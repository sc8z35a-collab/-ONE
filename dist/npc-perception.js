import {zoneOf} from './layout.js';
import {clamp} from './render.js';

const distance=(a,b)=>{const dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z;return Math.sqrt(dx*dx+dy*dy+dz*dz);};
const eyeHeight=a=>a.isBoss?2.86:a.swimming?.57:1.39-(a.brace??0)*.31;
export const visibleHeight=a=>a.isGoat?2.1:a.isHeli?1.15:a.isBoss?2.45:a.isRogueDrone?.05:a.isSniper?1.15:a.giant?1.51:a.swimming?.37:a.isRaider?1.11:1.09-(a.brace??0)*.30;

export class NpcPerception {
  constructor(battle) {
    this.battle=battle;
    this.memory=new WeakMap();
    this.sounds=[];
  }

  live(a,b) {
    return !!b && a!==b && (a.team!==b.team || a.isBoss) && (b.down??0)<=0 && (b.shield??0)<=0 &&
      Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z) && !b.lift && !b.ride &&
      (!(b.isBoss || b.isRaider || b.isSniper || b.isRogueDrone || b.isGoat || b.isHeli) || b.active);
  }

  sight(a,b) {
    const azone=zoneOf(a.x);
    if (!this.live(a,b) || azone!==zoneOf(b.x)) return null;
    const dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z, d2=dx*dx+dz*dz;
    const baseReach=a.isBoss?39:a.isRaider?28:a.weapon.blast?18:Math.min(36,a.weapon.range*.96);
    let reach=(b.isSniper || b.isGoat || b.isHeli)?Math.max(baseReach,42):baseReach;
    if (azone===0 && this.battle.hazards?.rain?.active) reach=Math.min(reach,(b.isHeli||b.isGoat||b.isSniper)?30:22);
    const dyS=dy*.72;
    if (d2+dyS*dyS>reach*reach || (b.inkSwimming && d2>77.44)) return null;
    const d=Math.sqrt(d2);
    const hnv=this.battle.hnv1;
    // HNV1 gives crew sharper peripheral awareness while keeping stealth/backstab meaningful.
    const fovMin=a.isBoss?-.69:a.isRaider?(hnv?.15:.36):(hnv?-.34:-.13);
    if (d>(a.isRaider?2.65:5.2)) {
      const bearing=(dx*Math.sin(a.yaw)-dz*Math.cos(a.yaw))/d;
      if (bearing<fovMin) return null;
    }
    const ax=a.x, ay=a.y+eyeHeight(a), az=a.z;
    const bx=b.x, by=b.y, bz=b.z, car=b.car??null;
    const body=visibleHeight(b), count=(b.swimming || b.isRogueDrone)?1:3;
    const battle=this.battle, subs=battle.subweapons, team=a.team;
    const hasFastLine=typeof battle.lineBlocked==='function', hasFastSub=typeof subs?.blockAny==='function';
    for (let i=0;i<count;i++) {
      const py=by+(i===0?body:i===1?body+(b.isBoss?.72:.44):body*.56);
      const wall=hasFastLine?battle.lineBlocked(ax,ay,az,bx,py,bz,1,car):!!battle.traceShot([ax,ay,az],[bx,py,bz],true,false,car);
      if (!wall) {
        const curt=hasFastSub?subs.blockAny(ax,ay,az,bx,py,bz,team):!!subs?.block([ax,ay,az],[bx,py,bz],team);
        if (!curt) return [bx,py,bz];
      }
    }
    return null;
  }

  select(a,previous=null,knownEnemy=null,knownPoint=undefined) {
    const b=this.battle, hnv=b.hnv1;
    let score=Infinity, best=null, point=null;
    const tryEnemy=enemy=>{
      if (!this.live(a,enemy)) return;
      const rank=hnv
        ?hnv.scoreTarget(a,enemy,previous)
        :distance(a,enemy)*(enemy===previous?.82:1)+(enemy.isBoss && a.index%3!==0?7:0);
      if (rank>=score) return;
      const sample=(enemy===knownEnemy && knownPoint!==undefined)?knownPoint:this.sight(a,enemy);
      if (sample) {score=rank;best=enemy;point=sample;}
    };
    const actors=b.actors;
    for (let i=0;i<actors.length;i++) tryEnemy(actors[i]);
    if (!a.isRaider && !a.isBoss) {
      const raiders=b.raiders.members;
      for (let i=0;i<raiders.length;i++) tryEnemy(raiders[i]);
      tryEnemy(b.boss);
      if (b.hazards?.targets) {
        const hazards=b.hazards.targets(a.x);
        for (let i=0;i<hazards.length;i++) tryEnemy(hazards[i]);
      }
    }
    return {enemy:best,point};
  }

  fire(a) {
    if (this.battle.clock-(a.heardAt??-Infinity)<.12) return;
    a.heardAt=this.battle.clock;
    this.sounds.push({x:a.x,y:a.y+.91,z:a.z,team:a.team,until:a.heardAt+.48});
    if (this.sounds.length>32) this.sounds.shift();
  }

  scan(a,dt,{immediate=false}={}) {
    const b=this.battle, hnv=b.hnv1;
    let s=this.memory.get(a);
    if (!s) {
      const before=a.lastSeen?.until>b.clock && zoneOf(a.lastSeen.x)===zoneOf(a.x)?a.lastSeen:null;
      s={enemy:null,point:null,foot:null,velocity:[0,0,0],visible:false,react:0,next:0,heard:null,at:-Infinity,
        level:zoneOf(a.x)};
      if (before) {
        const {x,z}=before, y=b.world.floor(x,z).y;
        s.foot={x,y,z};
        s.point=[x,y+1.08,z];
        s.at=before.until-(a.isRaider?8.3:4.7);
      }
      this.memory.set(a,s);
    }
    const level=zoneOf(a.x);
    if (s.level!==level) {
      s.enemy=s.point=s.foot=s.heard=null;
      a.lastSeen=null;
      s.visible=false;
      s.level=level;
      s.next=0;
    }
    let knownEnemy=null, knownPoint=undefined;
    if (s.enemy && s.visible) {
      knownEnemy=s.enemy;
      knownPoint=this.live(a,s.enemy)?this.sight(a,s.enemy):null;
      if (!knownPoint) {
        s.visible=false;
        s.next=Math.min(s.next,b.clock+(hnv?.03:.05));
      }
    }
    if (immediate || b.clock+dt*.15>=s.next) {
      const {enemy,point}=this.select(a,s.enemy,knownEnemy,knownPoint);
      const same=enemy && enemy===s.enemy;
      const elapsed=b.clock-s.at;
      const observed=same && s.point && elapsed>.03 && elapsed<.41;
      if (point) {
        if (!same || !s.visible) {
          s.react=b.clock+(hnv?hnv.reactionDelay(a):(a.isBoss?.20:.16)+b.rng()*.19);
        }
        if (observed) {
          const inv=1/elapsed, vel=s.velocity, prev=s.point;
          vel[0]=vel[0]*.41+clamp((point[0]-prev[0])*inv,-12,12)*.59;
          vel[1]=vel[1]*.41+clamp((point[1]-prev[1])*inv,-12,12)*.59;
          vel[2]=vel[2]*.41+clamp((point[2]-prev[2])*inv,-12,12)*.59;
        } else {
          s.velocity[0]=0; s.velocity[1]=0; s.velocity[2]=0;
        }
        s.enemy=enemy;
        s.point=point;
        if (s.foot) {s.foot.x=enemy.x; s.foot.y=enemy.y; s.foot.z=enemy.z;}
        else s.foot={x:enemy.x,y:enemy.y,z:enemy.z};
        s.at=b.clock;
        if (a.lastSeen) {a.lastSeen.x=enemy.x; a.lastSeen.z=enemy.z; a.lastSeen.until=b.clock+(a.isRaider?8.3:4.7);}
        else a.lastSeen={x:enemy.x,z:enemy.z,until:b.clock+(a.isRaider?8.3:4.7)};
      } else if (elapsed>4.7) s.enemy=s.point=s.foot=null;
      s.visible=!!point;
      s.next=b.clock+(hnv?.065+b.rng()*.040:.113+b.rng()*.071);
      if (!s.visible) this.listen(a,s);
    }
    if (s.heard?.until<b.clock) s.heard=null;
    return s;
  }

  listen(a,s) {
    const b=this.battle, sounds=this.sounds;
    while (sounds.length && sounds[0].until<b.clock) sounds.shift();
    if (!sounds.length) return;
    let closest=Infinity;
    const hearRange=b.hnv1?22:15, wallRange=b.hnv1?12:7.8, azone=zoneOf(a.x);
    const minSig=s.heard?.signal??0;
    for (let i=0;i<sounds.length;i++) {
      const sound=sounds[i];
      if (a.team===sound.team || azone!==zoneOf(sound.x) || sound.until<=minSig) continue;
      const d=distance(a,sound);
      if (d>hearRange || d>=closest) continue;
      const wall=typeof b.lineBlocked==='function'?b.lineBlocked(a.x,a.y+1.15,a.z,sound.x,sound.y,sound.z):!!b.traceShot([a.x,a.y+1.15,a.z],[sound.x,sound.y,sound.z],true,false);
      if (wall && d>wallRange) continue;
      closest=d;
      const uncertainty=(wall?2.2:1.1+d*.064)*(b.hnv1?.55:1);
      s.heard={x:sound.x+(b.rng()-.5)*uncertainty,z:sound.z+(b.rng()-.5)*uncertainty,until:b.clock+1.65,signal:sound.until};
    }
  }

  aim(a,s) {
    if (this.battle.hnv1) return this.battle.hnv1.predictAim(a,s);
    const dx=s.point[0]-a.x, dz=s.point[2]-a.z;
    const d=Math.sqrt(dx*dx+dz*dz);
    const lead=Math.min(.44,d/a.weapon.speed*.83+Math.min(.12,this.battle.clock-s.at));
    const p=s.point, v=s.velocity;
    return [p[0]+v[0]*lead,p[1]+v[1]*lead*.5,p[2]+v[2]*lead];
  }
}
