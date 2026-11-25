import {Renderer,clamp,forward,mix,sub,unit} from './render.js';
import {World,randomGenerator} from './world.js';
import {Paint} from './ink.js';
import {WEAPONS,SUPERS,weaponById} from './weapons.js';
import {BASE_TANK,CITY_RADIUS,METRO,RAIL,SCENE_FILE,SCENE_VERSION,STATIONS,TRACK_LAYER,ZONES,isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {Transit} from './transit.js';
import {TouchControls} from './touch.js';
import {Battle,drawCrew} from './battle.js';
import {SoftwareRenderer} from './software.js';
import {RemoteMatch,createCloudRoom,detectCloud,forgetRoom,rememberRoom,savedRoom} from './remote-match.js';
import {REST_PITCH,aerialView,crewView} from './cloud-view.js';
import {fullscreenElement,setFullscreen} from './fullscreen.js';
import {STAIRS,stairLane,stairPoint} from './stairs.js';
import {SUBWEAPONS,subweaponById} from './subweapons.js';
import {inkReadout,inkResult} from './ink-hud.js';
import {bankResults,levelOf,loadCareer,matchResults,mostActive,playerExp} from './progress.js';
import {FILM_RATES,FILM_SECONDS,FILM_SIZES,Film,filmBytes,filmSupport} from './film.js';
import {BOSS_RESPAWN_SECONDS,EXP_PER_KILL,RESPAWN_SECONDS} from './battle.js';
import {TRAIN_DOORS} from './train-model.js';
import {BOSS_BODY_HEIGHT} from './boss-model.js';
import {StageObjects} from './stage-objects.js';
import {SURFACE_SIZES} from './surfaces.js';

const $ = id => document.getElementById(id);
const setText=(id,text)=>{
  const node=typeof id==='string'?$(id):id, value=String(text);
  if (node.textContent!==value) node.textContent=value;
};
const arena=$('arena'), game=$('game'), mini=$('minimap'), miniCtx=mini.getContext('2d');
const title=$('title-screen'), hud=$('hud'), dialog=$('dialog'), rotate=$('rotate'), damageFlash=$('damage-flash');
const embeddedApp=navigator.userAgent.includes('InkShiftAndroid/');
const cloudRequired=document.querySelector('meta[name=inkshift-compute]')?.content==='cloud-required';
game.classList.toggle('native-android',embeddedApp);
$('apk-download').hidden=embeddedApp;
$('android-cloud').hidden=!embeddedApp;
const mapTabs=[...document.querySelectorAll('[data-map-level]')];
const keys=new Set();
const PREF_KEY='inkshift-controls-v2';
// Draw-distance steps of the settings slider, nearest first; the last draws
// the whole city.
const DRAW_DISTANCES=[60,80,110,150,210,300,420,Infinity];
const drawDistanceName=index=>Number.isFinite(DRAW_DISTANCES[index])?DRAW_DISTANCES[index]+'m':'最大';
// Shortest frame gap each frame-rate cap allows (a little under the period,
// so a display running exactly at the cap is never skipped).
const frameGap=fps=>fps>=120?0:1000/fps-1.5;
const portrait=window.matchMedia('(orientation: portrait)');
let renderer, world, demoStage, paint, localPaint, battle=null, camera=null, yaw=Math.PI/2, pitch=REST_PITCH;
let state='title', dialogKind=null, activeClock=0, prevTime=0, hudTime=0, mapTime=0, watchYaw=0;
let usingTouch=matchMedia('(pointer: coarse)').matches;
let mute=true, audio, noise, jumpQueued=false, shotQueued=false, desktopFire=false, rotationGate=false, hadPointerLock=false;
let viewActor=null, viewZone=-1, viewHeight=0, viewX=0, viewZ=0, watchPitch=0, cameraReach=1, watchAerial=true;
let focus=null, fpsTime=0, film=null;
let superQueued=false, droneQueued=false, useQueued=false, subQueued=false, coQueued=false, demoTrain;
let remote=null, connecting=null, accessCode='', cloudCheck=null, cloud=null;
let sceneData, graphicsLost=false, graphicsTimeout=0;
let renderedWidth=0, renderedHeight=0;
const prefs=readPrefs();
let mapImage, mapLevel='auto', lastMessage='', lastFeed='';
const mapLayers=[];
let demoActors=[];
const tags=[];
const scoreNodes=[$('cyan-score'),$('orange-score')];
const teamBars=[$('cyan-bar'),$('orange-bar')];

const canControl=()=>!!battle?.player && battle.player.down<=0 && state==='match' && !dialogKind && !rotationGate && !graphicsLost;
const touch=new TouchControls(arena,$('stick'),{fire:$('touch-fire'),swim:$('touch-swim'),jump:$('touch-jump')},{
  enabled:()=>usingTouch && canControl(),
  aim:aimMove,press:()=>{shotQueued=true;},jump:()=>{jumpQueued=true;}
});

function readPrefs() {
  let saved={};
  try { saved=JSON.parse(localStorage.getItem(PREF_KEY) || '{}') ?? {}; } catch { /* Use defaults. */ }
  return {
    weapon:weaponById(saved.weapon).id,
    sub:subweaponById(saved.sub).id,
    teamSize:saved.teamSize===4?4:8,
    unlimitedTime:saved.unlimitedTime===true,
    sensitivity:Number.isFinite(saved.sensitivity)?clamp(saved.sensitivity,.55,1.75):1,
    quality:['ultra','lite','high'].includes(saved.quality)?saved.quality:'auto',
    resolution:['fhd','2k'].includes(saved.resolution)?saved.resolution:'auto',
    fps:[30,60].includes(saved.fps)?saved.fps:120,
    reflections:saved.reflections!==false,
    drawDistance:Number.isInteger(saved.drawDistance)?clamp(saved.drawDistance,0,DRAW_DISTANCES.length-1):DRAW_DISTANCES.length-1
  };
}


const QUALITY_NAMES={high:'高画質',lite:'軽量 400p',ultra:'超軽量 300p'};

// Automatic: phones and software rendering use the lightweight 400p mode,
// and step down to the ultra-light mode while a server match is streaming.
function qualityLevel() {
  if (prefs.quality!=='auto') return prefs.quality;
  if (!usingTouch && !renderer?.cpuRenderer) return 'high';
  return remote?'ultra':'lite';
}

const lightQuality=()=>qualityLevel()!=='high';

function applyQuality() {
  const level=qualityLevel();
  renderer?.setQuality(level);
  if (renderer?.options) Object.assign(renderer.options,{resolution:prefs.resolution,reflections:prefs.reflections,
    drawDistance:DRAW_DISTANCES[prefs.drawDistance],fps:prefs.fps});
  // The frame loop skips display frames that come sooner than the FPS cap.
  if (renderer) renderer.minFrameGap=frameGap(prefs.fps);
  $('quality').querySelector('b').textContent=QUALITY_NAMES[level];
  $('quality').setAttribute('aria-pressed',String(level!=='high'));
}

function createRenderer() {
  try {
    return new Renderer(arena,paint);
  } catch (error) {
    if (error.name!=='WebGLUnavailable') throw error;
    return new SoftwareRenderer(arena);
  }
}

function savePrefs() {
  try { localStorage.setItem(PREF_KEY,JSON.stringify(prefs)); } catch { /* Private browsing may restrict storage. */ }
  const versus=prefs.teamSize+' VS '+prefs.teamSize;
  $('match-tag').textContent=versus+(prefs.unlimitedTime?' · ∞':'');
  $('watch-caption').textContent='WATCH '+versus+(prefs.unlimitedTime?' · ∞':'');
  $('active-weapon').textContent=weaponById(prefs.weapon).name+' / '+subweaponById(prefs.sub).name;
  const tl=$('time-limit');
  if (tl) {
    tl.setAttribute('aria-pressed',String(prefs.unlimitedTime));
    setText('time-limit-state',prefs.unlimitedTime?'無制限 ∞':'7分');
  }
  applyQuality();
}

function configureTouch() {
  game.classList.toggle('touch-active',usingTouch);
  applyQuality();
  updateOrientation();
}

function updateOrientation() {
  const gated=usingTouch && portrait.matches && state==='match' && !dialogKind;
  const opening=gated && !rotationGate, closing=!gated && rotationGate;
  rotationGate=gated;
  rotate.hidden=!gated;
  title.inert=!!dialogKind || graphicsLost;
  hud.inert=arena.inert=gated || !!dialogKind || graphicsLost;
  const full=embeddedApp || !!fullscreenElement(), label=full?'全画面を解除':'全画面';
  $('fullscreen').querySelector('b').textContent=label;
  for (const id of ['fullscreen','hud-fullscreen']) {
    $(id).setAttribute('aria-label',label);
    $(id).setAttribute('aria-pressed',String(full));
    $(id).title=label;
  }
  $('rotate-fullscreen').hidden=full;
  if (opening) {
    suspendInput();
    $(full?'exit-rotate':'rotate-fullscreen').focus({preventScroll:true});
  } else if (closing && !dialogKind && state==='match') arena.focus({preventScroll:true});
}

function initAudio() {
  if (mute) return;
  try {
    const Context=window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    audio ||= new Context();
    if (audio.state==='suspended') audio.resume().catch(()=>{});
    if (!noise) {
      noise=audio.createBuffer(1,Math.ceil(audio.sampleRate*.22),audio.sampleRate);
      const wave=noise.getChannelData(0);
      for (let i=0;i<wave.length;i++) wave[i]=(Math.random()*2-1)*(1-i/wave.length);
    }
  } catch {
    audio=null;
  }
}

function sound(kind) {
  if (kind==='hit') showHit(false);
  else if (kind==='down') showHit(true);
  if (!audio || mute || audio.state!=='running') return;
  const now=audio.currentTime;
  const out=audio.createGain();
  out.connect(audio.destination);
  const hit=['shot','lob','damage','hit','blast','bomb'].includes(kind);
  const duration={shot:.11,lob:.19,hit:.10,damage:.19,tick:.13,go:.31,down:.29,super:.30,drone:.22,boss:.65,bossDown:.59,finish:.5,
    blast:.34,bomb:.30,mark:.18}[kind] || .14;
  out.gain.setValueAtTime(.001,now);
  out.gain.exponentialRampToValueAtTime(kind==='shot'?.08:.12,now+.006);
  out.gain.exponentialRampToValueAtTime(.001,now+duration);
  const oscillator=audio.createOscillator();
  oscillator.type=kind==='shot'?'sine':kind==='damage'?'triangle':'sine';
  const freq={shot:260,lob:142,hit:840,damage:127,tick:554,go:830,down:730,super:620,drone:440,boss:110,bossDown:493,finish:660,
    blast:92,bomb:104,mark:988}[kind] || 440;
  oscillator.frequency.setValueAtTime(freq,now);
  oscillator.frequency.exponentialRampToValueAtTime(freq*(kind==='shot'?.44:kind==='damage'?.58:1.34),now+duration*.73);
  oscillator.connect(out);
  oscillator.onended=()=>out.disconnect();
  oscillator.start(now);
  oscillator.stop(now+duration);
  if (hit) {
    const burst=audio.createBufferSource(), filter=audio.createBiquadFilter();
    burst.buffer=noise;
    filter.type='bandpass';
    filter.frequency.value=kind==='shot'?980:520;
    filter.Q.value=.76;
    burst.connect(filter).connect(out);
    burst.start(now);
    burst.stop(now+duration);
  }
}

async function fullScreen(toggle=false,help=false) {
  const result=await setFullscreen(game,{toggle,landscape:usingTouch});
  updateOrientation();
  if (result!=='blocked' || !help) return;
  const content=document.createElement('div'), hint=document.createElement('p');
  hint.textContent=window.top===window
    ?'この表示では全画面に切り替えられませんでした。スマホではブラウザのメニューからホーム画面に追加し、追加したアイコンから横向きで開けます。'
    :'ゲームを新しいタブで開き、そちらで全画面ボタンを押してください。';
  content.append(hint);
  const actions=[];
  if (window.top!==window) {
    const link=document.createElement('a');
    link.className='primary fullscreen-link';
    link.href=location.href;
    link.target='_blank';
    link.rel='noopener';
    link.textContent='新しいタブで開く';
    actions.push(link);
  }
  const wasPaused=dialogKind==='pause';
  actions.push(button('閉じる','secondary',()=>{
    hideDialog();
    if (wasPaused) pause();
  }));
  showDialog('fullscreen','横画面でプレイ',content,actions);
}

// A cross snaps open around the reticle when a shot connects; a splat gets a
// larger red one.
function showHit(kill) {
  const node=$('hit-marker');
  if (!node || !battle?.player) return;
  node.classList.remove('hit','kill');
  void node.offsetWidth;
  node.classList.add(kill?'kill':'hit');
}

function clearControls() {
  keys.clear();
  desktopFire=false;
  jumpQueued=shotQueued=superQueued=droneQueued=useQueued=subQueued=false;
  touch.clear();
  battle?.clearPlayerInput();
}

function suspendInput() {
  clearControls();
  remote?.input(null,true);
  remote?.flush();
}

// While waiting to respawn the player can still look around.
const canLook=()=>canControl() || !!battle?.player && battle.player.down>0 && state==='match' && !dialogKind && !rotationGate && !graphicsLost;

function aimMove(dx,dy,isTouch=false) {
  if (!canLook()) return;
  const screenScale=isTouch?clamp(430/arena.clientHeight,.76,1.21):1;
  const sensitivity=prefs.sensitivity*screenScale;
  yaw=(yaw+dx*(isTouch?.0052:.0031)*sensitivity)%(Math.PI*2);
  pitch=clamp(pitch-dy*(isTouch?.0043:.0031)*sensitivity,-.86,.70);
}

function getInput() {
  const x=touch.x+(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0);
  const z=touch.z+(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0);
  const jump=jumpQueued, press=shotQueued, superMove=superQueued, drone=droneQueued, use=useQueued, subMove=subQueued, co=coQueued;
  jumpQueued=shotQueued=superQueued=droneQueued=useQueued=subQueued=coQueued=false;
  return {x,z,yaw,pitch,press,super:superMove,drone,use,sub:subMove,co,fire:touch.fire||desktopFire||keys.has('KeyF'),
    swim:touch.swim||keys.has('ShiftLeft')||keys.has('ShiftRight'),jump,overview:watchAerial,eye:battle?.player?camera?.eye:null};
}

function requestPointer() {
  if (usingTouch || document.pointerLockElement || !arena.requestPointerLock) return;
  try { arena.requestPointerLock()?.catch(()=>{}); } catch { /* Drag aiming stays available. */ }
}

function releasePointer() {
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function button(label,style,action) {
  const element=document.createElement('button');
  element.className=style;
  element.type='button';
  element.textContent=label;
  element.addEventListener('click',action);
  return element;
}

function showDialog(kind,heading,content,actions) {
  dialogKind=kind;
  suspendInput();
  releasePointer();
  $('dialog-title').textContent=heading;
  dialog.firstElementChild.classList.toggle('wide',kind==='result');
  dialog.dataset.kind=kind;
  $('dialog-content').replaceChildren(content);
  $('dialog-actions').replaceChildren(...actions);
  dialog.hidden=false;
  updateOrientation();
  actions[0]?.focus({preventScroll:true});
}

function hideDialog() {
  dialogKind=null;
  dialog.hidden=true;
  updateOrientation();
}

function settings() {
  const block=document.createElement('div');
  block.className='controls-settings';
  const row=document.createElement('label');
  const label=document.createElement('span');
  label.textContent='照準感度';
  const range=document.createElement('input');
  range.type='range';
  range.min='.55';
  range.max='1.75';
  range.step='.05';
  range.value=String(prefs.sensitivity);
  const value=document.createElement('output');
  const read=()=>{value.textContent=Math.round(prefs.sensitivity*100)+'%';};
  read();
  range.addEventListener('input',()=>{
    prefs.sensitivity=Number(range.value);
    read();
    savePrefs();
  });
  row.append(label,range,value);
  const graphics=document.createElement('label');
  graphics.className='graphics-setting';
  const labelGraphics=document.createElement('span');
  labelGraphics.textContent='描画品質';
  const quality=document.createElement('select');
  for (const [value,name] of [['auto','自動（スマホは軽量・サーバー戦は超軽量）'],['ultra','超軽量（300p・最短の描画距離）'],
      ['lite','軽量（400p・影と反射なし・短い描画距離）'],['high','高画質（全エフェクト）']]) {
    const option=document.createElement('option');
    option.value=value;
    option.textContent=name;
    quality.append(option);
  }
  quality.value=prefs.quality;
  quality.addEventListener('change',()=>{prefs.quality=quality.value;savePrefs();});
  graphics.append(labelGraphics,quality);
  const choice=(name,key,options,parse=value=>value)=>{
    const row=document.createElement('label');
    row.className='graphics-setting';
    const label=document.createElement('span');
    label.textContent=name;
    const select=document.createElement('select');
    for (const [value,text] of options) {
      const option=document.createElement('option');
      option.value=String(value);
      option.textContent=text;
      select.append(option);
    }
    select.value=String(prefs[key]);
    select.addEventListener('change',()=>{prefs[key]=parse(select.value);savePrefs();});
    row.append(label,select);
    return row;
  };
  const resolution=choice('解像度','resolution',[['auto','自動（画面と負荷に合わせる）'],['fhd','FHD（1920×1080）'],['2k','2K（2560×1440）']]);
  const fps=choice('フレームレート','fps',[[30,'30 fps'],[60,'60 fps'],[120,'120 fps']],Number);
  const mirror=choice('路面の反射','reflections',[[true,'反射あり'],[false,'反射なし']],value=>value==='true');
  const far=document.createElement('label');
  const farLabel=document.createElement('span');
  farLabel.textContent='描画距離';
  const farRange=document.createElement('input');
  farRange.type='range';
  farRange.min='0';
  farRange.max=String(DRAW_DISTANCES.length-1);
  farRange.step='1';
  farRange.value=String(prefs.drawDistance);
  const farValue=document.createElement('output');
  farValue.textContent=drawDistanceName(prefs.drawDistance);
  farRange.addEventListener('input',()=>{
    prefs.drawDistance=Number(farRange.value);
    farValue.textContent=drawDistanceName(prefs.drawDistance);
    savePrefs();
  });
  far.append(farLabel,farRange,farValue);
  const rate=document.createElement('p');
  rate.className='result-note';
  const hz=Math.round(1000/(renderer?.refreshInterval || 16.7));
  rate.textContent='この画面は約'+hz+'Hz。解像度の固定は高画質のときに使われ、自動では負荷に応じて内部解像度を下げて維持します。描画距離を縮めると、遠くの街並みは霞に溶けて描かれなくなります。';
  block.append(row,graphics,resolution,fps,mirror,far,rate);
  return block;
}

function guide() {
  const content=document.createElement('div');
  content.innerHTML=`<dl class="guide">
    <dt>移動・照準</dt><dd>左のスティックで移動。右をスワイプ、または撃つボタンをドラッグして照準を動かせます。照準が敵に重なるとロック枠が敵に吸い付き、動く敵を残像と進行方向の矢印つきで追い続けます。弾が命中すると大きな光の輪と十字が広がり、照準にもヒットマークが出ます。弾の狙いは手動です。</dd>
    <dt>潜水・壁登り</dt><dd>未塗装の床でもイカになれます。自チームのインクで回復が速くなり、塗った壁に向かって移動すると登れます。敵インクに立ち続けると、移動・回復・スーパーの蓄積が1秒ごとに少し落ちます。</dd>
    <dt>ジャンプ射撃・インク</dt><dd>撃つボタンを押したまま、別の指でジャンプできます。ゲージの黄色い部分が次の射撃で使うインクです。攻撃を受けると画面の縁が赤く光ります。</dd>
    <dt>武器選択</dt><dd>タイトルの「武器を選ぶ」か、対戦中の「武器変更」でメインとサブを選べます。装備を変えてもインク残量と待ち時間は引き継ぎます。</dd>
    <dt>ローラー・サブ</dt><dd>ローラーは短押しで振り、長押ししながら前進すると転がして塗れます。ジャンプ中に押すと空中でインクを振り飛ばします。メインとは別にサブを1つ選択。画面左上のサブボタンかGで使います。敵の時限ボムの輪からは離れましょう。</dd>
    <dt>外周街区・高架道路</dt><dd>街区は中心から半径500mです。中央通りから外周道路へ歩いて探索できます。高架道路の上り口は南側の ROUTE 07 標識が目印です。</dd>
    <dt>列車</dt><dd>高架線は街をぐるりと一周する環状線で、地上西駅→地上東駅→東のカーブ→南側の高架→西のカーブ→地上西駅の順に一方向へ走ります。B1の地下鉄は地下西駅と地下東駅を往復します。停車中に乗車ボタンかR、または開いた扉へ歩いて乗れます。車内では移動・射撃・塗りができ、停車駅で降車ボタンか扉へ歩いて降ります。乗降しても視点の向きは維持されます。広いB1へは街の4か所の階段からも歩いて降りられます。</dd>
    <dt>スーパー・ドローン</dt><dd>塗りと攻撃でスーパーがたまると、画面左上のボタンで発動できます。武器ごとに技が異なります。ドローンは1人1機で、塗りを広げながら、見えている敵へ1秒に1発の追従インク弾を撃ちます。召喚から60秒で再使用できます。</dd>
    <dt>新しい武器とスーパー</dt><dd>RD II QUATRO＋は5発の重弾を高速連射する武器で、圧倒的な火力と広い塗り範囲、高い機動力を備えます。TDは前方の扇形を一気に塗って敵を吹き飛ばす衝撃砲。OM Bombは弾が敵を追従する強化、OM BOMB IIはその2連発版（1発の攻撃は半分、塗りは2倍）、ebotは体力60・塗りと攻撃が半分の分身を2体呼びます。</dd>
    <dt>SW OUT / SW OUT II</dt><dd>1回で2発撃つ拳銃。照準が敵をロックしているときに撃つと、弾が敵をある程度追いかけます。SW OUTは追従が働く射撃だけインクを2倍使い、攻撃力は通常の半分。プレイヤー専用のSW OUT IIは追従中も消費が増えず、基本消費4割減・弾速1.3倍・追従力と範囲と射程1.5倍。COモード（CキーかCOボタン）では発射間隔が2倍になる代わりに追従力がさらに2倍になります。</dd>
    <dt>See Elite</dt><dd>投げた場所の半径3mに敵が入ると、その敵を20秒間マーキングします。壁越しに名前が見え、ミニマップにも表示されます。</dd>
    <dt>復活とEXP</dt><dd>倒されると復活まで12秒、オオモノイカに倒された場合は15秒かかります。敵を1人倒すごとに30 EXP。試合終了後に全員分が集計され、リザルトで全クルーの記録とEXPを確認できます。EXPはこの端末に貯まります。</dd>
    <dt>画質とフレームレート</dt><dd>軽量は400p・影と反射なし・短い描画距離、超軽量は300pでさらに軽い描画です。下の設定で、解像度（自動・FHD・2K）、フレームレートの上限（30・60・120fps）、路面の反射の有無、描画距離（60m〜最大）を選べます。</dd>
    <dt>スーパーギガチップ</dt><dd>ステージに落ちたチップを拾うと、その試合中は持てるインクが2倍になります。</dd>
    <dt>街の遮蔽物</dt><dd>木箱、レンガ、コンクリートブロックや、マンションと店舗のガラスはインク弾で壊せます。舗装路の先にある3棟は、1試合につき各キャラ1棟1回入れて室内を塗れます。</dd>
    <dt>タイムレスバトル</dt><dd>時間無制限の4対4。最初の襲撃は80秒後で、以降118秒ごとにオクトパスゼイアン4体が現れます。</dd>
    <dt>7分のナワバリ戦</dt><dd>床の塗り面積で勝敗が決まり、開始3分でオオモノイカが乱入します。</dd>
    <dt>PC</dt><dd>WASD、マウス、左クリックまたはFで射撃、Shiftで潜る、Spaceでジャンプ、Gでサブ、Qでスーパー、Eでドローン、CでSW OUT IIのCOモード。</dd>
  </dl>`;
  content.append(settings());
  showDialog('guide','操作ガイド',content,[button('閉じる','primary',()=>{
    hideDialog();
    $('how').focus({preventScroll:true});
  })]);
}

function loadout(inMatch=false) {
  if (inMatch && (!battle?.player || battle.finished || rotationGate)) return;
  const player=inMatch?battle.player:null;
  const draft={
    weapon:inMatch?remote?.pendingLoadout?.weapon??player.weapon.id:prefs.weapon,
    sub:inMatch?remote?.pendingLoadout?.sub??player.subId:prefs.sub,
    teamSize:prefs.teamSize,
    unlimitedTime:prefs.unlimitedTime
  };
  const kind=inMatch?(dialogKind==='pause'?'pause-loadout':'match-loadout'):'loadout';
  const content=document.createElement('div');
  const teamOptions=document.createElement('div');
  teamOptions.className='team-options';
  const weapons=document.createElement('div');
  weapons.className='weapon-options';
  const description=document.createElement('p');
  description.className='super-description';
  const subOptions=document.createElement('div');
  subOptions.className='weapon-options sub-options';
  function refresh() {
    for (const option of teamOptions.children) {
      if (option.dataset.size) option.setAttribute('aria-pressed',String(Number(option.dataset.size)===draft.teamSize));
      if (option.dataset.unlimited) option.setAttribute('aria-pressed',String((option.dataset.unlimited==='true')===draft.unlimitedTime));
    }
    for (const option of weapons.children) option.setAttribute('aria-pressed',String(option.dataset.weapon===draft.weapon));
    for (const option of subOptions.children) option.setAttribute('aria-pressed',String(option.dataset.sub===draft.sub));
    const special=SUPERS[weaponById(draft.weapon).special];
    description.textContent=special.name+'　'+special.detail;
  }
  if (!inMatch) {
    for (const size of [4,8]) {
      const option=button(size+'対'+size,'option',()=>{draft.teamSize=size;refresh();});
      option.dataset.size=String(size);
      teamOptions.append(option);
    }
    for (const [unlimited,label] of [[false,'試合時間 7分'],[true,'試合時間 無制限 ∞']]) {
      const option=button(label,'option',()=>{draft.unlimitedTime=unlimited;refresh();});
      option.dataset.unlimited=String(unlimited);
      teamOptions.append(option);
    }
  }
  for (const weapon of WEAPONS) {
    const option=button('','weapon-card',()=>{draft.weapon=weapon.id;refresh();});
    option.dataset.weapon=weapon.id;
    const name=document.createElement('b'), role=document.createElement('span'), detail=document.createElement('small');
    name.textContent=weapon.name;
    role.textContent=weapon.role;
    detail.textContent=weapon.detail;
    option.append(name,role,detail);
    weapons.append(option);
  }
  for (const sub of SUBWEAPONS) {
    const option=button('','weapon-card',()=>{draft.sub=sub.id;refresh();});
    option.dataset.sub=sub.id;
    const name=document.createElement('b'), cost=document.createElement('span'), detail=document.createElement('small');
    name.textContent=sub.name;
    cost.textContent=sub.role+' · '+sub.cooldown+'秒';
    detail.textContent=sub.detail;
    option.append(name,cost,detail);
    subOptions.append(option);
  }
  const heading=document.createElement('h3');
  heading.className='loadout-heading';
  heading.textContent='サブウェポンを1つ選択';
  if (!inMatch) content.append(teamOptions);
  content.append(weapons,description,heading,subOptions);
  refresh();
  showDialog(kind,inMatch?'プレイヤーの装備を変更':'プレイヤーの武器と対戦人数',content,[
    button(inMatch?'装備して対戦に戻る':'この装備を選ぶ','primary',()=>{
      Object.assign(prefs,draft);
      savePrefs();
      if (inMatch) {
        if (remote) remote.equip(draft.weapon,draft.sub);
        else battle.equipPlayer(draft.weapon,draft.sub);
        updateHud();
        resumeBattle();
      } else closeLoadout();
    }),
    button('キャンセル','secondary',closeLoadout)
  ]);
}

// Offline film: one full NPC match rendered to an MP4 on this device, from
// the camera of the crew member who was most active.
function filmDialog(defaults={size:'fhd',fps:60}) {
  if (state!=='title' || film || connecting) return;
  const content=document.createElement('div'), form=document.createElement('div');
  form.className='film-form';
  const intro=document.createElement('p');
  intro.textContent='NPC同士の8対8を7分まるごと、この端末でレンダリングしてMP4に書き出します。試合全体を先に演算し、最も活躍したNPCのカメラで、高画質設定のまま1フレームずつ描画します。BGMと効果音も高ビットレートで収録します。';
  const choice=(title,options,value)=>{
    const row=document.createElement('label'), name=document.createElement('span'), select=document.createElement('select');
    name.textContent=title;
    for (const [key,text] of options) {
      const option=document.createElement('option');
      option.value=key;
      option.textContent=text;
      select.append(option);
    }
    select.value=String(value);
    row.append(name,select);
    form.append(row);
    return select;
  };
  const size=choice('解像度',Object.entries(FILM_SIZES).map(([key,item])=>[key,item.label]),defaults.size);
  const rate=choice('フレームレート',FILM_RATES.map(fps=>[String(fps),fps+' fps']),defaults.fps);
  const status=document.createElement('p');
  status.className='film-status';
  let support=null, probe=0;
  const begin=button('書き出しを開始','primary',()=>{
    if (support && !support.reason) runFilm(size.value,Number(rate.value),support);
  });
  const refresh=async()=>{
    const ticket=++probe;
    begin.disabled=true;
    status.textContent='この端末のエンコーダーを確認しています…';
    support=await filmSupport(renderer,size.value,Number(rate.value));
    if (ticket!==probe) return;
    begin.disabled=!!support.reason;
    const frames=Math.round(FILM_SECONDS*Number(rate.value));
    const bytes=support.reason?0:filmBytes(support);
    const estimate=bytes>=1e9?'約'+(bytes/1e9).toFixed(1)+' GB':'約'+Math.round(bytes/1e6)+' MB';
    status.textContent=support.reason ?? '映像 '+support.video.label+' · 約'+Math.round(support.video.config.bitrate/1e6)+' Mbps\n音声 '+
      (support.audio?support.audio.label+' · '+Math.round(support.audio.config.bitrate/1000)+' kbps · 48 kHz ステレオ':'なし（この端末は音声エンコード非対応）')+
      '\n全 '+frames.toLocaleString()+' フレーム · ファイル '+estimate+'。書き出し中はこの画面を開いたままにしてください。';
  };
  size.addEventListener('change',refresh);
  rate.addEventListener('change',refresh);
  content.append(intro,form,status);
  showDialog('film','NPC戦を動画に書き出す',content,[begin,button('閉じる','secondary',()=>{
    probe++;
    hideDialog();
    $('film').focus({preventScroll:true});
  })]);
  refresh();
}

async function runFilm(size,fps,support) {
  const content=document.createElement('div'), status=document.createElement('p'), bar=document.createElement('div'), fill=document.createElement('i');
  status.className='film-status';
  bar.className='film-bar';
  bar.append(fill);
  content.append(status,bar);
  const clock=seconds=>Math.floor(seconds/60)+'分'+String(Math.floor(seconds%60)).padStart(2,'0')+'秒';
  const job=film=new Film({canvas:arena,renderer,world,size,fps,support,onProgress(update) {
    const part=update.total?update.done/update.total:0;
    if (update.phase==='analyze') {
      fill.style.width=(part*100).toFixed(1)+'%';
      status.textContent='1/2　試合を演算して、最も活躍したNPCを調べています\n'+Math.round(part*100)+'%';
    } else if (update.phase==='render') {
      fill.style.width=(part*100).toFixed(1)+'%';
      status.textContent='2/2　'+update.star+'（'+update.weapon+'）のカメラで描画中\n'+update.done.toLocaleString()+' / '+
        update.total.toLocaleString()+' フレーム · 試合 '+clock(update.clock)+'\n毎秒 '+update.rate.toFixed(1)+' フレーム · 残り約 '+clock(update.remaining)+
        ' · '+(update.bytes/1048576).toFixed(0)+' MB';
    } else status.textContent='ファイルをまとめています…';
  }});
  const previous=state;
  state='film';
  game.classList.add('filming');
  showDialog('film',FILM_SIZES[size].label+' · '+fps+' fps',content,[button('中止','secondary',()=>job.cancel())]);
  let result=null, problem=null;
  try {
    result=await job.run();
  } catch (error) {
    problem=error;
  }
  film=null;
  state=previous;
  game.classList.remove('filming');
  setPaint(localPaint);
  renderer.configureWorld?.(world,paint);
  applyQuality();
  prevTime=0;
  renderedWidth=renderedHeight=0;
  if (problem?.canceled) {
    hideDialog();
    $('film').focus({preventScroll:true});
    return;
  }
  const done=document.createElement('div'), note=document.createElement('p');
  note.className='film-status';
  const actions=[];
  if (result) {
    const url=URL.createObjectURL(result.blob), link=document.createElement('a');
    link.className='primary fullscreen-link';
    link.href=url;
    link.download=result.name;
    link.textContent='MP4を保存（'+(result.blob.size/1048576).toFixed(0)+' MB）';
    note.textContent='書き出しが完了しました。\n'+FILM_SIZES[size].label+' · '+fps+' fps · '+clock(result.seconds)+'\n映像 '+result.video+
      ' · 音声 '+(result.audio ?? 'なし')+'\nカメラ：'+result.star+'（'+result.weapon+' · 撃破 '+result.kills+'）\n所要時間 '+clock(result.elapsed);
    actions.push(link,button('閉じる','secondary',()=>{
      URL.revokeObjectURL(url);
      hideDialog();
      $('film').focus({preventScroll:true});
    }));
  } else {
    note.textContent='書き出せませんでした。\n'+(problem?.message ?? '原因不明のエラーです。')+'\n解像度かフレームレートを下げると成功する場合があります。';
    actions.push(button('設定に戻る','primary',()=>{hideDialog();filmDialog({size,fps});}),button('閉じる','secondary',hideDialog));
  }
  done.append(note);
  showDialog('film',result?'動画ができました':'書き出しエラー',done,actions);
}

function resumeBattle() {
  hideDialog();
  arena.focus({preventScroll:true});
  if (battle.player) requestPointer();
}

function closeLoadout() {
  if (dialogKind==='pause-loadout') pause();
  else if (dialogKind==='match-loadout') resumeBattle();
  else {
    hideDialog();
    $('loadout').focus({preventScroll:true});
  }
}

function pause() {
  if (state!=='match' || battle.finished) return;
  if (dialogKind==='pause') {
    resumeBattle();
    return;
  }
  const info=settings();
  const actions=[button('対戦に戻る','primary',pause)];
  if (battle.player) actions.push(button('武器を変更','secondary',()=>loadout(true)));
  if (!embeddedApp && !fullscreenElement()) actions.push(button('全画面','secondary',()=>fullScreen(false,true)));
  if (battle.unlimited) actions.push(button('試合を終えてリザルトへ','secondary',finish));
  actions.push(button('タイトルへ','secondary',showTitle));
  showDialog('pause','一時停止',info,actions);
}

function finish() {
  state='result';
  if (remote) forgetRoom(remote.ticket,battle.mode);
  const {scores,title}=inkResult(paint);
  drawMap();
  const content=document.createElement('div');
  content.innerHTML='<div class="result-scores"><div>CYAN<b>'+scores[0]+'</b></div><div>AMBER<b>'+scores[1]+'</b></div></div>';
  matchRecord(content);
  showDialog('result',title,content,[
    button('もう一戦','primary',()=>start(battle.mode,'new')),
    button('タイトルへ','secondary',showTitle)
  ]);
}

function resetSquads() {
  for (const id of ['cyan-squad','orange-squad']) $(id).replaceChildren();
  $('floaters').replaceChildren();
  tags.length=0;
  syncTags();
}

// Name tags follow the crew list, which grows and shrinks with ebot copies.
function syncTags() {
  const actors=battle.actors;
  if (tags.length===actors.length && tags.every((tag,i)=>tag.actor===actors[i] && tag.name===actors[i].name)) return;
  const old=new Map(tags.map(tag=>[tag.actor,tag]));
  const next=actors.map(actor=>{
    const prior=old.get(actor);
    if (prior && prior.name===actor.name) {
      old.delete(actor);
      return prior;
    }
    const copy=!!(actor.clone || actor.cloneOf);
    let dot=null;
    if (!copy) {
      dot=document.createElement('span');
      dot.className='squad-dot'+(actor.isPlayer?' you':'');
      dot.title=actor.name;
      (actor.team===0?$('cyan-squad'):$('orange-squad')).append(dot);
    }
    const label=document.createElement('span');
    label.className=(actor.team===1?'enemy':'')+(copy?' copy':'');
    label.textContent=actor.name;
    label.hidden=true;
    $('floaters').append(label);
    return {actor,name:actor.name,dot,label,visible:false};
  });
  for (const tag of old.values()) {
    tag.label.remove();
    tag.dot?.remove();
  }
  tags.length=0;
  tags.push(...next);
}

function showCareer() {
  const total=playerExp();
  setText('career-exp',total);
  setText('career-level',levelOf(total));
}

// Every crew member's record for the match. EXP is added up here, once the
// match is over, and banked to the totals kept on this device.
function matchRecord(content) {
  const rows=matchResults(battle,paint);
  const career=battle.expBanked?loadCareer():bankResults(rows);
  battle.expBanked=true;
  const best=mostActive(rows), mvp=best?.activity>0?best:null, me=rows.find(row=>row.isPlayer);
  if (me) {
    const line=document.createElement('p');
    line.className='result-note';
    const total=career.exp[me.name]??0;
    line.textContent='あなたの記録　撃破 '+me.kills+' × '+EXP_PER_KILL+' = +'+me.exp+' EXP　塗り '+me.area+' m²　ダウン '+me.downs+
      '　累計 '+total+' EXP（Lv.'+levelOf(total)+'）';
    content.append(line);
  }
  const scroll=document.createElement('div'), table=document.createElement('table');
  scroll.className='result-scroll';
  table.className='result-table';
  const cells=(row,values,tag='td')=>values.map((value,i)=>{
    const cell=document.createElement(tag);
    cell.textContent=String(value);
    if (tag==='td' && i===8) cell.className='exp';
    if (tag==='td' && i===9) cell.className='total';
    row.append(cell);
    return cell;
  });
  const head=table.createTHead().insertRow();
  cells(head,['クルー','武器','撃破','ダウン','塗り m²','与ダメ','スーパー','サブ','EXP','累計 EXP'],'th');
  const body=table.createTBody();
  for (const team of [0,1]) {
    for (const row of rows.filter(entry=>entry.team===team).sort((a,b)=>b.activity-a.activity)) {
      const line=body.insertRow(), total=career.exp[row.name]??0;
      line.className=(team===0?'cyan':'amber')+(row.isPlayer?' you':'')+(row===mvp?' mvp':'');
      cells(line,[row.name,row.weapon,row.kills,row.downs,row.area,row.dealt,row.supers,row.subs,'+'+row.exp,total+' · Lv.'+levelOf(total)]);
    }
  }
  scroll.append(table);
  const note=document.createElement('p');
  note.className='result-note';
  note.textContent='EXP は撃破1回につき '+EXP_PER_KILL+'。試合終了後にまとめて加算され、この端末に貯まります。MVP は撃破・塗り・与ダメージの合計が最も高いクルーです。';
  content.append(scroll,note);
  showCareer();
}

function setCompute(text) {
  const badge=$('compute-state');
  if (badge.textContent!==text) badge.textContent=text;
}

function setPaint(next) {
  if (paint===next) return;
  paint=next;
  renderer.configureWorld?.(world,paint);
  mapSetup();
}

function enterAccess(mode,note='') {
  const content=document.createElement('div');
  content.className='access-panel';
  const label=document.createElement('label'), field=document.createElement('input');
  label.textContent='Cloudflare 対戦接続キー';
  field.type='password';
  field.autocomplete='off';
  field.maxLength=160;
  const hint=document.createElement('p');
  hint.textContent=note || '設定した接続キーを入力して、サーバーで対戦を開始します。';
  const enter=()=>{
    if (!field.value) {field.focus();return;}
    accessCode=field.value;
    field.value='';
    start(mode,'new');
  };
  field.addEventListener('keydown',event=>{if (event.key==='Enter') enter();});
  label.append(field);
  content.append(hint,label);
  showDialog('access','サーバーに接続',content,[button('接続','primary',enter),button('戻る','secondary',hideDialog)]);
  field.focus();
}

function syncTravel(actor,previous,respawned) {
  if (respawned) ({yaw,pitch}={yaw:actor.yaw,pitch:REST_PITCH});
  if (respawned || isCabin(previous)!==isCabin(actor.x)) viewActor=null;
}

async function start(mode,request='choose') {
  if (!renderer || connecting) return;
  const token={client:null,canceled:false,controller:new AbortController()};
  connecting=token;
  const p=document.createElement('p');
  try {
    if (usingTouch) fullScreen();
    initAudio();
    cloud=await (cloudCheck ??= detectCloud(cloudRequired));
    if (token.canceled) return;
    if (!cloud || !cloud.ready) cloudCheck=null;
    setCompute(cloud?(cloud.ready?'CLOUDFLARE · サーバー演算':'CLOUDFLARE · 設定待ち'):'LOCAL · 端末内演算');
    if (!cloud) {
      remote?.close();
      remote=null;
      applyQuality();
      setPaint(localPaint);
      mount(mode,new Battle(world,paint,mode,{sound,finish,spawn:actor=>{
        yaw=actor.yaw;
        pitch=REST_PITCH;
        viewActor=null;
      }},{teamSize:prefs.teamSize,weapon:prefs.weapon,sub:prefs.sub,unlimitedTime:prefs.unlimitedTime}));
      return;
    }
    if (!cloud.ready) {
      p.textContent=cloud.unreachable?'対戦サーバーに応答がありません。接続を確認してから再試行してください。':
        cloud.outdated?'ゲームの更新後にページを再読み込みしてください。':'Workerで GAME_ACCESS_CODE を設定すると開始できます。';
      showDialog('server',cloud.unreachable?'対戦サーバーに接続できません':'Cloudflareの設定待ち',p,[button('閉じる','primary',hideDialog)]);
      return;
    }
    const prior=savedRoom(mode);
    if (request==='choose' && prior) {
      if (remote && !remote.closed && battle?.mode===mode) return;
      p.textContent='このタブで中断した対戦を再開できます。';
      showDialog('server','対戦を再開',p,[button('続きから','primary',()=>start(mode,'resume')),
        button('新しく始める','secondary',()=>start(mode,'new')),button('戻る','secondary',hideDialog)]);
      return;
    }
    const resume=request==='resume'?prior:null;
    if (!resume && !accessCode) {enterAccess(mode);return;}
    p.textContent=resume?'保存した対戦へ接続しています。':'対戦ルームとインク場を準備しています。';
    const cancel=()=>{
      token.canceled=true;
      token.controller.abort();
      token.client?.close();
      if (connecting===token) {
        connecting=null;
        hideDialog();
      }
    };
    showDialog('server','サーバーに接続中',p,[button('戻る','secondary',cancel)]);
    const ticket=resume ?? await createCloudRoom({mode,teamSize:prefs.teamSize,weapon:prefs.weapon,sub:prefs.sub,unlimitedTime:prefs.unlimitedTime},accessCode,token.controller);
    if (token.canceled) return;
    const client=token.client=new RemoteMatch(ticket,world,{sound,onTravel:syncTravel,status:(state,note)=>{
      setCompute(state==='connected'?'CLOUDFLARE · 接続中':state==='reconnecting'?'CLOUDFLARE · 再接続中':'CLOUDFLARE · 接続切れ');
      $('network-note').hidden=state==='connected';
      $('network-note').textContent=state==='reconnecting'?'サーバーに再接続しています':note ?? '';
      if (state==='error' && remote===client && battle) {
        const text=document.createElement('p');
        text.textContent=note;
        showDialog('server','サーバーとの接続が終了',text,[button('タイトルへ','primary',showTitle)]);
      }
    }});
    const scene=await client.ready;
    if (token.canceled) {client.close();return;}
    remote?.close();
    remote=client;
    applyQuality();
    if (!scene.finished) rememberRoom(ticket,mode);
    else forgetRoom(ticket,mode);
    setPaint(client.paint);
    mount(mode,scene,!!resume);
  } catch (error) {
    if (token.canceled) return;
    if (error.invalidAccess) {accessCode='';enterAccess(mode,error.message);}
    else {
      p.textContent=error.message;
      showDialog('server','接続できませんでした',p,[button('閉じる','primary',hideDialog)]);
    }
  } finally {
    if (connecting===token) connecting=null;
  }
}

function mount(mode,scene,resumed=false) {
  hideDialog();
  clearControls();
  battle=scene;
  yaw=battle.player?.yaw ?? Math.PI/2;
  pitch=resumed && Number.isFinite(battle.player?.pitch)?battle.player.pitch:REST_PITCH;
  watchYaw=battle.cameraActor().yaw;
  viewActor=null;
  state='match';
  mapLevel='auto';
  watchAerial=true;
  focus=null;
  lastMessage='';
  title.hidden=true;
  hud.hidden=false;
  game.classList.add('in-battle');
  game.classList.toggle('spectating',mode==='watch');
  updateWatchControls();
  $('player-meter').hidden=mode==='watch';
  $('spectator-label').hidden=mode!=='watch';
  $('combat-tools').hidden=mode==='watch';
  $('change-loadout').hidden=!battle.player;
  $('transit-action').hidden=true;
  $('reticle').hidden=mode==='watch';
  $('stairs-note').hidden=true;
  const versus=battle.teamSize+' VS '+battle.teamSize;
  const suffix=battle.timeless?' / TIMELESS':(mode==='watch'?' / NPC戦':' / ナワバリ戦')+(battle.unlimited?' · 無制限':'');
  $('hud-mode').textContent=versus+suffix;
  $('clock-label').textContent=battle.timeless?'TIMELESS':battle.unlimited?'無制限':'残り時間';
  $('squads').classList.toggle('expanded',battle.teamSize>4);
  resetSquads();
  updateOrientation();
  updateHud();
  drawMap();
  if (!rotationGate) {
    arena.focus({preventScroll:true});
    if (battle.player) requestPointer();
  }
}

function titlePaint() {
  paint.reset();
  const rng=randomGenerator(20220828);
  const pools=[[-16.5,1.5,0],[-10.5,-1.0,0],[-4.9,4.2,0],[-20.5,-6.2,0],[8.8,-5.9,1],[12.8,2.1,1],[2.7,2.9,1],[17,7.8,1]];
  for (const [x,z,t] of pools) for (let j=0;j<11;j++) {
    const px=x+(rng()-.5)*7.0,pz=z+(rng()-.5)*4.9;
    paint.stamp(px,pz,.42+rng()*1.33,t,world.floor(px,pz).layer,rng()*6.28);
  }
  demoActors=[{x:-15.6,z:-.3,yaw:1.43,team:0},{x:-6.0,z:1.53,yaw:1.75,team:0},
    {x:10.0,z:-4.1,yaw:-1.58,team:1},{x:19.1,z:7.33,yaw:-1.42,team:1}]
    .map((a,i)=>({...a,y:world.floor(a.x,a.z).y,index:i,steps:i*.54,vx:0,vz:0,damageAge:99,tank:92,pitch:-.07,recoil:0}));
}

function showTitle() {
  remote?.close();
  remote=null;
  applyQuality();
  showCareer();
  $('network-note').hidden=true;
  setPaint(localPaint);
  hideDialog();
  clearControls();
  releasePointer();
  battle=null;
  state='title';
  title.hidden=false;
  hud.hidden=true;
  game.classList.remove('in-battle','spectating','in-transit');
  $('floaters').replaceChildren();
  tags.length=0;
  focus=null;
  hideLock($('focus-lock'));
  titlePaint();
  updateOrientation();
  $('start').focus({preventScroll:true});
}

const MAP_CYAN32=0xffbed128, MAP_AMBER32=0xff4476f4;
const MAP_FLOOR32=0xff57523e, MAP_RAISED32=0xff747561, MAP_WALL32=0xff2f2918;
let mapPixels32=null;

function mapSetup() {
  const width=mini.width,height=mini.height;
  mapImage=miniCtx.createImageData(width,height);
  mapPixels32=new Uint32Array(mapImage.data.buffer);
  for (const [level,zone] of ZONES.entries()) {
    const indices=new Int32Array(width*height).fill(-1);
    const colors32=new Uint32Array(width*height);
    const [boundX,boundZ]=zone.bounds;
    for (let iz=0;iz<height;iz++) for (let ix=0;ix<width;ix++) {
      const i=iz*width+ix;
      const x=((ix+.5)/width*2-1)*boundX+zone.x,z=((iz+.5)/height*2-1)*boundZ;
      const onTrack=level===0 && Math.abs(x)<RAIL.edge && Math.abs(z-RAIL.z)<RAIL.halfWidth;
      const layer=onTrack?TRACK_LAYER:world.floor(x,z).layer, index=paint.index(x,z,layer);
      const allowed=paint.mask[index];
      if (allowed) indices[i]=index;
      colors32[i]=allowed?(layer===1 || layer===3 || onTrack || level>=2?MAP_RAISED32:MAP_FLOOR32):MAP_WALL32;
    }
    mapLayers[level]={indices,colors32,boundX,boundZ};
  }
}

function drawMap() {
  if (!battle || !mapImage) return;
  const view=battle.cameraActor(), level=mapLevel==='auto'?(watchingAerial()?0:zoneOf(view.x)):Number(mapLevel);
  const cabin=level>=2?battle.cabinTrain(view.x):null;
  const {indices,colors32,boundX,boundZ}=mapLayers[level];
  const out=mapPixels32, owners=paint.owner;
  for (let i=0,n=indices.length;i<n;i++) {
    const index=indices[i], owner=index===-1?0:owners[index];
    out[i]=owner===1?MAP_CYAN32:owner===2?MAP_AMBER32:colors32[i];
  }
  miniCtx.putImageData(mapImage,0,0);
  const outer=level===0 && zoneOf(view.x)===0 && (Math.abs(view.x)>boundX || Math.abs(view.z)>boundZ);
  $('map-floor').textContent=cabin?(cabin.connection?'直通トンネル':cabin.metro?'地下側 車内':'高架側 車内'):
    outer?'外周 '+Math.min(CITY_RADIUS,Math.round(Math.hypot(view.x,view.z)))+' m':
    mapLevel==='auto' && view.ride && !watchingAerial()?'高架線':ZONES[level].name;
  setText('map-cyan',paint.percent(0,level).toFixed(1));
  setText('map-amber',paint.percent(1,level).toFixed(1));
  for (const tab of mapTabs) tab.setAttribute('aria-pressed',String(tab.dataset.mapLevel===mapLevel));
  const px=x=>(x/boundX+1)*.5*mini.width;
  const pz=z=>(z/boundZ+1)*.5*mini.height;
  if (level<2) {
    if (level===0) {
      miniCtx.strokeStyle='#94b9ad';
      miniCtx.lineWidth=1;
      miniCtx.beginPath();miniCtx.moveTo(px(10.9),pz(-35));miniCtx.lineTo(px(10.9),pz(35));miniCtx.stroke();
    }
    for (const stair of STAIRS) {
      const l=stairPoint(stair,level);
      miniCtx.fillStyle='#f2d99d';
      miniCtx.fillRect(px(localX(l.x))-2.5,pz(l.z)-2.5,5,5);
    }
    const line=level===0?RAIL:METRO;
    miniCtx.strokeStyle=level===0?'#f4d08c':'#dba6be';
    miniCtx.lineWidth=1.3;
    miniCtx.beginPath();
    miniCtx.moveTo(px(-line.x),pz(line.z));
    miniCtx.lineTo(px(line.x),pz(line.z));
    miniCtx.stroke();
    miniCtx.font='bold 9px sans-serif';
    miniCtx.textAlign='center';
    for (const station of STATIONS.filter(stop=>stop.level===level)) {
      const x=px(localX(station.x)),z=pz(station.z);
      miniCtx.fillStyle='#f4e9c4';
      miniCtx.beginPath();miniCtx.arc(x,z,5,0,Math.PI*2);miniCtx.fill();
      miniCtx.fillStyle='#153c35';miniCtx.fillText(String(station.number),x,z+3);
    }
    for (const rail of [battle.transit,battle.metro]) if (rail.visibleIn(level)) {
      const train=rail.train;
      miniCtx.fillStyle=train.berserk?'#ff2838':['derailed','recover','return'].includes(train.phase)?'#fb9a75':'#fff0c6';
      miniCtx.fillRect(px(train.x)-5,pz(line.z+train.lateral)-1.8,10,3.6);
    }
    if (level===0 && battle.vehicles?.cars?.length) {
      for (const car of battle.vehicles.cars) {
        if (!car.alive) continue;
        const cx=px(car.x), cz=pz(car.z);
        miniCtx.fillStyle=car.stain>=.5?(car.stainTeam===0?'#10d8be':'#ff6c33'):
          car.driver?(car.driver.team===0?'#6ef5e3':'#ffb07a'):'#d4d9cf';
        miniCtx.fillRect(cx-3,cz-2,6,4);
      }
    }
    if (level===0 && battle.boss.active) {
      miniCtx.fillStyle='#d091e8';
      miniCtx.beginPath();
      miniCtx.arc(px(battle.boss.x),pz(battle.boss.z),4.5,0,Math.PI*2);
      miniCtx.fill();
    }
    const hz=battle.hazards;
    if (hz) {
      if (level===0 && hz.tsunami?.phase==='wave') {
        miniCtx.fillStyle='rgba(36,166,214,0.48)';
        const wx=px(hz.tsunami.x);
        miniCtx.fillRect(wx-9,0,18,mini.height);
      }
      if (level===1 && hz.underFlood?.active && hz.underFlood.depth>.2) {
        miniCtx.fillStyle='rgba(24,132,178,0.34)';
        miniCtx.fillRect(0,0,mini.width,mini.height);
      }
      if (level===0) for (const s of hz.snipers) if (s.active) {
        miniCtx.fillStyle='#ff3848';
        miniCtx.fillRect(px(s.x)-2.5,pz(s.z)-2.5,5,5);
      }
      for (const d of hz.rogueDrones) if (d.active && zoneOf(d.x)===level) {
        miniCtx.fillStyle='#e2408a';
        miniCtx.beginPath();
        miniCtx.arc(px(localX(d.x)),pz(d.z),3,0,Math.PI*2);
        miniCtx.fill();
      }
      if (level===0 && hz.goat?.active) {
        const gx=px(hz.goat.x), gz=pz(hz.goat.z);
        miniCtx.fillStyle='#ff2644';
        miniCtx.beginPath();
        miniCtx.arc(gx,gz,6,0,Math.PI*2);
        miniCtx.fill();
        miniCtx.strokeStyle='#ffd45a';
        miniCtx.lineWidth=1.8;
        miniCtx.beginPath();
        miniCtx.arc(gx,gz,8,0,Math.PI*2);
        miniCtx.stroke();
      }
    }
  } else {
    const open=cabin.train.stop && cabin.train.doorOpen>.70 && !cabin.failed();
    for (const side of [-1,1]) {
      miniCtx.fillStyle=side===cabin.line.doorSide && open?'#e5c180':'#78908b';
      for (const door of TRAIN_DOORS) miniCtx.fillRect(px(door)-6,side>0?mini.height-6:2,12,4);
    }
  }
  for (const a of battle.actors) {
    const marked=!!battle.player && a.team!==battle.player.team && a.revealUntil>battle.clock && a.revealTeam===battle.player.team;
    if (a.down>0 || zoneOf(a.x)!==level || (battle.player && a.team!==0 && !marked)) continue;
    const x=clamp(px(localX(a.x)),6,mini.width-6),z=clamp(pz(a.z),6,mini.height-6);
    if (marked) {
      // See Elite: a tagged opponent shows as a pulsing diamond.
      const size=4+Math.sin(battle.clock*9)*1.2;
      miniCtx.fillStyle='#ffb24d';
      miniCtx.strokeStyle='#3a1d0a';
      miniCtx.lineWidth=1.2;
      miniCtx.beginPath();
      miniCtx.moveTo(x,z-size);miniCtx.lineTo(x+size,z);miniCtx.lineTo(x,z+size);miniCtx.lineTo(x-size,z);
      miniCtx.closePath();
      miniCtx.fill();
      miniCtx.stroke();
      continue;
    }
    miniCtx.fillStyle=a.isPlayer?'#ffffff':a.team===0?'#8ffff0':'#ffe4c7';
    miniCtx.strokeStyle='#17323a';
    miniCtx.lineWidth=1.5;
    miniCtx.beginPath();
    miniCtx.arc(x,z,a.isPlayer?4.4:2.8,0,Math.PI*2);
    miniCtx.stroke();
    miniCtx.fill();
    if (a.isPlayer) {
      const d=forward(yaw);
      miniCtx.beginPath();
      miniCtx.moveTo(x+d[0]*9,z+d[2]*9);
      miniCtx.lineTo(x-d[2]*3,z+d[0]*3);
      miniCtx.lineTo(x+d[2]*3,z-d[0]*3);
      miniCtx.fill();
    }
  }
}

function message(big,small) {
  const key=big+'|'+small;
  if (lastMessage===key) return;
  lastMessage=key;
  const section=$('battle-message');
  if (!big) {
    section.replaceChildren();
    return;
  }
  const b=document.createElement('b'), line=document.createElement('small');
  b.textContent=big;
  line.textContent=small;
  section.replaceChildren(b,line);
}

function updateWeaponHud(weapon) {
  const label=$('hud-weapon');
  if (label.textContent===weapon.name) return;
  label.textContent=weapon.name;
  $('charge-track').hidden=!weapon.charge;
  $('fire-caption').textContent=weapon.roller?'振る・転がす':weapon.charge?'溜め撃ち':'撃つ';
  $('reticle').classList.toggle('wide',weapon.id==='fan' || weapon.id==='autoeima');
  $('reticle').classList.toggle('charged',!!weapon.charge);
}

function updateAbilities(p) {
  const active=Math.ceil(p.superUntil-battle.clock);
  const special=SUPERS[(active>0?p.activeSpecial:null)??p.weapon.special]??SUPERS[p.weapon.special];
  const superButton=$('super-action'), droneButton=$('drone-action');
  const superReady=battle.abilities.canActivate(p);
  const cramped=p.weapon.special==='giant' && p.superCharge>=100 && !p.ride && !p.lift && p.down<=0 && !superReady;
  setText('super-name',special.name);
  setText('super-state',active>0?'発動 '+active+'秒':superReady?'発動可能':cramped?'広い場所で発動':Math.floor(p.superCharge)+'%');
  $('super-bar').style.width=(active>0?Math.min(100,active/special.seconds*100):p.superCharge)+'%';
  superButton.disabled=!superReady;
  superButton.classList.toggle('ready',superReady);
  const wait=Math.max(0,Math.ceil(p.droneReady-battle.clock));
  setText('drone-state',p.drone?'飛行中':wait>0?wait+'秒':'準備OK');
  droneButton.disabled=!!p.drone || wait>0 || p.down>0 || !!p.ride || !!p.lift;
  droneButton.classList.toggle('ready',!droneButton.disabled);
  const sub=subweaponById(p.subId), subButton=$('sub-action');
  const subWait=Math.max(0,Math.ceil((p.subReady??0)-battle.clock));
  setText('sub-name',sub.name);
  setText('sub-state',subWait>0?subWait+'秒':p.tank<sub.cost?'INK不足':
    p.swimming?'潜水解除で使用':p.airborne && !['throw','see'].includes(sub.id)?'着地して使う':'準備OK');
  subButton.disabled=!battle.subweapons.canUse(p);
  subButton.classList.toggle('ready',!subButton.disabled);
  const coButton=$('co-action'), hasCo=!!p.weapon?.coMode;
  if (coButton.hidden===!!hasCo) coButton.hidden=!hasCo;
  if (hasCo) {
    setText('co-state',p.coMode?'ON':'OFF');
    coButton.classList.toggle('ready',!!p.coMode);
  }
  const cabin=isCabin(p.x);
  const stairs=stairLane(p.x,p.z,1.3);
  $('stairs-note').hidden=!stairs || p.down>0;
  if (stairs) $('stairs-note').textContent=stairs.level===0?'階段を歩いて B1 へ':'階段を歩いて地上へ';
  const option=p.down<=0?battle.transportOption(p):null;
  $('transit-action').hidden=!option;
  $('transit-action').disabled=option?.kind==='busy';
  $('transit-label').textContent=option?.label ?? '';
  $('transit-action').setAttribute('aria-label',option?.label ?? '列車・車に乗る・降りる');
  const inTransit=!!p.ride || !!p.lift || !!p.car || !!p.inCar;
  $('reticle').hidden=inTransit;
  game.classList.toggle('in-transit',inTransit);
}

function updateHud() {
  if (!battle) return;
  const time=Math.ceil(battle.left);
  const format=s=>Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
  setText('time',battle.unlimited?'∞':format(time));
  $('time').classList.toggle('urgent',!battle.unlimited && time<=30);
  const boss=battle.boss, raiders=battle.raiders, hz=battle.hazards, tb=hz?.trainBoss, goat=hz?.goat, view=battle.cameraActor(), level=watchingAerial()?0:zoneOf(view.x);
  const showGoat=!!goat?.active;
  const showTrainBoss=!showGoat && !!tb?.active && !boss.active;
  $('boss-hud').hidden=!showGoat && !boss.active && !showTrainBoss;
  const stationService=!watchingAerial() && level<2?battle.transportService(view):null;
  const transit=level>=2?battle.cabinTrain(view.x):stationService?.rail ??
    [battle.transit,battle.metro].find(rail=>rail.section===level && (rail.failed() || rail.alertUntil>rail.time)) ??
    (level===0?battle.transit:battle.metro), trainAlert=$('train-alert');
  const trainRecovering=transit.train.phase==='recover';
  const trainReturning=transit.train.phase==='return';
  trainAlert.hidden=!trainRecovering && !trainReturning && transit.alertUntil<=transit.time;
  if (!trainAlert.hidden) {
    const note=trainRecovering?transit.line.name+' · 復旧まで '+Math.ceil(transit.train.wait)+'秒':
      trainReturning?transit.line.name+' · 復旧運転中':transit.alert;
    if (trainAlert.textContent!==note) trainAlert.textContent=note;
  }
  const raidStatus=$('raid-status');
  raidStatus.hidden=!battle.timeless;
  if (battle.timeless) {
    const active=raiders.live().length;
    const note=active?'襲撃 '+raiders.wave+'　ゼイアン残り '+active+' / 4':
      '次の襲撃まで '+format(Math.max(0,Math.ceil(raiders.next-battle.elapsed)));
    if (raidStatus.textContent!==note) raidStatus.textContent=note;
  }
  const metroStatus=$('metro-status');
  metroStatus.hidden=level<2 && !stationService;
  if (!metroStatus.hidden) {
    const health=clamp(transit.integrity/(transit.line.integrity??720),0,1);
    $('train-line-name').textContent=transit.line.name;
    $('metro-hp').textContent='車体 '+Math.ceil(health*100)+'%';
    $('metro-hp-bar').style.transform='scaleX('+health+')';
  }
  const route=$('train-route');
  route.hidden=level<2 && !stationService;
  if (!route.hidden) {
    const info=transit.stopInfo(), prefix=info.docked?'停車 ':transit.connection?'直通 · ':'次は ';
    const status=info.status ?? prefix+info.station.name+' · '+(info.docked?'発車 ':'約')+info.seconds+'秒';
    if ($('train-next').textContent!==status) $('train-next').textContent=status;
    for (const node of $('train-stops').children) {
      const selected=!info.status && node.dataset.stop===info.station.id;
      node.classList.toggle('current',selected && info.docked);
      node.classList.toggle('next',selected && !info.docked);
    }
  }
  if (showGoat) {
    setText('boss-name',goat.name);
    $('boss-phase').textContent=goat.phase===3?'破滅':goat.phase===2?'激昂':'降臨';
    const ratio=clamp(goat.hp/goat.maxHp,0,1);
    $('boss-pct').textContent=Math.ceil(ratio*100)+'%';
    $('boss-bar').style.transform='scaleX('+ratio+')';
  } else if (boss.active) {
    setText('boss-name',boss.name);
    $('boss-phase').textContent='第'+boss.phase+'段階';
    const ratio=boss.hp/boss.maxHp;
    $('boss-pct').textContent=Math.ceil(ratio*100)+'%';
    $('boss-bar').style.transform='scaleX('+ratio+')';
  } else if (showTrainBoss) {
    setText('boss-name',tb.name);
    $('boss-phase').textContent='暴走ボス';
    const ratio=clamp(tb.hp/tb.maxHp,0,1);
    $('boss-pct').textContent=Math.ceil(ratio*100)+'%';
    $('boss-bar').style.transform='scaleX('+ratio+')';
  }
  const primaryAlert=battle.timeless?raiders:boss, alert=$('boss-alert');
  const activeAlert=hz && hz.alertUntil>battle.clock && hz.alertUntil>=primaryAlert.alertUntil?hz:primaryAlert;
  alert.hidden=activeAlert.alertUntil<=battle.clock;
  if (!alert.hidden && alert.textContent!==activeAlert.alert) alert.textContent=activeAlert.alert;
  for (let i=0;i<2;i++) {
    const value=paint.percent(i);
    scoreNodes[i].firstChild.nodeValue=value.toFixed(1);
    teamBars[i].style.width=value+'%';
  }
  syncTags();
  for (const {actor,dot} of tags) dot?.classList.toggle('down',actor.down>0);
  const p=battle.player;
  if (p) {
    const readout=inkReadout(p),ratio=readout.ratio,giga=p.tankMax>BASE_TANK;
    $('player-meter').setAttribute('aria-label',readout.empty?'インク不足':readout.low?'インク残りわずか':'インクと体力のゲージ');
    $('player-meter').classList.toggle('ink-low',readout.low);
    $('player-meter').classList.toggle('ink-empty',readout.empty);
    $('ink-next-shot').style.bottom=readout.after*100+'%';
    $('ink-next-shot').style.height=Math.min(ratio,readout.cost)*100+'%';
    $('player-meter').classList.toggle('giga',giga);
    $('ink-bar').style.transform='scaleY('+ratio+')';
    $('hp-bar').style.transform='scaleX('+p.hp/p.maxHp+')';
    updateWeaponHud(p.weapon);
    updateAbilities(p);
    const floor=world.support(p.x,p.y,p.z);
    const own=p.y<=floor.y+.12 && battle.surfaceInk(p,floor)===p.team+1;
    $('touch-swim').classList.toggle('available',own && p.down<=0 && !p.ride && !p.lift && !p.car);
    $('charge-bar').style.transform='scaleX('+p.charge+')';
    $('reticle').style.setProperty('--charge',p.charge);
    const drivenCar=p.car ?? (p.inCar?battle.vehicles?.cars?.find(c=>c.driver===p):null);
    const carTip=drivenCar?(drivenCar.stain>=.7?'⚠ 敵インク汚染 '+Math.round(drivenCar.stain*100)+'% · 爆発危険！ [E] 脱出':
      '運転中 · WASDで操作 / Spaceでドリフト / [E] 降りる'+(drivenCar.stain>.02?' · 敵インク '+Math.round(drivenCar.stain*100)+'%':'')):null;
    setText('meter-tip',carTip ?? (p.climbing?'インク壁を登っています':p.swimming?(p.inkSwimming?'自インク · 高速回復':'イカ状態 · ゆっくり回復'):
      p.inkPenalty?'敵インク · 移動と回復低下':p.charge>.03?(p.charge>=1?'最大チャージ · 離して発射':'チャージ中'):
      readout.empty?'インク不足':p.rolling?'ローラーで塗装中':p.weapon.roller?'短押しで振る · 長押し＋前進で転がす':own?'自インクで高速回復':'未塗装の床でも潜水できます'));
  } else {
    setText('viewing',watchingAerial()?'地上の全景':view.name+' · '+(view.intent || ZONES[level].name));
  }
  if (battle.countdown>0) message(String(Math.ceil(battle.countdown)),battle.timeless?'タイムレスバトル':battle.unlimited?'ナワバリ戦 · 時間無制限':'ナワバリ戦');
  else if (battle.clock<3.77) message('GO!','街区を塗り広げろ');
  else if (p?.down>0) {
    const downNote=p.downBy==='goat'?'破壊神ゴートに蹂躙された · 復帰まで '+BOSS_RESPAWN_SECONDS+'秒':
      p.downBy==='boss'?'オオモノイカに倒された · 復帰まで '+BOSS_RESPAWN_SECONDS+'秒':
      p.downBy==='trainBoss'?'暴走列車に撃破された · 復帰まで '+BOSS_RESPAWN_SECONDS+'秒':
      p.downBy==='carBomb'?'車の爆発に巻き込まれた · 復帰まで '+RESPAWN_SECONDS+'秒':
      p.downBy==='car'?'車に轢き倒された · 復帰まで '+RESPAWN_SECONDS+'秒':
      p.downBy==='drown'?'水没して溺死した · 復帰まで '+RESPAWN_SECONDS+'秒':
      p.downBy==='hazard'?'襲撃イベントに倒された · 復帰まで '+RESPAWN_SECONDS+'秒':
      '復帰まで '+RESPAWN_SECONDS+'秒';
    message(String(Math.ceil(p.down)),downNote);
  }
  else message('','');
  const feedKey=battle.events.map(event=>event.team+':'+event.label).join('|');
  if (feedKey!==lastFeed) {
    lastFeed=feedKey;
    $('feed').replaceChildren(...battle.events.map(event=>{
      const entry=document.createElement('span');
      entry.className='feed-entry'+(event.team===1?' amber':event.team===-1?' neutral':'');
      entry.textContent=event.label;
      return entry;
    }));
  }
}

// A small readout of the achieved frame rate and internal resolution.
function showRate(now) {
  if (now-fpsTime<500) return;
  fpsTime=now;
  const rate=Math.round(renderer.fps||0);
  setText('fps',rate?rate+' FPS · '+Math.min(arena.width,arena.height)+'p':'');
}

// Measures the display's refresh interval with a few idle animation frames,
// so the renderer knows whether to hold 60, 90 or 120 fps.
function measureRefresh() {
  const samples=[];
  let last=0;
  const tick=now=>{
    if (last) samples.push(now-last);
    last=now;
    if (samples.length<40) {requestAnimationFrame(tick);return;}
    samples.sort((a,b)=>a-b);
    const typical=samples[Math.floor(samples.length*.35)];
    if (typical>3 && typical<40) renderer.refreshInterval=typical;
  };
  requestAnimationFrame(tick);
}

function cameraFor(dt) {
  if (!battle) {
    const t=activeClock, drift=Math.sin(t*.092)*1.45;
    const mobile=arena.clientWidth<arena.clientHeight;
    return {eye:[-33.4+drift,3.66+Math.sin(t*.14)*.23,13.84+Math.sin(t*.13)*1.65],
      target:mobile?[4.4,5.7,-12.4]:[3.85,5.36,-13.4]};
  }
  if (watchingAerial()) return aerialView(arena.clientWidth/Math.max(1,arena.clientHeight));
  const actor=battle.cameraActor(), zone=zoneOf(actor.x);
  if (viewActor!==actor || viewZone!==zone) {
    viewActor=actor;
    viewZone=zone;
    viewHeight=actor.y;
    viewX=actor.x;
    viewZ=actor.z;
    cameraReach=1;
    watchPitch=clamp(actor.pitch-.075,-.49,.24);
    if (!battle.player) watchYaw=actor.yaw;
  }
  // The camera rides a smoothed anchor instead of the body itself, so a
  // sidestep, a server correction or an NPC's sudden turn never shakes the view.
  const follow=1-Math.exp(-dt*(battle.player?30:11));
  viewX+=(actor.x-viewX)*follow;
  viewZ+=(actor.z-viewZ)*follow;
  if (Math.hypot(actor.x-viewX,actor.z-viewZ)>2.6) {
    viewX=actor.x;
    viewZ=actor.z;
  }
  if (!battle.player) {
    const change=Math.atan2(Math.sin(actor.yaw-watchYaw),Math.cos(actor.yaw-watchYaw));
    watchYaw+=change*(1-Math.exp(-dt*4.1));
    watchPitch+=(clamp(actor.pitch-.075,-.49,.24)-watchPitch)*(1-Math.exp(-dt*5));
  } else if (actor.car && Math.abs(actor.car.speed)>1.2) {
    const targetYaw=actor.car.yaw;
    yaw+=Math.atan2(Math.sin(targetYaw-yaw),Math.cos(targetYaw-yaw))*(1-Math.exp(-dt*2.8));
  }
  viewHeight=mix(viewHeight,actor.y,1-Math.exp(-dt*14));
  const pose=crewView(battle,actor,{
    yaw:battle.player?yaw:watchYaw,
    pitch:battle.player?pitch:watchPitch,
    height:clamp(viewHeight,actor.y-.42,actor.y+.42),
    reach:mix(cameraReach,1,1-Math.exp(-dt*5.5)),
    watch:!battle.player,
    x:viewX,z:viewZ
  });
  cameraReach=pose.reach ?? 1;
  return pose;
}

function watchingAerial() {
  return battle?.mode==='watch' && watchAerial;
}

function updateWatchControls() {
  const spectating=battle?.mode==='watch', toggle=$('watch-view');
  toggle.hidden=!spectating;
  toggle.textContent=watchAerial?'NPCを追う':'全景に戻る';
  $('cycle').hidden=!spectating || watchAerial;
}

function drawFocus(now) {
  const marker=$('focus-lock'), reticle=$('reticle'), p=battle?.player;
  if (!canControl() || p.swimming || p.ride || p.lift || battle.countdown>0) {
    focus=null;
    hideLock(marker);
    reticle.classList.remove('enemy');
    return;
  }
  const snapshot=remote?.targetLock;
  let hit, contact, direct;
  if (remote) {
    if (snapshot && Math.cos(yaw-snapshot.yaw)>.981 && Math.abs(pitch-snapshot.pitch)<.16) {
      const target=snapshot.type==='boss'?battle.boss:snapshot.type==='raider'?
        battle.raiders.members.find(actor=>actor.index===snapshot.index):battle.actors[snapshot.index];
      if (target) {
        hit={actor:target,shift:snapshot.shift};
        contact=snapshot.offset;
        direct=snapshot.direct;
      }
    }
    if (!hit) focus=null;
  } else {
    hit=battle.focusTarget(camera.eye,unit(sub(camera.target,camera.eye)),p.team,p.weapon.range*p.rangeFactor+4);
    direct=!!hit;
  }
  if (hit) {
    const shift=hit.shift??0;
    if (focus?.actor!==hit.actor || focus.shift!==shift || now>focus.until) {
      focus={actor:hit.actor,shift,born:now,lastFrame:now,box:null,speed:[0,0,0,0],trail:[]};
    }
    focus.until=now+285;
    focus.contact=contact??[hit.point[0]+shift-hit.actor.x,hit.point[1]-hit.actor.y,hit.point[2]-hit.actor.z];
  }
  reticle.classList.toggle('enemy',!!direct);
  const target=focus?.actor;
  if (!target || now>focus.until || target.down>0 || target.shield>0 || target.ride || target.lift ||
      (target.isBoss || target.isRaider) && !target.active ||
      target.isRaider && !battle.raiders.members.includes(target) ||
      !sameLevel(target.x-focus.shift,camera.eye[0])) {
    hideLock(marker);
    return;
  }
  const x=target.x-focus.shift, y=target.y, z=target.z;
  if (!hit && !remote) {
    const [dx,dy,dz]=focus.contact;
    const contact=[x+dx,y+dy,z+dz];
    if (battle.traceShot(camera.eye,contact,true)?.t<.986 || battle.subweapons.block(camera.eye,contact,p.team)?.t<.986) {
      focus=null;
      hideLock(marker);
      return;
    }
  }
  const height=target.isBoss?BOSS_BODY_HEIGHT:target.giant?2.76:target.climbing?1.04:target.swimming?.47:1.97-(target.brace??0)*.36;
  const top=renderer.project([x,y+height,z]), bottom=renderer.project([x,y+.06,z]);
  if (!top || !bottom) {
    hideLock(marker);
    return;
  }
  const u=(top[0]+bottom[0])*.5, v=(top[1]+bottom[1])*.5;
  if (u<.03 || u>.97 || v<.06 || v>.94) {
    hideLock(marker);
    return;
  }
  const h=clamp(Math.abs(bottom[1]-top[1])*arena.clientHeight+17,33,arena.clientHeight*.70);
  const w=h*(target.climbing?.72:target.swimming?1.46:target.giant || target.isBoss?.93:.75);
  // The frame is carried by a critically damped spring at the display's own
  // rate: it glides onto the target and then keeps pace with it.
  const step=clamp(now-focus.lastFrame,0,72)/1000, box=[u,v,w,h];
  if (!focus.box || Math.hypot(u-focus.box[0],v-focus.box[1])>=.14) {
    focus.box=box;
    focus.speed=[0,0,0,0];
    focus.trail=[];
  } else for (let i=0;i<4;i++) {
    [focus.box[i],focus.speed[i]]=springStep(focus.box[i],focus.speed[i],box[i],step,i<2?26:18);
  }
  focus.lastFrame=now;
  const age=Math.max(0,now-focus.born);
  const arrival=clamp(age/210,0,1), after=clamp((age-52)/360,0,1), settle=(1-arrival)**2;
  marker.style.setProperty('--lock-zoom',1+.51*(1-arrival)**3);
  marker.style.setProperty('--lock-twist',(-18*settle).toFixed(2)+'deg');
  marker.style.setProperty('--lock-spread',(14*settle+(direct?0:4)).toFixed(1)+'px');
  marker.style.setProperty('--lock-halo',.78+after*.64);
  marker.style.setProperty('--lock-wave',.73*Math.sin(Math.PI*after));
  marker.style.setProperty('--lock-glint',arrival<1?.78:.26);
  marker.style.setProperty('--lock-scan',(11+78*(age/780%1))+'%');
  marker.style.setProperty('--lock-ring',(arrival*(direct?.9:.6)).toFixed(3));
  marker.style.setProperty('--lock-ring-size',(1+.55*settle).toFixed(3));
  marker.style.setProperty('--lock-pip',(1+.3*Math.sin(now*.013)).toFixed(3));
  marker.style.setProperty('--lock-alpha',direct?1:.68*clamp((focus.until-now)/180,0,1));
  marker.classList.toggle('tracking',!direct);
  marker.classList.toggle('boss',!!target.isBoss);
  marker.classList.toggle('homing',((p.activeSpecial==='om' || p.activeSpecial==='om2') && p.superUntil>battle.clock) || !!p.weapon?.homing);
  lockMotion(marker,now,direct,[x,y,z]);
  marker.hidden=false;
}

function hideLock(marker) {
  marker.hidden=true;
  const tether=$('lock-tether');
  if (tether) tether.hidden=true;
}

function springStep(value,speed,target,dt,omega) {
  const f=1+2*dt*omega, hoo=dt*omega*omega, hhoo=dt*hoo, inverse=1/(f+hhoo);
  return [(f*value+dt*speed+hhoo*target)*inverse,(speed+hoo*(target-value))*inverse];
}

// Everything that moves with the lock: its place on screen, the afterimages
// trailing behind it, the chevrons pointing where the target is heading, the
// contact pip and the tether back to the reticle.
function lockMotion(marker,now,direct,origin) {
  const [u,v,w,h]=focus.box, W=arena.clientWidth||1, H=arena.clientHeight||1;
  const x=u*W, y=v*H, style=marker.style;
  style.transform='translate3d('+(x-w/2).toFixed(2)+'px,'+(y-h/2).toFixed(2)+'px,0)';
  style.width=w.toFixed(1)+'px';
  style.height=h.toFixed(1)+'px';
  const vx=focus.speed[0]*W, vy=focus.speed[1]*H, pace=Math.hypot(vx,vy);
  const trail=focus.trail;
  trail.push([now,x,y]);
  while (trail.length>2 && now-trail[0][0]>190) trail.shift();
  const motion=clamp((pace-45)/240,0,1);
  for (const [i,id] of ['lock-ghost-a','lock-ghost-b'].entries()) {
    const ghost=$(id);
    if (!ghost?.style) continue;
    const time=now-(i+1)*64;
    let past=trail[0];
    for (const entry of trail) if (entry[0]<=time) past=entry;
    ghost.style.transform='translate3d('+(past[1]-x).toFixed(1)+'px,'+(past[2]-y).toFixed(1)+'px,0)';
    ghost.style.opacity=(motion*(i?.22:.42)).toFixed(3);
  }
  style.setProperty('--lock-motion',motion.toFixed(3));
  style.setProperty('--lock-heading',(Math.atan2(vy,vx)*180/Math.PI).toFixed(1)+'deg');
  style.setProperty('--lock-lead',(Math.max(w,h)*.5+7).toFixed(1)+'px');
  const [dx,dy,dz]=focus.contact, touch=renderer.project([origin[0]+dx,origin[1]+dy,origin[2]+dz]);
  style.setProperty('--lock-pip-x',(touch?clamp((touch[0]-u)*W,-w*.45,w*.45):0).toFixed(1)+'px');
  style.setProperty('--lock-pip-y',(touch?clamp((touch[1]-v)*H,-h*.45,h*.45):0).toFixed(1)+'px');
  const label=$('lock-label'), range=$('lock-range');
  const text=marker.classList.contains?.('homing')?'HOMING':direct?'LOCK':'TRACK';
  if (label && label.textContent!==text) label.textContent=text;
  const metres=Math.hypot(origin[0]-camera.eye[0],origin[1]-camera.eye[1],origin[2]-camera.eye[2]).toFixed(0)+'m';
  if (range && range.textContent!==metres) range.textContent=metres;
  const tether=$('lock-tether'), line=tether?.firstElementChild;
  if (!line) return;
  const gap=Math.hypot(x-W/2,y-H/2), rim=Math.max(w,h)*.5+5;
  tether.hidden=gap<rim+24;
  if (tether.hidden) return;
  line.setAttribute('x1',(W/2+(x-W/2)/gap*20).toFixed(1));
  line.setAttribute('y1',(H/2+(y-H/2)/gap*20).toFixed(1));
  line.setAttribute('x2',(x-(x-W/2)/gap*rim).toFixed(1));
  line.setAttribute('y2',(y-(y-H/2)/gap*rim).toFixed(1));
}

// Visibility and line of sight refresh at HUD rate; positions follow the
// camera every frame so name tags never lag behind the crew.
function projectTags() {
  if (!battle) return;
  const cameraActor=battle.cameraActor(), aerial=watchingAerial();
  for (const tag of tags) {
    const {actor}=tag;
    const range=Math.hypot(actor.x-cameraActor.x,actor.z-cameraActor.z);
    // See Elite: a tagged opponent keeps its name tag through walls.
    const marked=!!battle.player && actor.team!==battle.player.team && actor.revealUntil>battle.clock &&
      actor.revealTeam===battle.player.team;
    tag.marked=marked;
    tag.visible=marked?!(aerial || actor.down>0 || actor.lift || actor.ride || !sameLevel(actor.x,cameraActor.x) || range>90):
      !(aerial || actor===cameraActor || actor.down>0 || actor.swimming || actor.lift || actor.ride ||
      !sameLevel(actor.x,cameraActor.x) || range>25) && !battle.traceShot(camera.eye,[actor.x,actor.y+2.18,actor.z],true);
  }
  placeTags();
}

function placeTags() {
  const W=arena.clientWidth,H=arena.clientHeight;
  for (const tag of tags) {
    const {actor,label}=tag;
    const projected=tag.visible?renderer.project([actor.x,actor.y+2.18,actor.z]):null;
    const show=!!projected && projected[0]>=.015 && projected[0]<=.985 && projected[1]>=.13 && projected[1]<=.94;
    if (label.hidden===show) label.hidden=!show;
    if (label.classList && !!tag.marked!==label.classList.contains('marked')) label.classList.toggle('marked',!!tag.marked);
    if (show) label.style.transform=`translate(${(projected[0]*W).toFixed(1)}px,${(projected[1]*H).toFixed(1)}px) translate(-50%,-50%)`;
  }
}

function frame(now) {
  // The offline film renderer owns the canvas while it runs.
  if (graphicsLost || state==='film') {
    prevTime=now;
    requestAnimationFrame(frame);
    return;
  }
  const quiet=state==='title'?84:dialogKind || rotationGate?110:renderer.minFrameGap??0;
  if (document.hidden || (prevTime && now-prevTime<quiet)) {
    if (document.hidden) prevTime=now;
    requestAnimationFrame(frame);
    return;
  }
  const dt=prevTime?clamp((now-prevTime)/1000,0,.36):0;
  prevTime=now;
  const width=arena.clientWidth, height=arena.clientHeight;
  if (dialogKind && width===renderedWidth && height===renderedHeight) {
    requestAnimationFrame(frame);
    return;
  }
  const running=state==='match' && !dialogKind && !rotationGate && !document.hidden;
  if (!dialogKind && !rotationGate) activeClock+=dt;
  // The world moves first and the camera follows in the same frame, so the
  // view never trails the crew by a frame.
  if (remote && !dialogKind) {
    remote.input(running?getInput():null,!running);
    remote.advance(now);
    if (battle.finished && state==='match') finish();
  } else if (running && dt>0) {
    const input=getInput();
    const steps=Math.ceil(dt/(1/58));
    for (let i=0;i<steps;i++) {
      const player=battle.player, before=player?.x;
      battle.update(dt/steps,input,()=>cameraFor(0));
      if (player && isCabin(before)!==isCabin(player.x)) {
        syncTravel(player,before,false);
        input.yaw=player.yaw=yaw;
        input.pitch=player.pitch=pitch;
      }
      input.jump=input.press=input.super=input.drone=input.use=input.sub=input.co=false;
    }
  }
  camera=cameraFor(dt);
  const tookDamage=battle?.player?.lastDamageAt;
  const damageAge=Number.isFinite(tookDamage)?battle.clock+(battle.impactAgeOffset??0)-tookDamage:Infinity;
  damageFlash.style.opacity=String(Math.pow(clamp(1-damageAge/.49,0,1),1.35));
  renderer.clearDynamic();
  renderer.viewPoint=camera.eye;
  if (battle) {
    const nearCrew=camera.nearCrew?battle.cameraActor():null;
    battle.draw(renderer,camera.eye[0],camera.eye[2],nearCrew,camera.eye[1],camera.stair);
  }
  else {
    demoTrain.update(activeClock);
    demoTrain.draw(renderer);
    demoStage.draw(renderer,camera.eye[0],activeClock);
    for (const actor of demoActors) drawCrew(renderer,actor,activeClock);
  }
  renderer.draw(camera,paint,activeClock);
  renderedWidth=width;
  renderedHeight=height;
  showRate(now);
  drawFocus(now);
  if (battle && !rotationGate) {
    if (now-hudTime>82) {
      hudTime=now;
      updateHud();
      projectTags();
    } else placeTags();
    if (now-mapTime>178) {
      mapTime=now;
      drawMap();
    }
  }
  requestAnimationFrame(frame);
}

function fault(details) {
  console.error(details);
  $('loading').hidden=true;
  title.hidden=true;
  hud.hidden=true;
  rotate.hidden=true;
  const p=document.createElement('p');
  p.textContent='この環境で3D描画を開始できませんでした。WebGL 2対応のブラウザで開いてください。';
  showDialog('error','3D描画エラー',p,[button('再読み込み','primary',()=>location.reload())]);
}

$('start').addEventListener('click',()=>start('play'));
$('watch').addEventListener('click',()=>start('watch'));
$('timeless').addEventListener('click',()=>start('timeless'));
$('pause').addEventListener('click',pause);
for (const tab of mapTabs) tab.addEventListener('click',()=>{
  mapLevel=tab.dataset.mapLevel;
  drawMap();
});
$('cycle').addEventListener('click',()=>{
  if (battle?.mode==='watch' && !watchAerial && !dialogKind) {
    if (remote) remote.cycle();
    else battle.cycle();
    watchYaw=battle.cameraActor().yaw;
    updateHud();
  }
});
$('watch-view').addEventListener('click',()=>{
  if (battle?.mode!=='watch' || dialogKind) return;
  watchAerial=!watchAerial;
  viewActor=null;
  updateWatchControls();
  updateHud();
  drawMap();
});
$('how').addEventListener('click',guide);
$('loadout').addEventListener('click',()=>loadout());
$('time-limit')?.addEventListener('click',()=>{
  prefs.unlimitedTime=!prefs.unlimitedTime;
  savePrefs();
});
$('change-loadout').addEventListener('click',()=>{if (!dialogKind) loadout(true);});
$('quality').addEventListener('click',()=>{
  prefs.quality={high:'lite',lite:'ultra',ultra:'high'}[qualityLevel()];
  savePrefs();
});
$('film').addEventListener('click',()=>filmDialog());
for (const [id,action] of [
  ['super-action',()=>{superQueued=true;}],
  ['drone-action',()=>{droneQueued=true;}],
  ['sub-action',()=>{subQueued=true;}],
  ['co-action',()=>{coQueued=true;}],
  ['transit-action',()=>{useQueued=true;}]
]) {
  $(id).addEventListener('click',()=>{
    if (canControl()) action();
  });
}
$('touch-center').addEventListener('click',()=>{pitch=REST_PITCH;});
document.addEventListener('visibilitychange',()=>{
  prevTime=0;
  if (document.hidden) suspendInput();
});
document.addEventListener('pointerdown',event=>{
  if (event.pointerType==='touch' && !usingTouch) {
    usingTouch=true;
    configureTouch();
  }
},{capture:true,passive:true});
$('exit-rotate').addEventListener('click',showTitle);
$('rotate-fullscreen').addEventListener('click',()=>fullScreen(false,true));
for (const id of ['fullscreen','hud-fullscreen']) $(id).addEventListener('click',()=>fullScreen(true,true));
$('sound').addEventListener('click',()=>{
  mute=!mute;
  $('sound').setAttribute('aria-pressed',String(!mute));
  $('sound').querySelector('b').textContent=mute?'音声 OFF':'音声 ON';
  initAudio();
  sound('tick');
});
portrait.addEventListener('change',updateOrientation);
document.addEventListener('fullscreenchange',updateOrientation);
document.addEventListener('webkitfullscreenchange',updateOrientation);
document.addEventListener('pointerlockchange',()=>{
  const locked=document.pointerLockElement===arena;
  if (hadPointerLock && !locked && state==='match' && !dialogKind && !usingTouch) pause();
  hadPointerLock=locked;
});
window.addEventListener('blur',clearControls);
const blockBrowserAction=event=>event.preventDefault();
for (const type of ['copy','cut','gesturestart','gesturechange','gestureend']) {
  document.addEventListener(type,blockBrowserAction,{capture:true,passive:false});
}
for (const type of ['selectstart','contextmenu']) {
  game.addEventListener(type,event=>{
    if (!event.target.closest?.('input,textarea')) event.preventDefault();
  },true);
}
document.addEventListener('wheel',event=>{
  if (event.ctrlKey || event.metaKey) event.preventDefault();
},{capture:true,passive:false});
document.addEventListener('keydown',event=>{
  if ((event.ctrlKey || event.metaKey) && (['+','=','-','0'].includes(event.key) ||
      ['NumpadAdd','NumpadSubtract','Numpad0'].includes(event.code))) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
},true);
document.addEventListener('keydown',event=>{
  if (event.code==='Escape') {
    if (event.repeat) return;
    if (dialogKind==='guide') hideDialog();
    else if (['loadout','match-loadout','pause-loadout'].includes(dialogKind)) closeLoadout();
    else if (state==='match' && (!dialogKind || dialogKind==='pause')) pause();
    return;
  }
  if (state!=='match' || dialogKind || rotationGate) return;
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code)) {
    if (event.target?.closest?.('button,input,select,textarea,a[href],[contenteditable="true"]')) return;
    event.preventDefault();
  }
  keys.add(event.code);
  if (event.code==='Space' && !event.repeat) jumpQueued=true;
  if (event.code==='KeyF' && !event.repeat) shotQueued=true;
  if (event.code==='KeyC' && !event.repeat) $('cycle').click();
  if (!event.repeat && canControl()) {
    if (event.code==='KeyQ') superQueued=true;
    if (event.code==='KeyE') droneQueued=true;
    if (event.code==='KeyG') subQueued=true;
    if (event.code==='KeyC') coQueued=true;
    if (event.code==='KeyR') useQueued=true;
    if (event.code==='KeyB') loadout(true);
  }
});
document.addEventListener('keyup',event=>keys.delete(event.code));
arena.addEventListener('contextmenu',event=>event.preventDefault());
arena.addEventListener('pointerdown',event=>{
  if (!canControl() || event.pointerType==='touch' || event.button!==0) return;
  desktopFire=shotQueued=true;
  requestPointer();
});
document.addEventListener('pointermove',event=>{
  if (event.pointerType==='touch') return;
  if (document.pointerLockElement===arena || (desktopFire && event.target===arena)) aimMove(event.movementX,event.movementY);
});
for (const name of ['pointerup','pointercancel','lostpointercapture']) {
  document.addEventListener(name,event=>{
    if (event.pointerType!=='touch') desktopFire=false;
  });
}

arena.addEventListener('webglcontextlost',event=>{
  event.preventDefault();
  if (graphicsLost) return;
  graphicsLost=true;
  suspendInput();
  releasePointer();
  updateOrientation();
  $('loading-caption').textContent='3D表示を復旧中';
  $('loading').hidden=false;
  graphicsTimeout=setTimeout(()=>{
    graphicsLost=false;
    fault(new Error('WebGL context restoration timed out'));
  },12000);
});

arena.addEventListener('webglcontextrestored',()=>{
  if (!graphicsLost || !world) return;
  clearTimeout(graphicsTimeout);
  try {
    renderer=createRenderer();
    applyQuality();
    world.rebuildRenderer(renderer,sceneData);
    renderer.configureWorld?.(world,paint);
    loadTextures();
    graphicsLost=false;
    prevTime=0;
    viewActor=null;
    renderedWidth=renderedHeight=0;
    camera=cameraFor(0);
    updateOrientation();
    $('loading').hidden=true;
    if (battle && !rotationGate && !dialogKind) arena.focus({preventScroll:true});
  } catch (error) {
    graphicsLost=false;
    fault(error);
  }
});

// The real surface textures load after the title is up; phones and the
// lightweight modes keep smaller layers.
function loadTextures() {
  const [size,small]=SURFACE_SIZES[usingTouch || lightQuality()?'lite':'high'];
  renderer.loadSurfaces?.({size,small}).catch(error=>console.warn('Surface textures unavailable',error));
}

async function readProgress(response) {
  const total=Number(response.headers.get('content-length'))||0, reader=response.body?.getReader?.();
  if (!reader) return response.json();
  const caption=$('loading-caption'), base=caption.textContent, chunks=[];
  let loaded=0;
  for (;;) {
    const {done,value}=await reader.read();
    if (done) break;
    chunks.push(value);
    loaded+=value.length;
    caption.textContent=base+' '+(total?Math.min(99,Math.floor(loaded/total*100))+'%':(loaded/1048576).toFixed(1)+' MB');
  }
  caption.textContent=base;
  const bytes=new Uint8Array(loaded);
  let offset=0;
  for (const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadScene() {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),4500);
  try {
    const response=await fetch(`./${SCENE_FILE}`,{cache:'force-cache',signal:controller.signal});
    if (!response.ok) return null;
    const scene=await readProgress(response);
    return scene.version===SCENE_VERSION && scene.parts?.length>10000 && scene.solids?.length && scene.slabs?.length && scene.homes?.length===3 && scene.objects?.length && scene.elevated?.length?scene:null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

try {
  paint=localPaint=new Paint();
  // Spread each ink film step over up to this many frames (see Paint.advance).
  localPaint.slices=8;
  sceneData=await loadScene();
  renderer=createRenderer();
  applyQuality();
  world=new World(renderer,sceneData);
  demoStage=new StageObjects(world);
  demoTrain=new Transit(world);
  paint.setWorld(world);
  renderer.configureWorld?.(world,paint);
  mapSetup();
  titlePaint();
  savePrefs();
  showCareer();
  configureTouch();
  camera=cameraFor(0);
  renderer.draw(camera,paint,0);
  measureRefresh();
  loadTextures();
  $('loading').hidden=true;
  cloudCheck=detectCloud(cloudRequired).then(service=>{
    setCompute(service?(service.ready?'CLOUDFLARE · サーバー演算':'CLOUDFLARE · 設定待ち'):'LOCAL · 端末内演算');
    return service;
  });
  requestAnimationFrame(frame);
} catch (error) {
  fault(error);
}
