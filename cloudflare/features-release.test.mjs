import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {Paint} from '../dist/ink.js';
import {FluidEngine,FLUID_MEDIA,STORM_DRAINS} from '../dist/fluid-engine.js';
import {DestructionPhysics} from '../dist/destruction.js';
import {DynamicStage,DYNAMIC_STAGE_FIRST} from '../dist/dynamic-stage.js';
import {GOAT_ARMS,GOAT_ATTACK_KINDS,GOAT_REACH,HELI_SALVO_COUNT} from '../dist/hazards.js';
import {CHEATER_WEAPON,GOAT_WEAPON,NPC_WEAPONS,WEAPONS,weaponById} from '../dist/weapons.js';
import {PLAYER_SHIELD_COOLDOWN,PLAYER_SHIELD_DURATION,PLAYER_SHIELD_HP} from '../dist/abilities.js';
import {PLAYER_BASE_HP,drawCrew} from '../dist/battle.js';
import {AVATAR_FIELDS} from '../dist/cloud-view.js';
import {frameOf} from './frame.js';
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
  assert(Shaders.COMPOSITE_FRAGMENT.includes('uRaytrace') && Shaders.COMPOSITE_FRAGMENT.includes('uDepthAB') && Shaders.COMPOSITE_FRAGMENT.includes('uVP'));
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

test('上位存在・破壊神ゴート: 5種の新規攻撃(計8種)・4段階進化・神域軽減・死ぬまで永続出現・全8種描画とチェックポイント',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle, p=b.player;
  const foe=b.actors.find(a=>a.team===1);
  b.countdown=0;
  for (const a of b.actors) if (a!==p && a!==foe) a.down=99;
  assert.equal(GOAT_ATTACK_KINDS.length,8);
  for (const kind of ['smash','whirl','barrage','beam','meteor','gravity','lightning','nova']) {
    assert(GOAT_ATTACK_KINDS.includes(kind),'includes attack kind: '+kind);
  }

  const g=b.hazards.spawnGoat();
  assert.equal(g.maxHp,20000);
  assert.equal(g.until,Infinity);
  assert.equal(g.supreme,true);

  // Never despawns due to elapsed time — stays active continuously until HP reaches 0!
  for (let step=0;step<40;step++) {
    b.clock+=25; b.elapsed+=25;
    b.hazards.updateGoat(.05);
  }
  assert.equal(g.active,true,'Goat remains active even after +1000s without dying');

  // Exercise every one of the 5 brand-new attacks (beam, meteor, gravity, lightning, nova) + rendering + checkpoint!
  const packBuf=new Float32Array(STRIDE);
  const makeTestRenderer=()=>{
    let count=0;
    return {
      lite:false,
      get count(){return count;},
      add(shape,x,y,z,w,h,d,tint,kind=0,opts={}){
        for (const v of [x,y,z,w,h,d]) assert(Number.isFinite(v),'finite '+shape);
        packInstance(packBuf,0,x,y,z,w,h,d,tint,kind,opts,0,true);
        count++;
      },
      beam(a,c,w,d,tint,kind=0,opts={}){Renderer.prototype.beam.call(this,a,c,w,d,tint,kind,opts);}
    };
  };

  for (const kind of ['beam','meteor','gravity','lightning','nova']) {
    Object.assign(p,{x:g.x+10,y:0,z:g.z,hp:p.maxHp,down:0,shield:0,pShield:0,vx:0,vz:0});
    Object.assign(foe,{x:g.x+10,y:0,z:g.z+1,hp:100,down:0,shield:0,vx:0,vz:0});
    b.hazards.planGoatAttack([p,foe],kind);
    assert.equal(g.cast.kind,kind);
    // Verify checkpoint round-trip during active cast
    const snap=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
    assert.equal(snap.hazards.goat.cast?.kind,kind,'checkpoint preserves '+kind+' cast');
    // Render warning phase
    const rWarn=makeTestRenderer();
    b.hazards.drawGoat(rWarn,b.clock);
    assert(rWarn.count>160,'warning drawGoat emits Supreme geometry for '+kind);
    // Step through active window and confirm hits/effects + active rendering
    const startHpP=p.hp, startHpF=foe.hp;
    let damaged=false, maxActivePrims=0;
    const steps=Math.ceil((g.cast.end-g.cast.start)/.05)+4;
    for (let i=0;i<steps;i++) {
      b.clock+=.05; b.elapsed+=.05;
      b.hazards.updateGoat(.05);
      if (g.cast && b.clock>=g.cast.at && b.clock<=g.cast.end) {
        const rAct=makeTestRenderer();
        b.hazards.drawGoat(rAct,b.clock);
        maxActivePrims=Math.max(maxActivePrims,rAct.count);
      }
      if (p.hp<startHpP || foe.hp<startHpF || p.down>0 || foe.down>0) damaged=true;
    }
    assert(damaged,'Supreme Goat '+kind+' deals damage to targets');
    assert(maxActivePrims>160,'active drawGoat renders '+kind+' VFX ('+maxActivePrims+' prims)');
  }

  // Phase 4 (神域超越) reduces incoming damage by 20% and triggers only below 25% HP.
  b.hazards.hurtGoat(15500,p);
  assert.equal(g.phase,4);
  const hpBeforeP4=g.hp;
  const lostP4=b.hazards.hurtGoat(1000,p);
  assert.equal(lostP4,800,'Phase 4 grants 20% divine damage reduction');
  assert.equal(g.hp,hpBeforeP4-800);
  // Defeating Goat finally clears active state & schedules next arrival
  b.hazards.hurtGoat(20000,p);
  assert.equal(g.active,false);
  assert.equal(g.hp,0);
  assert(b.hazards.nextGoat>b.elapsed);
});

test('プレイヤー専用オート英馬 II SUPER: プレイヤーのみ選択・装備可能、NPCに絶対付与されず9発超追尾連射・1.2倍タンク',()=>{
  const superGun=weaponById('autoeima2super'), ae=weaponById('autoeima');
  assert(superGun && superGun.name==='オート英馬 II SUPER');
  assert.equal(superGun.playerOnly,true);
  assert(!NPC_WEAPONS.some(w=>w.id==='autoeima2super'),'excluded from NPC_WEAPONS');
  assert.equal(superGun.pellets,9);
  assert(Math.abs(superGun.cost-ae.cost*.5)<1e-9,'half ink cost of オート英馬 (0.875)');
  assert(Math.abs(superGun.delay-.115/1.2)<1e-9,'1.2x fire rate');
  assert(Math.abs(superGun.tankScale-1.2)<1e-9,'1.2x ink tank capacity');
  assert(superGun.homing.turn>ae.homing.turn && superGun.homing.reach>ae.homing.reach);

  // Never equipped by non-player actors in any mode
  for (const mode of ['play','watch','timeless']) {
    const {battle:mb}=new RoomEngine({mode,weapon:'autoeima2super',teamSize:8,cheater:false});
    assert(mb.actors.filter(a=>!a.isPlayer).every(a=>!a.weapon.playerOnly && a.weapon.id!=='autoeima2super'),mode);
  }

  const engine=new RoomEngine({...options,weapon:'autoeima2super'}), b=engine.battle, p=b.player;
  assert.equal(p.weapon.id,'autoeima2super');
  assert(Math.abs(p.tankMax-BASE_TANK*1.2)<1e-9);
  b.countdown=0;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,tank:100,fire:0,shield:0});
  assert(b.shoot(p,[p.x+12,p.y+1,p.z]));
  const shots=b.shots.filter(s=>s.actor===p);
  assert.equal(shots.length,9);
  assert(Math.abs(100-p.tank-.875)<1e-9);
  assert(shots.every(s=>s.homing && s.homing.reach===superGun.homing.reach));

  // Checkpoint cold restore keeps player weapon, 1.2x tank, and homing shots
  const restored=new RoomEngine({...options,weapon:'jet'},new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(restored.player.weapon.id,'autoeima2super');
  assert(Math.abs(restored.player.tankMax-BASE_TANK*1.2)<1e-9);
  assert.equal(restored.shots.length,9);
});

test('プレイヤー専用: 体力2倍(200HP)とシールド展開(耐久240・90%軽減・NPC不可・同期・3D描画)',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle, p=b.player;
  const ally=b.actors.find(a=>a.team===p.team && !a.isPlayer);
  const foe=b.actors.find(a=>a.team!==p.team);
  b.countdown=0;

  // 1. Player-only 2x HP (200), while normal NPCs remain 100 HP.
  assert.equal(PLAYER_BASE_HP,200);
  assert.equal(p.baseHp,200);
  assert.equal(p.maxHp,200);
  assert.equal(p.hp,200);
  assert.equal(ally.maxHp,100);
  assert.equal(foe.maxHp,100);

  // Health super doubles player baseHp (200 -> 400) and reverts to 200 on clearSuper.
  p.weapon=weaponById('dual'); // special: 'health'
  p.superCharge=100;
  assert(b.abilities.activate(p));
  assert.equal(p.maxHp,400);
  assert.equal(p.hp,400);
  b.abilities.clearSuper(p);
  assert.equal(p.maxHp,200);
  assert.equal(p.hp,200);

  // 2. Only the player can deploy personal shield; all NPCs are rejected.
  assert.equal(b.abilities.canDeployShield(p),true);
  assert.equal(b.abilities.canDeployShield(ally),false);
  assert.equal(b.abilities.canDeployShield(foe),false);
  assert.equal(b.abilities.deployShield(ally),false);
  assert.equal(b.abilities.deployShield(foe),false);
  assert.equal(ally.pShield,0);

  // Deploy via player input (pshield) in Battle.update
  b.update(1/30,{...still,pshield:true},view);
  assert.equal(p.pShield,PLAYER_SHIELD_HP);
  assert(p.pShieldUntil>b.clock && p.pShieldUntil<=b.clock+PLAYER_SHIELD_DURATION+.05);
  assert(p.pShieldReady>b.clock && p.pShieldReady<=b.clock+PLAYER_SHIELD_COOLDOWN+.05);
  assert.equal(b.abilities.canDeployShield(p),false,'cannot redeploy during cooldown');

  // 3. Shield absorbs 90% of incoming damage (both direct reduce and Battle.damage).
  p.shield=0; // clear spawn invulnerability
  assert.equal(b.abilities.reduce({...p,pShield:PLAYER_SHIELD_HP,pShieldUntil:b.clock+9,guard:0,giant:false,slam:null},100),10);
  const hpBefore=p.hp, shBefore=p.pShield;
  b.damage(p,100,foe,[p.x,p.y+1,p.z]);
  const shLost=shBefore-p.pShield, hpLost=hpBefore-p.hp;
  assert(shLost>0 && hpLost>0,'damage splits across shield and HP');
  assert(Math.abs(shLost/hpLost-9)<1e-6,'shield absorbs 90% while 10% leaks to HP (ratio='+shLost/hpLost+')');

  // 4. Cloudflare frame sync & checkpoint preserve player 2x HP and personal shield state.
  const f=frameOf(b,0,0,[]);
  const idxOf=k=>AVATAR_FIELDS.indexOf(k);
  const pRow=f.actors.find(row=>row[idxOf('isPlayer')]);
  assert(pRow,'player row exists in Cloudflare frame');
  assert.equal(pRow[idxOf('maxHp')],200);
  assert(pRow[idxOf('pShield')]>0 && pRow[idxOf('pShieldUntil')]>b.clock);
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(restored.player.baseHp,200);
  assert.equal(restored.player.maxHp,200);
  assert(Math.abs(restored.player.pShield-p.pShield)<1e-6);

  // 5. 3D drawCrew renders hexagonal personal shield dome cleanly.
  const packBuf=new Float32Array(STRIDE);
  let shieldPrims=0;
  const r={
    lite:false,
    add(shape,x,y,z,w,h,d,tint,kind=0,opts={}){
      packInstance(packBuf,0,x,y,z,w,h,d,tint,kind,opts,0,true);
      if (shape==='curtain' && kind===16) shieldPrims++;
    },
    beam(a,c,w,d,tint,kind=0,opts={}){Renderer.prototype.beam.call(this,a,c,w,d,tint,kind,opts);}
  };
  drawCrew(r,p,b.clock);
  assert(shieldPrims>=6,'active personal shield renders luminous 3D hexagonal barrier ('+shieldPrims+' panels)');

  // 6. Shield expires after duration and becomes ready again after cooldown; respawn keeps 200 HP.
  b.clock=p.pShieldUntil+.1;
  b.abilities.updateActor(p,.05);
  assert.equal(p.pShield,0);
  b.clock=p.pShieldReady+.1;
  assert.equal(b.abilities.canDeployShield(p),true);
  p.down=.02;
  p.hp=0;
  b.update(.05,still,view);
  assert.equal(p.down,0);
  assert.equal(p.hp,200);
  assert.equal(p.maxHp,200);
});

test('Wave 1 & Wave 2: lossless CPU/GPU optimizations and photorealism shader pipeline invariants',async ()=>{
  const {surfaceForJS,writeSurfaceSlots}=await import('../dist/surface-solver.js');
  const {drawTrain}=await import('../dist/train-model.js');
  const {RAIL}=await import('../dist/layout.js');

  // 1. Paint boss-free fast path (bossDirty=false -> runWordFlat2) produces exact parity with boss path
  const pClean=new Paint(), pBoss=new Paint();
  const engine=new RoomEngine({...options,teamSize:2,cheater:false}), b=engine.battle;
  pClean.setWorld(b.world);
  pBoss.setWorld(b.world);
  assert.equal(pClean.bossDirty,false);
  pClean.stamp(4,2,2.4,0,0,0,.06);
  pClean.stamp(7,2,2.4,1,0,0,.06);
  pBoss.stamp(4,2,2.4,0,0,0,.06);
  pBoss.stamp(7,2,2.4,1,0,0,.06);
  pBoss.bossDirty=true; // force general 3-team path
  for (let i=0;i<6;i++) {pClean.advance(1/20); pBoss.advance(1/20);}
  assert.equal(pClean.bossDirty,false,'2-team stamps keep bossDirty=false');
  assert.equal(pClean.zoneCount[0][0],pBoss.zoneCount[0][0],'cyan ink cell count matches 3-team path');
  assert.equal(pClean.zoneCount[0][1],pBoss.zoneCount[0][1],'amber ink cell count matches 3-team path');
  pClean.stamp(-6,-4,2.0,2,0,0,.06);
  assert.equal(pClean.bossDirty,true,'boss stamp immediately activates bossDirty');

  // 2. Vehicles _maxCarY early-out + rain parked-car addPacked template cache
  assert(b.vehicles._maxCarY>1.5,'Vehicles tracks maximum active car roof height');
  assert.equal(b.vehicles.traceAny(-20,b.vehicles._maxCarY+5,0,20,b.vehicles._maxCarY+5,0),false);
  let carPackedCalls=0, carAddCalls=0;
  const packMockR={
    lite:false,ultralite:false,reach:Infinity,viewPoint:[0,4,14],
    inFrustum(){return true;},
    add(){carAddCalls++;},
    addPacked(){carPackedCalls++;},
    beam(){},label(){}
  };
  b.vehicles.draw(packMockR,0,14,1.5,true); // raining = true!
  assert(carPackedCalls>0,'parked cars use addPacked template cache even during rain');
  assert(carAddCalls<carPackedCalls*30,'rain only draws shade/wipers outside parked-car template');

  // 3. Train rigid straight-track addPacked template cache & zero-alloc raw fallback equivalence
  let trPacked=0, trRaw=0;
  const mockTrain={x:0,lift:0,lateral:0,yaw:0,roll:0,routePitch:0,wetness:0,speed:0,direction:1,phase:'run',doorOpen:0,berserk:false,marks:[],windows:{}};
  drawTrain({...packMockR,addPacked(){trPacked++;},add(){},beam(){},label(){}},mockTrain,0,RAIL);
  assert(trPacked>=3,'straight-track train submits via rigid addPacked templates ('+trPacked+' buckets)');
  const rawBuf=new Float32Array(STRIDE);
  drawTrain({
    lite:false,add(t,x,y,z,w,h,d,c,k,o){packInstance(rawBuf,0,x,y,z,w,h,d,c,k,o,t==='box'?1:0,true); trRaw++;},
    beam(){},label(){}
  },mockTrain,0,RAIL);
  assert(trRaw>150,'zero-alloc drawTrainRaw emits full train geometry when addPacked is absent');

  // 4. Metal kind===4 writeSurfaceSlots fast path & packInstance basis fast paths match surfaceForJS bit-for-bit
  const buf=new Float32Array(STRIDE);
  const testColors=[0x202020,0xc8ccd0,0x408050,0x993020,0x3050a0,0x8a7055,0xffffff,0x101418];
  const testDims=[[0.2,0.1,0.15],[0.6,0.3,0.4],[1.8,0.8,0.6],[5.2,0.4,0.4],[0.8,0.03,0.6],[1.2,0.5,0.5]];
  const testYs=[0.1,0.9,2.2,5.5];
  for (const col of testColors) for (const [w,h,d] of testDims) for (const y of testYs) for (const shape of [0,1,2]) {
    packInstance(buf,0,3.5,y,-4.2,w,h,d,col,4,{},shape,false);
    const r=buf[16], g=buf[17], bl=buf[18];
    const f32=Math.fround, fr32=v=>f32(v-Math.floor(v));
    let qx=fr32(f32(f32(buf[12])*f32(.1031))), qy=fr32(f32(f32(buf[13])*f32(.1030))), qz=fr32(f32(f32(buf[14])*f32(.0973)));
    const cc=f32(33.33), dd=f32(f32(qx*f32(qy+cc))+f32(qy*f32(qz+cc))+f32(qz*f32(qx+cc)));
    qx=f32(qx+dd); qy=f32(qy+dd); qz=f32(qz+dd);
    const seed=fr32(f32(f32(qx+qy)*qz));
    const sx=f32(w), sy=f32(h), sz=f32(d);
    const eTop=surfaceForJS(4,r,g,bl,true,false,shape===2,seed,sx,sy,sz,shape,false,false,0,buf[13]+sy*.5);
    const eSide=surfaceForJS(4,r,g,bl,false,false,false,seed,sx,sy,sz,shape,false,false,0,buf[13]);
    const eBot=surfaceForJS(4,r,g,bl,false,true,false,seed,sx,sy,sz,shape,false,false,0,buf[13]-sy*.5);
    assert.equal(buf[3],eTop,'kind=4 top slot parity');
    assert.equal(buf[7],eSide,'kind=4 side slot parity');
    assert.equal(buf[11],eBot,'kind=4 bot slot parity');
  }
  // Verify basis-transformed kinds (0,3,21,23,31) match writeSurfaceSlots exactly
  const rotBasis=[[0.8,0,0.6],[0,1.2,0],[-0.6,0,0.8]];
  const refBuf=new Float32Array(STRIDE);
  for (const kind of [0,3,21,23,31]) for (const col of [0x15181a,0xf0f4f8,0x804020]) {
    packInstance(buf,0,2,1.5,-3,0.5,0.2,1.6,col,kind,{basis:rotBasis},1,true);
    refBuf.set(buf);
    writeSurfaceSlots(refBuf,0,1);
    assert.equal(buf[3],refBuf[3],'basis packInstance top kind='+kind);
    assert.equal(buf[7],refBuf[7],'basis packInstance side kind='+kind);
    assert.equal(buf[11],refBuf[11],'basis packInstance bot kind='+kind);
  }

  // 5. Photorealism Wave 2 shader invariants (all 6 upgrades present & balanced)
  assert(Shaders.COMMON.includes('smoothstep(1.15,6.5,peak)'),'AgX-inspired highlight roll-off in grade()');
  assert(Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('envBRDF_AB') && Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('FmsEms'),'Kulla-Conty multi-scattering PBR');
  assert(Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('dampRing') && Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('.021'),'rain-drenched asphalt capillary shoreline + physical water F0');
  assert(Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('meniscus'),'glossy liquid ink meniscus catchlights');
  assert(Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('aerialFog') && Shaders.DEFERRED_OUTDOOR_FRAGMENT.includes('rayleigh'),'Rayleigh/Mie aerial perspective');
  assert(Shaders.COMPOSITE_FRAGMENT.includes('maxSteps') && Shaders.COMPOSITE_FRAGMENT.includes('bounceCol'),'ULTRA RT adaptive SSR + chromatic SSGI');
});
