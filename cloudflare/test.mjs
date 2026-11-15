import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleEdge} from './edge.js';
import {RoomEngine} from './room-engine.js';
import {frameOf} from './frame.js';
import {CLOUD_PROTOCOL,INK_SIZE,SOCKET_PROTOCOL,applyInkPacket,resetVisualInk} from '../dist/ink-wire.js';
import {BASE_TANK,BOUNDS,CABIN_LAYER,CABIN_X,CABIN_Y,GIGA_TANK,METRO,RAIL,RAIL_CABIN_X,SCENE_FILE,STATIONS,UNDER_BOUNDS,UNDER_X,ZONES,interiorBlend,zoneOf} from '../dist/layout.js';
import {Paint} from '../dist/ink.js';
import {RemoteMatch} from '../dist/remote-match.js';
import {AVATAR_FIELDS,aerialView,crewView} from '../dist/cloud-view.js';
import {setFullscreen} from '../dist/fullscreen.js';
import {Renderer,multiply,perspective,view} from '../dist/render.js';
import {STAIRS,STAIR_SEAM,stairEnd,stairPoint} from '../dist/stairs.js';
import {trainArrival} from '../dist/tactics.js';
import {World} from '../dist/world.js';
import {BOSS_RESPAWN_SECONDS,EXP_PER_KILL,INK_HIT_DURATION,RESPAWN_SECONDS,drawCrew} from '../dist/battle.js';
import {collectShapes,Geometry,makeShape} from '../dist/collision.js';
import {TouchControls} from '../dist/touch.js';
import {DRONE_WEAPON,EBOT,SUPERS,WEAPONS,weaponById} from '../dist/weapons.js';
import {RAIDER_WEAPON} from '../dist/raiders.js';
import {SUBWEAPONS} from '../dist/subweapons.js';
import {TRAIN_DOORS} from '../dist/train-model.js';
import * as inkHud from '../dist/ink-hud.js';
import {CONNECTION_TIME} from '../dist/transit.js';

const origin='https://inkshift.example';
const code='test-only-random-long-access-code';
const room='a'.repeat(64);
const options={mode:'timeless',weapon:'prism',teamSize:8};
const {inkReadout}=inkHud;
const command={type:'input',x:0,z:0,yaw:Math.PI/2,pitch:-.14};
const submit=(engine,seq,at,extra={})=>engine.poll(JSON.stringify({...command,seq,...extra}),at);
const frame=packets=>JSON.parse(packets.find(x=>typeof x==='string'));
const apply=(p,packets)=>{
  const f=frame(packets);
  if (f.fullInk) resetVisualInk(p,f.fullInk);
  for (const bytes of packets) if (typeof bytes!=='string') applyInkPacket(p,bytes);
  return f;
};

test('edge locks room creation, signs a per-room ticket, and verifies origin and signature before routing',async()=>{
  let routed=0;
  const env={GAME_ACCESS_CODE:code,ASSETS:{fetch:()=>new Response('title')},
    ROOMS:{newUniqueId:()=>room,idFromString:x=>x,get:(id,config)=>({fetch:req=>{
      routed++;
      assert.equal(id,room);
      assert.equal(config.locationHint,'apac');
      assert.equal(JSON.parse(req.headers.get('X-Inkshift-Verified')).teamSize,4);
      return new Response('socket forwarded');
    }})}};
  const post=(access,from=origin)=>new Request(origin+'/api/inkshift/rooms',{method:'POST',
    headers:{'Content-Type':'application/json',Origin:from},body:JSON.stringify({...options,access})});
  const dial=ticket=>new Request(origin+'/api/inkshift/socket/'+room,{headers:{
    Origin:origin,Upgrade:'websocket','Sec-WebSocket-Protocol':SOCKET_PROTOCOL+', '+ticket}});
  assert.equal((await handleEdge(post(code),{...env,GAME_ACCESS_CODE:undefined})).status,503);
  assert.equal((await handleEdge(post(code,'https://elsewhere.example'),env)).status,403);
  assert.equal((await handleEdge(post('bad'),env)).status,401);
  const health=await (await handleEdge(new Request(origin+'/api/inkshift/health'),env)).json();
  assert.deepEqual(health,{cloud:true,ready:true,protocol:CLOUD_PROTOCOL});
  const res=await handleEdge(post(code),env);
  assert.equal(res.status,201);
  const ticket=await res.json();
  assert.equal(ticket.room,room);
  const tampered=(ticket.ticket[0]==='a'?'b':'a')+ticket.ticket.slice(1);
  assert.equal((await handleEdge(dial(tampered),env)).status,401);
  assert.equal(routed,0);
  assert.equal((await handleEdge(dial(ticket.ticket),env)).status,200);
  assert.equal(routed,1);
});

test('server owns time, movement, pause, and an unthrottled final timed snapshot',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  assert.equal(b.actors.length,8);
  assert.equal(b.actors.filter(a=>a.isPlayer).length,1);
  b.countdown=0;
  const x=b.player.x;
  for(let i=0;i<36;i++) submit(engine,i+1,1000+i*50,{z:9,time:9000,health:9999});
  assert(b.player.x>x+3 && b.player.x<x+15 && b.player.hp<=100);
  assert(b.elapsed>=1.6 && b.elapsed<=1.76);
  const elapsed=b.elapsed;
  const paused=submit(engine,37,2800,{paused:true});
  assert(paused.checkpoint);
  submit(engine,38,47000,{paused:true});
  assert.equal(b.elapsed,elapsed);
  submit(engine,39,47100);
  assert.equal(b.elapsed,elapsed);
  const timed=new RoomEngine({...options,mode:'play'});
  timed.battle.countdown=0;
  timed.battle.left=.03;
  submit(timed,1,1000);
  const finished=submit(timed,2,1050);
  assert(finished.checkpoint && frame(finished.frames).finished);
  assert.equal(timed.battle.left,0);
});

test('visible ink deltas and cold room restore preserve pigment, train and GIGA ownership',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player;
  const mirror=new Paint({...INK_SIZE,visualOnly:true});
  mirror.setWorld(b.world);
  apply(mirror,engine.frames(1000,true));
  const worldX=24,z=0, layer=b.world.floor(worldX,z).layer;
  b.paint.stamp(worldX,z,1.43,0,layer,.5,.054);
  const delta=apply(mirror,engine.frames(1100));
  assert(!delta.fullInk && mirror.get(worldX,z,layer)===1);
  b.paint.stamp(CABIN_X,0,1.2,1,CABIN_LAYER,.3,.056);
  Object.assign(p,{x:CABIN_X,y:CABIN_Y,z:0});
  const zone=apply(mirror,engine.frames(1200));
  assert.equal(zone.zone,2);
  assert.equal(zone.fullInk,ZONES[2].inkMask);
  assert.equal(mirror.get(CABIN_X,0,CABIN_LAYER),2);
  b.chip.owner=p;
  p.tank=273;p.tankMax=GIGA_TANK;
  b.metro.damage(133);
  b.clock=86;b.elapsed=83;
  b.raiders.spawn();
  const stored=new Map(Object.entries(structuredClone(engine.checkpoint())));
  const replay=new RoomEngine(options,stored);
  assert.equal(replay.battle.elapsed,83);
  assert.equal(replay.battle.metro.integrity,METRO.integrity-133);
  assert.equal(replay.battle.player.tankMax,GIGA_TANK);
  assert.equal(replay.battle.player.tank,273);
  assert.equal(replay.battle.chip.owner,replay.battle.player);
  assert.equal(replay.battle.raiders.live().length,4);
  assert.equal(replay.battle.paint.get(CABIN_X,0,CABIN_LAYER),2);
  assert.equal(replay.battle.paint.mask,b.paint.mask);
  assert.notEqual(replay.battle.paint.pixels,b.paint.pixels);
  assert.equal(replay.battle.left,Infinity);
});

test('both teams and raiders can board either train and fight and paint inside',()=>{
  const b=new RoomEngine(options).battle, p=b.player, target=b.actors[4];
  b.raiders.spawn();
  const passengers=[...b.actors,...b.raiders.live()];
  for (const [i,rail] of [b.metro,b.transit].entries()) {
    const line=rail.line;
    rail.update(.9);
    for (const passenger of passengers) {
      Object.assign(passenger,{x:line.center-line.x,y:line.platformY,z:line.platformZ,down:0,doorReady:0});
      assert(b.useTransport(passenger) && zoneOf(passenger.x)===i+2,passenger.name);
    }
    Object.assign(p,{x:line.cabinX-3.1,y:CABIN_Y,z:-.22,yaw:Math.PI/2,pitch:0,fire:0,swimming:false});
    Object.assign(target,{x:line.cabinX+2.4,y:CABIN_Y,z:.18,yaw:-Math.PI/2,shield:0,hp:100,down:0,swimming:false});
    for (const a of passengers) if (a!==p && a!==target) a.shield=10;
    const start=p.x;
    b.world.step(p,-.36,0);
    assert(p.x<start);
    assert(b.shoot(p,[target.x,target.y+1.15,target.z]));
    for (let j=0;j<32;j++) b.updateShots(1/120);
    assert(Math.abs(target.hp-(100-p.weapon.damage/3))<1e-8);
    b.abilities.paint(p,p.x,p.z,1.29,.042);
    assert.equal(b.paint.get(p.x,p.z,line.cabinLayer),1);
  }
  Object.assign(p,{x:CABIN_X,y:CABIN_Y,z:0});
  const intact=b.metro.integrity;
  b.abilities.area(p,p.x,p.y,p.z,4.8,112);
  assert(b.metro.integrity<intact);
  b.metro.damage(10000);
  assert(b.carryTransit(p,1/60) && zoneOf(p.x)===1);
});

test('each stair is walkable in both directions and shots continue across the landing',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  for (const stair of STAIRS) {
    for (const level of [0,1]) {
      Object.assign(p,stairPoint(stair,level),{y:ZONES[level].y,vy:0});
      for (let i=0;i<245;i++) b.move(p,4.59*stair.dir*(level===0?1:-1),0,1/60,false,false);
      assert.equal(zoneOf(p.x),1-level,stair.name);
      assert.equal(p.y,ZONES[1-level].y,stair.name);
    }
    const first=stairPoint(stair,0,STAIR_SEAM-.35), last=stairPoint(stair,0,STAIR_SEAM+1.14);
    const hit=b.traceShot([first.x,-3.28,first.z],[last.x,-4.48,last.z],true);
    assert(hit?.shift===UNDER_X && zoneOf(hit.position[0])===1,stair.name);
  }
});

test('a stair view streams ink from both sides without resetting it at the landing',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player;
  const shown=new Paint(INK_SIZE), stair=STAIRS[0], start=stairPoint(stair,0,4);
  const lower={x:UNDER_X-29,z:stair.z};
  b.paint.stamp(lower.x,lower.z,1.4,1,2,0,.067);
  assert.equal(apply(shown,engine.frames(1000,true)).fullInk,ZONES[0].inkMask | ZONES[1].inkMask);
  assert.equal(shown.get(lower.x,lower.z,2),2);
  Object.assign(p,start,{y:b.world.floor(start.x,start.z).y});
  assert.equal(apply(shown,engine.frames(1110)).fullInk,0);
  assert.equal(shown.get(lower.x,lower.z,2),2);
  const landing=stairPoint(stair,1,STAIR_SEAM+.04);
  Object.assign(p,landing,{y:b.world.floor(landing.x,landing.z).y});
  assert.equal(apply(shown,engine.frames(1140)).fullInk,0);
  assert.equal(shown.get(lower.x,lower.z,2),2);
});

test('wall ink stays off the score, provides team-specific climb grip and uses the precise mesh',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player, point=[16,.46,-16];
  const hit=b.world.traceExact(point,[16.84,.46,-16]);
  assert(hit?.shape?.id>=0 && hit.layer===undefined && hit.normal[0]<-.99);
  const before=b.paint.count.slice();
  Object.assign(p,{x:16,y:0,z:-16,vy:0,climbNormal:null});
  assert.equal(b.climb(p,3,0,1/60,true,false),false);
  b.splat(hit,{actor:p,power:1});
  assert.deepEqual(b.paint.count,before);
  const mark=b.decals.at(-1);
  assert.equal(mark.shape,hit.shape.id);
  assert(b.climb(p,3,0,1/60,true,false) && p.y>0);
  const enemy=b.actors[4];
  Object.assign(enemy,{x:16,y:0,z:-16,vy:0,climbNormal:null});
  assert.equal(b.climb(enemy,3,0,1/60,true,false),false);
  const scene=JSON.parse(readFileSync(new URL(`../dist/${SCENE_FILE}`,import.meta.url)));
  const baked=new World({zone:0,add(){},label(){},seal(){}},scene);
  const other=baked.traceExact(point,[16.84,.46,-16]);
  assert.equal(other.shape.id,hit.shape.id);
  assert.deepEqual(other.position,hit.position);
  const saved=engine.checkpoint();
  saved.game.decals.at(-1).shape=-1;
  const restored=new RoomEngine(options,new Map(Object.entries(saved))).battle;
  assert.equal(restored.decals.at(-1).shape,hit.shape.id);
  assert.equal(restored.wallOwner(hit.position,hit.normal,hit.shape.id),p.team+1);
  const marking=b.world.traceExact([-31.5,1,.03],[-31.5,-.05,.03]);
  assert.equal(marking.shape.kind,22);
  assert.equal(marking.layer,0);
});

test('ink ownership is saturated, dry swimming heals slower, and hostile ink adds pressure each second',()=>{
  const sample=owner=>{
    const b=new RoomEngine(options).battle, p=b.player;
    for (const a of b.actors) if (a!==p) a.down=99;
    b.paint.reset();
    b.countdown=0;
    Object.assign(p,{x:-44,y:0,z:3,tank:0,hp:30,damageAge:3,shield:0});
    if (owner) b.paint.stamp(p.x,p.z,3,owner-1,0,0,.067);
    b.update(1/24,{...command,swim:true},()=>crewView(b,p));
    return {b,p};
  };
  const dry=sample(0).p, own=sample(1).p;
  assert(dry.swimming && !dry.inkSwimming && own.swimming && own.inkSwimming);
  assert(own.tank>dry.tank && own.hp>dry.hp);
  const {b,p}=sample(2), index=b.paint.index(p.x,p.z,0), px=index*4;
  assert.equal(p.inkPenalty,1);
  assert.equal(b.paint.pixels[px],0);
  assert.equal(b.paint.pixels[px+1],255);
  b.inkPressure(p,.99);
  assert.equal(p.inkPenalty,2);
  b.inkPressure(p,1);
  assert.equal(p.inkPenalty,3);
  assert.equal(p.tankMax,BASE_TANK);
  Object.assign(b.chip,{x:p.x,y:p.y,z:p.z,owner:null});
  assert(b.pickupChip(p));
  assert.equal(p.tankMax,GIGA_TANK);
  assert(!b.pickupChip(p));
});

test('manual focus only tracks visible precise body hits and cannot change a projectile',()=>{
  const b=new RoomEngine(options).battle, p=b.player, target=b.actors[4];
  const eye=[-6,13,0], dir=[1,0,0], end=[6,13,0];
  Object.assign(target,{x:0,y:11.95,z:0,yaw:Math.PI/2,shield:0,down:0,swimming:false});
  assert.equal(b.focusTarget(eye,dir,p.team,35)?.actor,target);
  assert(b.bodyHit(eye,end,target)!==null);
  assert.equal(b.bodyHit([-6,13,.92],[6,13,.92],target),null);
  const one=b.aim(eye,dir,35);
  b.rng=()=>.5;
  p.fire=0;
  assert(b.shoot(p,one.position));
  const velocity=b.shots.at(-1).vel;
  target.z=4;
  assert.equal(b.focusTarget(eye,dir,p.team,35),null);
  assert.deepEqual(b.aim(eye,dir,35),one);
  p.fire=p.recoil=0;
  assert(b.shoot(p,one.position));
  assert.deepEqual(b.shots.at(-1).vel,velocity);
  Object.assign(target,{z:0,swimming:true});
  b.clock++;
  assert.equal(b.bodyHit(eye,end,target),null);
  assert(b.bodyHit([-6,12.09,0],[6,12.09,0],target)!==null);
});

test('the muzzle cannot spawn a shot beyond a thin obstacle at point-blank range',()=>{
  const b=new RoomEngine(options).battle,p=b.player;
  Object.assign(p,{x:16,y:0,z:-16,yaw:Math.PI/2,pitch:0,fire:0,recoil:0});
  assert(b.world.stand(p.x,p.z,.39));
  const [launch]=b.weaponLaunch(p);
  assert(launch.hit?.position[0]<launch.tip[0]);
  const tank=p.tank;
  assert(b.shoot(p,[26,1.4,-16]));
  assert.equal(b.shots.length,0);
  assert.equal(b.decals.at(-1)?.shape,launch.hit.shape.id);
  assert(p.muzzleBlocked && p.tank<tank);
});

test('crew camera stays fixed across forms and Cloudflare follows the selected spectator level',()=>{
  const engine=new RoomEngine({...options,mode:'watch'}), b=engine.battle, actor=b.cameraActor();
  const base=crewView(b,actor);
  for (const form of [{swimming:true,inkSwimming:false},{swimming:true,inkSwimming:true},{giant:true,swimming:false}]) {
    Object.assign(actor,form);
    assert.deepEqual(crewView(b,actor),base);
  }
  const aspect=844/390, pose=aerialView(aspect);
  const projector={vp:multiply(perspective(aspect),view(pose.eye,pose.target))};
  for (const x of [-53.5,53.5]) for (const z of [-35,35]) {
    const projection=Renderer.prototype.project.call(projector,[x,0,z]);
    assert(projection.every(n=>n>=0 && n<=1));
  }
  Object.assign(actor,{x:UNDER_X,y:-8,z:0});
  assert.equal(frame(engine.frames(1000,true)).zone,0);
  const follow=frame(submit(engine,1,1100,{overview:false}).frames);
  assert.equal(follow.zone,1);
  assert.equal(follow.fullInk,0);
  assert.equal(frame(submit(engine,2,1150,{overview:true}).frames).zone,0);
});

test('overhead geometry cannot raise the camera and staircase approaches blend continuously',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  Object.assign(p,{x:-50.55,y:0,z:-26.85,yaw:0});
  const underPlatform=crewView(b,p);
  assert(underPlatform.eye[1]<2.36);
  Object.assign(p,{swimming:true,inkSwimming:true});
  assert.deepEqual(crewView(b,p),underPlatform);
  const poses=[-.18,-.13].map(t=>{
    const entry=stairPoint(STAIRS[0],0,t);
    return crewView(b,{...entry,y:0,yaw:Math.PI/2,pitch:-.18});
  });
  assert(Math.hypot(...poses[0].eye.map((n,j)=>n-poses[1].eye[j]))<.15);
  for (const x of [CABIN_X,RAIL_CABIN_X]) {
    const pose=crewView(b,{x,y:CABIN_Y,z:0,yaw:0,pitch:-.18});
    assert(Math.abs(pose.eye[2])<1.87);
  }
  for (const aspect of [568/320,844/390,4/3,390/844]) {
    const pose=aerialView(aspect), projector={vp:multiply(perspective(aspect),view(pose.eye,pose.target))};
    for (const x of [-BOUNDS[0],BOUNDS[0]]) for (const z of [-BOUNDS[1],BOUNDS[1]]) {
      const uv=Renderer.prototype.project.call(projector,[x,0,z]);
      assert(uv.every(n=>n>=.05 && n<=.95));
    }
  }
  const daylight=interiorBlend({eye:[-45,2,-13],stair:true});
  const halfway=interiorBlend({eye:[-41,-1.2,-13],stair:true});
  const below=interiorBlend({eye:[-39,-3,-13],stair:true});
  assert(daylight===0 && daylight<halfway && halfway<below && below===1);
  assert.equal(halfway,interiorBlend({eye:[UNDER_X-41,-1.2,-13],stair:true}));
  const opening=stairPoint(STAIRS[0],1,2.5);
  assert.equal(b.world.traceExact([opening.x,-.88,opening.z],[opening.x,-1.17,opening.z]),null);
});

test('a camera boom leaves clearance for a wall beyond the sight ray’s grid cell',()=>{
  const geometry=new Geometry();
  const wall=makeShape('box',1,1,5.06,1,2,.08,0);
  geometry.add(wall);
  const start=[-1,1,4.88],end=[3,1,4.88];
  assert.equal(geometry.trace(start,end),null);
  assert.equal(geometry.traceClearance(start,end,.21)?.shape,wall);
  const pane=makeShape('glass',0,1,2,2,2,1,17);
  geometry.add(pane);
  assert.equal(geometry.trace([0,1,0],[0,1,1.9]),null);
  assert.equal(geometry.traceClearance([0,1,0],[0,1,1.9],.21)?.shape,pane);
});

test('the avatar cannot fill the aim view when the cabin camera is forced close',()=>{
  const b=new RoomEngine(options).battle,p=b.player;
  Object.assign(p,{x:CABIN_X-8.59,y:CABIN_Y,z:-.4,yaw:Math.PI/6,pitch:-.18});
  const pose=crewView(b,p);
  assert(pose.reach>0);
  assert.equal(pose.nearCrew,true);
  const direction=pose.target.map((v,i)=>(v-pose.eye[i])/17);
  const aim=[Math.sin(p.yaw)*Math.cos(p.pitch),Math.sin(p.pitch),-Math.cos(p.yaw)*Math.cos(p.pitch)];
  direction.forEach((v,i)=>assert(Math.abs(v-aim[i])<1e-10));
});

test('low painted sections and adjacent facade pieces support a complete wall climb',()=>{
  const b=new RoomEngine({...options,weapon:'jet'}).battle, p=b.player;
  const paintAt=y=>{
    const hit=b.world.traceExact([16,y,-16],[17.2,y,-16]);
    assert(hit && hit.layer===undefined);
    b.splat(hit,{actor:p,weapon:{...p.weapon,radius:.35},power:1});
    return hit;
  };
  const footMark=paintAt(.18), center=b.world.traceExact([16,.42,-16],[17.2,.42,-16]);
  assert.notEqual(footMark.shape.id,center.shape.id);
  assert.equal(b.wallOwner(center.position,center.normal,center.shape.id),0);
  Object.assign(p,{x:15.80,y:0,z:-16,vy:0,yaw:Math.PI/2});
  b.move(p,4.2,.5,1/60,true,false);
  assert(p.climbing && p.y>0 && p.z>-16);
  for (const y of [.42,.68,1,1.4,1.8,2.25,2.60]) paintAt(y);
  for (let i=0;i<42;i++) b.move(p,4.2,.5,1/60,true,false);
  assert(p.y>=2.58 && p.x>16.75 && !p.climbing);
});

test('ink swimming is faster than swimming over dry ground and produces no wake geometry',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  const start=-44, z=3, dt=1/24;
  const walk=(owner,swim)=>{
    b.paint.reset();
    if (owner) b.paint.stamp(start,z,3,0,0,0,.067);
    Object.assign(p,{x:start,y:0,z,vy:0,climbNormal:null});
    b.move(p,3,0,dt,swim,false);
    return p.x-start;
  };
  const ground=walk(false,false), dry=walk(false,true), ink=walk(true,true);
  assert(ink>ground*1.95 && ink>dry*1.8 && p.inkSwimming);
  assert.equal(b.drops.length,0);
  const camera=crewView(b,p);
  Object.assign(p,{swimming:false,inkSwimming:false});
  assert.deepEqual(crewView(b,p),camera);
});

test('main weapons fire four shots with their original cost of one shot',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  const former={jet:4.9,fan:9,charge:14,lob:18,blast:12,dual:6.3,surge:8.7,coil:7.5,prism:9,roller:5.39,rd2:48,td:30};
  const target=[p.x+5,p.y+1,p.z];
  for (const weapon of WEAPONS) {
    Object.assign(p,{weapon,tank:former[weapon.id],fire:0});
    b.shots.length=0;
    for (let i=1;i<=4;i++) {
      assert(b.shoot(p,target),weapon.id);
      assert(Math.abs(p.tank-former[weapon.id]*(1-i/4))<1e-9,weapon.id);
      p.fire=0;
    }
    // The TD shock cannon resolves its blast at once and leaves no round in flight.
    assert.equal(b.shots.length,weapon.blast?0:weapon.pellets*4);
    p.fire=0;
    assert(!b.shoot(p,target),weapon.id);
  }
});

test('roller tap releases a fan while a moving hold paints a continuous strip and clears on pause',()=>{
  const engine=new RoomEngine({...options,weapon:'roller'}), b=engine.battle, p=b.player;
  b.countdown=0;
  for (const a of b.actors) if (a!==p) a.down=99;
  Object.assign(p,{x:-44,y:0,z:3,yaw:Math.PI/2,pitch:-.18,shield:0,fire:0});
  const input={x:0,z:0,yaw:p.yaw,pitch:p.pitch,fire:true,press:true};
  b.control(p,input,1/24,()=>crewView(b,p));
  b.control(p,{...input,fire:false,press:false},1/24,()=>crewView(b,p));
  assert.equal(b.shots.length,5);
  assert(Math.abs(150-p.tank-WEAPONS[0].cost*1.1)<1e-9);
  p.fire=0;
  b.shots.length=0;
  const before=p.painted;
  for(let i=0;i<60;i++) b.update(1/60,{...input,z:1,press:false},()=>crewView(b,p));
  assert(p.rolling && p.painted>before && p.x>-40);
  for(const x of [-43,-42,-41]) assert.equal(b.paint.get(x,3,0),1);
  engine.resetLink();
  assert(!p.rolling && p.rollHold===0);
});

test('bomb fuses, moving paint, proximity trigger and enemy-only cover work through the shared simulation',()=>{
  for (const spec of SUBWEAPONS) {
    const engine=new RoomEngine({...options,weapon:'jet',sub:spec.id}), b=engine.battle,p=b.player;
    Object.assign(p,{x:-44,y:0,z:3,yaw:Math.PI/2,pitch:-.18,shield:0});
    assert(b.subweapons.use(p),spec.id);
    assert.equal(p.tank,150-spec.cost);
    assert(!b.subweapons.use(p));
    const item=b.subweapons.items[0], start=item.p.slice();
    if(spec.id==='curtain') {
      assert.equal(b.subweapons.block([start[0]+2,1,3],[start[0]-2,1,3],p.team),null);
      const shot={pos:[start[0]+2,1,3],vel:[-96,0,0],actor:b.actors[4],weapon:p.weapon,power:1,age:0};
      b.shots.push(shot);
      const health=p.hp;
      b.updateShots(1/24);
      assert.equal(p.hp,health);
      assert(item.hp<spec.hp && b.shots.length===0);
      continue;
    }
    if(spec.id==='trap') {
      b.clock=.9;
      b.subweapons.update(1/24);
      assert(!item.triggered);
      const enemy=b.actors[4];
      Object.assign(enemy,{x:start[0]+.7,y:0,z:3,shield:0,down:0});
      b.subweapons.update(1/24);
      assert(item.triggered && item.until<b.clock+.24);
      b.clock=item.until+.01;
      b.subweapons.update(1/24);
      assert(enemy.hp<100 && b.subweapons.items.length===0);
      continue;
    }
    if(spec.id==='see') {
      // The sensor flies like a bomb, rests, tags whoever steps inside 3 m and never explodes.
      for(let i=0;i<150;i++) {b.clock+=1/60;b.subweapons.update(1/60);}
      assert(!item.v && Math.hypot(...item.p.map((n,i)=>n-start[i]))>1);
      const enemy=b.actors[4], far=b.actors[5], painted=p.painted;
      Object.assign(enemy,{x:item.p[0]+2.2,y:item.p[1]-.17,z:item.p[2],shield:0,down:0});
      Object.assign(far,{x:item.p[0]+3.6,y:item.p[1]-.17,z:item.p[2],shield:0,down:0});
      b.clock+=.2;
      b.subweapons.update(1/60);
      assert(Math.abs(enemy.revealUntil-b.clock-spec.mark)<.01 && enemy.revealTeam===p.team);
      assert(!(far.revealUntil>b.clock) && enemy.hp===100);
      b.clock=item.until+.01;
      b.subweapons.update(1/60);
      assert.equal(b.subweapons.items.length,0);
      assert.equal(p.painted,painted);
      continue;
    }
    const before=p.painted;
    for(let i=0;i<30;i++) {b.clock+=1/60;b.subweapons.update(1/60);}
    if(spec.id==='timed') assert.deepEqual(item.p,start);
    else assert(Math.hypot(...item.p.map((n,i)=>n-start[i]))>1);
    const restored=new RoomEngine({...options,weapon:'jet',sub:spec.id},new Map(Object.entries(engine.checkpoint()))).battle;
    assert.equal(restored.subweapons.items[0].owner,restored.player);
    assert.equal(restored.player.subId,spec.id);
    assert(!restored.subweapons.canUse(restored.player));
    for(let i=0;i<190;i++) {b.clock+=1/60;b.subweapons.update(1/60);}
    assert.equal(b.subweapons.items.length,0);
    assert(p.painted>before,spec.id);
  }
});

test('a boarded train completes a through service, retains the cabin and survives a tunnel restore',()=>{
  const engine=new RoomEngine(options), b=engine.battle,p=b.player, rail=b.transit;
  rail.update(.9);
  Object.assign(p,{x:rail.line.center-rail.line.x,y:rail.line.platformY,z:rail.line.platformZ,doorReady:0});
  assert(rail.use(p));
  assert.equal(rail.option(p)?.label,'乗降中');
  const cabinX=p.x;
  for(let i=0;i<1000 && !rail.connection;i++) rail.update(rail.time+.1);
  assert(rail.connection && Number.isFinite(rail.arrival(0,1,1,1,rail.time)));
  const period=2.56, phase=x=>x/period-Math.round(x/period);
  assert(Math.abs(phase(rail.sceneryX(period)-rail.train.x))<.03);
  const phaseBefore=rail.sceneryX(period);
  rail.update(rail.time+18);
  assert.notEqual(rail.sceneryX(period),phaseBefore);
  b.elapsed=rail.time;
  b.clock=rail.time+3;
  b.metro.update(rail.time);
  const replay=new RoomEngine(options,new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(replay.player.x,cabinX);
  assert(replay.transit.connection && replay.transit.section===1);
  assert.equal(replay.transit.line.cabinX,RAIL_CABIN_X);
  let lastScenery;
  for(let i=0;i<1500 && replay.transit.connection;i++) {
    lastScenery=replay.transit.sceneryX(period);
    replay.transit.update(replay.transit.time+.01);
  }
  assert(Math.abs(phase(replay.transit.sceneryX(period)-lastScenery))<.05);
  replay.transit.update(replay.transit.time+.9);
  assert(replay.transit.train.stop===1 && replay.transit.train.doorOpen>.36);
  assert.equal(replay.transit.train.routePitch,0);
  replay.player.z=replay.transit.line.doorSide*.9;
  assert(replay.transit.use(replay.player));
  assert.equal(zoneOf(replay.player.x),1);
  assert(replay.player.y>METRO.y);
  assert.equal(replay.player.yaw,b.player.yaw);
});

test('damage in a connector stops and recovers the train at its actual location',()=>{
  const b=new RoomEngine(options).battle,rail=b.transit,p=b.player;
  rail.dock(1);
  rail.update(10.8);
  assert(rail.connection && rail.visibleIn(0));
  const position=rail.train.x,speed=rail.train.speed;
  Object.assign(p,{x:RAIL_CABIN_X,y:CABIN_Y,z:0});
  rail.damage(10000);
  assert(rail.failed() && rail.train.x===position && rail.train.speed===speed);
  rail.update(rail.time+.05);
  assert(rail.train.x>position && rail.train.x-position<.6 && rail.train.speed<speed);
  assert(rail.carry(p,1/24) && zoneOf(p.x)===0 && b.world.stand(p.x,p.z,.48));
  for (let i=0;i<600 && !rail.train.stop;i++) rail.update(rail.time+.05);
  assert.equal(rail.stopInfo().station.id,'G-E');
  assert.equal(rail.integrity,720);
});

test('projectiles and enemy-only curtains work at the exact stair fold',()=>{
  const b=new RoomEngine(options).battle,p=b.player,s=STAIRS[0];
  const fold=stairPoint(s,0,STAIR_SEAM), point=[fold.x,-2.72,fold.z], to=[fold.x+.65,-2.72,fold.z];
  assert.equal(zoneOf(stairEnd([fold.x-.2,-2.72,fold.z],point)[0]),1);
  const shot={pos:point,vel:[15.6,0,0],actor:p,weapon:p.weapon,power:1,age:0};
  b.shots.push(shot);
  b.updateShots(1/24);
  assert.equal(zoneOf(shot.pos[0]),1);
  const curtain={id:'curtain',p:[fold.x+UNDER_X+.27,-3.84,fold.z],owner:b.actors[4],yaw:Math.PI/2,
    halfWidth:1.2,height:2.15,hp:108,until:2};
  b.subweapons.items.push(curtain);
  assert.equal(b.subweapons.block(point,to,p.team)?.item,curtain);
  assert.equal(b.subweapons.block(point,to,curtain.owner.team),null);
  const grenade={id:'throw',p:[fold.x-.16,-2.72,fold.z],v:[12,0,0],owner:p,until:2};
  b.subweapons.items.push(grenade);
  b.subweapons.update(1/24);
  assert.equal(zoneOf(grenade.p[0]),1);
});

test('bomb damage respects narrow visible cover and carries through a clear stair opening',()=>{
  const b=new RoomEngine(options).battle,p=b.player,enemy=b.actors[4];
  const origin=[-11.5925,.93,-2.65], target=[-9.7075,1.15,-2.65];
  assert.equal(b.traceShot(origin,target),null);
  assert(b.traceShot(origin,target,true));
  Object.assign(enemy,{x:target[0],y:target[1]-.36,z:target[2],swimming:true,shield:0});
  const health=enemy.hp;
  b.abilities.area(p,origin[0],origin[1]-.28,origin[2],3.1,111,undefined,true);
  assert.equal(enemy.hp,health);
  const near=stairPoint(STAIRS[0],0,STAIR_SEAM-.40), far=stairPoint(STAIRS[0],1,STAIR_SEAM+.47);
  Object.assign(enemy,{...far,y:-4,swimming:false});
  b.abilities.area(p,near.x,-3.32,near.z,3.1,111,undefined,true);
  assert(enemy.hp<health);
});

test('expanded underground wings remain reachable and paint beyond the old boundary',()=>{
  const b=new RoomEngine(options).battle,p=b.paint;
  assert(UNDER_BOUNDS[0]*UNDER_BOUNDS[1]>48*30*2);
  const point={x:UNDER_X+57,z:32};
  assert(b.world.stand(point.x,point.z,.5));
  assert(p.index(point.x,point.z,2)>=0 && p.mask[p.index(point.x,point.z,2)]);
  assert(p.stamp(point.x,point.z,1.6,0,2)>0);
  assert.equal(p.get(point.x,point.z,2),1);
  for (const station of STATIONS.filter(stop=>stop.level===1)) {
    const entry=stairPoint(STAIRS[station.side<0?1:3],1), goal=b.lowerNav.nearest(station);
    assert(goal && b.lowerNav.route(entry,goal).length>0,station.name+' has a walkable approach');
  }
  const goal=b.lowerNav.nearest(point);
  assert(goal && b.lowerNav.route(stairPoint(STAIRS[3],1),goal).length>0);
});

test('an open train wins over another service waiting at the same level',()=>{
  const b=new RoomEngine(options).battle,p=b.player;
  b.metro.setSection(0);b.metro.dock(1);b.metro.update(.9);
  b.transit.update(.9);
  Object.assign(p,{x:-RAIL.x,y:RAIL.platformY,z:RAIL.platformZ,doorReady:0});
  assert.equal(b.metro.option(p).kind,'busy');
  assert.equal(b.transit.option(p).kind,'cabin-board');
  assert.equal(b.transportOption(p).kind,'cabin-board');
  assert(b.useTransport(p));
  assert.equal(zoneOf(p.x),3);
});

test('walking through an open doorway boards a train, visits four stations and exits onto a real platform',()=>{
  const b=new RoomEngine(options).battle,p=b.player,rail=b.transit,door=TRAIN_DOORS[1];
  rail.update(.9);
  Object.assign(p,{x:-RAIL.x+door,y:RAIL.platformY,z:RAIL.z+2.4,doorReady:0,vy:0});
  rail.train.doorOpen=0;
  const closed=p.z;
  b.move(p,0,-3,.1,false,false);
  assert.equal(p.z,closed,'a closed train body cannot be walked through');
  rail.update(1.2);
  b.move(p,0,-3,.1,false,false);
  assert.equal(zoneOf(p.x),3);
  const cabin=p.x;
  b.paint.stamp(p.x,p.z,.9,p.team,rail.line.cabinLayer);
  const visited=['G-W'];
  for(let i=0;i<1600 && visited.length<5;i++) {
    rail.update(rail.time+.1);
    b.metro.update(rail.time);
    const stop=rail.stopInfo();
    if (stop.docked && stop.doors && stop.station.id!==visited.at(-1)) visited.push(stop.station.id);
    assert.equal(p.x,cabin);
  }
  assert.deepEqual(visited,['G-W','G-E','B-E','B-W','G-W']);
  assert.equal(b.paint.get(p.x,p.z,rail.line.cabinLayer),1);
  p.z=rail.line.doorSide*.78;
  b.move(p,0,rail.line.doorSide*2,.08,false,false);
  assert.equal(zoneOf(p.x),0);
  assert.equal(p.yaw,command.yaw);
  assert.equal(b.world.floor(p.x,p.z).y,RAIL.platformY);
  assert(b.world.stand(p.x,p.z,.4));
  assert((p.doorReady??0)>rail.time,'exiting cannot bounce immediately back aboard');
  for (const section of [1,0]) {
    rail.setSection(section);rail.dock(-1);rail.update(rail.time+.9);
    const line=rail.line;
    Object.assign(p,{x:line.center-line.x+door,y:line.platformY,z:line.z+line.doorSide*2.4,doorReady:0,vy:0});
    b.move(p,0,-line.doorSide*3,.1,false,false);
    assert.equal(zoneOf(p.x),3);
    rail.update(rail.time+.8);
    p.z=line.doorSide*.78;
    b.move(p,0,line.doorSide*2,.08,false,false);
    assert.equal(zoneOf(p.x),section);
    assert.equal(b.world.floor(p.x,p.z).y,line.platformY);
  }
});

test('jumping preserves primary fire, including an aerial roller flick and a released charge',()=>{
  for (const weapon of WEAPONS) {
    const b=new RoomEngine({...options,weapon:weapon.id}).battle,p=b.player;
    Object.assign(p,{x:-44,y:0,z:3,vy:0,yaw:Math.PI/2,pitch:0,fire:0,swimming:false,rollHold:.4});
    const input={x:0,z:0,yaw:p.yaw,pitch:0,jump:true,fire:true,press:true};
    const camera=()=>({eye:[p.x-3,p.y+2,p.z],target:[p.x+20,p.y+1,p.z]});
    for(let n=0;n<8;n++) {
      p.fire-=1/60;b.control(p,input,1/60,camera);
      input.jump=input.press=false;
    }
    assert(p.airborne && p.y>0,weapon.id+' is in the air');
    if (weapon.charge) {input.fire=false;b.control(p,input,1/60,camera);}
    assert(weapon.blast || b.shots.length>=weapon.pellets,weapon.id+' fires during the jump');
    assert(p.tank<p.tankMax,weapon.id+' pays for its airborne shot');
    if (weapon.roller) assert(!p.rolling && p.rollHold===0);
  }
});

test('ink readout matches actual costs and updates capacity, shots remaining and low ink',()=>{
  for (const weapon of WEAPONS) for (const tankMax of [BASE_TANK,GIGA_TANK]) {
    const actor={tank:tankMax,tankMax,weapon},readout=inkReadout(actor);
    const remaining=Number(readout.remaining.match(/\d+/)[0]);
    assert(remaining*weapon.cost<=tankMax+1e-7 && (remaining+1)*weapon.cost>tankMax);
    assert(Math.abs(readout.ratio-readout.after-weapon.cost/tankMax)<1e-8);
    assert(readout.usage.includes(String(Number(weapon.cost.toFixed(4)))));
    const empty=inkReadout({...actor,tank:weapon.cost-.01});
    assert(empty.empty && empty.low && empty.remaining.startsWith('あと0'));
  }
});

test('older saved ink is remapped into the larger field without moving its world position or losing mass',()=>{
  const engine=new RoomEngine(options),stored=engine.checkpoint();
  stored.game.version=2;delete stored.game.field;
  stored.game.metro.train.x=-38.8;
  const {width:w,height:h}=INK_SIZE,bx=56,bz=38.2;
  const ix=Math.floor((-44/bx+1)*.5*w),iz=Math.floor((3/bz+1)*.5*h),cell=iz*w+ix;
  const film=new ArrayBuffer(8),data=new DataView(film);
  data.setUint32(0,cell,true);data.setUint16(4,Math.round(.036*65535/.105),true);
  for(let layer=0;layer<7;layer++) stored['ink'+layer]=layer===0?film:new ArrayBuffer(0);
  const b=new RoomEngine(options,new Map(Object.entries(stored))).battle;
  const x=((ix+.5)/w*2-1)*bx,z=((iz+.5)/h*2-1)*bz;
  assert.equal(b.paint.get(x,z,0),1);
  const mass=b.paint.cyan.reduce((sum,v)=>sum+v,0)*b.paint.cellArea;
  assert(Math.abs(mass-.036*4*bx*bz/(w*h))<.000001);
  assert.equal(b.metro.train.x,-METRO.x);
});

test('the cabin door collision follows opening on either current platform side',()=>{
  const b=new RoomEngine(options).battle,rail=b.transit,door=TRAIN_DOORS[0];
  for(const section of [0,1]) {
    rail.setSection(section);
    const x=rail.line.cabinX+door, side=rail.line.doorSide;
    const from=[x,CABIN_Y+1.60,0],to=[x,CABIN_Y+1.60,side*2.15];
    rail.train.doorOpen=0;
    assert(b.traceShot(from,to,true));
    rail.train.doorOpen=1;
    assert.equal(b.traceShot(from,to,true),null);
  }
});

test('a grazing projectile can hit without widening focus detection or steering the shot',()=>{
  const b=new RoomEngine({...options,weapon:'jet'}).battle, p=b.player, target=b.actors[4];
  Object.assign(target,{x:0,y:11.95,z:0,yaw:Math.PI/2,shield:0,down:0,swimming:false});
  let edge=.3;
  while (b.bodyHit([-2,13,edge],[2,13,edge],target)!==null) edge+=.01;
  const start=[-2,13,edge], dir=[1,0,0], end=[2,13,edge];
  assert.equal(b.bodyHit(start,end,target),null);
  assert.equal(b.focusTarget(start,dir,p.team,4),null);
  assert(b.bodyHit(start,end,target,.088)!==null);
  assert.equal(b.bodyHit([-2,13,.92],[2,13,.92],target,.115),null);
  b.shots.push({pos:start,vel:[96,0,0],actor:p,weapon:p.weapon,power:1,age:0,bend:null});
  const before=target.hp;
  b.updateShots(1/24);
  assert(target.hp<before);
  assert.equal(b.shots.length,0);
  assert.equal(b.inkImpacts.length,1);
  const impact=b.inkImpacts[0];
  assert(impact.p[0]>start[0] && impact.p[0]<end[0] && impact.p[2]===start[2]);
  assert.equal(impact.target,target);

  b.shots.push({pos:[16,.75,-16],vel:[60,0,0],actor:p,weapon:p.weapon,power:1,age:0});
  b.clock+=.1;
  b.updateShots(1/24);
  assert.equal(b.shots.length,0);
  assert.equal(b.inkImpacts.filter(impact=>impact.target===target).length,1);
  assert(b.inkImpacts.some(impact=>impact.normal));
  b.clock+=INK_HIT_DURATION;
  b.updateShots(1/24);
  assert.equal(b.inkImpacts.length,0);
});

test('running directions, jumps, landings and wall swimming have distinct articulated poses',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  const base={...p,yaw:Math.PI/2,vx:0,vz:0,vy:0,steps:1.1,airborne:false,landing:0};
  const presets=[{}, {vx:5.5},{vx:-5.5},{vz:5.5},{airborne:true,vy:5.2},{airborne:true,vy:-5.2},{landing:1},
    {swimming:true,vx:3}, {swimming:true,inkSwimming:true,vx:9}, {swimming:true,inkSwimming:true,climbing:true,climbNormal:[-1,0,0]}];
  const poses=presets.map(preset=>collectShapes(renderer=>drawCrew(renderer,{...base,...preset},1,false))
    .map(shape=>[...shape.p,...shape.span]));
  for (const pose of poses) assert(pose.length>5 && pose.every(part=>part.every(Number.isFinite)));
  assert.equal(new Set(poses.map(pose=>JSON.stringify(pose))).size,presets.length);
});

test('NPC travel estimates use live timetables and avoid a failed train',()=>{
  const b=new RoomEngine(options).battle, actor=b.actors[2];
  for (const [i,rail] of [b.transit,b.metro].entries()) {
    const line=rail.line;
    rail.update(line.dwell-1.85);
    const side=i===0?-1:1;
    rail.dock(side);
    rail.train.wait=1.85;
    Object.assign(actor,{x:line.center+side*line.x,y:line.platformY,z:line.platformZ,down:0,doorReady:0});
    const goal={x:line.center-side*line.x,z:line.platformZ};
    assert(Number.isFinite(trainArrival(rail,side,rail.time)));
    const plan=b.tactics.trip(actor,goal);
    assert(plan?.steps.some(step=>step.kind==='train' && step.level===i));
    rail.derail('test');
    assert.equal(trainArrival(rail,side,rail.time),Infinity);
    const detour=b.tactics.trip(actor,goal);
    assert(!detour?.steps.some(step=>step.kind==='train' && step.level===i));
  }
});

test('fullscreen requests happen immediately, with a landscape and browser fallback',async()=>{
  const calls=[];
  const doc={exitFullscreen(){calls.push('exit');doc.fullscreenElement=null;}};
  const target={requestFullscreen(config){calls.push(config.navigationUI);doc.fullscreenElement=this;}};
  const orientation={async lock(value){calls.push(value);throw Error('manual rotation');}};
  const pending=setFullscreen(target,{doc,landscape:true,orientation});
  assert.deepEqual(calls,['hide']);
  assert.equal(await pending,'active');
  assert.deepEqual(calls,['hide','landscape']);
  assert.equal(await setFullscreen(target,{doc,orientation,toggle:true}),'exited');
  assert.equal(await setFullscreen({},{doc,orientation}),'blocked');
  doc.fullscreenEnabled=doc.webkitFullscreenEnabled=false;
  const forbidden={requestFullscreen(){calls.push('denied standard');},webkitRequestFullscreen(){calls.push('denied legacy');}};
  assert.equal(await setFullscreen(forbidden,{doc,orientation}),'blocked');
  assert.deepEqual(calls,['hide','landscape','exit']);
});

test('a rapid orientation pause clears charged fire and queued actions on the server',()=>{
  const engine=new RoomEngine({...options,weapon:'charge'}), b=engine.battle, p=b.player;
  b.countdown=0;
  for (const a of b.actors) if (a!==p) a.down=99;
  for (let i=0;i<7;i++) submit(engine,i+1,1000+i*50,{fire:true});
  assert(p.charge>0);
  p.jumpBuffer=p.shotBuffer=.11;
  const tank=p.tank, elapsed=b.elapsed;
  const paused=submit(engine,8,1302,{paused:true});
  assert(paused.checkpoint);
  assert.equal(frame(paused.frames).elapsed,Math.round(elapsed*100)/100);
  assert.deepEqual([p.charge,p.jumpBuffer,p.shotBuffer],[0,0,0]);
  submit(engine,9,3200);
  submit(engine,10,3250);
  assert.equal(p.tank,tank);
  assert.equal(b.elapsed,elapsed+1/24);
  assert(!b.shots.some(shot=>shot.actor===p));
});

test('multitouch keeps independent actions with one aim pointer and clean capture handoffs',()=>{
  class Surface extends EventTarget {
    constructor(left,top,width,height) {
      super();
      this.rect={left,top,width,height};
      this.captured=new Set();
      const classes=new Set();
      this.classList={add:key=>classes.add(key),remove:key=>classes.delete(key)};
      this.style={};
      this.firstElementChild={style:{}};
    }
    getBoundingClientRect() {return this.rect;}
    setPointerCapture(id) {this.captured.add(id);}
    hasPointerCapture(id) {return this.captured.has(id);}
    releasePointerCapture(id) {
      this.captured.delete(id);
      this.pointer('lostpointercapture',id,0,0);
    }
    pointer(type,id,x,y) {
      const event=Object.assign(new Event(type,{cancelable:true}),{pointerId:id,pointerType:'touch',button:0,clientX:x,clientY:y});
      this.dispatchEvent(event);
    }
  }
  const arena=new Surface(0,0,844,390), stick=new Surface(24,277,86,86);
  const fire=new Surface(742,278,90,90), swim=new Surface(672,307,61,61), jump=new Surface(750,194,69,69);
  const aims=[];
  let shots=0,jumps=0;
  const touch=new TouchControls(arena,stick,{fire,swim,jump},{
    enabled:()=>true,aim:(x,y)=>aims.push([x,y]),press:()=>shots++,jump:()=>jumps++
  });
  stick.pointer('pointerdown',1,67,320);
  stick.pointer('pointermove',1,68,300);
  fire.pointer('pointerdown',2,780,328);
  swim.pointer('pointerdown',3,695,337);
  jump.pointer('pointerdown',4,779,227);
  assert(touch.z>0 && touch.fire && touch.swim);
  assert.deepEqual([shots,jumps],[1,1]);
  jump.pointer('pointerup',4,779,227);
  jump.releasePointerCapture(4);
  assert(touch.fire,'releasing jump must keep the held fire contact');
  fire.pointer('pointermove',2,787,324);
  swim.pointer('pointermove',3,706,349);
  assert.deepEqual(aims,[[7,-4]]);
  arena.pointer('pointerdown',5,530,195);
  arena.pointer('pointermove',5,543,187);
  fire.pointer('pointermove',2,795,325);
  arena.releasePointerCapture(5);
  fire.pointer('pointermove',2,799,329);
  fire.releasePointerCapture(2);
  swim.pointer('pointermove',3,710,346);
  assert.deepEqual(aims,[[7,-4],[13,-8],[4,4],[4,-3]]);
  assert(!touch.fire && touch.swim);
  touch.clear();
  assert(!touch.fire && !touch.swim && !touch.x && !touch.z);
  assert([arena,stick,fire,swim,jump].every(surface=>surface.captured.size===0));
});

test('a raider firing タコNZ4 launches finite rounds that can hit an opponent',()=>{
  const b=new RoomEngine(options).battle, enemy=b.actors[4];
  b.raiders.spawn();
  const raider=b.raiders.members[0];
  for (const a of b.actors) if (a!==enemy) a.down=10;
  for (const a of b.raiders.members) if (a!==raider) a.active=false;
  Object.assign(raider,{x:10,y:0,z:-16,yaw:Math.PI/2,pitch:0,fire:0});
  Object.assign(enemy,{x:15,y:0,z:-16,yaw:-Math.PI/2,shield:0});
  assert(b.shoot(raider,[enemy.x,1.10,enemy.z]));
  assert.equal(b.shots.length,1);
  assert(b.shots[0].vel.every(Number.isFinite));
  for (let i=0;i<24;i++) b.updateShots(1/120);
  assert(enemy.hp<100);
});

test('raiders in combat and on a route respect the train hull and fall under gravity',()=>{
  const b=new RoomEngine(options).battle, rail=b.transit;
  b.raiders.spawn();
  const a=b.raiders.members[0], line=rail.line;
  const edge={x:line.center+rail.train.x,y:line.y+.95,z:line.z-2.3,vy:0};
  Object.assign(a,edge);
  assert(!rail.blocksActor(a) && rail.blocksActor({...a,z:a.z+.18}));
  assert(!b.world.blocked(a.x,a.y,a.z+.18,a.radius,a.height));
  b.raiders.move(a,Math.PI,3,.06);
  assert.equal(a.z,edge.z);
  Object.assign(a,edge);
  b.steer(a,{x:a.x,z:a.z+2},.06,3);
  assert.equal(a.z,edge.z);
  Object.assign(a,{x:10,y:3,z:-16,vy:0});
  b.raiders.move(a,Math.PI/2,3,1/24);
  assert(a.y<3 && a.y>2.9 && a.airborne);
});

test('スーパーチャクチ stays beneath the cabin roof and begins at the real takeoff height',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  const weapon=WEAPONS.find(w=>w.special==='slam');
  Object.assign(p,{x:CABIN_X,y:CABIN_Y+.21,z:0,weapon,superCharge:100});
  const floor=b.world.floor(p.x,p.z).y;
  const roof=b.traceShot([p.x,p.y+1.7,p.z],[p.x,p.y+4.4,p.z],true).position[1];
  const start=p.y;
  assert(b.abilities.activate(p));
  b.abilities.updateActor(p,1/60);
  assert(p.y>=start-.02);
  for (let i=0;i<51;i++) {
    b.abilities.updateActor(p,1/60);
    assert(p.y+1.72<roof);
  }
  assert.equal(p.y,floor);
  assert.equal(p.slam,null);
  assert.equal(b.paint.get(p.x,p.z,CABIN_LAYER),p.team+1);
});

test('cold restore keeps an active drone, its pilot, and the same cooldown',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2});
  b.clock=8;
  assert(b.abilities.summon(p));
  const {until}=p.drone, ready=p.droneReady;
  b.clock+=1;
  b.abilities.update(.12);
  const replay=new RoomEngine(options,new Map(Object.entries(structuredClone(engine.checkpoint())))).battle;
  const owner=replay.player, drone=replay.abilities.drones[0];
  assert(drone && drone.owner===owner && owner.drone===drone);
  assert.deepEqual([drone.x,drone.y,drone.z,drone.until,owner.droneReady],[p.drone.x,p.drone.y,p.drone.z,until,ready]);
  assert(!replay.abilities.summon(owner));
  replay.clock=until;
  replay.abilities.update(1/24);
  assert.equal(owner.drone,null);
  assert.equal(replay.abilities.drones.length,0);
  assert(!replay.abilities.summon(owner));
});

test('raider tentacles stop at the thin railing and still hit in a clear lane',()=>{
  const b=new RoomEngine(options).battle, target=b.player;
  b.raiders.spawn();
  const a=b.raiders.members[0];
  for (const actor of b.actors) if (actor!==target) actor.down=99;
  const attack={giant:false,yaw:Math.PI/2};
  Object.assign(a,{x:-11.5925,y:-.01,z:-2.65});
  Object.assign(target,{x:-9.7075,y:.33,z:-2.65,shield:0});
  b.raiders.resolve(a,attack);
  assert.equal(target.hp,100);
  Object.assign(a,{x:10,y:0,z:-16});
  Object.assign(target,{x:15,y:0,z:-16});
  b.raiders.resolve(a,attack);
  assert(target.hp<100);
});

test('train ETA accounts for acceleration and braking from the first departure frame',()=>{
  const b=new RoomEngine(options).battle, rail=b.transit;
  while (rail.train.stop) rail.update(rail.time+.05);
  const start=rail.time, announced=[];
  for (let i=0;i<10;i++) {
    rail.update(rail.time+.1);
    announced.push(rail.stopInfo().seconds);
  }
  while (!rail.train.stop && rail.time<start+20) rail.update(rail.time+.05);
  assert.equal(rail.train.stop,1);
  const duration=rail.time-start;
  for (const [i,eta] of announced.entries()) {
    assert(Math.abs(eta-(duration-(i+1)*.1))<=1.05,[eta,duration,i].join(' / '));
    if (i>0) assert(eta<=announced[i-1]);
  }
});

test('a delayed train occupies its track until through service can enter safely',()=>{
  const b=new RoomEngine(options).battle, held=b.transit, arriving=b.metro;
  held.dock(1);
  held.train.wait=60;
  arriving.setSection(0);
  arriving.connection={from:1,to:0,side:1,age:CONNECTION_TIME-6.5};
  Object.assign(arriving.train,{phase:'connector',stop:0});
  const tick=dt=>{
    const now=held.time+dt;
    held.update(now);
    arriving.update(now);
  };
  for (let i=0;i<150;i++) tick(.05);
  assert(!arriving.visibleIn(0));
  assert.equal(arriving.stopInfo().status,'信号待ち');
  assert.equal(arriving.stopInfo().seconds,null);
  assert.equal(arriving.train.speed,0);
  held.train.wait=.01;
  let stop=false;
  for (let i=0;i<400 && !stop;i++) {
    tick(.05);
    assert(!(held.visibleIn(0) && arriving.visibleIn(0)));
    stop=arriving.stopInfo().docked;
  }
  assert(stop && arriving.stopInfo().station.id==='G-E');
});

test('an enemy ink curtain blocks the beam and takes damage while allied beams pass',()=>{
  const b=new RoomEngine(options).battle, p=b.player, target=b.actors[4];
  for (const a of b.actors) if (a!==p && a!==target) a.down=10;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,pitch:0});
  Object.assign(target,{x:15,y:0,z:-16,yaw:-Math.PI/2,shield:0});
  b.playerAim={position:[target.x,1.12,target.z]};
  const screen={id:'curtain',p:[12.5,.17,-16],yaw:Math.PI/2,halfWidth:2,height:1.95,hp:108,until:5,owner:target};
  b.subweapons.items.push(screen);
  b.abilities.advanced.launch(p,'beam');
  b.abilities.advanced.update(.7);
  assert(screen.hp<108 && target.hp===100);
  assert(Math.abs(b.abilities.advanced.effects[0].b[0]-screen.p[0])<.001);
  screen.owner=p;
  b.abilities.advanced.update(.17);
  assert(target.hp<100);
});

test('jumping disables deployable subweapons and still allows a thrown bomb',()=>{
  const b=new RoomEngine(options).battle, p=b.player;
  Object.assign(p,{x:10,y:1,z:-16,yaw:Math.PI/2,airborne:true,subId:'timed',tank:BASE_TANK});
  assert.equal(b.subweapons.canUse(p),false);
  assert.equal(b.subweapons.use(p),false);
  assert.equal(p.tank,BASE_TANK);
  p.subId='throw';
  assert(b.subweapons.canUse(p) && b.subweapons.use(p));
  assert.equal(p.tank,BASE_TANK-SUBWEAPONS[0].cost);
  Object.assign(p,{y:0,airborne:false,subId:'timed',subReady:0});
  assert(b.subweapons.canUse(p) && b.subweapons.use(p));
});

test('ordered input arriving in a burst retains one-shot actions without accelerating the room',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player;
  b.countdown=0;
  for (const a of b.actors) if (a!==p) a.down=99;
  Object.assign(p,{x:10,y:0,z:-16,vy:0,fire:0,tank:BASE_TANK});
  submit(engine,1,1000);
  submit(engine,2,1002,{jump:true,press:true});
  for (let i=3;i<=46;i++) submit(engine,i,1004);
  assert.equal(engine.violations,0);
  assert.equal(b.elapsed,0);
  submit(engine,47,1050);
  assert.equal(b.elapsed,1/24);
  assert(p.vy>0 && p.tank<BASE_TANK && b.shots.some(s=>s.actor===p));
});

test('a released joystick does not carry movement across a pause',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player;
  b.countdown=0;
  for (const a of b.actors) if (a!==p) a.down=99;
  Object.assign(p,{x:10,y:0,z:-16,vy:0});
  for (let i=0;i<6;i++) submit(engine,i+1,1000+i*50,{z:1});
  assert(p.x>10 && p.driveX>3);
  const before=[p.x,p.z];
  submit(engine,7,1252,{paused:true});
  submit(engine,8,2000);
  submit(engine,9,2050);
  assert.deepEqual([p.x,p.z],before);
});

test('touch release outside the action still clears fire if pointer capture fails',()=>{
  const classList={add(){},remove(){}}, doc=new EventTarget();
  const arena=Object.assign(new EventTarget(),{ownerDocument:doc});
  const stick=new EventTarget();
  const fire=Object.assign(new EventTarget(),{classList,contains:node=>node===fire,
    setPointerCapture(){throw new DOMException('Pointer already ended','NotFoundError');}});
  let presses=0;
  const moves=[];
  const touch=new TouchControls(arena,stick,{fire},{enabled:()=>true,aim:(x,y)=>moves.push([x,y]),press:()=>presses++,jump(){}});
  const pointer=(type,x)=>Object.assign(new Event(type,{cancelable:true}),
    {pointerId:42,pointerType:'touch',clientX:x,clientY:24});
  fire.dispatchEvent(pointer('pointerdown',20));
  assert(touch.fire);
  doc.dispatchEvent(pointer('pointermove',30));
  doc.dispatchEvent(pointer('pointerup',32));
  assert.equal(presses,1);
  assert.deepEqual(moves,[[10,0]]);
  assert(!touch.fire && !touch.contacts.size);
});

test('a failed shadow or reflection buffer leaves the base WebGL frame running',()=>{
  const savedDpr=globalThis.devicePixelRatio;
  globalThis.devicePixelRatio=1;
  try {
    for (const checks of [[0],[1,0]]) {
      let statusCount=0;
      const passes=[], bindings=[];
      const gl=new Proxy({
        FRAMEBUFFER_COMPLETE:1,createTexture:()=>({}),createFramebuffer:()=>({}),createRenderbuffer:()=>({}),
        checkFramebufferStatus:()=>checks[statusCount++],bindFramebuffer:(_target,buffer)=>bindings.push(buffer)
      },{get:(mock,key)=>mock[key]??(/^[A-Z0-9_]+$/.test(key)?key:()=>{})});
      const ink={w:8,h:8,layers:7,dirtyMask:0};
      const renderer=Object.assign(Object.create(Renderer.prototype),{gl,batches:{},inkSource:ink,
        canvas:{clientWidth:800,clientHeight:360},renderLimit:4096,pass:(...args)=>passes.push(args.at(-1))});
      const camera={eye:[0,2,4],target:[0,1,0]};
      renderer.draw(camera,ink,1);
      renderer.draw(camera,ink,2);
      assert.equal(statusCount,checks.length);
      assert.deepEqual(passes,[false,false]);
      assert.equal(bindings.at(-1),null);
      assert.equal(renderer.effects,false);
      assert.equal(renderer.shadowBuffer,null);
    }
  } finally {
    if (savedDpr===undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio=savedDpr;
  }
});

test('each stair landing is counted once and ink can flow across both ways',()=>{
  const engine=new RoomEngine(options), b=engine.battle, paint=b.paint;
  for (const stair of STAIRS) for (const offset of [-.24,.24]) {
    const upper=stairPoint(stair,0,STAIR_SEAM+offset), lower=stairPoint(stair,1,STAIR_SEAM+offset);
    const indexes=[paint.index(upper.x,upper.z,0),paint.index(lower.x,lower.z,2)];
    assert.equal(paint.mask[indexes[0]]+paint.mask[indexes[1]],1,stair.name);
    assert.equal(paint.surfaceIndex(upper.x,upper.z,0),paint.surfaceIndex(lower.x,lower.z,2));
  }
  const [left,right]=paint.stairEdges.entries().next().value;
  for (const [from,to] of [[left,right],[right,left]]) {
    paint.reset();
    const a=paint.surface[from], c=paint.surface[to];
    paint.cyan[a]=.07;
    paint.publish(a);
    paint.wake(from);
    paint.tick();
    assert(paint.cyan[c]>.001);
    assert(Math.abs(paint.cyan.reduce((sum,depth)=>sum+depth,0)-.07)<1e-7);
  }
  paint.reset();
  const old=stairPoint(STAIRS[0],1,STAIR_SEAM-.26);
  const legacy=paint.index(old.x,old.z,2);
  assert.equal(paint.mask[legacy],0);
  paint.cyan[legacy]=.032;
  const restored=new RoomEngine(options,new Map(Object.entries(structuredClone(engine.checkpoint())))).battle.paint;
  const physical=stairPoint(STAIRS[0],0,STAIR_SEAM-.26);
  assert(Math.abs(restored.depthAt(physical.x,physical.z,0)-.032)<.00001);
});

test('wet droplets stop at station roofs before staining the platform below',()=>{
  const b=new RoomEngine(options).battle, x=-49.4,z=-26;
  const floor=b.world.floor(x,z), roof=b.traceShot([x,floor.y+6,z],[x,floor.y+.05,z],true,false);
  assert(roof && roof.layer===undefined);
  const drip=(x,y,z)=>b.drops.push({p:[x,y,z],v:[0,-7,0],life:1,max:1,wet:.05,team:0,size:.22});
  drip(x,roof.position[1]+.65,z);
  drip(10,1,-16);
  for (let i=0;i<20;i++) b.updateShots(1/24);
  assert.equal(b.drops.length,0);
  assert.equal(b.paint.get(x,z,floor.layer),0);
  assert.equal(b.paint.get(10,-16,0),1);
});

test('ink from a KO lands on the occupied prop without awarding ground turf below',()=>{
  const b=new RoomEngine(options).battle, p=b.player,target=b.actors[4], x=-49.4,z=-26;
  const floor=b.world.floor(x,z), roof=b.traceShot([x,floor.y+6,z],[x,floor.y+.05,z],true,false);
  Object.assign(target,{x,y:roof.position[1],z,hp:5,shield:0});
  assert.equal(b.damage(target,90,p,[x,target.y+1,z]),5);
  assert.equal(b.paint.get(x,z,floor.layer),0);
  assert.equal(p.painted,0);
  assert.equal(b.decals.at(-1).shape,roof.shape.id);
  assert(b.decals.at(-1).p[1]>floor.y+2);
});

test('a tentacle hit cannot knock a crew member into a closed train',()=>{
  const b=new RoomEngine(options).battle, target=b.actors[4], rail=b.transit,line=rail.line;
  b.raiders.spawn();
  const a=b.raiders.members[0], z=line.z-2.3;
  Object.assign(target,{x:line.center+rail.train.x,y:line.y+.95,z,shield:0});
  Object.assign(a,{x:target.x,y:target.y,z:z-2.4});
  assert(!rail.blocksActor(target) && rail.blocksActor({...target,z:z+.65}));
  b.raiders.resolve(a,{giant:false,yaw:Math.PI});
  assert(target.hp<100);
  assert.equal(target.z,z);
  assert(!rail.blocksActor(target));
});

test('boss strikes respect thin cover between the warning area and a player',()=>{
  const b=new RoomEngine({...options,mode:'play'}).battle, p=b.player, boss=b.boss;
  for (const actor of b.actors) if (actor!==p) actor.down=99;
  Object.assign(p,{x:-11.8,y:b.world.floor(-11.8,-2.4).y,z:-2.4,shield:0});
  Object.assign(boss,{active:true,spawned:true,next:Infinity});
  boss.attack(-14.2,-4.2,4.1,1,105);
  b.clock=1.1;
  boss.update(1/24);
  assert.equal(p.hp,100);
  Object.assign(p,{x:15,y:0,z:-16});
  boss.attack(12,-16,4.1,1,105);
  b.clock=2.2;
  boss.update(1/24);
  assert(p.hp<100);
});

test('manual focus disappears behind an enemy ink curtain and returns behind an allied one',()=>{
  const b=new RoomEngine(options).battle, p=b.player,target=b.actors[4];
  for (const a of b.actors) if (a!==p && a!==target) a.down=99;
  Object.assign(target,{x:15,y:0,z:-16,yaw:-Math.PI/2,shield:0});
  const eye=[10,1.1,-16], dir=[1,0,0];
  assert.equal(b.focusTarget(eye,dir,p.team,12)?.actor,target);
  const screen={id:'curtain',p:[12.5,.17,-16],yaw:Math.PI/2,halfWidth:2,height:1.95,hp:108,until:5,owner:target};
  b.subweapons.items.push(screen);
  assert.equal(b.focusTarget(eye,dir,p.team,12),null);
  screen.owner=p;
  assert.equal(b.focusTarget(eye,dir,p.team,12)?.actor,target);
});

test('a cold room restore resumes in-flight projectiles with their owner and damage',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player,target=b.actors[4];
  for (const a of b.actors) if (a!==p && a!==target) a.down=99;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,pitch:0,fire:0});
  Object.assign(target,{x:15,y:0,z:-16,yaw:-Math.PI/2,shield:0});
  assert(b.shoot(p,[target.x,1.1,target.z]));
  b.updateShots(1/120);
  const old=b.shots[0], r=new RoomEngine(options,new Map(Object.entries(structuredClone(engine.checkpoint())))).battle;
  const shot=r.shots[0];
  assert(shot && shot.actor===r.player && shot.weapon===r.player.weapon);
  assert.deepEqual([shot.id,shot.age,shot.pos,shot.vel],[old.id,old.age,old.pos,old.vel]);
  for (let i=0;i<20;i++) r.updateShots(1/120);
  assert(r.actors[4].hp<100 && !r.shots.length);
});

test('cold restore continues advanced specials with their original hit history',()=>{
  const weapon=WEAPONS.find(w=>w.special==='beam');
  const config={...options,weapon:weapon.id}, engine=new RoomEngine(config), b=engine.battle, p=b.player,target=b.actors[4];
  for (const a of b.actors) if (a!==p && a!==target) a.down=99;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,pitch:0,superCharge:100});
  Object.assign(target,{x:15,y:0,z:-16,shield:0,yaw:-Math.PI/2});
  b.playerAim={position:[target.x,1.1,target.z]};
  assert(b.abilities.activate(p));
  const advanced=b.abilities.advanced, beam=advanced.effects[0];
  advanced.update(.71);
  assert(beam.damage.get(target)>0);
  advanced.launch(b.actors[0],'wave');
  advanced.effects[1].hit.add(target);
  advanced.launch(p,'vortex');
  const r=new RoomEngine(config,new Map(Object.entries(structuredClone(engine.checkpoint())))).battle;
  const [resumed,wave,vortex]=r.abilities.advanced.effects, enemy=r.actors[4];
  assert(r.player.beaming && resumed.actor===r.player && resumed.age===beam.age);
  assert.equal(resumed.damage.get(enemy),beam.damage.get(target));
  assert(wave.hit.has(enemy) && vortex.id==='vortex');
  r.playerAim={position:[enemy.x,1.1,enemy.z]};
  const hp=enemy.hp;
  r.abilities.advanced.update(.17);
  assert(enemy.hp<hp);
});

test('resuming after a long Cloudflare pause sends input on the healthy socket',()=>{
  const sent=[],closed=[], now=performance.now();
  const socket={readyState:WebSocket.OPEN,bufferedAmount:0,send:data=>sent.push(JSON.parse(data)),close:code=>closed.push(code)};
  const client=Object.assign(Object.create(RemoteMatch.prototype),{
    socket,seq:0,paused:true,pauseSent:true,received:now-12000,lastPauseSentAt:now-12000,pending:{}
  });
  client.input({...command,press:true},false);
  client.flush();
  assert.equal(sent.length,1);
  assert(sent[0].press && !sent[0].paused);
  assert.deepEqual(closed,[]);
  client.received-=8000;
  client.input(command,false);
  client.flush();
  assert.deepEqual(closed,[4002]);
});

test('NPCs select a clear opponent when a nearer swimmer is hidden by a railing',()=>{
  const b=new RoomEngine(options).battle, bot=b.actors[0], hidden=b.actors[4], clear=b.actors[5];
  for (const a of b.actors) if (![bot,hidden,clear].includes(a)) a.down=99;
  Object.assign(bot,{x:-14.2,y:0,z:-4.2,yaw:1.85});
  Object.assign(hidden,{x:-11.8,y:b.world.floor(-11.8,-2.4).y,z:-2.4,swimming:true,shield:0});
  Object.assign(clear,{x:-14.2,y:0,z:-8.2,shield:0});
  assert(b.traceShot([bot.x,bot.y+1.39,bot.z],[hidden.x,hidden.y+.37,hidden.z],true));
  assert.equal(b.enemyFor(bot),clear);
});

test('emergency train evacuation cancels attacks that were winding up inside the cabin',()=>{
  const b=new RoomEngine(options).battle,p=b.player,rail=b.metro;
  b.raiders.spawn();
  const raider=b.raiders.members[0];
  Object.assign(raider,{x:CABIN_X,y:CABIN_Y,z:0,attack:{yaw:Math.PI/2,at:.2,end:.6,giant:false,hit:false},target:p});
  Object.assign(p,{x:CABIN_X-3,y:CABIN_Y,z:0,weapon:WEAPONS.find(w=>w.special==='slam'),superCharge:100});
  assert(b.abilities.activate(p));
  rail.damage(10000);
  assert(b.carryTransit(raider,1/24) && b.carryTransit(p,1/24));
  assert.equal(zoneOf(raider.x),1);
  assert.equal(zoneOf(p.x),1);
  assert.equal(raider.attack,null);
  assert.equal(p.slam,null);
  assert.equal(b.abilities.updateActor(p,1/24),false);
  assert.equal(p.y,b.world.floor(p.x,p.z).y);
});

test('a moving roller paints through the physical stair joint in both directions',()=>{
  const b=new RoomEngine(options).battle,p=b.player,stair=STAIRS[0];
  p.weapon=WEAPONS.find(w=>w.roller);
  for (const level of [0,1]) {
    b.paint.reset();
    const here=stairPoint(stair,level,STAIR_SEAM+(level?.14:-.14));
    Object.assign(p,here,{y:b.world.floor(here.x,here.z).y,vx:level?-3:3,yaw:level?-Math.PI/2:Math.PI/2,fire:0});
    const tank=p.tank;
    assert(b.roll(p));
    assert.equal(p.tank,tank-p.weapon.cost);
    const next=stairPoint(stair,1-level,STAIR_SEAM+(level?-.7:.7));
    assert.equal(b.paint.get(next.x,next.z,b.world.floor(next.x,next.z).layer),p.team+1);
  }
});

test('a falling raider continues to fall through a tentacle windup',()=>{
  const b=new RoomEngine(options).battle;
  b.raiders.spawn();
  const a=b.raiders.members[0], attack={from:0,at:.56,end:.85,giant:false,yaw:0,hit:false};
  Object.assign(a,{x:10,y:2.1,z:-16,vy:-1,airborne:true,attack});
  b.clock=.1;
  b.raiders.update(1/24);
  assert.equal(a.attack,attack);
  assert(a.y<2.1 && a.vy< -1);
  assert.deepEqual([a.x,a.z],[10,-16]);
});

test('a trap detects an opponent across the walkable seam of a staircase',()=>{
  const b=new RoomEngine(options).battle,p=b.player,target=b.actors[4],stair=STAIRS[0];
  for (const a of b.actors) if (a!==p && a!==target) a.down=99;
  const site=stairPoint(stair,0,STAIR_SEAM-.99), enemy=stairPoint(stair,1,STAIR_SEAM+.26);
  Object.assign(p,site,{y:b.world.floor(site.x,site.z).y,subId:'trap',yaw:Math.PI/2});
  Object.assign(target,enemy,{y:b.world.floor(enemy.x,enemy.z).y,shield:0});
  assert(b.subweapons.use(p));
  const trap=b.subweapons.items[0];
  b.clock=.81;
  b.subweapons.update(1/24);
  assert.equal(trap.triggered,true);
  b.clock=1.05;
  b.subweapons.update(1/24);
  assert(target.hp<100);
});

test('the final partial tick resolves arrivals before the horn and stops later projectiles',()=>{
  const b=new RoomEngine({...options,mode:'play',teamSize:4}).battle, p=b.player;
  for (const a of b.actors) if (a!==p) a.down=99;
  Object.assign(b,{clock:422.975,elapsed:419.975,left:.025,countdown:0});
  b.transit.time=b.metro.time=b.elapsed;
  for (const [id,y] of [[1,.14],[2,.65]]) {
    b.shots.push({id,pos:[10,y,-16],vel:[0,-10,0],age:.1,actor:p,weapon:p.weapon,power:1});
  }
  b.update(.10,command,()=>crewView(b,p));
  assert(b.finished && b.left===0);
  assert(Math.abs(b.clock-423)<1e-8);
  assert.equal(b.paint.get(10,-16,0),1);
  assert.deepEqual(b.shots.map(shot=>shot.id),[2]);
});

test('a one-cell win shows distinct percentages in the result dialog',()=>{
  const main=readFileSync(new URL('../dist/main.js',import.meta.url),'utf8');
  const source=main.slice(main.indexOf('function finish()'),main.indexOf('function resetSquads()'));
  const battle={player:null}, paint={percent:team=>[20.0314,20.0304][team]};
  const document={createElement:()=>({})}, noOp=()=>{};
  let result;
  const render=new Function('paint','battle','document','button','showTitle','showDialog','drawMap','inkResult','matchRecord',
    'let state,remote;'+source+'\nfinish();');
  render(paint,battle,document,noOp,noOp,(_kind,title,content)=>{
    result={title,scores:content.innerHTML.match(/[\d.]+%/g)};
  },noOp,inkHud.inkResult,noOp);
  assert.equal(result.title,'シアンの勝利');
  assert(result.scores.length===2 && result.scores[0]!==result.scores[1]);
});

test('the finishing frame delivers every dirty ink tile before the room stops',()=>{
  const engine=new RoomEngine({...options,mode:'play',teamSize:4}),b=engine.battle,paint=b.paint;
  const mirror=new Paint({...INK_SIZE,visualOnly:true});
  mirror.setWorld(b.world);
  paint.reset();
  apply(mirror,engine.frames(1000,true));
  Object.assign(b,{countdown:0,left:.02,clock:422.98,elapsed:419.98});
  b.transit.time=b.metro.time=b.elapsed;
  submit(engine,1,1000);
  const tiles=new Set(), cells=[];
  for (let cell=0;cell<paint.layerSize && cells.length<65;cell++) {
    if (!paint.mask[cell]) continue;
    const tile=Math.floor(cell/paint.w/16)*paint.tilesWide+Math.floor((cell%paint.w)/16);
    if (tiles.has(tile)) continue;
    tiles.add(tile);
    paint.cyan[cell]=.06;
    paint.publish(cell);
    cells.push(cell);
  }
  assert.equal(cells.length,65);
  const final=apply(mirror,submit(engine,2,1050).frames);
  assert(final.finished && final.left===0);
  assert(cells.every(cell=>mirror.owner[cell]===1));
});

test('the client waits for paint packets before exposing a snapshot',async()=>{
  const engine=new RoomEngine(options), b=engine.battle, oldSocket=globalThis.WebSocket, oldLocation=globalThis.location;
  let socket;
  class Wire {
    static OPEN=1;
    static CLOSING=2;
    constructor() {socket=this;this.readyState=1;}
    close() {this.readyState=3;}
  }
  globalThis.WebSocket=Wire;
  globalThis.location={href:origin+'/'};
  const client=new RemoteMatch({room,ticket:'fixture'},b.world);
  client.ready.catch(()=>{});
  try {
    b.paint.stamp(10,-16,1.8,0,0,0,.057);
    const [header,...ink]=engine.frames(1000,true);
    assert(ink.length>0);
    socket.onopen();
    socket.onmessage({data:engine.hello()});
    socket.onmessage({data:header});
    assert(client.scene===null,'a header alone must not mount the scene');
    assert.equal(client.paint.get(10,-16,0),0);
    for (const packet of ink) socket.onmessage({data:packet});
    assert.equal(await client.ready,client.scene);
    assert.equal(client.paint.get(10,-16,0),1);
  } finally {
    client.close();
    globalThis.WebSocket=oldSocket;
    globalThis.location=oldLocation;
  }
});

test('a deep mixed puddle retains both ink volumes in a saved room',()=>{
  const engine=new RoomEngine(options),paint=engine.battle.paint,index=paint.index(10,-16,0);
  paint.cyan[index]=.168;
  paint.amber[index]=.119;
  paint.publish(index);
  const restored=new RoomEngine(options,new Map(Object.entries(structuredClone(engine.checkpoint())))).battle.paint;
  assert.equal(restored.cyan[index],paint.cyan[index]);
  assert.equal(restored.amber[index],paint.amber[index]);
  assert.equal(restored.get(10,-16,0),1);
});

test('an ink swimmer can keep holding a painted wall after a cold restore',()=>{
  const engine=new RoomEngine(options),b=engine.battle,p=b.player;
  const wall=b.world.traceExact([16,.55,-16],[17.2,.55,-16]);
  b.splat(wall,{actor:p,weapon:{...p.weapon,radius:.9},power:1});
  Object.assign(p,{x:15.80,y:0,z:-16,vy:0,yaw:Math.PI/2});
  b.move(p,4.2,0,1/24,true,false);
  assert(p.climbing && p.climbNormal && p.y>0);
  const r=new RoomEngine(options,new Map(Object.entries(structuredClone(engine.checkpoint())))).battle;
  r.move(r.player,0,0,1/24,true,false);
  assert(r.player.climbing && r.player.y===p.y);
  assert.deepEqual(r.player.climbNormal,p.climbNormal);
});

test('a released roller attack in the cabin faces its aim',()=>{
  const b=new RoomEngine({...options,weapon:'roller'}).battle,p=b.player;
  Object.assign(p,{x:CABIN_X-2,y:CABIN_Y,z:0,yaw:Math.PI/2,fire:0});
  const view=()=>({eye:[p.x-1,p.y+1,0],target:[p.x+4,p.y+1,0]});
  b.control(p,{...command,pitch:0,fire:true},.08,view);
  b.control(p,{...command,pitch:0,fire:false},.04,view);
  assert.equal(p.yaw,Math.PI/2);
  assert(b.shots.length>0 && b.shots.every(shot=>shot.pos[0]>p.x));
});

test('a stationary roller hold releases one swing and a completed roll releases none',()=>{
  const b=new RoomEngine({...options,weapon:'roller'}).battle,p=b.player;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,fire:0});
  const view=()=>({eye:[p.x-1,p.y+1,p.z],target:[p.x+4,p.y+1,p.z]});
  const fire={...command,pitch:0,fire:true}, tank=p.tank;
  for (let i=0;i<16;i++) b.control(p,fire,1/24,view);
  assert.equal(p.tank,tank);
  b.control(p,{...fire,fire:false},1/24,view);
  assert.equal(p.tank,tank-p.weapon.cost);
  p.fire=0;
  for (let i=0;i<8;i++) b.control(p,{...fire,z:1},1/24,view);
  assert(p.tank<tank-p.weapon.cost);
  const rolled=p.tank;
  p.fire=0;
  b.control(p,{...fire,fire:false},1/24,view);
  assert.equal(p.tank,rolled);
});

test('a falling avatar lands on the train roof and falls when the support moves away',()=>{
  const b=new RoomEngine(options).battle,p=b.player,rail=b.transit,line=rail.line;
  Object.assign(p,{x:line.center+rail.train.x-3,y:line.y+4.7,z:line.z,vy:-4,airborne:true});
  const roof=rail.trace([p.x,p.y,p.z],[p.x,line.y+1,p.z]).position[1];
  for (let i=0;i<12;i++) b.move(p,0,0,1/24,false,false);
  assert(Math.abs(p.y-roof)<.015 && !p.airborne && p.vy===0);
  assert(!rail.blocksActor(p));
  rail.train.x+=28;
  b.move(p,0,0,1/24,false,false);
  assert(p.y<roof && p.vy<0);
});

test('releasing swim under a low overhang keeps the player clear until there is room to stand',()=>{
  const b=new RoomEngine(options).battle,p=b.player,x=-26.15,z=-26.5;
  const {y}=b.world.floor(x,z);
  assert(!b.world.blocked(x,y+.018,z,.4,.58) && b.world.blocked(x,y+.018,z,.4,1.72));
  Object.assign(p,{x,y,z,vy:0,swimming:true});
  b.move(p,0,0,1/24,false,true);
  assert(p.swimming && !p.airborne && p.y===y);
  Object.assign(p,{x:10,y:0,z:-16,vy:0});
  b.move(p,0,0,1/24,false,false);
  assert.equal(p.swimming,false);
});

test('cloud meters do not round up into false ammo or super readiness',()=>{
  const engine=new RoomEngine({...options,weapon:'jet'}), p=engine.battle.player;
  Object.assign(p,{tank:p.weapon.cost-.0001,superCharge:99.998,charge:.9997});
  const row=frame(engine.frames(0,true)).actors.find(a=>a[AVATAR_FIELDS.indexOf('isPlayer')]);
  const displayed=Object.fromEntries(AVATAR_FIELDS.map((name,index)=>[name,row[index]]));
  assert(inkReadout({...displayed,weapon:p.weapon}).empty);
  // Meters are cut to a thousandth, always downward.
  for (const key of ['tank','superCharge','charge']) {
    assert(displayed[key]<=p[key] && p[key]-displayed[key]<.001,key);
  }
  assert(displayed.superCharge<100 && displayed.charge<1);
});

test('cloud subweapon availability knows whether the player is beaming or slamming',()=>{
  const engine=new RoomEngine(options), b=engine.battle,p=b.player;
  const client=Object.assign(Object.create(RemoteMatch.prototype),{world:b.world,paint:new Paint({...INK_SIZE,visualOnly:true}),motions:[]});
  p.tank=BASE_TANK;
  for (const action of ['beam','slam','none']) {
    p.beaming=action==='beam';
    p.slam=action==='slam'?{age:.18,y:0}:null;
    client.apply(frame(engine.frames(1000,true)));
    const player=client.scene.player;
    assert.equal(client.scene.subweapons.canUse(player),action==='none');
  }
});

test('an ink wave crosses the stair landing, hits downstairs and is streamed there',()=>{
  const b=new RoomEngine(options).battle,p=b.player,target=b.actors[4],s=STAIRS[0];
  const from=stairPoint(s,0,STAIR_SEAM-.32), to=stairPoint(s,1,STAIR_SEAM+.86);
  for (const a of b.actors) if (a!==p && a!==target) a.down=99;
  Object.assign(p,from,{y:b.world.floor(from.x,from.z).y,yaw:Math.PI/2});
  Object.assign(target,to,{y:b.world.floor(to.x,to.z).y,shield:0});
  b.abilities.advanced.launch(p,'wave');
  for (let i=0;i<5;i++) {b.clock+=1/24;b.abilities.advanced.update(1/24);}
  const effect=b.abilities.advanced.effects[0];
  assert(effect && effect.lanes.some(l=>!l.stopped && zoneOf(l.x)===1));
  assert(target.hp<100);
  assert.equal(b.paint.get(to.x,to.z,2),1);
  assert(frameOf(b,1,0,[]).effects.some(e=>e.id==='wave'));
  const ink=[];
  b.abilities.advanced.draw({add(_type,x){ink.push(x);},beam(){}},UNDER_X);
  assert(ink.length>0 && ink.every(x=>zoneOf(x)===1));
});

test('a drone coats the station canopy below it without painting through to the platform',()=>{
  const b=new RoomEngine(options).battle,p=b.player,x=-49.4,z=-26;
  const floor=b.world.floor(x,z);
  const roof=b.traceShot([x,floor.y+6,z],[x,floor.y+.04,z],true,false);
  assert(roof && roof.layer===undefined);
  b.paint.reset();
  Object.assign(p,{x,y:roof.position[1],z,yaw:Math.PI/2});
  assert(b.abilities.summon(p));
  p.drone.turn=30;
  for (let i=0;i<13;i++) {b.clock+=1/24;b.abilities.update(1/24);}
  assert.deepEqual(b.paint.count,[0,0]);
  assert(p.drone.y>roof.position[1]+1);
  assert(b.decals.some(mark=>mark.shape===roof.shape.id));
  Object.assign(p.drone,{x:10,y:1.54,z:-16,spray:0});
  b.abilities.update(1/24);
  assert.equal(b.paint.get(10,-16,0),1);
});

test('a cramped giant transformation keeps its charge and fits under a cabin roof when activated',()=>{
  const b=new RoomEngine({...options,weapon:'fan'}).battle,p=b.player,x=-23.35,z=-26.5;
  const {y}=b.world.floor(x,z);
  Object.assign(p,{x,y,z,superCharge:100});
  assert(!b.world.blocked(x,y+.018,z,.64,1.72));
  assert.equal(b.abilities.activate(p),false);
  assert.equal(p.superCharge,100);
  Object.assign(p,{x:CABIN_X,y:CABIN_Y,z:0});
  assert(b.abilities.activate(p) && p.giant);
  const shapes=collectShapes(r=>drawCrew(r,p,b.clock,false));
  const top=Math.max(...shapes.map(shape=>shape.max[1]));
  const roof=b.traceShot([p.x,p.y+1.6,0],[p.x,p.y+3.1,0],true,false);
  assert(top<roof.position[1]);
});

test('browser adapter receives state and paint through the same framed socket protocol',async()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  let now=1000, socket, receivedInputs=0;
  const oldSocket=globalThis.WebSocket, oldLocation=globalThis.location;
  class Loopback {
    static OPEN=1;
    static CLOSING=2;
    constructor(url,protocols) {
      assert.equal(url.protocol,'wss:');
      assert.equal(protocols[0],SOCKET_PROTOCOL);
      this.readyState=0;
      this.bufferedAmount=0;
      socket=this;
      queueMicrotask(()=>{
        this.readyState=1;
        this.onopen();
        this.onmessage({data:engine.hello()});
        for (const data of engine.frames(now,true)) this.onmessage({data});
      });
    }
    send(message) {
      receivedInputs++;
      for(const data of engine.poll(message,now+=50).frames) this.onmessage({data});
    }
    close() {this.readyState=3;}
  }
  globalThis.WebSocket=Loopback;
  globalThis.location={href:origin+'/'};
  const remote=new RemoteMatch({room,ticket:'test-token'},b.world);
  try {
    const scene=await remote.ready;
    assert(scene.timeless && scene.player && scene.actors.length===8);
    assert(remote.paint.visualOnly && !remote.paint.cyan);
    b.countdown=0;
    remote.input({...command,z:1,drone:true},false);
    for(let i=0;i<6;i++)remote.flush();
    assert(receivedInputs>=5 && b.player.drone);
    assert.equal(scene.player.drone,true);
    assert(socket.readyState===1);
    const target=b.actors[4];
    Object.assign(target,{x:0,y:11.95,z:0,yaw:Math.PI/2,shield:0,down:0,swimming:false});
    b.shots.push({pos:[-2,13,.47],vel:[96,0,0],actor:b.player,weapon:b.player.weapon,power:1,age:0});
    b.updateShots(1/24);
    const packets=engine.frames(now+=100,true);
    const snapshot=frame(packets);
    for (const data of packets) socket.onmessage({data});
    assert.equal(scene.inkImpacts.length,1);
    assert.equal(scene.inkImpacts[0].team,b.player.team);
    const marks=[];
    const r={lite:true,add(...args){if (args[2]>12 && args[2]<14) marks.push(args);},beam(){},label(){}};
    scene.draw(r,-6,0,null,14);
    // The streamed impact starts at the very beginning of its animation.
    assert(marks.some(args=>args[0]==='ripple' && args[9].label<.02));
    // A body hit is drawn large: eight spikes around a four-armed cross.
    assert.equal(marks.filter(args=>args[0]==='tri' && args[8]===3).length,12);
    assert(marks.filter(args=>args[0]==='ripple').length>=3);
    delete snapshot.inkImpacts;
    delete snapshot.inkPackets;
    snapshot.fullInk=0;
    socket.onmessage({data:JSON.stringify(snapshot)});
    assert.deepEqual(scene.inkImpacts,[]);

    const deliver=()=>{
      for(const data of engine.frames(now+=120)) socket.onmessage({data});
    };
    const projectile={id:41,pos:[-26,1.4,1],vel:[76,0,0],actor:b.player,weapon:b.player.weapon};
    b.shots=[projectile];
    target.yaw=3.10;
    deliver();
    remote.advance(remote.frameDue);
    projectile.pos[0]+=4;
    target.yaw=-3.10;
    deliver();
    assert.equal(scene.shots[0].pos[0],-26);
    // Halfway to the moment the snapshot is due, the round is halfway along.
    remote.advance((remote.frameAt+remote.frameDue)/2);
    assert(Math.abs(scene.shots[0].pos[0]+24)<1e-6);
    assert(Math.abs(Math.abs(scene.actors[4].yaw)-Math.PI)<.001);
    b.shots=[];
    deliver();
    assert.equal(scene.shots.length,0);
  } finally {
    remote.close();
    globalThis.WebSocket=oldSocket;
    globalThis.location=oldLocation;
  }
});
