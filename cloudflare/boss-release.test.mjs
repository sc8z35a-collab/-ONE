import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {frameOf} from './frame.js';
import {BOSS_ATTACK_TIMING,drawBossAttack} from '../dist/boss-effects.js';
import {BOSS_TENTACLES,drawBossModel} from '../dist/boss-model.js';
import {BOSS_SPEED,TENTACLE_REACH} from '../dist/boss.js';

const config={mode:'play',teamSize:4,weapon:'jet',sub:'throw'};
const engine=(stored=new Map())=>new RoomEngine(config,stored);
const saved=e=>new Map(Object.entries(structuredClone(e.checkpoint())));
const opponent=b=>b.actors.find(a=>a.team!==b.player.team);

test('weapon impacts expand floor coverage by 25 percent and wall coverage by 3.4× without changing damage',()=>{
  const {battle:b}=engine(), player=b.player, weapon=player.weapon;
  const floor=b.traceShot([10,1,-16],[10,-.15,-16],true);
  const oldRadius=weapon.radius*(.88+.23*.5)*1.26;
  b.paint.reset();
  b.paint.stamp(floor.position[0],floor.position[2],oldRadius,player.team,floor.layer,Math.PI,weapon.depth);
  const oldCoverage=b.paint.count[player.team];
  b.paint.reset();
  b.rng=()=>.5;
  b.splat(floor,{actor:player,weapon});
  const floorRatio=b.paint.count[player.team]/oldCoverage;
  assert(floorRatio>1.19 && floorRatio<1.32,floorRatio);
  const wall=b.traceShot([16,.55,-16],[17.2,.55,-16],true);
  assert.equal(wall.layer,undefined);
  const score=b.paint.count[player.team];
  b.splat(wall,{actor:player,weapon});
  assert(Math.abs((b.decals.at(-1).radius/oldRadius)**2-3.4)<1e-9);
  assert.equal(b.paint.count[player.team],score);
  assert.equal(weapon.damage,29);
});

test('a player can change weapons while paused and the acknowledged loadout survives room restoration',()=>{
  const e=engine(), b=e.battle, p=b.player;
  const bot=b.actors.find(a=>a!==p), botWeapon=bot.weapon;
  p.superCharge=100;
  assert(b.abilities.activate(p));
  Object.assign(p,{tank:53.5,hp:77,charge:.82,rollHold:.32,fire:.18,subReady:5});
  const send=(seq,loadout)=>e.poll(JSON.stringify({type:'input',seq,x:0,z:0,yaw:p.yaw,pitch:0,paused:true,loadout}),seq*1100);
  assert(send(1).checkpoint);
  const equip=send(2,{weapon:'charge',sub:'timed'});
  assert(equip.checkpoint && equip.frames.length);
  assert.equal(p.weapon.id,'charge');
  assert.equal(p.subId,'timed');
  assert.equal(p.activeSpecial,'shield');
  assert.deepEqual([p.tank,p.hp,p.fire,p.subReady,p.charge,p.rollHold],[53.5,77,.18,5,0,0]);
  assert.equal(b.clock,0);
  assert.equal(bot.weapon,botWeapon);
  const rejected=send(3,{weapon:'invalid',sub:'throw'});
  assert(!rejected.checkpoint);
  assert.equal(p.weapon.id,'charge');
  const r=engine(saved(e)).battle;
  assert.equal(r.player.weapon.id,'charge');
  assert.equal(r.player.subId,'timed');
  assert.equal(r.player.activeSpecial,'shield');
});

test('the boss gains health and cycles through a directed sweep, ground wave and late-phase mortar salvo',()=>{
  const {battle:b}=engine(), boss=b.boss, p=b.player, foe=opponent(b);
  boss.spawn();
  assert.equal(boss.hp,4200);
  assert.equal(new RoomEngine({...config,teamSize:8}).battle.boss.maxHp,6300);
  Object.assign(boss,{x:2,y:0,z:14});
  Object.assign(p,{x:8,y:0,z:14});
  Object.assign(foe,{x:20,y:0,z:10});
  boss.plan(p,6,[p,foe]);
  assert.equal(boss.attacks.at(-1).kind,'sweep');
  const phaseOneInterval=boss.next-b.clock;
  boss.hurt(boss.maxHp*.35);
  assert.equal(boss.phase,2);
  boss.plan(p,6,[p,foe]);
  assert.equal(boss.attacks.at(-1).kind,'slam');
  boss.hurt(boss.maxHp*.34);
  assert.equal(boss.phase,3);
  boss.plan(foe,18,[p,foe]);
  const salvo=boss.attacks.slice(-3);
  assert(salvo.every(a=>a.kind==='mortar' && a.arc.end>0 && a.arc.end<=1 && a.at-a.start>=.83));
  assert(boss.next-b.clock<phaseOneInterval);
  assert.equal(boss.cast.kind,'mortar');
  const frame=frameOf(b,0,0,[]);
  assert.deepEqual(frame.boss.cast,boss.cast);
  assert.equal(frame.boss.attacks.at(-1).arc.end,salvo.at(-1).arc.end);
  assert.equal(frameOf(b,1,0,[]).boss.attacks.length,0);
});

test('a sweep hits the sector only as its arm passes and does not hit the same player twice after restore',()=>{
  const e=engine(), b=e.battle, boss=b.boss, p=b.player, foe=opponent(b);
  boss.spawn();
  Object.assign(p,{x:10,y:0,z:-16,shield:0});
  Object.assign(foe,{x:5,y:0,z:-16,shield:0});
  const a=boss.attack(8,-16,4,.92,120,{kind:'sweep',yaw:Math.PI/2,halfAngle:1.05});
  b.clock=a.at+BOSS_ATTACK_TIMING.sweep.active*.16;
  boss.updateAttacks(1/24,[p,foe]);
  assert.equal(p.hp,p.maxHp);
  b.clock=a.at+BOSS_ATTACK_TIMING.sweep.active*.52;
  boss.updateAttacks(1/24,[p,foe]);
  assert(p.hp<p.maxHp);
  assert.equal(foe.hp,100);
  const r=engine(saved(e)).battle;
  const hp=r.player.hp;
  r.clock+=.037;
  r.boss.updateAttacks(1/24,[r.player,opponent(r)]);
  assert.equal(r.player.hp,hp);
  assert.equal(r.boss.attacks[0].hit.length,1);
});

test('attack meshes animate from warning through impact, and the boss coils and recoils with its cast',()=>{
  const {battle:b}=engine(), boss=b.boss;
  boss.spawn();
  for (const kind of ['mortar','sweep','slam']) {
    const a=boss.attack(-20,9,4.7,.92,100,{kind,yaw:Math.PI/2,halfAngle:kind==='sweep'?1.1:0});
    const render=(now,lite=false)=>{
      const parts=[];
      drawBossAttack({lite,add:(...p)=>parts.push(p),beam:(...p)=>parts.push(p)},a,now,3);
      return parts;
    };
    const warning=render(a.at-.21), active=render(a.at+.16), lite=render(a.at+.16,true);
    const visible=parts=>parts.find(part=>part[0]==='hazard');
    assert(visible(warning) && visible(active));
    assert.equal(visible(warning).at(-1).yaw,-Math.PI/2);
    assert(visible(active).at(-1).effect>=1);
    assert(active.length>lite.length);
    if (kind==='sweep') assert(active.some(part=>part[0]==='taper'));
    assert.equal(render(a.at+1.8).length,0);
  }
  const body=()=>{
    const parts=[];
    drawBossModel({lite:false,add:(...p)=>parts.push(p)},boss,.92);
    return parts;
  };
  const idle=body();
  boss.cast={kind:'slam',start:0,at:1.04,end:1.8};
  const coiled=body();
  assert(coiled.some(p=>p[8]===25));
  assert.notEqual(idle[0][2],coiled[0][2]);
});

test('the boss lashes five tentacles up to 10 m out, one per nearby crew member, and roams fast',()=>{
  const {battle:b}=engine(), boss=b.boss, p=b.player, foe=opponent(b);
  boss.spawn();
  assert.equal(BOSS_TENTACLES,5);
  assert.equal(TENTACLE_REACH,10);
  assert(BOSS_SPEED[0]>6 && BOSS_SPEED.every((v,i)=>!i || v>BOSS_SPEED[i-1]));
  Object.assign(boss,{x:0,y:0,z:0,volley:2});
  Object.assign(p,{x:6,y:0,z:0,vx:0,vz:0});
  Object.assign(foe,{x:-4,y:0,z:5,vx:0,vz:0});
  boss.plan(p,6,[p,foe]);
  const lash=boss.attacks.filter(a=>a.kind==='lash');
  assert.equal(lash.length,5);
  assert(lash.every(a=>Math.hypot(a.x-boss.x,a.z-boss.z)<=TENTACLE_REACH+1e-9));
  assert(lash.some(a=>Math.hypot(a.x-p.x,a.z-p.z)<.01) && lash.some(a=>Math.hypot(a.x-foe.x,a.z-foe.z)<.01));
  assert.equal(boss.cast.kind,'lash');
  assert.equal(boss.cast.points.length,5);
  const sweep=(boss.volley=0,boss.plan(p,6,[p,foe]),boss.attacks.at(-1));
  assert.equal(sweep.kind,'sweep');
  assert.equal(sweep.radius,TENTACLE_REACH);
  // The tentacles reach their strike points when the lash lands.
  const at=boss.attacks.find(a=>a.kind==='lash');
  boss.cast={kind:'lash',start:0,at:1,end:1.6,points:lash.map(a=>[a.x,a.z])};
  const parts=[];
  drawBossModel({lite:false,add:(...q)=>parts.push(q)},boss,1.18);
  const tips=parts.filter(q=>q[0]==='orb' || q[0]==='taper');
  assert(tips.some(q=>Math.hypot(q[1]-at.x,q[3]-at.z)<2.5));
  assert.equal(frameOf(b,0,0,[]).boss.cast.points.length,5);
});
