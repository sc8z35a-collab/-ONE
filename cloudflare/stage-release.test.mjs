import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {frameOf} from './frame.js';
import {RoomEngine} from './room-engine.js';
import {SCENE_FILE,SCENE_VERSION} from '../dist/layout.js';
import {RESIDENTIAL_TYPES,residentialLot} from '../dist/residential.js';
import {STREET_FACILITIES} from '../dist/street-facilities.js';
import {WEATHERING} from '../dist/weathering.js';
import {SUPERS,WEAPONS,weaponById} from '../dist/weapons.js';
import {World} from '../dist/world.js';

const options={mode:'play',weapon:'jet',teamSize:4};
const engine=()=>new RoomEngine(options);
const checkpoint=e=>new Map(Object.entries(structuredClone(e.checkpoint())));
const baked=JSON.parse(readFileSync(new URL(`../dist/${SCENE_FILE}`,import.meta.url)));
const receiver={zone:0,add(){},label(){},seal(){}};

test('all 30 residence designs fit without crossing parcel lines, and taller footprints get more land and foundation',()=>{
  const w=engine().battle.world;
  assert.equal(RESIDENTIAL_TYPES.length,30);
  assert.equal(new Set(RESIDENTIAL_TYPES.map(r=>[r.form,r.width,r.depth,r.height,r.facade,r.roof].join())).size,30);
  assert.equal(w.towerSites.filter(site=>site.type).length,30);
  for (const [i,a] of w.towerSites.entries()) for (const b of w.towerSites.slice(i+1)) {
    assert(Math.abs(a.x-b.x)>=a.halfW+b.halfW || Math.abs(a.z-b.z)>=a.halfD+b.halfD);
  }
  const tall=residentialLot(16,12,64), short=residentialLot(16,12,12);
  for (const key of Object.keys(short)) assert(tall[key]>short[key],key);
});

test('the baked city contains all fifty weathering designs and ten labelled facilities with clear entrances',()=>{
  assert.equal(baked.version,SCENE_VERSION);
  assert.equal(WEATHERING.length,50);
  assert.equal(new Set(WEATHERING.map(w=>w.name)).size,50);
  const ids=new Set(baked.parts.flatMap(part=>part[10]?.wear?[part[10].wear]:[]));
  assert.deepEqual([...ids].sort((a,b)=>a-b),WEATHERING.map(w=>w.id));
  const {battle:b}=engine();
  assert.equal(STREET_FACILITIES.length,10);
  for (const facility of STREET_FACILITIES) {
    const {id,x,z,d,label}=facility;
    assert(baked.parts.some(part=>part[1]==='label' && part[2]===label),label);
    const sign=-Math.sign(z), front=z+sign*d*.5;
    for (let i=0;id!=='kiosk' && i<15;i++) {
      const pz=front+sign*(1.05-i*.14);
      assert(b.world.stand(x,pz,.4) && !b.stage.blocked(x,.02,pz,.4,1.72),id);
    }
  }
});

test('three different block materials and window panes take ink damage, release their collision, and persist per room',()=>{
  const e=engine(), b=e.battle, p=b.player;
  const targets=b.stage.parts.filter(part=>part.id.startsWith('g-') || part.id==='home-0-window--1--1');
  assert.deepEqual(targets.map(o=>o.type).sort(),['clay','concrete','glass','wood']);
  for (const o of targets) {
    const [from,to]=[[o.x,o.y,o.z+o.d*.5+.4],[o.x,o.y,o.z-o.d*.5-.18]];
    const shot={actor:p,weapon:p.weapon,vel:[0,0,-14],power:1};
    assert.equal(b.traceShot(from,to,true)?.stageObject?.id,o.id);
    assert(b.stage.blocked(o.x,o.y-.06,o.z,.28,.29));
    const impacts=Math.ceil(o.style.hp/p.weapon.damage);
    for (let i=0;i<impacts;i++) {
      const hit=b.traceShot(from,to,true);
      assert.equal(hit?.stageObject?.id,o.id);
      b.splat(hit,shot);
    }
    assert.equal(b.stage.damage.get(o.id).hp,0);
    assert.notEqual(b.traceShot(from,to,true)?.stageObject?.id,o.id);
    assert(!b.stage.blocked(o.x,o.y-.06,o.z,.28,.29));
  }
  const snapshot=frameOf(b,0,0,[]);
  assert.equal(snapshot.stage.length,4);
  assert(snapshot.stage.every(([,hp])=>hp===0));
  const restored=new RoomEngine(options,checkpoint(e)).battle;
  assert.deepEqual(restored.stage.snapshot(),b.stage.snapshot());
  assert.equal(engine().battle.stage.snapshot().length,0);
  for (const o of b.stage.parts.filter(part=>part.id.startsWith('b-'))) {
    assert(Math.abs(b.world.floor(o.x,o.z).y-(o.y-o.h/2))<.01);
    assert(b.world.stand(o.x,o.z,.72));
  }
});

test('all three apartment interiors are paintable and each actor can enter each one only once per match',()=>{
  const e=engine(), b=e.battle, p=b.player, npc=b.actors.find(a=>a!==b.player);
  const bakedWorld=new World(receiver,baked);
  assert.deepEqual(bakedWorld.homes,b.world.homes);
  assert.deepEqual(bakedWorld.objects,b.world.objects);
  assert.equal(b.world.homes.length,3);
  for (const h of b.world.homes) {
    const x=(h.x0+h.x1)/2, z=(h.z0+h.z1)/2, sign=Math.sign(z), front=sign>0?h.z0:h.z1;
    const start=front-sign*1.05, outside=actor=>sign*actor.z<=sign*front+1e-6;
    for (const actor of [p,npc]) {
      Object.assign(actor,{x,y:0,z:start});
      for (let i=0;i<21;i++) b.stepActor(actor,0,sign*.14);
      assert(!outside(actor));
      assert(actor.apartmentVisits & (1<<h.index));
      for (let i=0;i<26;i++) b.stepActor(actor,0,-sign*.14);
      assert(outside(actor));
      for (let i=0;i<24;i++) b.stepActor(actor,0,sign*.14);
      assert(outside(actor));
    }
    b.paint.reset();
    const hit=b.traceShot([x,.68,z],[x,-.10,z],true);
    assert.equal(hit.layer,0);
    b.splat(hit,{actor:p,weapon:p.weapon});
    assert.equal(b.paint.get(x,z,0),1);
  }
  const restored=new RoomEngine(options,checkpoint(e)).battle;
  assert.equal(restored.player.apartmentVisits,7);
  assert.equal(restored.actors.find(a=>a!==restored.player).apartmentVisits,7);
  assert.equal(engine().battle.player.apartmentVisits,undefined);
});

test('removed missiles are absent from play, and a legacy room can activate the lob weapon’s replacement',()=>{
  const {battle:b}=new RoomEngine({...options,weapon:'lob'}), p=b.player;
  assert(!('missiles' in SUPERS));
  assert(WEAPONS.every(w=>Object.hasOwn(SUPERS,w.special)));
  assert.equal(weaponById('lob').special,'vortex');
  Object.assign(p,{x:-12,y:0,z:13,superCharge:100});
  assert(b.abilities.activate(p));
  assert.equal(b.abilities.advanced.effects[0].id,'vortex');
  assert(!('missiles' in frameOf(b,0,0,[])));
});

test('a shot reaches ground outside the old boundary, leaves unscored ink, and restores that exact coat',()=>{
  const e=new RoomEngine({...options,weapon:'lob'}), b=e.battle, p=b.player;
  for (const a of b.actors) if (a!==p) a.down=99;
  Object.assign(p,{x:-47,y:0,z:12,yaw:-Math.PI/2,fire:0});
  const generator=b.rng;
  b.rng=()=>.5;
  b.paint.reset();
  // Open street past the old edge (the apartment blocks start at x≈-104).
  assert(b.shoot(p,[-100,-.065,12]));
  for (let i=0;i<460 && b.shots.length;i++) {b.clock+=1/60;b.updateShots(1/60);}
  const mark=b.decals.at(-1);
  assert(mark && Math.abs(mark.p[0]+100)<.15 && mark.normal[1]>.98);
  assert.equal(b.paint.count[0],0);
  b.rng=generator;
  const restored=new RoomEngine(options,checkpoint(e)).battle;
  assert.equal(restored.decals.at(-1).shape,mark.shape);
});
