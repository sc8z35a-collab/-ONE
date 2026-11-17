import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RoomEngine} from './room-engine.js';
import {frameOf} from './frame.js';
import {crewView} from '../dist/cloud-view.js';
import {Geometry,makeShape} from '../dist/collision.js';
import {decodeFilmHeight,filmFlux} from '../dist/ink-fluid.js';
import {INK_SIZE,applyInkPacket} from '../dist/ink-wire.js';
import {Paint} from '../dist/ink.js';
import {CABIN_X,CABIN_Y,ENCLOSURE,RAIL_CABIN_X,SCENE_FILE,UNDER_X,cityExit,inCity,zoneOf} from '../dist/layout.js';
import {ELEVATED_APPROACH} from '../dist/elevated-approach.js';
import {FACADE_DEPTH,enclosureFronts} from '../dist/enclosure.js';
import {forward,unit,sub} from '../dist/render.js';
import {WINDOW_BREAK,WINDOW_CRACK} from '../dist/train-glass.js';
import {trainPose} from '../dist/train-model.js';
import {World} from '../dist/world.js';

const options={mode:'timeless',teamSize:4,weapon:'jet'};
const near=(a,b,error=1e-6)=>assert(Math.abs(a-b)<error,`${a} vs ${b}`);
const renderless=()=>({zone:0,add(){},label(){},seal(){}});

test('server inputs preserve aim in both directions through the train doors',()=>{
  const e=new RoomEngine(options), b=e.battle, p=b.player, rail=b.transit;
  b.countdown=0;
  b.elapsed=1.3;
  rail.update(b.elapsed);
  const line=rail.line, yaw=1.217,pitch=.283;
  Object.assign(p,{x:line.center+rail.train.x+2.64,y:line.platformY,z:line.platformZ,yaw,pitch});
  const input={type:'input',x:0,z:0,yaw,pitch};
  const poll=(seq,time,use=false)=>e.poll(JSON.stringify({...input,seq,use}),time);
  poll(1,1000);
  poll(2,1130,true);
  assert.equal(zoneOf(p.x),3);
  assert.equal(p.yaw,yaw);
  assert.equal(p.pitch,pitch);
  const view=crewView(b,p);
  unit(sub(view.target,view.eye)).forEach((value,i)=>near(value,forward(yaw,pitch)[i]));
  assert(view.eye[0]>RAIL_CABIN_X-9.24 && view.eye[0]<RAIL_CABIN_X+9.24);
  p.doorReady=0;
  poll(3,1260,true);
  assert.equal(zoneOf(p.x),0);
  assert.equal(p.yaw,yaw);
  assert.equal(p.pitch,pitch);
});

test('the approach connects ground level and the entire elevated road in the packaged scene',()=>{
  const scene=JSON.parse(readFileSync(new URL('../dist/'+SCENE_FILE,import.meta.url)));
  const baked=new World(renderless(),scene), {battle:b}=new RoomEngine(options);
  assert.deepEqual(scene.elevated,[ELEVATED_APPROACH]);
  const p=b.player;
  Object.assign(p,{x:10.9,y:0,z:96.4,vy:0});
  for (let i=0;i<540;i++) b.move(p,0,-5.9,1/24,false,false);
  assert(p.z<-30);
  near(p.y,12.67);
  const ramp=baked.traceExact([10.9,12,72],[10.9,-.1,72]);
  assert(ramp.position[1]>5 && ramp.normal[2]>.20);
  const underneath=baked.support(10.9,0,72);
  assert.equal(underneath.y,0);
});

test('a thin ring of building fronts is the edge of the city: solid to bodies and rays, with nothing beyond',()=>{
  const {battle:b}=new RoomEngine(options), {world}=b;
  const scene=JSON.parse(readFileSync(new URL('../dist/'+SCENE_FILE,import.meta.url)));
  const fronts=enclosureFronts();
  assert(fronts.length>25 && fronts.every(f=>f.height>=16 && f.width>=5));
  // Every piece of the street stands inside the ring (or is the ring itself).
  const reach=FACADE_DEPTH+.6;
  for (const [zone,type,x,,z,w,,d,,,opts] of scene.parts) {
    // The short tunnels behind the loop's openings belong to the ring.
    if (zone!==0 || type==='label' || opts?.portal) continue;
    assert(inCity(x,z,-reach-Math.max(w,d)*.5),`part at ${x},${z} lies outside the ring`);
  }
  // The ground ends with the ring: beyond it is empty space.
  assert(world.traceExact([0,.3,40],[0,-.2,40])?.normal[1]>.99);
  assert.equal(world.geometry.trace([0,.3,70],[0,-.2,70]),null);
  assert.equal(world.geometry.trace([130,30,0],[130,-5,0]),null);
  // Bodies stop at the ring, even high up a climbed front.
  const edge=ENCLOSURE[0].x1, runner={x:edge-.8,z:0,y:30};
  world.step(runner,5,0);
  near(runner.x,edge-.8);
  world.step(runner,-.5,0);
  near(runner.x,edge-1.3);
  assert(world.blocked(edge+.2,.05,0) && !world.blocked(edge-2,.05,0));
  // Rays end at the ring: on a front, or at the boundary above the lower ones.
  const ray=world.traceExact([0,60,0],[300,60,0]);
  near(ray.position[0],ENCLOSURE[0].x1,.6);
  assert.equal(cityExit([edge-1,0,0],[edge-6,0,0]),null);
  // A front is a wall: paint marks it but never scores as floor.
  const wall=world.traceExact([edge-8,1.5,3],[edge+6,1.5,3]);
  assert(wall?.shape && wall.normal[0]<-.9);
  const before=b.paint.count[0];
  b.splat(wall,{actor:b.player,weapon:b.player.weapon});
  assert.equal(b.paint.count[0],before);
  assert(b.wallOwner(wall.position,wall.normal,wall.shape.id)===1);
});

test('mixed film retains its volume while the wet side of a thin barrier stays isolated',()=>{
  const geometry=new Geometry(), paint=new Paint({width:64,height:40});
  const a=8*paint.w+32,b=a+1;
  const seam=((33/paint.w)*2-1)*paint.boundX;
  const z=((8.5/paint.h)*2-1)*paint.boundZ;
  geometry.add(makeShape('box',seam,.4,z,.04,.8,3,2));
  paint.barrierWorld=geometry;
  paint.cyan[a]=.082;
  paint.amber[a]=.024;
  assert.equal(paint.edge(a,b,paint.flowX,a,paint.barrierX),false);
  assert.equal(paint.barrierX[a],2);
  assert(filmFlux(.04,.001,.12,0)>filmFlux(.04,.001,0,0));
  assert(paint.edge(a,b,paint.flowX,a));
  near(paint.deltaC[a]+paint.deltaC[b],0);
  near(paint.deltaA[a]+paint.deltaA[b],0);
  assert(paint.deltaC[b]>paint.deltaA[b] && paint.deltaA[b]>0);

  const e=new RoomEngine(options), field=e.battle.paint, mirror=new Paint({...INK_SIZE,visualOnly:true});
  mirror.setWorld(e.battle.world);
  const x=0, y=2.42, layer=1, index=field.index(x,0,layer);
  field.stamp(x,0,1,0,layer,0,.06);
  const frames=e.frames(1000,true);
  for (const buffer of frames.slice(1)) applyInkPacket(mirror,buffer);
  const byte=mirror.pixels[index*4+3];
  assert(byte>0 && mirror.owner[index]===1);
  near(decodeFilmHeight(byte),y,.04);
  assert.equal(byte,field.pixels[index*4+3]);
});

test('wall paint clips to the actual panel and drains volume into falling drops',()=>{
  const geometry=new Geometry();
  geometry.add(makeShape('box',0,1,0,2,2,.15,2));
  const hit=geometry.trace([.9,1.85,1],[.9,1.85,-1]);
  const rim=geometry.coat({p:[.9,1.85,.098],shape:hit.shape.id,radius:1,normal:hit.normal},
    [[1,0,0],[0,1,0],[0,0,1]],new Array(12).fill(1));
  assert(rim.length>=4 && rim.every(([x,y,z])=>x<=1.000001 && x>=-1.000001 && y>=-1e-6 && y<=2.000001 && Math.abs(z-.075)<1e-6));
  const {battle:b}=new RoomEngine(options);
  const wall=b.world.traceExact([16,.55,-16],[17.2,.55,-16]);
  b.splat(wall,{actor:b.player,weapon:b.player.weapon});
  const mark=b.decals.at(-1), original=mark.volume, before=b.paint.count[0];
  b.drainWalls(.06);
  const transferred=b.drops.filter(drop=>drop.volume).reduce((sum,drop)=>sum+drop.volume,0);
  assert(transferred>0 && mark.volume<original);
  near(mark.volume+transferred,original,1e-9);
  assert.equal(b.paint.count[0],before);
  for (let i=0;i<30;i++) b.updateShots(1/60);
  assert(b.paint.count[0]>before);
});

test('a metro window cracks, breaks on both sides and remains broken in a restored room',()=>{
  const e=new RoomEngine(options), b=e.battle, p=b.player, rail=b.metro;
  const x=CABIN_X-4.30,y=CABIN_Y+1.70;
  const inside=()=>b.traceShot([x,y,0],[x,y,2.5],true);
  const exterior=()=>{
    const pose=trainPose(rail.train,rail.line);
    return rail.trace(pose.at(-4.3,3.02,2.35),pose.at(-4.3,3.02,.88),true);
  };
  const hit=inside(), id=hit.shape.windowId;
  assert.equal(hit.cabinWindow,rail);
  assert.equal(exterior()?.shape.windowId,id);
  for (let i=0;i<2;i++) b.splat(inside(),{actor:p,weapon:p.weapon});
  assert(rail.train.windows[id]>=WINDOW_CRACK && rail.train.windows[id]<WINDOW_BREAK);
  assert.equal(frameOf(b,2,0,[]).metro.train.windows[id],rail.train.windows[id]);
  for (let i=0;i<2;i++) b.splat(inside(),{actor:p,weapon:p.weapon});
  assert.equal(rail.train.windows[id],WINDOW_BREAK);
  assert.equal(inside()?.shape.windowId,undefined);
  assert.notEqual(exterior()?.shape.windowId,id);
  rail.dock(1);
  assert.equal(rail.train.windows[id],WINDOW_BREAK);
  const saved=new Map(Object.entries(structuredClone(e.checkpoint())));
  assert.equal(new RoomEngine(options,saved).battle.metro.train.windows[id],WINDOW_BREAK);
});

test('saved rooms translate old subway and cabin positions into the expanded coordinate layout',()=>{
  const e=new RoomEngine(options), state=e.checkpoint(), data=state.game;
  data.version=4;
  data.actors[0].x=321.6;
  data.actors[1].x=152.5;
  data.actors[2].x=477.5;
  data.chip.x=15.1;
  data.drops.push({p:[320.6,-3.4,.5],v:[0,-1,0],team:0,size:.12,life:.7,max:1,volume:.0003});
  const b=new RoomEngine(options,new Map(Object.entries(state))).battle;
  near(b.actors[0].x,CABIN_X+1.6);
  near(b.actors[1].x,UNDER_X-7.5);
  near(b.actors[2].x,RAIL_CABIN_X-2.5);
  near(b.chip.x,15.1);
  near(b.drops.at(-1).p[0],CABIN_X+.6);
  assert.equal(b.drops.at(-1).volume,.0003);
});
