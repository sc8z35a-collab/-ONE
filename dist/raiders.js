import {TAU,add,clamp,forward,scale} from './render.js';
import {BASE_TANK,isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {randomGenerator} from './world.js';
import {drawTentacle} from './creature-models.js';
import {bearing,muzzleClear} from './npc-combat.js';

export const RAIDER_INK=0xa66fbd;
export const RAIDER_WEAPON={id:'nz4',name:'タコNZ4',speed:74,gravity:6.8,range:26,damage:44,cost:4.1,delay:.255,radius:.74,
  depth:0,pellets:1,spread:.042,arc:0,size:.155};
const RAID_START=80, RAID_INTERVAL=118, RAID_STAY=99;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

export class Raiders {
  constructor(battle) {
    this.battle=battle;
    this.rng=randomGenerator(Math.floor(Math.random()*4294967296));
    this.members=[];
    this.next=RAID_START;
    this.wave=0;
    this.alert='';
    this.alertUntil=0;
    this.retreatAt=0;
  }

  spawn() {
    const b=this.battle;
    this.members=[];
    this.wave++;
    for (let i=0;i<4;i++) {
      const nav=i%2===0?b.nav:b.lowerNav;
      let p=nav.nodes[Math.floor(this.rng()*nav.nodes.length)];
      for (let k=0;k<48;k++) {
        const candidate=nav.nodes[Math.floor(this.rng()*nav.nodes.length)];
        if (b.actors.some(a=>a.down<=0 && distance(a,candidate)<5.6) ||
            this.members.some(a=>distance(a,candidate)<7.5)) continue;
        p=candidate;
        break;
      }
      const y=b.world.floor(p.x,p.z).y;
      const raider={x:p.x,y,z:p.z,team:-1,index:i,isRaider:true,name:'ゼイアン '+String(i+1).padStart(2,'0'),
        hp:185,maxHp:185,tank:BASE_TANK,tankMax:BASE_TANK,weapon:RAIDER_WEAPON,down:0,active:true,shield:0,
        yaw:this.rng()*TAU,pitch:0,fire:.4,heat:0,recoil:0,superCharge:23+i*9,
        scan:0,giant:false,giantUntil:0,superReady:0,attack:null,nextStrike:0,target:null,
        vx:0,vz:0,vy:0,coyote:0,jumpBuffer:0,steps:0,route:[],radius:.48,height:1.61,kills:0,painted:0,roamAt:0,
        nextTransit:b.clock+7+this.rng()*13,damageAge:99};
      b.hnv1?.mind(raider);
      this.members.push(raider);
    }
    this.retreatAt=b.elapsed+RAID_STAY;
    this.next=b.elapsed+RAID_INTERVAL;
    this.alert='オクトパスゼイアン ×4 襲撃';
    this.alertUntil=b.clock+4.8;
    b.callbacks.sound?.('boss');
  }

  live() {
    return this.members.filter(a=>a.active);
  }

  hurt(a,amount,source) {
    if (!a.active || a.shield>0) return 0;
    const lost=Math.min(a.hp,amount*(a.giant?.63:1));
    a.hp-=lost;
    a.damageAge=0;
    a.superCharge=Math.min(100,a.superCharge+lost*.49);
    if (a.hp<=0) {
      a.active=false;
      a.down=Infinity;
      if (source) source.kills++;
      const b=this.battle;
      b.events.unshift({label:(source?.name ?? '襲撃')+'  ▸  '+a.name,team:source?.team ?? -1,until:b.clock+3.5});
      b.events.length=Math.min(b.events.length,4);
      if (!this.members.some(x=>x.active)) {
        this.alert='襲撃隊を撃退';
        this.alertUntil=b.clock+4;
        b.callbacks.sound?.('bossDown');
      }
    }
    return lost;
  }

  resolve(a,attack) {
    const b=this.battle, giant=attack.giant;
    const start=[a.x,a.y+(giant?1.37:.94),a.z], direction=forward(attack.yaw);
    const reach=giant?8.5:8.1;
    const end=add(start,scale(direction,reach)), wall=b.traceShot(start,end,true);
    if (wall?.train) wall.train.damage(giant?29:9);
    const length=reach*(wall?.t ?? 1);
    for (const target of b.actors) {
      if (target.down>0 || target.ride || target.lift || !sameLevel(target.x,a.x)) continue;
      const dx=target.x-a.x,dz=target.z-a.z,d=Math.hypot(dx,dz);
      const along=dx*direction[0]+dz*direction[2], side=Math.abs(dx*direction[2]-dz*direction[0]);
      if (giant?d>5.25 && (along<0 || along>length || side>2.25):along<0 || along>length || side>.93) continue;
      if (Math.abs(target.y-a.y)>2.15 || b.traceShot(start,[target.x,target.y+.82,target.z],true)?.t<.956) continue;
      if (b.damage(target,giant?112:83,a,[target.x,target.y+.72,target.z]) && target.down<=0) {
        const impulse=giant?1.22:.65;
        b.stepActor(target,dx/Math.max(.2,d)*impulse,dz/Math.max(.2,d)*impulse);
      }
    }
    const point=add(start,scale(direction,Math.min(length,4.2)));
    b.burst(point,-1,giant?17:8,giant?4.05:2.84);
  }

  move(a,yaw,speed,dt,look=yaw,pitch) {
    const b=this.battle, [dx,,dz]=forward(yaw), x=localX(a.x),z=a.z;
    b.motion.drive(a,dx*speed,dz*speed,dt,{look,pitch});
    return Math.hypot(localX(a.x)-x,a.z-z)>dt*.32;
  }

  patrol(a,dt) {
    const b=this.battle;
    if (b.tactics.raider(a,dt)) return;
    const seen=a.lastSeen;
    if (seen?.until>b.clock && sameLevel(a.x,seen.x) && distance(a,seen)>1.3 &&
        b.navigate(a,seen,dt,3.2,false,{look:bearing(a,[seen.x,0,seen.z]),ready:.71})) return;
    if (!a.goal || a.roamAt<b.clock || distance(a,a.goal)<.8) {
      const nav=b.navs[zoneOf(a.x)], n=nav.nodes.length;
      let candidate=null;
      for (let i=0;i<14;i++) {
        const p=nav.nodes[Math.floor(this.rng()*n)];
        if (distance(a,p)>1.5 && distance(a,p)<18) {candidate=p;break;}
      }
      a.goal=candidate;
      a.roamAt=b.clock+3.6+this.rng()*2.6;
    }
    if (a.goal) {
      if (b.navigate(a,a.goal,dt,2.85)) return;
      a.goal=null;
    }
    b.motion.drive(a,0,0,dt,{look:a.yaw+dt*(a.index%2?1:-1)*1.94});
  }

  update(dt) {
    const b=this.battle;
    if (!b.timeless) return;
    if (b.elapsed>=this.next-1e-6) this.spawn();
    if (this.members.length && b.elapsed>=this.retreatAt) {
      if (this.members.some(a=>a.active)) {
        this.alert='オクトパスゼイアン撤退';
        this.alertUntil=b.clock+3.6;
      }
      for (const a of this.members) a.active=false;
      this.members=[];
    }
    for (const a of this.members) {
      if (!a.active) continue;
      a.shield=Math.max(0,a.shield-dt);
      a.fire-=dt;
      a.heat-=dt;
      a.recoil=Math.max(0,a.recoil-dt*7);
      a.damageAge+=dt;
      a.tank=Math.min(a.tankMax,a.tank+(a.heat<=0?21:2.3)*dt);
      if (b.carryTransit(a,dt)) continue;
      if (a.giant && a.giantUntil<=b.clock) {
        a.giant=false;
        a.radius=.48;
        a.height=1.61;
      }
      if (a.attack) {
        const attack=a.attack;
        if (b.clock<attack.end) b.motion.drive(a,0,0,dt,{look:attack.yaw});
        if (!attack.hit && b.clock>=attack.at) {
          attack.hit=true;
          this.resolve(a,attack);
        }
        if (b.clock<attack.end) continue;
        a.attack=null;
      }
      const sight=b.perception.scan(a,dt);
      const target=a.target=sight.visible?sight.enemy:null;
      if (!target) {
        b.hnv1?.tick(a,dt,sight);
        this.patrol(a,dt);
        continue;
      }
      const hnvPlan=b.hnv1?.raiderEngage(a,target,sight,dt);
      const point=hnvPlan?hnvPlan.aim:b.perception.aim(a,sight);
      const d=hnvPlan?hnvPlan.d:distance(a,sight.foot);
      const yaw=hnvPlan?hnvPlan.yaw:bearing(a,point);
      const pitch=hnvPlan?hnvPlan.pitch:clamp(Math.atan2(point[1]-a.y-1.25,Math.max(1,d)),-.52,.46);
      if (!a.giant) a.superCharge=Math.min(100,a.superCharge+dt*(d<15?8.7:5.1));
      if (!a.giant && a.superCharge>=100 && b.clock>=a.superReady && !b.bodyBlocked(a,.67,2.25)) {
        a.giant=true;
        a.giantUntil=b.clock+8.6;
        a.superReady=b.clock+17;
        a.superCharge=0;
        a.radius=.67;
        a.height=2.25;
        b.burst([a.x,a.y+.32,a.z],-1,18,3.6);
        a.nextStrike=b.clock+.47;
        continue;
      }
      const canStrike=d<(a.giant?8.1:7.15) && b.clock>=Math.max(a.nextStrike,sight.react) && Math.cos(yaw-a.yaw)>.87;
      if (canStrike) {
        const windup=a.giant?.56:.38;
        a.attack={yaw,from:b.clock,at:b.clock+windup,end:b.clock+windup+.29,giant:a.giant,hit:false};
        a.nextStrike=b.clock+(a.giant?1.24:2.22);
        b.motion.drive(a,0,0,dt,{look:yaw,pitch});
        continue;
      }
      if (!a.giant && d>3.4 && d<26 && Math.cos(yaw-a.yaw)>.962 && a.fire<=0 && b.clock>=sight.react) {
        const spread=hnvPlan?hnvPlan.spread:.22+d*.027;
        const shotPoint=point.map((p,i)=>i===1?p:p+(this.rng()-.5)*spread);
        if (muzzleClear(b,a,shotPoint)) b.shoot(a,shotPoint);
      }
      if (hnvPlan) this.move(a,hnvPlan.moveYaw,hnvPlan.speed,dt,yaw,pitch);
      else if (a.giant || d>9.3) this.move(a,a.yaw,a.giant?4.52:3.02,dt,yaw,pitch);
      else if (d<4.05 && !a.giant) this.move(a,a.yaw+Math.PI,1.73,dt,yaw,pitch);
      else this.move(a,a.yaw+(a.index%2?1:-1)*1.11,1.58,dt,yaw,pitch);
    }
  }

  draw(r,viewX) {
    const time=this.battle.clock;
    for (const a of this.members) {
      if (!a.active || !sameLevel(a.x,viewX)) continue;
      drawRaider(r,a,time);
    }
  }
}

export function drawRaider(r,a,time,attackVisible=true) {
  const size=a.giant?(isCabin(a.x)?1.27:1.80):1;
  const yaw=Math.PI-a.yaw, cy=Math.cos(yaw),sy=Math.sin(yaw);
  const at=(x,y,z)=>[a.x+(x*cy+z*sy)*size,a.y+y*size,a.z+(-x*sy+z*cy)*size];
  const skin=a.giant?0x865589:0x96668d, light=a.giant?0xe19b78:0xc48b9a, shell=0x533e60;
  const part=(kind,x,y,z,w,h,d,tint,mat=2)=>r.add(kind,...at(x,y,z),w*size,h*size,d*size,tint,mat,{dynamic:true,yaw});
  const pulse=Math.sin(time*5.6+a.index);
  part('orb',0,.91,-.11,.99,1.01,.88,skin,9);
  part('orb',0,1.38,-.16,.93,.85,.80,skin,9);
  part('orb',0,1.35,.16,.78,.37,.43,shell,4);
  for (const sign of [-1,1]) {
    part('orb',sign*.23,1.37,.34,.25,.18,.112,0xf4ca8c,3);
    part('orb',sign*.22,1.37,.392,.08,.158,.031,0x34273d,4);
    part('orb',sign*.38,1.45,-.05,.13,.26,.40,light,9);
  }
  const arms=8, links=r.lite?3:6;
  for (let i=0;i<arms;i++) {
    if (i===3 && attackVisible && a.attack) continue;
    const angle=i*TAU/arms;
    const points=[at(Math.cos(angle)*.26,.53,Math.sin(angle)*.25)];
    for (let j=1;j<=links;j++) {
      const t=j/links, rr=.31+t*(.59+(a.giant?.26:.05));
      const arc=angle+Math.sin(time*6+i+t*2)*.24*t;
      const y=.49*(1-t)+.115+Math.max(0,Math.sin(a.steps*3+i+t*3))*.17*t;
      const next=at(Math.cos(arc)*rr,y,Math.sin(arc)*rr);
      points.push(next);
    }
    if (i===2 && !a.giant) points.splice(0,points.length,at(-.22,.64,.14),at(-.39,.72,.26),at(-.37,.91,.43));
    drawTentacle(r,points,.30*size,skin,light);
  }
  if (!a.giant) {
    const recoil=a.recoil*.11;
    part('bevel',-.37,.94,.45,.19,.22,.45,0x313b40,4);
    part('box',-.37,1.025,.49-recoil,.178,.13,.46,0x697375,4);
    part('box',-.37,1.103,.65-recoil,.042,.046,.067,0x302f39,4);
    part('box',-.37,.842,.41,.134,.213,.16,0x443743,4);
    part('box',-.37,1.021,.728-recoil,.09,.083,.024,0x222c32,4);
    part('bevel',0,.94,-.49,.30,a.tankMax>BASE_TANK?.82:.57,.26,0x645170,4);
  }
  if (!a.attack || !attackVisible) return;
  const attack=a.attack, direction=forward(attack.yaw);
  const wind=clamp((time-attack.from)/(attack.at-attack.from),0,1);
  const strike=attack.hit?clamp((attack.end-time)/.29,0,1):0;
  if (!strike) {
    const radius=a.giant?5.45:2.09;
    const x=a.x+direction[0]*(a.giant?0:3.95),z=a.z+direction[2]*(a.giant?0:3.95);
    r.add('ripple',x,a.y+.027,z,radius*2,.027,radius*2,0xe6a07d,12,{dynamic:true,label:.24+wind*.16});
  }
  const reach=strike*(a.giant?8.1:7.7)+wind*.9;
  const strikePoints=[[a.x,a.y+1.0*size,a.z]];
  for (let j=1;j<=7;j++) {
    const t=j/7, curve=Math.sin(t*Math.PI)*(.38+pulse*.08)*strike;
    const next=[a.x+direction[0]*reach*t-direction[2]*curve,a.y+(.97+.72*Math.sin(t*Math.PI)*wind)*size,
      a.z+direction[2]*reach*t+direction[0]*curve];
    strikePoints.push(next);
  }
  drawTentacle(r,strikePoints,(a.giant?.57:.37),RAIDER_INK,light);
}
