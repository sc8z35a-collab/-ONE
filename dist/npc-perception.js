import {zoneOf} from './layout.js';
import {clamp,forward} from './render.js';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const eyeHeight=a=>a.isBoss?2.86:a.swimming?.57:1.39-(a.brace??0)*.31;
export const visibleHeight=a=>a.isGoat?2.1:a.isBoss?2.45:a.isRogueDrone?.05:a.isSniper?1.15:a.giant?1.51:a.swimming?.37:a.isRaider?1.11:1.09-(a.brace??0)*.30;

export class NpcPerception {
  constructor(battle) {
    this.battle=battle;
    this.memory=new WeakMap();
    this.sounds=[];
  }

  live(a,b) {
    return !!b && a!==b && (a.team!==b.team || a.isBoss) && (b.down??0)<=0 && (b.shield??0)<=0 &&
      Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z) && !b.lift && !b.ride &&
      (!(b.isBoss || b.isRaider || b.isSniper || b.isRogueDrone || b.isGoat) || b.active);
  }

  sight(a,b) {
    if (!this.live(a,b) || zoneOf(a.x)!==zoneOf(b.x)) return null;
    const dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z, d=Math.hypot(dx,dz);
    const baseReach=a.isBoss?39:a.isRaider?28:a.weapon.blast?18:Math.min(36,a.weapon.range*.96);
    const reach=(b.isSniper || b.isGoat)?Math.max(baseReach,34):baseReach;
    if (d*d+(dy*.72)*(dy*.72)>reach*reach || (b.inkSwimming && d>8.8)) return null;
    const bearing=(dx*Math.sin(a.yaw)-dz*Math.cos(a.yaw))/(d>.01?d:.01);
    const hnv=this.battle.hnv1;
    // HNV1 gives crew sharper peripheral awareness while keeping stealth/backstab meaningful.
    const fovMin=a.isBoss?-.69:a.isRaider?(hnv?.15:.36):(hnv?-.34:-.13);
    if (d>(a.isRaider?2.65:5.2) && bearing<fovMin) return null;
    const eye=[a.x,a.y+eyeHeight(a),a.z];
    const body=visibleHeight(b), count=(b.swimming || b.isRogueDrone)?1:3;
    for (let i=0;i<count;i++) {
      const h=i===0?body:i===1?body+(b.isBoss?.72:.44):body*.56;
      const point=[b.x,b.y+h,b.z];
      if (!this.battle.traceShot(eye,point,true,true,0,b.car??null) && !this.battle.subweapons.block(eye,point,a.team)) return point;
    }
    return null;
  }

  select(a,previous=null) {
    const b=this.battle, hnv=b.hnv1;
    let score=Infinity, best=null, point=null;
    const tryEnemy=enemy=>{
      if (!this.live(a,enemy)) return;
      const rank=hnv
        ?hnv.scoreTarget(a,enemy,previous)
        :distance(a,enemy)*(enemy===previous?.82:1)+(enemy.isBoss && a.index%3!==0?7:0);
      if (rank>=score) return;
      const sample=this.sight(a,enemy);
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
    if (s.enemy && s.visible && (!this.live(a,s.enemy) || !this.sight(a,s.enemy))) {
      s.visible=false;
      s.next=Math.min(s.next,b.clock+(hnv?.03:.05));
    }
    if (immediate || b.clock+dt*.15>=s.next) {
      const {enemy,point}=this.select(a,s.enemy);
      const same=enemy && enemy===s.enemy;
      const observed=same && s.point && b.clock-s.at>.03 && b.clock-s.at<.41;
      if (point) {
        if (!same || !s.visible) {
          s.react=b.clock+(hnv?hnv.reactionDelay(a):(a.isBoss?.20:.16)+b.rng()*.19);
        }
        s.velocity=observed?s.velocity.map((old,i)=>old*.41+clamp((point[i]-s.point[i])/(b.clock-s.at),-12,12)*.59):[0,0,0];
        s.enemy=enemy;
        s.point=point;
        s.foot={x:enemy.x,y:enemy.y,z:enemy.z};
        s.at=b.clock;
        a.lastSeen={x:enemy.x,z:enemy.z,until:b.clock+(a.isRaider?8.3:4.7)};
      } else if (b.clock-s.at>4.7) s.enemy=s.point=s.foot=null;
      s.visible=!!point;
      s.next=b.clock+(hnv?.065+b.rng()*.040:.113+b.rng()*.071);
      if (!s.visible) this.listen(a,s);
    }
    if (s.heard?.until<b.clock) s.heard=null;
    return s;
  }

  listen(a,s) {
    const b=this.battle;
    while (this.sounds[0]?.until<b.clock) this.sounds.shift();
    let closest=Infinity;
    const hearRange=b.hnv1?22:15;
    for (const sound of this.sounds) {
      if (a.team===sound.team || zoneOf(a.x)!==zoneOf(sound.x) || sound.until<=(s.heard?.signal??0)) continue;
      const d=distance(a,sound);
      if (d>hearRange || d>=closest) continue;
      const wall=b.traceShot([a.x,a.y+1.15,a.z],[sound.x,sound.y,sound.z],true);
      if (wall && d>(b.hnv1?12:7.8)) continue;
      closest=d;
      const uncertainty=(wall?2.2:1.1+d*.064)*(b.hnv1?.55:1);
      s.heard={x:sound.x+(b.rng()-.5)*uncertainty,z:sound.z+(b.rng()-.5)*uncertainty,until:b.clock+1.65,signal:sound.until};
    }
  }

  aim(a,s) {
    if (this.battle.hnv1) return this.battle.hnv1.predictAim(a,s);
    const d=Math.hypot(s.point[0]-a.x,s.point[2]-a.z);
    const lead=Math.min(.44,d/a.weapon.speed*.83+Math.min(.12,this.battle.clock-s.at));
    return s.point.map((value,i)=>value+s.velocity[i]*lead*(i===1?.5:1));
  }
}
