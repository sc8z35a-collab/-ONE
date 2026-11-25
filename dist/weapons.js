export const SUPERS = {
  shield:{name:'シールド',seconds:10,detail:'10秒間、シールドの耐久がある間は被ダメージを抑える。'},
  giant:{name:'ダイオウイカ',seconds:9,detail:'9秒間、大きなイカに変身。高速で泳ぎ、接触した相手を攻撃する。'},
  range:{name:'スーパー射程',seconds:16,detail:'16秒間、インク弾の射程が1.75倍になる。'},
  slam:{name:'スーパーチャクチ',seconds:1.05,detail:'飛び上がってから着地し、周囲を塗りながら敵に衝撃を与える。'},
  health:{name:'タイリョクバイ',seconds:20,detail:'20秒間、最大体力が100から200に増える。'},
  wave:{name:'インクウェーブ',seconds:2.25,detail:'扇形の波が進み、地面を塗りながら敵を押し返す。'},
  vortex:{name:'ボルテックス',seconds:2.62,detail:'渦が周囲の敵とインクを引き寄せ、最後に弾けて広く塗る。'},
  beam:{name:'プリズムビーム',seconds:3.5,detail:'溜めたあと、照準に追従する光線を照射。遮蔽物で止まる。'},
  om:{name:'OM Bomb',seconds:14,detail:'14秒間、身体能力を強化。敵の動きを捉え、撃った弾が敵をわずかに追従する。'},
  ebot:{name:'ebot',seconds:20,detail:'自分の分身を2体召喚。分身は体力60、塗りと攻撃は半分で、20秒間いっしょに戦う。'},
  om2:{name:'OM BOMB II',seconds:14,detail:'OM Bombの2連発版。14秒間、1回の射撃で追従弾を2発ずつ撃つ。1発の攻撃力は半分、塗りは合計2倍。'}
};

// Shots steer toward the nearest opponent inside this cone while a tracking super is active.
export const OM_HOMING={turn:1.55,cone:.50,reach:17};
export const EBOT={count:2,hp:60,damage:.5,paint:Math.SQRT1_2};

export const INK_COST_FACTOR=.5;
export const PAINT_RADIUS_FACTOR=1.5;
export const INK_EPSILON=1e-9;

export const WEAPONS = [
  {id:'jet',name:'シューター',role:'連射・万能',detail:'移動しながら安定して塗り広げる連射武器。',special:'shield',
    speed:54.1,gravity:8,range:33,damage:29,cost:2.45,delay:.118,radius:1.22,depth:.043,pellets:1,spread:.012,arc:0,size:.246},
  {id:'fan',name:'スプレッダー',role:'拡散・近距離',detail:'一度に5発。近距離を扇形に塗る。',special:'giant',
    speed:40.1,gravity:11,range:18,damage:15,cost:4.5,delay:.37,radius:.84,depth:.035,pellets:5,spread:.24,arc:0,size:.156},
  {id:'charge',name:'チャージャー',role:'溜め・長距離',detail:'長押しで溜めて、離すと撃つ。',special:'range',
    speed:95.7,gravity:5.1,range:52,damage:99,cost:7,delay:.34,radius:1.38,depth:.062,pellets:1,spread:.001,arc:0,size:.174,charge:.78},
  {id:'lob',name:'ロブキャノン',role:'曲射・広域',detail:'山なりの大きなインク弾で広く塗る。',special:'vortex',
    speed:30.9,gravity:16,range:35,damage:72,cost:9,delay:.76,radius:2.43,depth:.062,pellets:1,spread:.018,arc:.33,size:.432},
  {id:'blast',name:'インパクトブラスター',role:'重弾・中距離',detail:'重いインク弾を発射し、まとまった範囲を塗る。',special:'slam',
    speed:46.3,gravity:9,range:26,damage:63,cost:6,delay:.49,radius:1.93,depth:.059,pellets:1,spread:.009,arc:.025,size:.365},
  {id:'dual',name:'デュアルシューター',role:'2連弾・中距離',detail:'左右に分かれる2連弾を素早く連射する。',special:'health',
    speed:60.2,gravity:8,range:30,damage:20,cost:3.15,delay:.159,radius:1.03,depth:.041,pellets:2,spread:.053,arc:0,size:.184},
  {id:'surge',name:'ウェーブポンプ',role:'3連流・広がり',detail:'低い弾道の3連流で、横に広く塗れる。',special:'wave',
    speed:47.8,gravity:10.4,range:24,damage:17,cost:4.35,delay:.27,radius:1.07,depth:.048,pellets:3,spread:.127,arc:0,size:.197},
  {id:'coil',name:'スパイラルガン',role:'旋回弾・塗り',detail:'左右に振れる弾で曲がり角付近を塗り広げる。',special:'om',
    speed:46.3,gravity:8.7,range:28,damage:34,cost:3.75,delay:.234,radius:1.54,depth:.053,pellets:1,spread:.056,arc:.062,size:.263,swirl:2.1},
  {id:'prism',name:'プリズムランス',role:'高速弾・精密',detail:'集弾性の高い高速弾で、中距離から正確に狙う。',special:'beam',
    speed:80.3,gravity:5.5,range:39,damage:43,cost:4.5,delay:.316,radius:1.01,depth:.051,pellets:1,spread:.004,arc:0,size:.16},
  {id:'roller',name:'ストリートローラー',role:'帯状の塗り・近距離',detail:'短押しで扇状に振る。長押ししながら前進すると床を転がして塗る。消費はシューターの1.1倍。',special:'slam',
    speed:28,gravity:12,range:11,damage:33,cost:2.695,delay:.43,radius:1.04,depth:.052,pellets:5,spread:.48,arc:.06,size:.24,roller:true},
  {id:'rd2',name:'RD II QUATRO＋',role:'5連重弾・高速高火力',detail:'5発の重弾を束ねて高速連射する。圧倒的な火力と広い塗り範囲、高い機動力を備える。',special:'om2',
    speed:72,gravity:6.6,range:30,damage:70.4,cost:.6,delay:.22,radius:10/PAINT_RADIUS_FACTOR,depth:.030,pellets:5,spread:.034,arc:0,size:.19,weight:1.52},
  {id:'td',name:'TD',role:'衝撃砲・広範囲',detail:'前方へインクを爆発させる衝撃砲。1発ずつだが扇形を一気に塗り、範囲内の敵を吹き飛ばす。',special:'ebot',
    speed:40,gravity:9,range:10.5,damage:132,cost:15,delay:1.05,radius:1.25,depth:.050,pellets:1,spread:0,arc:0,size:.40,blast:{reach:10.5,half:.56}},
  // Two-round pistols. Fired at a locked-on enemy, the rounds follow it (see
  // AUTO_AIM): turn = steering rate, cone = how far off the flight line the
  // target may drift, reach = how far the guidance works, ink = cost factor
  // while it is working.
  {id:'swout',name:'SW OUT',role:'2発拳銃・自動追尾',detail:'1回で2発撃つ拳銃。ロック中の敵に撃つと、弾がある程度追いかける（追従が働く射撃はインク消費2倍）。基本消費はやや多く、攻撃力は半分。',special:'om',
    speed:63,gravity:8,range:28,damage:14.5,cost:2.9,delay:.26,radius:.98,depth:.040,pellets:2,spread:.018,arc:0,size:.17,
    autoAim:{turn:2.6,cone:.30,reach:22,ink:2}},
  {id:'swout2',name:'SW OUT II',role:'後継2発拳銃・プレイヤー専用',detail:'SW OUTの後継機。追従中も消費は増えず、基本消費4割減、弾速1.3倍、追従力・追従範囲・射程1.5倍。Cキー（またはCOボタン）でCOモードを切り替え：発射間隔が2倍になる代わりに追従力がさらに2倍。',special:'om2',playerOnly:true,
    speed:63*1.3,gravity:8,range:28*1.5,damage:14.5,cost:2.9*.6,delay:.26,radius:.98,depth:.040,pellets:2,spread:.018,arc:0,size:.17,
    autoAim:{turn:2.6*1.5,cone:.30*1.5,reach:22*1.5,ink:1},coMode:{delay:2,turn:2}},
  // Player-only rapid-fire 7-pellet homing shotgun: 0.25 ink per pellet (1.75 per
  // shot after INK_COST_FACTOR) and +20% (1.2x) ink tank capacity while held.
  {id:'autoeima',name:'オート英馬',role:'7連自動追尾散弾・プレイヤー専用',detail:'プレイヤー専用の自動追尾散弾銃。1回で7発（1発あたり0.25インク消費）を速い連射で広範囲に発射し、所持するだけでインクタンク容量が1.2倍になる。一定範囲内の敵へ弾が自動追従し、塗り力は抜群。',special:'vortex',playerOnly:true,
    speed:23.5,gravity:5.5,range:30,damage:6.5,cost:3.5,delay:.165,radius:1.55,depth:.056,pellets:7,spread:.34,arc:0,size:.21,
    tankScale:1.2,homing:{turn:4.8,cone:2.1,reach:16}}
].map(weapon=>({...weapon,cost:weapon.cost*INK_COST_FACTOR,radius:weapon.radius*PAINT_RADIUS_FACTOR}));

export const weaponTankMax=(weapon,base=150)=>base*(weapon?.tankScale ?? 1);

export const weaponById=id=>WEAPONS.find(weapon=>weapon.id===id) ?? WEAPONS[0];
// Weapons a computer-controlled crew may carry (playerOnly weapons are excluded).
export const NPC_WEAPONS=WEAPONS.filter(weapon=>!weapon.playerOnly);
// A locked-on shot: the enemy must sit on the aim line, within its body's
// width (radians, plus this much) at the distance it stands.
export const AUTO_AIM_LOCK={body:1.05,slack:.035};

// The drone's own tracking round: one a second, never selectable as a main weapon.
export const DRONE_WEAPON={id:'drone',name:'ドローン',speed:27,gravity:0,range:17,damage:27,cost:0,delay:1,radius:.62,depth:.030,
  pellets:1,spread:0,arc:0,size:.17};
export const DRONE_HOMING={turn:5.6,cone:1.35,reach:21};
// Illegally modified オート英馬 carried exclusively by the Cheater NPC:
// stronger, wider, faster auto-aim homing and half the default ink cost (0.875 vs 1.75).
export const CHEATER_WEAPON={id:'autoeima2s',name:'オート英馬 II Super',role:'違法改造9連超追尾散弾・チーター専用',
  detail:'チーターがオート英馬を違法改造した9連超追尾散弾銃。1.2倍の連射速度・広角散弾・圧倒的な自動追尾と半減されたインク消費量を誇る。',special:'vortex',
  speed:34,gravity:3.5,range:44,damage:10.5,cost:1.75*.5,delay:.115/1.2,radius:1.75*PAINT_RADIUS_FACTOR,depth:.062,pellets:9,spread:.52,arc:0,size:.22,
  homing:{turn:11.5,cone:2.75,reach:32}};
// Indiscriminate hazard weapons used by apartment snipers and rogue drones.
export const SNIPER_WEAPON={id:'sniper',name:'マンションスナイパー',speed:115,gravity:1.5,range:95,damage:46,cost:0,delay:2.4,
  radius:.45,depth:0,pellets:1,spread:0,arc:0,size:.16};
export const ROGUE_DRONE_WEAPON={id:'rogue_drone',name:'暴走ドローン',speed:29,gravity:0,range:22,damage:22,cost:0,delay:1.15,
  radius:.55,depth:0,pellets:1,spread:0,arc:0,size:.18,homing:{turn:5.2,cone:1.5,reach:22}};
export const TRAIN_BOSS_WEAPON={id:'train_boss',name:'暴走列車',speed:38,gravity:1.8,range:52,damage:36,cost:0,delay:.68,
  radius:1.05,depth:0,pellets:1,spread:0,arc:0,size:.30,homing:{turn:4.2,cone:1.5,reach:42}};
export const GOAT_WEAPON={id:'goat_orb',name:'破壊神ゴート',speed:42,gravity:1.0,range:55,damage:42,cost:0,delay:.6,
  radius:1.25,depth:.025,pellets:1,spread:0,arc:0,size:.38,homing:{turn:5.6,cone:2.2,reach:50}};
export const HELI_MISSILE_WEAPON={id:'heli_missile',name:'マルチミサイルヘリ',speed:30,gravity:4.8,range:72,damage:56,cost:0,delay:2.6,
  radius:2.1,depth:.02,pellets:1,spread:0,arc:0,size:.34,homing:{turn:6.4,cone:2.6,reach:68}};
const SPECIAL_SHOT_WEAPONS={[DRONE_WEAPON.id]:DRONE_WEAPON,[CHEATER_WEAPON.id]:CHEATER_WEAPON,
  [SNIPER_WEAPON.id]:SNIPER_WEAPON,[ROGUE_DRONE_WEAPON.id]:ROGUE_DRONE_WEAPON,[TRAIN_BOSS_WEAPON.id]:TRAIN_BOSS_WEAPON,
  [GOAT_WEAPON.id]:GOAT_WEAPON,[HELI_MISSILE_WEAPON.id]:HELI_MISSILE_WEAPON};
export const shotWeaponById=id=>SPECIAL_SHOT_WEAPONS[id] ?? weaponById(id);

export function shotTravel(weapon,horizontal,rangeFactor=1,power=1) {
  const range=weapon.range*rangeFactor*(weapon.charge?.38+.62*power:1);
  const speed=weapon.speed*(weapon.charge?.66+.34*power:1);
  return Math.max(.047,(horizontal+.5*Math.max(0,horizontal-range))/speed+weapon.arc);
}
