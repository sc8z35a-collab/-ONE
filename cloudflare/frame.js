import {zoneOf} from '../dist/layout.js';
import {AVATAR_FIELDS} from '../dist/cloud-view.js';

const q=n=>Math.round(n*100)/100;
const v=p=>p.map(q);
const railKeys=['x','stop','direction','phase','wait','speed','doorOpen','wetness','lateral','sideSpeed','yaw','roll','lift',
  'risk','spray','inkColor','viewDirection','routePitch','destination'];
const exactAvatar=new Set(['tank','charge','superCharge','hp','down','shield','superUntil','droneReady','subReady','doorReady']);
const actorView=a=>{
  const special={isPlayer:!!a.isPlayer,weapon:a.weapon?.id,drone:!!a.drone,ride:!!a.ride,lift:a.lift?{left:q(a.lift.left)}:null,
    slam:!!a.slam,beaming:!!a.beaming,bodyYaw:q(a.bodyYaw??a.yaw),feet:a.feet?v(a.feet):null,
    brace:a.brace??0,peek:a.peek??0,readyPose:a.readyPose??0,flare:a.flare??0,poseBank:a.poseBank??0};
  return AVATAR_FIELDS.map(key=>{
    const value=Object.hasOwn(special,key)?special[key]:a[key];
    return typeof value==='number' && !exactAvatar.has(key)?q(value):value;
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
    type:'frame',mode:b.mode,teamSize:b.teamSize,timeless:b.timeless,
    clock:b.clock,elapsed:q(b.elapsed),left:b.timeless?null:b.left,countdown:b.countdown,finished:b.finished,watching:b.watching,
    actors:b.actors.map(actorView),transit:railView(b.transit,nearby(b.transit.line.center)),metro:railView(b.metro,nearby(b.metro.line.center)),
    boss:{active:boss.active,spawned:boss.spawned,phase:boss.phase,hp:q(boss.hp),maxHp:boss.maxHp,alert:boss.alert,
      alertUntil:q(boss.alertUntil),x:q(boss.x),y:q(boss.y),z:q(boss.z),vx:q(boss.vx),vz:q(boss.vz),yaw:q(boss.yaw),steps:q(boss.steps??0),poseBank:q(boss.poseBank??0),cast:nearby(boss.x)?boss.cast:null,
      attacks:nearby(boss.x)?boss.attacks.map(({hit,...attack})=>attack):[]},
    raiders:{next:q(raiders.next),wave:raiders.wave,alert:raiders.alert,alertUntil:q(raiders.alertUntil),members:raiders.live().map(actorView)},
    shots:b.shots.filter(s=>nearby(s.pos[0])).slice(-90).map(s=>[...v(s.pos),...v(s.vel),s.actor.team,s.weapon.id,s.weapon.size,s.id]),
    drops:b.drops.filter(d=>nearby(d.p[0])).slice(-66).map(d=>[...v(d.p),q(d.size),q(d.life/d.max),d.team]),
    inkImpacts:b.inkImpacts.filter(hit=>nearby(hit.p[0])).map(hit=>[...v(hit.p),hit.team,q(hit.at),hit.normal]),
    subItems:b.subweapons.items.filter(item=>nearby(item.p[0])).map(({owner,v:velocity,...item})=>
      ({...item,p:v(item.p),owner:{team:owner.team}})),
    wakes:[], // Keep older clients compatible with this snapshot format.
    decals:b.decals.filter(d=>nearby(d.p[0])).slice(-220).map(d=>[...v(d.p),...d.normal.map(n=>Math.round(n*10000)/10000),
      d.team,q(d.phase),q(d.radius),d.shape,d.id]),
    effects:a.advanced.effects.filter(e=>e.id==='wave'?e.lanes.some(l=>!l.stopped && nearby(l.x)):nearby(e.x)).map(e=>({
      id:e.id,x:q(e.x),y:e.y,z:q(e.z),age:q(e.age),actor:{team:e.actor.team},lanes:e.lanes,
      burst:e.burst,a:e.a?v(e.a):null,b:e.b?v(e.b):null
    })),
    drones:a.drones.filter(d=>nearby(d.x)).map(d=>({x:q(d.x),y:q(d.y),z:q(d.z),yaw:q(d.yaw),owner:{team:d.owner.team}})),
    stage:b.stage.snapshot(),
    rings:a.rings.filter(r=>nearby(r.x)).slice(-38),events:b.events,
    chip:{x:b.chip.x,y:b.chip.y,z:b.chip.z,yaw:b.chip.yaw,owner:!!b.chip.owner},
    zone,fullInk,count:b.paint.count,total:b.paint.total,zoneCount:b.paint.zoneCount,zoneTotal:b.paint.zoneTotal,sounds
  };
}
