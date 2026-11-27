import {TAU,clamp,forward,scale,sub,unit} from './render.js';
import {giantHeight,isCabin,sameLevel,zoneOf} from './layout.js';
import {TEAM,TEAM_INK} from './world.js';
import {DRONE_HOMING,DRONE_WEAPON,SUPERS} from './weapons.js';
import {AdvancedSupers} from './advanced-super.js';
import {drawTentacle} from './creature-models.js';
import {stairNeighborShift,stairRay} from './stairs.js';

export const DRONE_COOLDOWN=60;
const DRONE_LIFETIME=23;
// The drone fires one tracking round a second at the nearest opponent it can see.
export const DRONE_FIRE_INTERVAL=1;
// Player-only deployable energy shield: absorbs 90% of incoming damage up to PLAYER_SHIELD_HP.
export const PLAYER_SHIELD_HP=240;
export const PLAYER_SHIELD_DURATION=9;
export const PLAYER_SHIELD_COOLDOWN=12;

const _sqDynYP={dynamic:true,yaw:0,pitch:0};
const _sqPts6=[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const _sqPts4=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];

export function drawSquid(r,a,time,tint,eyeTint,scale) {
  const yaw=Math.PI-a.yaw, sy=Math.sin(yaw), cy=Math.cos(yaw);
  const ax=a.x, ay=a.y, az=a.z, lite=!!r.lite;
  const setAt=(dst,x,y,z)=>{dst[0]=ax+(x*cy+z*sy)*scale; dst[1]=ay+y*scale; dst[2]=az+(-x*sy+z*cy)*scale;};
  _sqDynYP.yaw=yaw;
  const part=(type,x,y,z,w,h,d,color,kind=9,pitch=0)=>{
    _sqDynYP.pitch=pitch;
    r.add(type,ax+(x*cy+z*sy)*scale,ay+y*scale,az+(-x*sy+z*cy)*scale,w*scale,h*scale,d*scale,color,kind,_sqDynYP);
  };
  const sway=Math.sin(time*4.8), breath=1+Math.sin(time*5.4)*.045;
  const speed=Math.hypot(a.vx??0,a.vz??0), flap=Math.sin(time*(6.5+speed*.5))*(.18+clamp(speed*.04,0,.22));
  part('orb',0,.87,-.15,1.20*breath,1.43,1.28*breath,tint);
  part('cone',0,1.43,-.24,1.10*breath,1.18,1.12*breath,tint,9,-.08);
  if (!lite) {
    // Glowing mantle crest rings & crown energy ridge
    part('ring',0,1.28,-.20,1.12,.06,1.14,eyeTint,3,-.08);
    part('bevel',0,1.88,-.28,.12,.45,.52,eyeTint,3,-.18);
  }
  for (const sign of [-1,1]) {
    part('orb',sign*(.48+flap*.14),1.42,-.39,.36,.59,.18,tint,9,sign*(.34+flap));
    part('orb',sign*.44,.20,.68+.09*sway,.24,.22,.69,tint,9,.22);
  }
  part('orb',0,1.08,.45,.99,.57,.44,0x354448,4);
  for (const sign of [-1,1]) {
    part('orb',sign*.26,1.13,.65,.34,.27,.11,eyeTint,3);
    part('orb',sign*.25,1.13,.718,.12,.22,.055,0x252e32,4);
    part('orb',sign*.54,.59,-.08,.39,.72,.42,tint,9,-sign*(.3+flap*.4));
  }
  const links=lite?3:5;
  const pts=links===5?_sqPts6:_sqPts4;
  for (let i=0;i<8;i++) {
    const angle=i*TAU/8;
    for (let j=0;j<=links;j++) {
      const t=j/links, arc=angle+Math.sin(time*5.3+i+t*2.4)*t*.26;
      const reach=.30+t*.72;
      setAt(pts[j],Math.cos(arc)*reach,.20+.20*(1-t)+Math.sin(time*6.7+i+t*2)*t*.055,Math.sin(arc)*reach);
    }
    drawTentacle(r,pts,.27*scale,tint,eyeTint,lite?0:eyeTint);
  }
  for (const sign of [-1,1]) {
    setAt(_sqPts4[0],sign*.26,.56,.36);
    setAt(_sqPts4[1],sign*.47,.24,.80);
    setAt(_sqPts4[2],sign*(.56+sway*.07),.12+.04*Math.cos(time*5.8),1.14);
    setAt(_sqPts4[3],sign*(.47+sway*.11),.21+.05*Math.sin(time*6.4),1.38);
    drawTentacle(r,_sqPts4,.22*scale,tint,eyeTint,lite?0:eyeTint);
  }
}

export class Abilities {
  constructor(battle) {
    this.battle=battle;
    this.drones=[];
    this.rings=[];
    this.advanced=new AdvancedSupers(this);
  }

  credit(actor) {
    const painted=Math.max(0,actor.painted-actor.countedPaint);
    actor.countedPaint=actor.painted;
    actor.superCharge=Math.min(100,actor.superCharge+painted*this.battle.paint.cellArea*1.38*(1-(actor.inkPenalty??0)*.064));
  }

  clearSuper(actor) {
    actor.superUntil=0;
    actor.activeSpecial=null;
    actor.slam=null;
    actor.giant=actor.beaming=false;
    actor.radius=actor.height=undefined;
    actor.maxHp=actor.baseHp??100;
    actor.hp=Math.min(actor.hp,actor.maxHp);
    actor.guard=0;
    actor.rangeFactor=1;
  }

  slamMotion(actor,startY=actor.y) {
    const b=this.battle, height=actor.height??1.72;
    const hit=b.downwardSurface(actor.x,startY,actor.z), floor=b.world.floor(actor.x,actor.z);
    const y=hit?.position[1]??floor.y, top=Math.max(startY,y);
    const head=[actor.x,startY+height-.025,actor.z];
    const ceiling=b.traceShot(head,[actor.x,top+height+2.68,actor.z],true);
    const rise=ceiling?clamp(ceiling.position[1]-top-height-.045,0,2.62):2.62;
    return {y,startY,rise};
  }

  canActivate(actor) {
    return actor.down<=0 && !actor.lift && !actor.ride && !actor.cloneOf && actor.superCharge>=100 && (actor.superUntil??0)<=this.battle.clock &&
      (actor.weapon.special!=='giant' || !this.battle.bodyBlocked(actor,.64,giantHeight(actor.x)));
  }

  activate(actor) {
    const b=this.battle, id=actor.weapon.special, special=SUPERS[id];
    if (!this.canActivate(actor)) return false;
    actor.superCharge=0;
    actor.superUntil=b.clock+special.seconds;
    actor.activeSpecial=id;
    if (id==='shield') actor.guard=95;
    if (id==='giant') {
      actor.giant=true;
      actor.radius=.64;
      actor.height=giantHeight(actor.x);
      actor.giantNext=b.clock;
      actor.swimming=actor.inkSwimming=false;
      actor.charge=0;
    }
    if (id==='range') actor.rangeFactor=1.75;
    if (id==='health') {
      const bonus=actor.baseHp??100;
      actor.maxHp=bonus*2;
      actor.hp=Math.min(actor.maxHp,actor.hp+bonus);
    }
    if (id==='slam') {
      actor.slam={age:0,...this.slamMotion(actor)};
      actor.swimming=actor.inkSwimming=false;
      actor.vx=actor.vy=actor.vz=0;
      actor.driveX=actor.driveZ=actor.charge=0;
    }
    if (id==='ebot') b.summonClones(actor);
    this.advanced.launch(actor,id);
    actor.supers=(actor.supers??0)+1;
    if (actor.isPlayer) b.callbacks.sound?.('super');
    b.callbacks.cue?.('super',actor);
    return true;
  }

  canDeployShield(actor) {
    return !!actor?.isPlayer && actor.down<=0 && !actor.lift && !actor.ride && !actor.cloneOf &&
      !(actor.pShield>0 && (actor.pShieldUntil??0)>this.battle.clock) && (actor.pShieldReady??0)<=this.battle.clock;
  }

  deployShield(actor) {
    const b=this.battle;
    if (!this.canDeployShield(actor)) return false;
    actor.pShield=PLAYER_SHIELD_HP;
    actor.pShieldUntil=b.clock+PLAYER_SHIELD_DURATION;
    actor.pShieldReady=b.clock+PLAYER_SHIELD_COOLDOWN;
    b.burst([actor.x,actor.y+1.0,actor.z],actor.team,18,3.6);
    this.rings.push({x:actor.x,y:actor.y+.06,z:actor.z,r:2.6,team:actor.team,until:b.clock+.55});
    b.callbacks.sound?.('super');
    b.callbacks.cue?.('shield',actor);
    return true;
  }

  reduce(actor,amount) {
    if (actor.pShield>0 && (actor.pShieldUntil??0)>this.battle.clock) {
      const stopped=Math.min(actor.pShield,amount*.90);
      actor.pShield-=stopped;
      amount-=stopped;
      if (actor.pShield<=1e-3) {
        actor.pShield=0;
        actor.pShieldUntil=0;
      }
    }
    if (actor.guard>0) {
      const stopped=Math.min(actor.guard,amount*.84);
      actor.guard-=stopped;
      amount-=stopped;
    }
    if (actor.giant) amount*=.36;
    if (actor.slam) amount*=.50;
    return amount;
  }

  paint(actor,x,z,radius,depth,layer=this.battle.world.floor(x,z).layer) {
    const b=this.battle;
    actor.painted+=b.paint.stampGround(x,z,radius*1.17,actor.team,layer,b.rng()*TAU,depth);
  }

  paintSurface(actor,hit,radius,depth) {
    if (!hit) return;
    if (this.battle.paint.hasSurface(hit.position[0],hit.position[2],hit.layer)) {
      this.paint(actor,hit.position[0],hit.position[2],radius,depth,hit.layer);
    }
    else this.battle.splat(hit,{actor,weapon:{radius,depth,pellets:1},structureDamage:0});
  }

  enemies(actor,atX=actor.x) {
    const b=this.battle, z=zoneOf(atX), team=actor.team;
    const list=[];
    for (let i=0;i<b.actors.length;i++) {
      const other=b.actors[i];
      if (other.team!==team && other.down<=0 && !other.ride && !other.lift && zoneOf(other.x)===z) list.push(other);
    }
    if (team>=0) {
      for (let i=0;i<b.raiders.members.length;i++) {
        const raider=b.raiders.members[i];
        if (raider.active && !raider.ride && !raider.lift && zoneOf(raider.x)===z) list.push(raider);
      }
      if (b.boss.active && zoneOf(b.boss.x)===z) list.push(b.boss);
      if (b.hazards) {
        const hz=b.hazards.targetsView?b.hazards.targetsView(z):b.hazards.targets(atX);
        for (let i=0;i<hz.length;i++) list.push(hz[i]);
      }
    }
    return list;
  }

  enemiesView(team,atX) {
    const b=this.battle, z=zoneOf(atX), clk=b.clock;
    const slot=((team<0?2:team)<<2)|z;
    const cache=this._eCache ?? (this._eCache=Array.from({length:12},()=>[]));
    const stamps=this._eStamps ?? (this._eStamps=new Float64Array(12).fill(-1));
    if (stamps[slot]===clk) return cache[slot];
    stamps[slot]=clk;
    const list=cache[slot];
    list.length=0;
    for (let i=0;i<b.actors.length;i++) {
      const other=b.actors[i];
      if (other.team!==team && other.down<=0 && !other.ride && !other.lift && zoneOf(other.x)===z) list.push(other);
    }
    if (team>=0) {
      for (let i=0;i<b.raiders.members.length;i++) {
        const raider=b.raiders.members[i];
        if (raider.active && !raider.ride && !raider.lift && zoneOf(raider.x)===z) list.push(raider);
      }
      if (b.boss.active && zoneOf(b.boss.x)===z) list.push(b.boss);
      if (b.hazards) {
        const hz=b.hazards.targetsView?b.hazards.targetsView(z):b.hazards.targets(atX);
        for (let i=0;i<hz.length;i++) list.push(hz[i]);
      }
    }
    return list;
  }

  area(actor,x,y,z,radius,damage,hitCounts,ink=false) {
    const b=this.battle;
    b.damageMetro(x,y,z,radius,damage);
    b.stage.damageArea(b,actor,x,y,z,radius,damage);
    b.vehicles?.damageArea(x,y,z,radius,damage,actor);
    const origin=[x,y+.28,z], shift=stairNeighborShift(x,z,radius);
    const targets=this.enemies(actor,x);
    if (shift) targets.push(...this.enemies(actor,x+shift));
    for (const enemy of targets) {
      const otherLevel=!sameLevel(enemy.x,x), targetX=enemy.x-(otherLevel?shift:0);
      const distance=Math.hypot(targetX-x,enemy.z-z);
      if (Math.abs(enemy.y-y)>2.6 || distance>radius+(enemy.isBoss?1.2:0)) continue;
      if (hitCounts && (hitCounts.get(enemy)||0)>=2) continue;
      const point=[enemy.x,enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.74),enemy.z];
      const target=[targetX,point[1],point[2]];
      if (otherLevel && !stairRay(origin,target) || b.traceShot(origin,target,true)?.t<.95) continue;
      const amount=ink?damage*(1-.44*Math.min(1,distance/radius)):damage;
      const lost=ink?b.inkHit(enemy,amount,actor,point):b.damage(enemy,amount,actor,point);
      if (lost && hitCounts) {
        hitCounts.set(enemy,(hitCounts.get(enemy)||0)+1);
      }
    }
  }

  summon(actor) {
    const b=this.battle;
    if (actor.down>0 || actor.ride || actor.lift || actor.drone || actor.cloneOf || actor.droneReady>b.clock) return false;
    const drone={owner:actor,x:actor.x,z:actor.z,y:actor.y+1.55,yaw:actor.yaw,turn:0,spray:0,gun:.55,flash:-9,
      until:b.clock+DRONE_LIFETIME};
    actor.drone=drone;
    actor.droneReady=b.clock+DRONE_COOLDOWN;
    this.drones.push(drone);
    if (actor.isPlayer) b.callbacks.sound?.('drone');
    b.callbacks.cue?.('drone',actor);
    return true;
  }

  // Nearest opponent the drone has a clear line to.
  droneTarget(d) {
    const b=this.battle, from=[d.x,d.y-.2,d.z];
    let best=null, nearest=DRONE_WEAPON.range;
    for (const enemy of this.enemies(d.owner,d.x)) {
      if (enemy.shield>0) continue;
      const point=[enemy.x,enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.9),enemy.z];
      const range=Math.hypot(point[0]-from[0],point[1]-from[1],point[2]-from[2]);
      if (range>=nearest || range<.8 || b.traceShot(from,point,true) || b.subweapons.block(from,point,d.owner.team)) continue;
      nearest=range;
      best=point;
    }
    return best && {from,point:best};
  }

  droneFire(d) {
    const b=this.battle, aim=this.droneTarget(d);
    if (!aim) return false;
    const direction=unit(sub(aim.point,aim.from));
    b.shots.push({pos:aim.from.slice(),vel:scale(direction,DRONE_WEAPON.speed),actor:d.owner,weapon:DRONE_WEAPON,power:1,age:0,
      bend:null,homing:{...DRONE_HOMING},life:1.2,id:++b.shotSequence});
    d.flash=b.clock;
    d.aim=Math.atan2(direction[0],-direction[2]);
    b.perception?.fire({x:d.x,y:d.y-.9,z:d.z,team:d.owner.team,heardAt:-Infinity});
    b.callbacks.cue?.('drone-shot',{x:d.x,y:d.y,z:d.z,team:d.owner.team});
    return true;
  }

  updateActor(actor,dt) {
    const b=this.battle;
    if (actor.slam) {
      const slam=actor.slam;
      if (slam.rise===undefined) Object.assign(slam,this.slamMotion(actor,slam.y));
      slam.age+=dt;
      const t=clamp(slam.age/.83,0,1);
      const {startY,y,rise}=slam;
      if (t<1) {
        actor.y=startY+(y-startY)*t+Math.sin(Math.PI*t)*rise;
        actor.airborne=actor.y>y+.065;
        return true;
      }
      const hit=b.downwardSurface(actor.x,Math.max(actor.y,y),actor.z);
      const floor=hit?.position[1]??b.world.floor(actor.x,actor.z).y;
      actor.vy=Math.min(actor.vy,0)-17.9*dt;
      actor.y=Math.max(floor,Math.min(y,actor.y+actor.vy*dt));
      actor.airborne=actor.y>floor+.035;
      if (actor.airborne) return true;
      actor.vy=0;
      actor.y=floor;
      actor.slam=null;
      this.paintSurface(actor,hit,hit?.layer===undefined?3.4:5.35,.078);
      this.area(actor,actor.x,actor.y,actor.z,5.85,112);
      b.burst([actor.x,actor.y+.11,actor.z],actor.team,31,5.1,.016);
      this.rings.push({x:actor.x,y:actor.y+.031,z:actor.z,r:6.2,team:actor.team,until:b.clock+.55});
      return true;
    }
    if (actor.superUntil && actor.superUntil<=b.clock) this.clearSuper(actor);
    if (actor.pShieldUntil && actor.pShieldUntil<=b.clock) {
      actor.pShield=0;
      actor.pShieldUntil=0;
    }
    if (actor.giant && actor.giantNext<=b.clock) {
      actor.giantNext=b.clock+.60;
      const hit=b.downwardSurface(actor.x,actor.y,actor.z);
      if (!actor.airborne && hit && Math.abs(actor.y-hit.position[1])<.18) {
        this.paintSurface(actor,hit,1.64,.041);
      }
      this.area(actor,actor.x,actor.y,actor.z,1.95,84);
    }
    return false;
  }

  update(dt) {
    const b=this.battle;
    for (let i=this.drones.length-1;i>=0;i--) {
      const d=this.drones[i];
      if (b.clock>=d.until) {
        d.owner.drone=null;
        this.drones.splice(i,1);
        continue;
      }
      d.turn-=dt;
      d.spray-=dt;
      if (d.turn<=0) {
        let selected=d.yaw, score=-Infinity;
        for (const turn of [0,-.53,.53,-1.21,1.21,Math.PI]) {
          const yaw=d.yaw+turn, [x,,z]=forward(yaw);
          const px=d.x+x*3.7, pz=d.z+z*3.7;
          if (!b.world.stand(px,pz,.36)) continue;
          const owner=b.paint.get(px,pz,b.world.floor(px,pz).layer);
          const value=(owner===d.owner.team+1?0:1.3)-Math.abs(turn)*.31+b.rng()*.58;
          if (value>score) {
            selected=yaw;
            score=value;
          }
        }
        d.yaw=selected;
        d.turn=.62;
      }
      const [dx,,dz]=forward(d.yaw), oldX=d.x, oldZ=d.z;
      const nextX=d.x+dx*4.08*dt, nextZ=d.z+dz*4.08*dt;
      const floor=b.world.floor(nextX,nextZ).y;
      const ground=b.traceShot([nextX,Math.max(floor+.03,d.y-.22),nextZ],[nextX,floor-.12,nextZ],true,false);
      const height=(ground?.normal[1]>.54?ground.position[1]:floor)+1.54;
      const nextY=d.y+clamp(height-d.y,-dt*3.5,dt*3.5);
      if (!b.world.blocked(nextX,nextY-.18,nextZ,.35,.42) &&
          !b.traceShot([d.x,d.y,d.z],[nextX,nextY,nextZ],true,false,.14)) {
        d.x=nextX;
        d.z=nextZ;
        d.y=nextY;
      } else {
        d.yaw+=1.68;
        d.turn=0;
      }
      if (d.spray<=0) {
        d.spray=.47;
        const surface=b.world.floor(d.x,d.z);
        const hit=b.traceShot([d.x,d.y-.18,d.z],[d.x,surface.y-.12,d.z],true,false);
        if (hit?.layer!==undefined) {
          this.paint(d.owner,d.x,d.z,1.39,.032,hit.layer);
          b.burst([d.x,hit.position[1]+.06,d.z],d.owner.team,3,1.38);
        } else if (hit) {
          b.splat(hit,{actor:d.owner,weapon:{radius:.92,damage:0,pellets:1,depth:.032},structureDamage:0});
        }
      }
      if (Math.hypot(d.x-oldX,d.z-oldZ)<.001) d.turn=0;
      d.gun=(d.gun??DRONE_FIRE_INTERVAL)-dt;
      // The remainder carries over, so the cadence stays at exactly one a second.
      if (d.gun<=0) d.gun=this.droneFire(d)?Math.max(.5,d.gun+DRONE_FIRE_INTERVAL):.2;
    }
    this.rings=this.rings.filter(ring=>ring.until>b.clock);
    this.advanced.update(dt);
  }

  draw(r,viewX) {
    const now=this.battle.clock;
    this.advanced.draw(r,viewX);
    for (const d of this.drones) {
      if (!sameLevel(d.x,viewX)) continue;
      const team=TEAM[d.owner.team], bob=Math.sin(now*7+d.x)*.09;
      const y=d.y+bob;
      r.add('bevel',d.x,y,d.z,.67,.29,.52,0x535f5e,4,{dynamic:true,yaw:d.yaw});
      r.add('orb',d.x,y-.16,d.z,.29,.26,.27,team,9,{dynamic:true});
      const fired=now-(d.flash??-9);
      if (fired>=0 && fired<.16 && Number.isFinite(d.aim)) {
        const [ax,,az]=forward(d.aim), glow=.34*(1-fired/.16);
        r.add('orb',d.x+ax*.3,y-.2,d.z+az*.3,glow,glow,glow,0xfff4ce,3,{dynamic:true});
      }
      for (const side of [-1,1]) {
        const x=d.x+Math.cos(d.yaw)*side*.48, z=d.z+Math.sin(d.yaw)*side*.48;
        r.beam([d.x,y,d.z],[x,y,z],.075,.09,0x677779,4,{dynamic:true});
        r.add('cylinder',x,y+.10,z,.37,.065,.37,team,4,{dynamic:true});
      }
    }
    for (const ring of this.rings) {
      if (!sameLevel(ring.x,viewX)) continue;
      const t=clamp(1-(ring.until-now)/(ring.span??.55),0,1), radius=ring.r*(.42+t*.70);
      if (ring.half) {
        // A shock-cannon blast: an expanding sector in front of the muzzle.
        const tint=TEAM_INK[ring.team], reach=ring.r*(.25+.75*Math.min(1,t*1.6));
        r.add('hazard',ring.x,ring.y,ring.z,reach*2,1,reach*2,tint,24,{dynamic:true,yaw:-ring.yaw,label:Math.min(1,t*1.5),layer:ring.half/Math.PI,effect:1+t});
        for (let i=0;i<5;i++) {
          const [dx,,dz]=forward(ring.yaw+(i/4-.5)*2*ring.half), near=reach*.25, far=reach*(.72+.26*t);
          r.beam([ring.x+dx*near,ring.y+.05,ring.z+dz*near],[ring.x+dx*far,ring.y+.05,ring.z+dz*far],.13*(1-t),.04,i%2?tint:0xfff4ce,3,{dynamic:true});
        }
        continue;
      }
      r.add('ripple',ring.x,ring.y,ring.z,radius*2,.031,radius*2,TEAM_INK[ring.team],12,{dynamic:true,label:t});
    }
  }
}
