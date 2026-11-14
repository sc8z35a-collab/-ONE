import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {frameOf} from './frame.js';
import {RoomEngine} from './room-engine.js';
import {setFullscreen} from '../dist/fullscreen.js';
import {Paint} from '../dist/ink.js';
import {INK_SIZE,applyInkPacket,paintPackets} from '../dist/ink-wire.js';
import {isCabin,sameLevel} from '../dist/layout.js';
import {RemoteMatch} from '../dist/remote-match.js';
import {clamp,forward,sub,unit} from '../dist/render.js';
import {SUPERS,WEAPONS,weaponById} from '../dist/weapons.js';
import {SUBWEAPONS} from '../dist/subweapons.js';
import {STAIRS,STAIR_SEAM,stairPoint} from '../dist/stairs.js';

const options={mode:'play',teamSize:4,weapon:'prism'};
const neutral={x:0,z:0,yaw:Math.PI/2,pitch:-.14};
const camera={eye:[10,1.1,-16],target:[15,1.1,-16]};
const restored=engine=>new RoomEngine(options,new Map(Object.entries(engine.checkpoint()))).battle;
const main=readFileSync(new URL('../dist/main.js',import.meta.url),'utf8');
const fragment=(first,next)=>main.slice(main.indexOf(first),main.indexOf(next,main.indexOf(first)+first.length));
const frameCode=fragment('function frame(now)', 'function fault(');

function simulateDisplay(extra={}) {
  const result={inputs:0,steps:[],draws:0};
  const page={graphicsLost:false,state:'match',dialogKind:null,rotationGate:false,document:{hidden:false},
    prevTime:0,activeClock:0,renderedWidth:900,renderedHeight:420,arena:{clientWidth:900,clientHeight:420},
    remote:null,requestAnimationFrame(){},cameraFor:()=>camera,drawFocus(){},updateHud(){},projectTags(){},placeTags(){},drawMap(){},
    mapTime:0,hudTime:0,clamp,isCabin,paint:{},damageFlash:{style:{}},
    getInput(){result.inputs++;return {...neutral,jump:result.inputs===1};},
    battle:{player:null,draw(){},update(dt,input){result.steps.push({dt,jump:input.jump});}},
    renderer:{clearDynamic(){},draw(){result.draws++;}},...extra};
  return {page,result,frame:runInNewContext(frameCode+'\nframe',page)};
}

test('a zero-duration first animation frame does not drop a queued jump',()=>{
  const {frame,result}=simulateDisplay();
  frame(100);
  assert.equal(result.inputs,0);
  frame(116);
  assert.deepEqual(result.steps,[{dt:.016,jump:true}]);
});

test('an open pause menu renders a resized viewport without running the match',()=>{
  const {frame,page,result}=simulateDisplay({prevTime:100,dialogKind:'pause'});
  frame(212);
  assert.equal(result.draws,0);
  page.arena.clientWidth=840;
  page.arena.clientHeight=400;
  frame(324);
  assert.equal(result.draws,1);
  assert.equal(result.inputs,0);
  assert.equal(page.activeClock,0);
  frame(436);
  assert.equal(result.draws,1);
});

test('a damage event makes the HUD edge flash red and then fades, including while the player is down',()=>{
  const battle={clock:1.12,player:{lastDamageAt:1.12,down:3},draw(){},update(){}};
  const {frame,page}=simulateDisplay({battle});
  frame(100);
  assert.equal(page.damageFlash.style.opacity,'1');
  battle.clock=1.36;
  frame(116);
  assert(Number(page.damageFlash.style.opacity)>.30 && Number(page.damageFlash.style.opacity)<.65);
  battle.clock=1.62;
  frame(132);
  assert.equal(page.damageFlash.style.opacity,'0');
});

test('Space reaches a focused HUD button and still jumps when the arena has focus',()=>{
  const page={state:'match',dialogKind:null,rotationGate:false,keys:new Set(),jumpQueued:false,
    canControl:()=>true};
  const handler=runInNewContext('('+fragment("document.addEventListener('keydown',event=>{\n  if (event.code==='Escape')", "document.addEventListener('keyup'")
    .slice("document.addEventListener('keydown',".length).trimEnd().slice(0,-2)+')',page);
  let prevented=0;
  const event={code:'Space',repeat:false,preventDefault(){prevented++;},target:{closest:()=>({tagName:'BUTTON'})}};
  handler(event);
  assert.equal(prevented,0);
  assert.equal(page.jumpQueued,false);
  event.target={closest:()=>null};
  handler(event);
  assert.equal(prevented,1);
  assert.equal(page.jumpQueued,true);
});

test('a failed health probe is retried on the next match start',async()=>{
  const modes=[],prompts=[];
  const page={renderer:{},connecting:null,AbortController,usingTouch:false,initAudio(){},setCompute(){},
    document:{createElement:()=>({})},cloudRequired:false,savedRoom:()=>null,cloud:null,cloudCheck:Promise.resolve(null),detectCloud:async()=>({ready:true}),
    remote:null,localPaint:{},paint:{},world:{},Battle:class {},sound(){},finish(){},
    prefs:{},mount:mode=>modes.push(mode),setPaint(){},accessCode:'',enterAccess:mode=>prompts.push(mode)};
  const start=runInNewContext(fragment('async function start(mode,', 'function mount(')+'\nstart',page);
  await start('play');
  await start('timeless');
  assert.deepEqual(modes,['play']);
  assert.deepEqual(prompts,['timeless']);
});

test('fullscreen tries the available prefixed API when the standard request is rejected',async()=>{
  const calls=[];
  const target={requestFullscreen:async()=>{calls.push('standard');throw Error('unsupported request');},
    webkitRequestFullscreen(){calls.push('webkit');}};
  const status=await setFullscreen(target,{doc:{fullscreenEnabled:true,webkitFullscreenEnabled:true},landscape:true,
    orientation:{lock:mode=>calls.push(mode)}});
  assert.equal(status,'active');
  assert.deepEqual(calls,['standard','webkit','landscape']);
});

test('a previously tracked lock disappears immediately when an enemy curtain closes the sightline',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, foe=b.actors[4];
  for (const a of b.actors) if (a!==p && a!==foe) a.down=99;
  b.countdown=0;
  Object.assign(foe,{x:15,y:0,z:-16,yaw:-Math.PI/2,shield:0});
  const marker={hidden:true,style:{setProperty(){}},classList:{toggle(){}}};
  const reticle={classList:{remove(){},toggle(){}}};
  const page={$:id=>id==='focus-lock'?marker:reticle,canControl:()=>true,battle:b,camera,
    renderer:{project:point=>[.5,.74-point[1]*.15]},arena:{clientHeight:420},focus:null,remote:null,sameLevel,clamp,sub,unit};
  const draw=runInNewContext(fragment('function drawFocus(now)', 'function projectTags(')+'\ndrawFocus',page);
  draw(100);
  assert.equal(marker.hidden,false);
  b.subweapons.items.push({id:'curtain',p:[12.5,.17,-16],yaw:Math.PI/2,halfWidth:2,height:1.95,hp:108,until:5,owner:foe});
  draw(116);
  assert.equal(marker.hidden,true);
  assert(page.focus===null);
});

test('the match loadout menu only applies its selected player weapon when confirmed',()=>{
  const {battle}=new RoomEngine(options);
  const preferences={weapon:battle.player.weapon.id,sub:battle.player.subId,teamSize:4};
  const makeElement=()=>({dataset:{},children:[],append(...nodes){this.children.push(...nodes);},setAttribute(){}});
  let panel,resumed=0;
  const page={battle,prefs:preferences,WEAPONS,SUBWEAPONS,SUPERS,weaponById,remote:null,dialogKind:null,rotationGate:false,
    document:{createElement:makeElement},button:(_name,_style,click)=>({...makeElement(),click}),
    showDialog(_kind,_title,content,actions){panel={content,actions};},
    closeLoadout(){},resumeBattle(){resumed++;},savePrefs(){},updateHud(){}};
  const open=runInNewContext(fragment('function loadout(', 'function resumeBattle(')+'\nloadout',page);
  open(true);
  panel.content.children[0].children.find(node=>node.dataset.weapon==='roller').click();
  assert.notEqual(battle.player.weapon.id,'roller');
  panel.actions[0].click();
  assert.equal(battle.player.weapon.id,'roller');
  assert.equal(preferences.weapon,'roller');
  assert.equal(resumed,1);
});

test('the lock brackets animate once per acquisition and smoothly expire without feeding back into aim',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, foe=b.actors[4];
  for (const a of b.actors) if (a!==p && a!==foe) a.down=99;
  b.countdown=0;
  Object.assign(foe,{x:15,y:0,z:-16,yaw:-Math.PI/2,shield:0});
  const variables={};
  const marker={hidden:true,style:{setProperty(key,value){variables[key]=value;}},classList:{toggle(){}}};
  const reticle={classList:{remove(){},toggle(){}}};
  const pose={eye:[...camera.eye],target:[...camera.target]};
  const page={$:id=>id==='focus-lock'?marker:reticle,canControl:()=>true,battle:b,camera:pose,
    renderer:{project:point=>[.5,.74-point[1]*.15]},arena:{clientHeight:420},focus:null,remote:null,sameLevel,clamp,sub,unit};
  const draw=runInNewContext(fragment('function drawFocus(now)', 'function projectTags(')+'\ndrawFocus',page);
  draw(100);
  assert(!marker.hidden && variables['--lock-zoom']>1.49);
  draw(320);
  assert.equal(page.focus.born,100);
  assert.equal(variables['--lock-zoom'],1);
  assert(variables['--lock-wave']>.4);
  assert.deepEqual(pose,camera);
  page.camera={eye:pose.eye,target:[pose.eye[0],pose.eye[1]+3,pose.eye[2]+5]};
  draw(486);
  assert(!marker.hidden && variables['--lock-alpha']<.68);
  draw(607);
  assert(marker.hidden);
});

function connectFixture(t,engine) {
  const Original=globalThis.WebSocket, location=globalThis.location;
  let socket;
  class Wire {
    static OPEN=1;
    static CLOSING=2;
    constructor() {socket=this;this.readyState=0;this.bufferedAmount=0;this.sent=[];}
    connected() {this.readyState=1;this.onopen();}
    receive(data) {this.onmessage({data});}
    send(data) {this.sent.push(JSON.parse(data));}
    close() {this.readyState=3;}
  }
  globalThis.WebSocket=Wire;
  globalThis.location={href:'https://inkshift.example/'};
  const client=new RemoteMatch({room:'a'.repeat(64),ticket:'fixture'},engine.battle.world);
  client.ready.catch(()=>{});
  t.after(()=>{client.close();globalThis.WebSocket=Original;globalThis.location=location;});
  return {client,socket:()=>socket,receive(now){
    socket.receive(engine.hello());
    for (const data of engine.frames(now,true)) socket.receive(data);
  }};
}

test('a paused remote loadout survives reconnect and stops retrying after the server acknowledges it',async t=>{
  const engine=new RoomEngine(options), link=connectFixture(t,engine), client=link.client;
  const socket=link.socket();
  socket.connected();
  link.receive(100);
  const scene=await client.ready;
  socket.close();
  socket.onclose({code:1006});
  clearTimeout(client.retry);
  client.equip('roller','trap');
  assert.equal(client.pendingLoadout.weapon,'roller');
  client.open();
  const next=link.socket();
  next.connected();
  link.receive(200);
  client.flush();
  const command=next.sent.at(-1);
  assert.deepEqual(command.loadout,{weapon:'roller',sub:'trap'});
  assert(command.paused);
  for (const packet of engine.poll(JSON.stringify(command),1200).frames) next.receive(packet);
  assert.equal(scene.player.weapon.id,'roller');
  assert.equal(scene.player.subId,'trap');
  assert.equal(client.pendingLoadout,null);
  client.flush();
  assert.equal(next.sent.length,1);
});

test('reconnect keeps the last scene intact until its complete replacement and snaps corrected positions',async t=>{
  const engine=new RoomEngine(options), b=engine.battle;
  Object.assign(b.player,{x:-43,z:-16});
  const projectile={id:7,pos:[-20,1,-16],vel:[1,0,0],actor:b.player,weapon:b.player.weapon};
  b.shots.push(projectile);
  const link=connectFixture(t,engine), client=link.client;
  const first=link.socket();
  first.connected();
  link.receive(100);
  const scene=await client.ready;
  first.close();
  first.onclose({code:1006});
  clearTimeout(client.retry);
  client.open();
  link.socket().connected();
  assert.equal(scene.shots[0]?.pos[0],-20);
  assert.equal(scene.player.x,-43);
  b.player.x=-40;
  b.transit.train.x+=2;
  projectile.pos[0]=-24;
  link.receive(200);
  assert.equal(scene.player.x,-40);
  assert.equal(scene.transit.train.x,b.transit.train.x);
  assert.equal(scene.shots[0].pos[0],-24);
  assert.equal(client.motions.length,0);
});

test('an open socket sends no gameplay input until its first ink snapshot is complete',async t=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.paint.stamp(10,-16,1.8,0,0,0,.057);
  const {client,socket}=connectFixture(t,engine);
  const wire=socket();
  wire.connected();
  wire.receive(engine.hello());
  const [header,...ink]=engine.frames(100,true);
  assert(ink.length>0);
  wire.receive(header);
  client.input({...neutral,fire:true,press:true},false);
  client.flush();
  assert.equal(wire.sent.length,0);
  for (const data of ink) wire.receive(data);
  await client.ready;
  client.flush();
  assert.equal(wire.sent.length,1);
  assert(!wire.sent[0].press && !wire.sent[0].fire);
});

test('a pause held back by socket backpressure is delivered before resumed actions',()=>{
  const sent=[];
  const socket={readyState:WebSocket.OPEN,bufferedAmount:70000,send:data=>sent.push(JSON.parse(data))};
  const client=Object.assign(Object.create(RemoteMatch.prototype),{socket,seq:0,paused:false,pauseSent:false,
    lastPauseSentAt:-Infinity,received:performance.now(),pending:{}});
  client.input({...neutral,press:true},false);
  client.input(null,true);
  client.flush();
  assert.equal(sent.length,0);
  client.input({...neutral,jump:true},false);
  socket.bufferedAmount=0;
  client.flush();
  assert(sent[0]?.paused && !sent[0].press && !sent[0].jump);
  client.lastPauseSentAt-=50;
  client.flush();
  assert(!sent[1]?.paused && sent[1]?.jump && !sent[1].press);
});

test('the fraction of a tick after the starting horn is playable',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  b.countdown=.01;
  const old=p.y;
  b.update(.026,{...neutral,jump:true},()=>camera);
  assert.equal(b.countdown,0);
  assert(Math.abs(b.elapsed-.016)<1e-9);
  assert(Math.abs(b.clock-.026)<1e-9);
  assert(p.y>old && p.vy>0);
});

test('a submerged player cannot see an enabled subweapon that refuses to launch',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  Object.assign(p,{x:10,y:0,z:-16,subId:'throw',swimming:true});
  assert.equal(b.subweapons.canUse(p),false);
  assert.equal(b.subweapons.use(p),false);
  p.swimming=false;
  assert(b.subweapons.canUse(p) && b.subweapons.use(p));
});

function openPlatform(b) {
  const rail=b.transit, {line,train}=rail, p=b.player;
  Object.assign(train,{doorOpen:1,wait:5});
  Object.assign(p,{x:line.center+train.x,y:line.platformY,z:line.platformZ});
  return {rail,p};
}

test('boarding and disembarking show the same disabled state that a slam enforces',()=>{
  const {battle:b}=new RoomEngine(options), {rail,p}=openPlatform(b);
  p.slam={};
  assert.equal(rail.option(p)?.kind,'busy');
  assert.equal(rail.use(p),false);
  p.slam=null;
  assert.equal(rail.option(p)?.kind,'cabin-board');
  assert.equal(rail.use(p),true);
  p.doorReady=0;
  p.slam={};
  assert.equal(rail.option(p)?.kind,'busy');
  assert.equal(rail.use(p),false);
  p.slam=null;
  assert.equal(rail.use(p),true);
});

test('entering a carriage clears a platform jump and its ground grace period',()=>{
  const {battle:b}=new RoomEngine(options), {rail,p}=openPlatform(b);
  p.jumpBuffer=.15;
  p.coyote=.08;
  assert(rail.use(p) && isCabin(p.x));
  assert.deepEqual([p.jumpBuffer,p.coyote],[0,0]);
  const foot=p.y;
  b.move(p,0,0,.016,false,false);
  assert.equal(p.y,foot);
  assert.equal(p.vy,0);
});

test('thin underground station cover protects the train from an explosion',()=>{
  const {battle:b}=new RoomEngine(options), rail=b.metro;
  const previous=rail.integrity;
  assert.equal(b.damageMetro(rail.line.center-60,rail.line.y,44.98,6,30),0);
  assert.equal(rail.integrity,previous);
  assert(b.damageMetro(rail.line.center-57,rail.line.y,44.98,6,30)>0);
  assert(rail.integrity<previous);
});

test('the boss cannot walk into the side of a stopped elevated train',()=>{
  const {battle:b}=new RoomEngine(options), rail=b.transit, boss=b.boss;
  boss.spawn();
  const z=rail.line.z-2.55;
  Object.assign(boss,{x:rail.line.center+rail.train.x,y:rail.line.y+.95,z,scan:10,target:b.player,next:999});
  Object.assign(b.player,{x:boss.x,y:boss.y,z:z+6,shield:0});
  assert(!rail.blocksActor(boss) && rail.blocksActor({...boss,z:z+.16}));
  boss.update(.05);
  assert.equal(boss.z,z);
});

test('the vortex pulls enemies through a physically open stair landing before it bursts',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player, foe=b.actors[4], stair=STAIRS[0];
  const site=stairPoint(stair,0,STAIR_SEAM-.88), enemy=stairPoint(stair,1,STAIR_SEAM+.89);
  Object.assign(p,site,{y:b.world.floor(site.x,site.z).y});
  Object.assign(foe,enemy,{y:b.world.floor(enemy.x,enemy.z).y,shield:0});
  b.abilities.advanced.vortex({actor:p,...site,y:p.y,age:.5,paintAt:1},1/24);
  assert(foe.x<enemy.x-.12 && foe.x>enemy.x-.3);
  assert.equal(foe.hp,100);
});

test('a deployed vortex stops in front of a thin street railing',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  Object.assign(p,{x:-16.6,y:0,z:-2.2,yaw:1.4784073464102077});
  const [dx,,dz]=forward(p.yaw);
  const from=[p.x,.91,p.z], to=[p.x+dx*9.5,.91,p.z+dz*9.5];
  const hit=b.traceShot(from,to,true);
  assert(hit && hit.t>.4 && hit.t<.5 && !b.traceShot(from,to));
  b.abilities.advanced.launch(p,'vortex');
  const [effect]=b.abilities.advanced.effects;
  assert(effect.x<hit.position[0]-.5 && effect.x>p.x+2);
});

test('wet droplets in flight still land and paint the same spot after a cold restore',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.drops.push({p:[10,1,-16],v:[0,-7,0],life:1,max:1,wet:.05,team:0,size:.22});
  const r=restored(engine);
  assert.deepEqual(r.drops,b.drops);
  for (let i=0;i<7;i++) {b.updateShots(1/24);r.updateShots(1/24);}
  assert.equal(r.paint.get(10,-16,0),1);
  assert.equal(r.paint.depthAt(10,-16,0),b.paint.depthAt(10,-16,0));
});

test('cold storage continues both the match and raider random streams',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  for (let i=0;i<19;i++) {b.rng();b.raiders.rng();}
  const r=restored(engine);
  for (let i=0;i<5;i++) assert.deepEqual([r.rng(),r.raiders.rng()],[b.rng(),b.raiders.rng()]);
});

test('stored ink retains its directional current and substep across eviction',()=>{
  const engine=new RoomEngine(options), b=engine.battle, p=b.paint;
  p.stamp(10,-16,1.44,0,0,0,.085);
  p.kick(10,-16,0,6.5,-3.6);
  p.advance(.031);
  const r=restored(engine).paint, cell=p.surfaceIndex(10,-16,0);
  assert(p.flowX[cell]!==0 && p.flowZ[cell]!==0);
  assert.deepEqual([r.time,r.flowX[cell],r.flowZ[cell]],[p.time,p.flowX[cell],p.flowZ[cell]]);
  p.advance(.03);
  r.advance(.03);
  assert.equal(r.cyan[cell],p.cyan[cell]);
  assert.equal(r.cyan[cell+1],p.cyan[cell+1]);
});

test('an active elimination feed survives a cold restore and drops expired entries',()=>{
  const engine=new RoomEngine(options), b=engine.battle;
  b.clock=12;
  b.events=[{label:'MIZUKI ▸ REN',team:0,until:13},{label:'old',team:1,until:11}];
  const r=restored(engine);
  assert.deepEqual(r.events,[b.events[0]]);
  assert.deepEqual(frameOf(r,0,0,[]).events,r.events);
});

test('replicated life and action timers do not advance before the server crosses zero',()=>{
  const {battle:b}=new RoomEngine(options), p=b.player;
  b.clock=12.001;
  b.countdown=.004;
  Object.assign(p,{hp:.004,down:.004,shield:.003,subId:'throw',subReady:12.004});
  const f=frameOf(b,0,0,[]);
  const client=Object.assign(Object.create(RemoteMatch.prototype),{world:b.world,paint:new Paint({...INK_SIZE,visualOnly:true}),motions:[]});
  client.apply(f);
  const remote=client.scene;
  assert.equal(remote.countdown,b.countdown);
  assert.equal(remote.player.hp,p.hp);
  assert.equal(remote.player.down,p.down);
  assert.equal(remote.player.shield,p.shield);
  remote.player.down=0;
  assert.equal(remote.subweapons.canUse(remote.player),false);
});

test('an older visible ink tile is delivered during continuous heavy changes near the player',()=>{
  const p=new Paint(INK_SIZE), mirror=new Paint({...INK_SIZE,visualOnly:true});
  p.netDirty=new Set([0]);
  p.netSent=new Uint16Array(p.layerSize*p.layers);
  p.owner[0]=1;
  p.pixels[0]=255;
  const near=[];
  for (let z=6;z<=10;z++) for (let x=10;x<=14;x++) near.push([x,z]);
  for (let frame=0;frame<3;frame++) {
    for (const [tx,tz] of near) {
      p.netDirty.add(tz*p.tilesWide+tx);
      for (let z=0;z<16;z++) for (let x=0;x<16;x++) {
        const i=(tz*16+z)*p.w+tx*16+x, team=(x+z+frame)%2;
        p.owner[i]=team+1;
        p.pixels[i*4]=team?0:255;
        p.pixels[i*4+1]=team?255:0;
        p.pixels[i*4+2]=32+frame*48;
      }
    }
    for (const bytes of paintPackets(p,1,false,{x:0,z:0})) {
      assert(bytes.byteLength<=7200);
      applyInkPacket(mirror,bytes);
    }
  }
  assert.equal(mirror.owner[0],1);
});
