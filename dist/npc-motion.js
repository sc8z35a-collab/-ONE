import {zoneOf} from './layout.js';
import {clamp} from './render.js';
import {stairLane,stairNeighborShift} from './stairs.js';

const angle=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
const radius=a=>a.radius??(a.swimming?.34:.42);
const height=a=>a.height??(a.swimming?.58:1.72);
const heading=(x,z)=>Math.atan2(x,-z);
const smooth=t=>t*t*(3-2*t);

export function resetGait(a) {
  a.feet=null;
  a.gait=null;
  a.poseBank=0;
  a.brace=a.peek=a.readyPose=a.flare=0;
  a.driveX=a.driveZ=a.yawSpeed=0;
  a.bodyYaw=a.yaw;
}

export function limbJoint(root,end,upper,lower,pole) {
  const axis=end.map((value,i)=>value-root[i]);
  const span=Math.hypot(...axis);
  if (span<1e-5) return root.map((value,i)=>value+pole[i]*upper);
  for (let i=0;i<3;i++) axis[i]/=span;
  const length=clamp(span,Math.abs(upper-lower)+.001,upper+lower-.001);
  const along=(upper**2-lower**2+length**2)/(2*length);
  const bend=Math.sqrt(Math.max(0,upper**2-along**2));
  const dot=pole.reduce((sum,value,i)=>sum+value*axis[i],0);
  let side=pole.map((value,i)=>value-dot*axis[i]);
  if (Math.hypot(...side)<1e-6) side=Math.abs(axis[1])<.7?[axis[2],0,-axis[0]]:[0,axis[2],-axis[1]];
  const norm=Math.hypot(...side);
  return root.map((value,i)=>value+axis[i]*along+side[i]*bend/norm);
}

export class NpcMotion {
  constructor(battle) {
    this.battle=battle;
    this.groups=[[],[],[],[]];
  }

  begin() {
    for (const group of this.groups) group.length=0;
    const b=this.battle;
    for (const a of b.actors) if (a.down<=0 && !a.ride && !a.lift) this.groups[zoneOf(a.x)].push(a);
    for (const a of b.raiders.members) if (a.active && !a.ride && !a.lift) this.groups[zoneOf(a.x)].push(a);
    if (b.boss.active) this.groups[zoneOf(b.boss.x)].push(b.boss);
  }

  *neighbors(a,x,z,reach) {
    const level=zoneOf(x);
    for (const other of this.groups[level]) {
      if (other!==a && (!(other.isRaider || other.isBoss) || other.active) && zoneOf(other.x)===level && (other.down??0)<=0 && Math.abs(other.x-x)<reach &&
          Math.abs(other.z-z)<reach) yield [other,other.x];
    }
    const shift=stairNeighborShift(x,z,reach);
    if (shift) for (const other of this.groups[1-level]) {
      if (other!==a && (!(other.isRaider || other.isBoss) || other.active) && zoneOf(other.x)!==level && (other.down??0)<=0 && Math.abs(other.z-z)<reach &&
          Math.abs(other.x-shift-x)<reach) yield [other,other.x-shift];
    }
  }

  roomFor(a,x,y,z,r,h) {
    const shift=zoneOf(x)!==zoneOf(a.x)?stairNeighborShift(a.x,a.z,1):0;
    for (const [other,ox] of this.neighbors(a,x,z,r+1.5)) {
      if (other.ride || other.lift || y+h<=other.y+.09 || other.y+height(other)<=y+.09) continue;
      const sum=(r+radius(other))*.82;
      const end=(x-ox)**2+(z-other.z)**2;
      if (end>=sum*sum) continue;
      const start=(a.x+shift-ox)**2+(a.z-other.z)**2;
      if (end+1e-8<Math.min(start,sum*sum)) return false;
    }
    return true;
  }

  avoid(a,vx,vz) {
    if (Math.hypot(vx,vz)<.15) return [vx,vz];
    const b=this.battle;
    let pushX=0,pushZ=0,slow=1;
    for (const [other,ox] of this.neighbors(a,a.x,a.z,4.1)) {
      if (Math.abs(a.y-other.y)>1.05 || other.ride || other.lift) continue;
      const rx=ox-a.x, rz=other.z-a.z, dist=Math.hypot(rx,rz);
      if (dist<.02 || dist>4.1) continue;
      const ux=vx-(other.vx??0), uz=vz-(other.vz??0), toward=rx*ux+rz*uz;
      const t=clamp(toward/Math.max(.1,ux*ux+uz*uz),0,.43);
      const px=rx-ux*t,pz=rz-uz*t, near=Math.hypot(px,pz);
      const limit=radius(a)+radius(other)+.42;
      if (near>=limit || toward<0 && dist>limit*.75) continue;
      if (dist>1.5 && b.world.blocked((a.x+ox)/2,(a.y+other.y)/2+.36,(a.z+other.z)/2,.13,.68)) continue;
      const cross=rx*vz-rz*vx;
      const side=Math.abs(cross)<.42?1:Math.sign(cross);
      const weight=(1-near/limit)*(dist<1.6?3.6:2.3);
      pushX+=(-rx/dist*.43-rz/dist*side)*weight;
      pushZ+=(-rz/dist*.43+rx/dist*side)*weight;
      slow=Math.min(slow,1-.49*(1-near/limit));
    }
    return [vx*slow+pushX,vz*slow+pushZ];
  }

  segment(a,x,z,r=radius(a),h=height(a)) {
    const b=this.battle, n=Math.ceil(Math.hypot(x-a.x,z-a.z)/.36);
    const stairs=stairLane(a.x,a.z), probe={x:a.x,y:a.y,z:a.z,radius:r,height:h};
    for (let i=1;i<=n;i++) {
      probe.x=a.x+(x-a.x)*i/n;
      probe.z=a.z+(z-a.z)*i/n;
      const floor=b.world.support(probe.x,probe.y,probe.z);
      if (Math.abs(floor.y-probe.y)>.42 || !stairs && floor.stair) return false;
      probe.y=floor.y;
      if (b.world.blocked(probe.x,probe.y+.028,probe.z,r,h) ||
          b.stage.blocked(probe.x,probe.y+.028,probe.z,r,h) ||
          !b.stage.canEnter(a,probe.x,probe.y,probe.z) ||
          b.transit.blocksActor(probe) || b.metro.blocksActor(probe)) return false;
    }
    return true;
  }

  canHop(a,x,z) {
    if (a.airborne || a.giant || zoneOf(a.x)>=2 || stairLane(a.x,a.z)) return false;
    const b=this.battle,r=radius(a),h=height(a), sx=(a.x+x)/2, sz=(a.z+z)/2;
    const land=b.world.support(x,a.y+.98,z);
    if (land.y>a.y+.77 || land.y<a.y-.46 || this.segment(a,x,z,r,h)) return false;
    return !b.world.blocked(sx,a.y+.81,sz,r,h) && !b.world.blocked(a.x,a.y+.73,a.z,r,h) &&
      !b.stage.blocked(sx,a.y+.81,sz,r,h) &&
      this.segment({...a,y:land.y,x:sx,z:sz},x,z,r,h);
  }

  turn(a,yaw,pitch,dt) {
    const difference=angle(a.yaw,yaw);
    const rate=a.isBoss?2.6:a.weapon?.charge?6.6:8.6;
    const desired=clamp(difference*9,-rate,rate);
    a.yawSpeed=(a.yawSpeed??0)+clamp(desired-(a.yawSpeed??0),-44*dt,44*dt);
    a.yaw=angle(0,a.yaw+Math.sign(difference)*Math.min(Math.abs(difference),Math.max(0,a.yawSpeed*dt*Math.sign(difference))));
    if (Number.isFinite(pitch)) a.pitch=(a.pitch??0)+clamp(pitch-(a.pitch??0),-3.6*dt,3.6*dt);
  }

  drive(a,vx,vz,dt,{swim=false,jump=false,look,pitch,brace=0,peek=0,ready=0,emergency=false}={}) {
    const b=this.battle, previous=zoneOf(a.x), oldX=a.x, oldZ=a.z;
    const desiredSpeed=Math.hypot(vx,vz);
    if (look!==undefined || desiredSpeed>.09) this.turn(a,look??heading(vx,vz),pitch,dt);
    if (!a.isBoss) [vx,vz]=this.avoid(a,vx,vz);
    const ax=vx-(a.driveX??0),az=vz-(a.driveZ??0);
    const rate=emergency?68:a.isBoss?8:a.airborne?8.5:desiredSpeed<.12?33:27;
    const fraction=Math.min(1,rate*dt/Math.max(.001,Math.hypot(ax,az)));
    a.driveX=(a.driveX??0)+ax*fraction;
    a.driveZ=(a.driveZ??0)+az*fraction;
    if (a.isBoss) {
      b.stepActor(a,a.driveX*dt,a.driveZ*dt);
      a.vx=(a.x-oldX)/dt;a.vz=(a.z-oldZ)/dt;
      a.steps=(a.steps??0)+Math.hypot(a.vx,a.vz)*dt;
    } else b.move(a,a.driveX,a.driveZ,dt,swim,jump);
    const current=zoneOf(a.x);
    if (current!==previous) {
      resetGait(a);
      this.groups[current].push(a);
      return;
    }
    const speed=Math.hypot(a.vx??0,a.vz??0);
    const walkingYaw=heading(a.vx??0,a.vz??0);
    const body=a.bodyYaw??a.yaw;
    const target=speed>1?look===undefined?walkingYaw:a.yaw+clamp(angle(a.yaw,walkingYaw),-.99,.99)*.60:a.yaw;
    a.bodyYaw=angle(0,body+clamp(angle(body,target),-dt*(a.isBoss?2.4:6.1),dt*(a.isBoss?2.4:6.1)));
    const follow=(from,to)=>from+(to-from)*(1-Math.exp(-dt*13));
    a.poseBank=follow(a.poseBank??0,clamp((ax*Math.cos(a.bodyYaw)+az*Math.sin(a.bodyYaw))*.048,-.26,.26));
    a.brace=follow(a.brace??0,brace);
    a.peek=follow(a.peek??0,peek);
    a.readyPose=follow(a.readyPose??0,ready);
    a.flare=follow(a.flare??0,a.damageAge<.11?Math.exp(-a.damageAge*15):0);
    if (!a.isBoss && !a.isRaider) this.feet(a,dt,speed);
  }

  feet(a,dt,speed) {
    if (a.airborne || a.swimming || a.climbing || a.giant || a.ride || a.lift) {
      a.feet=a.gait=null;
      return;
    }
    const yaw=a.bodyYaw??a.yaw, b=this.battle;
    const place=(side,reach)=>{
      const x=a.x-Math.cos(yaw)*side*.177+(a.vx??0)*reach;
      const z=a.z-Math.sin(yaw)*side*.177+(a.vz??0)*reach;
      const floor=b.stage.support(x,a.y+.19,z,b.world.support(x,a.y+.19,z));
      if (Math.abs(floor.y-a.y)>.55 || b.world.blocked(x,floor.y+.02,z,.096,.26) ||
          b.stage.blocked(x,floor.y+.02,z,.096,.26)) return [a.x,a.y+.045,a.z,yaw];
      return [x,floor.y+.045,z,yaw];
    };
    if (!a.feet || !a.gait) {
      a.feet=[...place(-1,0),...place(1,0)];
      a.gait={leg:a.index%2,age:0,start:null,end:null,length:0};
    }
    const gait=a.gait, offset=gait.leg*4, side=gait.leg===0?-1:1;
    if (!gait.start) {
      const neutral=place(side,0), other=4-offset;
      const stretch=i=>Math.hypot(a.feet[i]-a.x,a.feet[i+2]-a.z);
      const turn=Math.abs(angle(a.feet[offset+3],yaw))>.88;
      if (stretch(offset)<.35 && stretch(other)>stretch(offset)+.15) {
        gait.leg=1-gait.leg;
        return;
      }
      if (stretch(offset)<(speed>.25?.35:.29) && Math.abs(a.feet[offset+1]-neutral[1])<.16 && !turn) return;
      gait.start=a.feet.slice(offset,offset+4);
      gait.end=place(side,Math.min(.115,.56/Math.max(.1,speed)));
      gait.age=0;
      gait.length=clamp(.217-speed*.019,.098,.217);
    }
    const t=clamp((gait.age+=dt)/gait.length,0,1), f=smooth(t);
    for (let i=0;i<3;i++) a.feet[offset+i]=t===1?gait.end[i]:gait.start[i]+(gait.end[i]-gait.start[i])*f;
    if (t<1) {
      const lift=Math.sin(t*Math.PI)*(.105+Math.min(speed,6)*.021);
      const x=a.feet[offset],z=a.feet[offset+2], y=a.feet[offset+1];
      const ground=b.stage.support(x,y+.18,z,b.world.support(x,y+.18,z));
      a.feet[offset+1]=Math.max(y,ground.y+.045)+lift;
    }
    a.feet[offset+3]=gait.start[3]+angle(gait.start[3],gait.end[3])*f;
    if (t===1) {
      gait.leg=1-gait.leg;
      gait.start=gait.end=null;
    }
  }
}
