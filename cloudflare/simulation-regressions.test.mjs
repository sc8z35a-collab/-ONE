import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {optionsFor} from './edge.js';
import {frameOf} from './frame.js';
import {RoomEngine} from './room-engine.js';
import {isCabin,sameLevel,STATIONS} from '../dist/layout.js';
import {STAIRS,STAIR_SEAM,stairPoint} from '../dist/stairs.js';
import {TouchControls} from '../dist/touch.js';
import {WEAPONS} from '../dist/weapons.js';

const options={mode:'play',teamSize:4,weapon:'prism'};
const dt=1/24;
const neutral={x:0,z:0,yaw:Math.PI/2,pitch:-.14};
const camera=()=>({eye:[10,1.2,-16],target:[15,1.2,-16]});
const restore=(engine,mode=engine.battle.mode)=>new RoomEngine({...options,mode},new Map(Object.entries(engine.checkpoint()))).battle;

const main=readFileSync(new URL('../dist/main.js',import.meta.url),'utf8');
const fragment=(first,next)=>main.slice(main.indexOf(first),main.indexOf(next,main.indexOf(first)+first.length));

function keyPage(kind) {
  const page={state:'match',dialogKind:kind,pauses:0,hideDialog(){},pause(){page.pauses++;}};
  const source=fragment("document.addEventListener('keydown',event=>{\n  if (event.code==='Escape')","document.addEventListener('keyup'");
  const handler=runInNewContext('('+source.slice("document.addEventListener('keydown',".length).trimEnd().slice(0,-2)+')',page);
  return {page,escape:repeat=>handler({code:'Escape',repeat})};
}

test('holding Escape only toggles pause once',()=>{
  const {page,escape}=keyPage(null);
  escape(false);
  escape(true);
  escape(true);
  assert.equal(page.pauses,1);
});

test('Escape cannot replace the disconnected-match dialog with an ordinary pause menu',()=>{
  const {page,escape}=keyPage('server');
  escape(false);
  assert.equal(page.pauses,0);
  page.dialogKind='pause';
  escape(false);
  assert.equal(page.pauses,1);
});

class TouchSurface extends EventTarget {
  constructor(width=84,height=84) {
    super();
    this.bounds={left:0,top:0,width,height};
    this.style={};
    this.firstElementChild={style:{}};
    this.classList={add(){},remove(){}};
  }
  getBoundingClientRect() {return this.bounds;}
  pointer(type,id,x=42,y=42) {
    this.dispatchEvent(Object.assign(new Event(type,{cancelable:true}),{pointerId:id,pointerType:'touch',
      button:0,clientX:x,clientY:y}));
  }
}
const touchFor=(arena,stick,buttons={})=>new TouchControls(arena,stick,buttons,{enabled:()=>true,aim(){},press(){},jump(){}});

test('a touch during a zero-size joystick layout cannot generate NaN movement',()=>{
  const arena=new TouchSurface(860,430), stick=new TouchSurface(0,0), controls=touchFor(arena,stick);
  stick.pointer('pointerdown',1,0,0);
  assert.deepEqual([controls.x,controls.z,controls.contacts.size],[0,0,0]);
  stick.bounds={left:0,top:0,width:84,height:84};
  stick.pointer('pointerdown',2);
  stick.pointer('pointermove',2,42,13);
  assert(controls.z>0);
});

test('a pointer capture released by the browser cannot strand a second held action during pause',()=>{
  const arena=new TouchSurface(860,430), stick=new TouchSurface(), fire=new TouchSurface(), swim=new TouchSurface();
  fire.hasPointerCapture=()=>true;
  fire.releasePointerCapture=()=>{throw new DOMException('pointer ended','NotFoundError');};
  const controls=touchFor(arena,stick,{fire,swim});
  fire.pointer('pointerdown',1);
  swim.pointer('pointerdown',2);
  assert(controls.fire && controls.swim);
  controls.clear();
  assert(!controls.fire && !controls.swim && controls.contacts.size===0);
});

test('thin visible cover occludes world-space crew nameplates',()=>{
  const {battle:b}=new RoomEngine(options), a=b.actors[4];
  Object.assign(b.player,{x:-11.244,y:0,z:-1.840});
  Object.assign(a,{x:-7.458,y:0,z:-3.320});
  const eye=[-11.244,.452,-1.840], point=[a.x,a.y+2.18,a.z];
  assert(b.traceShot(eye,point,true) && !b.traceShot(eye,point));
  const label={hidden:false,style:{}};
  const ctx={battle:b,arena:{clientWidth:900,clientHeight:450},tags:[{actor:a,label}],watchingAerial:()=>false,
    sameLevel,camera:{eye},renderer:{project:()=>[.5,.5]}};
  runInNewContext(fragment('function projectTags()', 'function frame(')+'\nprojectTags()',ctx);
  assert.equal(label.hidden,true);
});

test('following a live NPC advances past eliminated crews and handles the next elimination',()=>{
  const {battle:b}=new RoomEngine({...options,mode:'watch'});
  b.countdown=0;
  b.watching=0;
  b.actors[1].down=2;
  b.cycle();
  assert.equal(b.cameraActor(),b.actors[2]);
  b.actors[2].down=2;
  b.update(dt,neutral,camera);
  assert.equal(b.cameraActor(),b.actors[3]);
});

test('a raider picks a vulnerable opponent instead of a closer respawn shield',()=>{
  const {battle:b}=new RoomEngine({...options,mode:'timeless'});
  b.raiders.spawn();
  const a=b.raiders.members[0], shielded=b.actors[0], foe=b.actors[4];
  for (const p of b.actors) if (p!==shielded && p!==foe) p.down=99;
  Object.assign(a,{x:9,y:0,z:-16,yaw:Math.PI/2,scan:0});
  Object.assign(shielded,{x:11.3,y:0,z:-16,shield:1});
  Object.assign(foe,{x:14,y:0,z:-16,shield:0});
  b.raiders.update(dt);
  assert(a.target===foe);
});

test('a falling raider keeps falling when a patrol path cannot be found',()=>{
  const {battle:b}=new RoomEngine({...options,mode:'timeless'});
  b.raiders.spawn();
  const a=b.raiders.members[0];
  Object.assign(a,{x:10,y:3,z:-16,vy:-1,airborne:true,goal:{x:13,z:-16},roamAt:10});
  b.navigate=()=>false;
  b.raiders.patrol(a,dt);
  assert(a.y<3 && a.vy<-1);
});

test('squad intelligence forgets raiders that have retreated',()=>{
  const {battle:b}=new RoomEngine({...options,mode:'timeless'});
  b.raiders.spawn();
  const foe=b.raiders.members[0];
  b.tactics.observe(b.player,foe);
  assert.equal(b.tactics.intelligence(b.player,0).length,1);
  b.elapsed=b.raiders.retreatAt;
  b.raiders.update(dt);
  assert.equal(b.raiders.members.length,0);
  assert.equal(b.tactics.intelligence(b.player,0).length,0);
});

function canopy(b) {
  const x=-49.4,z=-26, floor=b.world.floor(x,z);
  return {x,z,floor,roof:b.traceShot([x,floor.y+6,z],[x,floor.y+.05,z],true,false)};
}

test('a giant stomp on a station canopy stains the canopy instead of the lower platform',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  const {x,z,floor,roof}=canopy(b);
  Object.assign(p,{x,y:roof.position[1],z,giant:true,giantNext:0,superUntil:10,airborne:false});
  b.abilities.updateActor(p,dt);
  assert.equal(b.paint.get(x,z,floor.layer),0);
  assert(b.decals.some(d=>d.shape===roof.shape.id));
});

test('a slam on a stopped train lands on its real roof above the tracks',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, rail=b.transit, line=rail.line;
  const x=line.center+rail.train.x-3,z=line.z;
  const roof=rail.trace([x,line.y+4.7,z],[x,line.y+1,z],true).position[1];
  Object.assign(p,{x,y:roof,z,weapon:WEAPONS.find(w=>w.special==='slam'),superCharge:100});
  assert(b.abilities.activate(p));
  for(let i=0;i<30;i++) b.abilities.updateActor(p,dt);
  assert(Math.abs(p.y-roof)<.02 && !p.slam);
  assert(rail.train.marks.some(m=>m.team===p.team));
});

test('a thrown bomb keeps flying for the last fraction of its fuse',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  b.subweapons.items.push({id:'throw',owner:p,p:[10,1.25,-16],v:[12,0,0],until:.023});
  b.clock=dt;
  b.subweapons.update(dt);
  assert.equal(b.subweapons.items.length,0);
  assert(Math.abs(b.abilities.rings[0].x-(10+12*.023))<1e-9);
});

test('a slide bomb leaves ink on a raised crate during the slide',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  const x=-14.3,y=2.65,z=-13.4;
  b.subweapons.items.push({id:'slider',owner:p,p:[x,y+.17,z],v:[4,0,0],until:5});
  b.clock=.05;
  b.subweapons.update(.05);
  assert.equal(b.subweapons.items.length,1);
  assert(b.decals.some(d=>Math.abs(d.p[0]-x-.2)<1e-8 && d.p[1]>2.65));
  assert.equal(b.paint.get(x,z,0),0);
});

test('NPCs escape a bomb on the other side of a traversable stair seam',()=>{
  const {battle:b}=new RoomEngine(options), a=b.actors[0], foe=b.actors[4], stairs=STAIRS[0];
  const pos=stairPoint(stairs,0,STAIR_SEAM-.45), danger=stairPoint(stairs,1,STAIR_SEAM+.53);
  Object.assign(a,pos,{y:b.world.floor(pos.x,pos.z).y,shield:0});
  b.subweapons.items.push({id:'timed',owner:foe,p:[danger.x,b.world.floor(danger.x,danger.z).y+.17,danger.z],until:.3});
  b.tactics.crew(a,null,dt);
  assert.equal(a.intent,'爆発範囲から退避');
  assert(a.x<pos.x-.10);
});

test('a planned passenger waits through the intermediate station, including after restore',()=>{
  const engine=new RoomEngine(options), b=engine.battle, a=b.actors[0], rail=b.transit, start=STATIONS[0], destination=STATIONS[2];
  Object.assign(a,{x:start.x,y:start.y,z:start.z});
  Object.assign(rail.train,{doorOpen:1,wait:5});
  const state=b.tactics.state(a);
  state.plan={steps:[{kind:'train',rail:0,level:0,from:-1,to:destination}]};
  assert(b.tactics.follow(a,state,dt) && isCabin(a.x));
  a.doorReady=0;
  rail.dock(1);
  Object.assign(rail.train,{doorOpen:1,wait:5});
  b.tactics.crew(a,null,dt);
  assert(isCabin(a.x));
  const r=restore(engine), npc=r.actors[0], service=r.transit;
  r.tactics.crew(npc,null,dt);
  assert(isCabin(npc.x));
  service.setSection(1);
  service.dock(1);
  Object.assign(service.train,{doorOpen:1,wait:5});
  for (let i=0;i<90 && isCabin(npc.x);i++) r.tactics.crew(npc,null,dt);
  assert(!isCabin(npc.x) && Math.abs(npc.x-destination.x)<9);
});

test('the streamed door remains boardable for the full authoritative window',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, rail=b.transit, start=STATIONS[0];
  Object.assign(p,{x:start.x,y:start.y,z:start.z});
  Object.assign(rail.train,{doorOpen:.702,wait:.802});
  assert.equal(rail.option(p)?.kind,'cabin-board');
  const f=frameOf(b,0,0,[]);
  const clientRail=Object.assign(Object.create(Object.getPrototypeOf(rail)),rail,f.transit);
  assert.equal(clientRail.option(p)?.kind,'cabin-board');
});

test('restoring an encounter preserves the boss target while its next scan is still pending',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.boss.spawn();
  b.boss.target=b.actors[4];
  b.boss.scan=.53;
  const r=restore(engine);
  assert(r.boss.target===r.actors[4] && r.boss.scan===.53);
});

test('restored raiders retain the last-seen stair location used for pursuit',()=>{
  const engine=new RoomEngine({...options,mode:'timeless'}), b=engine.battle;
  b.raiders.spawn();
  const sight={...stairPoint(STAIRS[0],0),until:15};
  b.raiders.members[0].lastSeen=sight;
  const r=restore(engine);
  assert.deepEqual(r.raiders.members[0].lastSeen,sight);
});

test('restoring a match preserves a live ink-hit effect and its target identity',()=>{
  const engine=new RoomEngine(options), b=engine.battle, foe=b.actors[4];
  b.clock=12;
  foe.shield=0;
  assert(b.inkHit(foe,18,b.player,[foe.x,foe.y+1,foe.z])>0);
  const r=restore(engine);
  assert.equal(r.inkImpacts.length,1);
  assert(r.inkImpacts[0].target===r.actors[4]);
  assert.deepEqual(frameOf(r,0,0,[]).inkImpacts,frameOf(b,0,0,[]).inkImpacts);
});

const workerSource=readFileSync(new URL('./worker.js',import.meta.url),'utf8');
const WorkerRoom=runInNewContext(workerSource.slice(workerSource.indexOf('const ROOM_RETENTION'),workerSource.indexOf('export default'))
  .replace('export class','class')+'\nInkshiftRoom',{
    DurableObject:class {constructor(ctx) {this.ctx=ctx;}},optionsFor,console
  });

test('the final result is persisted even inside the periodic checkpoint throttle',async()=>{
  const writes=[], pending=[];
  const ctx={storage:{put:async value=>{writes.push(value);}},waitUntil:promise=>pending.push(promise)};
  const instance=new WorkerRoom(ctx);
  const room={battle:{finished:true,elapsed:420},poll:()=>({frames:['final'],checkpoint:true}),
    checkpoint:()=>({game:{finished:true,left:0}})};
  instance.ensure=async()=>room;
  instance.saveAfter=Date.now()+10000;
  const sent=[],socket={readyState:1,deserializeAttachment:()=>options,send:data=>sent.push(data)};
  await instance.webSocketMessage(socket,'fixture');
  await Promise.all(pending);
  assert.deepEqual(sent,['final']);
  assert.deepEqual(writes,[{game:{finished:true,left:0}}]);
});

test('losing the socket while the result is sent still leaves a saved final result',async()=>{
  const writes=[], pending=[];
  const ctx={storage:{put:async value=>{writes.push(value);}},waitUntil:promise=>pending.push(promise)};
  const instance=new WorkerRoom(ctx);
  const room={battle:{finished:true,elapsed:420},poll:()=>({frames:['final'],checkpoint:true}),
    checkpoint:()=>({game:{finished:true,left:0}})};
  instance.ensure=async()=>room;
  const socket={readyState:1,deserializeAttachment:()=>options,send(){throw Error('socket closed');}};
  await assert.rejects(instance.webSocketMessage(socket,'fixture'),/socket closed/);
  await Promise.all(pending);
  assert.deepEqual(writes,[{game:{finished:true,left:0}}]);
});

test('expiration does not delete a room when a player reconnects during an in-flight save',async()=>{
  const calls=[], sockets=[];
  const ctx={getWebSockets:()=>sockets,storage:{setAlarm:async()=>{calls.push('renew');},deleteAll:async()=>{calls.push('delete');}}};
  const instance=new WorkerRoom(ctx), room={};
  instance.engine=room;
  let saved;
  instance.savePending=new Promise(resolve=>{saved=resolve;});
  const alarm=instance.alarm();
  sockets.push({readyState:1});
  saved();
  await alarm;
  assert.deepEqual(calls,['renew']);
  assert(instance.engine===room);
});
