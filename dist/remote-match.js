import {Abilities} from './abilities.js';
import {Battle} from './battle.js';
import {StageObjects} from './stage-objects.js';
import {Boss} from './boss.js';
import {AVATAR_FIELDS} from './cloud-view.js';
import {Paint} from './ink.js';
import {CLOUD_PROTOCOL,INK_SIZE,SOCKET_PROTOCOL,applyInkPacket,resetVisualInk} from './ink-wire.js';
import {METRO,giantHeight,sameLevel,zoneOf} from './layout.js';
import {Raiders} from './raiders.js';
import {Hazards} from './hazards.js';
import {clamp} from './render.js';
import {Transit} from './transit.js';
import {shotWeaponById,weaponById} from './weapons.js';
import {Subweapons} from './subweapons.js';

const PATH='/api/inkshift', BUTTONS=['press','jump','super','drone','use','cycle','sub','co'];
const MOVEMENT=['x','y','z','steps','yaw','pitch','bodyYaw','poseBank','brace','peek','readyPose','flare'];
const FEET=['0','1','2','3','4','5','6','7'];
const POSITION=['0','1','2'];
const TRAIN_MOTION=['x','doorOpen','wetness','lateral','roll','yaw','lift','viewDirection','routePitch'];
const REQUEST_MS=6500;
// Snapshots are shown one server step behind their arrival; a late frame is
// bridged by carrying the last motion on for at most this share of a step.
const EXTRAPOLATE=1.45;
// Own movement runs on the device and is only nudged toward the server.
const PREDICTED=['x','y','z','vx','vy','vz','steps','swimming','inkSwimming','climbing','climbNormal','airborne','landing',
  'coyote','jumpBuffer','driveX','driveZ','swimFX','yaw','pitch'];
const PREDICTED_SET=new Set(PREDICTED);
const LEAD_MS=21, DEADZONE=.16, SNAP=3.2;
const avatar=row=>Object.fromEntries(AVATAR_FIELDS.map((key,i)=>[key,row[i]]));
const neutral={x:0,z:0,yaw:0,pitch:0,fire:false,swim:false,front:false,overview:true};

export async function detectCloud(required=false) {
  const waiting=required?{cloud:true,ready:false,unreachable:true}:null;
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),2400);
  try {
    const response=await fetch(PATH+'/health',{cache:'no-store',signal:controller.signal});
    if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) return waiting;
    const health=await response.json();
    if (health.cloud!==true) return waiting;
    return {...health,outdated:health.protocol!==CLOUD_PROTOCOL,ready:health.ready && health.protocol===CLOUD_PROTOCOL};
  } catch { return waiting; }
  finally { clearTimeout(timer); }
}

const ROOM_KEY='inkshift-room-v6';

export function savedRoom(mode) {
  try {
    const result=JSON.parse(sessionStorage.getItem(ROOM_KEY));
    if (!result || result.mode!==mode || !/^[0-9a-f]{64}$/.test(result.room) ||
        typeof result.ticket!=='string' || !Number.isFinite(result.expires) || result.expires<=Date.now()) return null;
    return result;
  } catch { return null; }
}

export function rememberRoom(value,mode) {
  try { sessionStorage.setItem(ROOM_KEY,JSON.stringify({...value,mode})); }
  catch { /* Reconnecting on the live page remains available. */ }
}

export function forgetRoom(value,mode) {
  if (savedRoom(mode)?.room!==value.room) return;
  try { sessionStorage.removeItem(ROOM_KEY); }
  catch { /* An unavailable tab store holds no resumable room. */ }
}

export async function createCloudRoom(options,access,controller=new AbortController()) {
  const timer=setTimeout(()=>controller.abort(),REQUEST_MS);
  try {
    const response=await fetch(PATH+'/rooms',{method:'POST',cache:'no-store',signal:controller.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({...options,access})});
    if (!response.ok) {
      const error=new Error(response.status===401?'接続キーが一致しません。':'Cloudflareの対戦ルームを作成できませんでした。');
      error.invalidAccess=response.status===401;
      throw error;
    }
    return await response.json();
  } finally { clearTimeout(timer); }
}

function makeScene(world,paint,frame) {
  const b=Object.create(Battle.prototype);
  Object.assign(b,{world,paint,actors:[],crewShapes:new WeakMap(),mode:frame.mode,teamSize:frame.teamSize,timeless:frame.timeless,
    unlimited:!!(frame.unlimited ?? frame.timeless),player:null});
  b.transit=new Transit(world);
  b.metro=new Transit(world,null,METRO);
  b.abilities=new Abilities(b);
  b.stage=new StageObjects(world);
  b.subweapons=new Subweapons(b);
  b.boss=new Boss(b);
  b.raiders=new Raiders(b);
  b.hazards=new Hazards(b);
  return b;
}

function copyMotion(dest,row,keys,motions,force,angles=['yaw','bodyYaw']) {
  const from=Object.fromEntries(keys.map(key=>[key,dest[key]]));
  Object.assign(dest,row);
  if (force) return;
  const to={};
  const values=keys.filter(key=>Number.isFinite(from[key]) && Number.isFinite(row[key]));
  for (const key of values) {
    dest[key]=from[key];
    const angle=row[key]-from[key];
    to[key]=angles.includes(key)?from[key]+Math.atan2(Math.sin(angle),Math.cos(angle)):row[key];
  }
  if (values.length) motions.push({dest,from,to,keys:values});
}

export class RemoteMatch {
  constructor(ticket,world,{sound,status,onTravel}={}) {
    this.ticket=ticket;
    this.world=world;
    this.sound=sound;
    this.status=status;
    this.onTravel=onTravel;
    this.intent=neutral;
    this.pending={};
    this.paused=true;
    this.pauseSent=false;
    this.pausePending=false;
    this.lastPauseSentAt=-Infinity;
    this.lastLoadoutSentAt=-Infinity;
    this.pendingLoadout=null;
    this.attempt=0;
    this.received=0;
    this.seq=0;
    this.scene=null;
    this.paint=null;
    this.motions=[];
    this.rows=[];
    this.clockOffset=null;
    this.jitter=0;
    this.spacing=1000/24;
    this.arrivedAt=0;
    this.frameAt=0;
    this.frameDue=1;
    this.sentInputAt=-Infinity;
    this.sentAt=new Map();
    this.history=[];
    this.fix=[0,0,0];
    this.shadow=null;
    this.serverPlayer=null;
    this.ack=0;
    this.predictionOff=false;
    this.steppedAt=0;
    this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
    this.timeout=setTimeout(()=>this.fail('対戦サーバーからの応答を待機しました。'),REQUEST_MS+2500);
    // The render loop sends input as it changes; this only keeps an idle link alive.
    this.interval=setInterval(()=>{
      if (performance.now()-this.sentInputAt>=45) this.flush();
    },50);
    this.open();
  }

  open() {
    if (this.closed) return;
    this.inkBatch=null;
    this.awaitingFrame=true;
    this.rows=[];
    this.clockOffset=null;
    this.resetPrediction();
    const actor=this.scene?.player;
    this.intent=actor?{...neutral,yaw:actor.yaw,pitch:actor.pitch}:neutral;
    this.pending={};
    const url=new URL(PATH+'/socket/'+this.ticket.room,location.href);
    url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=this.socket=new WebSocket(url,[SOCKET_PROTOCOL,this.ticket.ticket]);
    socket.binaryType='arraybuffer';
    socket.onopen=()=>{
      if (socket!==this.socket) return;
      this.seq=0;
      this.pauseSent=false;
      this.lastPauseSentAt=-Infinity;
      this.lastLoadoutSentAt=-Infinity;
      this.received=performance.now();
    };
    socket.onmessage=event=>{
      if (socket!==this.socket) return;
      try {
        this.received=performance.now();
        if (typeof event.data!=='string') {
          const batch=this.inkBatch;
          if (batch) {
            batch.packets.push(event.data);
            if (batch.packets.length===batch.frame.inkPackets) {
              this.inkBatch=null;
              this.receiveFrame(batch.frame,batch.packets);
            }
          } else if (this.paint) applyInkPacket(this.paint,event.data);
          return;
        }
        const msg=JSON.parse(event.data);
        if (msg.type==='hello') {
          if (msg.protocol!==CLOUD_PROTOCOL || msg.ink?.width!==INK_SIZE.width || msg.ink?.height!==INK_SIZE.height) throw new Error('更新後に再読み込みしてください。');
          if (!this.paint) {
            this.paint=new Paint({...INK_SIZE,visualOnly:true});
            this.paint.setWorld(this.world);
          }
        }
        if (msg.type==='frame' && this.paint) {
          const size=msg.inkPackets??0;
          if (!Number.isInteger(size) || size<0 || size>256 || this.inkBatch) throw new Error('Incomplete ink frame');
          if (size) this.inkBatch={frame:msg,packets:[]};
          else this.receiveFrame(msg,[]);
        }
      } catch {
        this.fail('サーバーのデータ形式を確認できません。ページを再読み込みしてください。');
      }
    };
    socket.onclose=event=>{
      if (socket!==this.socket || this.closed) return;
      this.inkBatch=null;
      this.motions.length=0;
      if (event.code===4001) {this.fail('この対戦は別の接続で再開されました。');return;}
      if (this.attempt>=5) {this.fail('対戦サーバーへの再接続ができませんでした。');return;}
      this.status?.('reconnecting');
      this.pending={};
      this.retry=setTimeout(()=>this.open(),Math.min(2800,220*2**this.attempt++));
    };
  }

  receiveFrame(frame,packets) {
    const initial=!this.scene;
    this.apply(frame,this.awaitingFrame);
    for (const packet of packets) applyInkPacket(this.paint,packet);
    this.awaitingFrame=false;
    if (initial) {
      clearTimeout(this.timeout);
      this.resolve(this.scene);
    }
    this.attempt=0;
    this.targetLock=frame.lock ?? null;
    this.status?.('connected');
  }

  // When a snapshot for this server clock should be fully on screen. Frames are
  // paced by the server clock, so network jitter does not reach the motion.
  schedule(now,clock) {
    const sample=now-clock*1000;
    this.spacing??=1000/24;
    if (this.clockOffset==null || !(Math.abs(sample-this.clockOffset)<=280)) {
      this.clockOffset=sample;
      this.jitter=0;
    } else {
      const late=sample-this.clockOffset;
      this.jitter+=(Math.abs(late)-this.jitter)*.1;
      this.clockOffset+=late*(late<0?.5:.04);
    }
    if (this.arrivedAt) this.spacing+=(clamp(now-this.arrivedAt,20,160)-this.spacing)*.12;
    this.arrivedAt=now;
    return Math.max(now+8,this.clockOffset+clock*1000+clamp(this.spacing+this.jitter*2,34,150));
  }

  resetPrediction() {
    this.shadow=null;
    this.history=[];
    this.fix=[0,0,0];
    this.zoneMismatch=0;
  }

  input(intent,paused) {
    if (this.paused!==paused) {
      this.pauseSent=false;
      if (paused) this.pausePending=true;
      else this.received=performance.now();
    }
    this.paused=paused;
    if (paused || this.awaitingFrame || this.socket?.readyState!==WebSocket.OPEN) {
      this.intent=neutral;
      this.pending={};
      return;
    }
    const previous=this.intent ?? neutral;
    this.intent=intent ?? neutral;
    let tapped=false;
    for (const key of BUTTONS) {
      this.pending[key]=this.pending[key] || this.intent[key];
      tapped ||= !!this.intent[key];
    }
    if (this.intent.jump) this.jumpTap=true;
    // A changed control goes out at once; steady input settles at the server rate.
    const changed=tapped || previous.x!==this.intent.x || previous.z!==this.intent.z ||
      previous.fire!==this.intent.fire || previous.swim!==this.intent.swim;
    const waited=performance.now()-this.sentInputAt;
    if (waited>=(changed?12:33)) this.flush();
  }

  equip(weapon,sub) {
    const player=this.scene?.player;
    if (!this.pendingLoadout && player?.weapon.id===weapon && player.subId===sub) return;
    this.pendingLoadout={weapon,sub};
    this.lastLoadoutSentAt=-Infinity;
    this.flush();
  }

  cycle() {
    if (!this.awaitingFrame) this.pending.cycle=true;
  }

  flush() {
    const socket=this.socket;
    if (this.closed || socket?.readyState!==WebSocket.OPEN) return;
    const now=performance.now();
    if ((!this.paused || this.awaitingFrame) && now-this.received>7200) {socket.close(4002,'Idle connection');return;}
    if (this.awaitingFrame) return;
    const paused=this.paused || this.pausePending;
    const loadout=now-this.lastLoadoutSentAt>=300?this.pendingLoadout:null;
    if (paused?this.pauseSent && !loadout:now-this.lastPauseSentAt<30) return;
    if (socket.bufferedAmount>65536) return;
    const {x,z,yaw,pitch,fire,swim,front,overview,eye}=paused?neutral:this.intent;
    const taps=paused?{}:this.pending;
    socket.send(JSON.stringify({type:'input',seq:++this.seq,x,z,yaw,pitch,fire,swim,front,overview,...taps,paused,
      ...(loadout && {loadout}),...(eye && {eye:eye.map(n=>Math.round(n*100)/100)})}));
    this.sentInputAt=now;
    if (!paused) {
      const sent=this.sentAt ??= new Map();
      sent.set(this.seq,now);
      if (sent.size>96) sent.delete(sent.keys().next().value);
    }
    if (loadout) this.lastLoadoutSentAt=now;
    if (paused) {
      this.pausePending=false;
      this.lastPauseSentAt=now;
    } else this.pending={};
    this.pauseSent=paused;
  }

  apply(f,resync=false) {
    const initial=!this.scene;
    const snap=initial || resync;
    const b=this.scene ??= makeScene(this.world,this.paint,f);
    if (f.fullInk) resetVisualInk(this.paint,f.fullInk);
    this.paint.count=f.count;
    if (f.total!==undefined) this.paint.total=f.total;
    if (f.zoneCount) this.paint.zoneCount=f.zoneCount;
    if (f.zoneTotal) this.paint.zoneTotal=f.zoneTotal;
    if ('unlimited' in f) b.unlimited=!!f.unlimited;
    Object.assign(b,{clock:f.clock,elapsed:f.elapsed,left:b.unlimited?Infinity:f.left,countdown:f.countdown,finished:f.finished,
      watching:f.watching});
    if (f.events) b.events=f.events;
    if (f.chip) b.chip=f.chip;
    this.motions.length=0;
    const now=performance.now();
    this.frameAt=now;
    this.frameDue=snap?now+1:this.schedule(now,f.clock);
    if (snap) this.arrivedAt=now;
    this.ack=f.inputAck??this.ack??0;
    // Crew rows arrive whole on a full frame and as sparse changes otherwise.
    if (f.actors) this.rows=f.actors.map(row=>row.slice());
    else {
      if (!f.actorDiffs || f.actorDiffs.length!==this.rows?.length) throw new Error('Crew rows out of step');
      for (const [i,diff] of f.actorDiffs.entries()) {
        const row=this.rows[i];
        for (let k=0;k<diff.length;k+=2) row[diff[k]]=diff[k+1];
      }
    }
    b.actors.length=Math.min(b.actors.length,this.rows.length);
    b.player=null;
    for (const [i,encoded] of this.rows.entries()) {
      const row=avatar(encoded);
      const dest=b.actors[i] ??= {};
      const old=dest.x, wasDown=dest.down>0;
      const discontinuity=initial || dest.name!==row.name || !sameLevel(old,row.x) || Math.hypot(old-row.x,dest.z-row.z)>5.3 || wasDown && row.down<=0;
      const feet=dest.feet;
      copyMotion(dest,row,MOVEMENT,this.motions,snap || discontinuity);
      if (feet && dest.feet && !snap && !discontinuity) {
        copyMotion(feet,dest.feet,FEET,this.motions,false,['3','7']);
        dest.feet=feet;
      }
      dest.weapon=shotWeaponById(row.weapon);
      if (row.isPlayer) {
        b.player=dest;
        if (this.pendingLoadout?.weapon===row.weapon && this.pendingLoadout.sub===row.subId) this.pendingLoadout=null;
        const predicted=!!this.shadow;
        this.reconcile(row,now,snap || !predicted && discontinuity);
        if (!initial && (predicted?this.jumped:discontinuity)) this.onTravel?.(dest,old,wasDown);
        this.jumped=false;
      }
    }
    for (const [rail,row] of [[b.transit,f.transit],[b.metro,f.metro]]) {
      const {train={},...meta}=row;
      const previousConnection=rail.connection;
      if ('section' in meta || snap) rail.setSection(meta.section??rail.section??rail.homeLevel);
      Object.assign(rail,meta);
      if (meta.connection && previousConnection && meta.connection.from===previousConnection.from &&
          meta.connection.side===previousConnection.side) {
        copyMotion(previousConnection,meta.connection,['age'],this.motions,snap);
        rail.connection=previousConnection;
      }
      copyMotion(rail.train,train,TRAIN_MOTION,this.motions,snap || Math.abs(rail.train.x-(train.x??rail.train.x))>12);
      rail.cabinGlassAt=null;
    }
    copyMotion(b.boss,f.boss,['x','y','z','vx','vz','yaw','steps','poseBank'],this.motions,
      snap || 'active' in f.boss && b.boss.active!==f.boss.active);
    const oldRaiders=new Map((b.raiders.wave===f.raiders.wave?b.raiders.members:[]).map(a=>[a.index,a]));
    const members=f.raiders.members.map(encoded=>{
      const row=avatar(encoded), dest=oldRaiders.get(row.index) ?? {isRaider:true};
      copyMotion(dest,row,MOVEMENT,this.motions,snap || !sameLevel(dest.x,row.x));
      return dest;
    });
    Object.assign(b.raiders,f.raiders,{members});
    if (f.hazards && b.hazards) b.hazards.applySnapshot(f.hazards);
    const previousShots=new Map((snap?[]:b.shots??[]).filter(shot=>Number.isSafeInteger(shot.id)).map(shot=>[shot.id,shot]));
    b.shots=f.shots.map(([x,y,z,vx,vy,vz,team,weaponId,size,id])=>{
      const position=[x,y,z], previous=previousShots.get(id);
      if (!previous) return {id,pos:position,vel:[vx,vy,vz],actor:{team},weapon:{id:weaponId,size}};
      copyMotion(previous.pos,position,POSITION,this.motions,!sameLevel(previous.pos[0],x));
      previous.vel=[vx,vy,vz];
      return previous;
    });
    // Droplets are announced once and then fall on the device.
    const drops=(f.drops??[]).map(([x,y,z,size,part,team,vx=0,vy=0,vz=0,life=part*.5])=>
      ({p:[x,y,z],v:[vx,vy,vz],size,life,max:part>0?life/part:life,team}));
    b.drops=f.full || snap || !b.drops?drops:[...b.drops,...drops].slice(-96);
    b.inkImpacts=(f.inkImpacts??[]).map(([x,y,z,team,at,normal,kind])=>({p:[x,y,z],team,at,normal,kind:kind??0}));
    const previousSubs=new Map((snap?[]:b.subweapons.items).map(item=>[item.serial,item]));
    b.subweapons.items=(f.subItems??[]).map(row=>{
      const item=previousSubs.get(row.serial);
      if (!item) return row;
      const position=item.p;
      Object.assign(item,row,{p:position});
      copyMotion(position,row.p,POSITION,this.motions,!sameLevel(position[0],row.p[0]));
      return item;
    });
    const mark=([x,y,z,nx,ny,nz,team,phase,radius,shape,id])=>({p:[x,y,z],normal:[nx,ny,nz],team,phase,radius,shape,id});
    if (f.full || snap || !b.decals) {
      const oldMarks=new Map((snap?[]:b.decals??[]).map(item=>[item.id,item]));
      b.decals=(f.decals??[]).map(row=>oldMarks.get(row[10]) ?? mark(row));
    } else {
      const floor=f.decalMin??0;
      b.decals=[...b.decals.filter(item=>item.id>=floor),...(f.decals??[]).map(mark)].slice(-220);
    }
    b.abilities.drones=f.drones;
    if (f.stage) b.stage.restore(f.stage);
    b.abilities.rings=f.rings;
    b.abilities.advanced.effects=f.effects;
    for (const key of f.sounds) this.sound?.(key);
  }

  // Compares the authoritative position with where the device had the player
  // when the acknowledged input was sent, and feeds the difference back gently.
  reconcile(row,now,snap) {
    this.serverPlayer=row;
    const s=this.shadow;
    if (!s) return;
    for (const key of Object.keys(row)) if (!PREDICTED_SET.has(key)) s[key]=row[key];
    s.weapon=weaponById(row.weapon);
    s.radius=row.giant?.64:undefined;
    s.height=row.giant?giantHeight(row.x):undefined;
    const jump=()=>{
      for (const key of PREDICTED) if (key in row) s[key]=row[key];
      s.driveX=s.driveZ=0;
      this.history=[];
      this.fix=[0,0,0];
      this.zoneMismatch=0;
      this.jumped=true;
    };
    if (snap || row.down>0 || row.ride || row.lift || row.slam) {jump();return;}
    const sent=this.sentAt?.get(this.ack), past=sent===undefined?null:this.predictedAt(sent+LEAD_MS);
    if (!past) return;
    if (zoneOf(row.x)!==zoneOf(past.x)) {
      // A stair crossing is walked on both sides a moment apart; a carriage is entered at once.
      if (zoneOf(row.x)>=2 || zoneOf(past.x)>=2 || ++this.zoneMismatch>16) jump();
      return;
    }
    this.zoneMismatch=0;
    const ex=row.x-past.x, ey=row.y-past.y, ez=row.z-past.z, flat=Math.hypot(ex,ez);
    if (flat>SNAP || Math.abs(ey)>3) {jump();return;}
    const shift=[0,0,0];
    if (flat>DEADZONE) {
      const gain=flat>1?.55:.32;
      shift[0]=ex*gain;
      shift[2]=ez*gain;
    }
    if (Math.abs(ey)>.4 && !row.airborne && !s.airborne) shift[1]=ey*.5;
    if (!shift[0] && !shift[1] && !shift[2]) return;
    for (let k=0;k<3;k++) this.fix[k]+=shift[k];
    for (const entry of this.history) {
      entry.x+=shift[0];
      entry.y+=shift[1];
      entry.z+=shift[2];
    }
  }

  predictedAt(time) {
    const list=this.history;
    for (let i=list.length-1;i>=0;i--) if (list[i].t<=time) return list[i];
    return list[0] ?? null;
  }

  // Moves the player's own avatar with the shared movement code, so walking,
  // jumping and swimming answer the controls without waiting for the server.
  predict(now,dt) {
    const b=this.scene, p=b?.player, row=this.serverPlayer;
    if (this.predictionOff || !p || !row) return;
    const live=!this.paused && !this.awaitingFrame && !(b.countdown>0) && !b.finished && !(row.down>0) && !row.ride && !row.lift && !row.slam;
    if (!live) {
      if (this.shadow) this.resetPrediction();
      return;
    }
    let s=this.shadow;
    if (!s) {
      s=this.shadow={...row,weapon:weaponById(row.weapon),isPlayer:true,predicted:true,coyote:0,jumpBuffer:0,driveX:0,driveZ:0,swimFX:0,
        radius:row.giant?.64:undefined,height:row.giant?giantHeight(row.x):undefined,rollHold:0};
      this.history=[];
      this.fix=[0,0,0];
    }
    const intent=this.intent;
    s.yaw=intent.yaw;
    s.pitch=intent.pitch;
    s.rollHold=intent.fire && !s.swimming && !s.airborne?(s.rollHold??0)+dt:0;
    try {
      const ease=1-Math.exp(-dt*10);
      for (const [k,key] of ['x','y','z'].entries()) {
        const move=this.fix[k]*ease;
        s[key]+=move;
        this.fix[k]-=move;
      }
      const steps=Math.max(1,Math.ceil(dt/(1/50)));
      for (let i=0;i<steps;i++) {
        b.walk(s,{...intent,jump:i===0 && !!this.jumpTap},dt/steps);
        s.landing=Math.max(0,s.landing??0);
      }
    } catch (error) {
      // Fall back to showing the interpolated server position.
      this.predictionOff=true;
      this.shadow=null;
      console.warn('INKSHIFT movement prediction disabled',error);
      return;
    }
    this.jumpTap=false;
    this.history.push({t:now,x:s.x,y:s.y,z:s.z});
    while (this.history.length>2 && now-this.history[0].t>1300) this.history.shift();
    for (const key of PREDICTED) p[key]=s[key];
  }

  advance(now) {
    const span=Math.max(1,(this.frameDue??0)-(this.frameAt??0)) || 1;
    const t=clamp((now-this.frameAt)/span,0,EXTRAPOLATE);
    const dt=this.steppedAt?clamp((now-this.steppedAt)/1000,0,.1):0;
    this.steppedAt=now;
    const b=this.scene;
    if (b) b.impactAgeOffset=this.paused?0:clamp((now-(this.frameDue??now))/1000,-.15,.06);
    for (const {dest,from,to,keys} of this.motions) for (const key of keys) dest[key]=from[key]+(to[key]-from[key])*t;
    if (!b || this.paused || !(dt>0)) return;
    const drops=b.drops;
    if (drops?.length) {
      let kept=0;
      for (const drop of drops) {
        drop.p[0]+=drop.v[0]*dt;
        drop.p[1]+=drop.v[1]*dt;
        drop.p[2]+=drop.v[2]*dt;
        drop.v[1]-=9.81*dt;
        drop.life-=dt;
        if (drop.life>0 && drop.p[1]>this.world.floor(drop.p[0],drop.p[2]).y) drops[kept++]=drop;
      }
      drops.length=kept;
    }
    this.predict(now,dt);
  }

  fail(message) {
    if (this.closed) return;
    this.close(message);
    this.status?.('error',message);
  }

  close(message='対戦への接続を終了しました。') {
    if (this.closed) return;
    this.closed=true;
    this.inkBatch=null;
    if (!this.scene) this.reject(new Error(message));
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    clearInterval(this.interval);
    const socket=this.socket;
    if (socket?.readyState<WebSocket.CLOSING) socket.close(1000,'Match left');
  }
}
