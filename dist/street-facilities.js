import {floorWeathering,wallWeathering} from './weathering.js';

const METAL=0x596a66, CREAM=0xe6dbc0, STONE=0xb8b4a3;
const profiles=[
  ['kiosk','駅前売店','STATION KIOSK',27,29,3,2.4,2.46,0x46796e],
  ['super','ミニスーパー','FRESH MARKET',-15,-19.4,7.8,4.8,3.62,0x648249],
  ['convenience','コンビニ','CORNER MART',1,29,5.2,3.7,3.06,0x4e8b79],
  ['bakery','パン屋','BAKERY',14,-20.6,4.2,3.5,2.96,0xaa6951],
  ['cafe','カフェ','TERRACE CAFE',34,29,4.4,3.6,2.86,0x557e6b],
  ['pharmacy','薬局','PHARMACY',-42,29,4.2,3.3,3.07,0x66854b],
  ['produce','青果店','PRODUCE',2.5,-18,3.5,3.1,2.66,0x9b824d],
  ['florist','花屋','FLORIST',25.5,-18,3.8,3.3,2.83,0x98816d],
  ['cycle','自転車店','CYCLE WORKS',17,29,4.5,3.7,3.20,0x6e777e],
  ['laundry','コインランドリー','LAUNDRY',48,29,4.2,3.5,2.98,0x6e8790]
];

export const STREET_FACILITIES=profiles.map(([id,name,label,x,z,w,d,h,tint])=>({id,name,label,x,z,w,d,h,tint}));

function shopDetails(p,{id,w,d,h,tint}) {
  const back=-d/2+.43, edge=w/2-.53, front=d/2, frontInside=front-.32;
  const shelf=(x,z,width,tints)=>{
    p('box',x,.61,z,width,1.20,.35,0x8c7b61,2,true);
    for (const y of [.48,1.07,1.68]) {
      p('box',x,y,z+.08,width,.07,.53,CREAM,2);
      for (let i=0;i<Math.floor(width/.24);i++) {
        const px=x-width*.5+.16+i*.235;
        p('box',px,y+.13,z+.14,.135,.18+.053*(i%3),.17,tints[i%tints.length],2);
      }
    }
  };
  const table=(x,y,z,r)=>{
    p('cylinder',x,y-.33,z,.09,.66,.09,METAL,4);
    p('cylinder',x,y,z,r,.07,r,0xa2865a,13,true);
    p('cylinder',x,.08,z,.41,.07,.41,METAL,4);
  };
  const pot=(x,z,y,i)=>{
    p('taper',x,y+.15,z,.31,.30,.31,0x9b6e55,13);
    p('orb',x,y+.41,z,.31,.35,.31,0x668458,14);
    for (const side of [-1,1]) p('orb',x+side*.09,y+.56,z,.133,.11,.145,[0xd4898d,0xe7bf59,0xab85a7][i%3],2);
  };
  switch (id) {
    case 'kiosk':
      p('box',0,.52,front,w-.23,1.02,.18,tint,2,true);
      p('bevel',0,1.05,front+.01,w+.11,.12,.61,0x9d8468,13);
      shelf(0,back,w-.68,[0xddd088,0xb7654d,0x77978c]);
      p('box',edge,1.18,front,.45,.15,.29,METAL,4);
      break;
    case 'super':
      shelf(0,back,w-1.12,[0xbb824a,0x62815a,0xd5b456]);
      for (const x of [-w*.30,w*.30]) shelf(x,-.59,w*.25,[0x9e644c,0xe1ce92,0x7fa182]);
      p('bevel',w*.28,.56,frontInside,1.44,1.1,.47,0x899775,2,true);
      p('box',w*.28,1.22,frontInside,.39,.17,.35,METAL,4);
      break;
    case 'convenience':
      shelf(0,back,w-.98,[0xcc8c49,0x6c8a9a,0xc86b54]);
      for (const y of [.88,2.29]) for (const side of [-1,1])
        p('box',side*(w+1.51)*.25,y,front+.065,(w-1.51)*.5,.065,.046,y>2?0xc28b55:0xd9d1ae,2);
      p('box',edge-.34,.54,frontInside,1.03,1.07,.51,0x768d7a,2,true);
      break;
    case 'bakery':
      p('bevel',-edge,1.01,back,.58,1.92,.61,0x7f7c70,4,true);
      for (const y of [.58,1.07,1.55]) p('box',-edge,y,back+.33,.47,.31,.04,0x4f5251,8);
      p('bevel',1.20,.58,frontInside-.52,1.28,1.11,.55,0xa2825b,13,true);
      for (let i=0;i<5;i++) p('orb',.73+i*.23,1.20,frontInside-.52,.21,.19,.37,0xc29052,13);
      break;
    case 'cafe':
      for (const x of [-1.42,1.42]) {
        table(x,.73,front+.42,.60);
        p('box',x,.44,front+.85,.39,.08,.36,METAL,4);
        p('box',x,.68,front+1.0,.39,.40,.05,0x936f50,13);
        p('cylinder',x,.81,front+.43,.12,.095,.12,CREAM,2);
      }
      p('bevel',edge-.32,.54,back,1.11,1.04,.62,0x8d7358,13,true);
      break;
    case 'pharmacy':
      shelf(0,back,w-.92,[0xdcd7b8,0x92a498,0xc6a79a]);
      for (const [sx,sy] of [[.33,.10],[.10,.33]]) p('box',-edge,h-.49,front+.128,sx,sy,.05,0x94c468,3);
      break;
    case 'produce':
      for (let i=0;i<3;i++) {
        const x=-1.02+i*1.02,z=back+.1;
        p('bevel',x,.45,z,.88,.83,.63,0x967451,13,true);
        p('box',x,.87,z,.78,.07,.58,0x5d754f,2);
        for (const dx of [-.23,0,.23]) for (const dz of [-.15,.13])
          p('orb',x+dx,.95,z+dz,.19,.15,.18,[0xb66046,0xc89344,0x84a255][i],2);
      }
      break;
    case 'florist':
      for (const side of [-1,1]) {
        p('box',side*(edge-.08),.44,frontInside,.69,.10,.63,0x8b866e,13);
        for (let i=0;i<3;i++) pot(side*(edge-.34)+i*.26,frontInside,.50,i);
        pot(side*edge,front+.22,0,1);
      }
      break;
    case 'cycle':
      for (const start of [-edge+.25,.52]) {
        const z=back+.12;
        for (const x of [start,start+.62]) {
          p('ring',x,.36,z,.58,.11,.58,0x424b49,4,false,{pitch:Math.PI/2});
          p('ring',x,.36,z+.014,.50,.08,.50,0xa6b1a7,4,false,{pitch:Math.PI/2});
          p('box',x,.36,z+.03,.039,.43,.027,0x9ba39a,4);
          p('box',x,.36,z+.03,.43,.039,.027,0x9ba39a,4);
        }
        p('box',start+.31,.61,z,.55,.08,.08,0xab6f56,4);
        p('box',start+.12,.76,z,.23,.055,.12,METAL,4);
        p('box',start+.53,.78,z,.071,.39,.072,0x8e8e84,4);
      }
      break;
    case 'laundry':
      for (const x of [-1.36,-.45,.45,1.36]) {
        p('bevel',x,.60,back,.82,1.17,.59,0xc1c7bc,2,true);
        p('ring',x,.54,back+.314,.60,.105,.60,0x697c7e,4,false,{pitch:Math.PI/2});
        p('cylinder',x,.54,back+.291,.43,.042,.43,0x576e75,8,false,{pitch:Math.PI/2});
        p('box',x+.19,1.015,back+.304,.26,.072,.025,0x768b89,8);
      }
      break;
  }
}

export function buildStreetFacilities(world) {
  const r=world.r;
  for (const [index,s] of STREET_FACILITIES.entries()) {
    const {id,label,x,z,w,d,h,tint}=s, sign=z>0?-1:1, yaw=sign===1?0:Math.PI, front=d*.5;
    const p=(type,dx,y,dz,width,height,depth,color,kind=2,solid=false,opts={})=>{
      r.add(type,x+dx*sign,y,z+dz*sign,width,height,depth,color,kind,{...opts,yaw});
      if (solid) world.obstacle(x+dx*sign,y,z+dz*sign,width,height,depth);
    };
    const open=id!=='kiosk', doorway=id==='super'?1.87:id==='convenience'?1.51:1.23;
    p('box',0,-.049,0,w+.37,.13,d+.31,STONE,1);
    p('box',0,h*.5,-front+.09,w,h,.18,CREAM,2,true);
    for (const side of [-1,1]) {
      p('box',side*(w*.5-.085),h*.5,-.02,.17,h,d-.15,CREAM,2,true);
      const span=(w-doorway)*.5, cx=side*(w+doorway)*.25;
      if (open) p('box',cx,.32,front-.07,span,.64,.17,tint,2,true);
      p('box',side*(w*.5-.064),1.53,front,.12,2.31,.22,METAL,4,true);
      if (open) p('box',side*(doorway*.5+.035),1.42,front,.10,2.37,.20,METAL,4,true);
      if (open) {
        world.objects.push({id:id+'-window-'+side,type:'glass',x:x+cx*sign,y:1.52,z:z+(front+.005)*sign,
          w:span-.18,h:1.67,d:.004,yaw});
        p('box',cx,1.57,front+.028,span-.13,.052,.063,0xa8b3a6,4);
      }
    }
    p('bevel',0,h+.075,0,w+.25,.22,d+.31,0xbfc2ac,2,true);
    p('box',0,h-.22,front,w,.44,.23,tint,2,true);
    p('box',0,h-.47,front+.116,w-.12,.049,.07,CREAM,2);
    r.label(label,x,h-.218,z+sign*(front+.121),Math.min(w-.28,5.56),.39,0xf9efd4,yaw);
    if (id==='bakery' || id==='cafe' || id==='florist' || id==='produce') {
      const awning=id==='cafe'?1.03:.68, top=h-.59;
      const stripes=Math.ceil(w/.30);
      for (let j=0;j<stripes;j++) {
        const stripe=w/stripes;
        p('box',(j+.5)*stripe-w*.5,top,front+awning*.44,stripe,.075,awning,j%2?CREAM:tint,2,false,{pitch:.16});
      }
      p('box',0,top-.12,front+awning*.94,w,.11,.08,tint,2);
    }
    if (id==='super' || id==='laundry' || id==='cycle') {
      p('bevel',w*.21,h+.33,-d*.22,w*.32,.39,d*.31,0x869089,4);
      for (let j=0;j<6;j++) p('box',w*.11+j*w*.042,h+.54,-d*.22,.048,.018,d*.26,METAL,4);
    }
    shopDetails(p,s);
    if (open && index!==4 && index!==8) {
      floorWeathering(r,31+index,x,.017,z+sign*(front-.60),Math.min(w-.3,3.9),1.0,STONE);
    } else {
      const panelY=open?.044:.04, panelW=open?Math.min((w-doorway)*.5-.14,1.18):w-.24;
      wallWeathering(r,31+index,x+(open?(w+doorway)*.25*sign:0),panelY,z+sign*(front+(open?.016:.091)),yaw,
        panelW,.49,tint,index);
    }
  }
}
