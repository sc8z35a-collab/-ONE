import {isCabin,zoneOf} from './layout.js';
import {clamp,forward} from './render.js';
import {stairLane} from './stairs.js';
import {shotTravel} from './weapons.js';

export const gap=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export const bearing=(a,p)=>Math.atan2(p[0]-a.x,a.z-p[2]);
const obstructed=hit=>hit && hit.t<.98;

export function muzzleClear(b,a,target,power=1) {
  const launches=b.weaponLaunch(a), w=a.weapon;
  const usable=launches.filter(launch=>!launch.hit && !launch.crossesStair);
  if (!usable.length) return false;
  const center=launches[0].tip.map((value,i)=>launches.length===2?(value+launches[1].tip[i])*.5:value);
  const d=target.map((value,i)=>value-center[i]);
  const travel=shotTravel(w,Math.hypot(d[0],d[2]),a.rangeFactor,power);
  const rise=.5*w.gravity*travel*travel, count=clamp(Math.ceil(Math.sqrt(rise/.14)),1,10);
  const spreadPadding=.13+Math.min(.42,Math.hypot(d[0],d[2])*w.spread*.24);
  const allies=[...b.actors,...b.raiders.members.filter(other=>other.active)].filter(other=>other!==a && other.team===a.team && other.down<=0 && !other.ride && !other.lift && zoneOf(other.x)===zoneOf(a.x));
  let shotClear=false;
  for (const {tip} of usable) {
    let start=tip, blocked=false;
    for (let step=1;step<=count;step++) {
      const t=step/count, end=tip.map((value,i)=>value+d[i]*t+(i===1?rise*t*(1-t):0));
      if (allies.some(other=>b.bodyHit(start,end,other,spreadPadding)!==null)) return false;
      if (obstructed(b.traceShot(start,end,true)) || obstructed(b.subweapons.block(start,end,a.team))) {
        blocked=true;
        break;
      }
      start=end;
    }
    if (!blocked) shotClear=true;
  }
  return shotClear;
}

const TACTICAL_SHOT_LIMIT=60;
export function incoming(b,a) {
  const level=zoneOf(a.x);
  let danger=null, soon=.39, checked=0;
  for (let i=b.shots.length-1;i>=0 && checked<TACTICAL_SHOT_LIMIT;i--) {
    const s=b.shots[i];
    if (s.actor.team===a.team || zoneOf(s.pos[0])!==level) continue;
    const [rx,ry,rz]=[a.x-s.pos[0],a.y+.98-s.pos[1],a.z-s.pos[2]];
    const [vx,vy,vz]=s.vel, ux=vx-(a.vx??0), uz=vz-(a.vz??0), mag=ux*ux+uz*uz;
    if (Math.abs(rx)>38 || Math.abs(rz)>38 || mag<1) continue;
    checked++;
    const t=(rx*ux+rz*uz)/mag;
    if (t<=.025 || t>=soon || Math.hypot(rx-ux*t,rz-uz*t)>.83+(s.weapon.size??.12) ||
        Math.abs(ry-vy*t+.5*s.weapon.gravity*t*t)>1.05) continue;
    const point=[s.pos[0]+vx*t,s.pos[1]+vy*t-.5*s.weapon.gravity*t*t,s.pos[2]+vz*t];
    if (b.traceShot(s.pos,point,true)) continue;
    soon=t;
    danger={point:s.pos,side:[-vz,vx],time:t};
  }
  return danger;
}

export function bossOrTentacle(b,a) {
  for (const hit of b.boss.attacks) {
    if (hit.done || zoneOf(a.x)!==0 || Math.abs(a.y-hit.y)>2.65 || hit.at-b.clock>.93 || gap(a,hit)>=hit.radius+1.1) continue;
    if (hit.kind==='sweep' && Math.cos(Math.atan2(a.x-hit.x,hit.z-a.z)-hit.yaw)<Math.cos((hit.halfAngle??1)+.20)) continue;
    return {p:[hit.x,hit.y,hit.z]};
  }
  for (const other of b.raiders.members) {
    const strike=other.attack, d=gap(a,other);
    if (!other.active || !strike || strike.hit || zoneOf(a.x)!==zoneOf(other.x) || Math.abs(a.y-other.y)>1.9 || d>8.7) continue;
    const [x,,z]=forward(strike.yaw),dx=a.x-other.x,dz=a.z-other.z;
    if (strike.giant && d<5.7 || dx*x+dz*z>0 && Math.abs(dx*z-dz*x)<(strike.giant?2.6:1.18)) {
      if (!b.traceShot([other.x,other.y+.98,other.z],[a.x,a.y+.75,a.z],true)) return {p:[other.x,other.y,other.z]};
    }
  }
  return null;
}

export class NpcCombat {
  constructor(battle) {
    this.battle=battle;
  }

  position(a,s,p) {
    const b=this.battle,w=a.weapon,d=Math.max(.01,gap(a,p));
    const ux=(p.x-a.x)/d,uz=(p.z-a.z)/d;
    const preferred=a.giant?2.2:w.roller?2.7:w.charge?16:w.id==='fan'?6.0:w.blast?5.4:w.id==='lob'?12:w.id==='rd2'?11:9.1;
    const progress=clamp((d-preferred)*.32,-1.8,2.2);
    const enemyEye=[p.x,p.y+1.19,p.z], look=gap(a,p)<8?1.15:.85;
    const candidates=[[0,0],[progress,0],[progress,1.58],[progress,-1.58],[0,1.95],[0,-1.95],[-1.5,0]];
    let score=-Infinity,best={x:a.x,z:a.z};
    const teammates=b.motion.groups[zoneOf(a.x)].filter(other=>other!==a && other.team===a.team);
    for (const [advance,side] of candidates) {
      const x=a.x+ux*advance-uz*side,z=a.z+uz*advance+ux*side,distance=Math.hypot(p.x-x,p.z-z);
      if (!b.motion.segment(a,x,z)) continue;
      const floor=b.world.support(x,a.y,z), ally=teammates.reduce((inWay,c)=>inWay+Math.max(0,1-Math.hypot(c.x-x,c.z-z)/2.2),0);
      const ink=b.surfaceInk({x,z},floor);
      const cover=obstructed(b.traceShot(enemyEye,[x,floor.y+.68,z],true));
      const canShoot=!obstructed(b.traceShot([x,floor.y+look,z],enemyEye,true));
      const quality=-Math.abs(distance-preferred)*.39-ally*1.48+(ink===a.team+1?1.24:ink?-1.30:0)+
        (cover?(a.hp<63?2:.83):0)+(canShoot?1.16:-1.5)+Math.sign(side)*(s.bias??0)*.21-
        Math.hypot(advance,side)*.15;
      if (quality>score) {score=quality;best={x,z};}
    }
    s.bias=Math.sign((best.z-a.z)*ux-(best.x-a.x)*uz);
    return best;
  }

  shoot(a,s,sight,dt) {
    const b=this.battle,w=a.weapon;
    if (!sight?.visible || b.clock<sight.react || a.giant || a.beaming || a.swimming) {a.charge=0;return false;}
    const target=b.perception.aim(a,sight), yaw=bearing(a,target);
    if (Math.cos(a.yaw-yaw)<(w.charge?.995:.979)) return false;
    if (b.clock<(s.breath??0) || a.fire>0 || a.tank<w.cost) return false;
    const d=Math.hypot(target[0]-a.x,target[2]-a.z);
    if (d>w.range*(a.rangeFactor??1)*.95) return false;
    if (w.charge) {
      a.charge=Math.min(1,a.charge+dt/w.charge);
      if (a.charge<(d>18?.93:.72)) return false;
    }
    const power=w.charge?.27+.73*a.charge:1, spread=.13+d*(w.charge?.014:.025);
    const adjusted=target.map((value,i)=>value+(b.rng()-.5)*spread*(i===1?.48:1));
    if (!muzzleClear(b,a,adjusted,power) || !b.shoot(a,adjusted,power)) return false;
    a.charge=0;
    if (!s.burst) s.burst=w.charge?1:2+Math.floor(b.rng()*4);
    if (--s.burst<=0) s.breath=b.clock+.12+b.rng()*.29;
    return true;
  }

  engage(a,enemy,s,dt,sight) {
    const b=this.battle;
    if (!sight?.visible) return false;
    const point=sight.foot, d=gap(a,point), aim=b.perception.aim(a,sight);
    const ready={look:bearing(a,aim),pitch:clamp(Math.atan2(aim[1]-a.y-1.27,Math.max(.2,d)),-.61,.56),ready:1};
    if (b.clock>=(s.evadeScan??0)) {
      s.evadeScan=b.clock+.105;
      const risk=incoming(b,a);
      if (risk) {
        const scale=Math.max(1,Math.hypot(...risk.side));
        for (const dir of [a.side??1,-(a.side??1)]) {
          const x=a.x+risk.side[0]/scale*1.98*dir,z=a.z+risk.side[1]/scale*1.98*dir;
          if (!b.motion.segment(a,x,z)) continue;
          s.dodge={x,z,until:b.clock+.29,jump:risk.time>.11 && !isCabin(a.x) && !stairLane(a.x,a.z,.2) &&
            !b.bodyBlocked({...a,y:a.y+.67},a.radius??.42,1.72) && b.clock>(a.npcJumpAt??0)};
          a.side=dir;
          break;
        }
      }
    }
    if (s.dodge?.until>b.clock) {
      const evade=s.dodge;
      a.intent='弾道を見切って回避';
      if (evade.jump) a.npcJumpAt=b.clock+1.3;
      b.steer(a,evade,dt,5.7,false,{...ready,jump:evade.jump,emergency:true});
      evade.jump=false;
      return true;
    }
    if (b.clock>=(s.fightAt??0) || !s.pos) {
      s.fightAt=b.clock+.36+b.rng()*.18;
      s.pos=this.position(a,s,point);
    }
    a.intent=a.giant?'巨大化して前進':d<5.5?'間合いを取りながら迎撃':'射線をつないで交戦';
    b.steer(a,s.pos,dt,a.giant?4.93:4.70,false,{...ready,brace:d>7?.24:.11});
    if (a.weapon.roller && d<2.56 && Math.cos(a.yaw-ready.look)>.93 && b.roll(a)) return true;
    if (b.clock>=sight.react && b.clock>(s.subScan??0)) {
      s.subScan=b.clock+.44;
      b.subweapons.consider(a,enemy);
    }
    this.shoot(a,s,sight,dt);
    return true;
  }
}
