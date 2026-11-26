import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {BOSS_RESPAWN_SECONDS,EXP_PER_KILL,RESPAWN_SECONDS} from '../dist/battle.js';
import {bankResults,levelOf,loadCareer,matchResults,mostActive} from '../dist/progress.js';
import {DRONE_WEAPON,CHEATER_WEAPON,EBOT,GOAT_WEAPON,NPC_WEAPONS,ROGUE_DRONE_WEAPON,SNIPER_WEAPON,SUPERS,WEAPONS,weaponById} from '../dist/weapons.js';
import {BASE_TANK,CABIN_X,RAIL,UNDER_X,UNDER_Y} from '../dist/layout.js';
import {GOAT_ARMS} from '../dist/hazards.js';
import {HNV1_GAIN,HNV1_VERSION} from '../dist/hnv1.js';
import {optionsFor} from './edge.js';
import {SCENE_FRAGMENT,LITE_FRAGMENT} from '../dist/render-shaders.js';
import {SURFACES,SURFACE_SHEETS,sheetPrompt} from '../dist/surfaces.js';
import {Renderer,STRIDE,packInstance} from '../dist/render.js';
import {surfaceForJS,writeSurfaceSlots} from '../dist/surface-solver.js';

const options={mode:'play',weapon:'jet',teamSize:4};
const still={x:0,z:0,yaw:Math.PI/2,pitch:-.14};
const camera=()=>({eye:[10,1.1,-16],target:[15,1.1,-16]});
const alone=(b,...keep)=>{for (const a of b.actors) if (!keep.includes(a)) a.down=99;};

test('a splat keeps a crew member out for 12 seconds, a boss splat for 15',()=>{
  const {battle:b}=new RoomEngine(options), victim=b.actors[2], crushed=b.actors[3];
  b.countdown=0;
  Object.assign(victim,{shield:0,hp:4});
  Object.assign(crushed,{shield:0,hp:4});
  b.damage(victim,300,b.actors[0],[victim.x,victim.y+1,victim.z]);
  b.damage(crushed,300,null,[crushed.x,crushed.y+1,crushed.z],'boss');
  assert.equal(victim.down,RESPAWN_SECONDS);
  assert.equal(crushed.down,BOSS_RESPAWN_SECONDS);
  assert.deepEqual([RESPAWN_SECONDS,BOSS_RESPAWN_SECONDS],[12,15]);
  assert.equal(victim.downBy,'crew');
  assert.equal(crushed.downBy,'boss');
  for (let t=0;t<11.8;t+=.2) b.update(.2,still,camera);
  assert(victim.down>0 && crushed.down>0);
  for (let t=0;t<.6;t+=.2) b.update(.2,still,camera);
  assert(victim.down<=0 && victim.hp===100 && crushed.down>0);
  for (let t=0;t<3;t+=.2) b.update(.2,still,camera);
  assert(crushed.down<=0);
});

test('EXP is 30 per splat, counted after the match for every crew member, and banked by name',()=>{
  const {battle:b}=new RoomEngine({...options,teamSize:8}), saved=new Map();
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>saved.get(key) ?? null,setItem:(key,value)=>saved.set(key,value)}});
  try {
    b.player.kills=3;
    b.actors[9].kills=1;
    const rows=matchResults(b,b.paint);
    assert.equal(rows.length,16);
    assert.equal(rows.find(row=>row.isPlayer).exp,3*EXP_PER_KILL);
    assert.equal(rows.find(row=>row.name===b.actors[9].name).exp,EXP_PER_KILL);
    assert(rows.every(row=>['kills','downs','area','dealt','supers','subs','weapon'].every(key=>key in row)));
    assert.equal(mostActive(rows).isPlayer,true);
    bankResults(rows);
    const career=bankResults(rows);
    assert.equal(career.matches,2);
    assert.equal(career.exp.YOU,180);
    assert.equal(loadCareer().exp[b.actors[9].name],60);
    assert.deepEqual([levelOf(0),levelOf(299),levelOf(300)],[1,1,2]);
  } finally {
    if (previous) Object.defineProperty(globalThis,'localStorage',previous);
    else delete globalThis.localStorage;
  }
});

test('the drone fires one tracking round a second at an opponent in view',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, foe=b.actors[4];
  alone(b,p,foe);
  b.countdown=0;
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,shield:0});
  Object.assign(foe,{x:15,y:0,z:-16,shield:0,hp:100});
  assert(b.abilities.summon(p));
  let fired=0, last=-Infinity, gaps=[];
  for (let t=0;t<3.6;t+=1/24) {
    const before=b.shots.filter(shot=>shot.weapon===DRONE_WEAPON).length;
    b.abilities.update(1/24);
    b.clock+=1/24;
    const now=b.shots.filter(shot=>shot.weapon===DRONE_WEAPON);
    if (now.length>before) {
      fired++;
      if (Number.isFinite(last)) gaps.push(b.clock-last);
      last=b.clock;
      const shot=now.at(-1);
      assert(shot.homing && shot.homing.turn>0);
    }
    b.updateShots(1/24);
  }
  assert(fired>=3,'fired '+fired);
  // Never faster than one a second; a moment out of sight only delays a round.
  assert(gaps.every(gap=>gap>.99) && gaps.filter(gap=>gap<1.01).length>=1,gaps.join());
  assert(foe.hp<100);
});

test('RD II QUATRO+ fires five high-damage heavy rounds rapidly with wide paint, halved cost and boosted mobility',()=>{
  const rd=weaponById('rd2'), jet=weaponById('jet');
  assert.equal(rd.pellets,5);
  assert(Math.abs(rd.delay-.22)<1e-9);
  assert(Math.abs(rd.damage-70.4)<1e-9);
  assert(Math.abs(rd.cost-.3)<1e-9);
  assert(Math.abs(rd.radius-10)<1e-9);
  assert(Math.abs(rd.weight-1.52)<1e-9);
  assert(rd.damage*rd.pellets>jet.damage*12 && rd.radius>jet.radius && rd.cost<jet.cost*5);
  assert.equal(SUPERS[rd.special].name,'OM BOMB II');
  const walked=weapon=>{
    const {battle:b}=new RoomEngine({...options,weapon:weapon.id}), p=b.player;
    alone(b,p);
    Object.assign(p,{x:-44,y:0,z:3});
    const x=p.x;
    for (let i=0;i<24;i++) b.walk(p,{...still,z:1},1/24);
    return p.x-x;
  };
  const ratio=walked(rd)/walked(jet);
  assert(Math.abs(ratio-rd.weight)<.03,ratio);
  const {battle:b}=new RoomEngine({...options,weapon:'rd2'}), p=b.player;
  Object.assign(p,{x:-44,y:0,z:3,fire:0});
  assert(b.shoot(p,[p.x+8,p.y+1,p.z]));
  assert.equal(b.shots.length,5);
  assert(Math.abs(p.fire-rd.delay)<1e-9);
  assert.equal(p.tank,150-rd.cost);
});

test('the TD shock cannon blasts a cone in one shot without leaving rounds in flight',()=>{
  const {battle:b}=new RoomEngine({...options,weapon:'td'}), p=b.player, front=b.actors[4], side=b.actors[5];
  alone(b,p,front,side);
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,fire:0,shield:0});
  Object.assign(front,{x:15,y:0,z:-15.6,shield:0,hp:100});
  Object.assign(side,{x:10.2,y:0,z:-11,shield:0,hp:100});
  const painted=p.painted;
  assert(b.shoot(p,[20,1,-16]));
  assert.equal(b.shots.length,0);
  assert(front.hp<100,'front '+front.hp);
  assert.equal(side.hp,100);
  assert(p.painted>painted);
  assert(b.abilities.rings.some(ring=>ring.half>0));
  assert.equal(SUPERS[weaponById('td').special].name,'ebot');
});

test('OM Bomb makes rounds track; OM BOMB II fires each round twice at half strength',()=>{
  const {battle:b}=new RoomEngine({...options,weapon:'coil'}), p=b.player, foe=b.actors[4];
  alone(b,p,foe);
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,fire:0,superCharge:100});
  assert.equal(p.weapon.special,'om');
  assert(b.abilities.activate(p));
  assert(b.shoot(p,[20,1,-16]));
  assert(b.shots.length>0 && b.shots.every(shot=>shot.homing && !shot.dmg));
  // A round aimed past a target bends toward it.
  Object.assign(foe,{x:18,y:0,z:-14.6,shield:0});
  const shot=b.shots[0], before=Math.atan2(shot.vel[2],shot.vel[0]);
  b.guideShot(shot,.1);
  const after=Math.atan2(shot.vel[2],shot.vel[0]);
  assert(after>before,'turned '+(after-before));
  const two=new RoomEngine({...options,weapon:'rd2'}).battle, q=two.player;
  alone(two,q);
  Object.assign(q,{x:-44,y:0,z:3,fire:0,superCharge:100});
  assert(two.abilities.activate(q));
  assert(two.shoot(q,[q.x+8,q.y+1,q.z]));
  assert.equal(two.shots.length,10);
  assert(two.shots.every(round=>round.dmg===.5 && round.homing));
});

test('ebot calls two weaker copies that fight, earn no splats and leave after 20 seconds',()=>{
  const engine=new RoomEngine({...options,weapon:'td'}), b=engine.battle, p=b.player, foe=b.actors[4];
  alone(b,p,foe);
  Object.assign(p,{x:-44,y:0,z:3,yaw:Math.PI/2,superCharge:100});
  assert(b.abilities.activate(p));
  const copies=b.actors.filter(a=>a.cloneOf===p);
  assert.equal(copies.length,EBOT.count);
  assert(copies.every(copy=>copy.hp===60 && copy.maxHp===60 && copy.damageFactor===.5 && copy.team===p.team && !copy.isPlayer));
  assert(copies.every(copy=>Math.abs(copy.paintFactor**2-.5)<1e-9));
  assert(!b.abilities.canActivate(copies[0]) && !b.subweapons.canUse(copies[0]) && !b.abilities.summon(copies[0]));
  // Copies survive a cold restore with their caster.
  const restored=new RoomEngine({...options,weapon:'td'},new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(restored.actors.length,b.actors.length);
  assert.equal(restored.actors.filter(a=>a.cloneOf===restored.player).length,2);
  // Splatting a copy is no kill; it leaves at once.
  Object.assign(copies[0],{shield:0});
  const kills=foe.kills;
  b.damage(copies[0],400,foe,[copies[0].x,copies[0].y+1,copies[0].z]);
  assert.equal(foe.kills,kills);
  b.retireClones();
  assert.equal(b.actors.filter(a=>a.cloneOf===p).length,1);
  copies[1].painted=40;
  const painted=p.painted;
  b.clock+=SUPERS.ebot.seconds+.1;
  b.retireClones();
  assert.equal(b.actors.filter(a=>a.cloneOf).length,0);
  assert.equal(p.painted,painted+40);
});

test('a finishing ink hit is marked for the larger splat effect',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, foe=b.actors[4];
  Object.assign(foe,{shield:0,hp:6});
  b.inkHit(foe,10,p,[foe.x,foe.y+1,foe.z]);
  assert.equal(b.inkImpacts.at(-1).kind,1);
  b.clock+=.01;
  b.inkHit(foe,300,p,[foe.x,foe.y+1,foe.z]);
  assert.equal(b.inkImpacts.at(-1).kind,2);
});

test('171 textures in nineteen 3×3 sheets, every one of them used by the city shader',()=>{
  assert.equal(SURFACE_SHEETS.length,19);
  assert(SURFACE_SHEETS.every(sheet=>sheet.cells.length===9));
  assert.equal(new Set(SURFACES.map(surface=>surface.id)).size,171);
  // Exact-period crops tile as they are, so they must be patterns with a crop.
  for (const surface of SURFACES) if (surface.repeat) assert(surface.pattern && surface.crop,surface.id+' repeat');
  for (const surface of SURFACES) if (surface.crop) {
    const [left,top,right,bottom]=surface.crop;
    assert(left>=0 && top>=0 && right<=1 && bottom<=1 && right-left>.3 && bottom-top>.3,surface.id+' crop');
  }
  for (const surface of SURFACES) {
    const name='S_'+surface.id.toUpperCase();
    assert(SCENE_FRAGMENT.split(name).length>2,surface.id+' is never picked');
    assert(surface.meters>0 && surface.take>=0 && surface.take<=1);
  }
  assert(LITE_FRAGMENT.includes('surfaceFor('));
  for (const sheet of SURFACE_SHEETS) {
    const prompt=sheetPrompt(sheet);
    assert(prompt.includes('3×3') && /No borders.*text/.test(prompt));
    assert(sheet.cells.every(cell=>prompt.includes(cell.prompt)));
  }
});

test('SW OUT: two half-power rounds that follow a locked enemy at twice the ink; plain shots cost the base',()=>{
  const {battle:b}=new RoomEngine({...options,weapon:'swout'}), p=b.player, enemy=b.actors.find(a=>a.team!==p.team);
  const jet=weaponById('jet'), sw=weaponById('swout');
  b.countdown=0;
  alone(b,p,enemy);
  assert.equal(sw.pellets,2);
  assert.equal(sw.damage,jet.damage/2);
  assert(sw.cost>jet.cost);
  Object.assign(enemy,{x:p.x+12,y:p.y,z:p.z,shield:0,down:0});
  const chest=[enemy.x,enemy.y+.9,enemy.z];
  p.tank=100;p.fire=0;
  assert(b.shoot(p,chest));
  const guided=b.shots.filter(s=>s.actor===p);
  assert.equal(guided.length,2);
  assert(guided.every(s=>s.homing?.target===enemy));
  assert(Math.abs(100-p.tank-sw.cost*2)<1e-9);
  b.shots.length=0;
  p.tank=100;p.fire=0;
  assert(b.shoot(p,[p.x,p.y+5,p.z+20]));
  assert(b.shots.filter(s=>s.actor===p).every(s=>!s.homing));
  assert(Math.abs(100-p.tank-sw.cost)<1e-9);
  // A locked shot keeps turning toward the target as it moves away.
  b.shots.length=0;
  p.tank=100;p.fire=0;
  b.shoot(p,chest);
  const shot=b.shots.find(s=>s.actor===p);
  enemy.z+=2.4;
  const before=Math.atan2(shot.vel[2],shot.vel[0]);
  b.guideShot(shot,.1);
  assert(Math.atan2(shot.vel[2],shot.vel[0])>before);
});

test('SW OUT II: player-only, lighter, faster and longer, guidance at no extra ink, CO mode trades fire rate for tracking',()=>{
  const sw=weaponById('swout'), two=weaponById('swout2');
  assert(two.playerOnly && !sw.playerOnly);
  assert(Math.abs(two.cost-sw.cost*.6)<1e-9);
  assert(Math.abs(two.speed-sw.speed*1.3)<1e-9);
  assert(Math.abs(two.range-sw.range*1.5)<1e-9);
  assert(Math.abs(two.autoAim.turn-sw.autoAim.turn*1.5)<1e-9 && Math.abs(two.autoAim.reach-sw.autoAim.reach*1.5)<1e-9);
  assert.equal(two.autoAim.ink,1);
  const {battle:b}=new RoomEngine({...options,weapon:'swout2'}), p=b.player, enemy=b.actors.find(a=>a.team!==p.team);
  b.countdown=0;
  alone(b,p,enemy);
  assert(b.actors.filter(a=>!a.isPlayer).every(a=>!a.weapon.playerOnly));
  Object.assign(enemy,{x:p.x+12,y:p.y,z:p.z,shield:0,down:0});
  p.tank=100;p.fire=0;
  b.shoot(p,[enemy.x,enemy.y+.9,enemy.z]);
  assert(Math.abs(100-p.tank-two.cost)<1e-9);
  const normalTurn=b.shots.find(s=>s.actor===p).homing.turn;
  assert(Math.abs(p.fire-two.delay)<1e-9);
  b.control(p,{...still,co:true},.016,camera());
  assert.equal(p.coMode,true);
  b.shots.length=0;
  p.tank=100;p.fire=0;
  b.shoot(p,[enemy.x,enemy.y+.9,enemy.z]);
  assert(Math.abs(b.shots.find(s=>s.actor===p).homing.turn-normalTurn*2)<1e-9);
  assert(Math.abs(p.fire-two.delay*2)<1e-9);
});

test('オート英馬: player-only rapid 7-pellet homing shotgun (0.25 ink/pellet, 1.2x tank), slow weak wide high-paint rounds that home within range',()=>{
  const ae=weaponById('autoeima'), fan=weaponById('fan'), lob=weaponById('lob'), sw=weaponById('swout');
  assert.equal(ae.name,'オート英馬');
  assert(ae.playerOnly && !NPC_WEAPONS.some(w=>w.id==='autoeima'));
  assert.equal(ae.pellets,7);
  assert(Math.abs(ae.cost-7*.25)<1e-9);
  assert(Math.abs(ae.tankScale-1.2)<1e-9);
  assert(ae.delay<fan.delay && ae.speed<fan.speed && ae.speed<lob.speed);
  assert(ae.damage<fan.damage && ae.damage<sw.damage);
  assert(ae.radius>fan.radius && ae.spread>fan.spread && ae.range>fan.range);
  for (const mode of ['play','watch','timeless']) {
    const {battle:mb}=new RoomEngine({mode,weapon:'autoeima',teamSize:8});
    assert(mb.actors.filter(a=>!a.isPlayer).every(a=>!a.weapon.playerOnly && a.weapon.id!=='autoeima'),mode);
  }
  const engine=new RoomEngine({...options,weapon:'autoeima'}), b=engine.battle, p=b.player;
  // Carrying オート英馬 expands tankMax by 1.2x (both standard and after Giga chip, and when swapping weapons).
  assert(Math.abs(p.tankMax-BASE_TANK*1.2)<1e-9);
  assert(Math.abs(p.tank-BASE_TANK*1.2)<1e-9);
  const swap=new RoomEngine({...options,weapon:'jet'}).battle;
  assert.equal(swap.player.tankMax,BASE_TANK);
  assert(swap.equipPlayer('autoeima',swap.player.subId));
  assert(Math.abs(swap.player.tankMax-BASE_TANK*1.2)<1e-9);
  const enemy=b.actors.find(a=>a.team!==p.team);
  b.countdown=0;
  alone(b,p,enemy);
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,tank:100,fire:0,shield:0});
  assert(b.shoot(p,[p.x+12,p.y+1,p.z]));
  const shots=b.shots.filter(s=>s.actor===p);
  assert.equal(shots.length,7);
  assert(Math.abs(100-p.tank-1.75)<1e-9);
  assert(shots.every(s=>s.homing && s.homing.reach===ae.homing.reach && !s.homing.target));
  // Checkpoint cold restore preserves weapon homing on in-flight pellets & 1.2x tank.
  const restored=new RoomEngine({...options,weapon:'autoeima'},new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(restored.shots.length,7);
  assert(restored.shots.every(s=>s.homing && s.homing.reach===ae.homing.reach));
  assert(Math.abs(restored.player.tankMax-BASE_TANK*1.2)<1e-9);
  // Without aiming directly at an enemy, a pellet steers toward an opponent inside homing.reach.
  const center=shots[3];
  Object.assign(enemy,{x:center.pos[0]+9,y:p.y,z:center.pos[2]+4.5,shield:0,down:0});
  const before=Math.atan2(center.vel[2],center.vel[0]);
  b.guideShot(center,.1);
  assert(Math.atan2(center.vel[2],center.vel[0])>before,'steered inside reach');
  // An opponent outside homing.reach does not pull the pellet off course.
  const outer=shots[2];
  Object.assign(enemy,{x:outer.pos[0]+ae.homing.reach+6,y:p.y,z:outer.pos[2]+6,shield:0,down:0});
  const [vx,vy,vz]=outer.vel;
  b.guideShot(outer,.1);
  assert.deepEqual(outer.vel,[vx,vy,vz]);
});

test('チーター NPC: appears in ~50% of matches with オート英馬 II Super (half ink, 1.2x fire rate, 9 pellets, stronger auto-aim) and enhanced HP/agility',()=>{
  const ae=weaponById('autoeima');
  assert.equal(CHEATER_WEAPON.name,'オート英馬 II Super');
  assert.equal(CHEATER_WEAPON.pellets,9);
  assert(CHEATER_WEAPON.spread>=0.5 && CHEATER_WEAPON.spread>ae.spread);
  assert(Math.abs(CHEATER_WEAPON.delay-.115/1.2)<1e-9);
  assert(Math.abs(CHEATER_WEAPON.cost-ae.cost*.5)<1e-9);
  assert(CHEATER_WEAPON.homing.turn>ae.homing.turn && CHEATER_WEAPON.homing.reach>ae.homing.reach && CHEATER_WEAPON.homing.cone>ae.homing.cone);
  // 50% spawn rate across 120 seeded matches.
  let spawned=0;
  for (let seed=1;seed<=120;seed++) {
    const {battle:sb}=new RoomEngine({...options,seed});
    if (sb.actors.some(a=>a.isCheater)) spawned++;
  }
  assert(spawned>=40 && spawned<=80,'spawned '+spawned+'/120');
  const engine=new RoomEngine({...options,cheater:true}), b=engine.battle;
  const cheater=b.actors.find(a=>a.isCheater), normal=b.actors.find(a=>a.team===1 && !a.isCheater);
  assert(cheater && cheater.name==='チーター' && cheater.weapon===CHEATER_WEAPON);
  assert(cheater.maxHp>150 && cheater.baseHp===cheater.maxHp && cheater.tankMax>150 && cheater.agility>1.5);
  // Enhanced agility moves faster than a normal NPC over the same step.
  alone(b,cheater,normal);
  Object.assign(cheater,{x:-20,y:0,z:0,vx:0,vz:0,shield:0});
  Object.assign(normal,{x:-20,y:0,z:4,vx:0,vz:0,shield:0});
  b.move(cheater,5,0,.2,false,false);
  b.move(normal,5,0,.2,false,false);
  assert(cheater.x-(-20)>(normal.x-(-20))*1.4);
  // Fires 9 super-homing pellets for half of オート英馬's ink cost (0.875).
  cheater.tank=100; cheater.fire=0;
  assert(b.shoot(cheater,[cheater.x+10,cheater.y+1,cheater.z]));
  assert.equal(b.shots.filter(s=>s.actor===cheater).length,9);
  assert(Math.abs(100-cheater.tank-.875)<1e-9);
  // ClearSuper and checkpoint cold restore preserve Cheater stats & weapon.
  b.abilities.clearSuper(cheater);
  assert.equal(cheater.maxHp,220);
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  const rc=restored.actors.find(a=>a.isCheater);
  assert(rc && rc.name==='チーター' && rc.weapon===CHEATER_WEAPON && rc.maxHp===220 && rc.agility>1.5);
});

test('apartment snipers spawn on perimeter buildings, shoot both teams indiscriminately, and can be eliminated',()=>{
  const {battle:b}=new RoomEngine({...options,cheater:false}), cyan=b.player, amber=b.actors.find(a=>a.team===1);
  b.countdown=0;
  alone(b,cyan,amber);
  const snipers=b.hazards.spawnSnipers(4);
  assert.equal(snipers.length,4);
  assert(snipers.every(s=>s.active && s.y>=6 && Math.abs(s.z)>=28 && s.team===-1));
  const s=snipers[0];
  // Position Cyan in front of sniper -> sniper aims and fires.
  Object.assign(cyan,{x:s.x,y:0,z:0,shield:0,down:0});
  Object.assign(amber,{x:s.x+3,y:0,z:0,shield:0,down:0});
  s.fire=0; s.aim=0;
  for (let i=0;i<24;i++) b.hazards.updateSnipers(.06);
  assert(b.shots.some(shot=>shot.weapon===SNIPER_WEAPON && shot.actor===s));
  // Hide Cyan, expose Amber -> sniper shoots Amber too (both teams targeted).
  b.shots.length=0;
  cyan.down=10;
  s.fire=0; s.aim=0;
  for (let i=0;i<24;i++) b.hazards.updateSnipers(.06);
  assert(b.shots.some(shot=>shot.weapon===SNIPER_WEAPON && shot.actor===s));
  // Player can shoot down a sniper.
  cyan.down=0;
  const killsBefore=cyan.kills;
  const hit=b.findActor([s.x,s.y+1,s.z-3],[s.x,s.y+1,s.z+3],cyan.team);
  assert(hit && hit.actor===s);
  b.damage(s,400,cyan,[s.x,s.y+1,s.z]);
  assert(!s.active && cyan.kills===killsBefore+1);
});

test('rogue drone swarm periodically attacks both teams with homing shots and can be shot down',()=>{
  const {battle:b}=new RoomEngine({...options,cheater:false}), cyan=b.player, amber=b.actors.find(a=>a.team===1);
  b.countdown=0;
  alone(b,cyan,amber);
  const drones=b.hazards.spawnRogueDrones(4);
  assert.equal(drones.length,4);
  const d=drones[0];
  Object.assign(d,{x:10,y:2.5,z:-16,fire:0});
  Object.assign(cyan,{x:15,y:0,z:-16,shield:0,down:0});
  amber.down=10;
  b.hazards.updateRogueDrones(.05);
  assert(b.shots.some(s=>s.weapon===ROGUE_DRONE_WEAPON && s.actor===d && s.homing));
  b.shots.length=0;
  cyan.down=10;
  Object.assign(amber,{x:5,y:0,z:-16,shield:0,down:0});
  d.fire=0;
  b.hazards.updateRogueDrones(.05);
  assert(b.shots.some(s=>s.weapon===ROGUE_DRONE_WEAPON && s.actor===d && s.homing));
  // Can be shot down.
  cyan.down=0;
  b.damage(d,400,cyan,[d.x,d.y,d.z]);
  assert(!d.active);
});

test('rain washes surface ink; tsunami washes ink, drowns low ground while sparing high ground, and floods underground B1',()=>{
  const {battle:b}=new RoomEngine({...options,cheater:false}), low=b.player, high=b.actors[0], under=b.actors[4];
  b.countdown=0;
  alone(b,low,high,under);
  b.paint.reset();
  // Stamp ink on open surface street and open underground B1 floor.
  b.paint.stamp(10,-16,5,0,0,0,.04);
  b.paint.stamp(UNDER_X+10,-16,5,1,2,0,.04);
  const surfaceBefore=b.paint.zoneCount[0][0], underBefore=b.paint.zoneCount[1][1];
  assert(surfaceBefore>0 && underBefore>0);
  // Rain washes surface ink but leaves underground dry.
  b.hazards.startRain(10);
  for (let i=0;i<24;i++) b.hazards.updateRain(.25);
  assert(b.paint.zoneCount[0][0]<surfaceBefore);
  assert.equal(b.paint.zoneCount[1][1],underBefore);
  // Re-stamp surface ink and launch tsunami immediately.
  b.paint.stamp(10,-16,5,0,0,0,.06);
  assert(b.paint.zoneCount[0][0]>0);
  Object.assign(low,{x:10,y:0,z:-16,hp:100,shield:1.5,down:0});
  Object.assign(high,{x:10,y:6.3,z:-24.5,hp:100,shield:0,down:0});
  Object.assign(under,{x:UNDER_X+10,y:UNDER_Y,z:-16,hp:100,shield:0,down:0});
  b.hazards.startTsunami(0);
  for (let i=0;i<180;i++) b.hazards.updateTsunamiAndFlood(.06);
  // Surface ink swept away, low-ground fighter drowned, high-ground spared, underground flooded & drowned!
  assert.equal(b.paint.zoneCount[0][0],0);
  assert(low.down>0 && low.downBy==='drown');
  assert(high.down<=0 && high.hp===100);
  assert(b.hazards.underFlood.active && b.hazards.underFlood.depth>1.8);
  assert(b.paint.zoneCount[1][1]<underBefore);
  assert(under.down>0 && under.downBy==='drown');
});

test('runaway train becomes a high-speed enemy boss, blocks boarding, attacks fighters, and can be defeated',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle, p=b.player;
  b.countdown=0;
  alone(b,p);
  const tb=b.hazards.startTrainBoss('transit');
  assert(tb.active && b.transit.train.berserk);
  // Boarding is blocked during runaway boss state.
  Object.assign(p,{x:b.transit.line.x,y:b.transit.line.platformY,z:b.transit.line.platformZ});
  assert.equal(b.transit.option(p).kind,'busy');
  // Train runs at high speed without stopping.
  const x0=b.transit.train.x;
  for (let i=0;i<30;i++) {b.elapsed+=.05; b.transit.update(b.elapsed); b.hazards.updateTrainBoss(.05);}
  assert(b.transit.train.speed>18 && b.transit.train.x!==x0 && !b.transit.train.stop);
  // Checkpoint preserves runaway train boss state.
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  assert(restored.hazards.trainBoss.active && restored.transit.train.berserk);
  // Damaging the boss train lowers its HP and defeats it at 0 HP.
  const hpBefore=tb.hp;
  b.hazards.hurtTrainBoss(b.transit,400,p);
  assert.equal(tb.hp,hpBefore-400);
  b.hazards.hurtTrainBoss(b.transit,tb.maxHp,p);
  assert(!tb.active && !b.transit.train.berserk && b.transit.failed());
});

test('unlimited match time lets standard play/watch matches run past 7 minutes and still spawns the boss',()=>{
  const opts=optionsFor({mode:'play',weapon:'jet',teamSize:8,unlimitedTime:true});
  assert.equal(opts.unlimitedTime,true);
  const engine=new RoomEngine(opts), b=engine.battle;
  assert(b.unlimited && !b.timeless && b.left===Infinity);
  b.countdown=0;
  b.elapsed=450;
  b.update(.1,still,camera);
  assert(!b.finished && b.left===Infinity && b.boss.spawned);
  const restored=new RoomEngine({mode:'play',weapon:'jet',teamSize:8},new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(restored.unlimited,true);
});

test('perimeter apartments enclose all four sides of the arena while railway tunnel portals let trains pass cleanly',()=>{
  const {battle:b}=new RoomEngine({...options,cheater:false}), w=b.world;
  // Ground-level perimeter walls block walking out North, South, East, and West.
  for (const x of [-45,-20,0,11,25,45]) {
    assert(w.blocked(x,1,-37,.42,1.72),'north wall blocked at x='+x);
    assert(w.blocked(x,1,37,.42,1.72),'south wall blocked at x='+x);
  }
  for (const z of [-34,-20,-4,11,26]) {
    assert(w.blocked(-59,1,z,.42,1.72),'west wall blocked at z='+z);
    assert(w.blocked(59,1,z,.42,1.72),'east wall blocked at z='+z);
  }
  // West sky-bridge blocks actors mid-air too (cannot climb or jump out).
  assert(w.blocked(-59,7.5,11,.42,1.72),'west skyway blocks actors');
  // Railway tunnel portals block actors at track height on both East & West ends.
  assert(w.blocked(-55.6,7.0,RAIL.z,.42,1.72),'west rail tunnel blocks actors');
  assert(w.blocked(55.6,7.0,RAIL.z,.42,1.72),'east rail tunnel blocks actors');
  // Meanwhile the elevated train glides smoothly past both East & West tunnel portals.
  let minX=Infinity, maxX=-Infinity;
  for (let t=0;t<140;t+=.5) {
    b.transit.update(t);
    if (b.transit.section===0) {
      const ox=b.transit.pose().ox;
      minX=Math.min(minX,ox);
      maxX=Math.max(maxX,ox);
    }
  }
  assert(minX<-58 && maxX>58,'elevated train traverses tunnel portals: ['+minX+','+maxX+']');
});

test('破壊神ゴート: overwhelming HP, hovers midair with 16 arms & 50m reach, attacks both teams indiscriminately, escalates phases, and checkpoints',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle;
  const engine8=new RoomEngine({mode:'play',weapon:'jet',teamSize:8,cheater:false});
  assert.equal(engine.battle.hazards.goat.maxHp,20000);
  assert.equal(engine8.battle.hazards.goat.maxHp,30000);
  const cyan=b.player, amber=b.actors.find(a=>a.team===1);
  b.countdown=0;
  alone(b,cyan,amber);
  const g=b.hazards.spawnGoat(60);
  assert(g.active && g.hp===20000 && g.arms===GOAT_ARMS && g.arms===16 && g.until===Infinity);
  assert(g.y>=4,'Goat hovers in midair: y='+g.y);
  // Position Cyan and Amber across range & speeds -> Supreme Goat adapts across its 8-attack arsenal!
  Object.assign(cyan,{x:4,y:0,z:-4,hp:100,shield:0,down:0,vx:0,vz:0});
  Object.assign(amber,{x:-4,y:0,z:-4,hp:100,shield:0,down:0,vx:0,vz:0});
  g.nextAttack=b.clock;
  const sawKinds=new Set();
  let cyanHit=false, amberHit=false;
  for (let i=0;i<260;i++) {
    if (i===65) Object.assign(cyan,{x:26,y:0,z:4,hp:100,shield:0,down:0,vx:7,vz:0}), Object.assign(amber,{x:-28,y:0,z:-8,hp:100,shield:0,down:0,vx:-7,vz:0});
    if (i===145) Object.assign(cyan,{x:18,y:0,z:0,hp:100,shield:0,down:0,vx:0,vz:0}), Object.assign(amber,{x:-18,y:0,z:-2,hp:100,shield:0,down:0,vx:0,vz:0});
    b.clock+=.06; b.elapsed+=.06;
    b.hazards.updateGoat(.06);
    if (cyan.down>0 || cyan.hp<100) cyanHit=true;
    if (amber.down>0 || amber.hp<100) amberHit=true;
    if (g.cast?.kind) sawKinds.add(g.cast.kind);
  }
  assert(sawKinds.has('whirl') && sawKinds.size>=4,'Supreme Goat rotates through multiple tactical attacks: '+[...sawKinds].join(','));
  // Trigger homing barrage explicitly to verify Goat orbs remain homing at 50m
  b.hazards.planGoatAttack([cyan,amber],'barrage');
  b.clock=g.cast.at+.02;
  b.hazards.updateGoat(.04);
  assert(b.shots.some(s=>s.weapon===GOAT_WEAPON && s.homing),'barrage fires homing Goat orbs');
  assert(cyanHit,'Cyan attacked by Goat');
  assert(amberHit,'Amber attacked by Goat');
  // Also confirm both teams get eliminated when grounded inside close reach.
  Object.assign(cyan,{x:4,y:0,z:-4,hp:100,shield:0,down:0,vx:0,vz:0});
  Object.assign(amber,{x:-4,y:0,z:-4,hp:100,shield:0,down:0,vx:0,vz:0});
  Object.assign(g,{x:0,z:-4,volley:0,cast:null,lastCastKind:null,nextAttack:b.clock});
  for (let i=0;i<130;i++) {b.clock+=.06;b.elapsed+=.06;b.hazards.updateGoat(.06);}
  assert(cyan.down>0 && cyan.downBy==='goat','Cyan eliminated by Goat');
  assert(amber.down>0 && amber.downBy==='goat','Amber eliminated by Goat');
  // Checkpoint preserves Goat state cleanly.
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  assert(restored.hazards.goat.active && restored.hazards.goat.hp===g.hp && restored.hazards.goat.arms===16);
  // 4-Phase escalation (with Phase 4 divine resistance) & defeat via player fire.
  cyan.down=0; cyan.hp=cyan.maxHp;
  const hit=b.findActor([g.x,g.y+1.8,g.z-6],[g.x,g.y+1.8,g.z+6],cyan.team);
  assert(hit && hit.actor===g);
  b.hazards.hurtGoat(5500,cyan);
  assert.equal(g.phase,2);
  b.hazards.hurtGoat(5000,cyan);
  assert.equal(g.phase,3);
  b.hazards.hurtGoat(5000,cyan);
  assert.equal(g.phase,4);
  const killsBefore=cyan.kills;
  b.hazards.hurtGoat(6000,cyan);
  assert(!g.active && g.hp===0 && cyan.kills===killsBefore+1);
});

test('HNV1 foundation engine powers every NPC type with human archetypes, predictive aim, and disaster/boss survival',()=>{
  const {battle:b}=new RoomEngine({mode:'timeless',weapon:'jet',cheater:true});
  assert(b.hnv1 && b.hnv1.version===HNV1_VERSION && b.hnv1.gain===HNV1_GAIN && HNV1_GAIN===40);
  b.countdown=0;
  // Every NPC in the game runs on HNV1: crew, Cheater, ebot clone, Raiders, Snipers, Rogue Drones, Giant Squid Boss, Goat!
  const npcs=b.actors.filter(a=>!a.isPlayer);
  assert(npcs.length>0 && npcs.every(a=>a.hnv1==='HNV1' && b.hnv1.status(a).engine==='HNV1'));
  const cheater=b.actors.find(a=>a.isCheater);
  assert.equal(b.hnv1.status(cheater).archetype,'ace');
  const clone=b.addClone(npcs[0]);
  assert.equal(clone.hnv1,'HNV1');
  b.raiders.spawn();
  assert(b.raiders.members.every(r=>r.hnv1==='HNV1' && b.hnv1.status(r).archetype==='hunter'));
  const snipers=b.hazards.spawnSnipers(4);
  assert(snipers.every(s=>s.hnv1==='HNV1' && b.hnv1.status(s).archetype==='marksman'));
  const drones=b.hazards.spawnRogueDrones(4);
  assert(drones.every(d=>d.hnv1==='HNV1' && b.hnv1.status(d).archetype==='swarm'));
  assert.equal(b.boss.hnv1,'HNV1');
  assert.equal(b.hazards.goat.hnv1,'HNV1');

  // Dynamic emotional/cognitive state responds to kills & incoming damage.
  const bot=npcs[0], enemy=b.actors.find(a=>a.team!==bot.team);
  const beforeMind=b.hnv1.status(bot);
  bot.kills+=2;
  b.clock+=.1;
  b.hnv1.tick(bot,.1,{visible:true,enemy,point:[enemy.x,enemy.y+1,enemy.z],velocity:[4,0,0]});
  assert(b.hnv1.status(bot).morale>beforeMind.morale && b.hnv1.status(bot).streak===2);

  // Ballistic + acceleration aim prediction leads moving targets ahead of current position.
  Object.assign(bot,{x:0,y:0,z:-16,yaw:Math.PI/2,hp:100,tank:140,down:0,shield:0});
  Object.assign(enemy,{x:14,y:0,z:-16,vx:0,vy:0,vz:6,hp:100,down:0,shield:0});
  const sight={visible:true,enemy,point:[14,1.08,-16],foot:{x:14,y:0,z:-16},velocity:[0,0,6],at:b.clock};
  const aim=b.hnv1.predictAim(bot,sight);
  assert(aim[2]>-16,'HNV1 ballistic lead aims ahead along target Z velocity: '+aim[2]);

  // Tsunami evacuation: low-ground NPC immediately evacuates toward high ground!
  b.hazards.tsunami={phase:'warn',warnUntil:b.clock+4,x:-64,height:3.6,width:9.5,floodedUnder:false};
  Object.assign(bot,{x:10,y:0,z:-16,down:0,ride:null,lift:null});
  b.motion.begin();
  assert(b.hnv1.survivalAction(bot,.05,null));
  assert.equal(bot.intent,'HNV1: 津波から高台へ緊急避難');
  b.hazards.tsunami.phase='idle';

  // Underground B1 flood escape: NPC in B1 immediately routes to nearest stairwell up!
  b.hazards.underFlood={active:true,phase:'rise',depth:.8,maxDepth:2.65,timer:0,washTimer:0};
  Object.assign(bot,{x:UNDER_X+10,y:UNDER_Y,z:-16,down:0});
  b.motion.begin();
  assert(b.hnv1.survivalAction(bot,.05,null));
  assert.equal(bot.intent,'HNV1: 地下浸水から地上へ脱出');
  b.hazards.underFlood.active=false;

  // God of Destruction Goat 16-tentacle telegraph avoidance!
  const g=b.hazards.spawnGoat(40);
  g.x=10; g.z=-16;
  g.cast={kind:'whirl',x:10,z:-16,radius:28,start:b.clock,at:b.clock+.45,end:b.clock+1.1,done:false,yaw:0};
  Object.assign(bot,{x:14,y:0,z:-16,down:0});
  b.motion.begin();
  assert(b.hnv1.survivalAction(bot,.05,null));
  assert.equal(bot.intent,'HNV1: 破壊神ゴートの16本触手を回避');
});

test('map cars are drivable, paint own ink while driving, ram/run over enemies, dye with enemy ink when attacked, and explode for massive AoE damage',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle, p=b.player;
  const enemy=b.actors.find(a=>a.team===1), ally=b.actors.find(a=>a.team===p.team && a!==p);
  b.countdown=0;
  alone(b,p,enemy,ally);
  assert(b.vehicles && b.vehicles.cars.length>=13,'all map cars spawned dynamically');

  // Pick a street car and board it via transportOption / useTransport ([E]).
  const car=b.vehicles.cars.find(c=>Math.abs(c.x+17.85)<1 && Math.abs(c.z+3.80)<1) ?? b.vehicles.cars[0];
  assert(car.alive && car.stain===0 && !car.driver);
  Object.assign(p,{x:car.x,y:car.y,z:car.z+2.2,down:0,shield:0});
  assert.equal(b.transportOption(p)?.kind,'car-enter');
  assert(b.useTransport(p));
  assert.equal(p.car,car);
  assert.equal(car.driver,p);
  assert.equal(car.ownerTeam,p.team);
  assert.equal(b.transportOption(p)?.kind,'car-exit');

  // Drive freely forward & steer -> paints own ink along the road!
  b.paint.reset();
  const startX=car.x, startZ=car.z;
  for (let i=0;i<30;i++) {
    b.clock+=.04;
    b.vehicles.drive(p,{x:.25,z:1,jump:false},.04);
  }
  assert(Math.hypot(car.x-startX,car.z-startZ)>4,'car drove freely across the street');
  assert(b.paint.zoneCount[0][p.team]>0 && p.painted>0,'driving paints the ground with driver ink');

  // Ram / run over an enemy directly ahead at speed!
  const fx=Math.sin(car.yaw), fz=-Math.cos(car.yaw);
  Object.assign(enemy,{x:car.x+fx*4.5,y:car.y,z:car.z+fz*4.5,hp:100,shield:0,down:0});
  car.speed=14;
  for (let i=0;i<16 && enemy.down<=0;i++) {
    b.clock+=.04;
    b.vehicles.drive(p,{x:0,z:1,jump:false},.04);
  }
  assert(enemy.down>0 && enemy.downBy==='car','speeding car runs over and eliminates enemy');

  // Checkpoint cold restore preserves car position, driver & stain!
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  const rc=restored.vehicles.byId(car.id);
  assert(rc && rc.alive && rc.driver===restored.player && restored.player.car===rc);

  // Allied shots do not destroy own team's driven car.
  const hpBeforeAlly=car.hp;
  b.vehicles.damageCar(car,80,ally,[car.x,car.y+1,car.z]);
  assert.equal(car.hp,hpBeforeAlly,'allied shots do not destroy driven car');

  // Real enemy projectiles hit the car hull and dye it in the enemy's ink color!
  Object.assign(enemy,{x:car.x,y:car.y,z:car.z+7,hp:100,shield:0,down:0,tank:140,fire:0,yaw:0});
  b.shots.length=0;
  assert(b.shoot(enemy,[car.x,car.y+.8,car.z]));
  for (let i=0;i<24 && b.shots.length;i++) {b.clock+=1/60;b.updateShots(1/60);}
  assert(car.alive && car.stain>0 && car.stainTeam===enemy.team,'enemy shot dyed the car in enemy ink');

  // Place nearby ally & driver around the car, then finish dyeing it to 100% -> MASSIVE EXPLOSION!
  Object.assign(ally,{x:car.x+3.5,y:car.y,z:car.z,hp:100,shield:0,down:0});
  p.hp=100; p.shield=0;
  b.vehicles.damageCar(car,car.maxHp,enemy,[car.x,car.y+1,car.z]);
  assert(!car.alive && car.stain===1 && !p.car,'car explodes once completely dyed in enemy ink');
  assert(p.down>0 && p.downBy==='carBomb','driver takes massive explosion damage');
  assert(ally.down>0 && ally.downBy==='carBomb','nearby fighter takes heavy explosion damage');
  assert(b.paint.zoneCount[0][enemy.team]>0,'explosion splatters enemy ink crater');
});

test('upgraded vehicle dynamics engine, hit VFX, projectiles, and all 16 bespoke weapon models simulate & render cleanly',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle, p=b.player;
  const enemy=b.actors.find(a=>a.team===1);
  b.countdown=0;
  alone(b,p,enemy);

  // 1. Vehicle dynamics: 4-gear shift, RPM, suspension pitch/roll, powerslide drift + mini-turbo exit boost.
  const car=b.vehicles.cars.find(c=>Math.abs(c.x+17.85)<1 && Math.abs(c.z+3.80)<1) ?? b.vehicles.cars[0];
  Object.assign(p,{x:car.x,y:car.y,z:car.z+2.2,down:0,shield:0});
  assert(b.useTransport(p));
  for (let i=0;i<14;i++) {
    b.clock+=.04;
    b.vehicles.drive(p,{x:.05,z:1,jump:false},.04);
  }
  assert(car.gear>=2 && car.rpm>1500 && Math.abs(car.wheelSpin)>4,'vehicle shifts gears and spins wheels');
  assert(Math.abs(car.roll)>.005,'cornering induces body roll');

  // Hold Space (jump) while turning to initiate powerslide drift, charge mini-turbo, then release!
  for (let i=0;i<14;i++) {
    b.clock+=.04;
    b.vehicles.drive(p,{x:-.45,z:1,jump:true},.04);
  }
  assert(car.drifting && Math.abs(car.driftAngle)>.08 && car.driftCharge>.45,'powerslide builds drift angle and charge');
  const speedBeforeBoost=car.speed;
  b.clock+=.04;
  b.vehicles.drive(p,{x:0,z:1,jump:false},.04);
  assert(car.boostFlame>.3 && car.speed>speedBeforeBoost,'releasing charged drift fires mini-turbo exit boost');

  // Checkpoint preserves upgraded vehicle dynamics fields.
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  const rc=restored.vehicles.byId(car.id);
  assert(rc && rc.gear===car.gear && Math.abs(rc.rpm-car.rpm)<1 && Number.isFinite(rc.pitch) && Number.isFinite(rc.roll));
  b.vehicles.exit(p);

  // 2. Render verification harness with strict finite-geometry & basis checks + seal() to exercise drawPlainCrew.
  const makeRenderer=(lite=false)=>{
    const draws=[];
    const checkNum=(v,label)=>assert(typeof v==='number' && Number.isFinite(v),label+' must be finite, got '+v);
    return {
      lite,
      draws,
      seal() {},
      add(shape,x,y,z,sx,sy,sz,color,mat,opts) {
        assert(typeof shape==='string' && shape.length>0,'shape name required');
        checkNum(x,shape+'.x'); checkNum(y,shape+'.y'); checkNum(z,shape+'.z');
        checkNum(sx,shape+'.sx'); checkNum(sy,shape+'.sy'); checkNum(sz,shape+'.sz');
        checkNum(color,shape+'.color'); checkNum(mat,shape+'.mat');
        if (opts?.basis) {
          for (const v of opts.basis) for (const c of v) checkNum(c,shape+'.basis');
        }
        draws.push({shape,x,y,z,sx,sy,sz,color,mat,opts});
      },
      beam(a,c,r,color) {
        for (const v of [...a,...c,r,color]) checkNum(v,'beam');
        draws.push({shape:'beam',a,c,r,color});
      },
      label() {}
    };
  };

  // 3. Draw every single weapon (all 16 player weapons + Cheater Auto-Eima II Super) idle, firing, charged, and CO mode!
  const allWeapons=[...WEAPONS,CHEATER_WEAPON];
  assert.equal(allWeapons.length,17);
  Object.assign(p,{x:0,y:0,z:-16,yaw:0,pitch:0,down:0,swimming:false,tank:140,tankMax:140});
  for (const w of allWeapons) {
    p.weapon=w;
    p.muzzle=.07;
    p.charge=w.charge?.92:0;
    p.coMode=w.co?1:0;
    const r=makeRenderer(false);
    b.draw(r,0,-10,null,2.4);
    assert(r.draws.length>40,'weapon '+w.id+' emits rich upgraded 3D geometry ('+r.draws.length+' primitives)');
  }

  // 4. Draw all upgraded projectile classes (homing, precision, heavy, swirl, Goat, standard) + hit VFX (surface, body, KO)!
  const shotWeapons=[
    weaponById('autoeima'),CHEATER_WEAPON,GOAT_WEAPON,
    weaponById('charge'),weaponById('prism'),SNIPER_WEAPON,
    weaponById('lob'),weaponById('blast'),weaponById('rd2'),
    weaponById('coil'),weaponById('surge'),weaponById('jet')
  ];
  b.shots=shotWeapons.map((w,i)=>({
    pos:[-10+i*1.8,2.2,-16],
    vel:[18,0,-6],
    actor:i===1?enemy:p,
    weapon:w,
    power:1,
    age:.14,
    homing:!!w.homing,
    cheater:w.id==='autoeima2s',
    goat:w.id==='goat',
    trainBoss:false
  }));
  b.drops.length=0;
  b.inkImpacts.length=0;
  Object.assign(enemy,{x:3,y:0,z:-16,hp:100,shield:0,down:0});
  b.inkHit(enemy,30,p,[2,1.6,-16]);
  b.clock+=.04;
  b.inkHit(enemy,200,p,[4,1.6,-16]);
  b.addInkImpact({p:[6,.1,-16],team:1,normal:[0,1,0],kind:0});
  assert(b.drops.length>=18,'KO hit spawns celebratory splash fountain droplets');

  // Also test stained + exploding vehicle archetypes (0=GT Coupe, 1=Pickup, 2=Armored Van).
  const coupe=b.vehicles.cars.find(c=>c.style===0);
  const pickup=b.vehicles.cars.find(c=>c.style===1);
  const van=b.vehicles.cars.find(c=>c.style===2);
  assert(coupe && pickup && van,'all 3 bespoke vehicle archetypes present');
  coupe.stain=.82; coupe.stainTeam=1; coupe.boostFlame=.9; coupe.drifting=true; coupe.driftAngle=.22;
  pickup.stain=.45; pickup.stainTeam=1; pickup.braking=true;
  b.vehicles.damageCar(van,van.maxHp,enemy,[van.x,van.y+1,van.z]);
  assert(!van.alive && van.explodedAt>=0,'armored van enters flying-wheel explosion debris state');
  b.clock+=.25;

  const rFull=makeRenderer(false), rLite=makeRenderer(true);
  b.draw(rFull,0,-6,null,2.6);
  b.draw(rLite,0,-6,null,2.6);
  assert(rFull.draws.length>rLite.draws.length,'full renderer emits extra upgraded hit VFX, projectile & vehicle details over lite mode');
  assert(rFull.draws.some(d=>d.shape==='shade' && d.mat===28),'vehicles cast grounded contact AO shadows');
  assert(rFull.draws.some(d=>d.shape==='ring' && d.mat===3),'homing & precision projectiles emit glowing lock/Mach rings');
});

test('lossless optimization parity: writeSurfaceSlots fast paths, packInstance trig short-circuits, and inFrustum VFX culling preserve exact output',()=>{
  const f32=Math.fround, fract32=x=>f32(x-Math.floor(x));
  const seedFor=(x,y,z)=>{
    let qx=fract32(f32(f32(x)*f32(.1031))), qy=fract32(f32(f32(y)*f32(.1030))), qz=fract32(f32(f32(z)*f32(.0973)));
    const c=f32(33.33), d=f32(f32(qx*f32(qy+c))+f32(qy*f32(qz+c))+f32(qz*f32(qx+c)));
    qx=f32(qx+d); qy=f32(qy+d); qz=f32(qz+d);
    return fract32(f32(f32(qx+qy)*qz));
  };
  const buf=new Float32Array(STRIDE);
  const colors=[0x181c20,0x446688,0xcfd6d2,0xe6e7dc,0xd85a38,0x3ca060,0xff267a];
  const zones=[{x:12,y:1.5,z:-10,under:false,cabin:false},{x:UNDER_X+8,y:UNDER_Y+1.2,z:-8,under:true,cabin:false},{x:CABIN_X+4,y:1.2,z:0,under:false,cabin:true}];
  const sizes=[[0.04,0.05,0.22],[0.5,1.8,0.4],[3.5,0.25,2.4],[1.8,0.9,1.2]];
  // Exhaustively verify all fast-path kinds (8, 14, 18, 20, 21, 29, 0, 3, 22, 23, 26, 30, 31) against surfaceForJS!
  for (const kind of [0,3,8,14,18,20,21,22,23,26,29,30,31]) {
    for (const col of colors) for (const z of zones) for (const [sx,sy,sz] of sizes) for (const shape of [0,1,2,3]) {
      packInstance(buf,0,z.x,z.y,z.z,sx,sy,sz,col,kind,{},shape,false);
      const r=buf[16], g=buf[17], b=buf[18], seed=seedFor(buf[12],buf[13],buf[14]);
      const fx=f32(sx), fy=f32(sy), fz=f32(sz);
      const floorY=z.cabin?0:z.under?UNDER_Y:0;
      const top=surfaceForJS(kind,r,g,b,true,false,shape===2,seed,fx,fy,fz,shape,z.under,z.cabin,0,buf[13]+fy*.5-floorY);
      const side=surfaceForJS(kind,r,g,b,false,false,false,seed,fx,fy,fz,shape,z.under,z.cabin,0,buf[13]-floorY);
      const bot=surfaceForJS(kind,r,g,b,false,true,false,seed,fx,fy,fz,shape,z.under,z.cabin,0,buf[13]-fy*.5-floorY);
      assert.deepEqual([buf[3],buf[7],buf[11]],[top,side,bot],`surface slot mismatch kind=${kind} col=${col.toString(16)} shape=${shape}`);
    }
  }

  // Verify packInstance trig fast paths match general Euler rotation exactly.
  const b0=new Float32Array(STRIDE), b1=new Float32Array(STRIDE);
  packInstance(b0,0,1,2,3,4,5,6,0x112233,20,{yaw:0,pitch:0},1,true);
  packInstance(b1,0,1,2,3,4,5,6,0x112233,20,{basis:[[1,0,0],[0,1,0],[0,0,1]]},1,true);
  for (let i=0;i<STRIDE;i++) assert(Math.abs(b0[i]-b1[i])<1e-6,'identity fast path matches basis at '+i);
  const yaw=1.234;
  packInstance(b0,0,1,2,3,4,5,6,0x112233,20,{yaw,pitch:0},1,true);
  packInstance(b1,0,1,2,3,4,5,6,0x112233,20,{yaw,pitch:1e-12},1,true);
  for (let i=0;i<STRIDE;i++) assert(Math.abs(b0[i]-b1[i])<1e-6,'yaw-only fast path matches general at '+i);

  // Verify Renderer.prototype.prepareView + inFrustum accepts in-view points and rejects strictly behind-camera points.
  const cam={eye:[0,2,10],target:[0,2,0]};
  const dummy={_viewPlanes:[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]],_hasViewPlanes:false,drawingAdjacent:false,overview:false};
  Renderer.prototype.prepareView.call(dummy,cam,16/9);
  assert(Renderer.prototype.inFrustum.call(dummy,0,2,-5,1),'point directly in front of camera is in frustum');
  assert(!Renderer.prototype.inFrustum.call(dummy,0,2,25,1),'point strictly behind camera is culled');
});

test('deep motion & animation pass: swimming squid, crew hair/flinch/hose, vehicle wipers/DRS/sparks, Goat claws, Snipers, 4-rotor Drones & Boss render cleanly',()=>{
  const engine=new RoomEngine({mode:'play',weapon:'autoeima',teamSize:4,cheater:true}), b=engine.battle, p=b.player;
  b.countdown=0;

  // Activate EVERY animated system simultaneously for a full stress & animation check!
  b.hazards.startRain(12);
  b.hazards.spawnSnipers(3);
  b.hazards.spawnRogueDrones(3);
  const goat=b.hazards.spawnGoat(60);
  b.boss.spawn();
  for (const s of b.hazards.snipers) {s.aim=.8; s.recoil=.7; s.flash=b.clock; s.targetPos=[0,1,-16];}
  for (const d of b.hazards.rogueDrones) {d.flash=b.clock;}

  // Put one actor in ink-swimming squid state, player taking hit flinch + firing, and giant squid super!
  const swimmer=b.actors.find(a=>a!==p && a.team===0);
  Object.assign(swimmer,{x:2,y:0,z:-14,vx:5,vz:0,swimming:true,inkSwimming:true,down:0});
  Object.assign(p,{x:0,y:0,z:-16,vx:3,vz:2,recoil:.85,heat:.75,damageAge:.08,landing:.4,down:0,tank:110,tankMax:140});
  const giant=b.actors.find(a=>a.team===1);
  Object.assign(giant,{x:-4,y:0,z:-14,giant:true,down:0});

  // Drive a GT Coupe with drifting + braking + rain wipers + stain steam!
  const coupe=b.vehicles.cars.find(c=>c.style===0);
  Object.assign(coupe,{x:6,y:0,z:-16,speed:14,steer:.35,drifting:true,driftAngle:.22,driftCharge:.65,braking:true,boostFlame:.45,stain:.78,stainTeam:1,driver:p});

  // Pack every single draw call through real packInstance() (zero-alloc path with seal()!) across multiple animation frames!
  const packBuf=new Float32Array(STRIDE);
  let primCount=0;
  const benchRenderer={
    lite:false, ultra:false, fidelity:true, viewPoint:[0,2.4,-6],
    seal() {},
    add(shape,x,y,z,w,h,d,tint,kind=0,opts={}) {
      assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),'finite pos on '+shape);
      assert(Number.isFinite(w) && Number.isFinite(h) && Number.isFinite(d),'finite size on '+shape);
      packInstance(packBuf,0,x,y,z,w,h,d,tint,kind,opts,shape==='box'?1:shape==='bevel'?3:0,true);
      assert(Number.isFinite(packBuf[0]) && Number.isFinite(packBuf[12]),'finite packed matrix');
      primCount++;
    },
    beam(a,c,w,d,tint,kind=0,opts={}) {
      Renderer.prototype.beam.call(this,a,c,w,d,tint,kind,opts);
    },
    label() {}
  };

  // Cycle Goat through all 3 animated attacks (smash, whirl, barrage) + step clocks cleanly.
  const casts=[
    {kind:'smash',x:goat.x,z:goat.z,start:b.clock,at:b.clock+.5,end:b.clock+1.1,done:false,points:Array.from({length:16},(_,i)=>[i*2-15,0,-15])},
    {kind:'whirl',x:goat.x,z:goat.z,start:b.clock,at:b.clock+.4,end:b.clock+1.1,done:false,radius:28,yaw:0},
    {kind:'barrage',x:goat.x,z:goat.z,start:b.clock,at:b.clock+.4,end:b.clock+1.0,done:false,yaw:0}
  ];
  const t0=performance.now();
  for (let f=0;f<18;f++) {
    b.clock+=1/60;
    goat.cast=casts[f%3];
    p.weapon=WEAPONS[f%WEAPONS.length];
    p.charge=p.weapon.charge?.95:0;
    p.rolling=!!p.weapon.roller;
    b.draw(benchRenderer,0,-6,null,2.6);
  }
  const elapsedMs=performance.now()-t0;
  assert(primCount>15000,'full combat stress scene emitted rich 3D detail ('+primCount+' packed instances in '+elapsedMs.toFixed(1)+'ms)');
  assert(elapsedMs<2500,'zero-alloc packing maintains high CPU throughput ('+elapsedMs.toFixed(1)+'ms for 18 dense frames)');
});




