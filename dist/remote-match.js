import {Abilities} from './abilities.js';
import {Battle} from './battle.js';
import {StageObjects} from './stage-objects.js';
import {Boss} from './boss.js';
import {AVATAR_FIELDS} from './cloud-view.js';
import {Paint} from './ink.js';
import {CLOUD_PROTOCOL,INK_SIZE,SOCKET_PROTOCOL,applyInkPacket,resetVisualInk} from './ink-wire.js';
import {METRO,sameLevel} from './layout.js';
import {Raiders} from './raiders.js';
import {clamp,mix} from './render.js';
import {Transit} from './transit.js';
import {weaponById} from './weapons.js';
import {Subweapons} from './subweapons.js';

const PATH='/api/inkshift', BUTTONS=['press','jump','super','drone','use','cycle','sub'];
const MOVEMENT=['x','y','z','steps','yaw','pitch','bodyYaw','poseBank','brace','peek','readyPose','flare'];
const FEET=['0','1','2','3','4','5','6','7'];
const POSITION=['0','1','2'];
const TRAIN_MOTION=['x','doorOpen','wetness','lateral','roll','yaw','lift','viewDirection','routePitch'];
const REQUEST_MS=6500;
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

const ROOM_KEY='inkshift-room-v5';

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
  Object.assign(b,{world,paint,actors:[],crewShapes:new WeakMap(),mode:frame.mode,teamSize:frame.teamSize,timeless:frame.timeless,player:null});
  b.transit=new Transit(world);
  b.metro=new Transit(world,null,METRO);
  b.abilities=new Abilities(b);
  b.stage=new StageObjects(world);
  b.subweapons=new Subweapons(b);
  b.boss=new Boss(b);
  b.raiders=new Raiders(b);
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
    this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
    this.timeout=setTimeout(()=>this.fail('対戦サーバーからの応答を待機しました。'),REQUEST_MS+2500);
    this.interval=setInterval(()=>this.flush(),50);
    this.open();
  }

  open() {
    if (this.closed) return;
    this.inkBatch=null;
    this.awaitingFrame=true;
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
    this.intent=intent ?? neutral;
    for (const key of BUTTONS) this.pending[key]=this.pending[key] || this.intent[key];
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
    const {x,z,yaw,pitch,fire,swim,front,overview}=paused?neutral:this.intent;
    const taps=paused?{}:this.pending;
    socket.send(JSON.stringify({type:'input',seq:++this.seq,x,z,yaw,pitch,fire,swim,front,overview,...taps,paused,
      ...(loadout && {loadout})}));
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
    this.paint.total=f.total;
    if (f.zoneCount && f.zoneTotal) {
      this.paint.zoneCount=f.zoneCount;
      this.paint.zoneTotal=f.zoneTotal;
    }
    Object.assign(b,{clock:f.clock,elapsed:f.elapsed,left:f.timeless?Infinity:f.left,countdown:f.countdown,finished:f.finished,
      watching:f.watching,events:f.events,chip:f.chip});
    this.motions.length=0;
    this.frameAt=performance.now();
    for (const [i,encoded] of f.actors.entries()) {
      const row=avatar(encoded);
      const dest=b.actors[i] ??= {};
      const old=dest.x, wasDown=dest.down>0;
      const discontinuity=initial || !sameLevel(old,row.x) || Math.hypot(old-row.x,dest.z-row.z)>5.3 || wasDown && row.down<=0;
      const feet=dest.feet;
      copyMotion(dest,row,MOVEMENT,this.motions,snap || discontinuity);
      if (feet && dest.feet && !snap && !discontinuity) {
        copyMotion(feet,dest.feet,FEET,this.motions,false,['3','7']);
        dest.feet=feet;
      }
      dest.weapon=weaponById(row.weapon);
      if (row.isPlayer) {
        b.player=dest;
        if (this.pendingLoadout?.weapon===row.weapon && this.pendingLoadout.sub===row.subId) this.pendingLoadout=null;
        if (!initial && discontinuity) this.onTravel?.(dest,old,wasDown);
      }
    }
    for (const [rail,row] of [[b.transit,f.transit],[b.metro,f.metro]]) {
      const {train,...meta}=row;
      const previousConnection=rail.connection;
      rail.setSection(meta.section??rail.homeLevel);
      Object.assign(rail,meta);
      if (meta.connection && previousConnection && meta.connection.from===previousConnection.from &&
          meta.connection.side===previousConnection.side) {
        copyMotion(previousConnection,meta.connection,['age'],this.motions,snap);
        rail.connection=previousConnection;
      }
      copyMotion(rail.train,train,TRAIN_MOTION,this.motions,snap || Math.abs(rail.train.x-train.x)>12);
      rail.cabinGlassAt=null;
    }
    copyMotion(b.boss,f.boss,['x','y','z','vx','vz','yaw','steps','poseBank'],this.motions,snap || b.boss.active!==f.boss.active);
    const oldRaiders=new Map((b.raiders.wave===f.raiders.wave?b.raiders.members:[]).map(a=>[a.index,a]));
    const members=f.raiders.members.map(encoded=>{
      const row=avatar(encoded), dest=oldRaiders.get(row.index) ?? {isRaider:true};
      copyMotion(dest,row,MOVEMENT,this.motions,snap || !sameLevel(dest.x,row.x));
      return dest;
    });
    Object.assign(b.raiders,f.raiders,{members});
    const previousShots=new Map((snap?[]:b.shots??[]).filter(shot=>Number.isSafeInteger(shot.id)).map(shot=>[shot.id,shot]));
    b.shots=f.shots.map(([x,y,z,vx,vy,vz,team,weaponId,size,id])=>{
      const position=[x,y,z], previous=previousShots.get(id);
      if (!previous) return {id,pos:position,vel:[vx,vy,vz],actor:{team},weapon:{id:weaponId,size}};
      copyMotion(previous.pos,position,POSITION,this.motions,!sameLevel(previous.pos[0],x));
      previous.vel=[vx,vy,vz];
      return previous;
    });
    b.drops=f.drops.map(([x,y,z,size,life,team])=>({p:[x,y,z],size,life,max:1,team}));
    b.inkImpacts=(f.inkImpacts??[]).map(([x,y,z,team,at,normal])=>({p:[x,y,z],team,at,normal}));
    const previousSubs=new Map((snap?[]:b.subweapons.items).map(item=>[item.serial,item]));
    b.subweapons.items=(f.subItems??[]).map(row=>{
      const item=previousSubs.get(row.serial);
      if (!item) return row;
      const position=item.p;
      Object.assign(item,row,{p:position});
      copyMotion(position,row.p,POSITION,this.motions,!sameLevel(position[0],row.p[0]));
      return item;
    });
    const oldMarks=new Map((snap?[]:b.decals??[]).map(mark=>[mark.id,mark]));
    b.decals=f.decals.map(([x,y,z,nx,ny,nz,team,phase,radius,shape,id])=>
      oldMarks.get(id) ?? {p:[x,y,z],normal:[nx,ny,nz],team,phase,radius,shape,id});
    b.abilities.drones=f.drones;
    b.stage.restore(f.stage);
    b.abilities.rings=f.rings;
    b.abilities.advanced.effects=f.effects;
    for (const key of f.sounds) this.sound?.(key);
  }

  advance(now) {
    const t=clamp((now-this.frameAt)/97,0,1);
    if (this.scene) this.scene.impactAgeOffset=this.paused?0:t*.097;
    for (const {dest,from,to,keys} of this.motions) for (const key of keys) dest[key]=mix(from[key],to[key],t);
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
