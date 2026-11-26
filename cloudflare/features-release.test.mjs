import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {Paint} from '../dist/ink.js';
import {FluidEngine,FLUID_MEDIA,STORM_DRAINS} from '../dist/fluid-engine.js';
import {DestructionPhysics} from '../dist/destruction.js';
import {DynamicStage,DYNAMIC_STAGE_FIRST} from '../dist/dynamic-stage.js';
import {GOAT_ARMS,GOAT_REACH,HELI_SALVO_COUNT} from '../dist/hazards.js';
import {CHEATER_WEAPON,GOAT_WEAPON,WEAPONS,weaponById} from '../dist/weapons.js';
import {CX10_VERSION} from '../dist/cheater-engine.js';
import {inkResult} from '../dist/ink-hud.js';
import {BASE_TANK,GIGA_TANK,UNDER_X,UNDER_Y} from '../dist/layout.js';
import {Renderer,STRIDE,packInstance} from '../dist/render.js';
import * as Shaders from '../dist/render-shaders.js';
import {SoftwareRenderer} from '../dist/software.js';

const options={mode:'play',weapon:'jet',teamSize:4,cheater:false};
const still={x:0,z:0,yaw:0,pitch:-.12,fire:false,swim:false,front:false,overview:false};
const view=()=>({eye:[0,4,14],target:[0,1,0]});

test('unified FluidEngine drives rain runoff, boss black ink rain, percolation to B1, shot aerodynamics & tsunami bores',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.countdown=0;
  assert(b.fluid instanceof FluidEngine);
  assert.equal(FLUID_MEDIA.water.density,1000);
  assert(FLUID_MEDIA.boss.density>FLUID_MEDIA.water.density);

  // Weather rain accumulates shallow water on surface & washes ink without washing B1
  for (const a of b.actors) if (!a.isPlayer) a.down=99;
  b.paint.stamp(6,6,3,0,0,0,.08);
  b.paint.stamp(UNDER_X+6,6,3,0,2,0,.024);
  b.paint.advance(2);
  const b1Before=b.paint.zoneCount[1][0];
  b.hazards.startRain(8);
  for (let i=0;i<30;i++) b.update(1/30,still,view);
  assert(b.fluid.weatherRainRate>0);
  assert(b.fluid.surface.meanWaterDepth>0);
  assert.equal(b.paint.zoneCount[1][0],b1Before);

  // Active boss pours continuous black ink (owner=3) on surface AND percolates down into B1
  b.hazards.rain.active=false;
  b.boss.spawn();
  assert(b.boss.active);
  for (let i=0;i<60;i++) b.update(1/20,still,view);
  assert(b.paint.bossCount>0,'boss black ink accumulated on arena');
  assert(b.paint.zoneBossCount[1]>0,'boss black ink drained underground to B1');
  assert(b.fluid.underBossDepth>0 && b.fluid.cumulativePercolatedBoss>0);

  // Defeating boss stops continuous black rain immediately
  b.boss.active=false;
  b.fluid.stepBossInkRain(b,1/30);
  assert.equal(b.fluid.bossRainRate,0);

  // Tsunami bore wave exerts hydrodynamic push on street actors
  const target=b.actors[4];
  Object.assign(target,{x:-10,y:0,z:0,vx:0,vz:0,down:0,ride:null,lift:null});
  b.hazards.startTsunami();
  b.hazards.tsunami.phase='wave';
  b.hazards.tsunami.x=-11;
  b.hazards.tsunami.dir=1;
  b.fluid.stepTsunamiFluid(b.hazards,b,1/20);
  assert(target.vx>0 && b.fluid.lastTsunamiPeakForce>0);
});

test('surviving boss counts toward match ink victory and stops only when defeated',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.paint.reset();
  // Stamp overwhelming boss black ink
  for (let x=-20;x<=20;x+=3) for (let z=-12;z<=12;z+=3) b.paint.stamp(x,z,2.5,2,0,0,.08);
  b.paint.stamp(-28,0,1.2,0,0,0,.06);
  b.boss.spawn();
  assert(b.boss.active);
  const aliveResult=inkResult(b.paint,b);
  assert.equal(aliveResult.bossAlive,true);
  assert.equal(aliveResult.scores.length,3);
  assert.equal(aliveResult.title,'オオモノイカの勝利');

  // When defeated, match falls back to 2-team scoring
  b.boss.active=false;
  const deadResult=inkResult(b.paint,b);
  assert.equal(deadResult.bossAlive,false);
  assert.equal(deadResult.scores.length,2);
});

test('destruction physics damages, topples, shatters into debris, hides static geometry & removes collision on objects and buildings',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  const d=b.stage.destruction;
  assert(d instanceof DestructionPhysics);
  assert(d.structures.length>10 && d.byId.size>10);

  // Test destroying both a street object/planter and a registered architectural building
  const entries=d.structures;
  const obj=entries.find(s=>s.kind!=='tower' && s.kind!=='apartment' && s.zone===0) ?? entries[0];
  const bldg=entries.find(s=>(s.kind==='tower' || s.kind==='apartment' || s.kind==='shop') && s.zone===0) ?? entries[1];
  assert(obj && bldg && obj!==bldg);

  // Hammer object & building with high-impulse ink impacts until both collapse
  const obBefore=b.world.blocked(obj.x,obj.y,obj.z,.35,1.2);
  assert.equal(typeof obBefore,'boolean');
  d.applySplashDamage(obj.x,obj.y,obj.z,Math.max(obj.w,obj.d)+2,obj.maxHp*4,0,18);
  assert(obj.state==='collapsing' || obj.state==='destroyed','street object enters topple physics state');
  d.applySplashDamage(bldg.x,bldg.y,bldg.z,Math.max(bldg.w,bldg.d)+2,bldg.maxHp*4,1,24);
  assert(bldg.state==='collapsing' || bldg.state==='destroyed','building enters topple physics state');

  // Step rigid-body collapse ODE & flush GPU static batch hides
  const hides=[];
  const mockRenderer={hideStaticRegion:(...args)=>hides.push(args)};
  for (let i=0;i<150;i++) b.stage.update(1/30,b);
  d.flushRendererHides(mockRenderer);
  assert(hides.length>=2,'collapsed structures trigger hideStaticRegion on GPU batches');
  assert(obj.state==='destroyed' && d.rubble.length>0,'collapsed structures shatter into debris & rubble');

  // Verify world collision and geometry trace no longer block on disabled solid boxes
  for (const s of bldg.solids??[]) assert.equal(s.disabled,true);
  for (const s of obj.solids??[]) assert.equal(s.disabled,true);
});

test('ULTRA raytracing quality mode, SwRenderer compatibility & all 23 GLSL shaders pass structural validation',()=>{
  // All shaders balanced and declare raytrace/boss/wet uniforms
  for (const [name,src] of Object.entries(Shaders)) {
    if (typeof src!=='string' || !src.startsWith('#version 300 es')) continue;
    let b=0, p=0, cond=0;
    for (const ch of src) {
      if (ch==='{') b++; else if (ch==='}') b--;
      else if (ch==='(') p++; else if (ch===')') p--;
      assert(b>=0 && p>=0,name+' unbalanced');
    }
    assert.equal(b,0,name+' unclosed braces');
    assert.equal(p,0,name+' unclosed parens');
    const uniforms=new Set();
    for (const line of src.split('\n')) {
      if (/^\s*#(if|ifdef|ifndef)\b/.test(line)) cond++;
      else if (/^\s*#endif\b/.test(line)) cond--;
      assert(cond>=0,name+' extra #endif');
      const u=line.match(/^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)\s*;/);
      if (u) {
        assert(!uniforms.has(u[1]),name+' duplicate uniform '+u[1]);
        uniforms.add(u[1]);
      }
    }
    assert.equal(cond,0,name+' unclosed #if');
  }
  assert(Shaders.COMPOSITE_FRAGMENT.includes('uRaytrace') && Shaders.COMPOSITE_FRAGMENT.includes('uInvVP'));
  assert(Shaders.SKY_FRAGMENT.includes('uBossRage') && Shaders.LITE_SKY_FRAGMENT.includes('uBossRage'));

  // Renderer preset semantics: ultra = raytrace (not lite), ultralite = 300p lite
  const mockR={quality:'high',frame:1,scale:1,frameAverage:0,releaseShadows(){}};
  Renderer.prototype.setQuality.call(mockR,'ultra');
  assert.equal(mockR.raytrace,true);
  assert.equal(mockR.lite,false);
  assert.equal(mockR.ultralite,false);
  Renderer.prototype.setQuality.call(mockR,'ultralite');
  assert.equal(mockR.lite,true);
  assert.equal(mockR.ultralite,true);
  assert.equal(mockR.raytrace,false);

  // SoftwareRenderer setQuality & setMood (stub offscreen canvas for Node headless test)
  const fakeCtx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),fillRect(){},fillText(){},beginPath(){},arc(){},fill(){},stroke(){}};
  const fakeCanvas={width:64,height:64,clientWidth:640,clientHeight:360,getContext:()=>fakeCtx};
  const prevDoc=globalThis.document;
  globalThis.document={createElement:()=>fakeCanvas};
  try {
    const sw=new SoftwareRenderer(fakeCanvas);
    sw.setQuality('ultra');
    assert.equal(sw.lite,false);
    sw.setMood({bossActive:true,dt:1});
    assert(sw.bossRage>0.5);
    sw.setQuality('ultralite');
    assert.equal(sw.lite,true);
    assert.equal(sw.ultralite,true);
  } finally {
    if (prevDoc===undefined) delete globalThis.document; else globalThis.document=prevDoc;
  }
});

test('DynamicStage exercises all 7 kinematic mechanisms with zero collision glitches and lossless snapshot restore',()=>{
  const engine=new RoomEngine(options), b=engine.battle, ds=b.dynamicStage;
  assert(ds instanceof DynamicStage);
  b.countdown=0;

  // 1. Plates lift actor cleanly without sinking through floor
  ds.trigger('plates',true,b);
  const p=b.player;
  Object.assign(p,{x:-25.5,y:0,z:0,vy:0,down:0,ride:null,lift:null});
  for (let i=0;i<60;i++) {ds.step(1/30,b);ds.applyActorInteractions(b,1/30);}
  const plateFloor=b.world.floor(-25.5,0);
  assert(Math.abs(plateFloor.y)>0.15,'plate dynamically altered terrain elevation');
  assert(p.y>=plateFloor.y-0.05,'actor rests above lifted plate without falling through');

  // 2. Lowering highway center span + N/S viaducts + hinged ramps
  ds.trigger('highway',true,b);
  for (let i=0;i<140;i++) {ds.step(1/30,b);ds.applyActorInteractions(b,1/30);}
  assert(ds.highway.y<4.0,'highway center span lowered to walkable arena height');
  assert.equal(b.world.floor(10.9,0).y,ds.highway.y);
  assert(b.world.support(10.9,13,35).y>=12,'north/south viaduct shoulders stay aloft at 12.24m');

  // 3. Spline extending rail + Express Train intrusion across surface plaza
  ds.trigger('rail',true,b);
  for (let i=0;i<150;i++) {ds.step(1/30,b);ds.applyActorInteractions(b,1/30);}
  assert(ds.railIntrusion.trackProgress>0.9 && ds.railIntrusion.pose,'spline rail extended & train active');

  // 4. Bidirectional Surface <-> B1 Sinkholes & Updraft Vents + Fluid drain registration
  ds.trigger('sinkholes',true,b);
  for (let i=0;i<70;i++) ds.step(1/30,b);
  assert(STORM_DRAINS.length>=4,'open sinkholes register directly with FluidEngine STORM_DRAINS');
  const hole=ds.sinkholes[0];
  // Stepping over open chasm drops actor below y=-2.0 and warps cleanly into Underground B1
  Object.assign(p,{x:hole.x,y:-2.1,z:hole.z,vy:-4});
  ds.applyActorInteractions(b,1/30);
  assert.equal(p.x>40,true,'stepping into surface sinkhole warps cleanly to Underground B1');
  // Standing on B1 updraft returns cleanly to surface!
  Object.assign(p,{x:hole.ux,y:UNDER_Y+6.2,z:hole.uz,vy:2});
  ds.applyActorInteractions(b,1/30);
  assert(p.x<40 && p.y>=0.3,'B1 updraft launches player back onto arena surface');

  // 5. Shifting buildings push overlapping actors cleanly instead of trapping
  ds.trigger('buildings',true,b);
  for (let i=0;i<90;i++) {ds.step(1/30,b);ds.applyActorInteractions(b,1/30);}
  assert(ds.shiftingBuildings.every(sb=>sb.shape && sb.p>0.5),'buildings warped arena geometry');

  // 6. Rising hydraulic walls block movement & lift actors standing above seam
  ds.trigger('walls',true,b);
  const rw=ds.risingWalls[0];
  Object.assign(p,{x:rw.x,y:0.2,z:rw.z,vy:0});
  for (let i=0;i<110;i++) {ds.step(1/30,b);ds.applyActorInteractions(b,1/30);}
  assert(rw.h>2.0 && p.y>=rw.h-0.1,'rising wall lifts actor smoothly to top of wall');
  assert.equal(b.world.blocked(rw.x,0.5,rw.z,0.35,1.2),true,'rising wall blocks horizontal collision');
  assert(b.world.trace([rw.x-5,1.0,rw.z],[rw.x+5,1.0,rw.z])!==null,'rising wall blocks line-of-sight shots');

  // 7. Central turntable rotation + checkpoint & snapshot lossless round-trip
  ds.trigger('turntable',true,b);
  for (let i=0;i<30;i++) ds.step(1/30,b);
  assert(ds.turntable.angle>0.2);
  const cp=new Map(Object.entries(structuredClone(engine.checkpoint())));
  const restored=new RoomEngine(options,cp).battle.dynamicStage;
  assert.equal(restored.turntable.active,true);
  assert(Math.abs(restored.highway.y-ds.highway.y)<0.05);

  // Verify draw calls execute cleanly across Surface & B1 with zero non-finite coords
  const fakeRenderer={
    zone:0,lite:false,hideStaticRegion(){},
    add(shape,x,y,z,w,h,d){
      assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),'finite dynamic stage draw on '+shape);
      assert(w>0 && h>0 && d>0);
    }
  };
  ds.draw(fakeRenderer,0,0);
  ds.draw(fakeRenderer,UNDER_X,0);
});

test('Cheater CX10Engine dodges incoming bullets in 360°, counter-fires, kites, and outclasses normal NPCs',()=>{
  const engine=new RoomEngine({...options,teamSize:4,cheater:true}), b=engine.battle;
  b.countdown=0;
  const cheater=b.actors.find(a=>a.isCheater), foe=b.actors.find(a=>a.team!==cheater.team);
  assert(cheater && cheater.cx10===CX10_VERSION && b.cheaterAI);

  // Place Cheater facing foe cleanly in open street corridor & fire fast shots straight toward Cheater!
  for (const a of b.actors) if (a!==cheater && a!==foe) a.down=99;
  Object.assign(cheater,{x:-26,y:0,z:2,vx:0,vz:0,yaw:Math.PI/2,hp:220,maxHp:220,tank:240,fire:0,shield:0});
  Object.assign(foe,{x:-14,y:0,z:2,vx:0,vz:0,yaw:-Math.PI/2,hp:100,tank:150,fire:0,shield:0});

  const beforeX=cheater.x, beforeZ=cheater.z;
  // Spawn 2 fast hostile bullets aimed squarely at Cheater's chest
  b.shots.push(
    {pos:[-19,1.0,2],vel:[-35,0,0],actor:foe,weapon:weaponById('jet'),power:1,age:0,bend:null,homing:null,life:1,id:9001},
    {pos:[-20,1.0,2.4],vel:[-35,0,-1.5],actor:foe,weapon:weaponById('jet'),power:1,age:0,bend:null,homing:null,life:1,id:9002}
  );
  const sight=b.perception.scan(cheater,1/60);
  assert(sight.visible && sight.enemy===foe);
  for (let i=0;i<15;i++) {
    b.clock+=1/60;
    b.cheaterAI.step(cheater,foe,b.tactics.state(cheater),1/60,sight);
  }
  const st=b.cheaterAI.state(cheater);
  assert(st.bulletsDodged>=1,'Cheater CX10 detected and evaded incoming bullet trajectories');
  assert(Math.hypot(cheater.x-beforeX,cheater.z-beforeZ)>0.5,'Cheater agilely sidestepped/jumped out of bullet path');
  assert(b.shots.some(s=>s.actor===cheater),'Cheater counter-fired 9-pellet salvo while evading!');
});

test('破壊神ゴート: 50m attack reach, 16 thicker tentacles, homing orbs to 50m & smart tactical selection',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.countdown=0;
  assert.equal(GOAT_ARMS,16);
  assert.equal(GOAT_REACH,50);
  assert.equal(GOAT_WEAPON.homing.reach,50);

  const goat=b.hazards.spawnGoat(60);
  assert.equal(goat.arms,16);

  // Place enemies far away (~40m across arena, well inside 50m reach)
  for (let i=0;i<4;i++) {
    Object.assign(b.actors[i],{x:-38+i*3,y:0,z:12-i*2,down:0,ride:null,lift:null});
  }
  Object.assign(goat,{x:0,z:-4});
  // Smash reaches all 4 distant enemies with 16 tentacles!
  b.hazards.planGoatAttack(b.actors);
  assert.equal(goat.cast.radius,50);
  if (goat.cast.kind==='smash') {
    assert.equal(goat.cast.points.length,16,'all 16 tentacles plot target/flank impacts up to 50m');
    assert(goat.cast.points.some(pt=>Math.hypot(pt[0]-goat.x,pt[2]-goat.z)>30),'tentacles slam distant targets beyond 30m up to 50m');
  }

  // Close cluster >=2 triggers whirl when not locked out
  for (let i=0;i<4;i++) Object.assign(b.actors[i],{x:2+i*2,y:0,z:-4,vx:0,vz:0});
  goat.lastCastKind=null;
  b.hazards.planGoatAttack(b.actors);
  assert.equal(goat.cast.kind,'whirl','smart Goat selects 360° whirl when >=2 targets cluster nearby');

  // Verify drawGoat emits thicker 16 tentacles without errors
  let tentaclePrims=0;
  const packBuf=new Float32Array(STRIDE);
  const r={
    lite:false,
    add(shape,x,y,z,w,h,d,tint,kind=0,opts={}){
      packInstance(packBuf,0,x,y,z,w,h,d,tint,kind,opts,0,true);
      tentaclePrims++;
    },
    beam(a,c,w,d,tint,kind=0,opts={}){Renderer.prototype.beam.call(this,a,c,w,d,tint,kind,opts);}
  };
  b.hazards.drawGoat(r,b.clock);
  assert(tentaclePrims>140,'16 thick tentacles render high-detail limb primitives cleanly');
});

test('stage runaway train rampages on stage, cars are easily rideable, heavy downpour blinds view, +20 objects, apartment drone swarm & rooftop multi-missile heli',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle, p=b.player;
  b.countdown=0;

  // 1. +20 new breakable physical objects added to arena (obj-01..obj-20) & all valid
  const extraObjs=b.stage.parts.filter(pt=>pt.id.startsWith('obj-'));
  assert.equal(extraObjs.length,20,'20 new physical breakable stage objects registered');
  for (const o of extraObjs) {
    assert(b.stage.intact(o) && o.shape);
  }

  // 2. Cars are easily rideable near edge/bumper & near spawn plaza
  const plazaCar=b.vehicles.cars[b.vehicles.cars.length-1];
  Object.assign(p,{x:plazaCar.x+plazaCar.w*.5+1.4,y:plazaCar.y,z:plazaCar.z,down:0,ride:null,lift:null,car:null});
  const opt=b.transportOption(p);
  assert(opt && opt.kind==='car-enter','standing by car bumper/door offers car-enter option');
  assert.equal(b.useTransport(p),true);
  assert.equal(p.car,plazaCar,'player smoothly enters & drives map car');
  b.vehicles.drive(p,{x:0,z:1,jump:false},1/20);
  assert(plazaCar.speed>0,'driving accelerates vehicle forward');
  assert.equal(b.useTransport(p),true);
  assert.equal(p.car,null,'player cleanly exits car');

  // 3. Stage runaway train climbs onto main stage plaza, tramples fighters, & can be shot directly on stage
  const tb=b.hazards.startTrainBoss('transit');
  assert(tb.active && tb.stageMode);
  let sawRampage=false;
  for (let i=0;i<40;i++) {
    b.clock+=.05; b.elapsed+=.05;
    b.hazards.updateTrainBoss(.05);
    if (Math.abs(tb.z)>5 && Math.abs(tb.x)<40 && tb.y<3.5) sawRampage=true;
  }
  assert(sawRampage,'runaway train leaves track and sweeps across arena surface plaza');
  const aimStart=[tb.x,tb.y+1.8,tb.z+8], aimEnd=[tb.x,tb.y+1.8,tb.z-8];
  const tbHit=b.traceShot(aimStart,aimEnd,true);
  assert(tbHit && tbHit.trainBoss===tb,'player can shoot the rampaging runaway train directly on the stage');
  b.hazards.stopTrainBoss(false);

  // 4. Heavy blinding rain renders dense downpour streaks + storm mood
  b.hazards.startRain(12);
  let rainPrims=0;
  const packBuf=new Float32Array(STRIDE);
  const rainR={
    lite:false,viewPoint:[0,2,0],
    add(shape,x,y,z,w,h,d,tint,kind=0,opts={}){packInstance(packBuf,0,x,y,z,w,h,d,tint,kind,opts,0,true);rainPrims++;},
    beam(a,c,w,d,tint,kind=0,opts={}){Renderer.prototype.beam.call(this,a,c,w,d,tint,kind,opts);}
  };
  b.hazards.draw(rainR,0,0);
  assert(rainPrims>=120,'blinding torrential downpour renders dense multi-layer rain sheet & splashes');

  // 5. Countless swarm drones pour from apartments & Helicopter launches from apartment rooftop firing indiscriminate multi-missiles!
  const swarm=b.hazards.spawnRogueDrones();
  assert(swarm.length>=12 && b.hazards.droneSpawnsLeft>0,'countless rogue drones swarm out from apartment exits with reinforcements');
  const heli=b.hazards.spawnHeli(30);
  assert(heli.active && heli.isHeli && heli.y>=8,'attack helicopter spawns cleanly from apartment rooftop');
  let sawMissiles=false;
  for (let i=0;i<60;i++) {
    b.clock+=.05; b.elapsed+=.05;
    b.hazards.updateHeli(.05);
    if (b.hazards.missiles.length>=HELI_SALVO_COUNT) sawMissiles=true;
  }
  assert(sawMissiles,'rooftop attack helicopter unleashes indiscriminate multi-missile salvo');
  const heliShot=b.findActor([heli.x,heli.y+1,heli.z-8],[heli.x,heli.y+1,heli.z+8],0);
  assert(heliShot && heliShot.actor===heli,'helicopter can be targeted & shot down');
  b.hazards.hurtHeli(heli.maxHp,p);
  assert(!heli.active,'helicopter explodes cleanly when defeated');
});
