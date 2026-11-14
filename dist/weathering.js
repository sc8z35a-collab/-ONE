import {TAU,add,clamp,color,cross,mix,scale,sub} from './render.js';

const profiles=[
  ['雨だれ','runoff',0x655e4e,0x8b8971,15,.20],
  ['地際の湿気染み','damp',0x545c43,0x776c50,17,.27],
  ['日焼けした塗装','patch',0xf6ead0,0xdcc6a0,12,.21],
  ['白亜化した縁','edge',0xe6dbc3,0xfcf3dc,19,.17],
  ['剥がれた塗膜','flakes',0x887868,0xf1e1c8,17,.23],
  ['コンクリートの爆裂','spall',0x695747,0xb89069,5,.26],
  ['白華の吹き出し','bloom',0xe8e5d1,0xf6eedb,11,.26],
  ['さびの流下跡','runoff',0x8b4626,0xa9773f,8,.32],
  ['油のこすれ跡','scuff',0x444442,0x77654c,12,.26],
  ['ゴムの引きずり跡','tracks',0x3f4240,0x69655d,5,.30],
  ['斜めのヘアクラック','diagonal',0x514a42,0xdfd0b7,7,.37],
  ['Y字の分岐ひび','fork',0x4e4840,0xded3bf,8,.38],
  ['亀甲状のひび','crazing',0x59544b,0xded4bd,4,.31],
  ['沈下による横ひび','settle',0x5a4c40,0xdfccad,9,.39],
  ['乾燥収縮の縦ひび','shrink',0x65584d,0xe0cfb2,5,.32],
  ['段状のレンガ目地割れ','stair',0x634632,0xdcb994,6,.41],
  ['衝撃で広がった放射ひび','impact',0x534f46,0xe4cfb5,7,.37],
  ['角欠けから伸びたひび','broken',0x605448,0xede2c5,8,.35],
  ['伸縮目地の割れ','joint',0x484743,0xd4cebe,6,.44],
  ['シーリング補修したひび','sealed',0x6f6960,0x9f998a,9,.48],
  ['馬踏み目地のレンガ','brick',0x9f5f46,0xe1c6a1,5,.36],
  ['ヘリンボーン舗装','herring',0x857c68,0xe1cfb3,5,.28],
  ['正方形の磁器タイル','grid',0x9fa1a0,0xe2e5df,6,.30],
  ['テラゾーの骨材','chips',0x786853,0xe8dbc3,32,.35],
  ['板型枠コンクリート','boards',0x807663,0xc8b8a0,7,.31],
  ['ヘアライン仕上げ金属','brush',0x788a8a,0xc1cecb,24,.23],
  ['積み石ブロック','ashlar',0x827a70,0xe6d8b9,4,.32],
  ['波板のリブ','ribs',0x637b7e,0xc7d7cf,15,.29],
  ['六角形の敷石','hex',0x827468,0xe1d2b4,4,.33],
  ['洗い出し小石','chips',0x716654,0xd8bc92,23,.31],
  ['市松の店舗タイル','checker',0x5a6870,0xede2c5,6,.30],
  ['鋼板のダイヤ柄','diamond',0x7a898c,0xd6e0db,7,.33],
  ['滑り止めゴム溝','ribs',0x3f4c46,0xa0a79c,11,.40],
  ['多彩吹き付け塗装','chips',0x8d6953,0xe8dbbf,21,.30],
  ['日よけ生地のストライプ','stripes',0x527b65,0xfff2d7,12,.43],
  ['節のある木目','grain',0x85644b,0xbe956b,8,.35],
  ['陶器モザイク','mosaic',0x578977,0xe0e7bd,5,.46],
  ['粗粒アスファルト','chips',0x4f5553,0xc3c0af,26,.31],
  ['金属についた細い擦り傷','scuff',0xdedfd2,0x738684,17,.32],
  ['樹脂の編み目','weave',0x6f6663,0xcdb997,9,.36],
  ['地際の苔','damp',0x657c43,0x829354,26,.39],
  ['石についた地衣類','bloom',0x9a9c5c,0xc0bf7c,21,.30],
  ['ツタが残した跡','vine',0x597647,0x96985d,5,.44],
  ['縁石の白線剥がれ','curb',0xeee6cd,0x7c7b6c,16,.55],
  ['打ち直したコンクリート','patch',0x827c6b,0xd2cbba,5,.29],
  ['ボルト周囲の酸化跡','bolts',0x946b42,0xa98a65,5,.36],
  ['歩行面の摩耗','tracks',0xb8ae96,0xded2b5,8,.35],
  ['鉱物の層状しみ','bands',0x948c68,0xd7ccab,6,.32],
  ['舗装修理の縁取り','repair',0x67675e,0x9d9582,4,.44],
  ['摩耗した石張り目地','ashlar',0x6a6960,0xc2bba9,3,.37]
];

export const WEATHERING=profiles.map(([name,pattern,dark,light,count,opacity],i)=>
  ({id:i+1,name,pattern,dark,light,count,opacity}));

function recipe(profile,draw) {
  const {pattern,count:n}=profile;
  const {stroke,rect,spot,rand}=draw;
  const path=(points,width,tone=0)=>{
    for (let i=1;i<points.length;i++) stroke(points[i-1],points[i],width,tone);
  };
  const crack=(points,width=.011)=>{
    path(points.map(([x,y])=>[x,y+.013]),width*1.38,1);
    path(points,width);
  };
  const chain=(x,y,dx,dy,steps,jitter=.047)=>Array.from({length:steps+1},(_,i)=>
    [x+dx*i/steps+(i&&i<steps?(rand()-.5)*jitter:0),y+dy*i/steps+(i&&i<steps?(rand()-.5)*jitter:0)]);
  const specks=(size,xRange,yRange)=> {
    for (let i=0;i<n;i++) {
      const r=size*(.40+rand()*.76);
      spot(xRange(rand()),yRange(rand()),r,r*(.40+rand()*.65),i%3===0?1:0,4);
    }
  };

  switch (pattern) {
    case 'runoff':
      for (let i=0;i<n;i++) {
        const x=.08+(i+.5)*.84/n+(rand()-.5)*.026, top=.87+rand()*.10;
        const low=top-(.13+rand()*.68), width=.009+rand()*.019;
        stroke([x,top],[x+width*.35,low],width,0);
        stroke([x+width,top-.04],[x+width*1.14,low+.08],width*.64,1);
      }
      break;
    case 'damp':
      specks(.053,u=>.05+u*.90,v=>.06+v*v*.28);
      for (let i=0;i<9;i++) spot(.09+i*.102,.08+rand()*.04,.09,.040+rand()*.05,i%4===0?1:0,5);
      break;
    case 'patch':
    case 'bloom':
      specks(pattern==='patch'?.108:.071,u=>.15+u*.70,v=>.19+v*.64);
      break;
    case 'edge':
      for (let i=0;i<n;i++) {
        const x=i%2?.018+rand()*.075:.906+rand()*.075;
        stroke([x,rand()*.42],[x+rand()*.024,.57+rand()*.39],.010+rand()*.013,i%3===0?0:1);
      }
      break;
    case 'flakes':
      for (let i=0;i<n;i++) {
        const x=.06+rand()*.88,y=.09+rand()*.82,w=.017+rand()*.034,h=.024+rand()*.045;
        spot(x,y,w*1.11,h*1.19,1,4);
        spot(x-.008,y+.009,w,h,0,4);
      }
      break;
    case 'spall':
      for (let i=0;i<n;i++) {
        const x=.14+i*.18,y=.27+rand()*.42;
        spot(x,y,.063,.14,1,6);
        spot(x-.008,y+.021,.045,.115,0,5);
        stroke([x-.022,y+.077],[x+.035,y-.074],.013,1);
      }
      break;
    case 'scuff':
    case 'brush':
      for (let i=0;i<n;i++) {
        const x=.04+rand()*.60,y=.11+rand()*.80,run=.14+rand()*.23;
        stroke([x,y],[x+run,y+(.018+(i%3)*.014)*(pattern==='brush'?.14:1)],.004+rand()*.012,i%3===0?1:0);
      }
      break;
    case 'tracks':
      for (let i=0;i<n;i++) {
        const x=.08+i*.50/n;
        stroke([x,.21+i*.020],[x+.35,.56+i*.035],.019+rand()*.027,i%3===0?1:0);
      }
      break;
    case 'diagonal':
      crack(chain(.16,.17,.68,.67,n,.13));
      break;
    case 'fork':
      crack(chain(.51,.07,.02,.49,4));
      crack(chain(.53,.56,-.39,.38,5,.16));
      crack(chain(.53,.56,.30,.36,4,.11),.009);
      break;
    case 'crazing':
    case 'hex':
      for (let row=0;row<3;row++) for (let col=0;col<n;col++) {
        const x=.12+col*.226+(row%2)*.105, y=.18+row*.295;
        const sides=pattern==='hex'?6:5, points=[];
        for (let i=0;i<sides;i++) {
          const a=TAU*i/sides+Math.PI/2,r=pattern==='hex'?1:.72+rand()*.44;
          points.push([x+Math.cos(a)*.118*r,y+Math.sin(a)*.163*r]);
        }
        crack([...points,points[0]],.007);
      }
      break;
    case 'settle':
      crack(chain(.03,.37,.94,.25,n,.14),.014);
      crack(chain(.42,.45,.21,-.18,4,.075),.008);
      break;
    case 'shrink':
      for (let i=0;i<3;i++) crack(chain(.21+i*.27,.12+rand()*.24,-.065+rand()*.14,.50,n,.055),.008);
      break;
    case 'stair': {
      const points=[[.10,.10]];
      for (let i=1;i<=n;i++) points.push([.10+i*.13,.10+(i-1)*.13],[.10+i*.13,.10+i*.13]);
      crack(points,.014);
      break;
    }
    case 'impact':
      spot(.52,.51,.028,.065,0,6);
      for (let i=0;i<n;i++) {
        const a=TAU*i/n;
        crack(chain(.52,.51,Math.cos(a)*(.24+rand()*.15),Math.sin(a)*(.24+rand()*.15),4,.08),.009);
      }
      break;
    case 'broken':
      spot(.09,.84,.082,.13,0,5);
      crack(chain(.04,.94,.58,-.69,n,.18),.013);
      crack(chain(.26,.64,.56,-.13,5,.15),.008);
      break;
    case 'joint':
      stroke([.49,.04],[.49,.96],.058,1);
      crack(chain(.51,.03,-.005,.95,n,.044),.025);
      crack(chain(.51,.48,.23,-.18,5,.08),.010);
      break;
    case 'sealed': {
      const route=chain(.07,.26,.86,.47,n,.13);
      path(route,.048,1);
      path(route,.021,0);
      break;
    }
    case 'brick':
    case 'grid':
    case 'ashlar':
      for (let row=0;row<n;row++) {
        const y=row/n, height=1/n, step=pattern==='ashlar'?.29:pattern==='grid'?.16:.22;
        const offset=pattern==='grid'?0:(row%2)*step*.52;
        for (let x=-offset;x<1;x+=step) {
          const random=pattern==='ashlar'?rand()*.053:0;
          rect(x+.008+random,y+.022,x+step-.008,y+height-.017,(Math.floor((x+offset)/step)+row)%4===0?1:0);
        }
      }
      break;
    case 'herring':
      for (let i=0;i<n;i++) for (let j=0;j<4;j++) {
        const x=.045+i*.205+(j%2)*.092, y=.075+j*.23;
        stroke([x-.08,y-.08],[x+.044,y+.089],.051,0);
        stroke([x+.048,y+.089],[x+.15,y-.07],.039,1);
      }
      break;
    case 'chips':
      specks(n===23?.027:.017,u=>.05+u*.90,v=>.06+v*.88);
      break;
    case 'boards':
      for (let i=1;i<n;i++) {
        const y=i/n;
        stroke([.026,y],[.974,y],.013,0);
        stroke([.026,y+.016],[.974,y+.016],.014,1);
        for (const x of [.20,.78]) spot(x+(rand()-.5)*.07,y+.061,.017,.027,0,5);
      }
      break;
    case 'ribs':
      for (let i=0;i<n;i++) {
        const x=(i+.5)/n;
        rect(x-.022,.035,x,.965,0);
        rect(x+.002,.035,x+.018,.965,1);
      }
      break;
    case 'stripes':
      for (let i=0;i<n;i++) if (i%2===0) rect(i/n,.018,(i+1)/n,.982,0);
      break;
    case 'checker':
    case 'mosaic':
      for (let row=0;row<n;row++) for (let col=0;col<n*2;col++) {
        const x=col/(n*2),y=row/n, d=pattern==='mosaic'?.009:.003;
        rect(x+d,y+d,x+1/(n*2)-d,y+1/n-d,pattern==='mosaic'?(rand()<.37?1:0):(row+col)%2);
      }
      break;
    case 'diamond':
      for (let i=0;i<n;i++) for (let j=0;j<3;j++) {
        const x=(i+.5)/n, y=.19+j*.30, slope=(i+j)%2?1:-1;
        stroke([x-.034,y-.065*slope],[x+.034,y+.065*slope],.038,0);
        stroke([x-.027,y-.065*slope+.026],[x+.033,y+.060*slope+.026],.012,1);
      }
      break;
    case 'grain':
    case 'bands':
      for (let i=0;i<n;i++) {
        const y=(i+.5)/n;
        path(Array.from({length:9},(_,j)=>[j/8,y+Math.sin(j*.84+i*.59)*(.021+rand()*.029)]),.011,i%3===0?1:0);
      }
      if (pattern==='grain') {
        spot(.38,.52,.094,.057,0,7);
        spot(.38,.52,.061,.033,1,7);
        spot(.38,.52,.028,.019,0,6);
      }
      break;
    case 'weave':
      for (let i=0;i<n;i++) for (let j=0;j<4;j++) {
        const x=(i+.5)/n,y=(j+.5)/4;
        rect(x-.046,y-.042,x+.046,y+.042,(i+j)%2);
        rect(x-.018,y+.049,x+.018,y+.129,(i+j+1)%2);
      }
      break;
    case 'vine':
      for (let i=0;i<n;i++) {
        const x=.16+i*.16, vine=chain(x,.05,(rand()-.5)*.21,.66+rand()*.23,5,.1);
        path(vine,.009);
        for (const [px,py] of vine.slice(1)) spot(px+(rand()-.5)*.09,py,.034,.047,rand()<.25?1:0,4);
      }
      break;
    case 'curb':
      rect(.02,.24,.98,.74,0);
      for (let i=0;i<n;i++) spot(.06+rand()*.88,.24+rand()*.50,.014+rand()*.030,.04+rand()*.11,1,5);
      break;
    case 'bolts':
      for (let i=0;i<n;i++) {
        const x=.11+i*.195,y=.55+rand()*.14;
        spot(x,y,.045,.112,1,7);
        spot(x,y,.023,.059,0,7);
        stroke([x,y-.07],[x-.006,y-.24-rand()*.1],.012,0);
      }
      break;
    case 'repair':
      for (let i=0;i<n;i++) {
        const x=.034+i*.247, y=.27+rand()*.17;
        const corners=[[x,y],[x+.032,y-.11],[x+.192,y-.13],[x+.221,y+.26],[x+.104,y+.35],[x,y]];
        spot(x+.112,y+.08,.106,.235,1,6);
        path(corners,.014);
      }
      break;
  }
}

export function drawWeathering(renderer,id,{origin,right,up,width,height,tint,layer,seed=0}) {
  const profile=WEATHERING[id-1];
  let state=Math.imul(id*1029+seed,0x45d9f3b)>>>0;
  const rand=()=> {
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    return state/4294967296;
  };
  const normal=cross(right,up), base=color(tint), points=[color(profile.dark),color(profile.light)];
  const colors=points.map(rgb=>rgb.map((channel,i)=>mix(base[i],channel,profile.opacity)));
  const point=([u,v],tone)=>add(add(origin,scale(right,width*clamp(u,0,1))),
    add(scale(up,height*clamp(v,0,1)),scale(normal,.009+tone*.004)));
  const triangle=(a,b,c,tone)=>{
    const p=point(a,tone), u=sub(point(b,tone),p), v=sub(point(c,tone),p);
    const det=cross(u,v).reduce((sum,axis,i)=>sum+axis*normal[i],0);
    if (Math.abs(det)<1e-8) return;
    renderer.add('tri',...p,1,1,1,colors[tone],layer===undefined?2:1,{
      basis:det>0?[u,v,normal]:[v,u,normal],wear:id,layer
    });
  };
  const quad=(a,b,c,d,tone)=>{
    triangle(a,b,c,tone);
    triangle(a,c,d,tone);
  };
  recipe(profile,{
    rand,
    rect:(x0,y0,x1,y1,tone)=>quad([x0,y0],[x1,y0],[x1,y1],[x0,y1],tone),
    stroke:(a,b,w,tone)=>{
      const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx*width,dy*height);
      if (len<1e-6) return;
      const half=w*Math.min(width,height)/2;
      const x=-dy*height*half/(len*width),y=dx*width*half/(len*height);
      quad([a[0]+x,a[1]+y],[a[0]-x,a[1]-y],[b[0]-x*.68,b[1]-y*.68],[b[0]+x*.68,b[1]+y*.68],tone);
    },
    spot:(x,y,w,h,tone,edges)=>{
      const ring=Array.from({length:edges},(_,i)=>{
        const a=TAU*i/edges, r=.76+rand()*.24;
        return [x+Math.cos(a)*w*r,y+Math.sin(a)*h*r];
      });
      for (let i=0;i<edges;i++) triangle([x,y],ring[i],ring[(i+1)%edges],tone);
    }
  });
}

export function wallWeathering(renderer,id,x,y,z,yaw,width,height,tint,seed) {
  const right=[Math.cos(yaw),0,-Math.sin(yaw)];
  drawWeathering(renderer,id,{origin:add([x,y,z],scale(right,-width*.5)),right,up:[0,1,0],width,height,tint,seed});
}

export function floorWeathering(renderer,id,x,y,z,width,depth,tint,layer=0) {
  drawWeathering(renderer,id,{origin:[x-width*.5,y,z+depth*.5],right:[1,0,0],up:[0,0,-1],width,height:depth,tint,layer});
}
