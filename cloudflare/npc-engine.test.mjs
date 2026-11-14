import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine,HZ} from './room-engine.js';
import {NpcCover} from '../dist/npc-cover.js';
import {incoming,muzzleClear} from '../dist/npc-combat.js';
import {limbJoint} from '../dist/npc-motion.js';
import {NpcPerception} from '../dist/npc-perception.js';
import {STAIRS,STAIR_SEAM,stairPoint} from '../dist/stairs.js';
import {STATIONS,isCabin} from '../dist/layout.js';

const opts={mode:'play',teamSize:4,weapon:'jet'};
const dt=1/HZ;
const command=(seq,extra={})=>JSON.stringify({type:'input',seq,x:0,z:0,yaw:Math.PI/2,pitch:-.17,...extra});
const parse=update=>JSON.parse(update.frames[0]);

test('a hidden enemy only leaves a sampled position, and firing noise does not identify a target',()=>{
  let wall=false;
  const a={x:0,y:0,z:0,yaw:Math.PI/2,team:0,weapon:{range:30,speed:76}}, foe={x:6,y:0,z:0,team:1};
  const b={clock:1,rng:()=>.61,actors:[a,foe],raiders:{members:[]},boss:{},traceShot:()=>wall?{t:.5}:null,
    subweapons:{block:()=>null}};
  const perception=new NpcPerception(b);
  const sight=perception.scan(a,dt);
  assert(sight.visible && sight.react>b.clock);
  assert.deepEqual(sight.foot,{x:6,y:0,z:0});
  foe.x=6.3;
  b.clock+=.20;
  assert(perception.scan(a,dt).velocity[0]>0);
  wall=true;
  foe.x=7;
  perception.fire(foe);
  b.clock+=.27;
  const memory=perception.scan(a,dt);
  assert(!memory.visible && memory.foot.x===6.3);
  assert(memory.heard && memory.heard.x!==foe.x);
  assert.notEqual(memory.foot.x,foe.x);
});

test('a supporting player or an enemy curtain closes the real NPC firing window',()=>{
  const {battle:b}=new RoomEngine(opts), a=b.actors[0], ally=b.player, foe=b.actors[4];
  for (const other of b.actors) if (other!==a && other!==ally && other!==foe) other.down=99;
  Object.assign(a,{x:-45,y:0,z:1,yaw:Math.PI/2,bodyYaw:Math.PI/2,pitch:0});
  const point=[-36,1.22,.66];
  Object.assign(ally,{x:-41,y:0,z:1.15,yaw:Math.PI/2,bodyYaw:Math.PI/2});
  assert.equal(muzzleClear(b,a,point),false);
  ally.z=-2;
  assert(muzzleClear(b,a,point));
  b.subweapons.items.push({id:'curtain',p:[-40,.17,1],yaw:Math.PI/2,halfWidth:2,height:2,hp:108,until:5,owner:foe});
  assert.equal(muzzleClear(b,a,point),false);
});

test('NPCs detect oncoming ink using relative velocity and intervening geometry',()=>{
  const a={x:6,y:0,z:0,team:0,vx:1,vz:0};
  const shot={actor:{team:1},pos:[0,1.10,0],vel:[41,.5,0],weapon:{gravity:7,size:.15}};
  const b={shots:[shot],traceShot:()=>null};
  assert(incoming(b,a).time>.14);
  shot.vel[0]=-41;
  assert.equal(incoming(b,a),null);
  shot.vel[0]=41;
  b.traceShot=()=>({t:.55});
  assert.equal(incoming(b,a),null);
});

test('walking accelerates continuously, alternating legs keep their support, and IK stays finite at a straight leg',()=>{
  const {battle:b}=new RoomEngine(opts), a=b.actors[0];
  for (const other of b.actors) if (other!==a) other.down=99;
  Object.assign(a,{x:-45,y:0,z:1,yaw:Math.PI/2,bodyYaw:Math.PI/2});
  b.motion.begin();
  b.motion.drive(a,4.8,0,dt);
  assert(a.vx>0 && a.vx<2);
  let support=0;
  for (let i=0;i<28;i++) {
    const before=a.feet.slice(), vx=a.driveX;
    b.motion.drive(a,4.8,0,dt);
    assert(Math.abs(a.driveX-vx)<=27*dt+.00001);
    if (before.slice(0,3).every((v,j)=>v===a.feet[j]) ||
        before.slice(4,7).every((v,j)=>v===a.feet[j+4])) support++;
  }
  assert(support>=26);
  const hip=[0,1,0], knee=limbJoint(hip,[0,.4,0],.35,.35,[0,1,0]);
  assert(knee.every(Number.isFinite) && Math.abs(Math.hypot(knee[0],knee[1]-1,knee[2])-.35)<1e-8);
});

test('movement separates actors in opposite halves of the same stair landing',()=>{
  const {battle:b}=new RoomEngine(opts), a=b.actors[0], other=b.actors[4], stairs=STAIRS[0];
  const first=stairPoint(stairs,0,STAIR_SEAM-.36), second=stairPoint(stairs,1,STAIR_SEAM+.36);
  Object.assign(a,first,{y:-4,vx:2,vz:0});
  Object.assign(other,second,{y:-4,vx:-3,vz:0});
  b.motion.begin();
  const [vx,vz]=b.motion.avoid(a,3.7,0);
  assert(vx<3.7 && Math.abs(vz)>.12);
  assert.equal(b.motion.roomFor(a,a.x+.13,a.y,a.z,.4,1.72),false);
  assert(b.motion.roomFor(a,a.x-.1,a.y,a.z,.4,1.72));
});

test('a cover drill waits, steps out, fires and pulls back',()=>{
  const states=[], a={x:0,y:0,z:0,team:0,hp:100,tank:140,damageAge:99,weapon:{cost:2}}, s={};
  const b={clock:1,rng:()=>.5,steer(actor,p,_dt,_speed,_swim,pose){Object.assign(actor,p);states.push(pose.brace);}};
  let shots=0;
  const c=new NpcCover(b,{shoot(){shots++;return true;}});
  c.find=()=>({hide:{x:1,y:0,z:0},peek:{x:1,y:0,z:1},dir:1});
  const sight={visible:true,foot:{x:9,y:0,z:0},point:[9,1.09,0],at:1};
  for (const time of [1,1.45,1.50,1.55,1.61]) {
    b.clock=time;
    assert(c.run(a,s,sight,dt));
  }
  assert.equal(shots,2);
  assert.equal(a.intent,'射撃後に遮蔽へ戻る');
  assert.equal(a.z,0);
  assert(states.some(brace=>brace>.85) && states.some(brace=>brace<.3));
});

test('shared observations leave one NPC on the firing line and send another around the target',()=>{
  const {battle:b}=new RoomEngine(opts), anchor=b.actors[0], flanker=b.actors[2], enemy=b.actors[4];
  for (const a of b.actors) if (![anchor,flanker,enemy].includes(a)) a.down=99;
  Object.assign(anchor,{x:8,y:0,z:-15});
  Object.assign(flanker,{x:6,y:0,z:-11});
  Object.assign(enemy,{x:17,y:0,z:-15,shield:0});
  b.navs=b.navs.map(nav=>({...nav,nearest:point=>({...point})}));
  b.traceShot=()=>null;
  b.tactics.observe(anchor,enemy);
  b.perception.memory.set(anchor,{visible:true,foot:{x:17,y:0,z:-15}});
  b.tactics.squads.refresh();
  assert.equal(b.tactics.squads.orders.get(anchor)?.kind,'anchor');
  const intent=b.tactics.squads.orders.get(flanker);
  assert.equal(intent?.kind,'flank');
  assert(Math.abs(intent.goal.z-enemy.z)>8);
});

test('a stopped train accepts a planned NPC, and a checkpoint preserves its bounded route and stair identities',()=>{
  const engine=new RoomEngine(opts), b=engine.battle, a=b.actors[2], rail=b.transit;
  const [from,,,to]=STATIONS;
  Object.assign(a,{x:from.x,y:from.y,z:from.z});
  Object.assign(rail.train,{doorOpen:1,wait:5});
  const state=b.tactics.state(a);
  state.plan={goal:b.lowerNav.nodes[3],steps:[{kind:'train',rail:0,level:0,from:-1,to},
    {kind:'stairs',stair:STAIRS[3],to:{...stairPoint(STAIRS[3],0),level:0}}]};
  assert.equal(rail.boardingTime(0,-1,1),1);
  assert(b.tactics.follow(a,state,dt) && isCabin(a.x));
  assert.equal(a.trainTrips,1);
  const saved=engine.checkpoint();
  assert(JSON.stringify(saved.game.tactics).length<2200);
  const restored=new RoomEngine(opts,new Map(Object.entries(saved))).battle, rider=restored.actors[2];
  const plan=restored.tactics.state(rider).plan;
  assert(plan.steps[0].boarded && plan.steps[1].stair===STAIRS[3]);
  assert.equal(rider.cabinToLevel,1);
  assert.equal(rider.cabinToSide,-1);
});

test('the server clock advances with no packets while stale controls expire and idle state is checkpointed',()=>{
  const engine=new RoomEngine(opts), b=engine.battle, a=b.player;
  b.countdown=0;
  for (const other of b.actors) if (other!==a) other.down=99;
  Object.assign(a,{x:10,y:0,z:-16,shield:0});
  engine.poll(command(1,{z:1,fire:true,press:true}),1000);
  const first=parse(engine.pump(1100));
  assert(first.inputAck===1 && first.tick===2);
  for (let i=3;i<=21;i++) engine.pump(1000+Math.round(i*1000/HZ));
  assert(a.x>10.5 && a.tank<a.tankMax);
  const x=a.x,ammo=a.tank,elapsed=b.elapsed;
  engine.pump(1950);
  assert.equal(a.x,x);
  assert(a.tank>=ammo && b.elapsed>elapsed);
  const idle=engine.pump(9001);
  assert(idle.idle && idle.checkpoint && !engine.running);
  const second=b.elapsed;
  engine.resetLink();
  engine.poll(command(1),35000);
  assert.equal(b.elapsed,second);
  engine.pump(35051);
  assert(b.elapsed>second && a.x===x);
});

test('the Cloudflare lock clears behind a curtain and does not modify the shot direction',()=>{
  const r=new RoomEngine(opts),b=r.battle,p=b.player,a=b.actors[4];
  for (const actor of b.actors) if (actor!==a && actor!==p) actor.down=99;
  b.countdown=0;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,pitch:-.13});
  Object.assign(a,{x:14.192,y:0,z:-15.35,yaw:-Math.PI/2,shield:0});
  const aim={seq:1,yaw:Math.PI/2,pitch:-.13};
  r.updateLock(aim);
  const info=r.lockView();
  assert(info?.direct && b.actors[info.index]===a);
  assert.equal(p.yaw,aim.yaw);
  b.subweapons.items.push({id:'curtain',p:[12,.17,-15.35],yaw:Math.PI/2,halfWidth:2,height:2,hp:108,until:5,owner:a});
  r.updateLock(aim);
  assert.equal(r.lockView(),null);
  assert.equal(b.shots.length,0);
});
