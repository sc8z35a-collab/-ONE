import {TAU,add,clamp,forward,mix,scale} from './render.js';
import {TEAM_INK} from './world.js';
import {PAINT_RADIUS_FACTOR} from './weapons.js';
import {isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {stairLane} from './stairs.js';

export const CAR_EXPLOSION_RADIUS=8.4;
export const CAR_EXPLOSION_DAMAGE=520;
export const CAR_RESPAWN_SECONDS=38;
export const CAR_ENTER_RANGE=3.6;

const T=Math.PI/2;
const INK_COLORS=[TEAM_INK[0],TEAM_INK[1],0xa66fbd];

function lerpRgb(base,tint,t) {
  const f=clamp(t,0,1);
  const r0=(base>>16)&255, g0=(base>>8)&255, b0=base&255;
  const r1=(tint>>16)&255, g1=(tint>>8)&255, b1=tint&255;
  const r=Math.round(r0+(r1-r0)*f);
  const g=Math.round(g0+(g1-g0)*f);
  const b=Math.round(b0+(b1-b0)*f);
  return (r<<16)|(g<<8)|b;
}

const angleDiff=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));

// Ray vs oriented bounding box in car-local space (local X = forward, local Z = right, local Y = up).
function rayCar(car,start,end,clearance=0,limit=1) {
  const dx=end[0]-start[0], dy=end[1]-start[1], dz=end[2]-start[2];
  const hw=car.w*.5+clearance, hh=car.h*.5+clearance, hd=car.d*.5+clearance;
  const cx=car.x, cy=car.y+car.h*.5, cz=car.z;
  const rBound=Math.hypot(hw,hd)+.25;
  // Fast sphere/AABB reject before trig
  const minX=start[0]<end[0]?start[0]:end[0], maxX=start[0]>end[0]?start[0]:end[0];
  const minZ=start[2]<end[2]?start[2]:end[2], maxZ=start[2]>end[2]?start[2]:end[2];
  const minY=start[1]<end[1]?start[1]:end[1], maxY=start[1]>end[1]?start[1]:end[1];
  if (maxX<cx-rBound || minX>cx+rBound || maxZ<cz-rBound || minZ>cz+rBound || maxY<car.y-clearance || minY>car.y+car.h+clearance) return null;

  // Car forward axis = [sin(yaw), 0, -cos(yaw)], right axis = [cos(yaw), 0, sin(yaw)]
  const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
  const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
  const ox=start[0]-cx, oy=start[1]-cy, oz=start[2]-cz;
  const lx=ox*fx+oz*fz, ly=oy, lz=ox*rx+oz*rz;
  const dlx=dx*fx+dz*fz, dly=dy, dlz=dx*rx+dz*rz;

  let near=0, far=limit, axis=1, sign=1;
  const test=(o,d,h,ax)=>{
    if (d>-1e-6 && d<1e-6) return o>=-h && o<=h;
    const inv=1/d, t0=(-h-o)*inv, t1=(h-o)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) {near=enter;axis=ax;sign=t0<t1?-1:1;}
    if (leave<far) far=leave;
    return far>=near;
  };
  if (!test(lx,dlx,hw,0) || !test(ly,dly,hh,1) || !test(lz,dlz,hd,2)) return null;
  if (near<0 || near>=limit) return null;
  const normal=axis===0?[fx*sign,0,fz*sign]:axis===1?[0,sign,0]:[rx*sign,0,rz*sign];
  return {
    t:near,
    position:[start[0]+dx*near,start[1]+dy*near,start[2]+dz*near],
    normal,
    vehicle:car
  };
}

function pointInCar(car,x,y,z,radius,height) {
  if (!car.alive || zoneOf(x)!==0) return false;
  if (y>=car.y+car.h-.04 || y+height<=car.y+.03) return false;
  const dx=x-car.x, dz=z-car.z;
  const maxR=car.w*.5+radius+.3;
  if (dx*dx+dz*dz>maxR*maxR) return false;
  const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
  const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
  const lx=dx*fx+dz*fz, lz=dx*rx+dz*rz;
  const hw=car.w*.5, hd=car.d*.5;
  const cx=lx<-hw?lx+hw:lx>hw?lx-hw:0;
  const cz=lz<-hd?lz+hd:lz>hd?lz-hd:0;
  return cx*cx+cz*cz<radius*radius;
}

export class Vehicles {
  constructor(battle) {
    this.battle=battle;
    const defs=battle.world?.vehicleDefs ?? [];
    this.cars=defs.map((def,index)=>this.makeCar(def,index));
    this.ramHits=new Map();
  }

  makeCar(def,index) {
    const style=def.style ?? 0;
    const w=style===2?4.90:4.38, d=style===2?1.96:1.70, h=1.52;
    const maxHp=style===2?320:260;
    const y=this.battle.world?.floor(def.x,def.z).y ?? 0;
    const yaw=(def.dir??1)>0?T:-T;
    return {
      id:def.id ?? ('car-'+index),
      index,
      spawnX:def.x, spawnY:y, spawnZ:def.z, spawnYaw:yaw,
      x:def.x, y, z:def.z, yaw,
      vx:0, vz:0, speed:0, steer:0, wheelSpin:0, pitch:0, roll:0,
      w, d, h, style, baseTint:def.tint ?? 0x688f86,
      alive:true, hp:maxHp, maxHp,
      stain:0, stainTeam:-1,
      ownerTeam:-1, driver:null,
      paintTimer:0, explodedAt:-99, explodeTeam:-1, respawnAt:0,
      hitFlash:-9
    };
  }

  live() {
    return this.cars.filter(c=>c.alive);
  }

  byId(id) {
    return this.cars.find(c=>c.id===id) ?? null;
  }

  // ---- Collision & Raycast Integration ----
  blocked(x,y,z,radius,height,ignoreCar=null) {
    if (zoneOf(x)!==0) return false;
    const cars=this.cars;
    for (let i=0;i<cars.length;i++) {
      const car=cars[i];
      if (car===ignoreCar || !car.alive) continue;
      if (pointInCar(car,x,y,z,radius,height)) return true;
    }
    return false;
  }

  support(x,y,z,surface) {
    if (zoneOf(x)!==0) return surface;
    let top=surface.y;
    const maxY=y+.12;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (!car.alive || car.driver) continue;
      const roof=car.y+car.h;
      if (roof<=top+.12 || roof>maxY) continue;
      const dx=x-car.x, dz=z-car.z;
      const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
      const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
      const lx=dx*fx+dz*fz, lz=dx*rx+dz*rz;
      if (Math.abs(lx)<car.w*.48 && Math.abs(lz)<car.d*.48) top=roof;
    }
    return top>surface.y?{...surface,y:top,raised:true}:surface;
  }

  trace(start,end,clearance=0,limit=1,ignoreCar=null) {
    if (zoneOf(start[0])!==0) return null;
    let best=null, bestT=limit ?? 1;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (car===ignoreCar || !car.alive) continue;
      const hit=rayCar(car,start,end,clearance,bestT);
      if (hit && hit.t<bestT) {bestT=hit.t;best=hit;}
    }
    return best;
  }

  // ---- Boarding & Exiting ([E] key / transport button) ----
  option(actor) {
    if (!actor || actor.down>0 || actor.ride || actor.lift || zoneOf(actor.x)!==0) return null;
    if (actor.car) {
      return {kind:'car-exit',car:actor.car,label:'車から降りる'};
    }
    let nearest=null, best=CAR_ENTER_RANGE;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (!car.alive || car.driver) continue;
      const d=Math.hypot(car.x-actor.x,car.z-actor.z);
      if (d<best && Math.abs(car.y-actor.y)<2.1) {best=d;nearest=car;}
    }
    return nearest?{kind:'car-enter',car:nearest,label:'車に乗る'}:null;
  }

  enter(actor,car) {
    if (!actor || !car || !car.alive || car.driver || actor.car || actor.down>0 || actor.ride || actor.lift) return false;
    const b=this.battle;
    if (actor.giant || actor.beaming || actor.slam) b.abilities.clearSuper(actor);
    car.driver=actor;
    car.ownerTeam=actor.team;
    actor.car=car;
    actor.swimming=actor.inkSwimming=actor.climbing=actor.rolling=false;
    actor.charge=actor.rollHold=0;
    actor.x=car.x;
    actor.y=car.y+.25;
    actor.z=car.z;
    actor.yaw=car.yaw;
    actor.vx=car.vx;
    actor.vz=car.vz;
    actor.vy=0;
    if (actor.isPlayer) b.callbacks.sound?.('drone');
    return true;
  }

  exit(actor,force=false) {
    const car=actor?.car;
    if (!car) return false;
    const b=this.battle;
    const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
    const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
    const sideDist=car.d*.5+.78;
    const candidates=[
      [car.x-rx*sideDist,car.z-rz*sideDist],
      [car.x+rx*sideDist,car.z+rz*sideDist],
      [car.x-fx*(car.w*.5+.85),car.z-fz*(car.w*.5+.85)],
      [car.x+fx*(car.w*.5+.85),car.z+fz*(car.w*.5+.85)],
      [car.x,car.z]
    ];
    let ex=car.x, ey=car.y, ez=car.z;
    for (const [cx,cz] of candidates) {
      const fl=b.world.support(cx,car.y+.6,cz);
      if (Math.abs(fl.y-car.y)>1.2) continue;
      if (!b.world.blocked(cx,fl.y+.03,cz,.4,1.72) && !b.stage.blocked(cx,fl.y+.03,cz,.4,1.72) &&
          !this.blocked(cx,fl.y+.03,cz,.4,1.72,car)) {
        ex=cx; ey=fl.y; ez=cz;
        break;
      }
    }
    car.driver=null;
    actor.car=null;
    actor.x=ex; actor.y=ey; actor.z=ez;
    actor.vx=0; actor.vz=0; actor.vy=0;
    actor.driveX=0; actor.driveZ=0;
    if (!force && actor.isPlayer) b.callbacks.sound?.('lob');
    return true;
  }

  use(actor) {
    const opt=this.option(actor);
    if (!opt) return false;
    if (opt.kind==='car-exit') return this.exit(actor);
    if (opt.kind==='car-enter') return this.enter(actor,opt.car);
    return false;
  }

  // ---- Enemy Ink Dyeing, Damage & Massive Explosion ----
  damageCar(car,amount,source=null,point=null) {
    if (!car || !car.alive || !(amount>0)) return 0;
    const b=this.battle;
    const attackerTeam=source?.team ?? -1;
    // Allied fire does not destroy your own team's driven car.
    if (car.ownerTeam>=0 && attackerTeam===car.ownerTeam) {
      if (point) b.burst(point,attackerTeam,3,1.4);
      return 0;
    }
    const lost=Math.min(car.hp,amount);
    car.hp-=lost;
    car.hitFlash=b.clock;
    // Dye the car progressively in the enemy's ink color!
    car.stain=clamp(1-car.hp/car.maxHp,0,1);
    if (attackerTeam>=0) car.stainTeam=attackerTeam;
    else if (car.stainTeam<0) car.stainTeam=2;
    const p=point ?? [car.x,car.y+car.h*.65,car.z];
    b.burst(p,attackerTeam,6,2.3);
    if (source?.isPlayer) b.callbacks.sound?.('hit');
    if (car.hp<=0 || car.stain>=1) {
      this.explode(car,source);
    }
    return lost;
  }

  damageArea(x,y,z,radius,amount,source=null,ignoreCar=null) {
    if (zoneOf(x)!==0) return;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (!car.alive || car===ignoreCar) continue;
      const dist=Math.hypot(car.x-x,car.z-z);
      if (dist>radius+car.w*.45 || Math.abs(car.y-y)>3.2) continue;
      const falloff=clamp(1-Math.max(0,dist-car.w*.3)/(radius+.1),.3,1);
      this.damageCar(car,amount*falloff,source,[car.x,car.y+.9,car.z]);
    }
  }

  explode(car,source=null) {
    if (!car.alive) return;
    const b=this.battle;
    const driver=car.driver;
    const cx=car.x, cy=car.y, cz=car.z;
    const team=source?.team ?? (car.stainTeam>=0?car.stainTeam:-1);
    car.alive=false;
    car.hp=0;
    car.stain=1;
    car.speed=0; car.vx=0; car.vz=0;
    car.explodedAt=b.clock;
    car.explodeTeam=team;
    car.respawnAt=b.elapsed+CAR_RESPAWN_SECONDS;
    if (driver) {
      this.exit(driver,true);
      // Place ejected driver right at blast center so the explosion hits them cleanly!
      driver.x=cx; driver.y=cy+.1; driver.z=cz;
    }
    // Massive ink splash & visual shockwaves
    const floor=b.world.floor(cx,cz);
    if (team>=0 && b.paint.hasSurface(cx,cz,floor.layer)) {
      const painted=b.paint.stampGround(cx,cz,6.2*PAINT_RADIUS_FACTOR,team,floor.layer,0,.095);
      if (source && source.team>=0) source.painted=(source.painted??0)+painted;
    }
    b.burst([cx,cy+1.1,cz],team,34,7.4);
    b.abilities.rings.push({x:cx,y:floor.y+.08,z:cz,r:CAR_EXPLOSION_RADIUS,team:Math.max(0,team),until:b.clock+.75});
    b.abilities.rings.push({x:cx,y:floor.y+.12,z:cz,r:CAR_EXPLOSION_RADIUS*.55,team:1,until:b.clock+.48});
    b.callbacks.sound?.('bossDown');
    b.stage.damageArea(b,source ?? {team},cx,cy,cz,CAR_EXPLOSION_RADIUS,CAR_EXPLOSION_DAMAGE*.8);
    b.events.unshift({label:'💥 車が敵インクに染まり大爆発！',team,until:b.clock+4.0});
    b.events.length=Math.min(b.events.length,4);

    // Massive area damage to all nearby fighters, Raiders, Snipers, Drones, Boss, Goat!
    const victims=[
      ...b.actors,
      ...b.raiders.live(),
      ...(b.hazards?b.hazards.targets(cx):[]),
      ...(b.boss?.active?[b.boss]:[])
    ];
    for (let i=0;i<victims.length;i++) {
      const target=victims[i];
      if (!sameLevel(target.x,cx) || (target.down??0)>0 || target.ride || target.lift) continue;
      // Friendly source does not splat teammates unless they were driving an enemy-blown car
      if (source && source.team>=0 && target.team===source.team && target!==driver) continue;
      const dx=target.x-cx, dz=target.z-cz, dist=Math.hypot(dx,dz);
      if (dist>CAR_EXPLOSION_RADIUS || Math.abs(target.y-cy)>4.2) continue;
      const falloff=clamp(1-.55*(dist/CAR_EXPLOSION_RADIUS),.42,1);
      const dmg=CAR_EXPLOSION_DAMAGE*falloff;
      const inv=1/Math.max(.3,dist);
      if (!target.isBoss && !target.isGoat && !target.isSniper && !target.isRogueDrone) {
        b.stepActor(target,dx*inv*2.6,dz*inv*2.6);
      }
      b.damage(target,dmg,source,[target.x,target.y+.9,target.z],'carBomb');
    }

    // Chain-reaction blast damage to neighboring cars!
    this.damageArea(cx,cy,cz,CAR_EXPLOSION_RADIUS*.9,CAR_EXPLOSION_DAMAGE*.65,source,car);
  }

  // ---- Driving Physics, Ink Painting & Roadkill Ramming ----
  drive(actor,input,dt) {
    const car=actor?.car;
    if (!car || !car.alive) return false;
    const b=this.battle;
    const throttle=clamp(input.z??0,-1,1);
    const steerInput=clamp(input.x??0,-1,1);
    const drift=!!input.jump;

    // Arcade-crisp acceleration, braking, reverse, and handbrake drift
    const maxFwd=16.2, maxRev=-8.8;
    if (throttle>.05) {
      const accel=car.speed<0?34:19.5;
      car.speed=Math.min(maxFwd,car.speed+accel*throttle*dt);
    } else if (throttle<-.05) {
      const accel=car.speed>0?36:14.5;
      car.speed=Math.max(maxRev,car.speed+accel*throttle*dt);
    } else {
      const drag=(drift?22:9.5)*dt;
      car.speed=Math.abs(car.speed)<=drag?0:car.speed-Math.sign(car.speed)*drag;
    }

    // Smooth steering (turn rate scales smoothly with speed & allows tight drift turns)
    const targetSteer=steerInput*.55;
    car.steer=mix(car.steer,targetSteer,1-Math.exp(-dt*14));
    const speedMag=Math.abs(car.speed);
    if (speedMag>.25) {
      const dirSign=car.speed>=0?1:-1;
      const turnRate=(drift?3.15:2.35)*clamp(speedMag/4.5,.28,1);
      // Standard game yaw: forward = [sin(yaw), 0, -cos(yaw)], so turning right (steerInput > 0) increases yaw!
      car.yaw=angleDiff(0,car.yaw+steerInput*dirSign*turnRate*dt);
    }

    const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
    const dx=fx*car.speed*dt, dz=fz*car.speed*dt;
    const oldX=car.x, oldZ=car.z;

    // Move car with sliding collision along world walls & other cars
    const canPlace=(nx,nz)=>{
      const lx=localX(nx);
      if (Math.abs(lx)>53.5 || Math.abs(nz)>33.5) return null;
      if (stairLane(nx,nz,.9)) return null;
      const fl=b.world.support(nx,car.y+.55,nz);
      if (Math.abs(fl.y-car.y)>.62) return null;
      // Check front, center, and rear footprint circles against static world & other cars
      const r=car.d*.46;
      const offsets=[car.w*.34,0,-car.w*.34];
      for (let i=0;i<offsets.length;i++) {
        const px=nx+fx*offsets[i], pz=nz+fz*offsets[i];
        if (b.world.blocked(px,fl.y+.05,pz,r,car.h)) return null;
        if (this.blocked(px,fl.y+.05,pz,r,car.h,car)) return null;
        if (b.transit.blocksActor({x:px,y:fl.y,z:pz,radius:r,height:car.h})) return null;
      }
      return fl;
    };

    // Smash breakable crates/glass directly in front of a fast-moving car!
    if (speedMag>3.5) {
      const noseX=car.x+fx*(car.w*.5+.35), noseZ=car.z+fz*(car.w*.5+.35);
      b.stage.damageArea(b,actor,noseX,car.y+.3,noseZ,1.45,55+speedMag*8);
    }

    let moved=canPlace(car.x+dx,car.z+dz);
    if (moved) {
      car.x+=dx; car.z+=dz; car.y=moved.y;
    } else {
      // Try sliding along X or Z independently so driving along curbs/walls feels great
      const slideX=canPlace(car.x+dx,car.z);
      const slideZ=canPlace(car.x,car.z+dz);
      if (slideX) {car.x+=dx;car.y=slideX.y;car.speed*=.86;}
      else if (slideZ) {car.z+=dz;car.y=slideZ.y;car.speed*=.86;}
      else {car.speed*=-.22;}
    }

    car.vx=(car.x-oldX)/Math.max(.001,dt);
    car.vz=(car.z-oldZ)/Math.max(.001,dt);
    car.wheelSpin+=car.speed*dt*2.8;
    car.roll=mix(car.roll,clamp(-steerInput*car.speed*.012,-.14,.14),1-Math.exp(-dt*10));
    car.pitch=mix(car.pitch,clamp(-throttle*.045,-.06,.06),1-Math.exp(-dt*9));

    // Keep driver synchronized inside cabin
    actor.x=car.x;
    actor.y=car.y+.25;
    actor.z=car.z;
    actor.vx=car.vx;
    actor.vz=car.vz;
    actor.vy=0;
    actor.airborne=false;

    // 1) PAINT THE ROAD WITH DRIVER'S OWN INK!
    car.paintTimer-=dt;
    const actualSpeed=Math.hypot(car.vx,car.vz);
    if (actualSpeed>=.6 && car.paintTimer<=0 && actor.team>=0) {
      car.paintTimer=.055;
      const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
      const tread=car.d*.36;
      const paintR=car.d*.52*PAINT_RADIUS_FACTOR;
      for (const side of [-1,0,1]) {
        const px=car.x+rx*side*tread-fx*.35;
        const pz=car.z+rz*side*tread-fz*.35;
        const fl=b.world.support(px,car.y+.3,pz);
        if (Math.abs(fl.y-car.y)>.6) continue;
        if (!fl.raised && b.paint.hasSurface(px,pz,fl.layer)) {
          const gained=b.paint.stampGround(px,pz,paintR,actor.team,fl.layer,car.wheelSpin,.052);
          actor.painted+=gained;
          if (gained>0) b.paint.kick(px,pz,fl.layer,car.vx*.45,car.vz*.45);
        }
      }
      if (actualSpeed>4) b.drops.push({p:[car.x-fx*car.w*.46,car.y+.25,car.z-fz*car.w*.46],
        v:[-car.vx*.18+(b.rng()-.5)*2.5,2.2+b.rng()*1.4,-car.vz*.18+(b.rng()-.5)*2.5],
        team:actor.team,size:.14,life:.32,max:.32});
    }

    // 2) RAM / RUN OVER ENEMIES（「引き倒せたり」）!
    if (actualSpeed>=2.8) {
      this.ramTargets(car,actor,actualSpeed);
    }

    return true;
  }

  ramTargets(car,driver,speed) {
    const b=this.battle;
    const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
    const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
    const victims=[
      ...b.actors,
      ...b.raiders.live(),
      ...(b.boss?.active?[b.boss]:[]),
      ...(b.hazards?.goat?.active?[b.hazards.goat]:[])
    ];
    for (let i=0;i<victims.length;i++) {
      const target=victims[i];
      if (target===driver || (target.down??0)>0 || target.ride || target.lift || !sameLevel(target.x,car.x)) continue;
      if (target.team===driver.team) continue;
      if (Math.abs(target.y-car.y)>2.1 && !target.isGoat) continue;
      const dx=target.x-car.x, dz=target.z-car.z;
      const lx=dx*fx+dz*fz, lz=dx*rx+dz*rz;
      const rad=target.radius??.45;
      if (Math.abs(lx)>car.w*.5+rad+.25 || Math.abs(lz)>car.d*.5+rad+.25) continue;
      const lastHit=this.ramHits.get(target) ?? -99;
      if (b.clock-lastHit<.38) continue;
      this.ramHits.set(target,b.clock);
      // Heavy impact damage: cruising/top speed (>10 m/s) runs over & splats regular fighters in one hit!
      // (Remember Battle.damage scales by DAMAGE_SCALE = 1/3, so base 340 -> ~113 actual HP!)
      const impactBase=140+speed*24;
      const sideSign=lz>=0?1:-1;
      const pushX=fx*2.2+rx*sideSign*1.8, pushZ=fz*2.2+rz*sideSign*1.8;
      if (!target.isBoss && !target.isGoat) b.stepActor(target,pushX,pushZ);
      b.damage(target,impactBase,driver,[target.x,target.y+.9,target.z],'car');
      b.burst([target.x,target.y+.85,target.z],driver.team,14,4.2);
      // Slight recoil on vehicle
      car.speed*=.91;
    }
  }

  update(dt) {
    const b=this.battle;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (!car.alive) {
        if (car.respawnAt>0 && b.elapsed>=car.respawnAt) {
          // Respawn intact car cleanly at its original parking spot if unobstructed
          const occupied=b.actors.some(a=>a.down<=0 && sameLevel(a.x,car.spawnX) && Math.hypot(a.x-car.spawnX,a.z-car.spawnZ)<3.2);
          if (!occupied) {
            Object.assign(car,{
              x:car.spawnX,y:car.spawnY,z:car.spawnZ,yaw:car.spawnYaw,
              vx:0,vz:0,speed:0,steer:0,pitch:0,roll:0,
              alive:true,hp:car.maxHp,stain:0,stainTeam:-1,ownerTeam:-1,driver:null,respawnAt:0
            });
          }
        }
        continue;
      }
      // If driver died or got forcibly disconnected, release driver seat
      if (car.driver && (car.driver.down>0 || car.driver.car!==car)) {
        if (car.driver.car===car) car.driver.car=null;
        car.driver=null;
      }
      // Coasting empty car decelerates smoothly to a stop
      if (!car.driver && Math.abs(car.speed)>.05) {
        const drag=14*dt;
        car.speed=Math.abs(car.speed)<=drag?0:car.speed-Math.sign(car.speed)*drag;
        const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
        const nx=car.x+fx*car.speed*dt, nz=car.z+fz*car.speed*dt;
        if (Math.abs(localX(nx))<53.5 && Math.abs(nz)<33.5 && !b.world.blocked(nx,car.y+.05,nz,car.d*.46,car.h)) {
          car.x=nx; car.z=nz;
          car.wheelSpin+=car.speed*dt*2.8;
        } else {
          car.speed=0;
        }
      }
      // Danger smoke/sparks when heavily dyed by enemy ink (>= 70%)
      if (car.stain>=.70 && b.rng()<dt*10) {
        b.drops.push({
          p:[car.x+(b.rng()-.5)*1.2,car.y+1.35,car.z+(b.rng()-.5)*1.2],
          v:[(b.rng()-.5)*1.8,2.6+b.rng()*1.8,(b.rng()-.5)*1.8],
          team:car.stainTeam>=0?car.stainTeam:1,
          size:.18,life:.45,max:.45
        });
      }
    }
  }

  // ---- Cloud Snapshot & Checkpoint Serialization ----
  snapshot(zone,mergeStairs=false) {
    if (zone!==0 && !mergeStairs) return [];
    const q=n=>Math.round(n*100)/100;
    return this.cars.map(c=>({
      id:c.id,x:q(c.x),y:q(c.y),z:q(c.z),yaw:q(c.yaw),speed:q(c.speed),steer:q(c.steer),
      wheelSpin:q(c.wheelSpin),pitch:q(c.pitch),roll:q(c.roll),
      alive:c.alive,hp:q(c.hp),maxHp:c.maxHp,stain:q(c.stain),stainTeam:c.stainTeam,
      ownerTeam:c.ownerTeam,driverIndex:c.driver?this.battle.actors.indexOf(c.driver):-1,
      explodedAt:q(c.explodedAt),explodeTeam:c.explodeTeam,hitFlash:q(c.hitFlash)
    }));
  }

  applySnapshot(rows) {
    if (!Array.isArray(rows)) return;
    for (let i=0;i<rows.length;i++) {
      const s=rows[i], car=this.byId(s.id) ?? this.cars[i];
      if (!car) continue;
      Object.assign(car,s);
      car.driver=s.driverIndex>=0?this.battle.actors[s.driverIndex]??null:null;
    }
  }

  checkpoint() {
    return this.cars.map(c=>({
      id:c.id,x:c.x,y:c.y,z:c.z,yaw:c.yaw,speed:c.speed,steer:c.steer,wheelSpin:c.wheelSpin,
      alive:c.alive,hp:c.hp,stain:c.stain,stainTeam:c.stainTeam,ownerTeam:c.ownerTeam,
      driverIndex:c.driver?this.battle.actors.indexOf(c.driver):-1,
      explodedAt:c.explodedAt,explodeTeam:c.explodeTeam,respawnAt:c.respawnAt
    }));
  }

  restoreCheckpoint(rows) {
    if (!Array.isArray(rows)) return;
    for (const a of this.battle.actors) a.car=null;
    for (let i=0;i<rows.length;i++) {
      const s=rows[i], car=this.byId(s.id) ?? this.cars[i];
      if (!car) continue;
      Object.assign(car,s);
      car.driver=s.driverIndex>=0?this.battle.actors[s.driverIndex]??null:null;
      if (car.driver) car.driver.car=car;
    }
    this.ramHits.clear();
  }

  // ---- 3D Dynamic Vehicle Rendering (with live enemy-ink dyeing & explosion debris) ----
  draw(r,viewX,viewZ,clock) {
    if (zoneOf(viewX)!==0) return;
    const reach=r.reach??Infinity, lim2=reach===Infinity?Infinity:(reach+10)*(reach+10);
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (lim2!==Infinity) {
        const dx=car.x-viewX, dz=car.z-viewZ;
        if (dx*dx+dz*dz>lim2) continue;
      }
      if (!car.alive) {
        const age=clock-car.explodedAt;
        if (age>=0 && age<1.35) drawExplosionDebris(r,car,age);
        continue;
      }
      drawVehicle(r,car,clock);
    }
  }
}

function drawVehicle(r,car,clock) {
  const {x,y,z,yaw,w,d,style,baseTint,stain,stainTeam,driver,hitFlash}=car;
  const inkColor=INK_COLORS[stainTeam>=0?stainTeam:1] ?? INK_COLORS[1];
  // Smoothly dye the entire car body toward the attacking enemy's ink color!
  const flash=clock-hitFlash<.10?.35:0;
  const warnPulse=stain>=.72 && Math.sin(clock*20)>0?.22:0;
  const bodyTint=lerpRgb(baseTint,inkColor,clamp(stain*.92+flash*.4,0,1));
  const roofTint=lerpRgb(baseTint,inkColor,clamp(stain*1.05+warnPulse,0,1));
  const trim=0x959f9e, rubber=0x293438, glass=driver?0x588a99:0x405e68;

  // Car local frame: forward = [sin(yaw), 0, -cos(yaw)], right = [cos(yaw), 0, sin(yaw)]
  // In renderer, box yaw rotation maps local X -> [cos(ry), 0, -sin(ry)] and local Z -> [sin(ry), 0, cos(ry)].
  // So to align box local +X with car forward [sin(yaw), 0, -cos(yaw)], use ry = yaw - PI/2!
  const ry=yaw-T;
  const fx=Math.sin(yaw), fz=-Math.cos(yaw);
  const rx=Math.cos(yaw), rz=Math.sin(yaw);
  const at=(dx,dy,dz)=>[x+fx*dx+rx*dz,y+dy,z+fz*dx+rz*dz];
  const p=(type,dx,dy,dz,sx,sy,sz,c,k=2,extra={})=>
    r.add(type,...at(dx,dy,dz),sx,sy,sz,c,k,{dynamic:true,yaw:ry,...extra});

  // Undercarriage & main sculpted chassis
  p('box',0,.39,0,w-.16,.28,d-.06,rubber,4);
  p('bevel',0,.65,0,w-.04,.45,d,bodyTint,4);
  p('bevel',.40,.875,0,w-.86,.25,d-.10,bodyTint,4);
  p('box',w/2-.57,.79,0,1.06,.20,d-.08,bodyTint,4);
  p('box',-w/2+.54,.83,0,1.04,.27,d-.06,bodyTint,2);

  // Front & rear bumpers, grilles, headlights, taillights, and 4 rotating wheels
  for (const sign of [-1,1]) {
    p('box',sign*(w/2-.04),.46,0,.19,.17,d+.09,trim,4);
    p('box',sign*(w/2-.04),.66,0,.13,.25,d-.10,0x505b58,4);
    const lightTint=sign>0?(driver?0xfffbe0:0xf5eacc):(car.speed<-.5?0xff4d3b:0xb33c2b);
    for (const oz of [-.57,.57]) {
      p('box',sign*(w/2+.03),.735,oz,.045,.155,.31,lightTint,3);
    }
    for (const ox of [-w*.315,w*.303]) {
      const wheelYaw=ry+(ox>0?car.steer:0);
      r.add('cylinder',...at(ox,.38,sign*(d/2+.015)),.71,.24,.71,rubber,2,{dynamic:true,yaw:wheelYaw,pitch:T});
      r.add('cylinder',...at(ox,.38,sign*(d/2+.151)),.46,.05,.46,0x7f8c8c,4,{dynamic:true,yaw:wheelYaw,pitch:T});
    }
    // Side windows & pillars
    p('box',-.06,1.10,sign*(d/2-.12),1.66,.45,.05,glass,8);
    p('box',-.81,1.12,sign*(d/2-.12),.084,.50,.08,bodyTint,4);
    p('box',.73,1.12,sign*(d/2-.12),.088,.50,.08,bodyTint,4);
  }
  // Roof & windshields
  p('bevel',-.07,1.39,0,1.65,.115,d-.22,roofTint,4);
  p('box',.76,1.15,0,d-.20,.50,.076,glass,8,{yaw:ry+T,pitch:.42});
  p('box',-.92,1.17,0,d-.24,.48,.08,glass,8,{yaw:ry+T,pitch:-.35});

  if (style===1) {
    // Pickup bed
    p('box',-w/2+.57,.955,0,1.10,.12,d-.12,0x8c978a,4);
    for (const sign of [-1,1]) p('box',-w/2+.55,1.08,sign*(d/2-.09),1.2,.22,.12,bodyTint,2);
  } else if (style===2) {
    // Delivery van cargo box
    const cargoTint=lerpRgb(0xd7d4bc,inkColor,clamp(stain*.95,0,1));
    p('box',-w/2+.76,1.16,0,1.47,.83,d-.07,cargoTint,2);
  }

  // Team beacon strip on roof when occupied by a driver
  if (driver) {
    const teamColor=TEAM_INK[driver.team] ?? 0xffffff;
    p('box',-.07,1.48,0,.95,.08,.48,teamColor,3);
    // Driver silhouette visible inside cockpit
    p('orb',-.02,1.12,-.28,.34,.36,.34,teamColor,3);
  }

  // Dynamic glossy enemy ink coating layers growing across hood, roof & flanks as stain rises!
  if (stain>.04) {
    const s=clamp(stain,0,1);
    p('box',w*.24,.92,0,1.15*s+.25,.05,(d-.18)*(.45+.55*s),inkColor,9);
    p('box',-.07,1.455,0,1.55*s+.2,.045,(d-.26)*(.45+.55*s),inkColor,9);
    for (const sign of [-1,1]) {
      p('box',0,.68,sign*(d*.5+.025),w*.86*s+.35,.38*(.4+.6*s),.03,inkColor,9);
    }
    // Critical detonation glow ring around car when almost completely dyed (>= 78%)
    if (stain>=.78) {
      const pulse=.5+.5*Math.sin(clock*24);
      r.add('ripple',x,y+.08,z,(w+1.4)*(1+pulse*.18),.04,(w+1.4)*(1+pulse*.18),inkColor,12,{dynamic:true,label:.25+pulse*.65});
    }
  }
}

function drawExplosionDebris(r,car,age) {
  const {x,y,z,w,d,baseTint,explodeTeam}=car;
  const ink=INK_COLORS[explodeTeam>=0?explodeTeam:1] ?? INK_COLORS[1];
  const life=clamp(1-age/1.35,0,1);
  // Expanding blast fireball & shockwave rings
  if (age<.48) {
    const t=age/.48, core=(1-t)*3.2+1.2;
    r.add('orb',x,y+1.1+t*1.6,z,core,core,core,t<.25?0xfff5cc:ink,3,{dynamic:true});
    r.add('ripple',x,y+.12,z,2+t*CAR_EXPLOSION_RADIUS*2,.05,2+t*CAR_EXPLOSION_RADIUS*2,ink,12,{dynamic:true,label:t});
  }
  const count=r.lite?10:18;
  for (let i=0;i<count;i++) {
    const a=i*2.399+car.index, speed=3.2+(i%5)*1.45, lift=4.8+(i%4)*1.6;
    const px=x+Math.cos(a)*(w*.22+age*speed), pz=z+Math.sin(a)*(d*.22+age*speed);
    const py=Math.max(y+.1,y+.8+age*lift-age*age*6.2);
    const sz=(.32+(i%3)*.16)*Math.max(.01,life);
    r.add(i%3===0?'cylinder':'box',px,py,pz,sz,sz*.7,sz*1.1,i%2===0?ink:baseTint,i%2===0?9:4,
      {dynamic:true,yaw:a+age*6.5,pitch:age*(i%4+2.5)});
  }
}
