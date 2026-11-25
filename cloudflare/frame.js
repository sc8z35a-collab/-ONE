import {zoneOf} from '../dist/layout.js';
import {AVATAR_FIELDS} from '../dist/cloud-view.js';

const q=n=>Math.round(n*100)/100;
const v=p=>p.map(q);
const dropView=d=>[...v(d.p),q(d.size),q(d.life/d.max),d.team,...v(d.v),q(d.life)];
const railKeys=['x','stop','direction','phase','wait','speed','doorOpen','wetness','lateral','sideSpeed','yaw','roll','lift',
  'risk','spray','inkColor','viewDirection','routePitch','destination','berserk'];
// Meters never round up into a false "ready", and timers never round down
// into a false "finished": both are cut to a millisecond on the safe side.
const meters=new Set(['tank','charge','superCharge','hp']);
const timers=new Set(['down','shield','superUntil','droneReady','subReady','doorReady','revealUntil']);
const cut=(value,round)=>Number.isFinite(value)?round(value*1000)/1000:value;
const actorView=(a,close=true)=>{
  const special={isPlayer:!!a.isPlayer,isCheater:!!a.isCheater,inCar:!!a.car,weapon:a.weapon?.id,drone:!!a.drone,ride:!!a.ride,lift:a.lift?{left:q(a.lift.left)}:null,
    slam:!!a.slam,beaming:!!a.beaming,bodyYaw:q(a.bodyYaw??a.yaw),feet:close && a.feet?v(a.feet):null,clone:!!a.cloneOf,
    brace:a.brace??0,peek:a.peek??0,readyPose:a.readyPose??0,flare:a.flare??0,poseBank:a.poseBank??0};
  return AVATAR_FIELDS.map(key=>{
    const value=Object.hasOwn(special,key)?special[key]:a[key];
    if (typeof value!=='number') return value;
    return meters.has(key)?cut(value,Math.floor):timers.has(key)?cut(value,Math.ceil):q(value);
  });
};

function railView(rail,marks) {
  const t=rail.train, row={};
  for (const k of railKeys) row[k]=typeof t[k]==='number' && k!=='doorOpen' && k!=='wait'?q(t[k]):t[k];
  row.marks=marks?t.marks.slice(-26):[];
  row.windows=t.windows??{};
  return {train:row,time:rail.time,integrity:q(rail.integrity),alert:rail.alert,alertUntil:q(rail.alertUntil),
    section:rail.section,connection:rail.connection};
}

export function frameOf(b,zone,fullInk,sounds,mergeStairs=false) {
  const nearby=x=>{
    const level=zoneOf(x);
    return level===zone || mergeStairs && level<2;
  };
  const a=b.abilities, boss=b.boss, raiders=b.raiders;
  return {
    type:'frame',mode:b.mode,teamSize:b.teamSize,timeless:b.timeless,unlimited:!!b.unlimited,
    clock:b.clock,elapsed:q(b.elapsed),left:b.unlimited?null:b.left,countdown:b.countdown,finished:b.finished,watching:b.watching,
    actors:b.actors.map(actor=>actorView(actor,nearby(actor.x))),transit:railView(b.transit,nearby(b.transit.line.center)),metro:railView(b.metro,nearby(b.metro.line.center)),
    boss:{active:boss.active,spawned:boss.spawned,phase:boss.phase,hp:q(boss.hp),maxHp:boss.maxHp,alert:boss.alert,
      alertUntil:q(boss.alertUntil),x:q(boss.x),y:q(boss.y),z:q(boss.z),vx:q(boss.vx),vz:q(boss.vz),yaw:q(boss.yaw),steps:q(boss.steps??0),poseBank:q(boss.poseBank??0),cast:nearby(boss.x)?boss.cast:null,
      attacks:nearby(boss.x)?boss.attacks.map(({hit,...attack})=>attack):[]},
    raiders:{next:q(raiders.next),wave:raiders.wave,alert:raiders.alert,alertUntil:q(raiders.alertUntil),members:raiders.live().map(actor=>actorView(actor,nearby(actor.x)))},
    hazards:b.hazards?b.hazards.snapshot(zone,mergeStairs):null,
    vehicles:b.vehicles?b.vehicles.snapshot(zone,mergeStairs):[],
    shots:b.shots.filter(s=>nearby(s.pos[0])).slice(-90).map(s=>[...v(s.pos),...v(s.vel),s.actor.team,s.weapon.id,s.weapon.size,s.id]),
    drops:b.drops.filter(d=>nearby(d.p[0])).slice(-66).map(dropView),
    inkImpacts:b.inkImpacts.filter(hit=>nearby(hit.p[0])).map(hit=>[...v(hit.p),hit.team,q(hit.at),hit.normal,hit.kind??0]),
    subItems:b.subweapons.items.filter(item=>nearby(item.p[0])).map(({owner,v:velocity,...item})=>
      ({...item,p:v(item.p),owner:{team:owner.team}})),
    wakes:[], // Keep older clients compatible with this snapshot format.
    decals:b.decals.filter(d=>nearby(d.p[0])).slice(-220).map(d=>[...v(d.p),...d.normal.map(n=>Math.round(n*10000)/10000),
      d.team,q(d.phase),q(d.radius),d.shape,d.id]),
    effects:a.advanced.effects.filter(e=>e.id==='wave'?e.lanes.some(l=>!l.stopped && nearby(l.x)):nearby(e.x)).map(e=>({
      id:e.id,x:q(e.x),y:e.y,z:q(e.z),age:q(e.age),actor:{team:e.actor.team},lanes:e.lanes,
      burst:e.burst,a:e.a?v(e.a):null,b:e.b?v(e.b):null
    })),
    drones:a.drones.filter(d=>nearby(d.x)).map(d=>({x:q(d.x),y:q(d.y),z:q(d.z),yaw:q(d.yaw),owner:{team:d.owner.team},
      flash:q(d.flash??-9),aim:q(d.aim??d.yaw)})),
    stage:b.stage.snapshot(),
    dynStage:b.dynamicStage?b.dynamicStage.snapshot():null,
    underBossDepth:q(b.fluid?.underBossDepth ?? 0),
    rings:a.rings.filter(r=>nearby(r.x)).slice(-38),events:b.events,
    chip:{x:b.chip.x,y:b.chip.y,z:b.chip.z,yaw:b.chip.yaw,owner:!!b.chip.owner},
    zone,fullInk,count:b.paint.count,bossCount:b.paint.bossCount??0,total:b.paint.total,
    zoneCount:b.paint.zoneCount,zoneBossCount:b.paint.zoneBossCount??[0,0,0,0],zoneTotal:b.paint.zoneTotal,sounds,
    merged:mergeStairs
  };
}

const same=(a,b)=>a===b || typeof a==='object' && typeof b==='object' && !!a && !!b && JSON.stringify(a)===JSON.stringify(b);
function changed(previous,next) {
  const out={};
  for (const key of Object.keys(next)) if (!same(previous?.[key],next[key])) out[key]=next[key];
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
    out.actorDiffs=frame.actors.map((row,i)=>{
      const previous=link.rows[i], diff=[];
      for (let k=0;k<row.length;k++) if (!same(previous[k],row[k])) diff.push(k,row[k]);
      return diff;
    });
    delete out.actors;
    for (const key of ['transit','metro']) {
      const {train,...meta}=frame[key], before=link[key];
      out[key]={...changed(before,meta),train:changed(before.train,train)};
    }
    out.boss=changed(link.boss,frame.boss);
    for (const key of RARE) {
      if (same(link.rare[key],frame[key])) delete out[key];
    }
    const near=x=>{
      const level=zoneOf(x);
      return level===frame.zone || frame.merged && level<2;
    };
    out.drops=b.drops.filter(d=>!link.drops.has(d) && near(d.p[0])).slice(-48).map(dropView);
    out.decals=frame.decals.filter(mark=>mark[10]>link.decal);
    out.decalMin=b.decals[0]?.id??b.decalSequence+1;
  }
  link.rows=frame.actors;
  link.scope=scope;
  for (const key of ['transit','metro']) {
    const {train,...meta}=frame[key];
    link[key]={...meta,train};
  }
  link.boss=frame.boss;
  link.rare=Object.fromEntries(RARE.map(key=>[key,frame[key]]));
  link.drops=new WeakSet(b.drops);
  link.decal=b.decalSequence;
  delete out.merged;
  return out;
}
