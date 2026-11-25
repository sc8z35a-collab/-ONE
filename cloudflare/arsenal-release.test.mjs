import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {BOSS_RESPAWN_SECONDS,EXP_PER_KILL,RESPAWN_SECONDS} from '../dist/battle.js';
import {bankResults,levelOf,loadCareer,matchResults,mostActive} from '../dist/progress.js';
import {DRONE_WEAPON,CHEATER_WEAPON,EBOT,GOAT_WEAPON,NPC_WEAPONS,ROGUE_DRONE_WEAPON,SNIPER_WEAPON,SUPERS,weaponById} from '../dist/weapons.js';
import {RAIL,UNDER_X,UNDER_Y} from '../dist/layout.js';
import {GOAT_ARMS} from '../dist/hazards.js';
import {HNV1_GAIN,HNV1_VERSION} from '../dist/hnv1.js';
import {optionsFor} from './edge.js';
import {SCENE_FRAGMENT,LITE_FRAGMENT} from '../dist/render-shaders.js';
import {SURFACES,SURFACE_SHEETS,sheetPrompt} from '../dist/surfaces.js';

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

test('RD II QUATRO+ fires five heavy rounds, costs a lot of ink and slows its carrier',()=>{
  const rd=weaponById('rd2'), jet=weaponById('jet');
  assert.equal(rd.pellets,5);
  assert(rd.damage*rd.pellets>jet.damage*4 && rd.radius<jet.radius*.5 && rd.cost>jet.cost*8);
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

test('オート英馬: player-only rapid 7-pellet homing shotgun (0.5 ink/pellet), slow weak wide high-paint rounds that home within range',()=>{
  const ae=weaponById('autoeima'), fan=weaponById('fan'), lob=weaponById('lob'), sw=weaponById('swout');
  assert.equal(ae.name,'オート英馬');
  assert(ae.playerOnly && !NPC_WEAPONS.some(w=>w.id==='autoeima'));
  assert.equal(ae.pellets,7);
  assert(Math.abs(ae.cost-7*.5)<1e-9);
  assert(ae.delay<fan.delay && ae.speed<fan.speed && ae.speed<lob.speed);
  assert(ae.damage<fan.damage && ae.damage<sw.damage);
  assert(ae.radius>fan.radius && ae.spread>fan.spread && ae.range>fan.range);
  for (const mode of ['play','watch','timeless']) {
    const {battle:mb}=new RoomEngine({mode,weapon:'autoeima',teamSize:8});
    assert(mb.actors.filter(a=>!a.isPlayer).every(a=>!a.weapon.playerOnly && a.weapon.id!=='autoeima'),mode);
  }
  const engine=new RoomEngine({...options,weapon:'autoeima'}), b=engine.battle, p=b.player;
  const enemy=b.actors.find(a=>a.team!==p.team);
  b.countdown=0;
  alone(b,p,enemy);
  Object.assign(p,{x:10,y:0,z:-16,yaw:Math.PI/2,tank:100,fire:0,shield:0});
  assert(b.shoot(p,[p.x+12,p.y+1,p.z]));
  const shots=b.shots.filter(s=>s.actor===p);
  assert.equal(shots.length,7);
  assert(Math.abs(100-p.tank-3.5)<1e-9);
  assert(shots.every(s=>s.homing && s.homing.reach===ae.homing.reach && !s.homing.target));
  // Checkpoint cold restore preserves weapon homing on in-flight pellets.
  const restored=new RoomEngine({...options,weapon:'autoeima'},new Map(Object.entries(engine.checkpoint()))).battle;
  assert.equal(restored.shots.length,7);
  assert(restored.shots.every(s=>s.homing && s.homing.reach===ae.homing.reach));
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

test('チーター NPC: appears in ~50% of matches with オート英馬 II Super (half ink, stronger auto-aim) and enhanced HP/agility',()=>{
  const ae=weaponById('autoeima');
  assert.equal(CHEATER_WEAPON.name,'オート英馬 II Super');
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
  // Fires 7 super-homing pellets for half of オート英馬's ink cost (1.75).
  cheater.tank=100; cheater.fire=0;
  assert(b.shoot(cheater,[cheater.x+10,cheater.y+1,cheater.z]));
  assert.equal(b.shots.filter(s=>s.actor===cheater).length,7);
  assert(Math.abs(100-cheater.tank-1.75)<1e-9);
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

test('破壊神ゴート: overwhelming HP, hovers midair with 8 arms, attacks both teams indiscriminately, escalates phases, and checkpoints',()=>{
  const engine=new RoomEngine({...options,cheater:false}), b=engine.battle;
  const engine8=new RoomEngine({mode:'play',weapon:'jet',teamSize:8,cheater:false});
  assert.equal(engine.battle.hazards.goat.maxHp,12000);
  assert.equal(engine8.battle.hazards.goat.maxHp,18000);
  const cyan=b.player, amber=b.actors.find(a=>a.team===1);
  b.countdown=0;
  alone(b,cyan,amber);
  const g=b.hazards.spawnGoat(60);
  assert(g.active && g.hp===12000 && g.arms===GOAT_ARMS && g.arms===8);
  assert(g.y>=4,'Goat hovers in midair: y='+g.y);
  // Position Cyan and Amber beneath Goat -> Goat attacks both teams indiscriminately!
  Object.assign(cyan,{x:4,y:0,z:-4,hp:100,shield:0,down:0});
  Object.assign(amber,{x:-4,y:0,z:-4,hp:100,shield:0,down:0});
  g.nextAttack=b.clock;
  let sawSmash=false, sawWhirl=false, sawBarrage=false;
  for (let i=0;i<160;i++) {
    b.clock+=.06; b.elapsed+=.06;
    b.hazards.updateGoat(.06);
    if (g.cast?.kind==='smash') sawSmash=true;
    if (g.cast?.kind==='whirl') sawWhirl=true;
    if (g.cast?.kind==='barrage') sawBarrage=true;
  }
  assert(sawSmash && sawWhirl && sawBarrage,'Goat cycles 8-arm smash, whirl, and barrage');
  assert(b.shots.some(s=>s.weapon===GOAT_WEAPON && s.homing),'barrage fires homing Goat orbs');
  assert(cyan.down>0 && cyan.downBy==='goat','Cyan eliminated by Goat');
  assert(amber.down>0 && amber.downBy==='goat','Amber eliminated by Goat');
  // Checkpoint preserves Goat state cleanly.
  const restored=new RoomEngine({...options,cheater:false},new Map(Object.entries(engine.checkpoint()))).battle;
  assert(restored.hazards.goat.active && restored.hazards.goat.hp===g.hp && restored.hazards.goat.arms===8);
  // Phase escalation & defeat via player fire.
  cyan.down=0; cyan.hp=100;
  const hit=b.findActor([g.x,g.y+1.8,g.z-6],[g.x,g.y+1.8,g.z+6],cyan.team);
  assert(hit && hit.actor===g);
  b.hazards.hurtGoat(5000,cyan);
  assert.equal(g.phase,2);
  b.hazards.hurtGoat(4000,cyan);
  assert.equal(g.phase,3);
  const killsBefore=cyan.kills;
  b.hazards.hurtGoat(5000,cyan);
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

  // God of Destruction Goat 8-arm telegraph avoidance!
  const g=b.hazards.spawnGoat(40);
  g.x=10; g.z=-16;
  g.cast={kind:'whirl',x:10,z:-16,radius:13,start:b.clock,at:b.clock+.45,end:b.clock+1.1,done:false,yaw:0};
  Object.assign(bot,{x:14,y:0,z:-16,down:0});
  b.motion.begin();
  assert(b.hnv1.survivalAction(bot,.05,null));
  assert.equal(bot.intent,'HNV1: 破壊神ゴートの8本腕を回避');
});



