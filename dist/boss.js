import {TAU,add,clamp,forward,scale} from './render.js';
import {zoneOf} from './layout.js';
import {drawBossModel} from './boss-model.js';
import {BOSS_ATTACK_TIMING,bossArc,drawBossAttack} from './boss-effects.js';

export const BOSS_TIME=180;
const CADENCE=[3.17,2.65,2.16];
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

function reached(attack,actor,previous,current) {
  const dx=actor.x-attack.x,dz=actor.z-attack.z, range=Math.hypot(dx,dz);
  if (range>attack.radius || Math.abs(actor.y-attack.y)>(attack.kind==='slam'?1.08:2.35)) return false;
  let progress=0;
  if (attack.kind==='slam') progress=range/attack.radius;
  if (attack.kind==='sweep') {
    const delta=Math.atan2(dx,-dz)-attack.yaw;
    const angle=Math.atan2(Math.sin(delta),Math.cos(delta));
    if (Math.abs(angle)>attack.halfAngle) return false;
    progress=(angle+attack.halfAngle)/(2*attack.halfAngle);
  }
  return progress>=previous-.075 && progress<=current+.075;
}

export class Boss {
  constructor(battle) {
    this.battle=battle;
    this.isBoss=true;
    this.name='オオモノイカ';
    this.team=-1;
    this.x=0;
    this.y=0;
    this.z=-6.85;
    this.yaw=Math.PI;
    this.vx=this.vz=0;
    this.radius=1.05;
    this.height=3.5;
    this.hp=0;
    this.maxHp=battle.teamSize===8?6300:4200;
    this.down=0;
    this.shield=0;
    this.phase=1;
    this.active=false;
    this.spawned=false;
    this.alert='';
    this.alertUntil=0;
    this.next=0;
    this.volley=0;
    this.route=[];
    this.stuck=0;
    this.scan=0;
    this.patrol=null;
    this.patrolAt=0;
    this.target=null;
    this.cast=null;
    this.attacks=[];
  }

  spawn() {
    const b=this.battle;
    this.active=this.spawned=true;
    this.hp=this.maxHp;
    this.y=b.world.floor(this.x,this.z).y;
    this.alert='オオモノイカ乱入';
    this.alertUntil=b.clock+4.7;
    this.next=b.clock+2.35;
    b.callbacks.sound?.('boss');
  }

  hurt(damage) {
    if (!this.active) return 0;
    const lost=Math.min(this.hp,damage);
    this.hp-=lost;
    const ratio=this.hp/this.maxHp, phase=ratio<.34?3:ratio<.69?2:1;
    if (this.hp<=0) {
      this.active=false;
      this.alert='オオモノイカ撃破';
      this.alertUntil=this.battle.clock+4.9;
      this.attacks.length=0;
      this.cast=null;
      this.battle.callbacks.sound?.('bossDown');
    } else if (phase!==this.phase) {
      this.alert=phase===3?'オオモノイカ暴走':'オオモノイカが攻撃を強化';
      this.alertUntil=this.battle.clock+2.7;
      this.next=Math.min(this.next,this.battle.clock+1.12);
    }
    this.phase=phase;
    return lost;
  }

  targets() {
    return this.battle.actors.filter(a=>a.down<=0 && !a.lift && !a.ride && zoneOf(a.x)===0);
  }

  attack(x,z,radius,delay,damage,{kind='mortar',y,wait=0,yaw=this.yaw,halfAngle,arc}={}) {
    const b=this.battle, start=b.clock+wait;
    const attack={kind,x,z,y:y??b.world.floor(x,z).y+.025,yaw,halfAngle,arc,radius,phase:this.phase,
      start,at:start+delay,damage,done:false,hit:[]};
    this.attacks.push(attack);
    return attack;
  }

  launchMortar(target,index,followup=false) {
    const b=this.battle, phase=this.phase;
    const angle=b.rng()*TAU, spread=followup?2.65:.39, lead=phase===1?.06:phase===2?.22:.36;
    const x=clamp(target.x+(target.vx??0)*lead+Math.cos(angle)*spread,-52.7,52.7);
    const z=clamp(target.z+(target.vz??0)*lead+Math.sin(angle)*spread,-34.2,34.2);
    const ground=b.downwardSurface(x,target.y,z)?.position[1]??b.world.floor(x,z).y;
    const [dx,,dz]=forward(this.yaw);
    const from=[this.x+dx*1.22,this.y+3.49,this.z+dz*1.22], to=[x,ground+.06,z];
    const range=Math.hypot(x-this.x,z-this.z), lift=clamp(2.45+range*.15,2.5,7.25);
    const arc={from,to,lift,end:1,launch:.18};
    let previous=from, impact=to;
    const steps=Math.max(12,Math.ceil(range/1.7));
    for (let i=1;i<=steps;i++) {
      const point=bossArc(arc,i/steps);
      const hit=b.traceShot(previous,point,true,false);
      if (hit) {
        arc.end=(i-1+hit.t)/steps;
        impact=add(hit.position,scale(hit.normal,.045));
        break;
      }
      previous=point;
    }
    const delay=clamp((.91+range*.017)*arc.end,.83,1.63);
    return this.attack(impact[0],impact[2],3.16+phase*.45,delay,80+phase*9,
      {y:impact[1],wait:index*.17,arc});
  }

  plan(target,range,targets) {
    const phase=this.phase, clock=this.battle.clock;
    this.yaw=Math.atan2(target.x-this.x,this.z-target.z);
    const turn=this.volley++;
    let attack;
    if (range<=11.6 && (turn%3!==2 || range<=5.5)) {
      const slam=range<=8.6 && turn%2!==0;
      attack=slam?this.attack(this.x,this.z,5.2+phase*.76,1.05,112+phase*11,{kind:'slam',y:this.y+.025}):
        this.attack(this.x,this.z,9.8+phase*.73,.92,106+phase*10,
          {kind:'sweep',y:this.y+.025,halfAngle:.96+phase*.085});
    } else {
      const group=[0,1].map(team=>targets.find(actor=>actor.team===team && distance(this,actor)<38+phase*2)).filter(Boolean);
      for (const [i,actor] of group.entries()) {
        const mortar=this.launchMortar(actor,i);
        if (!attack) attack=mortar;
      }
      if (group.length && phase===3) this.launchMortar(group[turn%group.length],group.length,true);
    }
    this.next=clock+CADENCE[phase-1];
    if (attack) this.cast={kind:attack.kind,start:attack.start,at:attack.at,
      end:attack.at+BOSS_ATTACK_TIMING[attack.kind].active+.30,yaw:this.yaw};
  }

  updateAttacks(dt,targets) {
    const b=this.battle;
    for (const a of this.attacks) {
      if (a.done || a.at>b.clock) continue;
      const active=(BOSS_ATTACK_TIMING[a.kind]??BOSS_ATTACK_TIMING.mortar).active;
      const age=b.clock-a.at;
      const previous=active?clamp((age-dt)/active,0,1):0, current=active?clamp(age/active,0,1):1;
      const origin=[a.x,a.y+.39,a.z];
      a.hit??=[];
      if (current>=1) a.done=true;
      for (const actor of targets) {
        const key=actor.team*16+actor.index;
        if (a.hit.includes(key) || !reached(a,actor,previous,current)) continue;
        const destination=[actor.x,actor.y+(actor.swimming?.36:.84),actor.z];
        const barrier=b.traceShot(origin,destination,true,false);
        if (barrier?.t<.95 || b.subweapons.block(origin,destination,this.team)?.t<.95) continue;
        if (b.damage(actor,a.damage,null,destination,'boss')) a.hit.push(key);
      }
      if (a.done && a.kind!=='sweep') b.stage.damageArea(b,this,a.x,a.y,a.z,a.radius,a.damage*.68);
    }
    this.attacks=this.attacks.filter(a=>{
      const timing=BOSS_ATTACK_TIMING[a.kind]??BOSS_ATTACK_TIMING.mortar;
      return b.clock<a.at+timing.active+timing.linger;
    });
  }

  update(dt) {
    const b=this.battle;
    if (!this.spawned && b.duration-b.left>=BOSS_TIME-1e-6) this.spawn();
    if (!this.active) return;
    const targets=this.targets();
    this.updateAttacks(dt,targets);
    if (this.cast && b.clock>=this.cast.end) this.cast=null;
    if (this.cast) {
      b.motion.drive(this,0,0,dt,{look:this.cast.yaw});
      return;
    }
    const sight=b.perception.scan(this,dt);
    this.target=sight.visible?sight.enemy:null;
    const contact=sight.foot && b.clock-sight.at<6?sight.foot:sight.heard;
    if (!contact && (b.clock>this.patrolAt || !this.patrol || distance(this,this.patrol)<3)) {
      const points=b.tactics.sectors[0].filter(node=>distance(this,node)>5 && distance(this,node)<20 && Math.abs(node.x)<33 &&
        b.nav.clear(this,node,this.radius,this.height));
      this.patrol=points.length?points[Math.floor(b.rng()*points.length)]:null;
      this.patrolAt=b.clock+3.8;
    }
    const goal=contact ?? this.patrol;
    const range=goal?distance(this,goal):Infinity;
    if (goal && range>5) {
      if (!b.navigate(this,goal,dt,2.96+this.phase*.57)) b.motion.drive(this,0,0,dt,{look:Math.atan2(goal.x-this.x,this.z-goal.z)});
      this.y=b.world.floor(this.x,this.z).y;
    } else b.motion.drive(this,0,0,dt,{look:goal?Math.atan2(goal.x-this.x,this.z-goal.z):this.yaw+dt*.63});
    if (!sight.visible || b.clock<Math.max(this.next,sight.react) || range>38+this.phase*2) return;
    const bearing=Math.atan2(goal.x-this.x,this.z-goal.z);
    if (Math.cos(this.yaw-bearing)<.95) return;
    const ready=targets.filter(actor=>b.perception.sight(this,actor)).sort((a,c)=>distance(this,a)-distance(this,c));
    if (ready.includes(this.target)) this.plan(goal,range,ready);
  }

  draw(r,viewX) {
    if (zoneOf(viewX)!==0 || !this.active) return;
    const now=this.battle.clock+(this.battle.impactAgeOffset??0);
    drawBossModel(r,this,now);
    for (const a of this.attacks) drawBossAttack(r,a,now,this.phase);
  }
}
