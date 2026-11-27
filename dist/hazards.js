import {TAU,add,clamp,forward,scale,sub,unit} from './render.js';
import {STORM_DRAINS} from './ink-fluid.js';
import {METRO,RAIL,UNDER_Y,ZONES,isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {GOAT_WEAPON,HELI_MISSILE_WEAPON,ROGUE_DRONE_WEAPON,SNIPER_WEAPON,TRAIN_BOSS_WEAPON} from './weapons.js';
import {drawTentacle} from './creature-models.js';
import {randomGenerator} from './world.js';

export const SNIPER_FIRST=42, SNIPER_INTERVAL=75, SNIPER_STAY=32, SNIPER_COUNT=4;
export const ROGUE_DRONE_FIRST=58, ROGUE_DRONE_INTERVAL=82, ROGUE_DRONE_STAY=26, ROGUE_DRONE_COUNT=16;
export const RAIN_FIRST=70, RAIN_INTERVAL=95, RAIN_DURATION=22;
export const HELI_FIRST=92, HELI_INTERVAL=120, HELI_STAY=42, HELI_SALVO_COUNT=6;
export const TSUNAMI_FIRST=112, TSUNAMI_INTERVAL=115, TSUNAMI_WARN=5, TSUNAMI_SPEED=12.5, TSUNAMI_HEIGHT=3.6, TSUNAMI_WIDTH=9.5;
export const UNDER_FLOOD_MAX=2.65, UNDER_FLOOD_HOLD=16;
export const TRAIN_BOSS_FIRST=145, TRAIN_BOSS_INTERVAL=130, TRAIN_BOSS_DURATION=42;
export const GOAT_FIRST=95, GOAT_INTERVAL=165, GOAT_DURATION=Infinity, GOAT_ARMS=16, GOAT_HOVER_Y=5.2, GOAT_REACH=50;
export const GOAT_ATTACK_KINDS=['smash','whirl','barrage','beam','meteor','gravity','lightning','nova'];

function discoverApartmentPerches(world) {
  const north=[], south=[];
  for (const s of world?.solids ?? []) {
    const cx=(s.min[0]+s.max[0])*.5, cz=(s.min[2]+s.max[2])*.5;
    const w=s.max[0]-s.min[0], h=s.max[1]-s.min[1];
    if (Math.abs(cx)>46 || Math.abs(cz)<29 || Math.abs(cz)>44 || h<7 || s.min[1]>3.5 || w<3.5) continue;
    const sign=cz<0?1:-1;
    const front=sign>0?s.max[2]:s.min[2];
    const y=clamp(Math.min(s.max[1]-.4,7.6+(Math.abs(Math.round(cx))%3)*2.2),6.6,12.5);
    const perch={x:cx,y,z:front+sign*.78,yaw:sign>0?Math.PI:0,sign,roofY:s.max[1],roofZ:cz};
    (sign>0?north:south).push(perch);
  }
  const pickSpread=(list,want)=>{
    list.sort((a,b)=>a.x-b.x);
    if (list.length<=want) return list;
    const out=[];
    for (let i=0;i<want;i++) out.push(list[Math.floor((i+.5)*list.length/want)]);
    return out;
  };
  const combined=[...pickSpread(north,5),...pickSpread(south,5)];
  if (combined.length>=4) return combined;
  return [
    {x:-30,y:8.2,z:-30.8,yaw:Math.PI,sign:1,roofY:11.6,roofZ:-34},
    {x:-6,y:9.4,z:-30.8,yaw:Math.PI,sign:1,roofY:12.4,roofZ:-34},
    {x:22,y:8.2,z:-30.8,yaw:Math.PI,sign:1,roofY:11.6,roofZ:-34},
    {x:-20,y:8.4,z:30.8,yaw:0,sign:-1,roofY:11.6,roofZ:34},
    {x:8,y:9.2,z:30.8,yaw:0,sign:-1,roofY:12.4,roofZ:34},
    {x:30,y:8.4,z:30.8,yaw:0,sign:-1,roofY:11.6,roofZ:34}
  ];
}

function discoverApartmentDronePorts(world,perches) {
  const ports=[];
  for (const h of world?.homes ?? []) {
    const cx=(h.x0+h.x1)*.5, cz=(h.z0+h.z1)*.5, sign=-Math.sign(cz)||1;
    ports.push({x:cx,y:3.2,z:(sign>0?h.z1:h.z0)+sign*1.2,yaw:sign>0?0:Math.PI});
  }
  for (const p of perches) {
    ports.push({x:p.x,y:Math.min(7.8,p.y),z:p.z+p.sign*1.1,yaw:p.yaw});
  }
  if (!ports.length) return [{x:-24,y:4.5,z:-29,yaw:Math.PI},{x:24,y:4.5,z:29,yaw:0}];
  return ports;
}

export class Hazards {
  constructor(battle) {
    this.battle=battle;
    this.rng=randomGenerator((battle.seed ?? 519231)^0x5a3c9e1);
    this.perches=discoverApartmentPerches(battle.world);
    this.dronePorts=discoverApartmentDronePorts(battle.world,this.perches);
    this.snipers=[];
    this.rogueDrones=[];
    this.droneSpawnsLeft=0;
    this.droneSpawnTimer=0;
    this.sniperWave=0;
    this.droneWave=0;
    this.heliWave=0;
    this.trainBossCount=0;
    this.nextSniper=SNIPER_FIRST;
    this.sniperRetreatAt=0;
    this.nextDrone=ROGUE_DRONE_FIRST;
    this.droneRetreatAt=0;
    this.nextHeli=HELI_FIRST;
    this.heli={
      active:false,name:'暴走攻撃ヘリ',hp:0,maxHp:battle.teamSize===8?2400:1600,
      x:0,y:13,z:-32,yaw:0,vx:0,vz:0,pitch:0,roll:0,rotor:0,until:0,fire:0,
      radius:2.2,height:2.4,team:-1,isHeli:true,weapon:HELI_MISSILE_WEAPON
    };
    this.missiles=[];
    this.nextRain=RAIN_FIRST;
    this.rain={active:false,until:0,washTimer:0};
    this.nextTsunami=TSUNAMI_FIRST;
    this.tsunami={phase:'idle',warnUntil:0,x:-64,height:TSUNAMI_HEIGHT,width:TSUNAMI_WIDTH,floodedUnder:false};
    this.underFlood={active:false,phase:'idle',depth:0,maxDepth:UNDER_FLOOD_MAX,timer:0,washTimer:0};
    this.nextTrainBoss=TRAIN_BOSS_FIRST;
    this.trainBoss={active:false,rail:'transit',name:'暴走列車 07',hp:0,maxHp:battle.teamSize===8?3800:2600,
      until:0,fire:0,shock:0,stageMode:true,pathT:0,yaw:Math.PI*.5,pitch:0,roll:0,speed:24,x:-42,y:0,z:0};
    this.trainHits=new Map();
    this.nextGoat=GOAT_FIRST;
    this.goat={
      active:false,name:'破壊神ゴート',hp:0,maxHp:battle.teamSize===8?30000:20000,phase:1,
      x:0,y:GOAT_HOVER_Y,z:0,yaw:Math.PI,vx:0,vz:0,until:Infinity,nextAttack:0,volley:0,cast:null,
      radius:1.75,height:4.1,team:-1,isGoat:true,isBoss:true,supreme:true,arms:GOAT_ARMS,weapon:GOAT_WEAPON
    };
    this._goatNovaHits=new Set();
    this.alert='';
    this.alertUntil=0;
  }

  announce(text,duration=4.6,sound=null) {
    const b=this.battle;
    this.alert=text;
    this.alertUntil=b.clock+duration;
    if (sound) b.callbacks.sound?.(sound);
  }

  liveSnipers() {
    return this.snipers.filter(s=>s.active);
  }

  liveRogueDrones() {
    return this.rogueDrones.filter(d=>d.active);
  }

  targets(atX) {
    const z=zoneOf(atX);
    const list=[];
    for (let i=0;i<this.snipers.length;i++) {const s=this.snipers[i]; if (s.active && zoneOf(s.x)===z) list.push(s);}
    for (let i=0;i<this.rogueDrones.length;i++) {const d=this.rogueDrones[i]; if (d.active && zoneOf(d.x)===z) list.push(d);}
    if (this.heli.active && zoneOf(this.heli.x)===z) list.push(this.heli);
    if (this.goat.active && zoneOf(this.goat.x)===z) list.push(this.goat);
    return list;
  }

  targetsView(zone) {
    const clk=this.battle.clock;
    const cache=this._tCache ?? (this._tCache=[[],[],[],[]]);
    const stamps=this._tStamps ?? (this._tStamps=[-1,-1,-1,-1]);
    if (stamps[zone]===clk) return cache[zone];
    stamps[zone]=clk;
    const list=cache[zone];
    list.length=0;
    for (let i=0;i<this.snipers.length;i++) {const s=this.snipers[i]; if (s.active && zoneOf(s.x)===zone) list.push(s);}
    for (let i=0;i<this.rogueDrones.length;i++) {const d=this.rogueDrones[i]; if (d.active && zoneOf(d.x)===zone) list.push(d);}
    if (this.heli.active && zoneOf(this.heli.x)===zone) list.push(this.heli);
    if (this.goat.active && zoneOf(this.goat.x)===zone) list.push(this.goat);
    return list;
  }

  // ---- Apartment Building Snipers (敵味方関係なく狙撃) ----
  spawnSnipers(count=SNIPER_COUNT) {
    const b=this.battle;
    this.snipers=[];
    this.sniperWave++;
    const pool=this.perches.slice();
    const chosen=[];
    for (let i=0;i<count && pool.length;i++) {
      const idx=Math.floor(this.rng()*pool.length);
      chosen.push(pool.splice(idx,1)[0]);
    }
    for (let i=0;i<chosen.length;i++) {
      const p=chosen[i];
      const sniper={
        id:this.sniperWave*10+i,index:i,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:-.24,sign:p.sign,
        team:-1,isSniper:true,active:true,hp:90,maxHp:90,radius:.52,height:1.75,weapon:SNIPER_WEAPON,
        name:'マンションスナイパー '+String(i+1).padStart(2,'0'),
        aim:0,fire:1.1+i*.4,targetPos:null,recoil:0,flash:-9
      };
      b.hnv1?.mind(sniper);
      this.snipers.push(sniper);
    }
    this.sniperRetreatAt=b.elapsed+SNIPER_STAY;
    this.nextSniper=b.elapsed+SNIPER_INTERVAL;
    this.announce('⚠ マンションからスナイパー ×'+this.snipers.length+' が出現！敵味方無差別狙撃！',4.8,'boss');
    b.events.unshift({label:'マンションスナイパー ×'+this.snipers.length+' 出現',team:-1,until:b.clock+4.2});
    b.events.length=Math.min(b.events.length,4);
    return this.snipers;
  }

  hurtSniper(sniper,amount,source) {
    if (!sniper.active) return 0;
    const lost=Math.min(sniper.hp,amount);
    sniper.hp-=lost;
    if (sniper.hp<=0) {
      sniper.active=false;
      const b=this.battle;
      if (source) source.kills++;
      b.burst([sniper.x,sniper.y+1.0,sniper.z],source?.team ?? -1,18,3.8);
      b.events.unshift({label:(source?.name ?? '撃破')+'  ▸  '+sniper.name,team:source?.team ?? -1,until:b.clock+3.6});
      b.events.length=Math.min(b.events.length,4);
      if (!this.snipers.some(s=>s.active)) this.announce('マンションのスナイパーを全員排除！',3.6,'bossDown');
    }
    return lost;
  }

  updateSnipers(dt) {
    const b=this.battle;
    if (b.elapsed>=this.nextSniper-1e-6) this.spawnSnipers();
    if (this.snipers.length && b.elapsed>=this.sniperRetreatAt) {
      for (const s of this.snipers) s.active=false;
      this.snipers=[];
    }
    for (const s of this.snipers) {
      if (!s.active) continue;
      s.fire-=dt;
      s.recoil=Math.max(0,s.recoil-dt*6);
      const eye=[s.x,s.y+1.35,s.z];
      let best=null, bestDist=SNIPER_WEAPON.range;
      if (b.hnv1) {
        const pick=b.hnv1.pickSniperTarget(s,SNIPER_WEAPON.range,dt);
        if (pick) {best=pick;bestDist=pick.dist;}
      } else {
        for (const actor of b.actors) {
          if (actor.down>0 || actor.shield>0 || actor.ride || actor.lift || zoneOf(actor.x)!==0) continue;
          const tp=[actor.x,actor.y+(actor.swimming?.36:1.05),actor.z];
          const dist=Math.hypot(tp[0]-eye[0],tp[1]-eye[1],tp[2]-eye[2]);
          if (dist>=bestDist || dist<2) continue;
          if (b.traceShot(eye,tp,true) || b.subweapons.block(eye,tp,-1)) continue;
          bestDist=dist;
          best={actor,pos:tp};
        }
      }
      if (!best) {
        s.aim=Math.max(0,s.aim-dt*2);
        s.targetPos=null;
        continue;
      }
      const d=sub(best.pos,eye), horiz=Math.max(.1,Math.hypot(d[0],d[2]));
      s.yaw=Math.atan2(d[0],-d[2]);
      s.pitch=clamp(Math.atan2(d[1],horiz),-1.05,.5);
      s.targetPos=best.pos;
      s.aim+=dt;
      if (s.aim>=.95 && s.fire<=0) {
        const dir=unit(d);
        const start=add(eye,scale(dir,.65));
        const vel=scale(dir,SNIPER_WEAPON.speed);
        // Compensate gently for light bullet drop so sniper shots feel crisp.
        vel[1]+=.5*SNIPER_WEAPON.gravity*(bestDist/SNIPER_WEAPON.speed);
        b.shots.push({pos:start,vel,actor:s,weapon:SNIPER_WEAPON,power:1,age:0,bend:null,life:1.3,id:++b.shotSequence});
        s.fire=SNIPER_WEAPON.delay;
        s.aim=0;
        s.recoil=1;
        s.flash=b.clock;
      }
    }
  }

  // ---- Apartment Swarm Drones (マンションから無数のドローンが湧き出し襲撃) ----
  _launchApartmentDrone(index,delay=0) {
    const b=this.battle, ports=this.dronePorts;
    const port=ports[(this.droneWave*5+index)%ports.length];
    const spread=(this.rng()-.5)*4.2;
    const drone={
      id:this.droneWave*100+index,index,
      x:port.x+spread,y:port.y+(this.rng()-.5)*.9,z:port.z+(this.rng()-.5)*2.0,
      yaw:port.yaw+(this.rng()-.5)*.7,team:-1,isRogueDrone:true,active:true,hp:75,maxHp:75,
      radius:.58,height:.7,weapon:ROGUE_DRONE_WEAPON,
      name:'マンション暴走ドローン '+String(index+1).padStart(2,'0'),
      fire:.55+(index%6)*.22+delay,turn:0,flash:-9,aim:0
    };
    b.hnv1?.mind(drone);
    b.burst([drone.x,drone.y,drone.z],-1,10,2.8);
    return drone;
  }

  spawnRogueDrones(count=ROGUE_DRONE_COUNT) {
    const b=this.battle;
    this.rogueDrones=[];
    this.droneWave++;
    const initial=count>8?Math.min(count,14):count;
    for (let i=0;i<initial;i++) {
      this.rogueDrones.push(this._launchApartmentDrone(i));
    }
    // Countless reinforcements continue pouring from apartment exits during full invasion waves!
    this.droneSpawnsLeft=count>=ROGUE_DRONE_COUNT?16:0;
    this.droneSpawnTimer=1.35;
    this.droneRetreatAt=b.elapsed+ROGUE_DRONE_STAY;
    this.nextDrone=b.elapsed+ROGUE_DRONE_INTERVAL;
    this.announce('⚠ マンションから無数の暴走ドローン ×'+count+' が湧き出した！',5.0,'drone');
    b.events.unshift({label:'マンションドローン群 湧出中！',team:-1,until:b.clock+4.4});
    b.events.length=Math.min(b.events.length,4);
    return this.rogueDrones;
  }

  hurtDrone(drone,amount,source) {
    if (!drone.active) return 0;
    const lost=Math.min(drone.hp,amount);
    drone.hp-=lost;
    if (drone.hp<=0) {
      drone.active=false;
      const b=this.battle;
      if (source) source.kills++;
      b.burst([drone.x,drone.y,drone.z],source?.team ?? -1,18,3.8);
      b.events.unshift({label:(source?.name ?? '撃破')+'  ▸  '+drone.name,team:source?.team ?? -1,until:b.clock+3.6});
      b.events.length=Math.min(b.events.length,4);
      if (!this.rogueDrones.some(d=>d.active) && this.droneSpawnsLeft<=0) this.announce('マンションの暴走ドローン群を全機撃墜！',3.6,'bossDown');
    }
    return lost;
  }

  updateRogueDrones(dt) {
    const b=this.battle;
    if (b.elapsed>=this.nextDrone-1e-6) this.spawnRogueDrones();
    if (this.rogueDrones.length && b.elapsed>=this.droneRetreatAt) {
      for (const d of this.rogueDrones) d.active=false;
      this.rogueDrones=[];
      this.droneSpawnsLeft=0;
    }
    if (this.droneSpawnsLeft>0 && b.elapsed<this.droneRetreatAt-1.8) {
      this.droneSpawnTimer-=dt;
      let activeCount=0;
      for (let i=0;i<this.rogueDrones.length;i++) if (this.rogueDrones[i].active) activeCount++;
      if (this.droneSpawnTimer<=0 && activeCount<18) {
        this.droneSpawnTimer=.95;
        const burstCount=Math.min(3,this.droneSpawnsLeft);
        for (let k=0;k<burstCount;k++) {
          this.rogueDrones.push(this._launchApartmentDrone(this.rogueDrones.length));
          this.droneSpawnsLeft--;
        }
      }
    }
    for (const d of this.rogueDrones) {
      if (!d.active) continue;
      d.turn-=dt;
      d.fire-=dt;
      const from=[d.x,d.y-.18,d.z];
      let fireTarget=null, bob=0;
      if (b.hnv1) {
        const plan=b.hnv1.planRogueDrone(d,this.rogueDrones,ROGUE_DRONE_WEAPON,dt);
        fireTarget=plan.fireTarget;
        bob=plan.bob;
        if (plan.chase) d.yaw=plan.desiredYaw;
        else if (d.turn<=0) {d.yaw+=(this.rng()-.5)*1.8;d.turn=.85;}
      } else {
        let nearest=null, nearDist=Infinity, fireDist=ROGUE_DRONE_WEAPON.range;
        for (const actor of b.actors) {
          if (actor.down>0 || actor.ride || actor.lift || !sameLevel(actor.x,d.x)) continue;
          const tp=[actor.x,actor.y+(actor.swimming?.36:.92),actor.z];
          const dist=Math.hypot(tp[0]-from[0],tp[1]-from[1],tp[2]-from[2]);
          if (dist<nearDist) {nearDist=dist;nearest=actor;}
          if (actor.shield<=0 && dist<fireDist && dist>.9 && !b.traceShot(from,tp,true) && !b.subweapons.block(from,tp,-1)) {
            fireDist=dist;
            fireTarget=tp;
          }
        }
        if (nearest && nearDist>6.5) {
          d.yaw=Math.atan2(nearest.x-d.x,d.z-nearest.z);
        } else if (d.turn<=0) {
          d.yaw+=(this.rng()-.5)*1.8;
          d.turn=.85;
        }
      }
      const [dx,,dz]=forward(d.yaw);
      const nx=d.x+dx*5.7*dt, nz=d.z+dz*5.7*dt;
      const floor=b.world.floor(nx,nz).y;
      const ny=d.y+clamp(floor+2.5+bob-d.y,-dt*3.8,dt*3.8);
      const lx=localX(nx);
      const zone=zoneOf(d.x), [bx,bz]=ZONES[zone].bounds;
      if (Math.abs(lx)<bx-3 && Math.abs(nz)<bz-3 && !b.world.blocked(nx,ny-.2,nz,.42,.5)) {
        d.x=nx; d.y=ny; d.z=nz;
      } else {
        d.yaw+=1.9;
        d.turn=.3;
      }
      if (fireTarget && d.fire<=0) {
        const dir=unit(sub(fireTarget,from));
        b.shots.push({pos:from.slice(),vel:scale(dir,ROGUE_DRONE_WEAPON.speed),actor:d,weapon:ROGUE_DRONE_WEAPON,power:1,age:0,
          bend:null,homing:{...ROGUE_DRONE_WEAPON.homing},life:1.25,id:++b.shotSequence});
        d.fire=ROGUE_DRONE_WEAPON.delay;
        d.flash=b.clock;
        d.aim=Math.atan2(dir[0],-dir[2]);
      }
    }
  }

  // ---- Apartment Rooftop Attack Helicopter (屋上から無差別マルチミサイル乱射ヘリ) ----
  spawnHeli(duration=HELI_STAY) {
    const b=this.battle;
    this.heliWave++;
    const perches=this.perches;
    const roof=perches[(this.heliWave*3)%perches.length] ?? {x:-6,roofY:12,roofZ:-34,z:-31};
    const maxHp=b.teamSize===8?2400:1600;
    const rx=roof.x, ry=(roof.roofY??11.8)+1.4, rz=roof.roofZ??roof.z;
    Object.assign(this.heli,{
      active:true,hp:maxHp,maxHp,
      x:rx,y:ry,z:rz,yaw:rz<0?Math.PI:0,vx:0,vz:0,pitch:0,roll:0,rotor:0,
      until:b.elapsed+duration,fire:1.35,salvo:0,flash:-9
    });
    this.missiles=[];
    this.nextHeli=b.elapsed+HELI_INTERVAL;
    b.burst([rx,ry+.8,rz],-1,32,6.5);
    this.announce('🚁 マンション屋上から暴走攻撃ヘリ発進！無差別マルチミサイル警報！',5.4,'boss');
    b.events.unshift({label:'🚁 暴走ヘリ 屋上発進・ミサイル乱射',team:-1,until:b.clock+4.6});
    b.events.length=Math.min(b.events.length,4);
    return this.heli;
  }

  hurtHeli(amount,source=null) {
    const h=this.heli;
    if (!h.active || !(amount>0)) return 0;
    const lost=Math.min(h.hp,amount);
    h.hp-=lost;
    const b=this.battle;
    if (h.hp<=0) {
      h.active=false;
      this.missiles=[];
      if (source) source.kills++;
      b.burst([h.x,h.y+1.1,h.z],source?.team ?? -1,48,8.5);
      b.events.unshift({label:(source?.name ?? '撃墜')+'  ▸  '+h.name,team:source?.team ?? -1,until:b.clock+4.2});
      b.events.length=Math.min(b.events.length,4);
      this.announce('✦ 暴走攻撃ヘリを撃墜した！',4.2,'bossDown');
    }
    return lost;
  }

  updateHeli(dt) {
    const b=this.battle, h=this.heli;
    if (!h.active && b.elapsed>=this.nextHeli-1e-6) this.spawnHeli();
    if (h.active && b.elapsed>=h.until) {
      h.active=false;
      this.missiles=[];
      this.announce('暴走攻撃ヘリは空域を離脱した',3.8);
    }
    if (h.active) {
      h.rotor=(h.rotor+dt*28)%TAU;
      h.salvo+=dt;
      const t=b.elapsed*.55;
      const targetX=Math.sin(t)*32, targetZ=Math.cos(t*.85)*18;
      const targetY=Math.max(12.2,b.world.floor(targetX,targetZ).y+11.5+Math.sin(t*1.7)*1.4);
      const dx=targetX-h.x, dz=targetZ-h.z, d=Math.max(.1,Math.hypot(dx,dz));
      h.vx=dx/d*Math.min(13.5,d*1.8);
      h.vz=dz/d*Math.min(13.5,d*1.8);
      h.x+=h.vx*dt; h.z+=h.vz*dt;
      h.y+=clamp(targetY-h.y,-dt*6.5,dt*6.5);
      const desiredYaw=Math.atan2(h.vx,-h.vz);
      let dYaw=desiredYaw-h.yaw;
      while (dYaw>Math.PI) dYaw-=TAU; while (dYaw<-Math.PI) dYaw+=TAU;
      h.yaw+=dYaw*clamp(dt*4.5,0,1);
      h.pitch=.14;
      h.roll=clamp(dYaw*-.35,-.32,.32);
      h.fire-=dt;
      if (h.fire<=0) {
        h.fire=HELI_MISSILE_WEAPON.delay;
        h.flash=b.clock;
        const pool=[...b.actors,...b.raiders.live()].filter(a=>a.down<=0 && zoneOf(a.x)===0 && !a.ride && !a.lift);
        for (let m=0;m<HELI_SALVO_COUNT;m++) {
          const podSide=m%2===0?-1:1;
          const rx=Math.cos(h.yaw)*podSide*1.35, rz=Math.sin(h.yaw)*podSide*1.35;
          const fx=Math.sin(h.yaw)*.6, fz=-Math.cos(h.yaw)*.6;
          const sx=h.x+rx+fx, sy=h.y-.35, sz=h.z+rz+fz;
          let tx, tz;
          if (pool.length && m<pool.length) {
            const pick=pool[(Math.floor(this.rng()*pool.length))%pool.length];
            tx=clamp(pick.x+(pick.vx??0)*.45+(this.rng()-.5)*2.4,-46,46);
            tz=clamp(pick.z+(pick.vz??0)*.45+(this.rng()-.5)*2.4,-28,28);
          } else {
            tx=(this.rng()-.5)*68;
            tz=(this.rng()-.5)*40;
          }
          const ty=b.world.floor(tx,tz).y;
          const dir=unit([tx-sx,ty+3.5-sy,tz-sz]);
          this.missiles.push({
            id:++b.shotSequence,
            x:sx,y:sy,z:sz,
            vx:dir[0]*21+rx*3.5,vy:4.8+(m%3)*1.6,vz:dir[2]*21+rz*3.5,
            tx,ty,tz,life:3.2,age:0
          });
          b.abilities.rings.push({x:tx,y:ty+.06,z:tz,r:3.2,team:1,until:b.clock+1.05});
        }
        b.burst([h.x,h.y-.3,h.z],-1,16,4.2);
      }
    }
    this.updateMissiles(dt);
  }

  updateMissiles(dt) {
    if (!this.missiles.length) return;
    const b=this.battle, next=[];
    const shooter={team:-1,name:this.heli.name,isHeli:true};
    for (let i=0;i<this.missiles.length;i++) {
      const ms=this.missiles[i];
      ms.age+=dt;
      ms.life-=dt;
      const toX=ms.tx-ms.x, toY=(ms.ty+.2)-ms.y, toZ=ms.tz-ms.z;
      const dist=Math.hypot(toX,toY,toZ);
      const steer=ms.age<.28?3.2:14.0;
      const desired=unit([toX,toY+(dist>9?5.5:0),toZ]);
      const spd=29;
      ms.vx=ms.vx+(desired[0]*spd-ms.vx)*clamp(dt*steer,0,1);
      ms.vy=ms.vy+(desired[1]*spd-ms.vy)*clamp(dt*steer,0,1);
      ms.vz=ms.vz+(desired[2]*spd-ms.vz)*clamp(dt*steer,0,1);
      const nx=ms.x+ms.vx*dt, ny=ms.y+ms.vy*dt, nz=ms.z+ms.vz*dt;
      const flY=b.world.floor(nx,nz).y;
      const hitWall=ms.age>.18 && (b.traceShot?.([ms.x,ms.y,ms.z],[nx,ny,nz],true)?.t<1);
      const impacted=hitWall || ny<=flY+.32 || dist<1.45 || ms.life<=0;
      ms.x=nx; ms.y=ny; ms.z=nz;
      if (impacted) {
        const iy=Math.max(flY,ms.y);
        b.burst([ms.x,iy+.6,ms.z],1,22,5.6);
        b.abilities.rings.push({x:ms.x,y:flY+.07,z:ms.z,r:3.6,team:1,until:b.clock+.55});
        b.stage.damageArea(b,shooter,ms.x,iy,ms.z,3.6,72);
        b.vehicles?.damageArea(ms.x,iy,ms.z,3.6,64,shooter);
        for (const a of [...b.actors,...b.raiders.live()]) {
          if (a.down>0 || a.ride || a.lift || !sameLevel(a.x,ms.x)) continue;
          const ad=Math.hypot(a.x-ms.x,a.z-ms.z);
          if (ad>3.75 || Math.abs(a.y-iy)>3.4) continue;
          const falloff=clamp(1-.55*(ad/3.75),.42,1);
          const inv=1/Math.max(.3,ad);
          b.stepActor(a,(a.x-ms.x)*inv*1.8,(a.z-ms.z)*inv*1.8);
          b.damage(a,58*falloff,shooter,[a.x,a.y+.9,a.z],'heli');
        }
      } else {
        next.push(ms);
      }
    }
    this.missiles=next;
  }

  // ---- Rain (豪雨による視界不良＆インク消失) ----
  startRain(duration=RAIN_DURATION) {
    const b=this.battle;
    this.rain={active:true,until:b.elapsed+duration,washTimer:0};
    this.nextRain=b.elapsed+RAIN_INTERVAL;
    this.announce('☂ 豪雨発生！視界不良＆地上のインクが洗い流される！',4.8);
  }

  updateRain(dt) {
    const b=this.battle;
    if (!this.rain.active && b.elapsed>=this.nextRain-1e-6) this.startRain();
    if (!this.rain.active) return;
    if (b.elapsed>=this.rain.until) {
      this.rain.active=false;
      return;
    }
    this.rain.washTimer+=dt;
    if (b.fluid) b.fluid.stepRain(this,b.paint,dt);
    if (this.rain.washTimer>=.25) {
      this.rain.washTimer-=.25;
      if (!b.fluid) b.paint.wash(ZONES[0].inkMask,.0095);
      // Gradually dissolve exposed surface wall decals in the rain.
      const decals=b.decals;
      if (decals.length) {
        let removed=0, w=0;
        for (let i=0;i<decals.length;i++) {
          const d=decals[i];
          if (zoneOf(d.p[0])===0 && removed<4 && this.rng()<.18) {removed++; continue;}
          if (w!==i) decals[w]=d;
          w++;
        }
        decals.length=w;
      }
    }
  }

  // ---- Tsunami & Underground Flood (津波・インク消失・溺死・地下浸水) ----
  startTsunami(warnSeconds=TSUNAMI_WARN) {
    const b=this.battle;
    this.tsunami={phase:warnSeconds>0?'warn':'wave',warnUntil:b.elapsed+warnSeconds,x:-64,height:TSUNAMI_HEIGHT,width:TSUNAMI_WIDTH,floodedUnder:false};
    this.nextTsunami=b.elapsed+TSUNAMI_INTERVAL;
    this.announce(warnSeconds>0?'⚠ 津波警報！高台または高架上へ避難せよ！':'🌊 津波襲来！低地は溺死危険・インク消失！',5.0,'boss');
    b.events.unshift({label:'⚠ 津波警報発令',team:-1,until:b.clock+4.5});
    b.events.length=Math.min(b.events.length,4);
  }

  startUnderFlood() {
    const b=this.battle;
    this.underFlood={active:true,phase:'rise',depth:Math.max(this.underFlood.depth,.1),maxDepth:UNDER_FLOOD_MAX,timer:0,washTimer:0};
    this.announce('🌊 地下B1が浸水中！階段から地上へ避難！',5.0,'boss');
    b.events.unshift({label:'🌊 地下B1 浸水発生',team:-1,until:b.clock+4.5});
    b.events.length=Math.min(b.events.length,4);
  }

  updateTsunamiAndFlood(dt) {
    const b=this.battle, ts=this.tsunami;
    if (ts.phase==='idle' && b.elapsed>=this.nextTsunami-1e-6) this.startTsunami();
    if (ts.phase==='warn' && b.elapsed>=ts.warnUntil) {
      ts.phase='wave';
      this.announce('🌊 津波襲来！インク消失・低地は溺死危険！',4.8,'boss');
    }
    if (ts.phase==='wave') {
      const prevX=ts.x;
      ts.x+=TSUNAMI_SPEED*dt;
      ts.dir=1;
      ts.speed=TSUNAMI_SPEED;
      const back=Math.min(prevX,ts.x)-ts.width*.55, front=ts.x+ts.width*.5;
      // Unified fluid engine drives shallow-water bore wave, Morison push, structure impact & scour.
      if (b.fluid) {
        b.fluid.stepTsunamiFluid(this,b,dt);
      } else {
        b.paint.wash(ZONES[0].inkMask,1.0,back,front);
      }
      const decals=b.decals;
      if (decals.length) {
        let w=0;
        const hLim=ts.height+.4;
        for (let i=0;i<decals.length;i++) {
          const d=decals[i], dp=d.p;
          if (zoneOf(dp[0])===0 && dp[1]<hLim && dp[0]>=back && dp[0]<=front) continue;
          if (w!==i) decals[w]=d;
          w++;
        }
        decals.length=w;
      }
      // Sweep and drown any surface fighter caught below the wave crest.
      const xMin=ts.x-ts.width*.5, xMax=ts.x+ts.width*.5, yLim=ts.height-.55;
      const actors=b.actors;
      for (let i=0;i<actors.length;i++) {
        const a=actors[i];
        if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==0) continue;
        if (a.x>=xMin && a.x<=xMax && a.y<yLim) {
          b.stepActor(a,5.2*dt,0);
          b.damage(a,145*dt,null,[a.x,a.y+.9,a.z],'drown');
        }
      }
      const raiders=b.raiders.members;
      for (let i=0;i<raiders.length;i++) {
        const a=raiders[i];
        if (!a.active || a.down>0 || a.ride || a.lift || zoneOf(a.x)!==0) continue;
        if (a.x>=xMin && a.x<=xMax && a.y<yLim) {
          b.stepActor(a,5.2*dt,0);
          b.damage(a,145*dt,null,[a.x,a.y+.9,a.z],'drown');
        }
      }
      if (!ts.floodedUnder && ts.x>=-25) {
        ts.floodedUnder=true;
        this.startUnderFlood();
      }
      if (ts.x>68) {
        ts.phase='idle';
      }
    } else if (b.fluid && this.underFlood.active) {
      b.fluid.stepTsunamiFluid(this,b,dt);
    }
    const uf=this.underFlood;
    if (!uf.active) return;
    if (uf.phase==='rise') {
      uf.depth=Math.min(uf.maxDepth,uf.depth+.55*dt);
      if (uf.depth>=uf.maxDepth) {uf.phase='hold';uf.timer=UNDER_FLOOD_HOLD;}
    } else if (uf.phase==='hold') {
      uf.timer-=dt;
      if (uf.timer<=0) uf.phase='drain';
    } else if (uf.phase==='drain') {
      uf.depth=Math.max(0,uf.depth-.45*dt);
      if (uf.depth<=0) {uf.active=false;uf.phase='idle';return;}
    }
    const waterY=UNDER_Y+uf.depth;
    uf.washTimer+=dt;
    if (uf.depth>.2 && uf.washTimer>=.3) {
      uf.washTimer-=.3;
      b.paint.wash(ZONES[1].inkMask,.14);
      const decals=b.decals;
      if (decals.length) {
        let w=0;
        const wLim=waterY+.2;
        for (let i=0;i<decals.length;i++) {
          const d=decals[i], dp=d.p;
          if (zoneOf(dp[0])===1 && dp[1]<wLim) continue;
          if (w!==i) decals[w]=d;
          w++;
        }
        decals.length=w;
      }
    }
    if (uf.depth>.45) {
      const actors=b.actors;
      for (let i=0;i<actors.length;i++) {
        const a=actors[i];
        if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==1) continue;
        if (a.y+1.15<waterY) b.damage(a,70*dt,null,[a.x,a.y+.9,a.z],'drown');
      }
      const raiders=b.raiders.members;
      for (let i=0;i<raiders.length;i++) {
        const a=raiders[i];
        if (!a.active || a.down>0 || a.ride || a.lift || zoneOf(a.x)!==1) continue;
        if (a.y+1.15<waterY) b.damage(a,70*dt,null,[a.x,a.y+.9,a.z],'drown');
      }
    }
  }

  // ---- Runaway Train Boss (暴走列車：ステージ上へ上がり蹂躙しながら攻撃) ----
  trainBossRail() {
    return this.trainBoss.rail==='metro'?this.battle.metro:this.battle.transit;
  }

  traceTrainBoss(start,end,clearance=0,limit=1) {
    const tb=this.trainBoss;
    if (!tb.active || !tb.stageMode || zoneOf(start[0])!==0) return null;
    const dx=end[0]-start[0], dy=end[1]-start[1], dz=end[2]-start[2];
    const hw=8.2+clearance, hh=1.95+clearance, hd=1.55+clearance;
    const cx=tb.x, cy=tb.y+1.95, cz=tb.z;
    const rBound=Math.hypot(hw,hd)+.5;
    if (Math.max(start[0],end[0])<cx-rBound || Math.min(start[0],end[0])>cx+rBound ||
        Math.max(start[2],end[2])<cz-rBound || Math.min(start[2],end[2])>cz+rBound ||
        Math.max(start[1],end[1])<tb.y-clearance || Math.min(start[1],end[1])>tb.y+4.2+clearance) return null;
    const fx=Math.sin(tb.yaw??0), fz=-Math.cos(tb.yaw??0);
    const rx=Math.cos(tb.yaw??0), rz=Math.sin(tb.yaw??0);
    const ox=start[0]-cx, oy=start[1]-cy, oz=start[2]-cz;
    const lx=ox*fx+oz*fz, ly=oy, lz=ox*rx+oz*rz;
    const dlx=dx*fx+dz*fz, dly=dy, dlz=dx*rx+dz*rz;
    let near=0, far=limit??1, axis=1, sign=1;
    const test=(o,d,h,ax)=>{
      if (d>-1e-6 && d<1e-6) return o>=-h && o<=h;
      const inv=1/d, t0=(-h-o)*inv, t1=(h-o)*inv;
      const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
      if (enter>near) {near=enter;axis=ax;sign=t0<t1?-1:1;}
      if (leave<far) far=leave;
      return far>=near;
    };
    if (!test(lx,dlx,hw,0) || !test(ly,dly,hh,1) || !test(lz,dlz,hd,2)) return null;
    if (near<0 || near>=far) return null;
    const normal=axis===0?[fx*sign,0,fz*sign]:axis===1?[0,sign,0]:[rx*sign,0,rz*sign];
    return {t:near,position:[start[0]+dx*near,start[1]+dy*near,start[2]+dz*near],normal,trainBoss:tb};
  }

  blocksTrainBoss(x,y,z,radius,height) {
    const tb=this.trainBoss;
    if (!tb.active || !tb.stageMode || zoneOf(x)!==0) return false;
    if (y>=tb.y+3.9 || y+height<=tb.y-.2) return false;
    const dx=x-tb.x, dz=z-tb.z;
    const fx=Math.sin(tb.yaw??0), fz=-Math.cos(tb.yaw??0);
    const rx=Math.cos(tb.yaw??0), rz=Math.sin(tb.yaw??0);
    const lx=dx*fx+dz*fz, lz=dx*rx+dz*rz;
    const cx=lx<-8.1?lx+8.1:lx>8.1?lx-8.1:0;
    const cz=lz<-1.48?lz+1.48:lz>1.48?lz-1.48:0;
    return cx*cx+cz*cz<radius*radius;
  }

  startTrainBoss(which=null) {
    const b=this.battle;
    const railKey=which ?? (this.trainBossCount%2===0?'transit':'metro');
    this.trainBossCount++;
    const rail=railKey==='metro'?b.metro:b.transit;
    const maxHp=b.teamSize===8?3800:2600;
    const name=railKey==='metro'?'暴走地下鉄 B1':'暴走列車 07';
    rail.connection=null;
    rail.train.berserk=true;
    rail.train.stop=0;
    rail.train.doorOpen=0;
    rail.train.phase='drive';
    if (!rail.train.direction) rail.train.direction=1;
    // Emergency-evacuate anyone riding or inside the runaway train cabin.
    for (const a of [...b.actors,...b.raiders.live()]) {
      if (a.down>0) continue;
      if (isCabin(a.x) && sameLevel(a.x,rail.line.cabinX) || !rail.metro && a.ride) rail.unboard(a,true);
    }
    const sx=-38, sz=0, sy=b.world.floor(sx,sz).y;
    this.trainBoss={
      active:true,rail:railKey,name,hp:maxHp,maxHp,until:b.elapsed+TRAIN_BOSS_DURATION,fire:1.0,shock:b.elapsed+1.8,
      stageMode:true,pathT:0,yaw:Math.PI*.5,pitch:0,roll:0,speed:24,x:sx,y:sy,z:sz
    };
    this.trainHits.clear();
    this.nextTrainBoss=b.elapsed+TRAIN_BOSS_INTERVAL;
    this.announce('⚠ '+name+' がステージ上に暴走侵入！蹂躙攻撃に警戒せよ！',5.4,'boss');
    b.events.unshift({label:'⚠ '+name+' ステージ上へ侵入・暴走！',team:-1,until:b.clock+4.8});
    b.events.length=Math.min(b.events.length,4);
    return this.trainBoss;
  }

  stopTrainBoss(defeated,source=null) {
    const b=this.battle, tb=this.trainBoss;
    if (!tb.active) return;
    const rail=this.trainBossRail();
    tb.active=false;
    rail.train.berserk=false;
    this.trainHits.clear();
    if (defeated) {
      rail.derail('暴走鎮圧・緊急停止');
      b.burst([tb.x,tb.y+2.2,tb.z],source?.team ?? -1,44,8.0);
      b.abilities.rings.push({x:tb.x,y:tb.y+.1,z:tb.z,r:9.5,team:source?.team??0,until:b.clock+.75});
      this.announce('✦ '+tb.name+' をステージ上で鎮圧した！',4.8,'bossDown');
      b.events.unshift({label:(source?.name ?? '鎮圧')+'  ▸  '+tb.name,team:source?.team ?? -1,until:b.clock+4.5});
      b.events.length=Math.min(b.events.length,4);
      if (source) source.kills++;
    } else {
      this.announce(tb.name+' の暴走が収まった',3.8);
    }
  }

  hurtTrainBoss(rail,amount,source) {
    const tb=this.trainBoss;
    if (!tb.active || this.trainBossRail()!==rail || !(amount>0)) return 0;
    const lost=Math.min(tb.hp,amount);
    tb.hp-=lost;
    const b=this.battle;
    if (source) {
      const credit=source.cloneOf ?? source;
      source.superCharge=Math.min(100,source.superCharge+lost*.22);
      credit.dealt=(credit.dealt??0)+lost;
      if (source.isPlayer) b.callbacks.sound?.('hit');
    }
    if (tb.hp<=0) this.stopTrainBoss(true,source?.cloneOf ?? source);
    return lost;
  }

  updateTrainBoss(dt) {
    const b=this.battle, tb=this.trainBoss;
    if (!tb.active && b.elapsed>=this.nextTrainBoss-1e-6) this.startTrainBoss();
    if (!tb.active) return;
    if (b.elapsed>=tb.until) {
      this.stopTrainBoss(false);
      return;
    }
    const rail=this.trainBossRail();
    if (rail?.train) {
      rail.train.berserk=true;
      rail.train.stop=0;
      rail.train.speed=Math.max(rail.train.speed??0,24);
    }
    // Sweep across the surface arena plaza along a dynamic high-speed rampage figure-8 loop!
    tb.pathT=(tb.pathT??0)+dt*.52;
    const tx=-Math.cos(tb.pathT)*38, tz=Math.sin(tb.pathT*2)*18.5;
    const dvx=Math.sin(tb.pathT)*38*.52, dvz=Math.cos(tb.pathT*2)*37*.52;
    const yaw=Math.atan2(dvx,-dvz);
    const ty=b.world.floor(tx,tz).y;
    const fx=Math.sin(yaw), fz=-Math.cos(yaw);
    const fFloor=b.world.floor(tx+fx*4.2,tz+fz*4.2).y, bFloor=b.world.floor(tx-fx*4.2,tz-fz*4.2).y;
    tb.x=tx; tb.y=ty; tb.z=tz; tb.yaw=yaw; tb.speed=Math.hypot(dvx,dvz);
    tb.pitch=clamp(Math.atan2(fFloor-bFloor,8.4),-.24,.24);
    tb.roll=Math.sin(b.clock*16)*.06;
    tb.stageMode=true;

    const shooter={team:-1,name:tb.name,isBoss:true};
    // Bulldoze & shatter breakables/vehicles along cowcatcher front!
    const noseX=tb.x+fx*8.4, noseZ=tb.z+fz*8.4;
    b.stage?.damageArea(b,shooter,noseX,tb.y+.6,noseZ,3.8,240);
    b.vehicles?.damageArea(noseX,tb.y+.5,noseZ,3.4,140,shooter);
    if (b.paint.hasSurface(tb.x,tb.z,0)) b.paint.kick(tb.x,tb.z,0,fx*10,fz*10);

    // Crush, stomp & knock airborne any fighter near the rampaging locomotive hull!
    const victims=[...b.actors,...b.raiders.live()];
    let target=null, bestDist=TRAIN_BOSS_WEAPON.range;
    const rx=Math.cos(yaw), rz=Math.sin(yaw);
    for (const a of victims) {
      if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==0) continue;
      const dx=a.x-tb.x, dz=a.z-tb.z;
      const lx=dx*fx+dz*fz, lz=dx*rx+dz*rz;
      if (Math.abs(lx)<9.2 && Math.abs(lz)<2.45 && a.y>=tb.y-.8 && a.y<=tb.y+4.4) {
        const lastHit=this.trainHits.get(a) ?? -99;
        if (b.clock-lastHit>=.75) {
          this.trainHits.set(a,b.clock);
          const side=lz>=0?1:-1;
          b.stepActor(a,(rx*side*2.6+fx*2.0),(rz*side*2.6+fz*2.0));
          a.vy=Math.max(a.vy??0,6.8);
          b.damage(a,115,null,[a.x,a.y+.9,a.z],'trainBoss');
          b.burst([a.x,a.y+.9,a.z],-1,14,4.2);
        }
      }
      if (a.shield<=0) {
        const dist=Math.hypot(a.x-tb.x,a.y+.9-(tb.y+3.1),a.z-tb.z);
        if (dist<bestDist && dist>3) {bestDist=dist;target=a;}
      }
    }
    // Cowcatcher shockwave smash while charging!
    if (b.elapsed>=(tb.shock??0)) {
      tb.shock=b.elapsed+2.4;
      b.abilities.rings.push({x:noseX,y:tb.y+.08,z:noseZ,r:8.2,team:1,until:b.clock+.6});
      b.burst([noseX,tb.y+.8,noseZ],1,18,5.8);
      for (const a of victims) {
        if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==0) continue;
        const d=Math.hypot(a.x-noseX,a.z-noseZ);
        if (d<8.2 && Math.abs(a.y-tb.y)<3.8) {
          const inv=1/Math.max(.3,d);
          b.stepActor(a,(a.x-noseX)*inv*2.2,(a.z-noseZ)*inv*2.2);
          b.damage(a,64*(1-.45*(d/8.2)),null,[a.x,a.y+.9,a.z],'trainBoss');
        }
      }
    }
    tb.fire-=dt;
    if (target && tb.fire<=0) {
      const from=[tb.x,tb.y+3.85,tb.z];
      const to=[target.x+(target.vx??0)*.25,target.y+.9,target.z+(target.vz??0)*.25];
      const dir=unit(sub(to,from));
      b.shots.push({pos:from,vel:scale(dir,TRAIN_BOSS_WEAPON.speed),actor:shooter,weapon:TRAIN_BOSS_WEAPON,power:1,age:0,
        bend:null,homing:{...TRAIN_BOSS_WEAPON.homing},life:1.5,id:++b.shotSequence});
      b.burst(from,-1,10,3.6);
      tb.fire=TRAIN_BOSS_WEAPON.delay;
    }
  }

  // ---- God of Destruction Goat (上位存在・破壊神ゴート: 4段階超越・8種神罰攻撃・死ぬまで降臨継続) ----
  spawnGoat() {
    const b=this.battle, g=this.goat;
    const maxHp=b.teamSize===8?30000:20000;
    Object.assign(g,{
      active:true,hp:maxHp,maxHp,phase:1,
      x:0,y:GOAT_HOVER_Y+2.4,z:-4,yaw:Math.PI,vx:0,vz:0,
      until:Infinity,nextAttack:b.clock+1.35,volley:0,lastCastKind:null,cast:null,arms:GOAT_ARMS,supreme:true
    });
    this._goatNovaHits.clear();
    b.burst([g.x,g.y,g.z],-1,56,9.0);
    b.abilities.rings.push({x:g.x,y:b.world.floor(g.x,g.z).y+.08,z:g.z,r:16,team:1,until:b.clock+.9});
    this.announce('⚠ 上位存在【破壊神ゴート】降臨！討伐するまで戦場に君臨し続ける！',5.8,'boss');
    b.events.unshift({label:'⚠ 上位存在・破壊神ゴート降臨（HP '+maxHp+' · 8種神罰/50m）',team:-1,until:b.clock+5.2});
    b.events.length=Math.min(b.events.length,4);
    return g;
  }

  hurtGoat(amount,source=null) {
    const g=this.goat;
    if (!g.active || !(amount>0)) return 0;
    // Phase 4 (神域超越) grants 20% divine damage resistance.
    const effective=g.phase>=4?amount*.8:amount;
    const lost=Math.min(g.hp,effective);
    g.hp-=lost;
    const ratio=g.hp/g.maxHp, nextPhase=ratio<.25?4:ratio<.50?3:ratio<.75?2:1;
    const b=this.battle;
    if (g.hp<=0) {
      g.active=false;
      g.cast=null;
      this._goatNovaHits.clear();
      this.nextGoat=b.elapsed+GOAT_INTERVAL;
      b.burst([g.x,g.y+1.4,g.z],source?.team ?? -1,72,11.0);
      b.abilities.rings.push({x:g.x,y:b.world.floor(g.x,g.z).y+.08,z:g.z,r:22,team:Math.max(0,source?.team??0),until:b.clock+.95});
      this.announce('✦ 上位存在・破壊神ゴートを討伐した！',5.8,'bossDown');
      b.events.unshift({label:(source?.name ?? '討伐')+'  ▸  破壊神ゴート【上位存在】',team:source?.team ?? -1,until:b.clock+5.2});
      b.events.length=Math.min(b.events.length,4);
      if (source && source.team>=0) source.kills++;
    } else if (nextPhase!==g.phase) {
      g.phase=nextPhase;
      const fy=b.world.floor(g.x,g.z).y;
      b.burst([g.x,g.y+1.2,g.z],-1,44,8.5);
      b.abilities.rings.push({x:g.x,y:fy+.08,z:g.z,r:14+nextPhase*4,team:1,until:b.clock+.75});
      for (const a of [...b.actors,...b.raiders.live()]) {
        if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==0) continue;
        const dx=a.x-g.x, dz=a.z-g.z, d=Math.hypot(dx,dz);
        if (d<14 && d>.1) b.stepActor(a,(dx/d)*2.8,(dz/d)*2.8);
      }
      const msg=nextPhase===4?'⚠ 破壊神ゴート【神域超越】覚醒！全神罰が極限へ到達！':
        nextPhase===3?'⚠ 破壊神ゴート【破滅形態】！虚空と雷撃が50m全域を焼き払う！':
        '⚠ 上位存在・破壊神ゴートが激昂した！';
      this.announce(msg,4.6,'boss');
    }
    return lost;
  }

  planGoatAttack(targets,forcedKind=null) {
    const b=this.battle, g=this.goat, phase=g.phase, clock=b.clock;
    const turn=g.volley++;
    const mind=b.hnv1?b.hnv1.mind(g):null;
    const ranked=targets.filter(a=>Math.hypot(a.x-g.x,a.z-g.z)<=GOAT_REACH)
      .sort((a,c)=>b.hnv1?b.hnv1.scoreTarget(g,a,mind?.lastTarget)-b.hnv1.scoreTarget(g,c,mind?.lastTarget):
        Math.hypot(a.x-g.x,a.z-g.z)-Math.hypot(c.x-g.x,c.z-g.z));
    const whirlR=Math.min(GOAT_REACH,24+phase*7);
    let closeCount=0, airborneCount=0, fastCount=0;
    for (const a of ranked) {
      const d=Math.hypot(a.x-g.x,a.z-g.z);
      if (d<=whirlR*.72) closeCount++;
      if (a.airborne || a.y>(b.world.floor(a.x,a.z).y+1.4)) airborneCount++;
      if (Math.hypot(a.vx??0,a.vz??0)>5.2) fastCount++;
    }

    // Smart Supreme Tactical Selection across all 8 attack kinds!
    let pick=forcedKind && GOAT_ATTACK_KINDS.includes(forcedKind)?forcedKind:null;
    if (!pick) {
      if (ranked.length===0) {
        pick=['barrage','meteor','nova'][turn%3];
      } else if (closeCount>=2 && !g.lastCastKind) {
        pick='whirl';
      } else if (closeCount>=2) {
        const closePool=['whirl','gravity','nova','beam'];
        pick=closePool[turn%closePool.length];
        if (pick===g.lastCastKind) pick=closePool[(turn+1)%closePool.length];
      } else if (fastCount+airborneCount>=Math.ceil(ranked.length*.55)) {
        const fastPool=['barrage','lightning','beam','meteor'];
        pick=fastPool[turn%fastPool.length];
        if (pick===g.lastCastKind) pick=fastPool[(turn+1)%fastPool.length];
      } else {
        const spreadPool=['smash','meteor','beam','lightning','gravity','nova','barrage'];
        pick=spreadPool[turn%spreadPool.length];
        if (pick===g.lastCastKind) pick=spreadPool[(turn+1)%spreadPool.length];
      }
    }
    g.lastCastKind=pick;
    this._goatNovaHits.clear();
    const leadAnchor=ranked[0] ?? targets[0];

    if (pick==='smash') {
      // 1. 16-Tentacle Tactical Pinpoint + Flank Trap Smash up to 50m reach
      const points=[];
      for (let i=0;i<GOAT_ARMS;i++) {
        let px, pz;
        if (i<ranked.length) {
          const t=ranked[i];
          const pred=b.hnv1?b.hnv1.predictAim(g,t,GOAT_WEAPON):null;
          px=clamp(pred?pred[0]:t.x+(t.vx??0)*.34,-52,52);
          pz=clamp(pred?pred[2]:t.z+(t.vz??0)*.34,-34,34);
        } else if (leadAnchor) {
          const t=ranked[i%Math.max(1,ranked.length)] ?? leadAnchor;
          const ringSlot=Math.floor(i/Math.max(1,ranked.length));
          const escAng=Math.atan2(t.vz??0,t.vx??0)+(ringSlot-1.5)*0.95+i*0.4;
          const cutRad=Math.min(6.2,3.4+ringSlot*1.4);
          px=clamp(t.x+Math.cos(escAng)*cutRad,-52,52);
          pz=clamp(t.z+Math.sin(escAng)*cutRad,-34,34);
        } else {
          const ang=i*TAU/GOAT_ARMS+g.yaw, rad=10+(i%4)*9.5;
          px=clamp(g.x+Math.cos(ang)*rad,-52,52);
          pz=clamp(g.z+Math.sin(ang)*rad,-34,34);
        }
        const py=b.world.floor(px,pz).y;
        points.push([px,py,pz]);
      }
      g.cast={kind:'smash',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.48,end:clock+1.08,done:false,points};
    } else if (pick==='whirl') {
      // 2. 360-degree 16-Tentacle Colossal Void Whirlwind Sweep
      g.cast={kind:'whirl',x:g.x,z:g.z,start:clock,at:clock+.44,end:clock+1.14,done:false,radius:whirlR,yaw:g.yaw};
    } else if (pick==='barrage') {
      // 3. 16-20 Smart Homing Ruin Barrage covering full 50m range
      g.cast={kind:'barrage',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.38,end:clock+.92,done:false,yaw:g.yaw};
    } else if (pick==='beam') {
      // 4. [NEW] 虚空破滅光線 — Tri-Beam Void Annihilation Sweep across 50m!
      const baseYaw=leadAnchor?Math.atan2(leadAnchor.x-g.x,-(leadAnchor.z-g.z)):g.yaw;
      const sweepDir=turn%2===0?1:-1;
      g.cast={kind:'beam',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.46,end:clock+1.52,done:false,
        yaw0:baseYaw-sweepDir*.72,sweep:sweepDir*1.44,tick:0};
    } else if (pick==='meteor') {
      // 5. [NEW] 終末流星群 — Staggered Apocalypse Void Meteor Shower across 50m!
      const count=8+phase;
      const meteors=[];
      for (let i=0;i<count;i++) {
        let mx, mz;
        if (ranked.length) {
          const t=ranked[i%ranked.length];
          const spread=i<ranked.length?1.2:4.6+(i%3)*2.2;
          const ang=i*2.39996+g.yaw;
          mx=clamp(t.x+(t.vx??0)*.48+Math.cos(ang)*spread,-50,50);
          mz=clamp(t.z+(t.vz??0)*.48+Math.sin(ang)*spread,-32,32);
        } else {
          const ang=i*TAU/count+g.yaw, rad=10+(i%4)*9;
          mx=clamp(g.x+Math.cos(ang)*rad,-50,50);
          mz=clamp(g.z+Math.sin(ang)*rad,-32,32);
        }
        const my=b.world.floor(mx,mz).y;
        meteors.push({x:Math.round(mx*10)/10,y:Math.round(my*10)/10,z:Math.round(mz*10)/10,impactAt:clock+.52+i*.095,hit:false,r:4.5});
      }
      g.cast={kind:'meteor',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.52,end:clock+.52+count*.095+.35,done:false,meteors};
    } else if (pick==='gravity') {
      // 6. [NEW] 特異点崩壊 — Abyssal Singularity Gravity Well & Implosion!
      let wx=g.x, wz=g.z;
      if (ranked.length) {
        const subset=ranked.slice(0,Math.min(4,ranked.length));
        wx=clamp(subset.reduce((s,a)=>s+a.x,0)/subset.length,-42,42);
        wz=clamp(subset.reduce((s,a)=>s+a.z,0)/subset.length,-25,25);
      }
      const wy=b.world.floor(wx,wz).y;
      g.cast={kind:'gravity',x:g.x,z:g.z,wx:Math.round(wx*10)/10,wy:Math.round(wy*10)/10,wz:Math.round(wz*10)/10,
        radius:Math.min(GOAT_REACH,22+phase*5),start:clock,at:clock+.42,end:clock+1.68,done:false,imploded:false};
    } else if (pick==='lightning') {
      // 7. [NEW] 神罰雷撃 — Vertical Sky-to-Ground Divine Judgment Lightning Pillars!
      const count=7+phase;
      const bolts=[];
      for (let i=0;i<count;i++) {
        let bx, bz;
        if (i<ranked.length) {
          const t=ranked[i];
          bx=clamp(t.x+(t.vx??0)*.38,-50,50);
          bz=clamp(t.z+(t.vz??0)*.38,-32,32);
        } else if (leadAnchor) {
          const t=ranked[i%Math.max(1,ranked.length)] ?? leadAnchor;
          const ang=i*2.1+g.yaw, rad=3.5+(i%3)*2.8;
          bx=clamp(t.x+Math.cos(ang)*rad,-50,50);
          bz=clamp(t.z+Math.sin(ang)*rad,-32,32);
        } else {
          const ang=i*TAU/count, rad=14+(i%3)*10;
          bx=clamp(g.x+Math.cos(ang)*rad,-50,50);
          bz=clamp(g.z+Math.sin(ang)*rad,-32,32);
        }
        const by=b.world.floor(bx,bz).y;
        bolts.push([Math.round(bx*10)/10,Math.round(by*10)/10,Math.round(bz*10)/10]);
      }
      g.cast={kind:'lightning',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.46,end:clock+1.22,done:false,bolts};
    } else {
      // 8. [NEW] 次元震ノヴァ — 3 Expanding Dimensional Shockwave Rings + Spatial Cross-Slash!
      g.cast={kind:'nova',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.44,end:clock+1.84,done:false,
        waves:[0,.36,.72],speed:36,yaw:g.yaw};
    }
    g.nextAttack=clock+(phase>=4?.96:phase===3?1.20:phase===2?1.52:1.86);
  }

  resolveGoatCast(targets) {
    const b=this.battle, g=this.goat, cast=g.cast;
    cast.done=true;
    if (cast.kind==='smash') {
      const dmg=140+g.phase*18;
      for (const [px,py,pz] of cast.points) {
        b.burst([px,py+.35,pz],-1,12,4.6);
        b.abilities.rings.push({x:px,y:py+.06,z:pz,r:4.0,team:1,until:b.clock+.55});
        b.stage.damageArea(b,g,px,py,pz,3.8,dmg*.9);
        b.vehicles?.damageArea(px,py,pz,3.8,dmg*.65,g);
        for (const a of targets) {
          const d=Math.hypot(a.x-px,a.z-pz);
          if (d>3.9 || Math.abs(a.y-py)>3.2) continue;
          const nx=(a.x-g.x)/Math.max(.3,Math.hypot(a.x-g.x,a.z-g.z));
          const nz=(a.z-g.z)/Math.max(.3,Math.hypot(a.x-g.x,a.z-g.z));
          b.stepActor(a,nx*2.8,nz*2.8);
          b.damage(a,dmg,g,[a.x,a.y+.9,a.z],'goat');
        }
      }
    } else if (cast.kind==='whirl') {
      const rad=cast.radius, dmg=130+g.phase*18;
      b.abilities.rings.push({x:g.x,y:b.world.floor(g.x,g.z).y+.08,z:g.z,r:rad,team:1,until:b.clock+.65});
      b.stage.damageArea(b,g,g.x,b.world.floor(g.x,g.z).y,g.z,Math.min(20,rad*.48),dmg*.75);
      for (const a of targets) {
        const dx=a.x-g.x, dz=a.z-g.z, d=Math.hypot(dx,dz);
        if (d>rad) continue;
        const inv=1/Math.max(.3,d);
        b.stepActor(a,dx*inv*3.6,dz*inv*3.6);
        b.damage(a,dmg,g,[a.x,a.y+.9,a.z],'goat');
      }
    } else if (cast.kind==='barrage') {
      const mind=b.hnv1?b.hnv1.mind(g):null;
      const sorted=targets.slice().sort((a,c)=>b.hnv1
        ?b.hnv1.scoreTarget(g,a,mind?.lastTarget)-b.hnv1.scoreTarget(g,c,mind?.lastTarget)
        :Math.hypot(a.x-g.x,a.z-g.z)-Math.hypot(c.x-g.x,c.z-g.z));
      const shotsCount=g.phase>=3?20:GOAT_ARMS;
      for (let i=0;i<shotsCount;i++) {
        const ang=g.yaw+i*TAU/shotsCount;
        const from=[g.x+Math.cos(ang)*2.8,g.y+1.4+(i%3)*.48,g.z+Math.sin(ang)*2.8];
        const tgt=sorted.length?sorted[i%sorted.length]:null;
        const to=tgt?(b.hnv1?b.hnv1.predictAim(g,tgt,GOAT_WEAPON):[tgt.x,tgt.y+.9,tgt.z])
          :[g.x+Math.cos(ang)*42,b.world.floor(g.x,g.z).y+.6,g.z+Math.sin(ang)*42];
        const dir=unit(sub(to,from));
        b.shots.push({pos:from,vel:scale(dir,GOAT_WEAPON.speed),actor:g,weapon:GOAT_WEAPON,power:1,age:0,
          bend:null,homing:{...GOAT_WEAPON.homing},life:2.25,id:++b.shotSequence});
      }
      b.burst([g.x,g.y+1.5,g.z],-1,32,6.8);
    } else if (cast.kind==='lightning') {
      // Divine Judgment Lightning: full vertical column strike hitting ground & elevated rooftops!
      const dmg=138+g.phase*18;
      for (const [bx,by,bz] of cast.bolts) {
        b.burst([bx,by+1.2,bz],-1,16,5.4);
        b.abilities.rings.push({x:bx,y:by+.07,z:bz,r:4.4,team:1,until:b.clock+.65});
        b.stage.damageArea(b,g,bx,by,bz,4.0,dmg*.95);
        b.vehicles?.damageArea(bx,by,bz,4.0,dmg*.8,g);
        for (const a of targets) {
          const d=Math.hypot(a.x-bx,a.z-bz);
          if (d>4.1) continue;
          a.vy=Math.max(a.vy??0,6.8);
          const inv=1/Math.max(.3,d);
          b.stepActor(a,(a.x-bx)*inv*2.2,(a.z-bz)*inv*2.2);
          b.damage(a,dmg,g,[a.x,a.y+1.0,a.z],'goat');
        }
      }
    } else if (cast.kind==='nova') {
      // Immediate cross-shaped spatial rift detonation around Goat!
      const fy=b.world.floor(g.x,g.z).y, dmg=110+g.phase*16;
      b.burst([g.x,g.y+1.2,g.z],-1,36,8.0);
      b.abilities.rings.push({x:g.x,y:fy+.08,z:g.z,r:14,team:1,until:b.clock+.6});
      for (const a of targets) {
        const dx=a.x-g.x, dz=a.z-g.z, d=Math.hypot(dx,dz);
        if (d<11.5) {
          const inv=1/Math.max(.3,d);
          b.stepActor(a,dx*inv*3.2,dz*inv*3.2);
          b.damage(a,dmg,g,[a.x,a.y+.9,a.z],'goat');
        }
      }
    }
  }

  stepGoatCast(targets,dt) {
    const b=this.battle, g=this.goat, cast=g.cast, now=b.clock;
    if (!cast || now<cast.at) return;
    if (!cast.done) this.resolveGoatCast(targets);

    if (cast.kind==='beam') {
      // Tri-Beam Void Annihilation Sweep (ticks every 0.11s while sweeping across 50m!)
      const span=Math.max(.05,cast.end-cast.at);
      const frac=clamp((now-cast.at)/span,0,1);
      const baseYaw=cast.yaw0+cast.sweep*frac;
      cast.tick=(cast.tick??0)+dt;
      if (cast.tick>=.11) {
        cast.tick=0;
        const beamDmg=42+g.phase*8;
        for (const offset of [-.42,0,.42]) {
          const yw=baseYaw+offset;
          const fx=Math.sin(yw), fz=-Math.cos(yw);
          const endX=clamp(g.x+fx*GOAT_REACH,-54,54), endZ=clamp(g.z+fz*GOAT_REACH,-36,36);
          const midX=g.x+fx*18, midZ=g.z+fz*18;
          b.stage.damageArea(b,g,midX,b.world.floor(midX,midZ).y,midZ,4.2,beamDmg*1.2);
          b.abilities.rings.push({x:endX,y:b.world.floor(endX,endZ).y+.08,z:endZ,r:3.2,team:1,until:now+.28});
          for (const a of targets) {
            const ax=a.x-g.x, az=a.z-g.z;
            const proj=ax*fx+az*fz;
            if (proj<1.5 || proj>GOAT_REACH) continue;
            const perp=Math.abs(ax*fz-az*fx);
            if (perp>2.35) continue;
            b.stepActor(a,fx*1.4,fz*1.4);
            b.damage(a,beamDmg,g,[a.x,a.y+.95,a.z],'goat');
          }
        }
      }
    } else if (cast.kind==='meteor') {
      // Staggered Apocalypse Meteor impacts!
      const dmg=136+g.phase*18;
      for (const m of cast.meteors) {
        if (m.hit || now<m.impactAt) continue;
        m.hit=true;
        b.burst([m.x,m.y+.6,m.z],-1,24,6.4);
        b.abilities.rings.push({x:m.x,y:m.y+.07,z:m.z,r:m.r+1.1,team:1,until:now+.68});
        b.stage.damageArea(b,g,m.x,m.y,m.z,m.r,dmg*.95);
        b.vehicles?.damageArea(m.x,m.y,m.z,m.r,dmg*.8,g);
        for (const a of targets) {
          const d=Math.hypot(a.x-m.x,a.z-m.z);
          if (d>m.r+.35 || Math.abs(a.y-m.y)>4.0) continue;
          const falloff=clamp(1-.45*(d/(m.r+.35)),.52,1);
          const inv=1/Math.max(.3,d);
          a.vy=Math.max(a.vy??0,6.4);
          b.stepActor(a,(a.x-m.x)*inv*2.4,(a.z-m.z)*inv*2.4);
          b.damage(a,dmg*falloff,g,[a.x,a.y+.9,a.z],'goat');
        }
      }
    } else if (cast.kind==='gravity') {
      // Abyssal Singularity Pull -> Catastrophic Implosion!
      const implodeAt=cast.end-.22;
      if (!cast.imploded && now<implodeAt) {
        const pullSpeed=10.5+g.phase*1.8;
        for (const a of targets) {
          const dx=cast.wx-a.x, dz=cast.wz-a.z, d=Math.hypot(dx,dz);
          if (d>cast.radius || d<.4) continue;
          const strength=clamp(1.25-d/cast.radius,.35,1.15);
          b.stepActor(a,(dx/d)*pullSpeed*strength*dt,(dz/d)*pullSpeed*strength*dt);
          if (d<7.5) b.damage(a,(36+g.phase*8)*dt,g,[a.x,a.y+.9,a.z],'goat');
        }
      } else if (!cast.imploded && now>=implodeAt) {
        cast.imploded=true;
        const dmg=150+g.phase*20, blastR=Math.min(18,cast.radius*.58);
        b.burst([cast.wx,cast.wy+1.6,cast.wz],-1,44,8.8);
        b.abilities.rings.push({x:cast.wx,y:cast.wy+.08,z:cast.wz,r:blastR,team:1,until:now+.75});
        b.stage.damageArea(b,g,cast.wx,cast.wy,cast.wz,blastR*.65,dmg*.9);
        b.vehicles?.damageArea(cast.wx,cast.wy,cast.wz,blastR*.65,dmg*.8,g);
        for (const a of targets) {
          const dx=a.x-cast.wx, dz=a.z-cast.wz, d=Math.hypot(dx,dz);
          if (d>blastR) continue;
          const inv=1/Math.max(.3,d);
          a.vy=Math.max(a.vy??0,8.6);
          b.stepActor(a,dx*inv*3.6,dz*inv*3.6);
          b.damage(a,dmg*clamp(1-.45*(d/blastR),.55,1),g,[a.x,a.y+.9,a.z],'goat');
        }
      }
    } else if (cast.kind==='nova') {
      // 3 Expanding Dimensional Shockwave Rings across 50m!
      const dmg=108+g.phase*16, spd=cast.speed??36;
      for (let wi=0;wi<cast.waves.length;wi++) {
        const age=now-(cast.at+cast.waves[wi]);
        if (age<0) continue;
        const r=2+age*spd;
        if (r>GOAT_REACH+2) continue;
        for (const a of targets) {
          const key=wi+':'+a.team+':'+a.index+':'+(a.isRaider?'r':'a');
          if (this._goatNovaHits.has(key)) continue;
          const dx=a.x-cast.x, dz=a.z-cast.z, d=Math.hypot(dx,dz);
          const fl=b.world.floor(a.x,a.z).y;
          if (Math.abs(d-r)<2.8 && a.y<fl+2.5) {
            this._goatNovaHits.add(key);
            const inv=1/Math.max(.3,d);
            b.stepActor(a,dx*inv*2.8,dz*inv*2.8);
            a.vy=Math.max(a.vy??0,5.2);
            b.damage(a,dmg,g,[a.x,a.y+.9,a.z],'goat');
          }
        }
      }
    }
  }

  updateGoat(dt) {
    const b=this.battle, g=this.goat;
    if (!g.active && b.elapsed>=this.nextGoat-1e-6) this.spawnGoat();
    if (!g.active) return;
    // Supreme Entity Goat NEVER despawns on a timer — remains on the battlefield until defeated (hp <= 0)!
    const targets=[...b.actors,...b.raiders.live()].filter(a=>a.down<=0 && !a.ride && !a.lift && zoneOf(a.x)===0);
    // Smart Apex Intelligence: target densest threat cluster & weave around incoming specials/trains!
    let focus=b.hnv1?b.hnv1.pickApexTarget(g,targets,dt):null;
    if (!focus) {
      let best=Infinity;
      for (const a of targets) {
        const d=Math.hypot(a.x-g.x,a.z-g.z);
        if (d<best) {best=d;focus=a;}
      }
    }
    // Hazard & special avoidance force (e.g. evading tsunami wave, express train, prism beams, oncoming fire)
    let evadeX=0, evadeZ=0;
    for (const a of targets) {
      if (a.beaming || a.charge>.45) {
        const dx=g.x-a.x, dz=g.z-a.z, d=Math.hypot(dx,dz);
        if (d<24 && d>.2) {evadeX+=-dz/d*4.6; evadeZ+=dx/d*4.6;}
      }
    }
    if (this.tsunami?.phase==='wave') {
      const td=Math.abs(g.x-this.tsunami.x);
      if (td<this.tsunami.width) evadeZ+=(g.z>=0?1:-1)*5.5;
    }
    const speed=g.phase>=4?11.4:g.phase===3?10.0:g.phase===2?8.4:7.0;
    if (focus) {
      const leadX=focus.x+(focus.vx??0)*.35, leadZ=focus.z+(focus.vz??0)*.35;
      const dx=leadX-g.x, dz=leadZ-g.z, d=Math.max(.01,Math.hypot(dx,dz));
      const targetYaw=Math.atan2(dx,-dz);
      let dYaw=targetYaw-g.yaw;
      while (dYaw>Math.PI) dYaw-=TAU; while (dYaw<-Math.PI) dYaw+=TAU;
      g.yaw+=dYaw*clamp(dt*6.8,0,1);
      if (d>11.5) {
        g.vx=dx/d*speed+evadeX;
        g.vz=dz/d*speed+evadeZ;
      } else {
        const pull=(d-8.5)*.35;
        g.vx=(-dz/d*.75+dx/d*pull)*speed+evadeX;
        g.vz=(dx/d*.75+dz/d*pull)*speed+evadeZ;
      }
    } else {
      g.yaw+=dt*.85;
      g.vx=Math.sin(g.yaw)*speed*.45+evadeX;
      g.vz=-Math.cos(g.yaw)*speed*.45+evadeZ;
    }
    g.x=clamp(g.x+g.vx*dt,-48,48);
    g.z=clamp(g.z+g.vz*dt,-29,29);
    const floor=b.world.floor(g.x,g.z).y;
    const hoverBoost=g.cast?.kind==='meteor' || g.cast?.kind==='beam'?1.6:0;
    const hoverTarget=floor+GOAT_HOVER_Y+hoverBoost+(focus?.airborne?1.1:0)+Math.sin(b.clock*2.8)*.62;
    g.y=g.y+(hoverTarget-g.y)*clamp(dt*4.8,0,1);
    // Transcendent core pressure aura repels close fighters beneath/inside Goat's void silhouette.
    for (const a of targets) {
      const dx=a.x-g.x, dz=a.z-g.z, d=Math.hypot(dx,dz);
      if (d<3.2 && d>.05) {
        b.stepActor(a,(dx/d)*4.5*dt,(dz/d)*4.5*dt);
        b.damage(a,(22+g.phase*5)*dt,g,[a.x,a.y+.9,a.z],'goat');
      }
    }
    if (g.cast) {
      this.stepGoatCast(targets,dt);
      if (b.clock>=g.cast.end) g.cast=null;
    } else if (b.clock>=g.nextAttack && targets.length) {
      this.planGoatAttack(targets);
    }
  }

  update(dt) {
    this.updateSnipers(dt);
    this.updateRogueDrones(dt);
    this.updateHeli(dt);
    this.updateRain(dt);
    this.updateTsunamiAndFlood(dt);
    this.updateTrainBoss(dt);
    this.updateGoat(dt);
  }

  // ---- Serialization for Cloudflare frames and checkpoints ----
  snapshot(zone,mergeStairs=false) {
    const near=x=>{const l=zoneOf(x); return l===zone || mergeStairs && l<2;};
    const g=this.goat, tb=this.trainBoss, h=this.heli;
    const out={
      alert:this.alert,alertUntil:this.alertUntil,
      rain:this.rain.active,
      tsunami:this.tsunami.phase==='idle'?null:{phase:this.tsunami.phase,x:Math.round(this.tsunami.x*100)/100,height:this.tsunami.height,width:this.tsunami.width},
      underFlood:this.underFlood.active?{phase:this.underFlood.phase,depth:Math.round(this.underFlood.depth*100)/100}:null,
      trainBoss:tb.active?{active:true,rail:tb.rail,name:tb.name,stageMode:!!tb.stageMode,
        hp:Math.round(tb.hp*100)/100,maxHp:tb.maxHp,
        x:Math.round(tb.x*100)/100,y:Math.round(tb.y*100)/100,z:Math.round(tb.z*100)/100,
        yaw:Math.round((tb.yaw??0)*100)/100,pitch:Math.round((tb.pitch??0)*100)/100}:null,
      goat:g.active?{active:true,name:g.name,hp:Math.round(g.hp*100)/100,maxHp:g.maxHp,phase:g.phase,
        x:Math.round(g.x*100)/100,y:Math.round(g.y*100)/100,z:Math.round(g.z*100)/100,yaw:Math.round(g.yaw*100)/100,
        cast:near(g.x)?g.cast:null}:null,
      snipers:this.snipers.filter(s=>s.active && near(s.x)).map(s=>({
        id:s.id,x:s.x,y:s.y,z:s.z,yaw:s.yaw,pitch:s.pitch,hp:s.hp,maxHp:s.maxHp,aim:s.aim,targetPos:s.targetPos,flash:s.flash,recoil:s.recoil,active:true
      })),
      rogueDrones:this.rogueDrones.filter(d=>d.active && near(d.x)).map(d=>({
        id:d.id,x:d.x,y:d.y,z:d.z,yaw:d.yaw,hp:d.hp,maxHp:d.maxHp,flash:d.flash,aim:d.aim,active:true
      }))
    };
    if (h.active) out.heli={
      active:true,name:h.name,hp:Math.round(h.hp*100)/100,maxHp:h.maxHp,
      x:Math.round(h.x*100)/100,y:Math.round(h.y*100)/100,z:Math.round(h.z*100)/100,
      yaw:Math.round(h.yaw*100)/100,pitch:Math.round((h.pitch??0)*100)/100,roll:Math.round((h.roll??0)*100)/100,
      rotor:Math.round(h.rotor*100)/100
    };
    if (this.missiles.length && (zone===0 || mergeStairs)) {
      out.missiles=this.missiles.slice(0,12).map(m=>[Math.round(m.x*20)/20,Math.round(m.y*20)/20,Math.round(m.z*20)/20,
        Math.round(m.vx*10)/10,Math.round(m.vy*10)/10,Math.round(m.vz*10)/10]);
    }
    return out;
  }

  applySnapshot(data) {
    if (!data) return;
    this.alert=data.alert??'';
    this.alertUntil=data.alertUntil??0;
    this.rain.active=!!data.rain;
    this.tsunami=data.tsunami?{...this.tsunami,...data.tsunami}:{...this.tsunami,phase:'idle'};
    this.underFlood=data.underFlood?{...this.underFlood,active:true,...data.underFlood}:{...this.underFlood,active:false,phase:'idle',depth:0};
    this.trainBoss=data.trainBoss?{...this.trainBoss,...data.trainBoss}:{...this.trainBoss,active:false};
    this.heli=data.heli?{...this.heli,...data.heli}:{...this.heli,active:false};
    this.missiles=Array.isArray(data.missiles)?data.missiles.map((m,i)=>({id:i,x:m[0],y:m[1],z:m[2],vx:m[3],vy:m[4],vz:m[5]})):[];
    this.goat=data.goat?{...this.goat,...data.goat}:{...this.goat,active:false,cast:null};
    this.snipers=data.snipers??[];
    this.rogueDrones=data.rogueDrones??[];
  }

  checkpoint() {
    const {weapon:_gw,...goatData}=this.goat;
    const {weapon:_hw,...heliData}=this.heli;
    const gCast=goatData.cast;
    let castCopy=null;
    if (gCast) {
      castCopy={...gCast};
      if (gCast.points) castCopy.points=gCast.points.map(p=>[p[0],p[1],p[2]]);
      if (gCast.meteors) castCopy.meteors=gCast.meteors.map(m=>({...m}));
      if (gCast.bolts) castCopy.bolts=gCast.bolts.map(p=>[p[0],p[1],p[2]]);
      if (gCast.waves) castCopy.waves=gCast.waves.slice();
    }
    goatData.cast=castCopy;
    const snipers=new Array(this.snipers.length);
    for (let i=0;i<this.snipers.length;i++) {
      const {weapon:_w,...s}=this.snipers[i];
      if (s.targetPos) s.targetPos=[s.targetPos[0],s.targetPos[1],s.targetPos[2]];
      snipers[i]=s;
    }
    const rogueDrones=new Array(this.rogueDrones.length);
    for (let i=0;i<this.rogueDrones.length;i++) {
      const {weapon:_w,...d}=this.rogueDrones[i];
      rogueDrones[i]=d;
    }
    const missiles=new Array(this.missiles.length);
    for (let i=0;i<this.missiles.length;i++) missiles[i]={...this.missiles[i]};
    return {
      seed:this.rng.state(),sniperWave:this.sniperWave,droneWave:this.droneWave,heliWave:this.heliWave,trainBossCount:this.trainBossCount,
      droneSpawnsLeft:this.droneSpawnsLeft,droneSpawnTimer:this.droneSpawnTimer,
      nextSniper:this.nextSniper,sniperRetreatAt:this.sniperRetreatAt,
      nextDrone:this.nextDrone,droneRetreatAt:this.droneRetreatAt,
      nextHeli:this.nextHeli,heli:{...heliData},missiles,
      nextRain:this.nextRain,rain:{...this.rain},
      nextTsunami:this.nextTsunami,tsunami:{...this.tsunami},
      underFlood:{...this.underFlood},
      nextTrainBoss:this.nextTrainBoss,trainBoss:{...this.trainBoss},
      nextGoat:this.nextGoat,goat:goatData,
      alert:this.alert,alertUntil:this.alertUntil,
      snipers,rogueDrones
    };
  }

  restoreCheckpoint(data) {
    if (!data) return;
    const b=this.battle;
    if (Number.isInteger(data.seed)) this.rng=randomGenerator(data.seed);
    for (const k of ['sniperWave','droneWave','heliWave','trainBossCount','droneSpawnsLeft','droneSpawnTimer',
      'nextSniper','sniperRetreatAt','nextDrone','droneRetreatAt','nextHeli',
      'nextRain','nextTsunami','nextTrainBoss','nextGoat','alert','alertUntil']) {
      if (data[k]!==undefined) this[k]=data[k];
    }
    if (data.rain) this.rain={...data.rain};
    if (data.tsunami) this.tsunami={...data.tsunami};
    if (data.underFlood) this.underFlood={...this.underFlood};
    if (data.trainBoss) this.trainBoss={...data.trainBoss};
    if (data.heli) this.heli={...this.heli,...structuredClone(data.heli),weapon:HELI_MISSILE_WEAPON};
    this.missiles=structuredClone(data.missiles??[]);
    if (data.goat) this.goat={...this.goat,...structuredClone(data.goat),weapon:GOAT_WEAPON};
    this.snipers=(data.snipers??[]).map(s=>{const copy={...structuredClone(s),weapon:SNIPER_WEAPON};b.hnv1?.mind(copy);return copy;});
    this.rogueDrones=(data.rogueDrones??[]).map(d=>{const copy={...structuredClone(d),weapon:ROGUE_DRONE_WEAPON};b.hnv1?.mind(copy);return copy;});
    b.hnv1?.mind(this.goat);
    this.trainHits.clear();
  }

  drawGoat(r,now) {
    const g=this.goat;
    if (!g.active) return;
    const lite=!!r.lite || !!r.ultralite;
    const yaw=Math.PI-g.yaw, cy=Math.cos(yaw), sy=Math.sin(yaw);
    const gx=g.x, gy=g.y, gz=g.z;
    const breath=1+Math.sin(now*3.8)*.045;
    const cast=g.cast;
    const bodyTilt=cast?.kind==='whirl'?.24:cast?.kind==='smash'?-.14:Math.sin(now*2.1)*.06;
    const dark=0x1c1424, armor=0x2d1d38, gold=0xe5b84b, crimson=0xff2442, hotGold=0xffe680;
    const floor=this.battle.world.floor(gx,gz).y;
    const setAt=(dst,lx,ly,lz)=>{dst[0]=gx+lx*cy+lz*sy; dst[1]=gy+ly; dst[2]=gz-lx*sy+lz*cy;};
    _hzDynYP.yaw=yaw; _hzDynYP.pitch=bodyTilt;
    const put=(type,lx,ly,lz,w,h,d,col,mat=4,pitch=bodyTilt)=>{
      _hzDynYP.pitch=pitch;
      r.add(type,gx+lx*cy+lz*sy,gy+ly,gz-lx*sy+lz*cy,w,h,d,col,mat,_hzDynYP);
    };

    // Ominous dual levitation sigil & dark AO contact shadow directly beneath Goat
    _hzDynLabel.label=(now*.8)%1;
    r.add('ripple',gx,floor+.06,gz,6.4+Math.sin(now*6)*.65,.04,6.4+Math.sin(now*6)*.65,crimson,12,_hzDynLabel);
    if (!lite) {
      _hzDynLabel.label=((now*.8)+.5)%1;
      r.add('ripple',gx,floor+.09,gz,4.2+Math.cos(now*5)*.45,.04,4.2+Math.cos(now*5)*.45,gold,12,_hzDynLabel);
      _hzDynLabel.label=.70;
      r.add('shade',gx,floor+.02,gz,4.6,1,4.6,0,28,_hzDynLabel);
    }

    // Floating obsidian torso, sculpted rib-armor, divine mantle collar, pulsing crimson heart core & flowing cloak ribbons!
    put('bevel',0,1.45,0,1.98*breath,2.24,1.38*breath,dark,4);
    put('taper',0,.15,0,1.78,1.82,1.28,armor,4);
    const heartPulse=1+Math.sin(now*(cast?14:6))*.14;
    put('orb',0,1.65,.68,.70*heartPulse,.92*heartPulse,.36,cast?hotGold:crimson,3);
    put('bevel',0,2.38,0,2.30,.38,1.52,gold,4);
    if (!lite) {
      // Sculpted obsidian chest ribs + 3 flowing void cloak ribbons whipping behind Goat!
      for (let rb=0;rb<3;rb++) put('bevel',0,1.15+rb*.38,.66,1.55-rb*.12,.11,.16,gold,4);
      for (let c=-1;c<=1;c++) {
        const wave=Math.sin(now*4.6+c*1.3)*.28;
        put('bevel',c*.65,.45,-.82+wave*.25,.42,1.95,.10,c===0?armor:dark,4,.22+wave*.35);
        put('bevel',c*.72,-.55,-1.08+wave*.55,.32,1.15,.08,crimson,3,.42+wave*.55);
      }
    }

    // Supreme Entity Deity Skull-Helm, Blazing Third-Eye Crown, Articulated Jaw & Sweeping Twin Horns
    put('orb',0,3.15,.10,1.24,1.24,1.44,0xefe7d6,4,bodyTilt*.6);
    put('bevel',0,2.85,.68,.62,.48,.68,0xdcd2bd,4,bodyTilt*.6);
    put('orb',0,3.62,.58,.24,.32,.18,g.phase>=3 || cast?hotGold:crimson,3,bodyTilt*.5); // blazing third eye
    if (!lite) {
      put('bevel',0,3.88,.24,.18,.56,.58,gold,4,-.15);
      // Floating transcendent crown diadem ring above skull
      _hzDynYP.yaw=yaw+now*2.2; _hzDynYP.pitch=.18;
      setAt(_hzA,0,4.35,.05);
      r.add('ring',_hzA[0],_hzA[1],_hzA[2],1.45,.065,1.45,g.phase>=4?hotGold:gold,3,_hzDynYP);
    }
    for (let s=-1;s<=1;s+=2) {
      put('orb',s*.34,3.26,.65,.32,.18,.20,cast?hotGold:crimson,3,bodyTilt*.6);
      setAt(_hzA,s*.38,3.62,.05); setAt(_hzB,s*1.04,4.42,-.38); setAt(_hzC,s*1.42,4.15,-1.28);
      r.beam(_hzA,_hzB,.28,.21,gold,4,_hzDyn);
      r.beam(_hzB,_hzC,.20,.10,0x452b18,4,_hzDyn);
      if (!lite) r.add('orb',_hzC[0],_hzC[1],_hzC[2],.22,.22,.22,crimson,3,_hzDyn);
    }

    // 6 Radiant Seraphic Void Wing-Blades + Triple Counter-Rotating Celestial-Void Halos!
    if (!lite) {
      for (let w=0;w<3;w++) for (const side of [-1,1]) {
        const flap=Math.sin(now*3.6+w*.9)*.22;
        const wx=side*(2.6+w*.95), wy=3.4-w*.78+flap*.7, wz=-1.25-w*.25;
        setAt(_hzA,side*1.2,2.4-w*.45,-.75);
        setAt(_hzB,wx,wy,wz);
        r.beam(_hzA,_hzB,.22,.08,w===1?gold:crimson,3,_hzDyn);
        _hzDynYP.yaw=yaw+side*(.35+w*.14); _hzDynYP.pitch=flap;
        r.add('bevel',_hzB[0],_hzB[1],_hzB[2],1.45-w*.18,.26,.09,w===0?hotGold:armor,w===0?3:4,_hzDynYP);
      }
      if ((g.phase??1)>=3 || cast) {
        // Skyward supreme presence pillar
        _hzA[0]=gx; _hzA[1]=floor+.1; _hzA[2]=gz;
        _hzB[0]=gx; _hzB[1]=gy+22; _hzB[2]=gz;
        r.beam(_hzA,_hzB,.32,.12,g.phase>=4?hotGold:crimson,3,_hzDyn);
      }
    }
    const haloN=lite?8:10;
    for (let i=0;i<haloN;i++) {
      const a=now*1.95+i*TAU/haloN;
      const hx=Math.cos(a)*2.95, hy=2.25+Math.sin(a)*2.95;
      setAt(_hzA,hx,hy,-.95);
      r.add('orb',_hzA[0],_hzA[1],_hzA[2],.36,.36,.36,i%2?gold:crimson,3,_hzDyn);
      if (!lite && i%2===0) {
        const a2=-now*2.55+i*TAU/haloN;
        setAt(_hzB,Math.cos(a2)*3.85,2.25+Math.sin(a2)*3.85,-1.18);
        _hzDynYP.yaw=yaw+a2; _hzDynYP.pitch=a2*.5;
        r.add('bevel',_hzB[0],_hzB[1],_hzB[2],.28,.64,.14,dark,4,_hzDynYP);
      }
    }

    // 16 Thick Articulated Divine Tentacles in twin tiered wings with Pauldrons, Bracer Rings, Glowing Palms & Claws!
    const links=lite?3:5;
    const pts=links===5?_hzPts6:_hzPts4;
    for (let i=0;i<GOAT_ARMS;i++) {
      const side=i%2===0?-1:1, row=(i>>1)&3, layerIdx=i>>3;
      setAt(pts[0],side*(1.05+row*.16+layerIdx*.36),2.55-row*.44+layerIdx*.34,layerIdx===0?.08:-.52);
      const sx0=pts[0][0], sy0=pts[0][1], sz0=pts[0][2];
      // Ornate gold shoulder pauldron per tentacle!
      if (!lite) r.add('bevel',sx0,sy0+.08,sz0,.74,.52,.74,(row+layerIdx)%2?gold:armor,4,_hzDynYP);
      let tx, ty, tz;
      if (cast?.kind==='smash' && cast.points?.[i]) {
        const pt=cast.points[i];
        const prog=clamp((now-cast.start)/Math.max(.05,cast.at-cast.start),0,1);
        const strike=now>=cast.at?1:prog*prog*.42;
        const coilLift=now<cast.at?Math.sin(prog*Math.PI)*3.8:0;
        tx=sx0+(pt[0]-sx0)*strike;
        ty=sy0+(pt[1]+.40-sy0)*strike+coilLift;
        tz=sz0+(pt[2]-sz0)*strike;
        if (!cast.done) {
          _hzDynLabel.label=prog;
          r.add('hazard',pt[0],pt[1]+.05,pt[2],7.8,1,7.8,crimson,24,_hzDynLabel);
        }
      } else if (cast?.kind==='whirl') {
        const spin=now*11.5+i*TAU/GOAT_ARMS, reach=Math.min(28,18+(g.phase??1)*3.5);
        tx=gx+Math.cos(spin)*reach; ty=gy+.55+Math.sin(spin*2)*.6; tz=gz+Math.sin(spin)*reach;
      } else if (cast?.kind==='barrage') {
        const prog=clamp((now-cast.start)/Math.max(.05,cast.at-cast.start),0,1);
        const ang=i*TAU/GOAT_ARMS, rad=4.2-prog*.9+(layerIdx*.8);
        setAt(_hzA,Math.cos(ang)*rad,2.2+Math.sin(ang)*1.7,2.1+prog*1.2);
        tx=_hzA[0]; ty=_hzA[1]; tz=_hzA[2];
      } else if (cast?.kind==='meteor' || cast?.kind==='lightning') {
        // All 16 tentacles raised skyward invoking celestial judgment!
        const ang=i*TAU/GOAT_ARMS+now*1.4, rad=3.2+layerIdx*1.1;
        tx=gx+Math.cos(ang)*rad; ty=gy+5.4+Math.sin(now*8+i)*.55; tz=gz+Math.sin(ang)*rad;
      } else if (cast?.kind==='gravity' && cast.wx!==undefined) {
        // All 16 tentacles channel void filaments into the singularity core!
        const ang=i*TAU/GOAT_ARMS+now*3.8;
        tx=cast.wx+Math.cos(ang)*2.4; ty=(cast.wy??0)+2.2+Math.sin(ang*2)*.9; tz=cast.wz+Math.sin(ang)*2.4;
      } else if (cast?.kind==='beam' || cast?.kind==='nova') {
        const ang=i*TAU/GOAT_ARMS+now*2.6, rad=4.8+Math.sin(now*10+i)*.5;
        tx=gx+Math.cos(ang)*rad; ty=gy+2.4+Math.cos(ang*2)*.8; tz=gz+Math.sin(ang)*rad;
      } else {
        const wave=now*3.4+i*.68;
        const spread=(1.4+row*.36+layerIdx*.28)*Math.PI/8;
        setAt(_hzA,side*(3.0+Math.sin(wave)*.75+row*.38+layerIdx*.65),3.05-row*.58+layerIdx*.55+Math.cos(wave*1.3)*.58,1.55-layerIdx*.5+Math.sin(wave*.8+spread)*.9);
        tx=_hzA[0]; ty=_hzA[1]; tz=_hzA[2];
      }
      for (let j=1;j<links;j++) {
        const t=j/links, arch=Math.sin(t*Math.PI)*(1.45+(i%2)*.46+layerIdx*.25);
        const pDst=pts[j];
        pDst[0]=sx0+(tx-sx0)*t+side*cy*arch*.38;
        pDst[1]=sy0+(ty-sy0)*t+arch*.92;
        pDst[2]=sz0+(tz-sz0)*t-side*sy*arch*.38;
      }
      pts[links][0]=tx; pts[links][1]=ty; pts[links][2]=tz;
      drawTentacle(r,pts,.62,dark,gold,lite?0:crimson);
      const palmS=cast?.kind==='barrage'?.92:.76;
      r.add('orb',tx,ty,tz,palmS,palmS,palmS,cast?crimson:gold,3,_hzDyn);
      if (!lite) {
        const wrist=pts[links-1];
        r.add('ring',wrist[0],wrist[1],wrist[2],.68,.09,.68,gold,4,_hzDyn);
        const clawSpread=cast?.kind==='barrage'?.56:.40;
        const dx=tx-wrist[0], dy=ty-wrist[1], dz=tz-wrist[2];
        const inv=1/Math.max(.01,Math.hypot(dx,dy,dz));
        const fx=dx*inv, fy=dy*inv, fz=dz*inv;
        for (let c=-1;c<=1;c++) {
          const cx=tx+fx*.72+c*cy*clawSpread, cy2=ty+fy*.72+(c===0?.30:-.15), cz=tz+fz*.72-c*sy*clawSpread;
          _hzA[0]=tx; _hzA[1]=ty; _hzA[2]=tz;
          _hzB[0]=cx; _hzB[1]=cy2; _hzB[2]=cz;
          r.beam(_hzA,_hzB,.16,.11,gold,4,_hzDyn);
        }
      }
    }

    // ---- 3D Visuals for the 5 New Supreme Entity Attacks ----
    if (cast?.kind==='beam') {
      const firing=now>=cast.at;
      const frac=firing?clamp((now-cast.at)/Math.max(.05,cast.end-cast.at),0,1):0;
      const baseYaw=cast.yaw0+cast.sweep*frac;
      for (const offset of [-.42,0,.42]) {
        const yw=baseYaw+offset;
        const fx=Math.sin(yw), fz=-Math.cos(yw);
        const ex=clamp(gx+fx*GOAT_REACH,-54,54), ez=clamp(gz+fz*GOAT_REACH,-36,36);
        const ey=this.battle.world.floor(ex,ez).y+.6;
        _hzA[0]=gx; _hzA[1]=gy+2.8; _hzA[2]=gz;
        _hzB[0]=ex; _hzB[1]=ey; _hzB[2]=ez;
        if (firing) {
          r.beam(_hzA,_hzB,.68,.82,crimson,3,_hzDyn);
          if (!lite) r.beam(_hzA,_hzB,.28,.34,hotGold,3,_hzDyn);
          r.add('orb',ex,ey,ez,1.9,1.9,1.9,hotGold,3,_hzDyn);
        } else {
          r.beam(_hzA,_hzB,.08,.08,gold,3,_hzDyn);
        }
      }
    } else if (cast?.kind==='meteor' && cast.meteors) {
      for (let i=0;i<cast.meteors.length;i++) {
        const m=cast.meteors[i];
        if (now>m.impactAt+.18) continue;
        const fallDur=.52;
        const prog=clamp(1-(m.impactAt-now)/fallDur,0,1);
        _hzDynLabel.label=prog;
        r.add('hazard',m.x,m.y+.06,m.z,m.r*2,1,m.r*2,crimson,24,_hzDynLabel);
        if (now>=m.impactAt-fallDur && now<=m.impactAt+.06) {
          const my=m.y+34*(1-prog)+.8;
          const mx=m.x+5.5*(1-prog), mz=m.z-4.0*(1-prog);
          r.add('orb',mx,my,mz,2.1,2.1,2.1,dark,4,_hzDyn);
          r.add('orb',mx,my,mz,1.55,1.55,1.55,crimson,3,_hzDyn);
          _hzA[0]=mx; _hzA[1]=my; _hzA[2]=mz;
          _hzB[0]=mx+3.6; _hzB[1]=my+6.5; _hzB[2]=mz-2.6;
          r.beam(_hzA,_hzB,.85,.18,hotGold,3,_hzDyn);
        }
      }
    } else if (cast?.kind==='gravity' && cast.wx!==undefined) {
      const wx=cast.wx, wy=(cast.wy??0)+2.2, wz=cast.wz;
      const prog=clamp((now-cast.start)/Math.max(.05,cast.end-cast.start),0,1);
      const scaleW=cast.imploded?2.8:1.1+prog*1.35;
      r.add('orb',wx,wy,wz,scaleW*1.6,scaleW*1.6,scaleW*1.6,0x090410,4,_hzDyn);
      _hzDynYP.yaw=now*6.5; _hzDynYP.pitch=.38;
      r.add('ring',wx,wy,wz,scaleW*3.2,.18,scaleW*3.2,crimson,3,_hzDynYP);
      if (!lite) {
        _hzDynYP.yaw=-now*8.2; _hzDynYP.pitch=-.52;
        r.add('ring',wx,wy,wz,scaleW*4.4,.12,scaleW*4.4,0xa838ff,3,_hzDynYP);
      }
      _hzDynLabel.label=(1-(now*2.2)%1);
      r.add('ripple',wx,(cast.wy??0)+.07,wz,cast.radius*.85,.05,cast.radius*.85,0x9a30ff,12,_hzDynLabel);
    } else if (cast?.kind==='lightning' && cast.bolts) {
      const struck=now>=cast.at;
      const prog=clamp((now-cast.start)/Math.max(.05,cast.at-cast.start),0,1);
      for (let i=0;i<cast.bolts.length;i++) {
        const [bx,by,bz]=cast.bolts[i];
        if (!struck) {
          _hzDynLabel.label=prog;
          r.add('hazard',bx,by+.06,bz,8.2,1,8.2,gold,24,_hzDynLabel);
        } else {
          const fade=clamp(1-(now-cast.at)/Math.max(.05,cast.end-cast.at),0,1);
          const jit=Math.sin(now*60+i*2.7)*.55;
          _hzA[0]=bx; _hzA[1]=by; _hzA[2]=bz;
          _hzB[0]=bx+jit; _hzB[1]=by+14; _hzB[2]=bz-jit*.7;
          _hzC[0]=bx-jit*.5; _hzC[1]=by+28; _hzC[2]=bz+jit;
          r.beam(_hzA,_hzB,.72*fade,.55*fade,hotGold,3,_hzDyn);
          r.beam(_hzB,_hzC,.55*fade,.35*fade,crimson,3,_hzDyn);
          r.add('orb',bx,by+.8,bz,2.4*fade,2.4*fade,2.4*fade,hotGold,3,_hzDyn);
        }
      }
    } else if (cast?.kind==='nova' && cast.waves) {
      const fy=this.battle.world.floor(cast.x,cast.z).y;
      if (now>=cast.at) {
        const spd=cast.speed??36;
        for (let wi=0;wi<cast.waves.length;wi++) {
          const age=now-(cast.at+cast.waves[wi]);
          if (age<0) continue;
          const rad=2+age*spd;
          if (rad>GOAT_REACH+2) continue;
          _hzDynLabel.label=clamp(rad/GOAT_REACH,0,1);
          r.add('ripple',cast.x,fy+.12+wi*.08,cast.z,rad*2,.16,rad*2,wi%2?gold:crimson,12,_hzDynLabel);
        }
      } else {
        const prog=clamp((now-cast.start)/Math.max(.05,cast.at-cast.start),0,1);
        _hzDynLabel.label=prog;
        r.add('hazard',cast.x,fy+.06,cast.z,24,1,24,crimson,24,_hzDynLabel);
      }
    }
  }

  // ---- 3D Rendering (High Craft + Zero-Allocation + Frustum Culled VFX) ----
  draw(r,viewX,viewZ) {
    const now=this.battle.clock+(this.battle.impactAgeOffset??0);
    const zone=zoneOf(viewX);
    const lite=!!r.lite || !!r.ultralite;
    const hasFrustum=typeof r.inFrustum==='function';

    // 1. Apartment Snipers (Crouched Tactical Stance, Recoil Kickback, Scope Glint & Pulsing Laser Sight!)
    if (zone===0) {
      for (let i=0;i<this.snipers.length;i++) {
        const s=this.snipers[i];
        if (!s.active) continue;
        const yaw=Math.PI-s.yaw;
        const breath=Math.sin(now*3.6+s.id)*.022;
        const kick=(s.recoil??0)*.18;
        const fx=Math.sin(s.yaw), fz=-Math.cos(s.yaw);
        const rx=Math.cos(s.yaw), rz=Math.sin(s.yaw);
        _hzDynYP.yaw=yaw; _hzDynYP.pitch=-kick*.4;
        r.add('bevel',s.x,s.y+.50+breath,s.z,.60,.82,.44,0x2a222d,20,_hzDynYP);
        if (!lite) {
          // Tactical sniper hood cloak & armored chest rig
          r.add('bevel',s.x-fx*.12,s.y+.54+breath,s.z-fz*.12,.68,.78,.28,0x1a1520,21,_hzDynYP);
          r.add('bevel',s.x+fx*.20,s.y+.68+breath,s.z+fz*.20,.38,.28,.12,0x45354c,20,_hzDynYP);
        }
        _hzDynYP.pitch=0;
        r.add('orb',s.x,s.y+1.26+breath,s.z,.49,.49,.49,0x342838,20,_hzDynYP);
        r.add('orb',s.x+fx*.21,s.y+1.28+breath,s.z+fz*.21,.28,.14,.16,0xff2438,3,_hzDynYP);
        // Long fluted anti-materiel sniper rifle with kickback + glinting scope!
        const sp=Math.sin(s.pitch);
        _hzA[0]=s.x+fx*(.15-kick); _hzA[1]=s.y+1.16+breath; _hzA[2]=s.z+fz*(.15-kick);
        _hzB[0]=s.x+fx*(1.22-kick); _hzB[1]=s.y+1.18+breath+sp*.82; _hzB[2]=s.z+fz*(1.22-kick);
        r.beam(_hzA,_hzB,.095,.095,0x1d2529,4,_hzDyn);
        if (!lite) {
          // High-magnification scope + lens glint + muzzle brake
          r.add('cylinder',s.x+fx*(.48-kick),s.y+1.30+breath+sp*.22,s.z+fz*(.48-kick),.09,.32,.09,0x2c363b,4,_hzDynYP);
          r.add('orb',s.x+fx*(.66-kick),s.y+1.30+breath+sp*.30,s.z+fz*(.66-kick),.08,.08,.08,s.aim>.1?0xff5870:0x9ee6df,3,_hzDyn);
          r.add('box',_hzB[0],_hzB[1],_hzB[2],.14,.14,.14,0x151a1e,4,_hzDynYP);
          // Bipod legs braced on parapet
          _hzC[0]=s.x+fx*.75+rx*.16; _hzC[1]=s.y+.72; _hzC[2]=s.z+fz*.75+rz*.16;
          r.beam(_hzA,_hzC,.035,.035,0x2c363b,4,_hzDyn);
        }
        if (s.targetPos && s.aim>.08) {
          const pulse=.026+.026*Math.sin(now*30);
          r.beam(_hzB,s.targetPos,pulse,pulse,0xff2438,3,_hzDyn);
        }
        if (now-(s.flash??-9)<.16) {
          r.add('orb',_hzB[0],_hzB[1],_hzB[2],.46,.46,.46,0xffb060,3,_hzDyn);
          if (!lite) r.add('ring',_hzB[0],_hzB[1],_hzB[2],.72,.06,.72,0xff4458,3,_hzDynYP);
        }
      }
    }

    // 2. Hostile Rogue Drones (Banking Tilted Chassis, 4 Spinning Rotor Blades + Glow Discs & Scan Cone!)
    for (let i=0;i<this.rogueDrones.length;i++) {
      const d=this.rogueDrones[i];
      if (!d.active || !sameLevel(d.x,viewX)) continue;
      const bob=Math.sin(now*9.2+d.id)*.12, y=d.y+bob;
      const bankPitch=Math.sin(now*4.5+d.id)*.16+((now-(d.flash??-9))<.16?-.22:0);
      const cy=Math.cos(d.yaw), sy=Math.sin(d.yaw);
      _hzDynYP.yaw=d.yaw; _hzDynYP.pitch=bankPitch;
      r.add('bevel',d.x,y,d.z,.80,.32,.62,0x271e2c,20,_hzDynYP);
      r.add('orb',d.x,y-.18,d.z,.34,.28,.32,0xff2846,3,_hzDyn);
      if (!lite) {
        // Armored dorsal fin + glowing crimson threat ring beneath scanner eye!
        r.add('bevel',d.x,y+.22,d.z,.18,.14,.44,0x3c2c44,4,_hzDynYP);
        _hzDynLabel.label=(now*2.2+d.id*.3)%1;
        r.add('ripple',d.x,y-.32,d.z,.85,.03,.85,0xff2846,12,_hzDynLabel);
      }
      // 4 angled quad-rotor arms with spinning rotor blades!
      const bladeSpin=now*34+d.id*1.7;
      for (let rxS=-1;rxS<=1;rxS+=2) for (let rzS=-1;rzS<=1;rzS+=2) {
        const lx=rxS*.52, lz=rzS*.38;
        const px=d.x+lx*cy+lz*sy, pz=d.z-lx*sy+lz*cy;
        _hzA[0]=d.x; _hzA[1]=y; _hzA[2]=d.z;
        _hzB[0]=px; _hzB[1]=y+.06; _hzB[2]=pz;
        r.beam(_hzA,_hzB,.07,.07,0x3c2c44,4,_hzDyn);
        r.add('cylinder',px,y+.13,pz,.40,.045,.40,0xd83258,3,_hzDyn);
        if (!lite) {
          _hzDynYaw.yaw=bladeSpin*(rxS*rzS);
          r.add('box',px,y+.16,pz,.42,.018,.055,0xf0dce4,4,_hzDynYaw);
        }
      }
      if (now-(d.flash??-9)<.16) {
        r.add('orb',d.x,y-.24,d.z,.46,.46,.46,0xffd088,3,_hzDyn);
      }
    }

    // 3. Heavy Torrential Downpour Streaks & Ripples + Boss Crimson-Storm Black Ink Rain
    const bossActive=!!this.battle.boss?.active && !this.battle.timeless;
    if (this.rain.active && zone===0) {
      const count=r.ultralite?52:r.lite?108:172;
      for (let i=0;i<count;i++) {
        const f1=RAIN_SEEDS[i*2], f2=RAIN_SEEDS[i*2+1];
        const span=i<80?20:42;
        const rx=viewX+(f1-.5)*span, rz=viewZ+(f2-.5)*span;
        const cycle=(now*(3.2+(i%3)*.35)+f1*3.7+f2*5.1)%1;
        const ry=18*(1-cycle);
        if (hasFrustum && !r.inFrustum(rx,ry,rz,2.4)) continue;
        r.add('box',rx+.17,ry+1.225,rz+.07,.034,2.477438,.030,0xbcdcf0,3,_hzRainOpts);
        if (cycle>.90 && (i&1)===0) {
          _hzDynLabel.label=(cycle-.90)/.10;
          r.add('ripple',rx,.04,rz,1.2,.02,1.2,0x9fd2f0,12,_hzDynLabel);
        }
      }
    }
    if (bossActive && zone===0) {
      const bCount=r.ultralite?20:r.lite?38:56;
      for (let i=0;i<bCount;i++) {
        const f1=RAIN_SEEDS[i*2], f2=RAIN_SEEDS[i*2+1];
        const rx=viewX+(f1-.5)*38, rz=viewZ+(f2-.5)*38;
        const cycle=(now*3.45+f1*4.3+f2*6.7)%1;
        const ry=18*(1-cycle);
        if (hasFrustum && !r.inFrustum(rx,ry,rz,2.0)) continue;
        r.add('box',rx-.06,ry+.875,rz+.04,.036,1.755933,.032,0x0b070e,2,_hzBossRainOpts);
        if (cycle>.90) {
          _hzDynLabel.label=(cycle-.90)/.10;
          r.add('ripple',rx,.05,rz,1.15,.03,1.15,0x1a0b15,12,_hzDynLabel);
        }
      }
    }

    // 4. Tsunami Wave Wall & Surging Spray Crest (surface)
    if (this.tsunami.phase==='wave' && zone===0) {
      const ts=this.tsunami, h=ts.height, x=ts.x;
      _hzDynCurtain.label=.82;
      r.add('curtain',x+ts.width*.45,h*.5,0,76,h,1,0x1f8fb8,16,_hzDynCurtain);
      _hzDynCurtain.label=.65;
      r.add('curtain',x,h*.48,0,76,h*.95,1,0x146c94,16,_hzDynCurtain);
      r.add('box',x-ts.width*.1,h*.36,0,ts.width*.72,h*.72,72,0x177ba4,9,_hzDyn);
      for (let z=-32;z<=32;z+=8) {
        const crest=Math.sin(now*10+z)*.32;
        r.add('orb',x+ts.width*.38,h+.12+crest,z,2.9,1.55,9.2,0xd8f3ff,3,_hzDyn);
        if (!lite) {
          const sp=(now*3.5+z*.13)%1;
          r.add('orb',x+ts.width*.52+sp*2.4,h*.85+Math.sin(sp*Math.PI)*1.1,z+Math.sin(now*6+z)*1.5,.65*(1-sp),.65*(1-sp),.65*(1-sp),0xeaf8ff,3,_hzDyn);
        }
      }
    }

    // 5. Underground Flood Water Surface & Accumulated Boss Black Ink (B1)
    if (this.underFlood.active && this.underFlood.depth>.05 && zone===1) {
      const wy=UNDER_Y+this.underFlood.depth, cx=ZONES[1].x;
      r.add('box',cx,UNDER_Y+this.underFlood.depth*.5,0,126,this.underFlood.depth,90,0x166d91,9,_hzDyn);
      const step=r.lite?16:11;
      for (let ox=-48;ox<=48;ox+=step) for (let oz=-32;oz<=32;oz+=step) {
        if (hasFrustum && !r.inFrustum(cx+ox,wy,oz,4.8)) continue;
        _hzDynLabel.label=(now*.6+(ox+oz)*.03)%1;
        r.add('ripple',cx+ox,wy+.04,oz,4.5,.03,4.5,0x8ed8f2,12,_hzDynLabel);
      }
    }
    const underBossDepth=this.battle.fluid?.underBossDepth??0;
    if (zone===1 && (underBossDepth>.012 || bossActive)) {
      const cx=ZONES[1].x;
      if (underBossDepth>.012) {
        const d=underBossDepth, wy=UNDER_Y+d;
        r.add('box',cx,UNDER_Y+d*.5,0,124,d,88,0x0b080e,9,_hzDyn);
        const step=r.lite?18:13;
        for (let ox=-46;ox<=46;ox+=step) for (let oz=-30;oz<=30;oz+=step) {
          if (hasFrustum && !r.inFrustum(cx+ox,wy,oz,4.5)) continue;
          _hzDynLabel.label=(now*.42+(ox-oz)*.04)%1;
          r.add('ripple',cx+ox,wy+.03,oz,3.6,.025,3.6,0x451226,12,_hzDynLabel);
        }
      }
      if (bossActive || (this.battle.fluid?.lastPercolationRate??0)>.05) {
        for (const dr of STORM_DRAINS) {
          if (hasFrustum && !r.inFrustum(dr.ux,UNDER_Y+3,dr.uz,3.5)) continue;
          _hzA[0]=dr.ux; _hzA[1]=UNDER_Y+underBossDepth; _hzA[2]=dr.uz;
          _hzB[0]=dr.ux; _hzB[1]=UNDER_Y+6.4; _hzB[2]=dr.uz;
          r.beam(_hzA,_hzB,.09,.12,0x0c0810,2,_hzDyn);
          _hzDynLabel.label=(now*1.8+dr.ux) % 1;
          r.add('ripple',dr.ux,UNDER_Y+Math.max(.04,underBossDepth+.03),dr.uz,2.4,.03,2.4,0x350d1d,12,_hzDynLabel);
        }
      }
    }

    // 6. Stage-Rampaging Armored Runaway Express Boss
    if (this.trainBoss.active && sameLevel(this.trainBoss.x,viewX)) {
      const tb=this.trainBoss;
      _hzDynLabel.label=(now*2.2)%1;
      r.add('ripple',tb.x,tb.y+.35,tb.z,14,.06,14,0xff3040,12,_hzDynLabel);
      if (tb.stageMode) {
        const yw=(tb.yaw??0)-Math.PI*.5, fx=Math.sin(tb.yaw??0), fz=-Math.cos(tb.yaw??0);
        _hzDynYP.yaw=yw; _hzDynYP.pitch=-(tb.pitch??0);
        r.add('box',tb.x,tb.y+1.82,tb.z,16.2,3.15,2.92,0x2a1d24,20,_hzDynYP);
        r.add('bevel',tb.x,tb.y+3.36,tb.z,15.6,.52,2.56,0x3d222b,4,_hzDynYP);
        r.add('box',tb.x,tb.y+2.05,tb.z,16.26,.40,2.98,0xff2838,3,_hzDynYP);
        r.add('box',tb.x,tb.y+2.36,tb.z,13.2,.84,3.00,0xff7855,8,_hzDynYP);
        r.add('box',tb.x,tb.y+.42,tb.z,15.4,.58,2.30,0x191c22,4,_hzDynYP);
        // Reinforced Cowcatcher Plow & Headlights!
        r.add('bevel',tb.x+fx*8.45,tb.y+1.05,tb.z+fz*8.45,1.25,1.85,3.25,0x495358,4,_hzDynYP);
        r.add('orb',tb.x+fx*8.6,tb.y+2.05,tb.z+fz*8.6,.75,.65,.95,0xffea8a,3,_hzDyn);
        // Roof Missile/Canon Turret
        r.add('cylinder',tb.x,tb.y+3.82,tb.z,1.35,.55,1.35,0x382a33,4,_hzDyn);
        r.add('orb',tb.x,tb.y+4.18,tb.z,.62,.62,.62,0xff3048,3,_hzDyn);
      }
    }

    // 7. Apartment Rooftop Attack Helicopter & Indiscriminate Multi-Missiles
    if (zone===0 && this.heli.active) {
      const h=this.heli;
      _hzDynYP.yaw=Math.PI-h.yaw; _hzDynYP.pitch=h.pitch??.14;
      r.add('bevel',h.x,h.y,h.z,2.1,1.55,5.8,0x272a30,20,_hzDynYP);
      r.add('bevel',h.x,h.y+.12,h.z,2.45,.88,3.2,0x373c44,4,_hzDynYP);
      const fx=Math.sin(h.yaw), fz=-Math.cos(h.yaw), rx=Math.cos(h.yaw), rz=Math.sin(h.yaw);
      r.add('orb',h.x+fx*1.9,h.y-.08,h.z+fz*1.9,1.35,.95,1.65,0x7ac8e0,8,_hzDyn);
      // Tail boom & vertical stabilizer
      _hzA[0]=h.x-fx*2.2; _hzA[1]=h.y+.15; _hzA[2]=h.z-fz*2.2;
      _hzB[0]=h.x-fx*5.6; _hzB[1]=h.y+.52; _hzB[2]=h.z-fz*5.6;
      r.beam(_hzA,_hzB,.28,.14,0x2c3038,4,_hzDyn);
      r.add('box',_hzB[0],_hzB[1]+.42,_hzB[2],.20,1.05,.72,0xff3448,2,_hzDynYP);
      // Twin stub wings & 6-tube missile pods + crimson nose searchlight
      for (const s of [-1,1]) {
        r.add('box',h.x+rx*s*1.55,h.y-.18,h.z+rz*s*1.55,1.55,.20,.95,0x30353e,4,_hzDynYP);
        r.add('cylinder',h.x+rx*s*2.05,h.y-.35,h.z+rz*s*2.05,.52,1.15,.52,0x494f58,4,_hzDynYP);
        r.add('orb',h.x+rx*s*2.05+fx*.65,h.y-.35,h.z+rz*s*2.05+fz*.65,.28,.28,.28,0xff3b30,3,_hzDyn);
      }
      r.add('orb',h.x+fx*2.35,h.y-.72,h.z+fz*2.35,.48,.48,.48,0xff4458,3,_hzDyn);
      // Spinning 4-blade main rotor + tail rotor
      _hzDynYaw.yaw=h.rotor;
      r.add('cylinder',h.x,h.y+.92,h.z,.26,.45,.26,0x1d2026,4,_hzDyn);
      r.add('box',h.x,h.y+1.16,h.z,8.2,.05,.38,0xdbe2e0,4,_hzDynYaw);
      r.add('box',h.x,h.y+1.16,h.z,.38,.05,8.2,0xdbe2e0,4,_hzDynYaw);
      _hzDynYaw.yaw=h.rotor*2.4;
      r.add('box',_hzB[0],_hzB[1]+.42,_hzB[2],.12,1.55,.22,0xff5058,3,_hzDynYaw);
    }
    if (zone===0 && this.missiles.length) {
      for (let i=0;i<this.missiles.length;i++) {
        const m=this.missiles[i];
        const inv=1/Math.max(.1,Math.hypot(m.vx,m.vy,m.vz));
        _hzA[0]=m.x-m.vx*inv*1.1; _hzA[1]=m.y-m.vy*inv*1.1; _hzA[2]=m.z-m.vz*inv*1.1;
        _hzB[0]=m.x; _hzB[1]=m.y; _hzB[2]=m.z;
        r.beam(_hzA,_hzB,.14,.11,0xe2e8e4,4,_hzDyn);
        r.add('orb',m.x,m.y,m.z,.28,.28,.28,0xff4828,3,_hzDyn);
        r.add('orb',_hzA[0],_hzA[1],_hzA[2],.26,.26,.26,0xffd078,3,_hzDyn);
      }
    }

    // 8. God of Destruction Goat (破壊神ゴート)
    if (zone===0 && this.goat.active) this.drawGoat(r,now);
  }
}

const _hzDyn={dynamic:true};
const _hzDynYaw={dynamic:true,yaw:0};
const _hzDynYP={dynamic:true,yaw:0,pitch:0};
const _hzDynLabel={dynamic:true,label:0};
const _hzDynCurtain={dynamic:true,yaw:Math.PI/2,label:.82};
function _makeBeamOpts(dx,dy,dz) {
  const len=Math.sqrt(dx*dx+dy*dy+dz*dz), invL=1/len;
  const yx=dx*invL, yy=dy*invL, yz=dz*invL;
  const l=Math.sqrt(yy*yy+yx*yx), inv=1/l;
  const xx=yy*inv, xy=-yx*inv, xz=0;
  return {dynamic:true,basis:[[xx,xy,xz],[yx,yy,yz],[xy*yz-xz*yy,xz*yx-xx*yz,xx*yy-xy*yx]]};
}
const _hzRainOpts=_makeBeamOpts(.34,2.45,.14);
const _hzBossRainOpts=_makeBeamOpts(-.12,1.75,.08);
const _hzA=[0,0,0], _hzB=[0,0,0], _hzC=[0,0,0];
const _hzPts6=[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const _hzPts4=[[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
const RAIN_SEEDS=(()=>{
  const out=new Float32Array(180*2);
  for (let i=0;i<180;i++) {
    const h1=Math.sin(i*12.9898)*43758.5453;
    const h2=Math.sin(i*78.233)*43758.5453;
    out[i*2]=h1-Math.floor(h1);
    out[i*2+1]=h2-Math.floor(h2);
  }
  return out;
})();
