import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {frameOf} from './frame.js';
import {BOSS_TENTACLES,drawBossModel,BOSS_BODY_HEIGHT} from '../dist/boss-model.js';
import {Paint} from '../dist/ink.js';
import {INK_SIZE,applyInkPacket,resetVisualInk} from '../dist/ink-wire.js';
import {UNDER_X,ZONES} from '../dist/layout.js';
import {meshes} from '../dist/render.js';
import {SUBWEAPONS} from '../dist/subweapons.js';
import {WEAPONS,weaponById} from '../dist/weapons.js';

const options={mode:'play',teamSize:4,weapon:'lob'};

test('a legal 80-unit shot continues past three seconds, paints at its destination and streams the surface flash',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  for (const actor of b.actors) if (actor!==p) actor.down=99;
  Object.assign(p,{x:-47,y:0,z:22,yaw:Math.PI/2,fire:0});
  b.rng=()=>.5;
  b.paint.reset();
  assert(b.world.stand(p.x,p.z) && b.world.stand(33,22));
  assert(b.shoot(p,[33,-.05,22]));
  const dt=1/60;
  for (let i=0;i<180;i++) {b.clock+=dt;b.updateShots(dt);}
  assert.equal(b.shots.length,1);
  for (let i=0;i<80 && b.shots.length;i++) {b.clock+=dt;b.updateShots(dt);}
  assert.equal(b.shots.length,0);
  assert.equal(b.paint.get(33,22,0),1);
  const hit=frameOf(b,0,0,[]).inkImpacts.at(-1);
  assert(Math.abs(hit[0]-33)<.12 && hit[5][1]>.95);
});

test('the new weapon costs and splatter radius are applied without multiplying damage',()=>{
  const originalCosts=[2.45,4.5,7,9,6,3.15,4.35,3.75,4.5,2.695,12,15,2.9,2.9*.6];
  assert.deepEqual(WEAPONS.map(w=>w.cost),originalCosts.map(cost=>cost/2));
  assert.deepEqual(SUBWEAPONS.map(w=>w.cost),[14.5,20.5,13,16.5,18,12]);
  const {battle:b}=new RoomEngine(options), p=b.player, w=weaponById('jet');
  assert.equal(w.damage,29);
  assert.equal(w.radius,1.22*1.5);
  const hit=b.traceShot([10,1,-16],[10,-.15,-16],true);
  const paintAtRadius=weapon=>{
    b.paint.reset();
    b.rng=()=>.5;
    b.splat(hit,{actor:p,weapon});
    return b.paint.count[0];
  };
  const previous=paintAtRadius({...w,radius:1.22}), current=paintAtRadius(w);
  assert(current>previous*1.85 && current<previous*2.60);
});

test('surface and underground ink, scores and action continue to update on one link without a view switch',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.player;
  const replica=new Paint({...INK_SIZE,visualOnly:true});
  b.paint.reset();
  const receive=packets=>{
    assert(packets.length);
    const frame=JSON.parse(packets[0]);
    if (frame.fullInk) resetVisualInk(replica,frame.fullInk);
    for (const packet of packets.slice(1)) applyInkPacket(replica,packet);
    return frame;
  };
  const start=receive(engine.frames(1000,true)), below=UNDER_X-29,z=-13.25;
  assert.equal(start.fullInk,ZONES[0].inkMask|ZONES[1].inkMask);
  b.paint.stamp(10,-16,2,0,0,.2,.062);
  b.paint.stamp(below,z,2,1,2,.2,.062);
  const whileAbove=receive(engine.frames(1110));
  assert.equal(whileAbove.zone,0);
  assert.equal(replica.get(below,z,2),2);
  assert.equal(replica.get(10,-16,0),1);
  assert(whileAbove.zoneCount[0][0]>0 && whileAbove.zoneCount[1][1]>0);
  // Totals never change, so only the first full frame carries them.
  assert(start.full && start.zoneTotal.every(n=>n>0));
  assert(!whileAbove.full && whileAbove.zoneTotal===undefined && whileAbove.actorDiffs.length===b.actors.length);
  Object.assign(p,{x:below,y:-8,z});
  b.paint.stamp(13,-16,2,0,0,.4,.063);
  const whileBelow=receive(engine.frames(1140));
  assert.equal(whileBelow.zone,1);
  assert.equal(whileBelow.fullInk,0);
  assert.equal(replica.get(13,-16,0),1);
});

test('the boss is a plain, texture-ready body with five tentacles, phase colours and a hittable main body',()=>{
  const {battle:b}=new RoomEngine(options), boss=b.boss;
  Object.assign(boss,{x:10,y:0,z:-16,yaw:Math.PI,active:true});
  const emit=(phase,lite)=>{
    boss.phase=phase;
    const parts=[];
    drawBossModel({lite,add:(...part)=>parts.push(part)},boss,2.1);
    return parts;
  };
  const high=emit(1,false), mobile=emit(1,true), finalPhase=emit(3,false);
  assert(high.some(part=>part[0]==='mantle' && part[8]===23));
  // A few big shapes: the squid-skin textures carry the detail.
  assert(high.length<60 && mobile.length===high.length);
  assert.equal(high.filter(part=>part[0]==='taper').length,BOSS_TENTACLES*5);
  assert(!high.some(part=>part[0]==='ring' || part[0]==='bevel'));
  assert.notEqual(high[0][7],finalPhase[0][7]);
  assert(meshes().mantle.indices.length>meshes(true).mantle.indices.length*5);
  assert(b.bodyHit([boss.x,5.1,boss.z-7],[boss.x,5.1,boss.z+7],boss)!==null);
  assert.equal(BOSS_BODY_HEIGHT,6.3);
});
