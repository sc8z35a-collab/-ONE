import {INK_HIT_DURATION} from '../dist/battle.js';
import {BASE_TANK,CABIN_X,INK_REGIONS,PAINT_LAYERS,RAIL_CABIN_X,UNDER_X,inkOrigin,inkRegion} from '../dist/layout.js';
import {STAIRS} from '../dist/stairs.js';
import {RAIDER_WEAPON} from '../dist/raiders.js';
import {add,dot,scale} from '../dist/render.js';
import {shotWeaponById,weaponById} from '../dist/weapons.js';
import {randomGenerator} from '../dist/world.js';

const STORAGE_VERSION=7;
const filmKeys=Array.from({length:PAINT_LAYERS},(_,i)=>'ink'+i);
const flowKeys=Array.from({length:INK_REGIONS},(_,i)=>'flow'+i);
export const STORAGE_KEYS=['game',...filmKeys,...flowKeys];
const SKIP=new Set(['goal','target','enemy','travelLine','travelGoal','travelPath','route','drone','weapon','battle','cloneOf']);
function fields(value) {
  return Object.fromEntries(Object.entries(value).filter(([key,v])=>!SKIP.has(key) && (v===null || (typeof v!=='object' && typeof v!=='function'))));
}
const clone=value=>structuredClone(value);
const actor=a=>({...fields(a),lift:clone(a.lift),ride:clone(a.ride),slam:clone(a.slam),attack:clone(a.attack),
  climbNormal:clone(a.climbNormal),lastSeen:clone(a.lastSeen),feet:clone(a.feet),gait:clone(a.gait)});
const transit=t=>({train:clone(t.train),time:t.time,integrity:t.integrity,alert:t.alert,alertUntil:t.alertUntil,boardedAt:t.boardedAt,
  section:t.section,connection:clone(t.connection)});
const point=p=>p?{x:p.x,y:p.y,z:p.z,level:p.level,side:p.side}:null;

function savedTactics(state) {
  if (!state) return null;
  const {plan,cover,dodge}=state;
  return {...fields(state),previous:point(state.previous),refill:point(state.refill),pos:point(state.pos),
    cover:clone(cover),dodge:clone(dodge),plan:plan?{
      goal:point(plan.goal),cost:plan.cost,steps:plan.steps.map(({kind,level,from,rail,boarded,stair,to})=>
        ({kind,level,from,rail,boarded,stair:stair?.id,to:point(to)}))
    }:null};
}

const FILM_SCALE=65535/.105;

function reference(b,a) {
  if (a===b.boss) return ['boss'];
  const crew=b.actors.indexOf(a);
  if (crew>=0) return ['crew',crew];
  const raider=b.raiders.members.indexOf(a);
  return raider>=0?['raid',raider]:null;
}

function fighter(b,ref) {
  if (!ref) return null;
  const [kind,index]=ref;
  return kind==='crew'?b.actors[index]:kind==='raid'?b.raiders.members[index]:kind==='boss'?b.boss:null;
}

function saveHits(b,hits) {
  return Array.from(hits,([target,n])=>[reference(b,target),n]).filter(([ref])=>ref);
}

function restoreHits(b,hits=[]) {
  return new Map(hits.map(([ref,n])=>[fighter(b,ref),n]).filter(([target])=>target));
}

function encodeFilm(p,layer) {
  const start=layer*p.layerSize,end=start+p.layerSize;
  let n=0;
  const bossArr=p.boss;
  for (let i=start;i<end;i++) if (p.cyan[i] || p.amber[i] || (bossArr && bossArr[i])) n++;
  const buffer=new ArrayBuffer(n*16), out=new DataView(buffer);
  let at=0;
  for (let i=start;i<end;i++) {
    const a=p.cyan[i], b=p.amber[i], c=bossArr?bossArr[i]:0;
    if (!a && !b && !c) continue;
    out.setUint32(at,i-start,true);
    out.setFloat32(at+4,a,true);
    out.setFloat32(at+8,b,true);
    out.setFloat32(at+12,c,true);
    at+=16;
  }
  return buffer;
}

function decodeFilm(p,layer,buffer,field,version) {
  if (!(buffer instanceof ArrayBuffer)) return;
  const data=new DataView(buffer), legacy=version<4, hasBoss=version>=7, stride=legacy?8:hasBoss?16:12;
  const area=(field.boundX*field.boundZ/(field.width*field.height))/(p.boundX*p.boundZ/(p.w*p.h));
  for (let at=0;at+stride<=data.byteLength;at+=stride) {
    const cell=data.getUint32(at,true);
    if (cell>=field.width*field.height) continue;
    const x=(((cell%field.width)+.5)/field.width*2-1)*field.boundX+inkOrigin(layer);
    const z=((Math.floor(cell/field.width)+.5)/field.height*2-1)*field.boundZ;
    const index=p.surfaceIndex(x,z,layer);
    if (index<0 || !p.mask[index]) continue;
    p.cyan[index]+=(legacy?data.getUint16(at+4,true)/FILM_SCALE:data.getFloat32(at+4,true))*area;
    p.amber[index]+=(legacy?data.getUint16(at+6,true)/FILM_SCALE:data.getFloat32(at+8,true))*area;
    if (hasBoss && p.boss) p.boss[index]+=data.getFloat32(at+12,true)*area;
    p.publish(index);
    p.wake(inkRegion(Math.floor(index/p.layerSize))*p.layerSize+index%p.layerSize);
  }
}

function encodeCurrent(p,region) {
  const first=region*p.layerSize, last=first+p.layerSize;
  let count=0;
  for (let i=first;i<last;i++) if (p.flowX[i] || p.flowZ[i]) count++;
  const out=new DataView(new ArrayBuffer(count*12));
  let at=0;
  for (let i=first;i<last;i++) {
    if (!p.flowX[i] && !p.flowZ[i]) continue;
    out.setUint32(at,i-first,true);
    out.setFloat32(at+4,p.flowX[i],true);
    out.setFloat32(at+8,p.flowZ[i],true);
    at+=12;
  }
  return out.buffer;
}

function decodeCurrent(p,region,buffer) {
  if (!(buffer instanceof ArrayBuffer)) return;
  const data=new DataView(buffer);
  for (let at=0;at+12<=data.byteLength;at+=12) {
    const cell=data.getUint32(at,true), index=region*p.layerSize+cell;
    if (cell>=p.layerSize || p.surface[index]<0) continue;
    p.flowX[index]=data.getFloat32(at+4,true);
    p.flowZ[index]=data.getFloat32(at+8,true);
    p.wake(index);
  }
}

export function checkpointOf(b) {
  const owner=b.chip.owner;
  const chipOwner=owner?owner.isRaider?['raid',owner.index]:['crew',b.actors.indexOf(owner)]:null;
  const game={
    version:STORAGE_VERSION,field:{width:b.paint.w,height:b.paint.h,boundX:b.paint.boundX,boundZ:b.paint.boundZ},
    clock:b.clock,elapsed:b.elapsed,left:b.left,countdown:b.countdown,watching:b.watching,finished:b.finished,unlimited:!!b.unlimited,shotSequence:b.shotSequence,
    actors:b.actors.map(a=>({...actor(a),weaponId:a.weapon.id,...(a.cloneOf && {casterIndex:b.actors.indexOf(a.cloneOf)})})),
    tactics:{
      crew:b.actors.map(a=>savedTactics(b.tactics.states.get(a))),
      raiders:b.raiders.members.map(a=>savedTactics(b.tactics.states.get(a))),
      contacts:b.tactics.contacts.map(team=>Array.from(team,([target,position])=>[reference(b,target),position]).filter(([ref])=>ref))
    },
    transit:transit(b.transit),metro:transit(b.metro),
    boss:{...fields(b.boss),cast:clone(b.boss.cast),attacks:clone(b.boss.attacks)},bossTarget:reference(b,b.boss.target),
    raiders:{...fields(b.raiders),members:b.raiders.members.map(actor)},
    hazards:b.hazards?b.hazards.checkpoint():null,
    vehicles:b.vehicles?b.vehicles.checkpoint():null,
    decals:clone(b.decals),drops:clone(b.drops),events:clone(b.events),
    inkImpacts:b.inkImpacts.map(({target,...impact})=>({...clone(impact),target:reference(b,target)})),
    inkTime:b.paint.time,battleSeed:b.rng.state(),raidSeed:b.raiders.rng.state(),
    subItems:b.subweapons.items.map(({owner,...item})=>({...clone(item),owner:b.actors.indexOf(owner)})),
    drones:b.abilities.drones.map(({owner,...drone})=>({...drone,owner:b.actors.indexOf(owner)})),
    shots:b.shots.map(({actor,weapon,...shot})=>{
      const source=reference(b,actor);
      const departed=source?null:{team:actor.team,name:actor.name,kills:actor.kills,painted:actor.painted,superCharge:actor.superCharge};
      return {...clone(shot),source,departed,weapon:weapon.id};
    }),
    stage:b.stage.snapshot(),
    dynamicStage:b.dynamicStage?.snapshot?.() ?? null,
    underBossDepth:b.fluid?.underBossDepth ?? 0,
    effects:b.abilities.advanced.effects.map(({actor,hit,damage,...motion})=>({
      ...clone(motion),owner:b.actors.indexOf(actor),
      hit:hit?Array.from(hit,target=>reference(b,target)).filter(Boolean):undefined,
      damage:damage?saveHits(b,damage):undefined
    })),
    chip:{x:b.chip.x,y:b.chip.y,z:b.chip.z,yaw:b.chip.yaw},chipOwner
  };
  const values={game};
  for (const [layer,key] of filmKeys.entries()) values[key]=encodeFilm(b.paint,layer);
  for (const [region,key] of flowKeys.entries()) values[key]=encodeCurrent(b.paint,region);
  return values;
}

function migratePositions(data) {
  // Before version 5 the three interior coordinate origins were 160 m apart.
  const migrate=x=>x>400?x+RAIL_CABIN_X-480:x>240?x+CABIN_X-320:x>80?x+UNDER_X-160:x;
  const coordinate=point=>{if (point) point[0]=migrate(point[0]);};
  const position=entity=>{if (Number.isFinite(entity?.x)) entity.x=migrate(entity.x);};
  for (const a of [...data.actors,...(data.raiders?.members??[])]) {
    position(a);
    position(a.lastSeen);
    position(a.lift);
  }
  position(data.chip);
  for (const item of [...data.decals??[],...data.drops??[],...data.inkImpacts??[],...data.subItems??[]]) coordinate(item.p);
  for (const shot of data.shots??[]) coordinate(shot.pos);
  for (const drone of data.drones??[]) position(drone);
  for (const effect of data.effects??[]) {
    position(effect);
    coordinate(effect.a);
    coordinate(effect.b);
    for (const lane of effect.lanes??[]) position(lane);
  }
  return data;
}

export function restoreCheckpoint(b,stored) {
  const saved=stored.get('game');
  if (!saved || ![1,2,3,4,5,6,STORAGE_VERSION].includes(saved.version) ||
      saved.actors.filter(a=>a.casterIndex===undefined).length!==b.actors.length) return;
  const data=saved.version<5?migratePositions(clone(saved)):saved;
  for (const key of ['clock','elapsed','left','countdown','watching','finished']) b[key]=data[key];
  if (data.unlimited!==undefined) b.unlimited=!!data.unlimited;
  b.shotSequence=data.shotSequence??0;
  // ebot copies follow the regular crew in the saved order, so every stored
  // crew index still points at the same fighter after the restore.
  for (const row of data.actors) {
    if (row.casterIndex!==undefined && b.actors[row.casterIndex]) b.addClone(b.actors[row.casterIndex]);
  }
  for (let i=0;i<b.actors.length;i++) {
    const a=b.actors[i];
    const {weaponId,casterIndex,...saved}=data.actors[i];
    Object.assign(a,{isCheater:false,baseHp:100,agility:1,jumpFactor:1,regenFactor:1},saved,
      {drone:null,beaming:false,route:[],travelLine:null,travelGoal:null,enemy:null,goal:null});
    if (weaponId) a.weapon=shotWeaponById(weaponId);
    a.rollHold=0;
    a.rollUsed=false;
    a.rolling=false;
  }
  Object.assign(b.transit,data.transit);
  Object.assign(b.metro,data.metro);
  for (const rail of [b.transit,b.metro]) {
    rail.setSection(rail.section??rail.homeLevel);
    if (data.version<3 && rail.section===1) rail.train.x*=rail.line.x/38.8;
    if (rail.homeLevel===0 && data.transit.section===undefined && rail.integrity===0) rail.integrity=720;
  }
  const bossMax=b.boss.maxHp;
  Object.assign(b.boss,data.boss,{target:null,route:[]});
  if (b.boss.maxHp>0 && b.boss.maxHp<bossMax) {
    b.boss.hp*=bossMax/b.boss.maxHp;
    b.boss.maxHp=bossMax;
  }
  Object.assign(b.raiders,data.raiders);
  if (b.hazards && data.hazards) b.hazards.restoreCheckpoint(data.hazards);
  if (b.vehicles && data.vehicles) b.vehicles.restoreCheckpoint(data.vehicles);
  if (Number.isInteger(data.battleSeed)) b.rng=randomGenerator(data.battleSeed);
  if (Number.isInteger(data.raidSeed)) b.raiders.rng=randomGenerator(data.raidSeed);
  for (const a of b.raiders.members) {
    a.weapon=RAIDER_WEAPON;
    a.route=[];
    a.coyote??=0;
    a.jumpBuffer??=0;
  }
  b.boss.target=fighter(b,data.bossTarget)??null;
  if (data.tactics) {
    for (const [units,states] of [[b.actors,data.tactics.crew],[b.raiders.members,data.tactics.raiders]]) {
      for (const [i,a] of units.entries()) {
        if (!states?.[i]) continue;
        const state=clone(states[i]);
        for (const step of state.plan?.steps??[]) if (step.stair) step.stair=STAIRS.find(stair=>stair.id===step.stair);
        b.tactics.states.set(a,state);
      }
    }
    b.tactics.contacts=data.tactics.contacts.map(entries=>new Map(entries.map(([ref,point])=>[fighter(b,ref),{...point}]).filter(([a])=>a)));
  }
  b.chip={...data.chip,owner:null};
  if (data.chipOwner) {
    const [kind,i]=data.chipOwner;
    b.chip.owner=(kind==='crew'?b.actors[i]:b.raiders.members.find(a=>a.index===i)) ?? true;
  }
  if (data.version===1) for (const a of [...b.actors,...b.raiders.members]) {
    const previous=a.tankMax || 100, next=(previous>100?BASE_TANK*2:BASE_TANK)*(a.weapon?.tankScale ?? 1);
    a.tank*=next/previous;
    a.tankMax=next;
  }
  b.stage.restore(data.stage);
  if (b.dynamicStage && data.dynamicStage) b.dynamicStage.restore(data.dynamicStage);
  if (b.fluid && data.underBossDepth!==undefined) b.fluid.underBossDepth=data.underBossDepth;
  const savedDecals=data.decals ?? [];
  b.decals=savedDecals.flatMap(mark=>{
    const start=add(mark.p,scale(mark.normal,.075));
    const end=add(mark.p,scale(mark.normal,-.13));
    const hit=b.world.traceExact(start,end);
    if (!hit?.shape || b.paint.hasSurface(hit.position[0],hit.position[2],hit.layer) || dot(hit.normal,mark.normal)<.75) return [];
    return [{...mark,p:add(hit.position,scale(hit.normal,.023)),normal:hit.normal,shape:hit.shape.id}];
  });
  b.drops=data.drops ?? [];
  b.events=(data.events??[]).filter(event=>event.until>b.clock);
  b.inkImpacts=(data.inkImpacts??[]).filter(hit=>b.clock-hit.at<INK_HIT_DURATION)
    .map(hit=>({...hit,target:fighter(b,hit.target)}));
  b.subweapons.items=(data.subItems??[]).filter(item=>b.actors[item.owner]).map(({owner,...item})=>({...item,owner:b.actors[owner]}));
  b.subweapons.sequence=Math.max(0,...b.subweapons.items.map(item=>item.serial));
  for (const {owner,...saved} of data.drones??[]) {
    const a=b.actors[owner];
    if (!a || a.drone || saved.until<=b.clock) continue;
    a.drone={...saved,owner:a};
    b.abilities.drones.push(a.drone);
  }
  for (const {source,departed,weapon,...shot} of data.shots??[]) {
    const actor=fighter(b,source) ?? departed;
    if (actor) b.shots.push({...shot,actor,weapon:weapon===RAIDER_WEAPON.id?RAIDER_WEAPON:shotWeaponById(weapon)});
  }
  for (const {owner,hit,damage,...motion} of data.effects??[]) {
    const actor=b.actors[owner];
    if (!actor) continue;
    const effect={...motion,actor};
    if (effect.id==='wave') effect.hit=new Set((hit??[]).map(ref=>fighter(b,ref)).filter(Boolean));
    if (effect.id==='beam') {
      if (!data.actors[owner].beaming || actor.down>0 || actor.ride || actor.lift) continue;
      actor.beaming=true;
      effect.damage=restoreHits(b,damage);
    }
    b.abilities.advanced.effects.push(effect);
  }
  b.decalSequence=savedDecals.reduce((n,d)=>Math.max(n,d.id??0),0);
  b.paint.reset();
  b.paint.time=data.inkTime??0;
  const field=data.field??{width:b.paint.w,height:b.paint.h,boundX:56,boundZ:38.2};
  for (const [layer,key] of filmKeys.entries()) decodeFilm(b.paint,layer,stored.get(key),field,data.version);
  if (field.width===b.paint.w && field.height===b.paint.h && field.boundX===b.paint.boundX && field.boundZ===b.paint.boundZ) {
    for (const [region,key] of flowKeys.entries()) decodeCurrent(b.paint,region,stored.get(key));
  }
}
