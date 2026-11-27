import {resetGait} from './npc-motion.js';
import {surfacePaintRadius} from './ink.js';
import {add,clamp,cross,dot,mix,scale,splatRadius,sub,unit} from './render.js';
import {collectShapes,surfaceRim,traceShapes} from './collision.js';
import {CABIN_Y,LOOP_LENGTH,METRO,RAIL,STATIONS,giantHeight,isCabin,localX,loopAhead,loopWrap,railEnd,railPath,sameLevel,stationAt} from './layout.js';
import {drawTrain,TRAIN_AXLES,TRAIN_DOORS,TRAIN_HULLS,trainPose} from './train-model.js';
import {rayBox} from './world.js';
import {STAIRS,stairPoint} from './stairs.js';
import {WINDOW_BREAK} from './train-glass.js';

const smooth=t=>t*t*(3-2*t);
export const CONNECTION_TIME=32;
const PORTAL_TIME=6;
const BOARDING_MARGIN=.80;
const COAT_RIM=Array.from({length:12},(_,i)=>splatRadius(i*Math.PI/6));
const portalStop=line=>Math.max(line.x+27,line.edge+10.05);
// Each line serves its own two stations: the elevated loop runs one way
// round (west → east → round the loop → west), the metro shuttles.
const lineStops=level=>STATIONS.filter(stop=>stop.level===level).map(stop=>[stop.level,stop.side]);
// Track distance from one station to the next one this line serves.
const legLength=(line,fromSide)=>line.loop?(fromSide<0?2*line.x:LOOP_LENGTH-2*line.x):2*line.x;
const nearestDoor=x=>TRAIN_DOORS.reduce((a,b)=>Math.abs(a-x)<Math.abs(b-x)?a:b);
const lineSpeed=level=>level===1?10.4:11.25;
function runningSpeed(speed,distance,adhesion,limit,dt) {
  const goal=Math.min(limit,Math.sqrt(2*3.4*adhesion*distance));
  const rate=speed<goal?2.61:4.25;
  const next=mix(speed,goal,clamp(dt*rate*adhesion,0,1));
  return distance<.21?Math.max(next,.62):next;
}

function estimateRun(distance,speed,wetness,limit) {
  const dt=.05, adhesion=1-.66*wetness;
  let seconds=0;
  while (distance>.037 && seconds<80) {
    speed=runningSpeed(speed,distance,adhesion,limit,dt);
    distance-=speed*dt;
    seconds+=dt;
  }
  return seconds;
}

const freshTrain=(side,line)=>({
  x:side*line.x, stop:side, direction:-side, phase:'dwell', wait:line.dwell, speed:0,
  doorOpen:0, wetness:0, lateral:0, sideSpeed:0, yaw:0, roll:0, lift:0,routePitch:0,
  risk:0, spray:0, inkColor:0x35bcaa, marks:[], windows:{}, viewDirection:-side, berserk:false
});

export class Transit {
  constructor(world,paint=null,line=RAIL) {
    this.world=world;
    this.paint=paint;
    this.homeLevel=line.center===METRO.center?1:0;
    this.line={...line};
    this.section=this.homeLevel;
    this.metro=this.section===1;
    this.connection=null;
    this.integrity=line.integrity ?? 720;
    this.train=freshTrain(-1,line);
    this.time=0;
    this.alert='';
    this.alertUntil=0;
    this.boardedAt=-Infinity;
  }

  setSection(section) {
    const {cabinX,cabinLayer}=this.line;
    this.section=section;
    this.metro=section===1;
    this.line={...(this.metro?METRO:RAIL),cabinX,cabinLayer};
    this.posedTrain=null;
  }

  visibleIn(section) {
    const c=this.connection;
    return section===this.section && (!c || c.age<PORTAL_TIME || c.age>CONNECTION_TIME-PORTAL_TIME);
  }

  nextStop() {
    const t=this.train;
    if (this.connection) return {level:this.connection.to,side:this.connection.side};
    return {level:this.section,side:t.stop || (t.phase==='return' || this.line.loop?t.destination??t.direction:t.direction)};
  }

  stopInfo() {
    const next=this.nextStop(), stop=stationAt(next.level,next.side);
    const t=this.train,c=this.connection;
    const status=t.berserk?'暴走中・敵ボス化':this.failed()?'列車を復旧中':c?.waiting?'信号待ち':t.phase==='return'?'復旧運転中':null;
    const seconds=t.stop?Math.max(0,t.wait):c?CONNECTION_TIME-c.age:this.runSeconds(next.side);
    return {station:stop,seconds:c?.waiting?null:Math.ceil(seconds),docked:!!t.stop,doors:t.doorOpen>.70,status};
  }

  runSeconds(side) {
    const {x,speed,wetness,phase}=this.train;
    const distance=this.line.loop?loopAhead(x,side*this.line.x):Math.abs(side*this.line.x-x), limit=phase==='return'?4.8:lineSpeed(this.section);
    const prior=this.runEstimate;
    if (prior && prior.distance===distance && prior.speed===speed && prior.wetness===wetness && prior.limit===limit) {
      return prior.seconds;
    }
    const seconds=estimateRun(distance,speed,wetness,limit);
    this.runEstimate={distance,speed,wetness,limit,seconds};
    return seconds;
  }

  sceneryX(period) {
    const c=this.connection;
    if (!c || c.age<=PORTAL_TIME) return this.train.x;
    // The repeating tunnel ends on the same window phase as the destination track.
    const run=Math.round(CONNECTION_TIME*8.5/period)*period;
    if (c.age>=CONNECTION_TIME-PORTAL_TIME) return this.train.x+c.side*run;
    const from=c.from===1?METRO:RAIL, to=c.to===1?METRO:RAIL;
    const progress=(c.age-PORTAL_TIME)/(CONNECTION_TIME-2*PORTAL_TIME);
    return c.side*mix(portalStop(from),portalStop(to)+run,smooth(progress));
  }

  boardingTime(level,side,ready) {
    return this.arrival(level,side,null,null,ready);
  }

  arrival(fromLevel,fromSide,toLevel,toSide,ready) {
    const t=this.train;
    if (t.berserk || this.failed() || t.phase==='return' || this.integrity<150 || this.connection?.waiting) return Infinity;
    const next=this.nextStop(), stops=lineStops(this.section), line=this.line;
    // A line never changes level: other levels are reached by the stairs.
    if (fromLevel!==this.section || toLevel!==null && toLevel!==this.section) return Infinity;
    let index=stops.findIndex(([level,side])=>level===next.level && side===next.side);
    if (index<0) return Infinity;
    let at=t.stop?this.time:this.time+this.runSeconds(next.side);
    let depart=t.stop?this.time+t.wait:at+line.dwell, boarded=false;
    for (let i=0;i<8;i++) {
      const [level,side]=stops[index];
      if (boarded && level===toLevel && side===toSide) return at;
      if (level===fromLevel && side===fromSide && ready+BOARDING_MARGIN<depart) {
        if (toLevel===null) return Math.max(at,ready);
        boarded=true;
      }
      index=(index+1)%stops.length;
      at=depart+legLength(line,side)/(lineSpeed(this.section)*(1-.37*t.wetness))+1.43;
      depart=at+line.dwell;
    }
    return Infinity;
  }

  update(clock) {
    if (clock<this.time) {
      this.time=0;
      this.setSection(this.homeLevel);
      this.connection=null;
      this.train=freshTrain(-1,this.line);
      this.integrity=this.line.integrity ?? 720;
      this.alertUntil=0;
    }
    while (clock-this.time>1e-8) {
      const dt=Math.min(.05,clock-this.time);
      this.time+=dt;
      this.step(dt);
    }
  }

  readRails() {
    const t=this.train, line=this.line;
    if (!this.paint) return [0,0];
    let left=0,right=0,cyan=0,amber=0;
    const pose=trainPose(t,line);
    for (const dx of TRAIN_AXLES) {
      for (const side of [-1,1]) {
        const [x,,z]=pose.at(dx,0,side*line.gauge);
        const depth=this.paint.depthAt(x,z,line.layer);
        if (side<0) left+=depth;
        else right+=depth;
        const team=this.paint.get(x,z,line.layer);
        if (team===1) cyan+=depth;
        if (team===2) amber+=depth;
      }
    }
    t.inkColor=cyan>=amber?0x2bd6bc:0xf49660;
    return [left/TRAIN_AXLES.length,right/TRAIN_AXLES.length];
  }

  dock(side) {
    const {marks,windows,viewDirection}=this.train;
    this.train={...freshTrain(side,this.line),marks,windows,viewDirection};
  }

  failed() {
    return this.train.phase==='derailed' || this.train.phase==='recover';
  }

  derail(note,sideForce=0) {
    const t=this.train;
    t.phase='derailed';
    t.sideSpeed+=sideForce;
    t.stop=0;
    t.doorOpen=0;
    this.alert=this.line.name+' · '+note;
    this.alertUntil=this.time+5.3;
  }

  damage(amount) {
    const t=this.train;
    if (t.berserk || this.failed() || t.phase==='return' || !(amount>0)) return 0;
    const lost=Math.min(amount,this.integrity);
    this.integrity-=lost;
    if (this.integrity<=0) {
      this.connection=null;
      this.derail('車体損傷で緊急停止');
    }
    return lost;
  }

  step(dt) {
    const t=this.train, line=this.line;
    t.viewDirection=mix(t.viewDirection,t.direction,1-Math.exp(-dt*2.4));
    if (t.berserk) {
      t.stop=0;
      t.doorOpen=0;
      t.phase='drive';
      t.wetness=0;
      t.risk=0;
      const topSpeed=lineSpeed(this.section)*2.25;
      t.speed=mix(t.speed,topSpeed,clamp(dt*3.8,0,1));
      t.roll=Math.sin(this.time*18)*.09;
      t.lift=Math.abs(Math.sin(this.time*24))*.08;
      t.lateral=Math.sin(this.time*13)*.12;
      t.yaw=Math.sin(this.time*15)*.03;
      if (line.loop) {
        t.direction=1;
        t.x=loopWrap(t.x+t.speed*dt);
      } else {
        const limit=Math.min(line.x+8,line.edge-10);
        t.x+=t.direction*t.speed*dt;
        if (t.x>=limit) {t.x=limit;t.direction=-1;}
        else if (t.x<=-limit) {t.x=-limit;t.direction=1;}
      }
      return;
    }
    if (t.phase==='connector') {
      const c=this.connection;
      const signal=CONNECTION_TIME-PORTAL_TIME;
      const approaching=c.age<=signal;
      c.age=Math.min(CONNECTION_TIME,c.age+dt);
      // Each level has one track. Hold inside the tunnel until that track clears.
      if (c.age>=signal && approaching) {
        c.waiting=this.peer?.visibleIn(c.to)===true;
        if (c.waiting) c.age=signal;
      }
      if (c.age>=CONNECTION_TIME*.5 && this.section!==c.to) this.setSection(c.to);
      const entering=c.age<CONNECTION_TIME*.5;
      const progress=entering?clamp(c.age/PORTAL_TIME,0,1):clamp((CONNECTION_TIME-c.age)/PORTAL_TIME,0,1);
      const portal=portalStop(this.line);
      t.x=c.side*mix(this.line.x,portal,smooth(progress));
      t.direction=entering?c.side:-c.side;
      t.speed=(portal-this.line.x)*6*progress*(1-progress)/PORTAL_TIME;
      t.doorOpen=0;
      t.stop=0;
      t.routePitch=(entering?1:-1)*c.side*(c.to===1?-1:1)*.048*Math.sin(progress*Math.PI);
      if (c.age>=CONNECTION_TIME) {
        const side=c.side;
        this.connection=null;
        this.dock(side);
      }
      return;
    }
    if (t.phase==='dwell') {
      t.wait-=dt;
      t.doorOpen=smooth(clamp(Math.min((line.dwell-t.wait)/.64,t.wait/.72),0,1));
      if (t.wait<=0) {
        // On to the line's other station: the loop always runs forward.
        t.phase='drive';
        t.destination=-t.stop;
        t.direction=line.loop?1:-t.stop;
        t.stop=0;
        t.doorOpen=0;
      }
      return;
    }
    if (t.phase==='derailed') {
      t.speed=Math.max(0,t.speed-dt*5.6);
      if (line.loop) t.x=loopWrap(t.x+t.speed*t.direction*dt);
      else {
        const limit=railEnd(line);
        t.x=clamp(t.x+t.speed*t.direction*dt,-limit,limit);
        if (Math.abs(t.x)>=limit) t.speed=0;
      }
      t.lateral=clamp(t.lateral+t.sideSpeed*dt,-1.55,1.55);
      t.sideSpeed*=Math.exp(-dt*2.65);
      t.roll=mix(t.roll,Math.sign(t.lateral||t.sideSpeed)*.37,1-Math.exp(-dt*2.7));
      t.yaw=mix(t.yaw,Math.sign(t.lateral||t.sideSpeed)*.24*t.direction,1-Math.exp(-dt*2.1));
      t.lift=mix(t.lift,-Math.abs(t.lateral)*.19,1-Math.exp(-dt*3));
      if (t.speed<=.001) {
        t.phase='recover';
        t.wait=this.metro?9.2:6.1;
      }
      return;
    }
    if (t.phase==='recover') {
      t.wait-=dt;
      if (t.wait<2.05) {
        const settle=1-Math.exp(-dt*2.6);
        for (const property of ['lateral','sideSpeed','roll','yaw','lift','wetness','routePitch']) t[property]=mix(t[property]??0,0,settle);
      }
      if (t.wait<=0) {
        if (line.loop) {
          // Creep forward to whichever station comes up first.
          t.destination=loopAhead(t.x,-line.x)<loopAhead(t.x,line.x)?-1:1;
          t.direction=1;
        } else {
          t.destination=t.x<0?-1:1;
          t.direction=Math.sign(t.destination*line.x-t.x) || -t.destination;
        }
        t.risk=0;
        t.phase='return';
        this.integrity=line.integrity ?? 720;
        if (this.metro) t.marks.length=0;
        t.windows={};
        this.posedTrain=null;
        this.cabinGlassAt=null;
      }
      return;
    }

    const [left,right]=this.readRails();
    const load=clamp(Math.max(left,right)*15,0,1);
    t.wetness=mix(t.wetness,load,1-Math.exp(-dt*5.6));
    const returning=t.phase==='return', destination=returning || line.loop?t.destination??t.direction:t.direction;
    const target=destination*line.x, distance=line.loop?loopAhead(t.x,target):Math.abs(target-t.x);
    const adhesion=1-.66*t.wetness;
    t.speed=runningSpeed(t.speed,distance,adhesion,returning?4.8:lineSpeed(this.section),dt);
    const bias=clamp((right-left)*22,-1,1);
    const oscillation=Math.sin(this.time*9.6)*.52+Math.sin(this.time*14.3)*.23;
    const sideForce=(bias*3.4+oscillation*2.2*t.wetness)*Math.min(1,t.speed/8);
    t.sideSpeed+=(sideForce-t.lateral*12.3-t.sideSpeed*4.1)*dt;
    t.lateral+=t.sideSpeed*dt;
    t.roll=clamp(t.lateral*.29+t.sideSpeed*.037,-.19,.19);
    t.yaw=clamp(-t.sideSpeed*.063*t.direction,-.09,.09);
    t.lift=Math.abs(t.roll)*.065;
    const danger=Math.max(0,t.wetness-.35)*Math.max(0,t.speed-3)*.31+Math.abs(t.lateral)*.17;
    t.risk=clamp(t.risk+(danger-.21)*dt,0,1);
    t.spray-=dt;
    if (this.paint && t.wetness>.21 && t.spray<=0) {
      t.spray=.16;
      const pose=trainPose(t,line);
      for (const side of [-1,1]) {
        const [kx,,kz]=pose.at(t.direction*2.08,0,side*line.gauge);
        this.paint.kick(kx,kz,line.layer,t.direction*t.speed*.49,t.sideSpeed);
      }
    }
    if (!returning && t.risk>=1) {
      this.derail('インクで脱線',Math.sign(bias||oscillation)*3.34);
      return;
    }
    if (this.metro && !returning && t.wetness>.22) {
      this.damage(t.wetness*t.wetness*(3+t.speed*.63)*dt);
      if (this.failed()) return;
    }
    if (distance<=Math.max(.037,t.speed*dt)) {
      this.dock(destination);
      return;
    }
    t.x+=t.direction*t.speed*dt;
    if (line.loop) t.x=loopWrap(t.x);
  }

  option(actor) {
    const t=this.train, line=this.line;
    const cooling=(actor.doorReady??0)>this.time;
    const unavailable=actor.slam?{kind:'busy',label:'着地後に乗降できます'}:
      cooling?{kind:'busy',label:'乗降中'}:null;
    if (actor.lift) return this.metro?null:{kind:'busy',label:'昇降中'};
    if (isCabin(actor.x)) {
      if (!sameLevel(actor.x,line.cabinX)) return null;
      if (unavailable) return unavailable;
      const info=this.stopInfo();
      return t.stop && t.doorOpen>.70 && t.wait>BOARDING_MARGIN?{kind:'cabin-exit',label:info.station.name+'で降りる'}:
        {kind:'busy',label:this.failed()?'緊急停車':t.stop?'扉の開閉中':info.status ?? info.station.name+'へ · 約'+info.seconds+'秒'};
    }
    if (actor.ride) {
      if (this.metro) return null;
      if (t.stop && t.doorOpen>.36) return unavailable ?? {kind:'exit',label:'降りる'};
      return {kind:'busy',label:t.stop?'扉が開くまでお待ちください':t.wetness>.31?'車輪が滑っています':'高架線を移動中'};
    }
    const px=actor.x-line.center;
    if (sameLevel(actor.x,line.center) && Math.abs(actor.y-line.platformY)<.55
      && Math.abs(actor.z-line.platformZ)<2.13 && Math.abs(Math.abs(px)-line.x)<8.85) {
      if (t.berserk) return {kind:'busy',label:'列車暴走中！乗車不可'};
      if (this.failed() || t.phase==='return') return {kind:'busy',label:'列車を復旧中'};
      if (t.stop && t.doorOpen>.70 && t.wait>BOARDING_MARGIN && Math.abs(px-t.x)<8.85) {
        return unavailable ?? {kind:'cabin-board',label:'乗車 · '+stationAt(this.section,t.stop).name};
      }
      return {kind:'busy',label:'列車を待つ'};
    }
    return null;
  }

  stopMoving(actor) {
    actor.driveX=actor.driveZ=actor.vx=actor.vz=actor.vy=0;
    actor.swimming=actor.inkSwimming=actor.climbing=actor.airborne=false;
    actor.landing=0;
    actor.climbNormal=null;
    actor.charge=0;
    actor.shotBuffer=actor.jumpBuffer=actor.coyote=0;
    actor.rollHold=0;
    actor.rollUsed=false;
    actor.rolling=false;
  }

  use(actor) {
    if (actor.down>0 || actor.slam || (actor.doorReady ?? 0)>this.time) return false;
    const option=this.option(actor), t=this.train, line=this.line;
    if (!option || option.kind==='busy') return false;
    this.stopMoving(actor);
    if (option.kind==='exit') this.unboard(actor,false);
    if (option.kind==='cabin-board') {
      actor.x=line.cabinX+nearestDoor(localX(actor.x)-t.x);
      actor.y=CABIN_Y;
      actor.z=line.doorSide*.93;
      actor.cabinFrom=t.stop;
      actor.cabinFromLevel=this.section;
      actor.cabinEntered=this.time;
      actor.cabinVisits=(actor.cabinVisits ?? 0)+1;
      this.boardedAt=this.time;
      this.onCrossing(actor);
    }
    if (option.kind==='cabin-exit') this.unboard(actor,false);
    return true;
  }

  walkThrough(actor,before) {
    if (!actor.isPlayer || actor.down>0 || actor.slam || actor.lift || (actor.doorReady??0)>this.time) return false;
    const option=this.option(actor),line=this.line;
    if (option?.kind==='cabin-board') {
      const door=nearestDoor(actor.x-line.center-this.train.x);
      const aligned=Math.abs(actor.x-line.center-this.train.x-door)<.64;
      const gap=(actor.z-line.z)*line.doorSide;
      const toward=(actor.z-before.z)*line.doorSide<-.0001;
      return aligned && toward && gap<2.28 && gap>1.52 && this.use(actor);
    }
    if (option?.kind==='cabin-exit') {
      const aligned=Math.abs(localX(actor.x)-nearestDoor(localX(actor.x)))<.64;
      return aligned && actor.z*line.doorSide>.81 && (actor.z-before.z)*line.doorSide>.0001 && this.use(actor);
    }
    return false;
  }

  pose() {
    const t=this.train, line=this.line, c=this._pose;
    if (c && c.t===t && c.x===t.x && c.lat===t.lateral && c.lift===t.lift &&
        c.yaw===t.yaw && c.roll===t.roll && c.rp===t.routePitch &&
        c.cx===line.center && c.z===line.z && c.y===line.y) return c;
    const p=trainPose(t,line), origin=p.at(0,0,0);
    return this._pose={t,x:t.x,lat:t.lateral,lift:t.lift,yaw:t.yaw,roll:t.roll,rp:t.routePitch,
      cx:line.center,z:line.z,y:line.y,pose:p,ox:origin[0],oz:origin[2]};
  }

  blocksActor(actor,radiusOverride,heightOverride) {
    const line=this.line;
    const h=heightOverride ?? actor.height ?? (actor.swimming?.58:1.72);
    if (!sameLevel(actor.x,line.center) || !this.visibleIn(this.section) ||
        actor.y>line.y+5.3 || actor.y+h<line.y+.7) return false;
    const cached=this.pose();
    const reachZ=line.loop?11.5:4.5;
    if (Math.abs(actor.x-cached.ox)>11.5 || Math.abs(actor.z-cached.oz)>reachZ) return false;
    const pose=cached.pose, foot=pose.local([actor.x,actor.y,actor.z]);
    if (Math.abs(foot[0])>10.4 || Math.abs(foot[2])>2.5) return false;
    const head=pose.local([actor.x,actor.y+h,actor.z]);
    const radius=radiusOverride ?? actor.radius ?? (actor.swimming?.33:.4);
    const r2=radius*radius, loY=foot[1]<head[1]?foot[1]:head[1], hiY=foot[1]>head[1]?foot[1]:head[1];
    for (let i=0;i<TRAIN_HULLS.length;i++) {
      const {min,max}=TRAIN_HULLS[i];
      if (loY>=max[1] || hiY<=min[1]) continue;
      const dx=foot[0]<min[0]?foot[0]-min[0]:foot[0]>max[0]?foot[0]-max[0]:0;
      const dz=foot[2]<min[2]?foot[2]-min[2]:foot[2]>max[2]?foot[2]-max[2]:0;
      if (dx*dx+dz*dz<r2) return true;
    }
    return false;
  }

  onCrossing(actor) {
    this.stopMoving(actor);
    resetGait(actor);
    actor.cabinToSide=actor.cabinToLevel=null;
    actor.beaming=false;
    actor.slam=null;
    if (actor.giant && !actor.isRaider) actor.height=giantHeight(actor.x);
    if (actor.isRaider) {
      actor.attack=null;
      actor.target=null;
    }
    actor.route=[];
    actor.goal=null;
    actor.enemy=null;
    actor.doorReady=this.time+.65;
  }

  placeRider(actor) {
    [actor.x,actor.y,actor.z]=trainPose(this.train,this.line).at(actor.ride.offset,1.075,.17);
  }

  unboard(actor,emergency) {
    const t=this.train, line=this.line;
    const fromCabin=isCabin(actor.x), offset=fromCabin?nearestDoor(localX(actor.x)):actor.ride.offset;
    // Off the station straight (anywhere on the loop) riders are led to the nearer platform.
    const along=line.loop?railPath(t.x).x:t.x, onStraight=!line.loop || Math.abs(loopWrap(t.x))<=line.edge && Math.abs(along-t.x)<.01;
    const outsideStation=emergency && (Math.abs(along)>line.edge-2 || !onStraight);
    const x=line.center+(outsideStation?(Math.sign(along) || 1)*line.x:t.x)+offset, z=line.platformZ-line.doorSide*.43;
    const exits=emergency?[[x,z+line.doorSide*2.5],[x,z+line.doorSide*4.7],[x-2.1,z+line.doorSide*3.5],
      [x+2.1,z+line.doorSide*3.5],[x,z+line.doorSide*6.4]]:[[x,z]];
    const [px,pz]=exits.find(([px,pz])=>this.world.stand(px,pz,.52))
      ?? [line.center+(t.x<0?-line.x:line.x),line.platformZ];
    actor.x=px;
    actor.z=pz;
    actor.y=this.world.floor(px,pz).y;
    actor.ride=null;
    if (fromCabin) this.onCrossing(actor);
    actor.shield=Math.max(actor.shield,emergency?2.15:1.1);
  }

  carry(actor,dt) {
    if (isCabin(actor.x)) {
      if (!sameLevel(actor.x,this.line.cabinX) || !this.failed() && !this.train.berserk) return false;
      this.unboard(actor,true);
      return true;
    }
    if (this.metro) return false;
    if (actor.ride) {
      if (this.failed() || this.train.berserk) this.unboard(actor,true);
      else this.placeRider(actor);
      return true;
    }
    if (!actor.lift) return false;
    const lift=actor.lift;
    lift.left-=dt;
    if (!lift.moved && lift.left<=.46) {
      const stair=STAIRS.reduce((a,b)=>Math.hypot(a.x-lift.lift.x,a.z-lift.lift.z)<Math.hypot(b.x-lift.lift.x,b.z-lift.lift.z)?a:b);
      const landing=stairPoint(stair,lift.toUnder?1:0);
      actor.x=landing.x;
      actor.z=landing.z;
      actor.y=this.world.floor(actor.x,actor.z).y;
      actor.route=[];
      actor.goal=null;
      actor.enemy=null;
      actor.liftsUsed=(actor.liftsUsed ?? 0)+1;
      lift.moved=true;
    }
    if (lift.left<=0) {
      actor.lift=null;
      actor.shield=Math.max(actor.shield,.85);
    }
    return true;
  }

  trace(start,end,precise=false,clearance=0) {
    const line=this.line;
    if (!sameLevel(start[0],line.center) || !this.visibleIn(this.section)) return null;
    const sy=start[1], ey=end[1];
    if ((sy>ey?sy:ey)<line.y-.05-clearance || (sy<ey?sy:ey)>line.y+5.3+clearance) return null;
    const cached=this.pose(), x=cached.ox, z=cached.oz;
    // On a curve the car is turned: test against a box that holds it at any heading.
    const reachX=(line.loop?9.8:9.4)+clearance, reachZ=(line.loop?9.8:3.63)+clearance;
    const sx=start[0], ex=end[0], sz=start[2], ez=end[2];
    if ((sx>ex?sx:ex)<x-reachX || (sx<ex?sx:ex)>x+reachX ||
        (sz>ez?sz:ez)<z-reachZ || (sz<ez?sz:ez)>z+reachZ) return null;
    const t=this.train, pose=cached.pose;
    const local=pose.local(start), delta=sub(pose.local(end),local);
    if (precise) {
      const pad=clearance+.25;
      if (!rayBox(local,delta,{min:[-9.6-pad,-.25-pad,-2.0-pad],max:[9.6+pad,5.45+pad,2.0+pad]})) return null;
      if (!this.posedTrain || this.posedTrain.time!==this.time || this.posedTrain.train!==t || this.posedTrain.doorOpen!==t.doorOpen) {
        this.posedTrain={time:this.time,train:t,doorOpen:t.doorOpen,shapes:collectShapes(r=>this.draw(r))};
      }
      const hit=traceShapes(this.posedTrain.shapes,start,end,clearance);
      return hit?{...hit,train:this,local:pose.local(hit.position),localNormal:pose.basis.map(axis=>dot(axis,hit.normal))}:null;
    }
    let best=null;
    for (let i=0;i<TRAIN_HULLS.length;i++) {
      const hit=rayBox(local,delta,TRAIN_HULLS[i]);
      if (hit && (!best || hit.t<best.t)) best=hit;
    }
    if (!best) return null;
    const point=add(local,scale(delta,best.t));
    return {t:best.t,position:pose.at(...point),normal:pose.rotate(...best.normal),train:this,local:point,localNormal:best.normal};
  }

  hitWindow(id,amount) {
    if (!(amount>0)) return;
    const t=this.train;
    t.windows??={};
    const before=t.windows[id]??0;
    if (before>=WINDOW_BREAK) return;
    t.windows[id]=Math.min(WINDOW_BREAK,before+amount);
    this.posedTrain=null;
    this.cabinGlassAt=null;
    if (t.windows[id]>=WINDOW_BREAK) {
      this.alert=this.line.name+' · 窓ガラス破損';
      this.alertUntil=this.time+3.8;
    }
  }

  splatter(hit,team,size,damage,windowDamage=damage) {
    if (hit.shape?.windowId) {
      this.hitWindow(hit.shape.windowId,windowDamage);
    } else {
      const marks=this.train.marks, pose=trainPose(this.train,this.line);
      const radius=clamp(size*.91,.35,1.16)*surfacePaintRadius(hit.localNormal);
      const n=hit.normal, ref=Math.abs(n[1])>.85?[0,0,1]:[0,1,0];
      const u=unit(cross(ref,n)), axes=[u,cross(n,u),n];
      const rim=hit.shape?surfaceRim(hit.shape,hit.position,axes,COAT_RIM,radius*.62)
        .map(point=>pose.local(add(point,scale(n,.016)))):null;
      marks.push({point:add(hit.local,scale(hit.localNormal,.016)),normal:hit.localNormal,team,size:radius,rim});
      if (marks.length>36) marks.shift();
    }
    this.damage(damage);
  }

  draw(r) {
    drawTrain(r,this.train,this.time,this.line);
  }
}
