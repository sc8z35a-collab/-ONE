import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {BOSS_RESPAWN_SECONDS,EXP_PER_KILL,RESPAWN_SECONDS} from '../dist/battle.js';
import {bankResults,levelOf,loadCareer,matchResults,mostActive} from '../dist/progress.js';
import {DRONE_WEAPON,EBOT,SUPERS,weaponById} from '../dist/weapons.js';
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

test('117 textures in thirteen 3×3 sheets, every one of them used by the city shader',()=>{
  assert.equal(SURFACE_SHEETS.length,13);
  assert(SURFACE_SHEETS.every(sheet=>sheet.cells.length===9));
  assert.equal(new Set(SURFACES.map(surface=>surface.id)).size,117);
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
