import {TAU,add,clamp,forward,scale,sub,unit} from './render.js';
import {METRO,RAIL,UNDER_Y,ZONES,isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {GOAT_WEAPON,ROGUE_DRONE_WEAPON,SNIPER_WEAPON,TRAIN_BOSS_WEAPON} from './weapons.js';
import {drawTentacle} from './creature-models.js';
import {randomGenerator} from './world.js';

export const SNIPER_FIRST=42, SNIPER_INTERVAL=75, SNIPER_STAY=32, SNIPER_COUNT=4;
export const ROGUE_DRONE_FIRST=58, ROGUE_DRONE_INTERVAL=82, ROGUE_DRONE_STAY=26, ROGUE_DRONE_COUNT=4;
export const RAIN_FIRST=70, RAIN_INTERVAL=95, RAIN_DURATION=22;
export const TSUNAMI_FIRST=112, TSUNAMI_INTERVAL=115, TSUNAMI_WARN=5, TSUNAMI_SPEED=12.5, TSUNAMI_HEIGHT=3.6, TSUNAMI_WIDTH=9.5;
export const UNDER_FLOOD_MAX=2.65, UNDER_FLOOD_HOLD=16;
export const TRAIN_BOSS_FIRST=145, TRAIN_BOSS_INTERVAL=130, TRAIN_BOSS_DURATION=42;
export const GOAT_FIRST=185, GOAT_INTERVAL=165, GOAT_DURATION=65, GOAT_ARMS=8, GOAT_HOVER_Y=4.6, GOAT_REACH=14.5;

function discoverApartmentPerches(world) {
  const north=[], south=[];
  for (const s of world?.solids ?? []) {
    const cx=(s.min[0]+s.max[0])*.5, cz=(s.min[2]+s.max[2])*.5;
    const w=s.max[0]-s.min[0], h=s.max[1]-s.min[1];
    if (Math.abs(cx)>46 || Math.abs(cz)<29 || Math.abs(cz)>44 || h<7 || s.min[1]>3.5 || w<3.5) continue;
    const sign=cz<0?1:-1;
    const front=sign>0?s.max[2]:s.min[2];
    const y=clamp(Math.min(s.max[1]-.4,7.6+(Math.abs(Math.round(cx))%3)*2.2),6.6,12.5);
    const perch={x:cx,y,z:front+sign*.78,yaw:sign>0?Math.PI:0,sign};
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
    {x:-30,y:8.2,z:-30.8,yaw:Math.PI,sign:1},
    {x:-6,y:9.4,z:-30.8,yaw:Math.PI,sign:1},
    {x:22,y:8.2,z:-30.8,yaw:Math.PI,sign:1},
    {x:-20,y:8.4,z:30.8,yaw:0,sign:-1},
    {x:8,y:9.2,z:30.8,yaw:0,sign:-1},
    {x:30,y:8.4,z:30.8,yaw:0,sign:-1}
  ];
}

export class Hazards {
  constructor(battle) {
    this.battle=battle;
    this.rng=randomGenerator((battle.seed ?? 519231)^0x5a3c9e1);
    this.perches=discoverApartmentPerches(battle.world);
    this.snipers=[];
    this.rogueDrones=[];
    this.sniperWave=0;
    this.droneWave=0;
    this.trainBossCount=0;
    this.nextSniper=SNIPER_FIRST;
    this.sniperRetreatAt=0;
    this.nextDrone=ROGUE_DRONE_FIRST;
    this.droneRetreatAt=0;
    this.nextRain=RAIN_FIRST;
    this.rain={active:false,until:0,washTimer:0};
    this.nextTsunami=TSUNAMI_FIRST;
    this.tsunami={phase:'idle',warnUntil:0,x:-64,height:TSUNAMI_HEIGHT,width:TSUNAMI_WIDTH,floodedUnder:false};
    this.underFlood={active:false,phase:'idle',depth:0,maxDepth:UNDER_FLOOD_MAX,timer:0,washTimer:0};
    this.nextTrainBoss=TRAIN_BOSS_FIRST;
    this.trainBoss={active:false,rail:'transit',name:'暴走列車 07',hp:0,maxHp:battle.teamSize===8?3800:2600,until:0,fire:0,x:0,y:0,z:0};
    this.trainHits=new Map();
    this.nextGoat=GOAT_FIRST;
    this.goat={
      active:false,name:'破壊神ゴート',hp:0,maxHp:battle.teamSize===8?18000:12000,phase:1,
      x:0,y:GOAT_HOVER_Y,z:0,yaw:Math.PI,vx:0,vz:0,until:0,nextAttack:0,volley:0,cast:null,
      radius:1.55,height:3.6,team:-1,isGoat:true,isBoss:true,arms:GOAT_ARMS,weapon:GOAT_WEAPON
    };
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
    const list=[];
    for (const s of this.snipers) if (s.active && sameLevel(s.x,atX)) list.push(s);
    for (const d of this.rogueDrones) if (d.active && sameLevel(d.x,atX)) list.push(d);
    if (this.goat.active && sameLevel(this.goat.x,atX)) list.push(this.goat);
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

  // ---- Periodic Rogue Drone Swarm (敵味方無差別ドローン襲撃) ----
  spawnRogueDrones(count=ROGUE_DRONE_COUNT) {
    const b=this.battle;
    this.rogueDrones=[];
    this.droneWave++;
    const spots=[
      {x:-24,z:-8,zone:0},{x:0,z:11,zone:0},{x:26,z:-9,zone:0},
      {x:1280,z:8,zone:1},{x:-12,z:16,zone:0}
    ];
    for (let i=0;i<count;i++) {
      const sp=spots[i%spots.length];
      const floor=b.world.floor(sp.x,sp.z).y;
      const drone={
        id:this.droneWave*10+i,index:i,x:sp.x+(this.rng()-.5)*6,y:floor+2.6,z:sp.z+(this.rng()-.5)*6,
        yaw:this.rng()*TAU,team:-1,isRogueDrone:true,active:true,hp:75,maxHp:75,radius:.58,height:.7,weapon:ROGUE_DRONE_WEAPON,
        name:'暴走ドローン '+String(i+1).padStart(2,'0'),
        fire:.7+i*.3,turn:0,flash:-9,aim:0
      };
      b.hnv1?.mind(drone);
      this.rogueDrones.push(drone);
    }
    this.droneRetreatAt=b.elapsed+ROGUE_DRONE_STAY;
    this.nextDrone=b.elapsed+ROGUE_DRONE_INTERVAL;
    this.announce('⚠ 暴走ドローン群 ×'+this.rogueDrones.length+' 襲来！敵味方関係なく攻撃！',4.8,'drone');
    b.events.unshift({label:'暴走ドローン群 ×'+this.rogueDrones.length+' 襲来',team:-1,until:b.clock+4.2});
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
      b.events.unshift({label:(source?.name ?? '撃墜')+'  ▸  '+drone.name,team:source?.team ?? -1,until:b.clock+3.6});
      b.events.length=Math.min(b.events.length,4);
      if (!this.rogueDrones.some(d=>d.active)) this.announce('暴走ドローン群を全機撃墜！',3.6,'bossDown');
    }
    return lost;
  }

  updateRogueDrones(dt) {
    const b=this.battle;
    if (b.elapsed>=this.nextDrone-1e-6) this.spawnRogueDrones();
    if (this.rogueDrones.length && b.elapsed>=this.droneRetreatAt) {
      for (const d of this.rogueDrones) d.active=false;
      this.rogueDrones=[];
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

  // ---- Rain (豪雨によるインク消失) ----
  startRain(duration=RAIN_DURATION) {
    const b=this.battle;
    this.rain={active:true,until:b.elapsed+duration,washTimer:0};
    this.nextRain=b.elapsed+RAIN_INTERVAL;
    this.announce('☂ 豪雨発生！地上のインクが洗い流される！',4.5);
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
    if (this.rain.washTimer>=.25) {
      this.rain.washTimer-=.25;
      b.paint.wash(ZONES[0].inkMask,.0095);
      // Gradually dissolve exposed surface wall decals in the rain.
      if (b.decals.length) {
        let removed=0;
        b.decals=b.decals.filter(d=>{
          if (zoneOf(d.p[0])===0 && removed<4 && this.rng()<.18) {removed++;return false;}
          return true;
        });
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
      const back=Math.min(prevX,ts.x)-ts.width*.55, front=ts.x+ts.width*.5;
      // Completely wash away surface ink swept by the tsunami wave.
      b.paint.wash(ZONES[0].inkMask,1.0,back,front);
      if (b.decals.length) {
        b.decals=b.decals.filter(d=>!(zoneOf(d.p[0])===0 && d.p[1]<ts.height+.4 && d.p[0]>=back && d.p[0]<=front));
      }
      // Sweep and drown any surface fighter caught below the wave crest.
      const victims=[...b.actors,...b.raiders.live()];
      for (const a of victims) {
        if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==0) continue;
        if (a.x>=ts.x-ts.width*.5 && a.x<=ts.x+ts.width*.5 && a.y<ts.height-.55) {
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
      if (b.decals.length) {
        b.decals=b.decals.filter(d=>!(zoneOf(d.p[0])===1 && d.p[1]<waterY+.2));
      }
    }
    if (uf.depth>.45) {
      const victims=[...b.actors,...b.raiders.live()];
      for (const a of victims) {
        if (a.down>0 || a.ride || a.lift || zoneOf(a.x)!==1) continue;
        if (a.y+1.15<waterY) {
          b.damage(a,70*dt,null,[a.x,a.y+.9,a.z],'drown');
        }
      }
    }
  }

  // ---- Runaway Train Boss (電車の暴走による敵ボス化) ----
  trainBossRail() {
    return this.trainBoss.rail==='metro'?this.battle.metro:this.battle.transit;
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
    const p0=rail.pose();
    this.trainBoss={active:true,rail:railKey,name,hp:maxHp,maxHp,until:b.elapsed+TRAIN_BOSS_DURATION,fire:1.0,
      x:p0.ox,y:p0.y,z:p0.oz};
    this.trainHits.clear();
    this.nextTrainBoss=b.elapsed+TRAIN_BOSS_INTERVAL;
    this.announce('⚠ '+name+' が暴走・敵ボス化！攻撃して鎮圧せよ！',5.0,'boss');
    b.events.unshift({label:'⚠ '+name+' 暴走・ボス化',team:-1,until:b.clock+4.5});
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
      b.burst([tb.x,tb.y+2.2,tb.z],source?.team ?? -1,36,6.5);
      this.announce('✦ '+tb.name+' を鎮圧した！',4.8,'bossDown');
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
    const rail=this.trainBossRail(), pose=rail.pose(), origin=[pose.ox,pose.y,pose.oz];
    tb.x=origin[0]; tb.y=origin[1]; tb.z=origin[2];
    // Crush & knock back any fighter close to the runaway train hull.
    const victims=[...b.actors,...b.raiders.live()];
    let target=null, bestDist=TRAIN_BOSS_WEAPON.range;
    for (const a of victims) {
      if (a.down>0 || a.ride || a.lift || !sameLevel(a.x,origin[0])) continue;
      const local=pose.pose.local([a.x,a.y+.8,a.z]);
      if (Math.abs(local[0])<9.8 && Math.abs(local[2])<2.55 && local[1]>-.6 && local[1]<4.3) {
        const lastHit=this.trainHits.get(a) ?? -99;
        if (b.clock-lastHit>=.85) {
          this.trainHits.set(a,b.clock);
          const side=local[2]>=0?1:-1;
          const push=pose.pose.rotate(0,0,side*2.6);
          b.stepActor(a,push[0],push[2]);
          b.damage(a,95,null,[a.x,a.y+.9,a.z],'trainBoss');
        }
      }
      if (a.shield<=0) {
        const dist=Math.hypot(a.x-origin[0],a.y+.9-(origin[1]+3.1),a.z-origin[2]);
        if (dist<bestDist && dist>3) {bestDist=dist;target=a;}
      }
    }
    tb.fire-=dt;
    if (target && tb.fire<=0) {
      const from=[origin[0],origin[1]+3.55,origin[2]];
      const to=[target.x,target.y+.9,target.z];
      const dir=unit(sub(to,from));
      const shooter={team:-1,name:tb.name,isBoss:true};
      b.shots.push({pos:from,vel:scale(dir,TRAIN_BOSS_WEAPON.speed),actor:shooter,weapon:TRAIN_BOSS_WEAPON,power:1,age:0,
        bend:null,homing:{...TRAIN_BOSS_WEAPON.homing},life:1.4,id:++b.shotSequence});
      b.burst(from,-1,8,3.2);
      tb.fire=TRAIN_BOSS_WEAPON.delay;
    }
  }

  // ---- God of Destruction Goat (破壊神ゴート: 圧倒的体力・浮遊・8本の腕で無差別蹂躙) ----
  spawnGoat(duration=GOAT_DURATION) {
    const b=this.battle, g=this.goat;
    const maxHp=b.teamSize===8?18000:12000;
    Object.assign(g,{
      active:true,hp:maxHp,maxHp,phase:1,
      x:0,y:GOAT_HOVER_Y+2.4,z:-4,yaw:Math.PI,vx:0,vz:0,
      until:b.elapsed+duration,nextAttack:b.clock+1.5,volley:0,cast:null,arms:GOAT_ARMS
    });
    this.nextGoat=b.elapsed+GOAT_INTERVAL;
    b.burst([g.x,g.y,g.z],-1,44,7.5);
    this.announce('⚠ 破壊神ゴート降臨！宙を舞う8本の腕が敵味方関係なく蹂躙する！',5.5,'boss');
    b.events.unshift({label:'⚠ 破壊神ゴート降臨（HP '+maxHp+'）',team:-1,until:b.clock+5.0});
    b.events.length=Math.min(b.events.length,4);
    return g;
  }

  hurtGoat(amount,source=null) {
    const g=this.goat;
    if (!g.active || !(amount>0)) return 0;
    const lost=Math.min(g.hp,amount);
    g.hp-=lost;
    const ratio=g.hp/g.maxHp, nextPhase=ratio<.33?3:ratio<.66?2:1;
    const b=this.battle;
    if (g.hp<=0) {
      g.active=false;
      g.cast=null;
      b.burst([g.x,g.y+1.2,g.z],source?.team ?? -1,56,9.0);
      this.announce('✦ 破壊神ゴートを討伐した！',5.5,'bossDown');
      b.events.unshift({label:(source?.name ?? '討伐')+'  ▸  破壊神ゴート',team:source?.team ?? -1,until:b.clock+5.0});
      b.events.length=Math.min(b.events.length,4);
      if (source && source.team>=0) source.kills++;
    } else if (nextPhase!==g.phase) {
      g.phase=nextPhase;
      this.announce(nextPhase===3?'⚠ 破壊神ゴート【破滅形態】！8本の腕が極限暴走！':'⚠ 破壊神ゴートが激昂した！',4.0,'boss');
    }
    return lost;
  }

  planGoatAttack(targets) {
    const b=this.battle, g=this.goat, phase=g.phase, clock=b.clock;
    const turn=g.volley++;
    const pick=turn%3;
    if (pick===0) {
      // 8-Arm Annihilation Smash: all 8 arms strike up to 8 targets/spots simultaneously!
      const near=targets.filter(a=>Math.hypot(a.x-g.x,a.z-g.z)<=GOAT_REACH+2)
        .sort((a,c)=>b.hnv1?b.hnv1.scoreTarget(g,a,b.hnv1.mind(g).lastTarget)-b.hnv1.scoreTarget(g,c,b.hnv1.mind(g).lastTarget):
          Math.hypot(a.x-g.x,a.z-g.z)-Math.hypot(c.x-g.x,c.z-g.z));
      const points=[];
      for (let i=0;i<GOAT_ARMS;i++) {
        const t=near[i];
        let px, pz;
        if (t) {
          const pred=b.hnv1?b.hnv1.predictAim(g,t,GOAT_WEAPON):null;
          px=clamp(pred?pred[0]:t.x+(t.vx??0)*.22,-51,51);
          pz=clamp(pred?pred[2]:t.z+(t.vz??0)*.22,-32,32);
        } else {
          const ang=i*TAU/GOAT_ARMS+g.yaw, rad=5.5+(i%2)*4.5;
          px=clamp(g.x+Math.cos(ang)*rad,-51,51);
          pz=clamp(g.z+Math.sin(ang)*rad,-32,32);
        }
        const py=b.world.floor(px,pz).y;
        points.push([px,py,pz]);
      }
      g.cast={kind:'smash',x:g.x,z:g.z,radius:GOAT_REACH,start:clock,at:clock+.55,end:clock+1.15,done:false,points};
    } else if (pick===1) {
      // 360-degree 8-Arm Void Whirlwind Sweep!
      g.cast={kind:'whirl',x:g.x,z:g.z,start:clock,at:clock+.48,end:clock+1.22,done:false,radius:12.5+phase*1.1,yaw:g.yaw};
    } else {
      // 8-Arm Ruin Barrage: launches 8 homing destruction orbs from all 8 palms!
      g.cast={kind:'barrage',x:g.x,z:g.z,radius:10,start:clock,at:clock+.42,end:clock+.95,done:false,yaw:g.yaw};
    }
    g.nextAttack=clock+(phase===3?1.35:phase===2?1.8:2.3);
  }

  resolveGoatCast(targets) {
    const b=this.battle, g=this.goat, cast=g.cast;
    cast.done=true;
    if (cast.kind==='smash') {
      const dmg=125+g.phase*15;
      for (const [px,py,pz] of cast.points) {
        b.burst([px,py+.35,pz],-1,12,4.4);
        b.abilities.rings.push({x:px,y:py+.06,z:pz,r:3.4,team:1,until:b.clock+.55});
        b.stage.damageArea(b,g,px,py,pz,3.2,dmg*.8);
        for (const a of targets) {
          const d=Math.hypot(a.x-px,a.z-pz);
          if (d>3.35 || Math.abs(a.y-py)>2.9) continue;
          const nx=(a.x-g.x)/Math.max(.3,Math.hypot(a.x-g.x,a.z-g.z));
          const nz=(a.z-g.z)/Math.max(.3,Math.hypot(a.x-g.x,a.z-g.z));
          b.stepActor(a,nx*2.4,nz*2.4);
          b.damage(a,dmg,g,[a.x,a.y+.9,a.z],'goat');
        }
      }
    } else if (cast.kind==='whirl') {
      const rad=cast.radius, dmg=115+g.phase*16;
      b.abilities.rings.push({x:g.x,y:b.world.floor(g.x,g.z).y+.08,z:g.z,r:rad,team:1,until:b.clock+.65});
      b.stage.damageArea(b,g,g.x,b.world.floor(g.x,g.z).y,g.z,rad*.75,dmg*.7);
      for (const a of targets) {
        const dx=a.x-g.x, dz=a.z-g.z, d=Math.hypot(dx,dz);
        if (d>rad) continue;
        const inv=1/Math.max(.3,d);
        b.stepActor(a,dx*inv*3.1,dz*inv*3.1);
        b.damage(a,dmg,g,[a.x,a.y+.9,a.z],'goat');
      }
    } else if (cast.kind==='barrage') {
      const sorted=targets.slice().sort((a,c)=>b.hnv1
        ?b.hnv1.scoreTarget(g,a,b.hnv1.mind(g).lastTarget)-b.hnv1.scoreTarget(g,c,b.hnv1.mind(g).lastTarget)
        :Math.hypot(a.x-g.x,a.z-g.z)-Math.hypot(c.x-g.x,c.z-g.z));
      for (let i=0;i<GOAT_ARMS;i++) {
        const ang=g.yaw+i*TAU/GOAT_ARMS;
        const from=[g.x+Math.cos(ang)*2.3,g.y+1.4+(i%2)*.55,g.z+Math.sin(ang)*2.3];
        const tgt=sorted.length?sorted[i%sorted.length]:null;
        const to=tgt?(b.hnv1?b.hnv1.predictAim(g,tgt,GOAT_WEAPON):[tgt.x,tgt.y+.9,tgt.z])
          :[g.x+Math.cos(ang)*20,b.world.floor(g.x,g.z).y+.6,g.z+Math.sin(ang)*20];
        const dir=unit(sub(to,from));
        b.shots.push({pos:from,vel:scale(dir,GOAT_WEAPON.speed),actor:g,weapon:GOAT_WEAPON,power:1,age:0,
          bend:null,homing:{...GOAT_WEAPON.homing},life:1.75,id:++b.shotSequence});
      }
      b.burst([g.x,g.y+1.5,g.z],-1,20,5.2);
    }
  }

  updateGoat(dt) {
    const b=this.battle, g=this.goat;
    if (!g.active && b.elapsed>=this.nextGoat-1e-6) this.spawnGoat();
    if (!g.active) return;
    if (b.elapsed>=g.until) {
      g.active=false;
      g.cast=null;
      this.announce('破壊神ゴートは虚空へ帰還した…',4.2);
      return;
    }
    const targets=[...b.actors,...b.raiders.live()].filter(a=>a.down<=0 && !a.ride && !a.lift && zoneOf(a.x)===0);
    // HNV1 Apex Deity Intelligence: hunts clustered fighters & active threats of either team!
    let focus=b.hnv1?b.hnv1.pickApexTarget(g,targets,dt):null;
    if (!focus) {
      let best=Infinity;
      for (const a of targets) {
        const d=Math.hypot(a.x-g.x,a.z-g.z);
        if (d<best) {best=d;focus=a;}
      }
    }
    const speed=g.phase===3?8.6:g.phase===2?7.2:5.8;
    if (focus) {
      const dx=focus.x-g.x, dz=focus.z-g.z, d=Math.max(.01,Math.hypot(dx,dz));
      g.yaw=Math.atan2(dx,-dz);
      if (d>6.5) {
        g.vx=dx/d*speed;
        g.vz=dz/d*speed;
      } else {
        // Orbit menacingly overhead while tearing apart nearby fighters.
        g.vx=-dz/d*speed*.65;
        g.vz=dx/d*speed*.65;
      }
    } else {
      g.yaw+=dt*.8;
      g.vx=Math.sin(g.yaw)*speed*.45;
      g.vz=-Math.cos(g.yaw)*speed*.45;
    }
    g.x=clamp(g.x+g.vx*dt,-48,48);
    g.z=clamp(g.z+g.vz*dt,-29,29);
    const floor=b.world.floor(g.x,g.z).y;
    const hoverTarget=floor+GOAT_HOVER_Y+Math.sin(b.clock*2.6)*.55;
    g.y=g.y+(hoverTarget-g.y)*clamp(dt*4.2,0,1);
    if (g.cast) {
      if (!g.cast.done && b.clock>=g.cast.at) this.resolveGoatCast(targets);
      if (b.clock>=g.cast.end) g.cast=null;
    } else if (b.clock>=g.nextAttack && targets.length) {
      this.planGoatAttack(targets);
    }
  }

  update(dt) {
    this.updateSnipers(dt);
    this.updateRogueDrones(dt);
    this.updateRain(dt);
    this.updateTsunamiAndFlood(dt);
    this.updateTrainBoss(dt);
    this.updateGoat(dt);
  }

  // ---- Serialization for Cloudflare frames and checkpoints ----
  snapshot(zone,mergeStairs=false) {
    const near=x=>{const l=zoneOf(x); return l===zone || mergeStairs && l<2;};
    const g=this.goat;
    return {
      alert:this.alert,alertUntil:this.alertUntil,
      rain:this.rain.active,
      tsunami:this.tsunami.phase==='idle'?null:{phase:this.tsunami.phase,x:Math.round(this.tsunami.x*100)/100,height:this.tsunami.height,width:this.tsunami.width},
      underFlood:this.underFlood.active?{phase:this.underFlood.phase,depth:Math.round(this.underFlood.depth*100)/100}:null,
      trainBoss:this.trainBoss.active?{active:true,rail:this.trainBoss.rail,name:this.trainBoss.name,
        hp:Math.round(this.trainBoss.hp*100)/100,maxHp:this.trainBoss.maxHp,
        x:Math.round(this.trainBoss.x*100)/100,y:Math.round(this.trainBoss.y*100)/100,z:Math.round(this.trainBoss.z*100)/100}:null,
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
  }

  applySnapshot(data) {
    if (!data) return;
    this.alert=data.alert??'';
    this.alertUntil=data.alertUntil??0;
    this.rain.active=!!data.rain;
    this.tsunami=data.tsunami?{...this.tsunami,...data.tsunami}:{...this.tsunami,phase:'idle'};
    this.underFlood=data.underFlood?{...this.underFlood,active:true,...data.underFlood}:{...this.underFlood,active:false,phase:'idle',depth:0};
    this.trainBoss=data.trainBoss?{...this.trainBoss,...data.trainBoss}:{...this.trainBoss,active:false};
    this.goat=data.goat?{...this.goat,...data.goat}:{...this.goat,active:false,cast:null};
    this.snipers=data.snipers??[];
    this.rogueDrones=data.rogueDrones??[];
  }

  checkpoint() {
    const {weapon:_gw,...goatData}=this.goat;
    return {
      seed:this.rng.state(),sniperWave:this.sniperWave,droneWave:this.droneWave,trainBossCount:this.trainBossCount,
      nextSniper:this.nextSniper,sniperRetreatAt:this.sniperRetreatAt,
      nextDrone:this.nextDrone,droneRetreatAt:this.droneRetreatAt,
      nextRain:this.nextRain,rain:{...this.rain},
      nextTsunami:this.nextTsunami,tsunami:{...this.tsunami},
      underFlood:{...this.underFlood},
      nextTrainBoss:this.nextTrainBoss,trainBoss:{...this.trainBoss},
      nextGoat:this.nextGoat,goat:structuredClone(goatData),
      alert:this.alert,alertUntil:this.alertUntil,
      snipers:this.snipers.map(({weapon:_w,...s})=>structuredClone(s)),
      rogueDrones:this.rogueDrones.map(({weapon:_w,...d})=>structuredClone(d))
    };
  }

  restoreCheckpoint(data) {
    if (!data) return;
    const b=this.battle;
    if (Number.isInteger(data.seed)) this.rng=randomGenerator(data.seed);
    for (const k of ['sniperWave','droneWave','trainBossCount','nextSniper','sniperRetreatAt','nextDrone','droneRetreatAt',
      'nextRain','nextTsunami','nextTrainBoss','nextGoat','alert','alertUntil']) {
      if (data[k]!==undefined) this[k]=data[k];
    }
    if (data.rain) this.rain={...data.rain};
    if (data.tsunami) this.tsunami={...data.tsunami};
    if (data.underFlood) this.underFlood={...data.underFlood};
    if (data.trainBoss) this.trainBoss={...data.trainBoss};
    if (data.goat) this.goat={...this.goat,...structuredClone(data.goat),weapon:GOAT_WEAPON};
    this.snipers=(data.snipers??[]).map(s=>{const copy={...structuredClone(s),weapon:SNIPER_WEAPON};b.hnv1?.mind(copy);return copy;});
    this.rogueDrones=(data.rogueDrones??[]).map(d=>{const copy={...structuredClone(d),weapon:ROGUE_DRONE_WEAPON};b.hnv1?.mind(copy);return copy;});
    b.hnv1?.mind(this.goat);
    this.trainHits.clear();
  }

  drawGoat(r,now) {
    const g=this.goat;
    if (!g.active) return;
    const yaw=Math.PI-g.yaw, cy=Math.cos(yaw), sy=Math.sin(yaw);
    const at=(lx,ly,lz)=>[g.x+lx*cy+lz*sy,g.y+ly,g.z-lx*sy+lz*cy];
    const dark=0x1c1424, armor=0x2d1d38, gold=0xe5b84b, crimson=0xff2442;
    const floor=this.battle.world.floor(g.x,g.z).y;
    // Ominous levitation shadow & glowing sigil directly on the ground underneath
    r.add('ripple',g.x,floor+.06,g.z,6.2+Math.sin(now*6)*.6,.04,6.2+Math.sin(now*6)*.6,crimson,12,{dynamic:true,label:(now*.8)%1});
    // Floating obsidian torso, divine mantle, and glowing core
    r.add('bevel',g.x,g.y+1.45,g.z,1.95,2.2,1.35,dark,4,{dynamic:true,yaw});
    r.add('taper',g.x,g.y+.15,g.z,1.75,1.8,1.25,armor,4,{dynamic:true,yaw});
    r.add('orb',...at(0,1.65,.68),.68,.88,.34,crimson,3,{dynamic:true,yaw});
    r.add('bevel',...at(0,2.35,0),2.2,.36,1.45,gold,4,{dynamic:true,yaw});
    // Horned Goat Deity Head & Blazing Crimson Eyes
    r.add('orb',...at(0,3.15,.10),1.15,1.15,1.35,0xefe7d6,4,{dynamic:true,yaw});
    r.add('bevel',...at(0,2.85,.68),.58,.46,.65,0xdcd2bd,4,{dynamic:true,yaw});
    for (const sign of [-1,1]) {
      r.add('orb',...at(sign*.34,3.26,.65),.28,.16,.18,crimson,3,{dynamic:true,yaw});
      // Sweeping curved twin goat horns
      const h0=at(sign*.38,3.62,.05), h1=at(sign*.95,4.28,-.35), h2=at(sign*1.28,4.05,-1.15);
      r.beam(h0,h1,.26,.20,gold,4,{dynamic:true});
      r.beam(h1,h2,.19,.10,0x452b18,4,{dynamic:true});
    }
    // Floating golden-crimson halo ring orbiting behind back
    for (let i=0;i<8;i++) {
      const a=now*1.8+i*TAU/8;
      r.add('orb',...at(Math.cos(a)*2.6,2.1+Math.sin(a)*2.6,-.85),.32,.32,.32,i%2?gold:crimson,3,{dynamic:true});
    }
    // 8 Articulated Divine Arms radiating in 4 pairs around Goat!
    const cast=g.cast, links=r.lite?3:5;
    for (let i=0;i<GOAT_ARMS;i++) {
      const side=i%2===0?-1:1, tier=Math.floor(i/2);
      const shoulder=at(side*(1.05+tier*.14),2.35-tier*.45,-.12);
      let tip;
      if (cast?.kind==='smash' && cast.points?.[i]) {
        const p=cast.points[i];
        const prog=clamp((now-cast.start)/Math.max(.05,cast.at-cast.start),0,1);
        const strike=now>=cast.at?1:prog*.55;
        tip=[shoulder[0]+(p[0]-shoulder[0])*strike,shoulder[1]+(p[1]+.35-shoulder[1])*strike,shoulder[2]+(p[2]-shoulder[2])*strike];
        if (!cast.done) r.add('hazard',p[0],p[1]+.05,p[2],6.6,1,6.6,crimson,24,{dynamic:true,label:prog});
      } else if (cast?.kind==='whirl') {
        const spin=now*11+i*TAU/GOAT_ARMS, reach=10.5;
        tip=[g.x+Math.cos(spin)*reach,g.y+.6,g.z+Math.sin(spin)*reach];
      } else {
        const wave=now*3.4+i*.85;
        const spread=(1.6+tier*.38)*Math.PI/8;
        const lx=side*(2.6+Math.sin(wave)*.55+tier*.32);
        const ly=2.8-tier*.65+Math.cos(wave*1.3)*.45;
        const lz=1.45+Math.sin(wave*.8+spread)*.75;
        tip=at(lx,ly,lz);
      }
      const pts=[shoulder];
      for (let j=1;j<links;j++) {
        const t=j/links, arch=Math.sin(t*Math.PI)*(1.25+(i%2)*.4);
        pts.push([
          shoulder[0]+(tip[0]-shoulder[0])*t+side*cy*arch*.35,
          shoulder[1]+(tip[1]-shoulder[1])*t+arch*.85,
          shoulder[2]+(tip[2]-shoulder[2])*t-side*sy*arch*.35
        ]);
      }
      pts.push(tip);
      drawTentacle(r,pts,.36,dark,gold);
      r.add('orb',tip[0],tip[1],tip[2],.55,.55,.55,cast?crimson:gold,3,{dynamic:true});
    }
  }

  // ---- 3D Rendering ----
  draw(r,viewX,viewZ) {
    const now=this.battle.clock+(this.battle.impactAgeOffset??0);
    const zone=zoneOf(viewX);
    // 1. Apartment Snipers + Laser Sights
    if (zone===0) {
      for (const s of this.snipers) {
        if (!s.active) continue;
        const yaw=Math.PI-s.yaw;
        r.add('bevel',s.x,s.y+.52,s.z,.58,.82,.42,0x2a222d,4,{dynamic:true,yaw});
        r.add('orb',s.x,s.y+1.26,s.z,.48,.48,.48,0x342838,4,{dynamic:true,yaw});
        // Glowing red sniper visor
        const [fx,,fz]=forward(s.yaw);
        r.add('orb',s.x+fx*.20,s.y+1.28,s.z+fz*.20,.26,.14,.16,0xff2438,3,{dynamic:true,yaw});
        // Long sniper rifle
        const muzzle=[s.x+fx*1.15,s.y+1.18+Math.sin(s.pitch)*.8,s.z+fz*1.15];
        r.beam([s.x+fx*.15,s.y+1.16,s.z+fz*.15],muzzle,.09,.09,0x1d2529,4,{dynamic:true});
        // Laser sight telegraph when aiming at a fighter
        if (s.targetPos && s.aim>.08) {
          const pulse=.025+.025*Math.sin(now*28);
          r.beam(muzzle,s.targetPos,pulse,pulse,0xff2438,3,{dynamic:true});
        }
        if (now-(s.flash??-9)<.15) {
          r.add('orb',muzzle[0],muzzle[1],muzzle[2],.42,.42,.42,0xffb060,3,{dynamic:true});
        }
      }
    }
    // 2. Hostile Rogue Drones
    for (const d of this.rogueDrones) {
      if (!d.active || !sameLevel(d.x,viewX)) continue;
      const bob=Math.sin(now*9+d.id)*.11, y=d.y+bob;
      r.add('bevel',d.x,y,d.z,.76,.32,.58,0x271e2c,4,{dynamic:true,yaw:d.yaw});
      r.add('orb',d.x,y-.17,d.z,.33,.28,.31,0xff2846,3,{dynamic:true});
      for (const side of [-1,1]) {
        const rx=d.x+Math.cos(d.yaw)*side*.54, rz=d.z+Math.sin(d.yaw)*side*.54;
        r.beam([d.x,y,d.z],[rx,y,rz],.08,.09,0x3c2c44,4,{dynamic:true});
        r.add('cylinder',rx,y+.12,rz,.42,.06,.42,0xd83258,3,{dynamic:true});
      }
      if (now-(d.flash??-9)<.16) {
        r.add('orb',d.x,y-.22,d.z,.42,.42,.42,0xffd088,3,{dynamic:true});
      }
    }
    // 3. Rain Streaks & Ripples (surface only)
    if (this.rain.active && zone===0) {
      const count=r.ultra?18:r.lite?32:56;
      for (let i=0;i<count;i++) {
        const h1=Math.sin(i*12.9898)*43758.5453, f1=h1-Math.floor(h1);
        const h2=Math.sin(i*78.233)*43758.5453, f2=h2-Math.floor(h2);
        const rx=viewX+(f1-.5)*34, rz=viewZ+(f2-.5)*34;
        const cycle=(now*2.8+f1*3.7+f2*5.1)%1;
        const ry=16*(1-cycle);
        r.beam([rx,ry,rz],[rx+.18,ry+1.45,rz],.024,.024,0x9fd2f0,3,{dynamic:true});
        if (cycle>.92) r.add('ripple',rx,.04,rz,.95,.02,.95,0x8cc9ec,12,{dynamic:true,label:(cycle-.92)/.08});
      }
    }
    // 4. Tsunami Wave Wall (surface)
    if (this.tsunami.phase==='wave' && zone===0) {
      const ts=this.tsunami, h=ts.height, x=ts.x;
      // Main translucent rushing wall of water
      r.add('curtain',x+ts.width*.45,h*.5,0,76,h,1,0x1f8fb8,16,{dynamic:true,yaw:Math.PI/2,label:.82});
      r.add('curtain',x,h*.48,0,76,h*.95,1,0x146c94,16,{dynamic:true,yaw:Math.PI/2,label:.65});
      r.add('box',x-ts.width*.1,h*.36,0,ts.width*.72,h*.72,72,0x177ba4,9,{dynamic:true});
      // Foaming crest along top of wave
      for (let z=-32;z<=32;z+=8) {
        const crest=Math.sin(now*10+z)*.28;
        r.add('orb',x+ts.width*.38,h+.1+crest,z,2.8,1.5,9.2,0xd8f3ff,3,{dynamic:true});
      }
    }
    // 5. Underground Flood Water Surface (B1)
    if (this.underFlood.active && this.underFlood.depth>.05 && zone===1) {
      const wy=UNDER_Y+this.underFlood.depth, cx=ZONES[1].x;
      r.add('box',cx,UNDER_Y+this.underFlood.depth*.5,0,126,this.underFlood.depth,90,0x166d91,9,{dynamic:true});
      // Shimmering water surface ripples
      const step=r.lite?16:11;
      for (let ox=-48;ox<=48;ox+=step) for (let oz=-32;oz<=32;oz+=step) {
        const phase=(now*.6+(ox+oz)*.03)%1;
        r.add('ripple',cx+ox,wy+.04,oz,4.5,.03,4.5,0x8ed8f2,12,{dynamic:true,label:phase});
      }
    }
    // 6. Runaway Train Boss Aura
    if (this.trainBoss.active && sameLevel(this.trainBoss.x,viewX)) {
      const pulse=(now*2.2)%1;
      r.add('ripple',this.trainBoss.x,this.trainBoss.y+.35,this.trainBoss.z,14,.06,14,0xff3040,12,{dynamic:true,label:pulse});
    }
    // 7. God of Destruction Goat (破壊神ゴート)
    if (zone===0 && this.goat.active) this.drawGoat(r,now);
  }
}
