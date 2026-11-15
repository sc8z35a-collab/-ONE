import {TAU,add,clamp,cross,dot,forward,mix,scale,splatRadius,sub,unit} from './render.js';
import {SPAWN_X,TEAM,TEAM_INK,randomGenerator} from './world.js';
import {BASE_TANK,GIGA_TANK,METRO,RAIL,CITY_RADIUS,ZONES,cityExit,floorBounds,giantScale,isCabin,isUnder,localX,sameLevel,zoneOf} from './layout.js';
import {Transit} from './transit.js';
import {Abilities,drawSquid} from './abilities.js';
import {Boss} from './boss.js';
import {drawBossModel} from './boss-model.js';
import {RAIDER_INK,Raiders,drawRaider} from './raiders.js';
import {drawCabinDoors,drawCabinScenery,drawCabinWindows} from './metro-stage.js';
import {Tactics} from './tactics.js';
import {NpcMotion,resetGait,limbJoint} from './npc-motion.js';
import {NpcPerception} from './npc-perception.js';
import {stairCrossing,stairEnd,stairLane,stairNeighborShift,stairRay} from './stairs.js';
import {actorInRay,collectShapes,traceShapes} from './collision.js';
import {EBOT,INK_EPSILON,OM_HOMING,PAINT_RADIUS_FACTOR,SUPERS,WEAPONS,shotTravel,weaponById} from './weapons.js';
import {SUBWEAPONS,Subweapons,subweaponById} from './subweapons.js';
import {StageObjects} from './stage-objects.js';
import {surfacePaintRadius} from './ink.js';
import {wallRunoff} from './ink-fluid.js';

export const DURATION=420;
export const DAMAGE_SCALE=1/3;
// Seconds out of play after a splat; the boss keeps its victims out longer.
export const RESPAWN_SECONDS=12;
export const BOSS_RESPAWN_SECONDS=15;
export const EXP_PER_KILL=30;
const MAX_TEAM_INDEX=16;
export const chargeGain=actor=>1-(actor.inkPenalty??0)*.064;
function decalBasis(n,phase) {
  const ref=Math.abs(n[1])>.9?[0,0,1]:[0,1,0];
  const base=unit(cross(ref,n)), side=cross(n,base);
  const x=add(scale(base,Math.cos(phase)),scale(side,Math.sin(phase)));
  return [x,cross(n,x),n];
}
const WHITE = 0xeae9d8, BOOT = 0x323f44, GRAPHITE = 0x425155, TRIM = 0x82908b;
const DECAL_RIM=Array.from({length:12},(_,i)=>splatRadius(i*TAU/12));
// Decals never move once placed, so their clipped triangle fan is built once
// (kept outside the decal so checkpoints stay small).
const decalShapes=new WeakMap();
function decalShape(geometry,decal) {
  let shape=decalShapes.get(decal);
  if (shape) return shape;
  const axes=decalBasis(decal.normal,decal.phase);
  const rim=geometry.coat(decal,axes,DECAL_RIM);
  shape={axes,origin:decal.p.slice()};
  if (rim) {
    shape.fan=[];
    for (let j=0;j<rim.length;j++) {
      const u=sub(add(rim[j],scale(decal.normal,.023)),decal.p);
      const v=sub(add(rim[(j+1)%rim.length],scale(decal.normal,.023)),decal.p);
      if (Math.hypot(...cross(u,v))>=.000002) shape.fan.push([u,v,decal.normal]);
    }
  }
  decalShapes.set(decal,shape);
  return shape;
}
export const INK_HIT_DURATION=.62;
const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);

function drawInkImpact(renderer,{p,team,at,normal:surface,kind=0},eye,time) {
  const age=clamp((time-at)/INK_HIT_DURATION,0,1);
  const toward=sub(eye,p), range=Math.hypot(...toward);
  if (age>=1 || range<1.05) return;
  const normal=surface??scale(toward,1/range), [right,up]=decalBasis(normal,0);
  // A body hit reads from across the street: it is drawn far larger than a
  // surface splash and keeps a minimum on-screen size at long range.
  const body=!surface, boost=body?(kind===2?2.75:2.05):1;
  const center=add(p,scale(normal,.10)), size=(surface?.69:1)*clamp(range/8,.72,body?2.6:1.48)*boost;
  const fade=1-age, radius=(.37+.71*(1-fade*fade))*size;
  const tint=TEAM_INK[team] ?? RAIDER_INK;
  const plane=[right,normal,scale(up,-1)], sheen=add(center,scale(normal,.014));
  renderer.add('ripple',...center,radius*2,.03,radius*2,tint,12,{dynamic:true,basis:plane,label:age});
  renderer.add('ripple',...sheen,radius*1.36,.03,radius*1.36,0xfff7d9,12,{dynamic:true,basis:plane,label:Math.min(1,age*1.4)});
  if (body) {
    // Second shock ring, a hot core and a cross of light for the hit itself.
    const late=clamp(age*1.5-.12,0,1);
    renderer.add('ripple',...sheen,radius*2.75*late,.03,radius*2.75*late,kind===2?0xfff2c2:tint,12,{dynamic:true,basis:plane,label:Math.min(1,.18+late*.85)});
    if (age<.34) {
      const core=(.52+.3*fade)*size*(1-age*2.9);
      renderer.add('orb',...sheen,core,core,core,0xffffff,3,{dynamic:true});
      renderer.add('orb',...sheen,core*1.7,core*1.7,core*1.7,tint,9,{dynamic:true});
    }
    const reach=(.55+1.25*(1-fade*fade))*size, width=.11*size*fade;
    for (const [axis,other] of [[right,up],[up,right]]) {
      const tip=scale(axis,reach);
      renderer.add('tri',...add(center,scale(axis,-reach)),1,1,1,0xfff4cf,3,{dynamic:true,basis:[scale(tip,2),scale(other,width),normal]});
      renderer.add('tri',...add(center,scale(axis,reach)),1,1,1,0xfff4cf,3,{dynamic:true,basis:[scale(tip,-2),scale(other,-width),normal]});
    }
  }
  if (age<.40) {
    const spark=(.26+.21*fade)*size*(1-age*2.5);
    renderer.add('orb',...sheen,spark,spark,spark,0xfff4ce,3,{dynamic:true});
  }
  const spikes=body?(kind===2?12:8):4;
  for (let i=0;i<spikes;i++) {
    const angle=(i+.5)*TAU/spikes;
    const direction=add(scale(right,Math.cos(angle)),scale(up,Math.sin(angle)));
    const side=scale(cross(direction,normal),.13*size*fade);
    const tip=add(scale(direction,(.17+.37*fade)*size*(body && i%2?1.5:1)),scale(side,.5));
    const base=add(add(center,scale(direction,radius)),scale(side,-.5));
    renderer.add('tri',...base,1,1,1,body && i%2?tint:0xfff4cf,3,{dynamic:true,basis:[side,tip,normal]});
    if (!renderer.lite || body) {
      const spark=add(base,scale(normal,.28*fade));
      renderer.add('orb',...spark,.10*fade*size,.15*fade*size,.10*fade*size,tint,3,{dynamic:true});
    }
  }
}

function shotFraction(from,to) {
  const cap=(start,end,min,max)=>end>max?(max-start)/(end-start):end<min?(min-start)/(end-start):1;
  if (zoneOf(from[0])===0) {
    return cityExit(from,to)??1;
  }
  const [boundX,boundZ]=floorBounds(from[0]), x=localX(from[0]);
  return clamp(Math.min(cap(x,x+to[0]-from[0],-boundX-13,boundX+13),cap(from[2],to[2],-boundZ-13,boundZ+13)),0,1);
}

class Navigation {
  constructor(world,zone) {
    this.world=world;
    this.nodes=[];
    const {bounds,x}=zone, spacing=this.spacing=isCabin(zone.x)?.72:1.7;
    const margin=isCabin(zone.x)?.60:1;
    this.x0=x-bounds[0]+margin;
    this.z0=-bounds[1]+margin;
    this.columns=Math.floor((bounds[0]*2-2*margin)/spacing)+1;
    this.rows=Math.floor(-2*this.z0/spacing)+1;
    const grid=this.grid=new Array(this.columns*this.rows);
    for (let z=0;z<this.rows;z++) for (let x=0;x<this.columns;x++) {
      const px=this.x0+x*spacing, pz=this.z0+z*spacing;
      if (stairLane(px,pz) || !world.stand(px,pz,.58)) continue;
      const node={x:px,z:pz,i:this.nodes.length,links:[]};
      this.nodes.push(node);
      grid[z*this.columns+x]=node;
    }
    for (let index=0;index<grid.length;index++) {
      const node=grid[index];
      if (!node) continue;
      const column=index%this.columns,row=Math.floor(index/this.columns);
      for (let dz=-1;dz<=1;dz++) for (let dx=-1;dx<=1;dx++) {
        if ((!dx && !dz) || column+dx<0 || column+dx>=this.columns || row+dz<0 || row+dz>=this.rows) continue;
        const next=grid[(row+dz)*this.columns+column+dx];
        if (next && this.clear(node,next)) node.links.push(next);
      }
    }
  }

  clear(a,b,radius=.61,height=1.68) {
    const count=Math.ceil(distance(a,b)/.28);
    let floor=this.world.floor(a.x,a.z).y;
    const allowStairs=!!stairLane(a.x,a.z) || !!stairLane(b.x,b.z);
    for (let step=1;step<=count;step++) {
      const t=step/count;
      const x=mix(a.x,b.x,t),z=mix(a.z,b.z,t),y=this.world.floor(x,z).y;
      if (!allowStairs && stairLane(x,z) || Math.abs(y-floor)>.39 || this.world.blocked(x,y+.025,z,radius,height)) return false;
      floor=y;
    }
    return true;
  }

  nearest(point,radius=.43,height=1.68) {
    let best=null, bestDistance=Infinity;
    const col=Math.round((point.x-this.x0)/this.spacing),row=Math.round((point.z-this.z0)/this.spacing);
    for (let z=Math.max(0,row-3);z<=Math.min(this.rows-1,row+3);z++) {
      for (let x=Math.max(0,col-3);x<=Math.min(this.columns-1,col+3);x++) {
        const node=this.grid[z*this.columns+x];
        if (!node) continue;
        const d=(node.x-point.x)**2+(node.z-point.z)**2;
        if (d<bestDistance && this.clear(point,node,radius,height)) {
          best=node;
          bestDistance=d;
        }
      }
    }
    return best;
  }

  route(from,goal,radius=.61,height=1.68,weight=null,openAt=null) {
    const start=this.nearest(from,Math.min(radius,.43),height), end=goal;
    if (!start || !end) return [];
    if (!weight && !openAt && this.clear(from,end,radius,height)) return [end];
    const g=new Float32Array(this.nodes.length).fill(Infinity);
    const f=new Float32Array(this.nodes.length).fill(Infinity);
    const parent=new Int32Array(this.nodes.length).fill(-1);
    const queued=new Uint8Array(this.nodes.length);
    const open=[start];
    g[start.i]=0;
    f[start.i]=distance(start,end);
    queued[start.i]=1;
    while (open.length) {
      let index=0;
      for (let k=1;k<open.length;k++) if (f[open[k].i]<f[open[index].i]) index=k;
      const here=open[index];
      open[index]=open[open.length-1];
      open.pop();
      queued[here.i]=0;
      if (here===end) {
        const route=[];
        for (let k=end.i;k!==start.i && k>=0;k=parent[k]) route.push(this.nodes[k]);
        route.push(start);
        route.reverse();
        while (route.length>1 && !weight && !openAt && this.clear(from,route[1],radius,height)) route.shift();
        return route;
      }
      for (const next of here.links) {
        if (openAt && !openAt(next)) continue;
        if ((radius>.61 || height>1.68) && !this.clear(here,next,radius,height)) continue;
        const cost=g[here.i]+distance(here,next)*(weight?weight(next):1);
        if (cost>=g[next.i]) continue;
        g[next.i]=cost;
        f[next.i]=cost+distance(next,end);
        parent[next.i]=here.i;
        if (!queued[next.i]) {
          queued[next.i]=1;
          open.push(next);
        }
      }
    }
    return [];
  }
}

function actorAt(team,index,isPlayer,weapon) {
  const actor={
    team,index,isPlayer,weapon,name:isPlayer?'YOU':(team===0?'C-':'A-')+String(index+1).padStart(2,'0'), kills:0, downs:0, painted:0,
    dealt:0,supers:0,subs:0,revealUntil:0,revealTeam:-1,downBy:null,
    hp:100,maxHp:100,tank:BASE_TANK,tankMax:BASE_TANK,down:0,superCharge:0,countedPaint:0,drone:null,droneReady:0,liftsUsed:0, shield:0, fire:0, heat:0, damageAge:99, lastDamageAt:-99, recoil:0, swimFX:0,
    subId:index===6?'see':SUBWEAPONS[(team*3+index)%5].id,subReady:0,rolling:false,rollHold:0,
    swimming:false, inkSwimming:false, climbing:false, inkExposure:0, inkPenalty:0, x:0,y:0,z:0,yaw:0,pitch:0,vx:0,vy:0,vz:0,steps:0,
    route:[],goal:null,think:.12*index,roam:0,stuck:0,side:index%2?1:-1
  };
  respawn(actor);
  return actor;
}

function respawn(a) {
  a.x=(a.team===0?-1:1)*(SPAWN_X+(a.index>=4?2.65:0));
  a.y=0;
  a.z=[-2.7,-.88,.94,2.76][a.index%4];
  a.yaw=a.team===0?Math.PI/2:-Math.PI/2;
  a.pitch=-.14;
  a.hp=a.maxHp=100;
  a.superUntil=0;
  a.activeSpecial=null;
  a.guard=0;
  a.rangeFactor=1;
  a.giant=a.beaming=false;
  a.slam=a.ride=a.lift=null;
  a.radius=a.height=undefined;
  a.travelGoal=null;
  a.doorReady=0;
  a.cabinToSide=a.cabinToLevel=null;
  a.tank=a.tankMax;
  a.shield=1.5;
  a.down=0;
  a.downBy=null;
  a.revealUntil=0;
  a.vx=a.vy=a.vz=0;
  a.rolling=false;
  a.rollHold=0;
  a.rollUsed=false;
  a.fire=.1;
  a.heat=0;
  a.swimming=a.inkSwimming=a.climbing=false;
  a.climbNormal=null;
  a.airborne=false;
  a.landing=0;
  a.inkExposure=a.inkPenalty=0;
  a.route=[];
  a.goal=null;
  a.think=.13+.17*a.index;
  a.roam=0;
  a.stuck=0;
  a.damageAge=99;
  a.charge=0;
  a.driveX=a.driveZ=0;
  a.jumpBuffer=a.coyote=a.shotBuffer=0;
  a.scan=0;
  a.enemy=a.lastSeen=null;
  resetGait(a);
}

export class Battle {
  constructor(world,paint,mode,callbacks = {},options = {}) {
    this.world=world;
    this.paint=paint;
    this.stage=new StageObjects(world);
    this.mode=mode;
    this.callbacks=callbacks;
    this.timeless=mode==='timeless';
    this.teamSize=this.timeless || options.teamSize===4?4:8;
    this.seed=Number.isInteger(options.seed)?options.seed:null;
    this.rng=randomGenerator(mode==='watch'?77349:947213);
    this.navs=world.navigations ??= ZONES.map(zone=>new Navigation(world,zone));
    [this.nav,this.lowerNav]=this.navs;
    this.transit=new Transit(world,paint);
    this.metro=new Transit(world,paint,METRO);
    this.transit.peer=this.metro;
    this.metro.peer=this.transit;
    this.abilities=new Abilities(this);
    this.subweapons=new Subweapons(this);
    this.boss=new Boss(this);
    this.raiders=new Raiders(this);
    this.clock=0;
    this.duration=DURATION;
    this.left=this.timeless?Infinity:this.duration;
    this.elapsed=0;
    this.countdown=3;
    this.actors=[];
    this.shots=[];
    this.shotSequence=0;
    this.drops=[];
    this.inkImpacts=[];
    this.decals=[];
    this.decalSequence=0;
    this.crewShapes=new WeakMap();
    this.events=[];
    this.watching=0;
    this.finished=false;
    this.player=null;
    this.paint.reset();
    for (let t=0;t<2;t++) for (let i=0;i<this.teamSize;i++) {
      const player=mode!=='watch' && t===0 && i===1;
      const slot=this.timeless?[[0,1,6,9],[7,9,8,2]][t][i]:[0,t===0?1:7,9,2,3,5,t===0?6:10,t===0?11:8][i];
      const weapon=player?weaponById(options.weapon):WEAPONS[slot];
      const actor=actorAt(t,i,player,weapon);
      if (player) actor.subId=subweaponById(options.sub).id;
      this.actors.push(actor);
      if (actor.isPlayer) this.player=actor;
      this.paint.stamp(actor.x,actor.z,2.15,t,0,i*.4,.044);
    }
    // A seeded match (the offline renderer) places the chip reproducibly.
    const random=this.seed===null?Math.random:randomGenerator(this.seed);
    const pool=(random()<.32?this.lowerNav:this.nav).nodes.filter(n=>Math.abs(localX(n.x))<40 && this.world.stand(n.x,n.z,.55));
    const chip=pool[Math.floor(random()*pool.length)];
    this.chip={x:chip.x,y:this.world.floor(chip.x,chip.z).y,z:chip.z,owner:null,yaw:random()*TAU};
    this.motion=new NpcMotion(this);
    this.perception=new NpcPerception(this);
    this.tactics=new Tactics(this);
  }

  // ebot: weaker copies of the caster that fight as ordinary crew until they
  // are splatted or their time runs out. They never respawn.
  addClone(owner,saved=null) {
    const used=new Set(this.actors.filter(a=>a.team===owner.team).map(a=>a.index));
    let index=this.teamSize;
    while (used.has(index)) index++;
    if (index>=MAX_TEAM_INDEX) return null;
    const clone=actorAt(owner.team,index,false,owner.weapon);
    const order=this.actors.filter(a=>a.cloneOf===owner).length+1;
    Object.assign(clone,{name:owner.name+'·e'+order,cloneOf:owner,clone:true,cloneUntil:this.clock+SUPERS.ebot.seconds,
      hp:EBOT.hp,maxHp:EBOT.hp,baseHp:EBOT.hp,damageFactor:EBOT.damage,paintFactor:EBOT.paint,subId:owner.subId,
      tank:owner.tankMax,tankMax:owner.tankMax,shield:.7,think:0});
    if (saved) Object.assign(clone,saved);
    this.actors.push(clone);
    return clone;
  }

  summonClones(owner) {
    const [fx,,fz]=forward(owner.yaw), spots=[[1.25,-.2],[-1.25,-.2],[0,-1.5],[1.9,.9],[-1.9,.9],[0,1.6]];
    let made=0;
    for (const [side,ahead] of spots) {
      if (made>=EBOT.count) break;
      const x=stairCrossing(owner.x,owner.z,owner.x-fz*side+fx*ahead,owner.z+fx*side+fz*ahead,owner.y), z=owner.z+fx*side+fz*ahead;
      if (!sameLevel(x,owner.x)) continue;
      const floor=this.world.support(x,owner.y+.3,z);
      const probe={x,y:floor.y,z};
      if (Math.abs(floor.y-owner.y)>.6 || this.bodyBlocked(probe,.4,1.72) || !this.stage.canEnter(owner,x,floor.y,z) ||
          this.traceShot([owner.x,owner.y+.9,owner.z],[x,floor.y+.9,z],true)) continue;
      const clone=this.addClone(owner);
      if (!clone) break;
      Object.assign(clone,{x,y:floor.y,z,yaw:owner.yaw,bodyYaw:owner.yaw,pitch:owner.pitch,apartmentVisits:owner.apartmentVisits});
      this.burst([x,floor.y+.9,z],owner.team,14,3);
      this.abilities.rings.push({x,y:floor.y+.04,z,r:1.6,team:owner.team,until:this.clock+.55});
      made++;
    }
    // A cramped caster still gets its copies; they step out of the same spot.
    while (made<EBOT.count) {
      const clone=this.addClone(owner);
      if (!clone) break;
      Object.assign(clone,{x:owner.x,y:owner.y,z:owner.z,yaw:owner.yaw,bodyYaw:owner.yaw,pitch:owner.pitch,apartmentVisits:owner.apartmentVisits});
      made++;
    }
    return made;
  }

  retireClones() {
    for (let i=this.actors.length-1;i>=0;i--) {
      const clone=this.actors[i], owner=clone.cloneOf;
      if (!owner || clone.down<=0 && this.clock<clone.cloneUntil) continue;
      // The caster keeps the copy's turf on its record, without earning a super from it.
      owner.painted+=clone.painted;
      owner.countedPaint+=clone.painted;
      if (clone.down<=0) this.burst([clone.x,clone.y+.9,clone.z],clone.team,12,2.6);
      if (clone.drone) clone.drone.until=this.clock;
      this.tactics.states.delete(clone);
      this.perception.memory.delete(clone);
      for (const table of this.tactics.contacts) table.delete(clone);
      this.actors.splice(i,1);
      if (this.mode==='watch') {
        if (i<this.watching) this.watching--;
        else if (i===this.watching) {
          this.watching=Math.min(this.watching,this.actors.length-1);
          if (this.actors[this.watching].down>0) this.cycle();
        }
      }
    }
  }

  equipPlayer(weaponId,subId) {
    const actor=this.player, weapon=weaponById(weaponId), sub=subweaponById(subId);
    if (this.finished || !actor || weapon.id!==weaponId || sub.id!==subId ||
        actor.weapon===weapon && actor.subId===subId) return false;
    if (actor.weapon!==weapon) {
      if (actor.superUntil>this.clock && !actor.activeSpecial) actor.activeSpecial=actor.weapon.special;
      this.clearPlayerInput();
      actor.weapon=weapon;
      actor.recoil=0;
      actor.muzzleBlocked=false;
    }
    actor.subId=sub.id;
    return true;
  }

  clearPlayerInput() {
    const actor=this.player;
    if (actor) {
      actor.charge=actor.shotBuffer=actor.jumpBuffer=actor.rollHold=0;
      actor.driveX=actor.driveZ=0;
      actor.rolling=false;
      actor.rollUsed=false;
    }
  }

  pickupChip(actor) {
    const c=this.chip;
    if (c.owner || actor.ride || actor.lift || actor.down>0 || Math.abs(actor.y-c.y)>.77 || distance(actor,c)>.66) return false;
    c.owner=actor;
    actor.tankMax=GIGA_TANK;
    actor.tank=Math.min(GIGA_TANK,actor.tank+BASE_TANK);
    if (actor.isPlayer) this.callbacks.sound?.('drone');
    return true;
  }

  cabinTrain(x) {
    return zoneOf(x)===2?this.metro:this.transit;
  }

  transportService(actor) {
    const choices=[this.metro,this.transit].map(rail=>({rail,option:rail.option(actor)})).filter(choice=>choice.option);
    return choices.find(choice=>choice.option.kind!=='busy') ?? choices[0] ?? null;
  }

  transportOption(actor) {
    return this.transportService(actor)?.option ?? null;
  }

  useTransport(actor) {
    return this.transportService(actor)?.rail.use(actor) ?? false;
  }

  carryTransit(actor,dt) {
    if (!actor.isPlayer && actor.ride && actor.rideFrom!==this.transit.train.stop) this.transit.use(actor);
    return this.transit.carry(actor,dt) || this.metro.carry(actor,dt);
  }

  cameraActor() {
    return this.player || this.actors[this.watching];
  }

  cycle() {
    const start=this.watching;
    for (let i=1;i<=this.actors.length;i++) {
      const next=(start+i)%this.actors.length;
      if (this.actors[next].down<=0) {
        this.watching=next;
        return;
      }
    }
  }

  bodyHit(start,end,actor,padding=0) {
    if (!actorInRay(actor,start,end,padding)) return null;
    let pose=this.crewShapes.get(actor);
    const form=actor.giant?3:actor.climbing?2:actor.swimming?1:0;
    if (!pose || pose.clock!==this.clock || pose.x!==actor.x || pose.y!==actor.y || pose.z!==actor.z || pose.yaw!==actor.yaw || pose.pitch!==actor.pitch ||
        pose.bodyYaw!==actor.bodyYaw || pose.brace!==actor.brace || pose.peek!==actor.peek || pose.form!==form) {
      pose={clock:this.clock,x:actor.x,y:actor.y,z:actor.z,yaw:actor.yaw,pitch:actor.pitch,bodyYaw:actor.bodyYaw,brace:actor.brace,peek:actor.peek,form,shapes:collectShapes(r=>{
        if (actor.isBoss) drawBossModel(r,actor,this.clock,true);
        else if (actor.isRaider) drawRaider(r,actor,this.clock,false);
        else drawCrew(r,actor,this.clock,false);
      })};
      this.crewShapes.set(actor,pose);
    }
    return traceShapes(pose.shapes,start,end,padding)?.t ?? null;
  }

  findActor(start,end,team,joined=true,padding=0) {
    const seam=joined && stairRay(start,end);
    if (seam) {
      const early=seam.t>0 && this.findActor(start,seam.point,team,false,padding);
      if (early) return {...early,t:early.t*seam.t};
      const offset=[seam.shift,0,0], late=seam.t<1 && this.findActor(add(seam.point,offset),add(end,offset),team,false,padding);
      return late?{...late,t:seam.t+(1-seam.t)*late.t,shift:seam.shift}:null;
    }
    let closest=null;
    for (const actor of this.actors) {
      if (actor.team===team || actor.down>0 || actor.shield>0 || actor.lift || actor.ride || !sameLevel(actor.x,start[0])) continue;
      const t=this.bodyHit(start,end,actor,padding);
      if (t!==null && (!closest || t<closest.t)) closest={actor,t};
    }
    if (team>=0) for (const raider of this.raiders.members) {
      if (!raider.active || raider.shield>0 || raider.ride || raider.lift || !sameLevel(raider.x,start[0])) continue;
      const t=this.bodyHit(start,end,raider,padding);
      if (t!==null && (!closest || t<closest.t)) closest={actor:raider,t};
    }
    if (this.boss.active && sameLevel(this.boss.x,start[0])) {
      const t=this.bodyHit(start,end,this.boss,padding);
      if (t!==null && (!closest || t<closest.t)) closest={actor:this.boss,t};
    }
    return closest;
  }

  traceShot(start,end,precise=false,joined=true,clearance=0) {
    const seam=precise && joined && stairRay(start,end);
    if (seam) {
      const early=seam.t>0 && this.traceShot(start,seam.point,true,false,clearance);
      if (early) return {...early,t:early.t*seam.t};
      const offset=[seam.shift,0,0], late=seam.t<1 && this.traceShot(add(seam.point,offset),add(end,offset),true,false,clearance);
      return late?{...late,t:seam.t+(1-seam.t)*late.t,shift:seam.shift}:null;
    }
    let best=precise?this.world.traceExact(start,end,clearance):this.world.trace(start,end);
    const object=this.stage.trace(start,end,clearance,best?.t);
    if (object && (!best || object.t<best.t)) best=object;
    if (isCabin(start[0]) && sameLevel(start[0],end[0])) {
      const rail=this.cabinTrain(start[0]);
      if (!rail.cabinGlassAt || rail.cabinGlassAt!==rail.train || rail.cabinDoorAt!==rail.train.doorOpen || rail.cabinDoorSide!==rail.line.doorSide) {
        rail.cabinDoorShapes=collectShapes(r=>{
          drawCabinDoors(r,rail);
          drawCabinWindows(r,rail);
        });
        rail.cabinGlassAt=rail.train;
        rail.cabinDoorAt=rail.train.doorOpen;
        rail.cabinDoorSide=rail.line.doorSide;
      }
      const door=traceShapes(rail.cabinDoorShapes,start,end,clearance);
      if (door && (!best || door.t<best.t)) best=door.shape.windowId?{...door,cabinWindow:rail}:door;
    }
    for (const rail of [this.transit,this.metro]) {
      const train=rail.trace(start,end,precise,clearance);
      if (train && (!best || train.t<best.t)) best=train;
    }
    return best;
  }

  aim(eye,dir,range=38) {
    const end=add(eye,scale(dir,range));
    let probe=end;
    if (zoneOf(eye[0])===0) {
      const horizon=add(eye,scale(dir,CITY_RADIUS*2+1));
      probe=add(eye,scale(sub(horizon,eye),shotFraction(eye,horizon)));
    }
    const wall=this.traceShot(eye,probe,true);
    return {position:wall && !wall.boundary?add(eye,scale(sub(probe,eye),wall.t)):end};
  }

  focusTarget(eye,dir,team,range) {
    const end=add(eye,scale(dir,range)), hit=this.findActor(eye,end,team);
    if (!hit) return null;
    const point=add(eye,scale(dir,hit.t*range));
    const wall=this.traceShot(eye,point,true);
    const curtain=this.subweapons.block(eye,point,team);
    return wall?.t<.999 || curtain?.t<.999?null:{...hit,point};
  }

  enemyFor(bot) {
    return this.perception.select(bot).enemy;
  }

  steer(actor,target,dt,speed=5.18,swim=false,pose={}) {
    const dx=target.x-actor.x,dz=target.z-actor.z,d=Math.hypot(dx,dz);
    const stride=Math.min(speed,Math.sqrt(Math.max(0,d-.045)*42));
    const vx=d>.045?dx/d*stride:0,vz=d>.045?dz/d*stride:0;
    if (actor.isPlayer) {
      this.drive(actor,vx,vz,dt,swim,!!pose.jump);
      return true;
    }
    this.motion.drive(actor,vx,vz,dt,{...pose,swim,emergency:pose.emergency || actor.intent==='爆発範囲から退避'});
    return true;
  }

  navigate(actor,target,dt,speed=5.18,swim=false,pose={}) {
    const zone=zoneOf(actor.x),nav=this.navs[zone],old=actor.travelGoal;
    const radius=actor.radius??.47, height=actor.height??1.68;
    const changed=!old || zoneOf(old.x)!==zone || distance(old,target)>.77;
    const stalled=(actor.stuck??0)>.24;
    let next=target;
    if (changed || this.clock>=(actor.travelAt??0) || stalled && !actor.travelObstacles) {
      actor.travelGoal={x:target.x,z:target.z};
      actor.travelAt=this.clock+(stalled?.62:1.21);
      actor.travelObstacles=stalled;
      const clear=nav.clear(actor,target,radius,height);
      const contacts=actor.team>=0?this.tactics.intelligence(actor,zone).filter(c=>c.fresh>.52):[];
      const startInk=this.paint.get(actor.x,actor.z,this.world.floor(actor.x,actor.z).layer);
      const endInk=this.paint.get(target.x,target.z,this.world.floor(target.x,target.z).layer);
      const middle={x:(actor.x+target.x)/2,z:(actor.z+target.z)/2};
      const middleInk=this.paint.get(middle.x,middle.z,this.world.floor(middle.x,middle.z).layer);
      const hostile=actor.team>=0 && [startInk,endInk,middleInk].some(ink=>ink===2-actor.team);
      const weight=!clear && actor.team>=0 || hostile && distance(actor,target)>5?node=>{
        const cache=weights.get(node.i);
        if (cache!==undefined) return cache;
        const floor=this.world.floor(node.x,node.z);
        const ink=this.paint.get(node.x,node.z,floor.layer);
        const risk=contacts.reduce((sum,c)=>sum+Math.max(0,1-distance(node,c)/7.7)*c.fresh,0);
        const value=1+(ink===2-actor.team?.48:0)+Math.min(1.05,risk*(actor.hp<65?.91:.33));
        weights.set(node.i,value);
        return value;
      }:null;
      const weights=new Map(), blocked=new Map();
      const openAt=stalled?node=>{
        if (distance(actor,node)>8) return true;
        if (blocked.has(node.i)) return !blocked.get(node.i);
        const y=this.world.floor(node.x,node.z).y;
        const probe={x:node.x,y:y+.028,z:node.z,radius,height};
        const occupied=this.stage.blocked(probe.x,probe.y,probe.z,radius,height) ||
          !this.stage.canEnter(actor,probe.x,probe.y,probe.z) || this.transit.blocksActor(probe) || this.metro.blocksActor(probe);
        blocked.set(node.i,occupied);
        return !occupied;
      }:null;
      actor.travelPath=clear && !weight && !openAt?null:nav.route(actor,nav.nearest(target,radius,height),radius,height,weight,openAt);
    }
    const path=actor.travelPath;
    if (path) {
      if (!path.length) return false;
      if (path.length>1 && distance(actor,path[0])<.67) path.shift();
      if (path.length>2 && !stalled && nav.clear(actor,path[1],radius,height) && distance(actor,path[1])<3.4) path.shift();
      next=path[0];
      if (path.length===1 && distance(actor,next)<.9 && nav.clear(actor,target,radius,height)) next=target;
    }
    const before={x:actor.x,z:actor.z};
    const locked=pose.jump || stalled && this.clock>(actor.npcJumpAt??0) && distance(actor,next)<2.45 && this.motion.canHop(actor,next.x,next.z);
    if (locked) actor.npcJumpAt=this.clock+1.6;
    this.steer(actor,next,dt,speed,swim,{...pose,jump:locked});
    actor.stuck=distance(actor,next)>.8 && distance(actor,before)<dt*.30?(actor.stuck??0)+dt:Math.max(0,(actor.stuck??0)-dt*1.5);
    return true;
  }

  npc(actor,dt) {
    const sight=this.perception.scan(actor,dt);
    actor.enemy=sight.visible?sight.enemy:null;
    if (sight.visible && sight.at===this.clock) this.tactics.observe(actor,sight.enemy,sight.foot);
    this.tactics.crew(actor,actor.enemy,dt,sight);
  }

  surfaceInk(actor,surface) {
    if (!surface.raised && this.paint.hasSurface(actor.x,actor.z,surface.layer)) {
      return this.paint.get(actor.x,actor.z,surface.layer);
    }
    return this.wallOwner([actor.x,surface.y,actor.z],[0,1,0]);
  }

  inkPressure(actor,dt) {
    const floor=this.world.support(actor.x,actor.y,actor.z);
    const hostile=!actor.ride && !actor.lift && actor.y<=floor.y+.08 && this.surfaceInk(actor,floor)===2-actor.team;
    actor.inkExposure=hostile?Math.min(4.01,(actor.inkExposure??0)+dt):0;
    actor.inkPenalty=hostile?1+Math.floor(actor.inkExposure+1e-7):0;
  }

  drive(actor,vx,vz,dt,swim,jump) {
    const strength=1-Math.exp(-dt*(Math.abs(vx)+Math.abs(vz)>.12?24:30));
    actor.driveX=mix(actor.driveX??0,vx,strength);
    actor.driveZ=mix(actor.driveZ??0,vz,strength);
    this.move(actor,actor.driveX,actor.driveZ,dt,swim,jump);
  }

  wallOwner(point,normal,shape=-1,grip=0) {
    for (let i=this.decals.length-1;i>=0;i--) {
      const mark=this.decals[i], neighbor=shape>=0 && mark.shape>=0 && mark.shape!==shape;
      if (neighbor && !grip || dot(mark.normal,normal)<(grip?.95:.99) || !sameLevel(point[0],mark.p[0])) continue;
      const delta=sub(point,mark.p);
      if (Math.abs(dot(mark.normal,delta))>(grip?.16:.095) || Math.hypot(...delta)>mark.radius*1.83+grip) continue;
      const axes=decalBasis(mark.normal,mark.phase);
      const u=dot(delta,axes[0])/(mark.radius*1.66),v=dot(delta,axes[1])/(mark.radius*1.35);
      if (Math.hypot(u,v)<=splatRadius(Math.atan2(v,u))+grip/(mark.radius*1.66)) return mark.team+1;
    }
    return 0;
  }

  wallGrip(actor,direction,previous) {
    for (const height of [.42,.19,.68]) {
      const start=[actor.x,actor.y+height,actor.z], end=add(start,scale(direction,1.06));
      const hit=this.world.traceExact(start,end);
      if (!hit || Math.abs(hit.normal[1])>.30 || previous && dot(previous,hit.normal)<.57) continue;
      if (this.wallOwner(hit.position,hit.normal,hit.shape?.id,.12)===actor.team+1) return hit;
    }
    return null;
  }

  climb(actor,vx,vz,dt,wantsSwim,jump) {
    const old=actor.climbNormal;
    actor.climbNormal=null;
    actor.climbing=false;
    const pace=Math.hypot(vx,vz);
    if (!wantsSwim || actor.team<0 || actor.giant || actor.vy>3 || !old && pace<.56) return false;
    const direction=pace>.56?[vx/pace,0,vz/pace]:scale(old,-1);
    if (old && dot(direction,old)>.25) return false;
    const grip=this.wallGrip(actor,old?scale(old,-1):direction,old);
    if (!grip && old && pace>.56 && dot(direction,old)<-.24) {
      const x=actor.x-old[0]*.69,z=actor.z-old[2]*.69;
      const ledge=this.world.support(x,actor.y+.42,z);
      if (ledge.y>=actor.y-.12 && ledge.y<=actor.y+.42 && !this.world.blocked(x,ledge.y+.025,z,.36,.62) &&
          !this.stage.blocked(x,ledge.y+.025,z,.36,.62) && this.stage.canEnter(actor,x,ledge.y,z)) {
        const y=Math.max(actor.y,ledge.y)+.42;
        if (!this.world.traceExact([actor.x,y,actor.z],[x,y,z])) {
          const before={x:actor.x,y:actor.y,z:actor.z};
          actor.x=x;actor.z=z;actor.y=ledge.y;actor.vy=0;
          if (!actor.predicted) this.stage.visit(actor,before);
          actor.vx=actor.vz=0;
          actor.swimming=true;
          actor.inkSwimming=this.surfaceInk(actor,ledge)===actor.team+1;
          return true;
        }
      }
    }
    if (!grip) return false;
    const normal=unit([grip.normal[0],0,grip.normal[2]]);
    const before=[actor.x,actor.y,actor.z];
    actor.climbNormal=normal;
    actor.climbing=actor.swimming=actor.inkSwimming=true;
    actor.airborne=false;
    actor.landing=actor.vy=0;
    const into=-dot(direction,normal);
    const inset=clamp(-dot(sub(grip.position,before),normal)-.36,0,dt*5.8);
    const side=pace>.56?scale(add(direction,scale(normal,into)),dt*2.45):[0,0,0];
    this.stepActor(actor,side[0]-normal[0]*inset,side[2]-normal[2]*inset);
    const next=actor.y+(pace>.56?Math.max(.35,into)*4.85*dt:0);
    if (!this.world.blocked(actor.x,next+.018,actor.z,.33,.61) && !this.stage.blocked(actor.x,next+.018,actor.z,.33,.61)) actor.y=next;
    if (jump) {
      actor.climbing=actor.swimming=actor.inkSwimming=false;
      actor.airborne=true;
      actor.climbNormal=null;
      actor.vy=5.32;
      this.stepActor(actor,normal[0]*.36,normal[2]*.36);
    }
    actor.vx=(actor.x-before[0])/Math.max(.001,dt);
    actor.vz=(actor.z-before[2])/Math.max(.001,dt);
    actor.steps+=Math.max(0,actor.y-before[1])*4.25;
    return true;
  }

  stepActor(actor,dx,dz,boarding=false) {
    const before={x:actor.x,y:actor.y,z:actor.z};
    this.world.step(actor,dx,dz,(x,y,z,radius,height)=>
      !this.stage.blocked(x,y,z,radius,height) && this.stage.canEnter(actor,x,y,z) &&
      (actor.isPlayer || this.motion.roomFor(actor,x,y,z,radius,height)));
    if (boarding && actor.isPlayer && !actor.predicted &&
        (this.transit.walkThrough(actor,before) || this.metro.walkThrough(actor,before))) return true;
    const hull=actor.isPlayer?actor:{...actor,radius:(actor.radius??(actor.swimming?.33:.4))+.039};
    if (this.transit.blocksActor(hull) || this.metro.blocksActor(hull)) {
      actor.x=before.x;actor.z=before.z;actor.y=before.y;
    } else if (!actor.predicted) this.stage.visit(actor,before);
    return false;
  }

  bodyBlocked(actor,radius,height) {
    return this.world.blocked(actor.x,actor.y+.018,actor.z,radius,height) ||
      this.stage.blocked(actor.x,actor.y+.018,actor.z,radius,height) ||
      [this.transit,this.metro].some(rail=>rail.blocksActor({...actor,radius,height}));
  }

  trainContact(actor,fromY,toY) {
    const start=[actor.x,fromY,actor.z], end=[actor.x,toY,actor.z];
    const first=this.transit.trace(start,end), second=this.metro.trace(start,end);
    return first && (!second || first.t<second.t)?first:second;
  }

  actorSupport(actor) {
    const floor=this.stage.support(actor.x,actor.y,actor.z,this.world.support(actor.x,actor.y,actor.z));
    const roof=this.trainContact(actor,actor.y+.10,actor.y-.10);
    return roof?.normal[1]>.54 && roof.position[1]>floor.y?{...floor,y:roof.position[1],raised:true}:floor;
  }

  downwardSurface(x,y,z) {
    const ground=this.world.floor(x,z);
    const hit=this.traceShot([x,Math.max(y,ground.y)+.14,z],[x,ground.y-.15,z],true,false);
    if (!(hit?.t>1e-6 && hit.normal[1]>.54)) return null;
    if (hit.layer===ground.layer && Math.abs(hit.position[1]-ground.y)<.045) {
      return {...hit,position:[x,ground.y,z]};
    }
    return hit;
  }

  move(actor,vx,vz,dt,wantsSwim,jump) {
    if (this.climb(actor,vx,vz,dt,wantsSwim,jump)) return;
    const wasAirborne=actor.airborne;
    const surface=this.actorSupport(actor);
    const grounded=actor.y<=surface.y+.065 && actor.vy<=0;
    const owner=this.surfaceInk(actor,surface);
    actor.coyote=grounded?.092:Math.max(0,actor.coyote-dt);
    actor.jumpBuffer=jump?.14:Math.max(0,actor.jumpBuffer-dt);
    const needsClearance=!actor.giant && grounded && actor.swimming && this.bodyBlocked(actor,.4,1.72);
    actor.swimming=!actor.giant && grounded && (needsClearance || wantsSwim && (owner===0 || owner===actor.team+1));
    const hostile=grounded && owner && owner!==actor.team+1;
    const resistance=hostile?.88-.037*Math.max(0,(actor.inkPenalty??1)-1):1;
    const speed=(actor.giant && !actor.isRaider?1.67:actor.swimming?(owner===actor.team+1?1.98:1.06):1)*resistance*
      (actor.giant?1:actor.weapon?.weight??1);
    const x=localX(actor.x),z=actor.z,zone=zoneOf(actor.x);
    if (actor.jumpBuffer>0 && actor.coyote>0 && !needsClearance) {
      actor.vy=actor.swimming?6.45:6.05;
      actor.swimming=false;
      actor.jumpBuffer=actor.coyote=0;
    }
    if (this.stepActor(actor,vx*speed*dt,vz*speed*dt,true)) return;
    const floor=this.actorSupport(actor);
    let ground=floor.y;
    if (grounded && actor.vy<=0 && surface.stair && surface.stair===floor.stair) {
      actor.y=ground;
      actor.vy=0;
    } else if (actor.y>ground+.02 || actor.vy>0) {
      actor.vy-=17.9*dt;
      let next=actor.y+actor.vy*dt;
      if (actor.vy>0) {
        const height=actor.height??1.70;
        const ceiling=this.trainContact(actor,actor.y+height-.015,next+height+.018);
        const radius=actor.radius??.39;
        if (ceiling?.normal[1]<-.54 || this.world.blocked(actor.x,next+.018,actor.z,radius,height) ||
            this.stage.blocked(actor.x,next+.018,actor.z,radius,height)) {
          next=actor.y;
          actor.vy=0;
        }
      } else {
        const bottom=Math.max(next,ground);
        if (bottom<actor.y+.06) {
          const roof=this.trainContact(actor,actor.y+.06,bottom);
          if (roof?.normal[1]>.54) ground=Math.max(ground,roof.position[1]);
        }
      }
      actor.y=Math.max(next,ground);
      if (next<=ground) actor.vy=0;
    } else {
      actor.y=ground;
      actor.vy=0;
    }
    actor.airborne=actor.y>ground+.12 || actor.vy>.15;
    actor.landing=wasAirborne && !actor.airborne?1:Math.max(0,(actor.landing??0)-dt*7.2);
    if (zone!==zoneOf(actor.x)) {
      actor.stairsUsed=(actor.stairsUsed??0)+1;
      actor.enemy=null;
      actor.route=[];
      actor.travelGoal=null;
    }
    actor.inkSwimming=actor.swimming && this.surfaceInk(actor,floor)===actor.team+1;
    actor.vx=(localX(actor.x)-x)/Math.max(.001,dt);
    actor.vz=(actor.z-z)/Math.max(.001,dt);
    actor.steps+=Math.hypot(actor.vx,actor.vz)*dt*1.93;
    if (actor.inkSwimming && !floor.raised && !actor.predicted) {
      actor.swimFX-=dt;
      if (actor.swimFX<=0 && Math.hypot(actor.vx,actor.vz)>.65) {
        actor.swimFX=.095;
        this.paint.kick(actor.x,actor.z,floor.layer,actor.vx,actor.vz);
      }
    }
  }

  // The movement half of the controls. The Cloudflare client runs the same
  // step ahead of the server to show the player's own motion without delay.
  walk(a,input,dt) {
    const [sx,,sz]=forward(input.yaw), nx=-sz, nz=sx;
    const m=Math.max(1,Math.hypot(input.x,input.z));
    const pace=(input.z<0?5.28:6.08)*(a.beaming?.63:a.weapon.roller && input.fire && a.rollHold>.19?.78:1);
    this.drive(a,(nx*input.x+sx*input.z)*pace/m,(nz*input.x+sz*input.z)*pace/m,dt,
      input.swim && !input.fire && !input.press && !input.sub,input.jump);
  }

  control(a,input,dt,camera) {
    const startedInCabin=isCabin(a.x);
    const pendingShot=a.charge>0 || a.shotBuffer>0 || a.rollHold>0;
    a.yaw=input.yaw;
    a.pitch=input.pitch;
    this.walk(a,input,dt);
    if (startedInCabin!==isCabin(a.x)) return;
    if (input.fire || input.press || pendingShot || a.beaming) {
      const view=typeof camera==='function'?camera():camera;
      const dir=unit(sub(view.target,view.eye));
      this.playerAim=this.aim(view.eye,dir,Math.hypot(...floorBounds(view.eye[0]))*2+12);
    }
    if (input.sub) this.subweapons.use(a,input.yaw,input.pitch);
    const weapon=a.weapon;
    if (a.giant || a.beaming) return;
    if (weapon.roller) {
      if (input.fire && !a.swimming) {
        if (a.airborne) {
          a.rollUsed=this.shoot(a,this.playerAim.position) || a.rollUsed;
          a.rollHold=0;
          a.rolling=false;
        } else {
          a.rollHold+=dt;
          if (a.rollHold>=.20 && this.roll(a)) a.rollUsed=true;
        }
      } else {
        if (input.press || a.rollHold>0 && !a.rollUsed) this.shoot(a,this.playerAim.position);
        a.rollHold=0;
        a.rollUsed=false;
        a.rolling=false;
      }
      return;
    }
    if (weapon.charge) {
      if ((input.fire || input.press) && !a.swimming && a.tank+INK_EPSILON>=weapon.cost && a.fire<=0) {
        a.charge=Math.min(1,a.charge+dt/weapon.charge);
      } else if (a.charge>0 && !input.fire) {
        if (!a.swimming) this.shoot(a,this.playerAim.position,.27+.73*a.charge);
        a.charge=0;
      } else if (a.swimming) {
        a.charge=0;
      }
    } else {
      a.shotBuffer=input.press?.16:Math.max(0,a.shotBuffer-dt);
      if ((input.fire || a.shotBuffer>0) && this.shoot(a,this.playerAim.position)) a.shotBuffer=0;
    }
  }

  muzzle(a) {
    const launch=this.weaponLaunch(a)[0];
    return launch.hit || launch.crossesStair?launch.origin:launch.tip;
  }

  weaponLaunch(actor) {
    const origin=[actor.x,actor.y+(actor.weapon.roller?1.48:1.30)-(actor.brace??0)*.36,actor.z];
    const pose=crewPose(actor,this.clock);
    let tips;
    if (actor.weapon.roller) {
      const {y,z}=rollerPosition(actor);
      tips=[pose.loc(0,y,z+.318)];
    } else if (actor.isRaider) {
      tips=[pose.loc(-.39,1.26,.79)];
    } else {
      const gun=gunPose(actor,pose);
      tips=actor.weapon.id==='dual'?[-1,1].map(side=>gun.at(-.415+side*.13,1.30,1.034)):
        [gun.at(-.415,1.30,.746+gun.barrel*.85)];
    }
    return tips.map(tip=>{
      const hit=this.traceShot(origin,tip,true);
      const position=hit?hit.position:stairEnd(origin,tip);
      return {origin,tip,hit,position,crossesStair:!sameLevel(tip[0],position[0])};
    });
  }

  roll(a,onlyNew=false) {
    if (!a.weapon.roller || a.down>0 || a.swimming || a.airborne || a.giant || a.beaming || a.slam || a.ride || a.lift ||
        Math.hypot(a.vx,a.vz)<.55) return false;
    const [dx,,dz]=forward(a.yaw), frontX=a.x+dx*.84, z=a.z+dz*.84;
    const x=stairCrossing(a.x,a.z,frontX,z,a.y);
    const floor=this.world.support(x,a.y+.18,z);
    if (Math.abs(floor.y-a.y)>.33 || this.traceShot([a.x,a.y+.35,a.z],[frontX,a.y+.35,z],true)) return false;
    if (onlyNew && !floor.raised && this.paint.get(x,z,floor.layer)===a.team+1) return false;
    if (a.tank+INK_EPSILON<a.weapon.cost) return false;
    a.rolling=true;
    if (a.fire>0) return true;
    for (const lane of [-1,0,1]) {
      const offset=lane*.58*PAINT_RADIUS_FACTOR;
      const rawX=frontX-dz*offset, pz=z+dx*offset;
      const px=stairCrossing(a.x,a.z,rawX,pz,a.y);
      const hit=this.traceShot([px,a.y+.48,pz],[px,a.y-.25,pz],true,false);
      if (!hit || hit.normal[1]<.54 || this.traceShot([a.x,a.y+.38,a.z],[rawX,a.y+.38,pz],true)) continue;
      if (this.paint.hasSurface(px,pz,hit.layer)) a.painted+=this.paint.stampGround(px,pz,.65*PAINT_RADIUS_FACTOR*(a.paintFactor??1),a.team,hit.layer,0,.046);
      else this.splat(hit,{actor:a,weapon:a.weapon,paint:a.paintFactor},.46);
    }
    this.abilities.area(a,x,a.y+.25,z,1.05,76*(a.damageFactor??1),undefined,true);
    a.tank=Math.max(0,a.tank-a.weapon.cost);
    a.fire=.18;
    a.heat=.51;
    if (a.isPlayer) this.callbacks.sound?.('shot');
    this.callbacks.cue?.('roll',a);
    return true;
  }

  // TD: one wide blast that fans ink across the floor ahead and hits every
  // opponent inside the cone, pushing the survivors back.
  blast(actor,target,launches) {
    const weapon=actor.weapon, {reach,half}=weapon.blast, launch=launches[0];
    const start=launch.hit || launch.crossesStair?launch.origin:launch.tip;
    const aim=unit(sub(target,start)), yaw=Math.atan2(aim[0],-aim[2]), flat=Math.hypot(aim[0],aim[2]);
    const range=reach*(actor.rangeFactor??1), team=actor.team;
    const damage=weapon.damage*(actor.damageFactor??1), paint=actor.paintFactor??1;
    for (const u of [-1,-.5,0,.5,1]) {
      const [dx,,dz]=forward(yaw+u*half), direction=unit([dx*Math.max(.35,flat),aim[1],dz*Math.max(.35,flat)]);
      const end=add(start,scale(direction,range)), wall=this.traceShot(start,end,true);
      const length=range*(wall?.t??1);
      for (const part of [.28,.6,.92]) {
        const along=length*part;
        if (along<.9) continue;
        const point=stairEnd(start,add(start,scale(direction,along)));
        const ground=this.downwardSurface(point[0],point[1],point[2]);
        if (ground && point[1]-ground.position[1]<3.4) this.abilities.paintSurface(actor,ground,weapon.radius*paint*(.78+part*.5),weapon.depth);
      }
      if (wall && !wall.boundary) this.splat(wall,{actor,weapon,power:.7,paint,structureDamage:damage*.5});
    }
    const shift=stairNeighborShift(start[0],start[2],range), targets=this.abilities.enemies(actor,start[0]);
    if (shift) targets.push(...this.abilities.enemies(actor,start[0]+shift));
    const screened=new Set();
    for (const enemy of targets) {
      const other=!sameLevel(enemy.x,start[0]);
      const point=[enemy.x,enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.86),enemy.z];
      const local=[point[0]-(other?shift:0),point[1],point[2]], delta=sub(local,start), gap=Math.hypot(...delta);
      if (gap>range+(enemy.isBoss?1.3:0) || gap>.9 && dot(delta,aim)/gap<Math.cos(half+.14)) continue;
      if (other && !stairRay(start,local) || this.traceShot(start,local,true)?.t<.96) continue;
      const curtain=this.subweapons.block(start,local,team);
      if (curtain) {
        if (!screened.has(curtain.item)) curtain.item.hp-=damage*.55;
        screened.add(curtain.item);
        continue;
      }
      const lost=this.inkHit(enemy,damage*(1-.45*Math.min(1,gap/range)),actor,point);
      if (lost && !enemy.isBoss && enemy.down<=0) {
        const flatGap=Math.max(.3,Math.hypot(delta[0],delta[2]));
        this.stepActor(enemy,delta[0]/flatGap*.95,delta[2]/flatGap*.95);
      }
    }
    const [fx,,fz]=forward(yaw), middle=[start[0]+fx*range*.55,start[1],start[2]+fz*range*.55];
    this.stage.damageArea(this,actor,middle[0],middle[1]-.6,middle[2],range*.55,damage*.6);
    this.damageMetro(middle[0],middle[1],middle[2],range*.5,damage*.4);
    const floor=this.world.support(actor.x,actor.y,actor.z).y;
    this.abilities.rings.push({x:start[0],y:Math.max(floor,actor.y)+.05,z:start[2],r:range,team,until:this.clock+.46,span:.46,yaw,half});
    for (let i=0;i<30;i++) {
      const [dx,,dz]=forward(yaw+(this.rng()-.5)*2*half), speed=5+this.rng()*12, life=.26+this.rng()*.34;
      this.drops.push({p:start.slice(),v:[dx*speed,aim[1]*speed+1.2+this.rng()*3.2,dz*speed],life,max:life,team,size:.07+this.rng()*.16,wet:0});
    }
    if (this.drops.length>630) this.drops.splice(0,this.drops.length-630);
    actor.tank=Math.max(0,actor.tank-weapon.cost);
    actor.fire=actor.isPlayer?weapon.delay:weapon.delay+this.rng()*.12;
    actor.heat=.6;
    actor.recoil=1;
    actor.muzzleBlocked=!!launch.hit;
    this.perception.fire(actor);
    if (actor.isPlayer) this.callbacks.sound?.('blast');
    this.callbacks.cue?.('blast',actor);
    return true;
  }

  shoot(actor,target,power=1) {
    const weapon=actor.weapon;
    if (actor.fire>0 || actor.tank+INK_EPSILON<weapon.cost || actor.swimming || actor.down>0 || actor.giant || actor.beaming || actor.ride || actor.lift || actor.slam) return false;
    const launches=this.weaponLaunch(actor);
    if (weapon.blast) return this.blast(actor,target,launches);
    const start=launches.length===2?scale(add(launches[0].tip,launches[1].tip),.5):launches[0].tip;
    const delta=sub(target,start);
    const horizontal=Math.hypot(delta[0],delta[2]);
    const travel=shotTravel(weapon,horizontal,actor.rangeFactor,power);
    const central=[delta[0]/travel,(delta[1]+.5*weapon.gravity*travel*travel)/travel,delta[2]/travel];
    const lateral=unit(cross(central,[0,1,0]));
    const force=Math.hypot(...central);
    // OM Bomb: every round tracks. OM BOMB II fires each round twice at half power.
    const special=actor.superUntil>this.clock?actor.activeSpecial:null;
    const tracking=special==='om' || special==='om2', twin=special==='om2';
    const strength=(actor.damageFactor??1)*(twin?.5:1), paint=actor.paintFactor??1;
    for (let copy=0;copy<(twin?2:1);copy++) for (let i=0;i<weapon.pellets;i++) {
      const fan=weapon.pellets>1?(i/(weapon.pellets-1)-.5):this.rng()-.5;
      const v=add(central,scale(lateral,force*weapon.spread*fan));
      v[1]+=(this.rng()-.5)*force*weapon.spread*.25;
      if (twin) {
        const offset=force*.021*(copy?1:-1);
        v[0]+=lateral[0]*offset;
        v[1]+=force*.012*(copy?1:-1);
        v[2]+=lateral[2]*offset;
      }
      const bend=weapon.swirl?scale(lateral,(this.rng()>.5?1:-1)*weapon.swirl):null;
      const launch=launches[i%launches.length], shot={pos:launch.position.slice(),vel:v,actor,weapon,power,age:0,bend};
      if (tracking) shot.homing={...OM_HOMING};
      if (strength!==1) shot.dmg=strength;
      if (paint!==1) shot.paint=paint;
      if (!this.impactShot(shot,launch.origin,launch.tip,launch.hit)) {
        shot.id=++this.shotSequence;
        this.shots.push(shot);
      }
    }
    actor.tank=Math.max(0,actor.tank-weapon.cost);
    actor.fire=actor.isPlayer?weapon.delay:Math.max(.18,weapon.delay)+(weapon.charge?.30:.0)+this.rng()*.085;
    actor.heat=.51;
    actor.recoil=1;
    actor.muzzleBlocked=launches.every(launch=>!!launch.hit);
    this.perception.fire(actor);
    if (actor.isPlayer) this.callbacks.sound?.(weapon.id==='lob'?'lob':'shot');
    this.callbacks.cue?.('shot',actor);
    return true;
  }

  burst(point,team,count,power,wet=0) {
    for (let i=0;i<count;i++) {
      const angle=this.rng()*TAU, v=(.26+this.rng()*.74)*power;
      const life=.29+this.rng()*.48;
      this.drops.push({p:point.slice(),v:[Math.cos(angle)*v,(.38+this.rng())*power,Math.sin(angle)*v],
        life,max:life,team,size:.042+this.rng()*.136,wet});
    }
    if (this.drops.length>630) this.drops.splice(0,this.drops.length-630);
  }

  coat(hit,team,radius,phase,volume=0) {
    this.decals.push({p:add(hit.position,scale(hit.normal,.023)),normal:hit.normal,team,phase,radius,
      shape:hit.shape?.id??-1,id:++this.decalSequence,volume});
    if (this.decals.length>310) this.decals.shift();
  }

  splat(hit,shot,scaleSize=1) {
    if (hit.boundary) return;
    const p=hit.position, team=shot.actor.team, weapon=shot.weapon ?? shot.actor.weapon;
    const size=weapon.radius*(.88+this.rng()*.23)*scaleSize*1.26*(shot.power??1)*(shot.paint??1);
    const force=(weapon.damage??0)*(shot.power??1)*(shot.dmg??1);
    const phase=this.rng()*TAU;
    if (shot.vel && (shot.actor.isPlayer || this.mode==='watch') && !this.inkImpacts.some(mark=>
      mark.normal && mark.at===this.clock && mark.team===team && Math.hypot(...sub(mark.p,p))<.70)) {
      this.addInkImpact({p,team,normal:hit.normal});
    }
    if (hit.cabinWindow) {
      const amount=shot.structureDamage ?? force;
      hit.cabinWindow.hitWindow(hit.shape.windowId,amount);
      hit.cabinWindow.damage(amount*.095);
    } else if (hit.train) {
      const amount=force;
      hit.train.splatter(hit,team,size,shot.structureDamage??amount*.095,shot.structureDamage??amount);
    } else if (hit.stageObject) {
      const damage=shot.structureDamage ?? force;
      this.stage.strike(hit.stageObject,damage,this.clock,team);
    } else if (team<0) {
      this.burst(add(p,scale(hit.normal,.027)),team,5,1.6);
      return;
    } else {
      const field=this.paint.hasSurface(p[0],p[2],hit.layer);
      if (field) {
        shot.actor.painted+=this.paint.stampGround(p[0],p[2],size,team,hit.layer,phase,weapon.depth);
        if (shot.vel) this.paint.kick(p[0],p[2],hit.layer,shot.vel[0]*.38,shot.vel[2]*.38);
      } else if (hit.shape) {
        const radius=size*surfacePaintRadius(hit.normal);
        const volume=Math.abs(hit.normal[1])<.54?radius**2*(weapon.depth??.035)*.018:0;
        this.coat(hit,team,radius,phase,volume);
      }
    }
    this.burst(add(p,scale(hit.normal,.027)),team,weapon.pellets>1?3:Math.round(6+size*2.4),1.95+size*.74,hit.layer===undefined?0:.009+size*.007);
  }

  damageMetro(x,y,z,radius,amount) {
    if (isCabin(x)) return this.cabinTrain(x).damage(amount*.31);
    let lost=0;
    for (const rail of [this.transit,this.metro]) {
      if (!rail.visibleIn(zoneOf(x))) continue;
      const {line,train}=rail, center=line.center+train.x;
      const nearX=clamp(x,center-9.05,center+9.05), nearZ=clamp(z,line.z+train.lateral-1.6,line.z+train.lateral+1.6);
      if (Math.hypot(x-nearX,z-nearZ)>radius || Math.abs(y-line.y)>4.4) continue;
      const hit=this.traceShot([x,y+.48,z],[nearX,line.y+2.1,nearZ],true);
      if (!hit || hit.train===rail) lost+=rail.damage(amount*.62);
    }
    return lost;
  }

  damage(actor,baseDamage,source,point,cause=null) {
    const reduced=baseDamage*DAMAGE_SCALE*(source && !source.isPlayer ? .91 : 1);
    // A copy fights on its caster's record.
    const credit=source?.cloneOf ?? source;
    if (actor.isBoss || actor.isRaider) {
      const lost=actor.isBoss?this.boss.hurt(reduced):this.raiders.hurt(actor,reduced,credit);
      if (lost && source) {
        source.superCharge=Math.min(100,source.superCharge+lost*.25*chargeGain(source));
        credit.dealt=(credit.dealt??0)+lost;
        this.burst(point,source.team,5,2.14);
        if (source.isPlayer) this.callbacks.sound?.('hit');
        this.callbacks.cue?.(actor.isBoss?'hit':actor.active?'hit':'down',actor,source);
      }
      return lost;
    }
    if (actor.down>0 || actor.shield>0 || actor.lift || actor.ride) return 0;
    const lost=Math.min(actor.hp,this.abilities.reduce(actor,reduced));
    if (!(lost>0)) return 0;
    actor.hp-=lost;
    actor.damageAge=0;
    actor.lastDamageAt=this.clock;
    if (source) source.superCharge=Math.min(100,source.superCharge+lost*.36*chargeGain(source));
    if (credit) credit.dealt=(credit.dealt??0)+lost;
    if (source?.isPlayer) this.callbacks.sound?.('hit');
    if (actor.isPlayer) this.callbacks.sound?.('damage');
    this.burst(point,source?.team ?? -1,6,2.41);
    if (actor.hp>0) {
      this.callbacks.cue?.('hit',actor,source);
      return lost;
    }
    const boss=cause==='boss' || !source;
    actor.down=actor.cloneOf?Infinity:boss?BOSS_RESPAWN_SECONDS:RESPAWN_SECONDS;
    actor.downBy=boss?'boss':source.isRaider?'raid':'crew';
    actor.swimming=actor.inkSwimming=actor.climbing=false;
    actor.downs++;
    this.abilities.clearSuper(actor);
    if (actor.cloneOf) actor.maxHp=actor.baseHp??actor.maxHp;
    if (source) {
      // Splatting a copy is not an elimination: it earns no kill and no EXP.
      if (!actor.cloneOf) credit.kills++;
      if (source.team>=0) {
        const {x,y,z}=actor, floor=this.world.floor(x,z);
        const hit=this.traceShot([x,Math.max(y,floor.y)+.12,z],[x,floor.y-.13,z],true,false);
        if (hit) this.splat(hit,{actor:source,weapon:WEAPONS[0]},1.43);
      }
    }
    this.burst([actor.x,actor.y+1.05,actor.z],source?.team ?? -1,actor.cloneOf?12:26,actor.cloneOf?3.1:4.4);
    this.abilities.rings.push({x:actor.x,y:actor.y+.06,z:actor.z,r:2.6,team:Math.max(0,source?.team??actor.team),until:this.clock+.55});
    this.events.unshift({label:(source?.name ?? this.boss.name)+'  ▸  '+actor.name,team:source?.team ?? -1,until:this.clock+3.4});
    this.events.length=Math.min(this.events.length,4);
    if (source?.isPlayer) this.callbacks.sound?.('down');
    this.callbacks.cue?.('down',actor,source);
    return lost;
  }

  inkHit(target,damage,source,point) {
    const lost=this.damage(target,damage,source,point);
    const team=source.team;
    if (lost>0 && (source.isPlayer || source.cloneOf?.isPlayer || this.mode==='watch')) {
      const finished=target.isBoss || target.isRaider?!target.active:target.down>0;
      const prior=this.inkImpacts.find(hit=>hit.at===this.clock && hit.target===target && hit.team===team);
      if (prior) prior.kind=Math.max(prior.kind??1,finished?2:1);
      else this.addInkImpact({p:point,team,target,kind:finished?2:1});
    }
    return lost;
  }

  addInkImpact(impact) {
    this.inkImpacts.push({...impact,at:this.clock});
    if (this.inkImpacts.length>48) this.inkImpacts.shift();
  }

  impactShot(shot,from,to,wall=this.traceShot(from,to,true)) {
    const tolerance=clamp(shot.weapon.size*.36,.055,.115);
    const actor=this.findActor(from,to,shot.actor.team,true,tolerance);
    const curtain=this.subweapons.block(from,to,shot.actor.team);
    if (curtain && (!wall || curtain.t<wall.t) && (!actor || curtain.t<actor.t)) {
      curtain.item.hp-=shot.weapon.damage*shot.power*(shot.dmg??1);
      this.burst(curtain.p,shot.actor.team,4,1.7);
    } else if (actor && (!wall || actor.t<wall.t)) {
      const point=add(from,scale(sub(to,from),actor.t));
      point[0]+=actor.shift??0;
      this.inkHit(actor.actor,shot.weapon.damage*shot.power*(shot.dmg??1),shot.actor,point);
    } else if (wall) this.splat(wall,shot);
    else return false;
    return true;
  }

  // Turns a tracking round toward the best opponent inside its seeker cone.
  guideShot(shot,dt) {
    const {turn,cone,reach}=shot.homing, [vx,vy,vz]=shot.vel, speed=Math.hypot(vx,vy,vz);
    if (speed<1) return;
    const [px,py,pz]=shot.pos, limit=Math.cos(cone);
    let best=-Infinity, wx=0, wy=0, wz=0;
    for (const enemy of this.abilities.enemies(shot.actor,px)) {
      if (enemy.shield>0) continue;
      const dx=enemy.x-px, dy=enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.9)-py, dz=enemy.z-pz, gap=Math.hypot(dx,dy,dz);
      if (gap>reach || gap<.25) continue;
      const facing=(dx*vx+dy*vy+dz*vz)/(gap*speed), value=facing-gap/reach*.1;
      if (facing<limit || value<=best) continue;
      best=value;
      wx=dx/gap;wy=dy/gap;wz=dz/gap;
    }
    if (best===-Infinity) return;
    const ux=vx/speed, uy=vy/speed, uz=vz/speed;
    const angle=Math.acos(clamp(ux*wx+uy*wy+uz*wz,-1,1));
    if (angle<1e-4) return;
    const t=Math.min(1,turn*dt/angle), sine=Math.sin(angle);
    const keep=Math.sin((1-t)*angle)/sine, steer=Math.sin(t*angle)/sine;
    shot.vel=[(ux*keep+wx*steer)*speed,(uy*keep+wy*steer)*speed,(uz*keep+wz*steer)*speed];
  }

  drainWalls(dt) {
    for (const mark of this.decals) {
      const volume=wallRunoff(mark,dt);
      if (!volume) continue;
      const n=mark.normal, down=unit([n[0]*n[1],n[1]*n[1]-1,n[2]*n[1]]);
      const rim=this.world.geometry.coat(mark,decalBasis(n,mark.phase),DECAL_RIM);
      let foot=mark.p;
      if (rim?.length) {
        foot=rim.reduce((lowest,p)=>p[1]<lowest[1]?p:lowest,rim[0]);
        foot=add(foot,scale(n,.034));
      }
      if (this.drops.length>=630) {
        mark.volume+=volume;
        continue;
      }
      this.drops.push({p:foot.slice(),v:add(scale(down,.9),scale(n,.27)),team:mark.team,volume,
        life:7.2,max:7.2,size:Math.max(.058,Math.cbrt(volume)*1.75)});
    }
  }

  landDrop(drop,hit) {
    if (hit.boundary || drop.v[1]>=0) return;
    const [x,,z]=hit.position;
    if (drop.volume) {
      if (this.paint.depositDrop(x,z,hit.layer,drop.team,drop.volume,drop.v[0],drop.v[2])) return;
      if (hit.shape?.id>=0) this.coat(hit,drop.team,Math.max(.12,drop.size*2.8),0,drop.volume);
    } else if (hit.layer!==undefined) {
      this.paint.stampGround(x,z,drop.size*2.4,drop.team,hit.layer,0,drop.wet);
    }
  }

  updateShots(dt) {
    this.drainWalls(dt);
    while (this.inkImpacts.length && this.clock-this.inkImpacts[0].at>=INK_HIT_DURATION) this.inkImpacts.shift();
    for (let i=this.shots.length-1;i>=0;i--) {
      const shot=this.shots[i];
      if (shot.life!==undefined && shot.age>=shot.life) {
        this.burst(shot.pos,shot.actor.team,3,1.2);
        this.shots.splice(i,1);
        continue;
      }
      if (shot.homing) this.guideShot(shot,dt);
      if (shot.bend) {
        const turn=Math.sin(shot.age*7.1)*dt;
        shot.vel[0]+=shot.bend[0]*turn;
        shot.vel[2]+=shot.bend[2]*turn;
      }
      const to=add(shot.pos,scale(shot.vel,dt));
      to[1]-=.5*shot.weapon.gravity*dt*dt;
      const fraction=shotFraction(shot.pos,to);
      const end=fraction<1?add(shot.pos,scale(sub(to,shot.pos),fraction)):to;
      if (fraction>0 && this.impactShot(shot,shot.pos,end) || fraction<1 || to[1]<ZONES[zoneOf(shot.pos[0])].y-18) {
        this.shots.splice(i,1);
        continue;
      }
      shot.vel[1]-=shot.weapon.gravity*dt;
      shot.pos=stairEnd(shot.pos,to);
      shot.age+=dt;
    }
    for (let i=this.drops.length-1;i>=0;i--) {
      const drop=this.drops[i];
      const from=drop.p, to=add(from,scale(drop.v,dt)), wet=(drop.wet || drop.volume) && drop.team>=0;
      const hit=wet && this.traceShot(from,to,true);
      if (hit) {
        this.landDrop(drop,hit);
        this.drops.splice(i,1);
        continue;
      }
      drop.p=stairEnd(from,to);
      drop.v[1]-=9.81*dt;
      drop.life-=dt;
      const [dx,dy,dz]=drop.p;
      const zone=zoneOf(dx), line=zone===0?RAIL:zone===1?METRO:null;
      const landsOnRail=line && from[1]>=line.y && dy<=line.y && Math.abs(dx-line.center)<line.edge && Math.abs(dz-line.z)<line.halfWidth;
      const floor=landsOnRail?{y:line.y,layer:line.layer}:this.world.floor(dx,dz);
      if (drop.p[1]<=floor.y) {
        if (wet) this.landDrop(drop,{position:drop.p,layer:floor.layer});
        this.drops.splice(i,1);
      } else if (drop.life<=0) this.drops.splice(i,1);
    }
  }

  update(dt,input,camera) {
    if (this.finished || dt<=0) return;
    if (this.countdown>0) {
      const waiting=Math.min(dt,this.countdown);
      this.clock+=waiting;
      const previous=Math.ceil(this.countdown);
      this.countdown-=waiting;
      this.paint.advance(waiting);
      if (Math.ceil(this.countdown)<previous) this.callbacks.sound?.(this.countdown>0?'tick':'go');
      if (this.player) {
        this.player.yaw=input.yaw;
        this.player.pitch=input.pitch;
      }
      dt-=waiting;
      if (dt<=0) return;
    }
    if (!this.timeless) dt=Math.min(dt,this.left);
    if (dt<=0) {
      this.finishMatch();
      return;
    }
    this.clock+=dt;
    if (this.timeless) this.elapsed+=dt;
    else {
      this.left=Math.max(0,this.left-dt);
      this.elapsed=this.duration-this.left;
    }
    this.transit.update(this.elapsed);
    this.metro.update(this.elapsed);
    this.motion.begin();
    this.tactics.squads.refresh();
    for (const actor of this.actors) {
      if (actor.down>0) {
        actor.down-=dt;
        if (actor.down<=0) {
          respawn(actor);
          this.tactics.states.delete(actor);
          this.perception.memory.delete(actor);
          if (actor.isPlayer) this.callbacks.spawn?.(actor);
        }
        continue;
      }
      actor.fire-=dt;
      actor.rolling=false;
      actor.heat-=dt;
      actor.shield=Math.max(0,actor.shield-dt);
      actor.recoil=Math.max(0,actor.recoil-dt*8.3);
      actor.damageAge+=dt;
      this.inkPressure(actor,dt);
      this.abilities.credit(actor);
      let crossed=false;
      if (actor.isPlayer) {
        actor.yaw=input.yaw;
        actor.pitch=input.pitch;
        if (input.use) crossed=this.useTransport(actor);
        if (input.super) this.abilities.activate(actor);
        if (input.drone) this.abilities.summon(actor);
      }
      if (actor.revealUntil>this.clock && actor.revealTeam>=0) {
        // A marked crew member is common knowledge for the team that tagged it.
        this.tactics.contacts[actor.revealTeam]?.set(actor,{x:actor.x,y:actor.y,z:actor.z,until:this.clock+7.5});
      }
      const carried=this.carryTransit(actor,dt);
      const occupied=this.abilities.updateActor(actor,dt);
      if (!carried && !occupied && !crossed) {
        if (actor.isPlayer) this.control(actor,input,dt,camera);
        else this.npc(actor,dt);
      }
      const factor=1-(actor.inkPenalty??0)*.072;
      const refill=actor.swimming?(actor.inkSwimming?48:18):actor.heat<=0?(actor.isPlayer?13:17):0;
      actor.tank=Math.min(actor.tankMax,actor.tank+refill*dt*factor);
      this.pickupChip(actor);
      if (actor.damageAge>1.9) {
        const recovery=actor.swimming?(actor.inkSwimming?28:20):19;
        actor.hp=Math.min(actor.maxHp,actor.hp+recovery*dt*factor);
      }
    }
    this.updateShots(dt);
    this.subweapons.update(dt);
    this.abilities.update(dt);
    this.retireClones();
    if (!this.timeless) this.boss.update(dt);
    this.raiders.update(dt);
    for (const raider of this.raiders.members) if (raider.active) this.pickupChip(raider);
    if (this.mode==='watch' && this.cameraActor().down>0) this.cycle();
    this.paint.advance(dt);
    this.events=this.events.filter(event=>event.until>this.clock);
    if (!this.timeless && this.left<=0) this.finishMatch();
  }

  finishMatch() {
    this.finished=true;
    this.callbacks.sound?.('finish');
    this.callbacks.finish?.();
  }

  draw(renderer,viewX=this.cameraActor().x,viewZ=this.cameraActor().z,hideCrew=null,viewY=2.5,stair=false) {
    this.drawLevel(renderer,viewX,viewZ,hideCrew,viewY);
    const zone=zoneOf(viewX);
    if (!stair || zone>=2) return;
    renderer.drawingAdjacent=true;
    this.drawLevel(renderer,viewX-ZONES[zone].x+ZONES[1-zone].x,viewZ,hideCrew,viewY);
    renderer.drawingAdjacent=false;
  }

  drawLevel(renderer,viewX,viewZ,hideCrew,viewY) {
    const zone=zoneOf(viewX);
    const visualClock=this.clock+(this.impactAgeOffset??0);
    this.stage.draw(renderer,viewX,visualClock);
    if (zone<2) for (const rail of [this.transit,this.metro]) if (rail.visibleIn(zone)) rail.draw(renderer);
    if (zone>=2) drawCabinScenery(renderer,this.cabinTrain(viewX));
    const chip=this.chip;
    if (!chip.owner && sameLevel(chip.x,viewX)) {
      const opts={dynamic:true,yaw:chip.yaw};
      renderer.add('bevel',chip.x,chip.y+.026,chip.z,.33,.052,.20,0x5e6858,4,opts);
      renderer.add('box',chip.x,chip.y+.058,chip.z,.195,.013,.132,0x333b36,4,opts);
      for (const side of [-1,1]) renderer.add('box',chip.x+Math.cos(chip.yaw)*side*.122,chip.y+.057,
        chip.z-Math.sin(chip.yaw)*side*.122,.063,.011,.153,0xa29670,4,opts);
    }
    // The lightweight modes draw nothing beyond their fogged draw distance.
    const reach=renderer.reach??Infinity, within=(x,z,limit)=>limit===Infinity || Math.hypot(x-viewX,z-viewZ)<limit;
    for (const actor of this.actors) {
      if (actor!==hideCrew && actor.down<=0 && !actor.ride && sameLevel(actor.x,viewX) && within(actor.x,actor.z,reach+6)) {
        drawCrew(renderer,actor,visualClock);
      }
    }
    this.abilities.draw(renderer,viewX);
    this.subweapons.draw(renderer,viewX);
    this.boss.draw(renderer,viewX);
    this.raiders.draw(renderer,viewX);
    for (const shot of this.shots) {
      if (!sameLevel(shot.pos[0],viewX) || !within(shot.pos[0],shot.pos[2],reach)) continue;
      const y=unit(shot.vel), x=unit(cross(y,[0,1,0])), z=cross(x,y);
      const position=add(shot.pos,scale(y,-.11));
      const size=shot.weapon.size, ink=TEAM_INK[shot.actor.team] ?? RAIDER_INK;
      renderer.add('orb',...position,size,size*(shot.weapon.id==='lob'?1.42:2.84),size,ink,9,{dynamic:true,basis:[x,y,z]});
      if (renderer.fidelity) {
        // A liquid streak that stretches with speed behind the leading drop.
        const speed=Math.hypot(...shot.vel), tail=clamp(speed*.022,.22,.95)*(shot.weapon.id==='lob'?.55:1);
        renderer.add('limb',...add(position,scale(y,-tail*.5)),size*.78,tail,size*.78,ink,9,{dynamic:true,basis:[x,y,z]});
        renderer.add('orb',...add(position,scale(y,size*.35)),size*.42,size*.9,size*.42,0xf6fffc,3,{dynamic:true,basis:[x,y,z]});
      } else if (!renderer.lite) {
        const trail=add(position,scale(y,-.28));
        renderer.add('orb',...trail,size*.48,size*1.22,size*.48,ink,9,{dynamic:true,basis:[x,y,z]});
      }
    }
    for (let i=0;i<this.drops.length;i+=renderer.ultra?3:renderer.lite?2:1) {
      const d=this.drops[i];
      if (!sameLevel(d.p[0],viewX) || !within(d.p[0],d.p[2],reach*.7)) continue;
      const size=d.size*(.46+.54*d.life/d.max);
      renderer.add('orb',...d.p,size,size*1.42,size,TEAM_INK[d.team] ?? 0xb573c7,9,{dynamic:true});
    }
    for (const hit of this.inkImpacts) {
      if (sameLevel(hit.p[0],viewX)) drawInkImpact(renderer,hit,[viewX,viewY,viewZ],this.clock+(this.impactAgeOffset??0));
    }
    const markReach=Math.min(140,reach*.8);
    for (const decal of this.decals) {
      if (!sameLevel(decal.p[0],viewX) || Math.hypot(decal.p[0]-viewX,decal.p[2]-viewZ)>markReach) continue;
      const tint=TEAM_INK[decal.team];
      const shape=decalShape(this.world.geometry,decal);
      if (shape.fan) {
        for (const basis of shape.fan) renderer.add('tri',...shape.origin,1,1,1,tint,26,{dynamic:true,basis});
      } else renderer.add('splat',...shape.origin,decal.radius*1.66,decal.radius*1.35,1,tint,26,{dynamic:true,basis:shape.axes});
    }
  }
}

function crewPose(a,time,yaw=Math.PI-a.yaw) {
  const vx=a.vx??0,vz=a.vz??0,vy=a.vy??0,phase=a.steps??0;
  const speed=Math.hypot(vx,vz),pace=clamp(speed/5.9,0,1);
  const cy=Math.cos(yaw),sy=Math.sin(yaw);
  const loc=(x,y,z)=>[a.x+x*cy+z*sy,a.y+y,a.z-x*sy+z*cy];
  const fore=(vx*sy+vz*cy)/Math.max(1,speed),lateral=(vx*cy-vz*sy)/Math.max(1,speed);
  const airborne=a.airborne ?? Math.abs(vy)>.48,rising=airborne && vy>0;
  const crouch=a.landing??0,swing=Math.sin(phase),transfer=Math.cos(phase);
  const brace=a.brace??0, peek=a.peek??0, ready=a.readyPose??0, hit=a.flare??0;
  const rise=airborne?(rising?.048:-.018):Math.abs(swing)*pace*.053+Math.sin(time*4.6+a.index)*.016*(1-pace)-crouch*.19-brace*.36;
  const sway=pace*lateral*.15+(a.poseBank??0)*.21+peek*.24,lean=pace*fore*.17+crouch*.14+brace*.082+ready*.028-hit*.083;
  return {cy,sy,loc,phase,pace,fore,lateral,airborne,rising,crouch,swing,transfer,rise,sway,lean};
}

function rollerPosition(a) {
  const recoil=a.recoil??0;
  return {y:a.rolling?.31:1.48-recoil*.55,z:a.rolling?.86:.76+recoil*.18};
}

function gunPose(a,pose,weapon=a.weapon??WEAPONS[0]) {
  const pitch=-(a.pitch??0)*.47-pose.lean*.48;
  const c=Math.cos(pitch),s=Math.sin(pitch),recoil=(a.recoil??0)*.105;
  const at=(x,y,z)=>{
    const dy=y-1.25,dz=z-.437-recoil;
    return pose.loc(x+pose.sway*.87,1.25+pose.rise*.87+dy*c-dz*s,.437+pose.lean*.87+dy*s+dz*c);
  };
  const barrel=weapon.id==='charge'?.56:weapon.id==='lob'?.34:weapon.id==='rd2'?.44:weapon.id==='td'?.30:.315;
  return {at,pitch,barrel};
}

export function drawCrew(r,a,time,showEffects=true) {
  const tint=TEAM[a.team], bright=TEAM_INK[a.team];
  // Render-only detail: hit detection collects the plain shapes, so the
  // silhouette and every pose stay identical to what shots are tested against.
  const view=r.viewPoint;
  const range=view?Math.hypot(a.x-view[0],a.y-view[1],a.z-view[2]):0;
  const hi=!!r.fidelity && range<(r.lite?13:26);
  const soft=hi?'soft':'bevel', limbShape=hi?'limb':'taper';
  const grip=a.climbing && a.climbNormal;
  const yaw=Math.PI-(grip?Math.atan2(-grip[0],grip[2]):a.isPlayer || a.swimming || a.weapon?.roller?a.yaw:a.bodyYaw??a.yaw);
  if (a.giant) {
    drawSquid(r,a,time,tint,0xffebbd,giantScale(a.x));
    return;
  }
  if (r.fidelity && showEffects && range<60 && !a.climbing && !(a.airborne ?? Math.abs(a.vy??0)>.48)) {
    r.add('shade',a.x,a.y+.016,a.z,a.swimming?1.05:1.25,1,a.swimming?1.35:1.25,0,28,{dynamic:true,label:.62});
  }
  if (showEffects && a.guard>0) {
    const pulse=.15*Math.sin(time*8);
    r.add('ripple',a.x,a.y+.06,a.z,2.14+pulse,.03,2.14+pulse,0xd3fff2,12,{dynamic:true,label:.08});
    r.add('ripple',a.x,a.y+1.03,a.z,2.02,.03,2.02,0x86ded0,12,{dynamic:true,label:.24});
    for (let i=0;i<4;i++) {
      const angle=i*TAU/4, direction=forward(angle);
      r.add('curtain',a.x+direction[0]*.69,a.y+.99,a.z+direction[2]*.69,1.31,1.84,1,bright,16,
        {dynamic:true,yaw:-angle,label:1-a.guard/95});
    }
  }
  const pose=crewPose(a,time,yaw);
  const {cy,sy,loc,phase,pace,fore,lateral,airborne,rising,crouch,swing,transfer,rise,sway,lean}=pose;
  if (a.swimming) {
    const pull=time*(a.climbing?11:a.inkSwimming?14:8)+phase*.82+a.index*.8;
    const stretch=1+pace*(a.inkSwimming?.26:.08);
    const tilt=a.climbing?-Math.PI/2:Math.cos(pull)*pace*.10;
    const cp=Math.cos(tilt),sp=Math.sin(tilt);
    const centerY=a.climbing?.54:.11, centerZ=a.climbing?.17:0;
    const squid=(type,x,y,z,w,h,d,color,material,pitch=0)=>{
      const p=loc(x,centerY+(y-.11)*cp-z*sp,centerZ+(y-.11)*sp+z*cp);
      r.add(type,...p,w,h,d,color,material,{dynamic:true,yaw,pitch:pitch+tilt});
    };
    squid('orb',0,.104,-.067,.69,.178,.94*stretch,bright,9);
    squid(soft,0,.139,-.116,.64,.173,.68*stretch,tint,9,-.10);
    squid('orb',0,.193,.15,.43,.287,.48,tint,9,-.25);
    squid(soft,0,.227,.321,.317,.126,.151,0x293f49,8,-.09);
    squid(soft,0,.265,.165,.102,.029,.274,bright,9);
    for (const sign of [-1,1]) {
      squid(soft,sign*.084,.241,.376,.078,.052,.035,0xdbf2d3,3);
      if (hi) squid('orb',sign*.084,.247,.392,.034,.03,.016,0x0b1214,8);
      const stroke=Math.sin(pull+sign*.92), effort=a.climbing?.11:.045+pace*.065;
      squid('orb',sign*(.19+stroke*effort),.068+stroke*.022,-.47-stroke*.06,.188,.08,.50*stretch,bright,9,stroke*.18);
    }
    for (let i=0;i<4;i++) {
      const tail=(i-1.5)*.105, stroke=Math.sin(pull+i*.76);
      squid(hi?'limb':'taper',tail,.079,-.56-stretch*.10,.093,.32+stretch*.12,.085,tint,9,Math.PI/2+stroke*.19);
    }
    if (hi) for (const sign of [-1,1]) squid('limb',sign*.21,.15,.05,.06,.34,.05,bright,9,Math.PI/2.3);
    return;
  }
  const material=(mat,c)=>mat===2?(c===BOOT || c===GRAPHITE?21:18):mat===4 && (c===tint || c===bright)?20:mat;
  const part=(type,x,y,z,w,h,d,c,mat=2,pitch=0)=>{
    const upper=clamp((y-.66)*1.06,0,1);
    r.add(type,...loc(x+sway*upper,y+rise*upper,z+lean*upper),w,h,d,c,material(mat,c),
      {dynamic:true,yaw,pitch:pitch-lean*upper*.48});
  };
  const weapon=a.weapon ?? WEAPONS[0];
  const aimYaw=Math.PI-a.yaw;
  const gun=weapon.roller?null:gunPose(a,crewPose(a,time,aimYaw));
  const torso=(x,y,z)=>{
    const upper=clamp((y-.66)*1.06,0,1);
    return loc(x+sway*upper,y+rise*upper,z+lean*upper);
  };
  // A fresh hit flashes the whole suit; an ebot copy wears a paler shell.
  const struck=a.damageAge<.15, copy=!!(a.clone || a.cloneOf);
  const hit=struck?0xffd0b0:copy?0xeef6f0:0xd5ddd0;
  const armor=struck?0xff8f70:copy?0x6d8792:0x263943;
  if (showEffects && copy) {
    const spin=time*2.4+(a.index??0);
    r.add('ring',a.x,a.y+2.32+Math.sin(spin)*.03,a.z,.5,.05,.5,bright,3,{dynamic:true,yaw:spin});
  }
  if (showEffects && (a.activeSpecial==='om' || a.activeSpecial==='om2') && a.superUntil>time) {
    // OM Bomb: seeker lights orbit the crew member while its rounds track.
    const count=a.activeSpecial==='om2'?4:2;
    for (let i=0;i<count;i++) {
      const angle=time*5.2+i*TAU/count, lift=1.15+.35*Math.sin(time*3.1+i*1.7);
      r.add('orb',a.x+Math.cos(angle)*.72,a.y+lift,a.z+Math.sin(angle)*.72,.13,.13,.13,i%2?0xfff4ce:bright,3,{dynamic:true});
    }
    r.add('ripple',a.x,a.y+.05,a.z,1.7+.2*Math.sin(time*9),.03,1.7+.2*Math.sin(time*9),0xfff4ce,12,{dynamic:true,label:.35});
  }
  const accent=[0xe0c88f,0xb5d7cb,0x9eb8d0,0xe2a47d][(a.index??0)%4];
  const visor=a.team===0?0x4c8c99:0x825650;
  part(soft,0,.99,-.025,.66,.62,.44,armor,2,.13);
  part(soft,0,1.13,.063,.61,.34,.43,tint,20);
  part(soft,0,1.18,.272,.36,.16,.062,hit,18);
  part(soft,0,.80,.186,.54,.14,.17,GRAPHITE,21);
  part('bevel',0,.824,.284,.169,.080,.045,accent,4);
  part(soft,0,1.402,.014,.38,.19,.34,GRAPHITE,21);
  part('orb',0,1.716,-.012,.665,.565,.618,armor,20,.10);
  part('orb',0,1.891,-.025,.601,.207,.546,tint,20,.15);
  part(soft,0,1.814,-.162,.476,.112,.308,tint,20,.075);
  part('bevel',0,1.719,.267,.609,.252,.206,0x182a34,4,.055);
  part('bevel',0,1.714,.349,.529,.179,.101,visor,8,.068);
  part('bevel',0,1.812,.310,.51,.040,.147,accent,20);
  part(soft,0,1.506,.267,.426,.158,.214,0x314851,21,-.07);
  part('box',0,1.522,.372,.259,.050,.026,0x1c2931,4);
  if (hi) {
    part('box',0,1.664,.392,.44,.009,.012,bright,3,.068);
    part('box',0,1.715,.395,.47,.12,.004,0x0e1a20,8,.068);
    part('ring',0,1.80,-.02,.63,.05,.58,0x1a262c,4);
    part('box',0,1.18,.30,.018,.15,.012,TRIM,4);
    for (const dy of [.86,.91]) part('box',0,dy,.268,.50,.012,.02,0x1b2529,21);
  }
  for (const sign of [-1,1]) {
    part(soft,sign*.256,1.647,.267,.164,.236,.206,GRAPHITE,20);
    part('cylinder',sign*.320,1.685,.009,.228,.098,.228,tint,20);
    part(soft,sign*.326,1.68,.039,.102,.164,.229,armor,4);
    part('box',sign*.330,1.712,.157,.071,.064,.039,bright,3);
    const curl=Math.sin(time*4+a.index+sign)*.1;
    part(limbShape,sign*.225,1.442,-.180,.144,.318,.143,bright,9,.24+curl);
    part('orb',sign*.218,1.301,-.218,.105,.141,.132,tint,9);
    for (const dz of [-.06,.02,.10]) part('box',sign*.161,1.546,.344+dz*.35,.044,.031,.013,TRIM,4);
    part(soft,sign*.225,1.074,.246,.119,.270,.085,armor,21);
    part('box',sign*.23,1.154,.293,.055,.084,.019,accent,3);
    if (hi) {
      part('cylinder',sign*.378,1.685,.009,.11,.012,.11,0x9aa7a4,4);
      part(soft,sign*.21,.82,.20,.13,.12,.07,GRAPHITE,21);
      part('box',sign*.12,1.10,.285,.03,.30,.012,0x1d282c,21,.05);
    }
  }
  part(soft,0,1.989,-.086,.121,.042,.323,accent,20);
  const capacity=a.tankMax ?? BASE_TANK, expanded=capacity>BASE_TANK;
  const tankHeight=expanded?1.11:.79, fill=tankHeight*.70*clamp(a.tank/capacity,0,1);
  part(soft,0,1.13,-.294,.53,.57,.218,armor,21);
  part('bevel',0,1.125,-.458,.463,tankHeight,.31,hi?0x3a474b:0x778d90,4);
  if (!hi) part('bevel',0,1.125,-.557,.362,tankHeight*.82,.176,visor,8);
  for (const sign of [-1,1]) {
    part(soft,0,1.125+sign*(tankHeight*.50-.05),-.463,.479,.12,.285,armor,20);
    part('bevel',sign*.198,1.125,-.551,.073,tankHeight*.74,.134,accent,4);
    part('box',0,1.125+sign*tankHeight*.33,-.648,.305,.034,.025,TRIM,4);
  }
  part('bevel',0,1.125,-.657,.086,tankHeight*.75,.029,GRAPHITE,4);
  if (fill>.003) part('box',0,1.125+(fill-tankHeight*.70)*.5,-.678,.045,fill,.020,bright,3);
  if (hi) {
    // A clear canister: dark liner, sloshing ink column, glass front.
    const inner=tankHeight*.74, level=clamp(a.tank/capacity,0,1), slosh=Math.sin(time*5.3+a.index)*.05*(pace+.2);
    part('box',0,1.125,-.535,.33,inner+.02,.05,0x10181b,21);
    if (level>.01) part('box',0,1.125-inner*.5+inner*level*.5,-.585,.31,inner*level,.09,bright,9,slosh*.2);
    part('glass',0,1.125,-.636,.35,inner+.03,1,0xd8f0ea,17);
    part('box',0,1.125+tankHeight*.38,-.47,.08,.05,.08,0x9aa7a4,4);
  }
  for (const sign of [-1,1]) {
    const step=swing*sign*pace;
    const forwardStep=airborne?sign*(rising?.20:.12):fore*step*.39;
    const sideStep=airborne?sign*.055:lateral*step*.31;
    const lift=airborne?(rising?.27:.12)+sign*.045:Math.max(0,transfer*sign)*pace*.17;
    const planted=a.feet && !airborne && !a.isPlayer;
    const base=sign<0?0:4;
    const hip=[sign*.175+sway*.24,.753+rise*(planted?.61:.43),lean*.25];
    const foot=[sign*.185+sideStep,.112+lift,.10+forwardStep];
    const ankle=[foot[0],foot[1]+.112,foot[2]-.065];
    const knee=[mix(hip[0],ankle[0],.53),mix(hip[1],ankle[1],.49),
      mix(hip[2],ankle[2],.45)+(rising?.19:.065)+crouch*.18];
    if (planted) {
      const bootYaw=Math.PI-a.feet[base+3],fx=Math.sin(bootYaw),fz=Math.cos(bootYaw);
      const x=a.feet[base],y=a.feet[base+1]+.060,z=a.feet[base+2];
      const ankle=[x-fx*.064,y+.111,z-fz*.064];
      const knee=limbJoint(loc(...hip),ankle,.383,.370,[fx,.09,fz]);
      r.beam(loc(...hip),knee,.25,.26,GRAPHITE,18,{dynamic:true,shape:limbShape});
      r.beam(knee,ankle,.21,.23,hit,18,{dynamic:true,shape:limbShape});
      const part=(type,x,y,z,w,h,d,color,mat)=>r.add(type,x,y,z,w,h,d,color,mat,{dynamic:true,yaw:bootYaw});
      part(soft,...knee,.242,.236,.260,GRAPHITE,21);
      part(soft,knee[0]+fx*.127,knee[1],knee[2]+fz*.127,.148,.121,.047,tint,20);
      part(soft,x,y,z,.299,.19,.475,BOOT,21);
      part('bevel',x,y-.063,z,.304,.063,.473,0x202e37,21);
      part(soft,x+fx*.166,y+.007,z+fz*.166,.274,.105,.139,tint,20);
      part('box',x+fx*.13,y+.075,z+fz*.13,.151,.042,.094,accent,20);
      if (hi) {
        part('box',x,y-.038,z,.31,.018,.478,0xb9bdb3,21);
        part(soft,x-fx*.16,y+.05,z-fz*.16,.24,.13,.12,0x1c272b,21);
      }
    } else {
      r.beam(loc(...hip),loc(...knee),.25,.26,GRAPHITE,18,{dynamic:true,shape:limbShape});
      r.beam(loc(...knee),loc(...ankle),.21,.23,hit,18,{dynamic:true,shape:limbShape});
      part(soft,...knee,.242,.236,.260,GRAPHITE,21);
      part(soft,knee[0],knee[1],knee[2]+.127,.148,.121,.047,tint,20);
      const bootPitch=airborne?(rising?-.32:.16):transfer*sign*pace*.14;
      part(soft,...foot,.299,.19,.475,BOOT,21,bootPitch);
      part('bevel',foot[0],foot[1]-.062,foot[2],.304,.063,.473,0x202e37,21,bootPitch);
      part(soft,foot[0],foot[1]+.005,foot[2]+.166,.274,.105,.139,tint,20,bootPitch);
      part('box',foot[0],foot[1]+.075,foot[2]+.13,.151,.042,.094,accent,20,bootPitch);
      if (hi) {
        part('box',foot[0],foot[1]-.037,foot[2],.31,.018,.478,0xb9bdb3,21,bootPitch);
        part(soft,foot[0],foot[1]+.05,foot[2]-.16,.24,.13,.12,0x1c272b,21,bootPitch);
      }
    }
    const armSwing=sign>0?-step*.14:0;
    const armLift=airborne?.07:armSwing*.28-crouch*.035;
    part(soft,sign*.331,1.241,.023,.294,.267,.322,tint,20);
    part(soft,sign*.400,1.237,.032,.158,.193,.252,armor,21);
    part('box',sign*.385,1.263,.158,.12,.041,.025,accent,4);
    const hand=weapon.roller?loc(sign*.25,1.13,.40):gun.at(...(sign<0?[-.416,1.22,.44]:[-.285,1.18,.66]));
    const shoulder=torso(sign*.331,1.241,.023);
    const elbow=planted || a.brace>0?limbJoint(shoulder,hand,.371,.415,[sign*cy,-.58,-sign*sy]):
      loc(sign*.386,1.06+armLift,.22+armSwing);
    r.beam(shoulder,elbow,.19,.21,tint,18,{dynamic:true,shape:limbShape});
    r.beam(elbow,hand,.165,.18,hit,18,{dynamic:true,shape:limbShape});
    r.add('orb',...elbow,.192,.185,.194,tint,18,{dynamic:true,yaw});
    if (hi) {
      const wrist=add(hand,scale(unit(sub(elbow,hand)),.07));
      r.add('cylinder',...wrist,.15,.05,.15,0x1c272b,21,{dynamic:true,basis:limbBasis(sub(hand,elbow))});
      r.add('soft',...hand,.19,.16,.21,BOOT,21,{dynamic:true,yaw});
      r.add('soft',...add(hand,[sign*cy*.07,.025,-sign*sy*.07]),.07,.06,.11,BOOT,21,{dynamic:true,yaw});
    } else r.add('orb',...hand,.20,.19,.22,BOOT,21,{dynamic:true,yaw});
  }
  if (weapon.roller) {
    const {y:headY,z:headZ}=rollerPosition(a);
    const axis=[cy,0,-sy], up=[0,1,0], axes=[up,axis,cross(up,axis)];
    const position=loc(0,headY,headZ);
    r.add('cylinder',...position,.62,1.76,.62,bright,9,{dynamic:true,basis:axes});
    const spin=a.rolling?a.steps*.83:0, facing=[sy,0,cy];
    for (let i=0;i<3;i++) {
      const angle=spin+i*TAU/3, radial=add(scale(up,Math.cos(angle)),scale(facing,Math.sin(angle)));
      const seam=add(position,scale(radial,.313));
      r.add('box',...seam,1.63,.013,.035,tint,9,{dynamic:true,basis:[axis,radial,cross(axis,radial)]});
    }
    for (const sign of [-1,1]) {
      r.add('cylinder',...loc(sign*.88,headY,headZ),.64,.086,.64,GRAPHITE,4,{dynamic:true,basis:axes});
      r.beam(loc(sign*.88,headY,headZ),loc(sign*.88,headY+.33,headZ-.16),.055,.055,TRIM,4,{dynamic:true});
    }
    r.beam(loc(-.88,headY+.33,headZ-.16),loc(.88,headY+.33,headZ-.16),.065,.065,TRIM,4,{dynamic:true});
    r.beam(loc(0,headY+.33,headZ-.16),loc(0,1.13,.40),.075,.075,GRAPHITE,4,{dynamic:true});
    part('box',0,1.13,.40,.57,.12,.14,BOOT,4);
    return;
  }
  const long=weapon.id==='charge', wide=weapon.id==='fan', heavy=weapon.id==='lob', dual=weapon.id==='dual';
  const quad=weapon.id==='rd2', cannon=weapon.id==='td';
  const barrel=gun.barrel;
  const width=cannon?.37:quad?.34:heavy?.33:wide?.30:.235;
  const gunPart=(type,x,y,z,w,h,d,color,mat=4,pitch=0)=>r.add(type,...gun.at(x,y,z),w,h,d,color,material(mat,color),
    {dynamic:true,yaw:aimYaw,pitch:pitch+gun.pitch});
  gunPart('bevel',-.415,1.30,.474,dual?.35:width,heavy || quad || cannon?.29:.222,.565,GRAPHITE);
  gunPart('box',-.415,1.341,.49,dual?.37:width+.02,.137,.408,tint);
  if (quad) {
    // RD II QUATRO+: four barrels in a square around a fifth, under a heavy shroud.
    for (const [bx,by] of [[-.085,.075],[.085,.075],[-.085,-.075],[.085,-.075],[0,0]]) {
      gunPart('cylinder',-.415+bx,1.30+by,.69+barrel*.30,.085,barrel,.085,TRIM,4,Math.PI/2);
      gunPart('cylinder',-.415+bx,1.30+by,.70+barrel*.82,.058,.03,.058,bright,9,Math.PI/2);
    }
    gunPart('bevel',-.415,1.30,.66+barrel*.55,.30,.27,.13,BOOT);
    gunPart('bevel',-.415,1.30,.60,.33,.30,.11,GRAPHITE);
    gunPart('box',-.415,1.47,.50,.07,.07,.36,tint);
    gunPart('orb',-.415,1.12,.52,.20,.17,.30,tint,9);
  } else if (cannon) {
    // TD: a short, wide shock cannon with a flared mouth.
    gunPart('cylinder',-.415,1.30,.69+barrel*.30,.30,barrel,.30,TRIM,4,Math.PI/2);
    gunPart('cone',-.415,1.30,.62+barrel*.95,.50,.26,.50,BOOT,4,-Math.PI/2);
    gunPart('cylinder',-.415,1.30,.70+barrel*.86,.33,.04,.33,bright,9,Math.PI/2);
    for (const side of [-1,1]) gunPart('box',-.415+side*.20,1.30,.56,.05,.20,.34,tint);
    gunPart('orb',-.415,1.49,.47,.22,.17,.28,tint,9);
  } else if (!dual) {
    gunPart('cylinder',-.415,1.30,.69+barrel*.30,heavy?.245:.138,barrel,heavy?.245:.138,TRIM,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.67+barrel*.85,heavy?.32:wide?.25:.211,.093,heavy?.32:wide?.25:.211,BOOT,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.721+barrel*.85,heavy?.245:.125,.035,heavy?.245:.125,bright,9,Math.PI/2);
  }
  if (wide) for (const side of [-1,1]) gunPart('cylinder',-.415+side*.14,1.296,.78,.088,.26,.088,TRIM,4,Math.PI/2);
  if (long) gunPart('box',-.415,1.448,.524,.105,.096,.28,BOOT);
  if (heavy) gunPart('orb',-.414,1.51,.44,.263,.24,.31,tint,9);
  gunPart('box',-.415,1.205,.359,.125,.207,.17,BOOT,4,-.20);
  for (const sign of [-1,1]) {
    const edge=(dual?.35:width)*.5;
    gunPart('box',-.415+sign*(edge+.011),1.345,.437,.022,.045,.237,TRIM);
    gunPart('orb',-.415+sign*(edge+.025),1.275,.48,.027,.027,.028,0xcbbf9e);
  }
  if (hi) {
    gunPart('box',-.415,1.418,.47,.05,.03,.30,0x1c272b,4);
    gunPart('box',-.415,1.418,.36,.075,.06,.07,0x111a1e,8);
    gunPart('box',-.415+(dual?.36:width)*.5+.004,1.30,.50,.004,.05,.20,bright,3);
  }
  if (long) {
    gunPart('cylinder',-.415,1.49,.52,.109,.32,.109,GRAPHITE,4,Math.PI/2);
    gunPart('cylinder',-.415,1.49,.688,.081,.025,.081,0xacc7bd,8,Math.PI/2);
    for (let i=0;i<4;i++) gunPart('box',-.415,1.38,.74+i*.078,.13,.025,.022,BOOT);
  }
  if (dual) for (const sign of [-1,1]) {
    gunPart('cylinder',-.415+sign*.13,1.30,.80,.095,.34,.095,TRIM,4,Math.PI/2);
    gunPart('cylinder',-.415+sign*.13,1.30,.99,.14,.047,.14,GRAPHITE,4,Math.PI/2);
    gunPart('cylinder',-.415+sign*.13,1.30,1.015,.080,.019,.080,bright,9,Math.PI/2);
  }
  if (weapon.id==='coil') for (let i=0;i<5;i++)
    gunPart('cylinder',-.415,1.30,.60+i*.073,.26-i*.018,.032,.26-i*.018,TRIM,4,Math.PI/2);
  if (weapon.id==='surge') for (const sign of [-1,0,1])
    gunPart('cylinder',-.415+sign*.10,1.45,.41,.08,.26,.08,bright,9);
  if (weapon.id==='prism') {
    gunPart('bevel',-.415,1.39,.48,.20,.17,.33,0xbad7ca,8);
    for (const sign of [-1,1]) gunPart('box',-.415+sign*.124,1.36,.52,.045,.19,.38,TRIM);
  }
  if (showEffects && (a.recoil>.65 && !a.muzzleBlocked || a.charge>.12)) {
    const flash=a.charge>.12?.071+.095*a.charge:cannon?.46:quad?.27:.14;
    for (const side of dual?[-1,1]:[0]) gunPart('orb',-.415+side*.13,1.30,dual?1.063:.785+barrel*.85,flash,flash,flash*1.7,bright,3);
  }
}

function limbBasis(axis) {
  const y=unit(axis), ref=Math.abs(y[2])>.93?[1,0,0]:[0,0,1];
  const x=unit(cross(y,ref));
  return [x,y,cross(x,y)];
}
