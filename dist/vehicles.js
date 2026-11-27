import {Renderer,STRIDE,TAU,add,clamp,cross,forward,mix,packInstance,scale,unit} from './render.js';
import {TEAM_INK} from './world.js';
import {PAINT_RADIUS_FACTOR} from './weapons.js';
import {localX,sameLevel,zoneOf} from './layout.js';
import {stairLane} from './stairs.js';

export const CAR_EXPLOSION_RADIUS=8.4;
export const CAR_EXPLOSION_DAMAGE=520;
export const CAR_RESPAWN_SECONDS=38;
export const CAR_ENTER_RANGE=5.6;

const T=Math.PI/2;
const INK_COLORS=[TEAM_INK[0],TEAM_INK[1],0xa66fbd];
const _CAR_SHAPE_IDS={box:1,ramp:2,bevel:3,soft:4};
const _CAR_SYMMETRIC=new Set(['box','bevel','cylinder','taper','cone','orb','soft','limb','mantle','ring']);

function syncCarTrig(car) {
  if (car._yawCached===car.yaw) return;
  const y=car.yaw;
  car._yawCached=y;
  car._fx=Math.sin(y);
  car._fz=-Math.cos(y);
  car._rx=Math.cos(y);
  car._rz=Math.sin(y);
  if (car._rBound===undefined) car._rBound=Math.sqrt((car.w*.5)*(car.w*.5)+(car.d*.5)*(car.d*.5))+.25;
}

function recordCarTemplate(fn) {
  const buckets=new Map();
  const rec={
    add(type,x,y,z,w,h,d,tint,kind=0,opts={}) {
      let arr=buckets.get(type);
      if (!arr) {arr=[];buckets.set(type,arr);}
      const o=arr.length;
      arr.length=o+STRIDE;
      packInstance(arr,o,x,y,z,w,h,d,tint,kind,opts,_CAR_SHAPE_IDS[type]??0,_CAR_SYMMETRIC.has(type));
    }
  };
  fn(rec);
  const out=[];
  for (const [type,arr] of buckets) out.push([type,new Float32Array(arr)]);
  return out;
}

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

// Builds a full 3D orthonormal basis [fwd, up, right] for a sprung vehicle chassis
// incorporating heading (yaw + drift slip), acceleration/brake/slope pitch, and cornering roll.
function chassisBasisInto(yaw,pitch,roll,out) {
  const fx0=Math.sin(yaw), fz0=-Math.cos(yaw);
  const rx0=Math.cos(yaw), rz0=Math.sin(yaw);
  const cp=Math.cos(pitch), sp=Math.sin(pitch);
  const cr=Math.cos(roll), sr=Math.sin(roll);
  // Apply pitch around right axis (positive pitch lifts the nose during hard acceleration)
  const fx=fx0*cp, fy=sp, fz=fz0*cp;
  const ux0=-fx0*sp, uy0=cp, uz0=-fz0*sp;
  // Apply roll around forward axis (positive roll tilts roof toward right)
  const ux=ux0*cr+rx0*sr, uy=uy0*cr, uz=uz0*cr+rz0*sr;
  const rx=rx0*cr-ux0*sr, ry=-uy0*sr, rz=rz0*cr-uz0*sr;
  const b0=out[0], b1=out[1], b2=out[2];
  b0[0]=fx; b0[1]=fy; b0[2]=fz;
  b1[0]=ux; b1[1]=uy; b1[2]=uz;
  b2[0]=rx; b2[1]=ry; b2[2]=rz;
  return out;
}

const _vBasis=[[0,0,0],[0,0,0],[0,0,0]], _vOpts={dynamic:true,basis:_vBasis};
const _vAuxBasis=[[0,0,0],[0,0,0],[0,0,0]], _vAuxOpts={dynamic:true,basis:_vAuxBasis};
const _vExBasis=[[0,0,0],[0,0,0],[0,0,0]], _vExOpts={dynamic:true,basis:_vExBasis};
const _vWBasis=[[0,0,0],[0,0,0],[0,0,0]], _vWOpts={dynamic:true,basis:_vWBasis};
const _vABasis=[[0,0,0],[0,0,0],[0,0,0]], _vAOpts={dynamic:true,basis:_vABasis};
const _vShadeOpts={dynamic:true,yaw:0,label:.72};
const _vRipOpts={dynamic:true,label:0};
const _vDebOpts={dynamic:true,yaw:0,pitch:0};
const _vDyn={dynamic:true};

// Ray vs oriented bounding box in car-local space (local X = forward, local Z = right, local Y = up).
function rayCar(car,start,end,clearance=0,limit=1) {
  syncCarTrig(car);
  const sx=start[0], sy=start[1], sz=start[2];
  const ex=end[0], ey=end[1], ez=end[2];
  const hw=car.w*.5+clearance, hh=car.h*.5+clearance, hd=car.d*.5+clearance;
  const cx=car.x, cy=car.y+car.h*.5, cz=car.z;
  const rBound=car._rBound+clearance*1.415;
  const minX=sx<ex?sx:ex, maxX=sx>ex?sx:ex;
  if (maxX<cx-rBound || minX>cx+rBound) return null;
  const minZ=sz<ez?sz:ez, maxZ=sz>ez?sz:ez;
  if (maxZ<cz-rBound || minZ>cz+rBound) return null;
  const minY=sy<ey?sy:ey, maxY=sy>ey?sy:ey;
  if (maxY<car.y-clearance || minY>car.y+car.h+clearance) return null;

  const dx=ex-sx, dy=ey-sy, dz=ez-sz;
  const fx=car._fx, fz=car._fz, rx=car._rx, rz=car._rz;
  const ox=sx-cx, oy=sy-cy, oz=sz-cz;
  const lx=ox*fx+oz*fz, lz=ox*rx+oz*rz;
  const dlx=dx*fx+dz*fz, dlz=dx*rx+dz*rz;

  let near=0, far=limit, axis=1, sign=1;
  if (dlx>-1e-6 && dlx<1e-6) {if (lx<-hw || lx>hw) return null;}
  else {
    const inv=1/dlx, t0=(-hw-lx)*inv, t1=(hw-lx)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) {near=enter;axis=0;sign=t0<t1?-1:1;}
    if (leave<far) far=leave;
    if (far<near) return null;
  }
  if (dy>-1e-6 && dy<1e-6) {if (oy<-hh || oy>hh) return null;}
  else {
    const inv=1/dy, t0=(-hh-oy)*inv, t1=(hh-oy)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) {near=enter;axis=1;sign=t0<t1?-1:1;}
    if (leave<far) far=leave;
    if (far<near) return null;
  }
  if (dlz>-1e-6 && dlz<1e-6) {if (lz<-hd || lz>hd) return null;}
  else {
    const inv=1/dlz, t0=(-hd-lz)*inv, t1=(hd-lz)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) {near=enter;axis=2;sign=t0<t1?-1:1;}
    if (leave<far) far=leave;
    if (far<near) return null;
  }
  if (near<0 || near>=limit) return null;
  const normal=axis===0?[fx*sign,0,fz*sign]:axis===1?[0,sign,0]:[rx*sign,0,rz*sign];
  return {
    t:near,
    position:[sx+dx*near,sy+dy*near,sz+dz*near],
    normal,
    vehicle:car
  };
}

function rayCarAny(car,sx,sy,sz,dx,dy,dz,minX,maxX,minY,maxY,minZ,maxZ,limit) {
  syncCarTrig(car);
  const cx=car.x, cz=car.z, rBound=car._rBound;
  if (maxX<cx-rBound || minX>cx+rBound || maxZ<cz-rBound || minZ>cz+rBound || maxY<car.y || minY>car.y+car.h) return false;
  const hw=car.w*.5, hh=car.h*.5, hd=car.d*.5;
  const fx=car._fx, fz=car._fz, rx=car._rx, rz=car._rz;
  const ox=sx-cx, oy=sy-(car.y+hh), oz=sz-cz;
  const lx=ox*fx+oz*fz, lz=ox*rx+oz*rz;
  const dlx=dx*fx+dz*fz, dlz=dx*rx+dz*rz;
  let near=0, far=limit;
  if (dlx>-1e-6 && dlx<1e-6) {if (lx<-hw || lx>hw) return false;}
  else {
    const inv=1/dlx, t0=(-hw-lx)*inv, t1=(hw-lx)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) near=enter;
    if (leave<far) far=leave;
    if (far<near) return false;
  }
  if (dy>-1e-6 && dy<1e-6) {if (oy<-hh || oy>hh) return false;}
  else {
    const inv=1/dy, t0=(-hh-oy)*inv, t1=(hh-oy)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) near=enter;
    if (leave<far) far=leave;
    if (far<near) return false;
  }
  if (dlz>-1e-6 && dlz<1e-6) {if (lz<-hd || lz>hd) return false;}
  else {
    const inv=1/dlz, t0=(-hd-lz)*inv, t1=(hd-lz)*inv;
    const enter=t0<t1?t0:t1, leave=t0<t1?t1:t0;
    if (enter>near) near=enter;
    if (leave<far) far=leave;
    if (far<near) return false;
  }
  return near>=0 && near<limit;
}

function pointInCar(car,x,y,z,radius,height) {
  if (!car.alive || zoneOf(x)!==0) return false;
  if (y>=car.y+car.h-.04 || y+height<=car.y+.03) return false;
  const dx=x-car.x, dz=z-car.z;
  const maxR=car.w*.5+radius+.3;
  if (dx*dx+dz*dz>maxR*maxR) return false;
  syncCarTrig(car);
  const lx=dx*car._fx+dz*car._fz, lz=dx*car._rx+dz*car._rz;
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
    let maxY=0;
    for (let i=0;i<this.cars.length;i++) {const y=this.cars[i].y+this.cars[i].h; if (y>maxY) maxY=y;}
    this._maxCarY=maxY+.35;
  }

  makeCar(def,index) {
    const style=def.style ?? 0;
    const w=style===2?4.90:4.38, d=style===2?1.96:1.70, h=1.52;
    const maxHp=style===2?320:260;
    const y=this.battle.world?.floor(def.x,def.z).y ?? 0;
    const yaw=(def.dir??1)>0?T:-T;
    const car={
      id:def.id ?? ('car-'+index),
      index,
      spawnX:def.x, spawnY:y, spawnZ:def.z, spawnYaw:yaw,
      x:def.x, y, z:def.z, yaw,
      vx:0, vz:0, speed:0, steer:0, wheelSpin:0,
      // Upgraded 4-wheel suspension, powerslide drift & transmission engine state
      pitch:0, roll:0, driftAngle:0, susY:0, susVel:0,
      rpm:900, gear:1, throttle:0, braking:false, drifting:false, driftCharge:0,
      boostFlame:0, impactShake:0,
      w, d, h, style, baseTint:def.tint ?? 0x688f86,
      alive:true, hp:maxHp, maxHp,
      stain:0, stainTeam:-1,
      ownerTeam:-1, driver:null,
      paintTimer:0, explodedAt:-99, explodeTeam:-1, respawnAt:0,
      hitFlash:-9,
      _yawCached:NaN, _fx:0, _fz:0, _rx:0, _rz:0,
      _rBound:Math.sqrt((w*.5)*(w*.5)+(d*.5)*(d*.5))+.25,
      _tplHi:null, _tplLo:null
    };
    syncCarTrig(car);
    return car;
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
    const cars=this.cars;
    for (let i=0;i<cars.length;i++) {
      const car=cars[i];
      if (!car.alive || car.driver) continue;
      const roof=car.y+car.h;
      if (roof<=top+.12 || roof>maxY) continue;
      const dx=x-car.x, dz=z-car.z;
      if (dx*dx+dz*dz>car._rBound*car._rBound) continue;
      syncCarTrig(car);
      const lx=dx*car._fx+dz*car._fz, lz=dx*car._rx+dz*car._rz;
      if (Math.abs(lx)<car.w*.48 && Math.abs(lz)<car.d*.48) top=roof;
    }
    return top>surface.y?{...surface,y:top,raised:true}:surface;
  }

  trace(start,end,clearance=0,limit=1,ignoreCar=null) {
    if (zoneOf(start[0])!==0) return null;
    let best=null, bestT=limit ?? 1;
    const cars=this.cars;
    for (let i=0;i<cars.length;i++) {
      const car=cars[i];
      if (car===ignoreCar || !car.alive) continue;
      const hit=rayCar(car,start,end,clearance,bestT);
      if (hit && hit.t<bestT) {bestT=hit.t;best=hit;}
    }
    return best;
  }

  traceAny(sx,sy,sz,ex,ey,ez,limit=1,ignoreCar=null) {
    if (zoneOf(sx)!==0) return false;
    const cars=this.cars, n=cars.length;
    if (!n) return false;
    const minY=sy<ey?sy:ey;
    if (minY>this._maxCarY) return false;
    const minX=sx<ex?sx:ex, maxX=sx>ex?sx:ex;
    const maxY=sy>ey?sy:ey;
    const minZ=sz<ez?sz:ez, maxZ=sz>ez?sz:ez;
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    for (let i=0;i<n;i++) {
      const car=cars[i];
      if (car===ignoreCar || !car.alive) continue;
      if (rayCarAny(car,sx,sy,sz,dx,dy,dz,minX,maxX,minY,maxY,minZ,maxZ,limit)) return true;
    }
    return false;
  }

  // ---- Boarding & Exiting ([R] key / transport button) ----
  option(actor) {
    if (!actor || actor.down>0 || actor.ride || actor.lift || zoneOf(actor.x)!==0) return null;
    if (actor.car) {
      return {kind:'car-exit',car:actor.car,label:'車から降りる'};
    }
    let nearest=null, best=CAR_ENTER_RANGE;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (!car.alive || car.driver) continue;
      const dx=actor.x-car.x, dz=actor.z-car.z;
      const maxD=best+car.w*.5;
      if (dx*dx+dz*dz>=maxD*maxD || Math.abs(car.y-actor.y)>=2.4) continue;
      syncCarTrig(car);
      const lx=Math.abs(dx*car._fx+dz*car._fz), lz=Math.abs(dx*car._rx+dz*car._rz);
      const ex=lx>car.w*.5?lx-car.w*.5:0, ez=lz>car.d*.5?lz-car.d*.5:0;
      const edgeDist=Math.sqrt(ex*ex+ez*ez);
      if (edgeDist<=2.85) {
        best=edgeDist; nearest=car;
      }
    }
    return nearest?{kind:'car-enter',car:nearest,label:'🚗 車に乗る'}:null;
  }

  enter(actor,car) {
    if (!actor || !car || !car.alive || car.driver || actor.car || actor.down>0 || actor.ride || actor.lift) return false;
    const b=this.battle;
    if (actor.giant || actor.beaming || actor.slam) b.abilities.clearSuper(actor);
    car.driver=actor;
    car.ownerTeam=actor.team;
    // Suspension compression bounce when hopping into the driver's seat!
    car.susVel=-.95;
    car.rpm=1450;
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
    car.braking=false;
    car.drifting=false;
    car.susVel=.65;
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
    // Chassis shudders on impact!
    car.susVel-=.72;
    car.impactShake=Math.min(1,(car.impactShake??0)+.45);
    car.stain=clamp(1-car.hp/car.maxHp,0,1);
    if (attackerTeam>=0) car.stainTeam=attackerTeam;
    else if (car.stainTeam<0) car.stainTeam=2;
    const p=point ?? [car.x,car.y+car.h*.65,car.z];
    b.burst(p,attackerTeam,8,2.7);
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
    car.drifting=false; car.braking=false; car.boostFlame=0;
    car.explodedAt=b.clock;
    car.explodeTeam=team;
    car.respawnAt=b.elapsed+CAR_RESPAWN_SECONDS;
    if (driver) {
      this.exit(driver,true);
      driver.x=cx; driver.y=cy+.1; driver.z=cz;
    }
    // Massive ink splash & multi-layered shockwave rings
    const floor=b.world.floor(cx,cz);
    if (team>=0 && b.paint.hasSurface(cx,cz,floor.layer)) {
      const painted=b.paint.stampGround(cx,cz,6.2*PAINT_RADIUS_FACTOR,team,floor.layer,0,.095);
      if (source && source.team>=0) source.painted=(source.painted??0)+painted;
    }
    b.burst([cx,cy+1.1,cz],team,42,8.4);
    b.addInkImpact?.({p:[cx,cy+1.25,cz],team:Math.max(0,team),kind:2});
    b.abilities.rings.push({x:cx,y:floor.y+.08,z:cz,r:CAR_EXPLOSION_RADIUS,team:Math.max(0,team),until:b.clock+.82});
    b.abilities.rings.push({x:cx,y:floor.y+.14,z:cz,r:CAR_EXPLOSION_RADIUS*.6,team:1,until:b.clock+.52});
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
      if (source && source.team>=0 && target.team===source.team && target!==driver) continue;
      const dx=target.x-cx, dz=target.z-cz, dist=Math.hypot(dx,dz);
      if (dist>CAR_EXPLOSION_RADIUS || Math.abs(target.y-cy)>4.2) continue;
      const falloff=clamp(1-.55*(dist/CAR_EXPLOSION_RADIUS),.42,1);
      const dmg=CAR_EXPLOSION_DAMAGE*falloff;
      const inv=1/Math.max(.3,dist);
      if (!target.isBoss && !target.isGoat && !target.isSniper && !target.isRogueDrone && !target.isHeli) {
        b.stepActor(target,dx*inv*2.8,dz*inv*2.8);
      }
      b.damage(target,dmg,source,[target.x,target.y+.9,target.z],'carBomb');
    }

    // Chain-reaction blast damage to neighboring cars!
    this.damageArea(cx,cy,cz,CAR_EXPLOSION_RADIUS*.9,CAR_EXPLOSION_DAMAGE*.65,source,car);
  }

  // ---- Upgraded 4-Wheel Suspension, Drift, Gear & Driving Dynamics Engine ----
  drive(actor,input,dt) {
    const car=actor?.car;
    if (!car || !car.alive) return false;
    const b=this.battle;
    const throttle=clamp(input.z??0,-1,1);
    const steerInput=clamp(input.x??0,-1,1);
    const handbrake=!!input.jump;

    const prevSpeed=car.speed;
    const prevGear=car.gear ?? 1;
    const wasDrifting=!!car.drifting;

    // Archetype handling tuning: coupe is snappy/fast, pickup has torque, van is heavy rammer
    const topFwd=car.style===0?17.6:car.style===1?16.4:15.2;
    const topRev=-9.2;
    const accelRate=car.style===0?22.5:car.style===1?20.5:18.2;

    const braking=(throttle<-.08 && car.speed>.8) || (throttle>.08 && car.speed<-.8) || (handbrake && Math.abs(car.speed)>1.5 && Math.abs(steerInput)<.15);
    car.braking=braking;
    car.throttle=throttle;

    // Active powerslide drift when holding Space while steering at speed!
    const canDrift=handbrake && car.speed>4.4 && Math.abs(steerInput)>.12;
    car.drifting=canDrift;
    if (canDrift) {
      car.driftCharge=Math.min(1.4,(car.driftCharge??0)+dt);
    } else if (wasDrifting && (car.driftCharge??0)>.45 && throttle>.2) {
      // Mini-turbo exit boost out of a clean drift!
      car.speed=Math.min(topFwd+2.6,car.speed+3.4);
      car.boostFlame=.55;
      car.susVel-=.7;
      car.driftCharge=0;
      if (actor.isPlayer) b.callbacks.sound?.('drone');
    } else {
      car.driftCharge=Math.max(0,(car.driftCharge??0)-dt*2.5);
    }

    // Longitudinal engine torque, braking, and rolling/aerodynamic drag
    if (throttle>.05) {
      const boostMul=car.boostFlame>0?1.32:1;
      const accel=car.speed<0?38:accelRate*boostMul*(car.drifting?.86:1);
      const cap=car.boostFlame>0?topFwd+2.6:topFwd;
      car.speed=Math.min(cap,car.speed+accel*throttle*dt);
      if (prevSpeed<2.5 && throttle>.7) car.boostFlame=Math.max(car.boostFlame??0,.28);
    } else if (throttle<-.05) {
      const accel=car.speed>0?40:15.5;
      car.speed=Math.max(topRev,car.speed+accel*throttle*dt);
    } else {
      const drag=(handbrake?24:9.2)*dt;
      car.speed=Math.abs(car.speed)<=drag?0:car.speed-Math.sign(car.speed)*drag;
    }

    // Speed-sensitive steering & powerslide slip angle
    const targetSteer=steerInput*(canDrift?.68:.54);
    car.steer=mix(car.steer,targetSteer,1-Math.exp(-dt*16));
    const speedMag=Math.abs(car.speed);
    if (speedMag>.22) {
      const dirSign=car.speed>=0?1:-1;
      const lowSpeedGrip=clamp(speedMag/3.8,.32,1);
      const highSpeedStability=clamp(1.08-speedMag*.018,.78,1.05);
      const turnRate=(canDrift?3.45:2.48)*lowSpeedGrip*highSpeedStability;
      car.yaw=angleDiff(0,car.yaw+steerInput*dirSign*turnRate*dt);
    }

    // Slip angle sweeps rear end visually outward during powerslide drifts
    const targetDrift=canDrift?steerInput*.38:0;
    car.driftAngle=mix(car.driftAngle??0,targetDrift,1-Math.exp(-dt*(canDrift?9:7)));

    const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
    const dx=fx*car.speed*dt, dz=fz*car.speed*dt;
    const oldX=car.x, oldZ=car.z, oldY=car.y;

    const canPlace=(nx,nz)=>{
      const lx=localX(nx);
      if (Math.abs(lx)>53.5 || Math.abs(nz)>33.5) return null;
      if (stairLane(nx,nz,.9)) return null;
      const fl=b.world.support(nx,car.y+.55,nz);
      if (Math.abs(fl.y-car.y)>.62) return null;
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
      const slideX=canPlace(car.x+dx,car.z);
      const slideZ=canPlace(car.x,car.z+dz);
      if (slideX) {car.x+=dx;car.y=slideX.y;car.speed*=.86;car.impactShake=Math.min(1,(car.impactShake??0)+.22);}
      else if (slideZ) {car.z+=dz;car.y=slideZ.y;car.speed*=.86;car.impactShake=Math.min(1,(car.impactShake??0)+.22);}
      else {
        if (speedMag>4) {car.susVel-=.85;car.impactShake=Math.min(1,(car.impactShake??0)+.55);}
        car.speed*=-.22;
      }
    }

    // 4-Gear Automatic Transmission & RPM curve
    const speedRatio=clamp(Math.abs(car.speed)/topFwd,0,1.15);
    const gear=car.speed<-.3?0:speedRatio<.26?1:speedRatio<.54?2:speedRatio<.82?3:4;
    if (gear>prevGear && gear>=2 && throttle>.4) {
      // Subtle exhaust pop + squat impulse on upshift!
      car.boostFlame=Math.max(car.boostFlame??0,.18);
      car.susVel-=.35;
    }
    car.gear=gear;
    const gearMin=[0,0,.24,.50,.78][gear];
    const gearSpan=[.45,.30,.32,.34,.36][gear];
    const targetRpm=900+clamp((speedRatio-gearMin)/gearSpan,0,1)*5800+(Math.abs(throttle)>.1?700:0)+(canDrift?650:0);
    car.rpm=mix(car.rpm??900,clamp(targetRpm,900,7600),1-Math.exp(-dt*12));

    // Real 3D Suspension Physics: slope alignment + accel squat + brake dive + cornering roll + spring-damper bounce!
    const frontFl=b.world.support(car.x+fx*(car.w*.42),car.y+.6,car.z+fz*(car.w*.42));
    const rearFl=b.world.support(car.x-fx*(car.w*.42),car.y+.6,car.z-fz*(car.w*.42));
    const slopePitch=Math.abs(frontFl.y-rearFl.y)<1.2?Math.atan2(frontFl.y-rearFl.y,car.w*.84):0;
    const longAccel=(car.speed-prevSpeed)/Math.max(.001,dt);
    // Positive pitch lifts the nose (accel squat); negative dips the nose (hard braking)
    const dynamicPitch=clamp(longAccel*.0042+(car.boostFlame>0?.035:0),-.095,.085);
    car.pitch=mix(car.pitch??0,clamp(slopePitch+dynamicPitch,-.24,.24),1-Math.exp(-dt*12));

    // Body roll leans outward against centrifugal cornering force
    const targetRoll=clamp(-steerInput*car.speed*(canDrift?.016:.011),-.17,.17);
    car.roll=mix(car.roll??0,targetRoll,1-Math.exp(-dt*11));

    // Vertical suspension spring-damper reacts to road elevation jumps
    const dyRoad=car.y-oldY;
    if (Math.abs(dyRoad)>.02) car.susVel-=clamp(dyRoad*12,-.9,.9);
    const springF=-92*(car.susY??0)-13*(car.susVel??0);
    car.susVel=(car.susVel??0)+springF*dt;
    car.susY=clamp((car.susY??0)+car.susVel*dt,-.16,.16);
    car.boostFlame=Math.max(0,(car.boostFlame??0)-dt);

    car.vx=(car.x-oldX)/Math.max(.001,dt);
    car.vz=(car.z-oldZ)/Math.max(.001,dt);
    car.wheelSpin+=car.speed*dt*2.85;

    // Keep driver synchronized inside cabin
    actor.x=car.x;
    actor.y=car.y+.25;
    actor.z=car.z;
    actor.vx=car.vx;
    actor.vz=car.vz;
    actor.vy=0;
    actor.airborne=false;

    // 1) PAINT THE ROAD WITH DRIVER'S OWN INK + DRIFT SPRAY PLUMES!
    car.paintTimer-=dt;
    const actualSpeed=Math.hypot(car.vx,car.vz);
    if (actualSpeed>=.6 && car.paintTimer<=0 && actor.team>=0) {
      car.paintTimer=.052;
      const rx=Math.cos(car.yaw), rz=Math.sin(car.yaw);
      const tread=car.d*.38;
      const paintR=car.d*(canDrift?.60:.52)*PAINT_RADIUS_FACTOR;
      for (const side of [-1,0,1]) {
        const px=car.x+rx*side*tread-fx*.35;
        const pz=car.z+rz*side*tread-fz*.35;
        const fl=b.world.support(px,car.y+.3,pz);
        if (Math.abs(fl.y-car.y)>.6) continue;
        if (!fl.raised && b.paint.hasSurface(px,pz,fl.layer)) {
          const gained=b.paint.stampGround(px,pz,paintR,actor.team,fl.layer,car.wheelSpin,.054);
          actor.painted+=gained;
          if (gained>0) b.paint.kick(px,pz,fl.layer,car.vx*.48,car.vz*.48);
        }
      }
      // Twin rear tire ink rooster-tails & drift sparks
      if (actualSpeed>4.5) {
        const sprayCount=canDrift?2:1;
        for (let k=0;k<sprayCount;k++) {
          const tireSide=k===0?-1:1;
          b.drops.push({
            p:[car.x-fx*car.w*.42+rx*tireSide*car.d*.46,car.y+.22,car.z-fz*car.w*.42+rz*tireSide*car.d*.46],
            v:[-car.vx*.22+rx*tireSide*(canDrift?3.6:1.2)+(b.rng()-.5)*2.0,
               (canDrift?3.1:2.1)+b.rng()*1.4,
               -car.vz*.22+rz*tireSide*(canDrift?3.6:1.2)+(b.rng()-.5)*2.0],
            team:actor.team,size:canDrift?.18:.13,life:.36,max:.36
          });
        }
      }
    }

    // 2) RAM / RUN OVER ENEMIES!
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
      const impactBase=140+speed*24;
      const sideSign=lz>=0?1:-1;
      const pushX=fx*2.2+rx*sideSign*1.8, pushZ=fz*2.2+rz*sideSign*1.8;
      if (!target.isBoss && !target.isGoat) b.stepActor(target,pushX,pushZ);
      b.damage(target,impactBase,driver,[target.x,target.y+.9,target.z],'car');
      b.burst([target.x,target.y+.85,target.z],driver.team,16,4.8);
      b.addInkImpact?.({p:[target.x,target.y+.95,target.z],team:driver.team,kind:(target.down??0)>0?2:1});
      car.susVel-=1.1;
      car.impactShake=1;
      car.speed*=.91;
    }
  }

  update(dt) {
    const b=this.battle;
    let maxCarY=0;
    for (let i=0;i<this.cars.length;i++) {
      const car=this.cars[i];
      if (!car.alive) {
        if (car.respawnAt>0 && b.elapsed>=car.respawnAt) {
          const occupied=b.actors.some(a=>a.down<=0 && sameLevel(a.x,car.spawnX) && Math.hypot(a.x-car.spawnX,a.z-car.spawnZ)<3.2);
          if (!occupied) {
            Object.assign(car,{
              x:car.spawnX,y:car.spawnY,z:car.spawnZ,yaw:car.spawnYaw,
              vx:0,vz:0,speed:0,steer:0,pitch:0,roll:0,driftAngle:0,susY:0,susVel:0,
              rpm:900,gear:1,throttle:0,braking:false,drifting:false,driftCharge:0,boostFlame:0,impactShake:0,
              alive:true,hp:car.maxHp,stain:0,stainTeam:-1,ownerTeam:-1,driver:null,respawnAt:0
            });
            const topY=car.y+car.h; if (topY>maxCarY) maxCarY=topY;
          }
        }
        continue;
      }
      car.impactShake=Math.max(0,(car.impactShake??0)-dt*4.5);
      if (car.driver && (car.driver.down>0 || car.driver.car!==car)) {
        if (car.driver.car===car) car.driver.car=null;
        car.driver=null;
      }
      // Settle empty car suspension, pitch, roll, rpm, and coasting speed
      if (!car.driver) {
        car.braking=false; car.drifting=false; car.boostFlame=Math.max(0,(car.boostFlame??0)-dt*2);
        car.rpm=mix(car.rpm??900,900,1-Math.exp(-dt*6));
        car.pitch=mix(car.pitch??0,0,1-Math.exp(-dt*8));
        car.roll=mix(car.roll??0,0,1-Math.exp(-dt*8));
        car.driftAngle=mix(car.driftAngle??0,0,1-Math.exp(-dt*8));
        const springF=-92*(car.susY??0)-14*(car.susVel??0);
        car.susVel=(car.susVel??0)+springF*dt;
        car.susY=clamp((car.susY??0)+car.susVel*dt,-.16,.16);
        if (Math.abs(car.speed)>.05) {
          const drag=14*dt;
          car.speed=Math.abs(car.speed)<=drag?0:car.speed-Math.sign(car.speed)*drag;
          const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
          const nx=car.x+fx*car.speed*dt, nz=car.z+fz*car.speed*dt;
          if (Math.abs(localX(nx))<53.5 && Math.abs(nz)<33.5 && !b.world.blocked(nx,car.y+.05,nz,car.d*.46,car.h)) {
            car.x=nx; car.z=nz;
            car.wheelSpin+=car.speed*dt*2.85;
          } else {
            car.speed=0;
          }
        }
      }
      const topY=car.y+car.h; if (topY>maxCarY) maxCarY=topY;
      // Dripping enemy ink & warning sparks when heavily dyed by enemy ink (>= 65%)
      if (car.stain>=.65 && b.rng()<dt*(8+car.stain*12)) {
        b.drops.push({
          p:[car.x+(b.rng()-.5)*1.4,car.y+1.35,car.z+(b.rng()-.5)*1.4],
          v:[(b.rng()-.5)*2.1,2.6+b.rng()*2.2,(b.rng()-.5)*2.1],
          team:car.stainTeam>=0?car.stainTeam:1,
          size:.19,life:.48,max:.48
        });
      }
    }
    this._maxCarY=maxCarY+.35;
  }

  // ---- Cloud Snapshot & Checkpoint Serialization ----
  snapshot(zone,mergeStairs=false) {
    if (zone!==0 && !mergeStairs) return [];
    const q=n=>Math.round(n*100)/100;
    return this.cars.map(c=>({
      id:c.id,x:q(c.x),y:q(c.y),z:q(c.z),yaw:q(c.yaw),speed:q(c.speed),steer:q(c.steer),
      wheelSpin:q(c.wheelSpin),pitch:q(c.pitch),roll:q(c.roll),driftAngle:q(c.driftAngle??0),
      susY:q(c.susY??0),rpm:Math.round(c.rpm??900),gear:c.gear??1,
      braking:!!c.braking,drifting:!!c.drifting,boostFlame:q(c.boostFlame??0),
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
      pitch:c.pitch??0,roll:c.roll??0,driftAngle:c.driftAngle??0,susY:c.susY??0,
      rpm:c.rpm??900,gear:c.gear??1,
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

  // ---- High-Craft Dynamic 3D Vehicle Rendering (Zero-Alloc Hot Path) ----
  draw(r,viewX,viewZ,clock) {
    if (zoneOf(viewX)!==0) return;
    const reach=r.reach??Infinity, lim2=reach===Infinity?Infinity:(reach+12)*(reach+12);
    const raining=!!this.battle.hazards?.rain?.active;
    const hasFrustum=typeof r.inFrustum==='function';
    const cars=this.cars;
    for (let i=0;i<cars.length;i++) {
      const car=cars[i];
      const dx=car.x-viewX, dz=car.z-viewZ, d2=dx*dx+dz*dz;
      if (lim2!==Infinity && d2>lim2) continue;
      if (!car.alive) {
        const age=clock-car.explodedAt;
        if (age>=0 && age<1.55) {
          if (!hasFrustum || r.inFrustum(car.x,car.y+1.8,car.z,CAR_EXPLOSION_RADIUS+2)) {
            drawExplosionDebris(r,car,age);
          }
        }
        continue;
      }
      drawVehicle(r,car,clock,Math.sqrt(d2),raining,hasFrustum);
    }
  }
}

function drawVehicle(r,car,clock,dist=10,raining=false,hasFrustum=false) {
  const {x,y,z,yaw,w,d,style,baseTint,stain,stainTeam,driver,hitFlash}=car;
  const hi=!r.lite && !r.ultralite && dist<42;
  const inView=!hasFrustum || r.inFrustum(x,y+1,z,w+2.4);

  // Soft grounded AO contact shadow beneath the car (skipped cleanly when off-screen!)
  const visualYaw=yaw+(car.driftAngle??0);
  if (inView) {
    _vShadeOpts.yaw=visualYaw-T;
    r.add('shade',x,y+.018,z,w*1.14,1,d*1.30,0,28,_vShadeOpts);
    if (!driver && dist<16) {
      const bob=Math.sin(clock*4.2+car.index)*.11;
      const hover=dist<CAR_ENTER_RANGE+2;
      _vRipOpts.label=(clock*.85+car.index*.2)%1;
      r.add('ripple',x,y+.06,z,w+2.0,.04,w+2.0,hover?0x38ffe0:0xa5e6dc,12,_vRipOpts);
      r.add('orb',x,y+car.h+.78+bob,z,.24,.30,.24,hover?0x38ffe0:0xc4efe6,3,_vDyn);
    }
  }

  // Stationary parked car fast path: blast-copy pre-packed Float32 templates in ~4 memcpy calls (works in rain too!).
  if (!driver && car.speed===0 && stain<=.03 && clock-hitFlash>=.10 &&
      !car.braking && !car.drifting && !(car.boostFlame>0) && !(car.impactShake>0) &&
      Math.abs(car.susY??0)<1e-4 && Math.abs(car.pitch??0)<1e-4 &&
      Math.abs(car.roll??0)<1e-4 && Math.abs(car.driftAngle??0)<1e-4 &&
      typeof r.addPacked==='function') {
    const spin=car.wheelSpin??0, steer=car.steer??0;
    let tpl=hi?car._tplHi:car._tplLo;
    if (!tpl || tpl.x!==x || tpl.y!==y || tpl.z!==z || tpl.yaw!==yaw || tpl.steer!==steer || tpl.spin!==spin) {
      const buckets=recordCarTemplate(rec=>drawVehicleBody(rec,car,0,hi,false,false,hi));
      tpl={x,y,z,yaw,steer,spin,buckets};
      if (hi) car._tplHi=tpl; else car._tplLo=tpl;
    }
    const buckets=tpl.buckets, rad=car._rBound+.5, cy=y+car.h*.5;
    for (let i=0;i<buckets.length;i++) r.addPacked(buckets[i][0],buckets[i][1],x,cy,z,rad);
    if (hi && inView) {
      const bf0=Math.sin(yaw), bf2=-Math.cos(yaw), br0=Math.cos(yaw), br2=Math.sin(yaw);
      chassisBasisInto(yaw,-.42,0,_vAuxBasis);
      const wipePhase=raining?Math.sin(clock*6.4)*.5+.5:0;
      const wy=.98+Math.sin(wipePhase*Math.PI)*.14;
      for (let k=0;k<2;k++) {
        const wz=(k===0?-.32:.14)+wipePhase*.28;
        r.add('box',x+bf0*.81+br0*wz,y+wy,z+bf2*.81+br2*wz,.022,.026,.34,0x151c20,4,_vAuxOpts);
      }
    }
    return;
  }

  drawVehicleBody(r,car,clock,hi,raining,inView,false);
}

function drawVehicleBody(r,car,clock,hi,raining,inView,skipWipers=false) {
  const {x,y,z,yaw,w,d,style,baseTint,stain,stainTeam,driver,hitFlash}=car;
  const visualYaw=yaw+(car.driftAngle??0);
  const inkColor=INK_COLORS[stainTeam>=0?stainTeam:1] ?? INK_COLORS[1];
  const flash=clock-hitFlash<.10?.38:0;
  const warnPulse=stain>=.72 && Math.sin(clock*22)>0?.26:0;
  // Clearcoat metallic paint smoothly dyes toward enemy ink color as stain builds!
  const bodyTint=lerpRgb(baseTint,inkColor,clamp(stain*.92+flash*.4,0,1));
  const roofTint=lerpRgb(baseTint,inkColor,clamp(stain*1.05+warnPulse,0,1));
  const trim=0x9ba6a4, chrome=0xcfd6d2, darkMetal=0x2c363b, rubber=0x1e2629, glass=driver?0x4c7e8f:0x36525c;
  const bodyMat=20; // Metallic armor clearcoat sheen for automotive lacquer!

  // Full 3D sprung chassis coordinate frame (yaw+drift, pitch squat/dive, cornering roll, engine idle hum)
  const idleVib=driver?Math.sin(clock*(32+(car.rpm??900)*.008))*.0048:0;
  const shake=(car.impactShake??0)*Math.sin(clock*58)*.048;
  const bodyLift=(car.susY??0)+idleVib;
  const cPitch=(car.pitch??0)+shake*.4, cRoll=(car.roll??0)+shake;
  chassisBasisInto(visualYaw,cPitch,cRoll,_vBasis);
  const bf=_vBasis[0], bu=_vBasis[1], br=_vBasis[2];
  const bf0=bf[0], bf1=bf[1], bf2=bf[2];
  const bu0=bu[0], bu1=bu[1], bu2=bu[2];
  const br0=br[0], br1=br[1], br2=br[2];
  const p=(type,dx,dy,dz,sx,sy,sz,c,k=bodyMat)=>{
    const ly=dy+bodyLift;
    r.add(type,x+bf0*dx+bu0*ly+br0*dz,y+bf1*dx+bu1*ly+br1*dz,z+bf2*dx+bu2*ly+br2*dz,sx,sy,sz,c,k,_vOpts);
  };
  const pAux=(type,dx,dy,dz,sx,sy,sz,c,k,o)=>{
    const ly=dy+bodyLift;
    r.add(type,x+bf0*dx+bu0*ly+br0*dz,y+bf1*dx+bu1*ly+br1*dz,z+bf2*dx+bu2*ly+br2*dz,sx,sy,sz,c,k,o);
  };

  // ---- 1. Sculpted Chassis, Hood, Fenders, Side Intakes & Underbody ----
  p('box',0,.38,0,w-.16,.24,d-.08,darkMetal,4);
  p('bevel',0,.64,0,w-.04,.44,d,bodyTint,bodyMat);
  p('bevel',.38,.87,0,w-.86,.24,d-.12,bodyTint,bodyMat);
  p('bevel',w/2-.60,.82,0,1.14,.18,d-.12,bodyTint,bodyMat);
  if (hi) {
    for (let s=-1;s<=1;s+=2) {
      p('box',w/2-.62,.925,s*.28,.46,.026,.22,darkMetal,4); // hood vents
      p('box',-.42,.66,s*(d/2+.018),.48,.16,.03,0x192124,4); // side aero brake ducts
    }
  }
  p('bevel',-w/2+.56,.85,0,1.06,.24,d-.10,bodyTint,bodyMat);

  // ---- 2. Front Fascia, Slatted Grille, Tow Hooks, Bumpers, LED Headlights, Turn Signals & Exhausts ----
  p('bevel',w/2-.04,.43,0,.22,.16,d+.10,darkMetal,4);
  p('box',w/2+.05,.32,0,.16,.055,d+.04,rubber,21); // front chin splitter
  p('bevel',-w/2+.04,.44,0,.22,.17,d+.10,darkMetal,4);
  p('box',-w/2-.04,.33,0,.12,.08,d*.76,0x1d2528,4); // rear diffuser
  p('box',w/2-.01,.63,0,.12,.22,d-.48,0x1d2629,4);
  if (hi) {
    p('box',w/2+.055,.57,0,.02,.018,d-.54,chrome,4);
    p('box',w/2+.055,.63,0,.02,.018,d-.54,chrome,4);
    p('box',w/2+.055,.69,0,.02,.018,d-.54,chrome,4);
    p('orb',w/2+.07,.64,0,.04,.07,.10,chrome,4);
    // Front forged tow hook loop
    p('ring',w/2+.12,.38,-.44,.09,.028,.09,0xe63b32,4);
  }
  p('box',-(w/2+.065),.48,0,.022,.13,.38,0xe6e7dc,0);
  p('box',w/2+.065,.48,0,.022,.13,.38,0xe6e7dc,0);

  // LED Headlights, DRL Eyebrows, Sequential Steering Turn Signals, Brake & Reverse Lamps!
  const headBright=driver?0xfffce0:0xede3c4;
  const brakeActive=!!car.braking;
  const reverseActive=car.speed<-.35;
  const tailColor=brakeActive?0xff2218:driver?0xd63626:0x8e2c22;
  const blinkOn=driver && Math.sin(clock*13)>0;
  const steerDir=car.steer??0;
  const teamColor=driver?(TEAM_INK[driver.team] ?? 0xffffff):0xffffff;
  for (let s=-1;s<=1;s+=2) {
    const oz=s*.56;
    const turningThisSide=blinkOn && (s<0?steerDir<-.14:steerDir>.14);
    p('bevel',w/2+.01,.73,oz,.09,.17,.36,darkMetal,4);
    p('box',w/2+.055,.74,oz,.035,.12,.28,headBright,3);
    p('box',w/2+.06,.66,oz,.03,.034,.26,turningThisSide?0xffb820:0x9e7830,turningThisSide?3:4);
    if (hi) p('box',w/2+.058,.81,oz,.026,.022,.32,driver?0xffffff:0xdce8e6,3); // crisp DRL eyebrow
    if (driver && hi && inView) p('orb',w/2+.55,.55,oz,.65,.34,.55,0xfff6d2,3);
    p('bevel',-w/2-.01,.74,oz,.08,.17,.38,darkMetal,4);
    p('box',-w/2-.052,.75,oz,.036,.12,.30,tailColor,3);
    if (turningThisSide) p('box',-w/2-.058,.75,s*.74,.034,.11,.08,0xffb820,3);
    if (reverseActive) p('box',-w/2-.058,.66,oz*.72,.03,.05,.12,0xffffff,3);
  }
  // Center high-mount 3rd brake light strip on rear roof edge when braking!
  if (brakeActive) p('box',-w/2+.98,1.38,0,.04,.045,.66,0xff2218,3);

  // Twin Chrome Exhaust Tailpipes + Pulsing Turbo Flames + Backfire Shock-Rings!
  _vExBasis[0][0]=bu0; _vExBasis[0][1]=bu1; _vExBasis[0][2]=bu2;
  _vExBasis[1][0]=bf0; _vExBasis[1][1]=bf1; _vExBasis[1][2]=bf2;
  _vExBasis[2][0]=br0; _vExBasis[2][1]=br1; _vExBasis[2][2]=br2;
  const bfFlame=car.boostFlame??0;
  for (let s=-1;s<=1;s+=2) {
    const ez=s*.42;
    pAux('cylinder',-w/2-.08,.33,ez,.10,.22,.10,chrome,4,_vExOpts);
    pAux('cylinder',-w/2-.18,.33,ez,.07,.04,.07,0x101416,4,_vExOpts);
    if (driver && inView && (bfFlame>0 || (car.throttle>.5 && car.speed>2))) {
      const fLen=bfFlame>0?.48+.20*Math.sin(clock*52):.20+.07*Math.sin(clock*38);
      const flameColor=bfFlame>0?0x66e8ff:0xffa83c;
      _vAuxBasis[0][0]=bu0; _vAuxBasis[0][1]=bu1; _vAuxBasis[0][2]=bu2;
      _vAuxBasis[1][0]=-bf0; _vAuxBasis[1][1]=-bf1; _vAuxBasis[1][2]=-bf2;
      _vAuxBasis[2][0]=br0; _vAuxBasis[2][1]=br1; _vAuxBasis[2][2]=br2;
      pAux('cone',-w/2-.22-fLen*.4,.33,ez,.12,fLen,.12,flameColor,3,_vAuxOpts);
      if (bfFlame>0) {
        p('orb',-w/2-.24,.33,ez,.13,.13,.13,0xffffff,3);
        if (hi) {
          // Expanding plasma backfire shock-ring popping out of tailpipe!
          const rp=(clock*9+s*.3)%1;
          const rSize=.14+rp*.26;
          pAux('ring',-w/2-.24-rp*.55,.33,ez,rSize,.028,rSize,0x7cf0ff,3,_vAuxOpts);
        }
      }
    }
  }

  // ---- 3. Cabin, Reflective Windows, Pillars, Mirrors, Door Handles, Wipers & Animated Cockpit ----
  for (let s=-1;s<=1;s+=2) {
    p('box',0,.34,s*(d/2+.02),w*.52,.09,.07,darkMetal,4);
    p('box',0,.53,s*(d/2+.025),1.78,.04,.04,chrome,4);
    p('box',-.08,1.11,s*(d/2-.12),1.70,.44,.05,glass,8);
    p('box',-.82,1.12,s*(d/2-.115),.09,.50,.085,bodyTint,bodyMat);
    p('box',-.12,1.14,s*(d/2-.105),.075,.46,.075,darkMetal,4);
    p('box',.72,1.12,s*(d/2-.115),.09,.50,.085,bodyTint,bodyMat);
    p('box',-.34,.89,s*(d/2+.015),.20,.042,.045,chrome,4);
    p('box',.34,.89,s*(d/2+.015),.20,.042,.045,chrome,4);
    p('box',.62,1.01,s*(d/2+.06),.07,.045,.15,darkMetal,4);
    p('bevel',.64,1.06,s*(d/2+.16),.18,.13,.19,bodyTint,bodyMat);
  }
  p('bevel',-.09,1.39,0,1.68,.11,d-.20,roofTint,bodyMat);
  chassisBasisInto(visualYaw,cPitch-.42,cRoll,_vAuxBasis);
  pAux('box',.75,1.15,0,.072,.50,d-.20,glass,8,_vAuxOpts);
  // Animated Working Windshield Wipers sweep automatically during rain or enemy ink contamination!
  if (hi && !skipWipers) {
    const wipeActive=raining || stain>.15;
    const wipePhase=wipeActive?Math.sin(clock*6.4)*.5+.5:0;
    for (let k=0;k<2;k++) {
      const wz=(k===0?-.32:.14)+wipePhase*.28;
      const wy=.98+Math.sin(wipePhase*Math.PI)*.14;
      pAux('box',.81,wy,wz,.022,.026,.34,0x151c20,4,_vAuxOpts);
    }
  }
  chassisBasisInto(visualYaw,cPitch+.35,cRoll,_vAuxBasis);
  pAux('box',-.92,1.17,0,.076,.48,d-.22,glass,8,_vAuxOpts);
  if (hi) {
    // Interior dashboard, glowing dash cluster, turning steering wheel & sport headrests!
    p('box',.52,.95,0,.34,.18,d-.34,0x1f282b,21);
    if (driver) p('box',.41,1.01,-.26,.04,.07,.32,teamColor,3); // illuminated HUD gauge cluster
    p('ring',.34,1.02,-.28,.22,.03,.22,rubber,21); // steering wheel
    p('box',.34,1.02,-.28+steerDir*.06,.03,.18,.04,chrome,4); // turning steering spoke!
    p('soft',-.18,1.08,-.34,.16,.28,.28,0x2a3338,21);
    p('soft',-.18,1.08,.34,.16,.28,.28,0x2a3338,21);
  }

  // ---- 4. Archetype Signature Equipment & Active Aero Animations ----
  if (style===0) {
    // Street GT Coupe: ACTIVE DRS Rear Wing (airbrake tilt under braking, sleek flat on turbo!) + underbody team neon!
    const wingPitch=brakeActive?.42:bfFlame>0?-.12:.06;
    p('box',-w/2+.36,1.06,-.52,.12,.22,.05,darkMetal,4);
    p('box',-w/2+.36,1.06,.52,.12,.22,.05,darkMetal,4);
    chassisBasisInto(visualYaw,cPitch+wingPitch,cRoll,_vAuxBasis);
    pAux('bevel',-w/2+.32,1.19,0,.28,.055,d+.04,darkMetal,4,_vAuxOpts);
    for (let s=-1;s<=1;s+=2) p('box',-w/2+.32,1.19,s*(d*.5+.03),.32,.14,.03,bodyTint,bodyMat);
    p('bevel',-.72,1.47,0,.22,.09,.04,darkMetal,4);
    if (driver && hi && inView) {
      // Glowing team-ink underbody ground-effect neon strip!
      p('box',0,.23,-(d*.48),w*.56,.03,.04,teamColor,3);
      p('box',0,.23,d*.48,w*.56,.03,.04,teamColor,3);
    }
  } else if (style===1) {
    // Tactical Pickup Truck: front bull-bar, roll-bar with alternating flashing rally lights, bed struts & spare tire!
    p('bevel',w/2+.14,.62,0,.10,.34,d*.74,darkMetal,4);
    p('orb',w/2+.20,.68,-.36,.14,.14,.08,0xffe8a0,3);
    p('orb',w/2+.20,.68,.36,.14,.14,.08,0xffe8a0,3);
    p('box',-w/2+.57,.955,0,1.12,.11,d-.12,0x76827c,4);
    for (let s=-1;s<=1;s+=2) {
      p('box',-w/2+.55,1.08,s*(d/2-.09),1.22,.22,.12,bodyTint,bodyMat);
      p('box',-.76,1.38,s*(d/2-.18),.08,.56,.08,darkMetal,4);
    }
    p('box',-.76,1.64,0,.09,.08,d-.32,darkMetal,4);
    const strobe=driver && Math.abs(car.speed)>2.5?Math.floor(clock*10)%2:-1;
    for (let k=0;k<4;k++) {
      const lz=-.42+k*.28;
      const lit=strobe>=0 && (k%2===strobe);
      p('orb',-.72,1.72,lz,.11,.10,.12,lit?teamColor:driver?0xfff6c0:0xd4a852,3);
    }
    if (hi) p('cylinder',-w/2+.55,.26,0,.62,.20,.62,rubber,21); // under-bed spare wheel
  } else if (style===2) {
    // Armored Delivery Cargo Van: corrugated cargo box, sliding door track, roof utility rack & animated caution beacon!
    const cargoTint=lerpRgb(0xd7d4bc,inkColor,clamp(stain*.95,0,1));
    p('bevel',-w/2+.86,1.22,0,1.78,.94,d-.06,cargoTint,2);
    if (hi) {
      for (let i=0;i<5;i++) {
        const rx=-w/2+.18+i*.34;
        p('box',rx,1.22,-(d/2-.01),.055,.80,.045,trim,4);
        p('box',rx,1.22,d/2-.01,.055,.80,.045,trim,4);
      }
      // Roof rack + rear cargo door seam & bumper step
      p('box',-.42,1.74,-.68,1.95,.05,.05,chrome,4);
      p('box',-.42,1.74,.68,1.95,.05,.05,chrome,4);
      p('box',-1.2,1.72,0,.06,.04,1.38,chrome,4);
      p('box',-.42,1.72,0,.06,.04,1.38,chrome,4);
      p('box',.36,1.72,0,.06,.04,1.38,chrome,4);
      p('box',-w/2-.04,1.22,0,.03,.86,.04,darkMetal,4); // dual rear door seam
    }
    for (let k=-1;k<=1;k++) p('orb',.54,1.50,k*.62,.08,.07,.10,0xffa834,3);
    if (driver) {
      // Animated pulsing roof utility beacon!
      const bPulse=.5+.5*Math.sin(clock*16);
      p('orb',-.42,1.80,0,.16+bPulse*.06,.14,.16+bPulse*.06,bPulse>.5?teamColor:0xffb838,3);
    }
  }

  // ---- 5. True 4-Wheel Rotating Assemblies + Compressing Coilover Shocks + Glowing Brake Discs + Drift Sparks! ----
  const wheelY=.36, spin=car.wheelSpin??0;
  const cs=Math.cos(spin), ss=Math.sin(spin);
  const driftActive=!!car.drifting && inView;
  const dCharge=car.driftCharge??0;
  const sparkTint=dCharge>=.45?0xfff4cf:dCharge>=.22?0xffa83c:0x5ce8ff;
  for (let axIdx=0;axIdx<2;axIdx++) {
    const isFront=axIdx===1, ox=isFront?w*.303:-w*.315;
    const wyaw=visualYaw+(isFront?(car.steer??0):0);
    const wfx=Math.sin(wyaw), wfz=-Math.cos(wyaw);
    const wrx=Math.cos(wyaw), wrz=Math.sin(wyaw);
    _vWBasis[0][0]=wfx*cs; _vWBasis[0][1]=ss; _vWBasis[0][2]=wfz*cs;
    _vWBasis[1][0]=wrx;    _vWBasis[1][1]=0;  _vWBasis[1][2]=wrz;
    _vWBasis[2][0]=-wfx*ss;_vWBasis[2][1]=cs; _vWBasis[2][2]=-wfz*ss;
    _vABasis[0][0]=wfx;    _vABasis[0][1]=0;  _vABasis[0][2]=wfz;
    _vABasis[1][0]=wrx;    _vABasis[1][1]=0;  _vABasis[1][2]=wrz;
    _vABasis[2][0]=0;      _vABasis[2][1]=1;  _vABasis[2][2]=0;
    for (let s=-1;s<=1;s+=2) {
      const wz=s*(d/2+.02);
      const wcx=x+bf0*ox+br0*wz, wcy=y+wheelY, wcz=z+bf2*ox+br2*wz;
      r.add('cylinder',wcx,wcy,wcz,.72,.26,.72,rubber,21,_vAOpts);
      r.add('cylinder',wcx+wrx*s*.115,wcy,wcz+wrz*s*.115,.47,.06,.47,0x6e7c7d,4,_vAOpts);
      r.add('cylinder',wcx+wrx*s*.145,wcy,wcz+wrz*s*.145,.16,.04,.16,chrome,4,_vAOpts);
      if (hi) {
        // Inner ventilated brake rotor (glows hot orange-red when hard braking!) + caliper
        const rotorTint=brakeActive && Math.abs(car.speed)>2.5?0xff6a30:0x889496;
        const rotorMat=brakeActive && Math.abs(car.speed)>2.5?3:4;
        r.add('cylinder',wcx+wrx*s*.065,wcy,wcz+wrz*s*.065,.34,.04,.34,rotorTint,rotorMat,_vAOpts);
        r.add('box',wcx+wrx*s*.075-wfx*.14,wcy+.08,wcz+wrz*s*.075-wfz*.14,.13,.18,.07,driver?teamColor:0xc43c32,4,_vAOpts);
        // Rotating twin crossed alloy spokes visibly spinning with wheelSpin!
        const spx=wcx+wrx*s*.132, spz=wcz+wrz*s*.132;
        r.add('box',spx,wcy,spz,.40,.03,.055,chrome,4,_vWOpts);
        r.add('box',spx,wcy,spz,.055,.03,.40,chrome,4,_vWOpts);
        // Visible compressing coilover suspension shock inside wheel well!
        const wellTopY=y+.64+bodyLift+bf1*ox+br1*wz;
        const strutLen=clamp(wellTopY-wcy,.12,.48);
        r.add('cylinder',wcx-wrx*s*.10,wcy+strutLen*.5,wcz-wrz*s*.10,.075,strutLen,.075,driver?teamColor:0xe0a63a,4,_vDyn);
      }
      // Escalating Drift Sparks & Ink-Tire Smoke spraying off BOTH rear tires during powerslide!
      if (!isFront && driftActive) {
        for (let k=0;k<2;k++) {
          const sp=(clock*13+k*.5+s*.23)%1;
          const back=.32+sp*1.25, lift=.08+Math.sin(sp*Math.PI)*.42, spread=(k===0?1:-1)*.18*sp;
          const sz=(1-sp)*.13;
          r.add('orb',wcx-bf0*back+br0*spread,y+.08+lift,wcz-bf2*back+br2*spread,sz,sz*1.6,sz,k===0?sparkTint:teamColor,3,_vDyn);
        }
      }
    }
  }

  // ---- 6. Occupied Cockpit Beacon & Steering-Leaning Driver Silhouette ----
  if (driver) {
    const dLean=clamp(-(car.roll??0)*1.3+steerDir*.18,-.22,.22);
    p('bevel',-.09,1.48,0,1.02,.085,.54,darkMetal,4);
    p('box',-.09,1.50,0,.88,.065,.40,teamColor,3);
    p('orb',-.02,1.14,-.28+dLean,.34,.36,.34,teamColor,3);
    p('box',.12,1.15,-.28+dLean,.08,.12,.26,0x101c22,8);
  }

  // ---- 7. Progressive Enemy Ink Dyeing, Overheat Steam & Critical Detonation Aura ----
  if (stain>.03) {
    const s=clamp(stain,0,1);
    p('bevel',w*.24,.94,0,1.18*s+.26,.055,(d-.18)*(.45+.55*s),inkColor,9);
    p('bevel',-.09,1.46,0,1.58*s+.22,.05,(d-.24)*(.45+.55*s),inkColor,9);
    for (let side=-1;side<=1;side+=2) {
      p('bevel',.15,.68,side*(d*.5+.026),w*.86*s+.38,.40*(.42+.58*s),.036,inkColor,9);
      if (s>.35) p('orb',-w*.26,.78,side*(d*.5+.02),(.45+.55*s)*.85,.34*s,.08,inkColor,9);
    }
    if (s>.55) {
      p('orb',w*.32,.96,.22,.44*s,.14,.42*s,inkColor,9);
      p('orb',-.48,1.45,-.18,.52*s,.12,.48*s,inkColor,9);
    }
    // Rising dark-ink overheat steam puffs from the hood as enemy ink nears detonation!
    if (s>=.62 && hi && inView) {
      for (let k=0;k<2;k++) {
        const sp=(clock*2.4+k*.5+car.index*.17)%1;
        const ps=(.14+sp*.26)*(1-sp*.6);
        p('orb',w*.28+Math.sin(clock*5+k)*sp*.18,.98+sp*1.05,(k===0?-.18:.18)*sp,ps,ps,ps,k===0?inkColor:0x2b2530,9);
      }
    }
    if (stain>=.76 && inView) {
      const pulse=.5+.5*Math.sin(clock*26);
      _vRipOpts.label=.22+pulse*.70;
      r.add('ripple',x,y+.08,z,(w+1.5)*(1+pulse*.22),.04,(w+1.5)*(1+pulse*.22),inkColor,12,_vRipOpts);
      _vRipOpts.label=.4+pulse*.5;
      r.add('ripple',x,y+.12,z,(w+2.8)*(1-pulse*.12),.04,(w+2.8)*(1-pulse*.12),0xfff4cf,12,_vRipOpts);
      p('orb',w*.25,1.02,0,.32+pulse*.18,.26+pulse*.14,.32+pulse*.18,0xfff2c2,3);
    }
  }
}

function drawExplosionDebris(r,car,age) {
  const {x,y,z,w,d,baseTint,explodeTeam}=car;
  const ink=INK_COLORS[explodeTeam>=0?explodeTeam:1] ?? INK_COLORS[1];
  const life=clamp(1-age/1.55,0,1);
  // Multi-stage fireball core + double shockwave dome + blazing energy halo
  if (age<.58) {
    const t=age/.58, core=(1-t)*3.9+1.45;
    r.add('orb',x,y+1.2+t*1.95,z,core,core,core,t<.22?0xffffff:t<.45?0xffe8a8:ink,3,_vDyn);
    r.add('orb',x,y+1.2+t*1.95,z,core*1.58,core*1.48,core*1.58,ink,9,_vDyn);
    _vRipOpts.label=t;
    r.add('ripple',x,y+.12,z,2.4+t*CAR_EXPLOSION_RADIUS*2.15,.05,2.4+t*CAR_EXPLOSION_RADIUS*2.15,ink,12,_vRipOpts);
    _vRipOpts.label=clamp(t*1.3,0,1);
    r.add('ripple',x,y+.20,z,1.4+t*CAR_EXPLOSION_RADIUS*1.55,.05,1.4+t*CAR_EXPLOSION_RADIUS*1.55,0xfff4cf,12,_vRipOpts);
  }
  // Tumbling blown-off hood panel + detached front bumper!
  const panelLife=Math.max(.02,life);
  _vDebOpts.yaw=car.yaw+age*5.4; _vDebOpts.pitch=age*8.2;
  r.add('bevel',x+Math.sin(car.yaw)*age*2.2,Math.max(y+.18,y+1.1+age*7.6-age*age*6.6),z-Math.cos(car.yaw)*age*2.2,
    1.15*panelLife,.09*panelLife,1.25*panelLife,baseTint,20,_vDebOpts);
  _vDebOpts.yaw=car.yaw-age*6.8; _vDebOpts.pitch=age*6.4;
  r.add('bevel',x-Math.cos(car.yaw)*age*3.1,Math.max(y+.14,y+.7+age*5.4-age*age*6.4),z-Math.sin(car.yaw)*age*3.1,
    .22*panelLife,.16*panelLife,d*panelLife,0x2c363b,4,_vDebOpts);
  // 4 flying spinning tires blown outward from wheel corners!
  for (let tIdx=0;tIdx<4;tIdx++) {
    const ang=car.yaw+tIdx*T+.6, spd=4.4+(tIdx%2)*1.4, lift=6.4+(tIdx%2)*1.1;
    const tx=x+Math.cos(ang)*(1.1+age*spd), tz=z+Math.sin(ang)*(1.1+age*spd);
    const ty=Math.max(y+.26,y+.5+age*lift-age*age*6.8);
    const sc=.68*panelLife;
    _vDebOpts.yaw=ang+age*9; _vDebOpts.pitch=age*11;
    r.add('cylinder',tx,ty,tz,sc,.24*panelLife,sc,0x1e2629,21,_vDebOpts);
  }
  // Tumbling charred chassis shards & glowing ink sparks
  const count=r.lite?10:22;
  for (let i=0;i<count;i++) {
    const a=i*2.399+car.index, speed=3.4+(i%5)*1.55, lift=5.2+(i%4)*1.8;
    const px=x+Math.cos(a)*(w*.22+age*speed), pz=z+Math.sin(a)*(d*.22+age*speed);
    const py=Math.max(y+.1,y+.9+age*lift-age*age*6.4);
    const sz=(.34+(i%3)*.17)*Math.max(.01,life);
    const fiery=i%5===0 && age<.85;
    _vDebOpts.yaw=a+age*7.2; _vDebOpts.pitch=age*(i%4+2.8);
    r.add(i%3===0?'bevel':'box',px,py,pz,sz,sz*.65,sz*1.15,fiery?0xffe090:i%2===0?ink:baseTint,fiery?3:i%2===0?9:20,_vDebOpts);
  }
}
