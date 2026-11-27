import {zoneOf} from '../dist/layout.js';
import {AVATAR_FIELDS} from '../dist/cloud-view.js';

const q=n=>Math.round(n*100)/100;
const v=p=>[q(p[0]),q(p[1]),q(p[2])];
const dropView=d=>{
  const p=d.p, vv=d.v;
  return [q(p[0]),q(p[1]),q(p[2]),q(d.size),q(d.life/d.max),d.team,q(vv[0]),q(vv[1]),q(vv[2]),q(d.life)];
};
const railKeys=['x','stop','direction','phase','wait','speed','doorOpen','wetness','lateral','sideSpeed','yaw','roll','lift',
  'risk','spray','inkColor','viewDirection','routePitch','destination','berserk'];
// Meters never round up into a false "ready", and timers never round down
// into a false "finished": both are cut to a millisecond on the safe side.
const meters=new Set(['tank','charge','superCharge','hp','pShield']);
const timers=new Set(['down','shield','pShieldUntil','pShieldReady','superUntil','droneReady','subReady','doorReady','revealUntil']);
const cutFloor=value=>Number.isFinite(value)?Math.floor(value*1000)/1000:value;
const cutCeil=value=>Number.isFinite(value)?Math.ceil(value*1000)/1000:value;

// Precompiled opcode plan synced dynamically with AVATAR_FIELDS (zero per-actor temp objects or Set lookups).
const SPECIAL_OP={
  isPlayer:3,isCheater:4,inCar:5,weapon:6,drone:7,ride:8,lift:9,slam:10,
  beaming:11,bodyYaw:12,feet:13,clone:14,brace:15,peek:16,readyPose:17,flare:18,poseBank:19
};
const AVATAR_LEN=AVATAR_FIELDS.length;
const AVATAR_OPS=new Uint8Array(AVATAR_LEN);
for (let i=0;i<AVATAR_LEN;i++) {
  const key=AVATAR_FIELDS[i];
  AVATAR_OPS[i]=SPECIAL_OP[key] ?? (meters.has(key)?1:timers.has(key)?2:0);
}

const actorView=(a,close=true)=>{
  const row=new Array(AVATAR_LEN);
  for (let i=0;i<AVATAR_LEN;i++) {
    const op=AVATAR_OPS[i];
    if (op===0) {
      const val=a[AVATAR_FIELDS[i]];
      row[i]=typeof val==='number'?q(val):val;
    } else if (op===1) {
      const val=a[AVATAR_FIELDS[i]];
      row[i]=typeof val==='number'?cutFloor(val):val;
    } else if (op===2) {
      const val=a[AVATAR_FIELDS[i]];
      row[i]=typeof val==='number'?cutCeil(val):val;
    } else {
      switch (op) {
        case 3: row[i]=!!a.isPlayer; break;
        case 4: row[i]=!!a.isCheater; break;
        case 5: row[i]=!!a.car; break;
        case 6: row[i]=a.weapon?.id; break;
        case 7: row[i]=!!a.drone; break;
        case 8: row[i]=!!a.ride; break;
        case 9: row[i]=a.lift?{left:q(a.lift.left)}:null; break;
        case 10: row[i]=!!a.slam; break;
        case 11: row[i]=!!a.beaming; break;
        case 12: row[i]=q(a.bodyYaw??a.yaw); break;
        case 13: row[i]=close && a.feet?v(a.feet):null; break;
        case 14: row[i]=!!a.cloneOf; break;
        case 15: row[i]=q(a.brace??0); break;
        case 16: row[i]=q(a.peek??0); break;
        case 17: row[i]=q(a.readyPose??0); break;
        case 18: row[i]=q(a.flare??0); break;
        case 19: row[i]=q(a.poseBank??0); break;
      }
    }
  }
  return row;
};

function railView(rail,marks) {
  const t=rail.train, row={};
  for (let i=0;i<railKeys.length;i++) {
    const k=railKeys[i], val=t[k];
    row[k]=typeof val==='number' && k!=='doorOpen' && k!=='wait'?q(val):val;
  }
  row.marks=marks?t.marks.slice(-26):[];
  row.windows=t.windows??{};
  return {train:row,time:rail.time,integrity:q(rail.integrity),alert:rail.alert,alertUntil:q(rail.alertUntil),
    section:rail.section,connection:rail.connection};
}

export function frameOf(b,zone,fullInk,sounds,mergeStairs=false) {
  const nearby=x=>{
    const level=zoneOf(x);
    return level===zone || (mergeStairs && level<2);
  };
  const a=b.abilities, boss=b.boss, raiders=b.raiders;
  const actors=new Array(b.actors.length);
  for (let i=0;i<b.actors.length;i++) {
    const act=b.actors[i];
    actors[i]=actorView(act,nearby(act.x));
  }
  const bossNear=nearby(boss.x);
  let bossAttacks=[];
  if (bossNear && boss.attacks.length) {
    bossAttacks=new Array(boss.attacks.length);
    for (let i=0;i<boss.attacks.length;i++) {
      const {hit,...attack}=boss.attacks[i];
      bossAttacks[i]=attack;
    }
  }
  const liveRaiders=raiders.live();
  const raiderMembers=new Array(liveRaiders.length);
  for (let i=0;i<liveRaiders.length;i++) {
    const act=liveRaiders[i];
    raiderMembers[i]=actorView(act,nearby(act.x));
  }
  // Single-pass reverse-capped collection for shots/drops/decals/rings.
  const shots=[];
  for (let i=b.shots.length-1;i>=0 && shots.length<90;i--) {
    const s=b.shots[i];
    if (nearby(s.pos[0])) {
      const p=s.pos, vv=s.vel;
      shots.push([q(p[0]),q(p[1]),q(p[2]),q(vv[0]),q(vv[1]),q(vv[2]),s.actor.team,s.weapon.id,s.weapon.size,s.id]);
    }
  }
  if (shots.length>1) shots.reverse();
  const drops=[];
  for (let i=b.drops.length-1;i>=0 && drops.length<66;i--) {
    const d=b.drops[i];
    if (nearby(d.p[0])) drops.push(dropView(d));
  }
  if (drops.length>1) drops.reverse();
  const inkImpacts=[];
  for (let i=0;i<b.inkImpacts.length;i++) {
    const hit=b.inkImpacts[i];
    if (nearby(hit.p[0])) {
      const p=hit.p;
      inkImpacts.push([q(p[0]),q(p[1]),q(p[2]),hit.team,q(hit.at),hit.normal,hit.kind??0]);
    }
  }
  const subItems=[];
  const srcSub=b.subweapons.items;
  for (let i=0;i<srcSub.length;i++) {
    const raw=srcSub[i];
    if (!nearby(raw.p[0])) continue;
    const {owner,v:velocity,...item}=raw;
    subItems.push({...item,p:v(raw.p),owner:{team:owner.team}});
  }
  const decals=[];
  for (let i=b.decals.length-1;i>=0 && decals.length<220;i--) {
    const d=b.decals[i];
    if (!nearby(d.p[0])) continue;
    const p=d.p, n=d.normal;
    decals.push([q(p[0]),q(p[1]),q(p[2]),Math.round(n[0]*10000)/10000,Math.round(n[1]*10000)/10000,Math.round(n[2]*10000)/10000,
      d.team,q(d.phase),q(d.radius),d.shape,d.id]);
  }
  if (decals.length>1) decals.reverse();
  const effects=[];
  const srcEff=a.advanced.effects;
  for (let i=0;i<srcEff.length;i++) {
    const e=srcEff[i];
    let ok=false;
    if (e.id==='wave') {
      for (let j=0;j<e.lanes.length;j++) if (!e.lanes[j].stopped && nearby(e.lanes[j].x)) {ok=true; break;}
    } else ok=nearby(e.x);
    if (!ok) continue;
    effects.push({
      id:e.id,x:q(e.x),y:e.y,z:q(e.z),age:q(e.age),actor:{team:e.actor.team},lanes:e.lanes,
      burst:e.burst,a:e.a?v(e.a):null,b:e.b?v(e.b):null
    });
  }
  const drones=[];
  for (let i=0;i<a.drones.length;i++) {
    const d=a.drones[i];
    if (!nearby(d.x)) continue;
    drones.push({x:q(d.x),y:q(d.y),z:q(d.z),yaw:q(d.yaw),owner:{team:d.owner.team},flash:q(d.flash??-9),aim:q(d.aim??d.yaw)});
  }
  const rings=[];
  for (let i=a.rings.length-1;i>=0 && rings.length<38;i--) {
    const r=a.rings[i];
    if (nearby(r.x)) rings.push(r);
  }
  if (rings.length>1) rings.reverse();
  return {
    type:'frame',mode:b.mode,teamSize:b.teamSize,timeless:b.timeless,unlimited:!!b.unlimited,
    clock:b.clock,elapsed:q(b.elapsed),left:b.unlimited?null:b.left,countdown:b.countdown,finished:b.finished,watching:b.watching,
    actors,transit:railView(b.transit,nearby(b.transit.line.center)),metro:railView(b.metro,nearby(b.metro.line.center)),
    boss:{active:boss.active,spawned:boss.spawned,phase:boss.phase,hp:q(boss.hp),maxHp:boss.maxHp,alert:boss.alert,
      alertUntil:q(boss.alertUntil),x:q(boss.x),y:q(boss.y),z:q(boss.z),vx:q(boss.vx),vz:q(boss.vz),yaw:q(boss.yaw),steps:q(boss.steps??0),poseBank:q(boss.poseBank??0),cast:bossNear?boss.cast:null,
      attacks:bossAttacks},
    raiders:{next:q(raiders.next),wave:raiders.wave,alert:raiders.alert,alertUntil:q(raiders.alertUntil),members:raiderMembers},
    hazards:b.hazards?b.hazards.snapshot(zone,mergeStairs):null,
    vehicles:b.vehicles?b.vehicles.snapshot(zone,mergeStairs):[],
    shots,drops,inkImpacts,subItems,
    wakes:[], // Keep older clients compatible with this snapshot format.
    decals,effects,drones,
    stage:b.stage.snapshot(),
    dynStage:b.dynamicStage?b.dynamicStage.snapshot():null,
    underBossDepth:q(b.fluid?.underBossDepth ?? 0),
    rings,events:b.events,
    chip:{x:b.chip.x,y:b.chip.y,z:b.chip.z,yaw:b.chip.yaw,owner:!!b.chip.owner},
    zone,fullInk,count:b.paint.count,bossCount:b.paint.bossCount??0,total:b.paint.total,
    zoneCount:b.paint.zoneCount,zoneBossCount:b.paint.zoneBossCount??[0,0,0,0],zoneTotal:b.paint.zoneTotal,sounds,
    merged:mergeStairs
  };
}

// Zero-allocation structural equality matching JSON.stringify equivalence for wire payloads.
function same(a,b) {
  if (a===b) return true;
  if (!a || !b || typeof a!=='object' || typeof b!=='object') return false;
  const arrA=Array.isArray(a);
  if (arrA!==Array.isArray(b)) return false;
  if (arrA) {
    const n=a.length;
    if (n!==b.length) return false;
    for (let i=0;i<n;i++) if (!same(a[i],b[i])) return false;
    return true;
  }
  let countA=0;
  for (const k in a) {
    if (!Object.hasOwn(a,k)) continue;
    const va=a[k];
    if (va===undefined) continue;
    countA++;
    if (!Object.hasOwn(b,k) || !same(va,b[k])) return false;
  }
  let countB=0;
  for (const k in b) {
    if (Object.hasOwn(b,k) && b[k]!==undefined) countB++;
  }
  return countA===countB;
}

function changed(previous,next) {
  const out={};
  for (const key in next) {
    if (Object.hasOwn(next,key) && !same(previous?.[key],next[key])) out[key]=next[key];
  }
  return out;
}
const RARE=['mode','teamSize','timeless','unlimited','stage','dynStage','vehicles','hazards','bossCount','zoneBossCount','underBossDepth','events','chip','total','zoneTotal','wakes'];

// The wire form of a snapshot. A link that already holds a snapshot receives
// only what changed since: sparse crew rows, the changed train and boss
// fields, and newly created droplets and wall marks. `link` is the per-socket
// memory; a forced frame rebuilds it.
export function packFrame(b,frame,link,full=false) {
  const scope=frame.zone+':'+frame.merged;
  const fresh=full || !link.rows || link.rows.length!==frame.actors.length || link.scope!==scope;
  const out={...frame};
  if (fresh) out.full=true;
  else {
    const actorDiffs=new Array(frame.actors.length);
    for (let i=0;i<frame.actors.length;i++) {
      const row=frame.actors[i], previous=link.rows[i], diff=[];
      for (let k=0;k<row.length;k++) if (!same(previous[k],row[k])) diff.push(k,row[k]);
      actorDiffs[i]=diff;
    }
    out.actorDiffs=actorDiffs;
    delete out.actors;
    for (const key of ['transit','metro']) {
      const {train,...meta}=frame[key], before=link[key];
      out[key]={...changed(before,meta),train:changed(before.train,train)};
    }
    out.boss=changed(link.boss,frame.boss);
    for (let i=0;i<RARE.length;i++) {
      const key=RARE[i];
      if (same(link.rare[key],frame[key])) delete out[key];
    }
    const fz=frame.zone, fm=frame.merged;
    const newDrops=[];
    for (let i=b.drops.length-1;i>=0 && newDrops.length<48;i--) {
      const d=b.drops[i];
      if (link.drops.has(d)) continue;
      const lvl=zoneOf(d.p[0]);
      if (lvl===fz || (fm && lvl<2)) newDrops.push(dropView(d));
    }
    if (newDrops.length>1) newDrops.reverse();
    out.drops=newDrops;
    const newDecals=[], dec=frame.decals, lim=link.decal;
    for (let i=0;i<dec.length;i++) if (dec[i][10]>lim) newDecals.push(dec[i]);
    out.decals=newDecals;
    out.decalMin=b.decals[0]?.id??b.decalSequence+1;
  }
  link.rows=frame.actors;
  link.scope=scope;
  for (const key of ['transit','metro']) {
    const {train,...meta}=frame[key];
    link[key]={...meta,train};
  }
  link.boss=frame.boss;
  const rare={};
  for (let i=0;i<RARE.length;i++) {const key=RARE[i]; rare[key]=frame[key];}
  link.rare=rare;
  link.drops=new WeakSet(b.drops);
  link.decal=b.decalSequence;
  delete out.merged;
  return out;
}
