import {floorWeathering,wallWeathering} from './weathering.js';

const CONCRETE=0xc8c3b3, PAVING=0xa9b0a7, FRAME=0x697d80, GLASS=0x7cacae;

const PROFILES=[
  // Name, form, width, depth, floors, facade, roof, cladding.
  ['駅前板状棟','slab',16,8.6,7,'balcony','service',0xd2c2a7],
  ['セットバック南棟','terrace',18.5,12,10,'screen','garden',0xb6ad99],
  ['中庭回廊棟','court',23,17,6,'ribbon','garden',0xba8067],
  ['細身の角住戸棟','corner',9.8,10.4,13,'vertical','solar',0xd5d1b9],
  ['住戸連結ツイン','bridge',25,11.2,12,'ribbon','service',0x9eaaa8],
  ['東西段差棟','split',19,12.5,9,'loggia','garden',0xbcc5ae],
  ['低層レンガ棟','slab',14.2,9.4,4,'loggia','gable',0xa76e59],
  ['ガラス腰壁の塔','pin',12.5,11.7,18,'balcony','service',0x9db6bd],
  ['縦庭のある棟','terrace',21.5,15,13,'vertical','garden',0xb9b59d],
  ['逆L字角地棟','ell',17.2,16,9,'screen','solar',0xd0c5ac],
  ['水辺の横長棟','slab',24.2,8.3,8,'ribbon','garden',0xb9c9c6],
  ['段床メゾネット棟','split',15,13,6,'balcony','gable',0xc1a88d],
  ['二重外廊下棟','twin',21.6,12,11,'loggia','service',0x9caaa8],
  ['コの字共同住宅','court',20.4,16.3,7,'balcony','solar',0xbdafa1],
  ['交差住戸棟','cross',18,16,14,'vertical','garden',0xb8c2ba],
  ['サイドテラス棟','ell',22.2,14.1,12,'balcony','garden',0xc9ae8e],
  ['広場の双塔住宅','twin',28,13.5,17,'screen','service',0x94a8b1],
  ['段丘の広幅棟','terrace',24.4,17.1,8,'loggia','solar',0xbb977e],
  ['コーナーベランダ棟','corner',15.4,12,12,'balcony','garden',0xc7c3b0],
  ['棟間ブリッジ住宅','bridge',29,13.8,20,'vertical','service',0xadc0c1],
  ['低層屋上菜園棟','ell',18.1,14.2,5,'ribbon','garden',0xaaa688],
  ['斜め出窓の集合住宅','offset',13.7,12.6,11,'screen','gable',0xa58f7e],
  ['段違いスキップフロア棟','offset',20.6,14,15,'loggia','solar',0xbcc5b8],
  ['中央ホールの高層住宅','cross',24,18,19,'ribbon','service',0xa7b3bc],
  ['北庭の箱型住宅','court',26.4,18.2,9,'vertical','garden',0xc3b49d],
  ['幅広い連続バルコニー棟','slab',26.8,10.2,10,'balcony','solar',0xd0cbbb],
  ['スリムな白磁棟','pin',9.5,8.9,16,'vertical','gable',0xe2dbca],
  ['中庭側スロープ住宅','ell',16.7,19,11,'loggia','service',0xc1ae9c],
  ['隅切りワイドタワー','corner',21.7,17.1,21,'screen','garden',0xaabbb6],
  ['緑化ブリッジの大型棟','bridge',30,18.8,16,'balcony','garden',0xb1a899]
];

export const RESIDENTIAL_TYPES=PROFILES.map(([name,form,width,depth,floors,facade,roof,tint])=>
  ({name,form,width,depth,floors,facade,roof,tint,height:floors*2.92+1.1}));

const volumes={
  slab:[[0,0,1,1,0,1]],
  terrace:[[0,0,1,1,0,.46],[-.09,-.09,.78,.75,.46,.73],[-.16,-.17,.55,.57,.73,1]],
  court:[[-.36,0,.28,1,0,1],[.36,0,.28,1,0,.87],[0,-.34,.44,.32,0,.92],[0,.36,.44,.28,0,.43]],
  corner:[[-.13,-.04,.74,.92,0,1],[.37,-.21,.26,.57,0,.74],[.16,.36,.40,.28,0,.64]],
  bridge:[[-.31,-.04,.37,.88,0,1],[.31,.04,.37,.92,0,.92],[0,0,.32,.53,.57,.68]],
  split:[[-.25,-.02,.50,.96,0,.76],[.25,-.07,.50,.86,0,1]],
  pin:[[0,0,1,1,0,.18],[0,-.05,.76,.74,.18,1]],
  ell:[[-.28,0,.44,1,0,1],[.22,-.27,.56,.46,0,.76]],
  twin:[[-.28,0,.43,.88,0,1],[.29,-.07,.41,.86,0,.87],[0,.05,1,.9,0,.15]],
  cross:[[0,0,.55,1,0,1],[0,0,1,.47,0,.69]],
  offset:[[-.11,-.07,.78,.80,0,.32],[.08,.08,.82,.81,.32,.67],[-.13,-.13,.71,.72,.67,1]]
};

export function residentialLot(width,depth,height) {
  const scale=Math.sqrt(width*depth);
  const setback=1.0+height*.046+scale*.054;
  const footing=.28+height*.014+scale*.022;
  return {
    width:width+2*setback, depth:depth+2.1*setback,
    foundationWidth:width+2*footing, foundationDepth:depth+2*footing,
    foundationDepthBelowGrade:.40+height*.034+scale*.024,
    podium:.17+height*.010+scale*.010
  };
}

const overlap=(a,b,gap=0)=>Math.abs(a.x-b.x)<a.halfW+b.halfW+gap &&
  Math.abs(a.z-b.z)<a.halfD+b.halfD+gap;

export function residentialSites(reserved=[]) {
  const sites=[];
  const streets=[
    {front:43.5,yaw:0},
    {front:43.5,yaw:Math.PI},
    {front:81,yaw:0},
    {front:83,yaw:Math.PI},
    {front:59,yaw:Math.PI/2}
  ];
  for (const [i,street] of streets.entries()) {
    const group=RESIDENTIAL_TYPES.slice(i*6,i*6+6).map(type=>({type,lot:residentialLot(type.width,type.depth,type.height)}));
    const gap=2.4, width=group.reduce((sum,a)=>sum+a.lot.width,0)+(group.length-1)*gap;
    const quarter=i===4;
    const first=quarter?-width/2:Math.min(-10-width/2,76-width);
    const side=street.yaw===0?-1:1;
    let front=street.front;
    while (true) {
      let at=first;
      const row=group.map(({type,lot})=>{
        const site={
          x:quarter?-(front+lot.depth/2):at+lot.width/2,
          z:quarter?at+lot.width/2:side*(front+lot.depth/2), yaw:street.yaw, type, lot,
          halfW:(quarter?lot.depth:lot.width)/2,halfD:(quarter?lot.width:lot.depth)/2
        };
        for (const block of reserved) if (overlap(site,block,1.5)) {
          if (quarter) {
            const next=block.z+block.halfD+site.halfD+1.5;
            at+=next-site.z;
            site.z=next;
          } else {
            const next=block.x+block.halfW+site.halfW+1.5;
            at+=next-site.x;
            site.x=next;
          }
        }
        at+=lot.width+gap;
        return site;
      });
      if (!row.some(site=>sites.some(existing=>overlap(site,existing,2)))) {
        sites.push(...row);
        break;
      }
      front+=3.5;
    }
  }
  return sites;
}

function parcelArtist(r,site) {
  const {x,z,yaw}=site, cy=Math.cos(yaw), sy=Math.sin(yaw);
  return (type,dx,y,dz,w,h,d,tint,kind=2,opts={})=>
    r.add(type,x+dx*cy+dz*sy,y,z-dx*sy+dz*cy,w,h,d,tint,kind,{...opts,yaw:yaw+(opts.yaw??0)});
}

function roofDetails(part,x,y,z,w,d,roof) {
  part('bevel',x,y+.09,z,w+.14,.19,d+.14,CONCRETE,2);
  for (const sign of [-1,1]) {
    part('box',x,y+.25,z+sign*(d*.5-.07),w,.31,.14,CONCRETE,2);
    part('box',x+sign*(w*.5-.07),y+.25,z,.14,.31,d,CONCRETE,2);
  }
  if (roof==='gable') {
    const pitch=Math.atan2(1.15,d*.5);
    for (const sign of [-1,1]) part('box',x,y+.95,z+sign*d*.25,w+.15,.19,Math.hypot(d*.5,1.15),
      0x7a514e,4,{pitch:sign*pitch});
    return;
  }
  if (roof==='garden') {
    part('box',x,y+.29,z,w*.70,.18,d*.66,0x677d58,2);
    for (const dx of [-.24,0,.24]) for (const dz of [-.22,.22]) {
      part('bevel',x+dx*w,y+.46,z+dz*d,w*.18,.30,d*.18,0x847b63);
      part('orb',x+dx*w,y+.77,z+dz*d,w*.14,.52,d*.16,0x779758,2);
    }
    return;
  }
  if (roof==='solar') {
    for (const dx of [-.23,0,.23]) part('box',x+dx*w,y+.54,z,w*.18,.12,d*.44,0x3c5c72,4,{pitch:-.24});
    return;
  }
  part('bevel',x+w*.13,y+.81,z-d*.13,w*.28,1.60,d*.31,0x99a29c,2);
  part('bevel',x-w*.23,y+.43,z+d*.17,w*.16,.69,d*.26,FRAME,4);
  part('cylinder',x+w*.19,y+2.18,z-d*.13,.09,1.90,.09,FRAME,4);
}

function drawResidence(r,site,wear) {
  const {type,lot}=site, {width:w,depth:d,height:h,facade,tint}=type, p=parcelArtist(r,site);
  p('box',0,-.08,0,lot.width,.19,lot.depth,PAVING,1);
  p('box',0,-lot.foundationDepthBelowGrade/2,0,lot.foundationWidth,lot.foundationDepthBelowGrade,lot.foundationDepth,0x858985,2);
  p('bevel',0,lot.podium/2,0,lot.foundationWidth,lot.podium,lot.foundationDepth,CONCRETE,2);
  p('box',0,.032,d*.5+1.42,lot.width-.55,.061,1.72,0xc8c2ae,1);
  const sy=Math.sin(site.yaw), cy=Math.cos(site.yaw);
  const front=d*.5+1.42;
  if (wear===22 || wear===29 || wear===30) {
    floorWeathering(r,wear,site.x+front*sy,.063,site.z+front*cy,Math.abs(sy)>.5?1.61:lot.width-.72,
      Math.abs(sy)>.5?lot.width-.72:1.61,0xc8c2ae);
  } else {
    const plinth=lot.foundationDepth*.5;
    wallWeathering(r,wear,site.x+plinth*sy,.04,site.z+plinth*cy,site.yaw,
      lot.foundationWidth-.50,lot.podium-.081,CONCRETE,Math.round(site.x));
  }
  for (const sign of [-1,1]) {
    const dx=sign*(lot.width*.5-1.07), dz=d*.18;
    p('box',dx,.14,dz,1.31,.27,d*.68,0x779164,2);
    p('cylinder',dx,.78,dz,.18,1.4,.18,0x796c54,2);
    p('orb',dx,1.85,dz,1.52,1.65,1.48,0x72935a,2);
  }
  for (const [i,[dx,dz,width,depth,low,high]] of volumes[type.form].entries()) {
    const x=dx*w,z=dz*d,bw=width*w,bd=depth*d;
    const base=lot.podium+low*h, top=lot.podium+high*h, span=top-base;
    const body=type.form==='corner' || type.form==='offset'?'bevel':'box';
    p(body,x,base+span*.5,z,bw,span,bd,tint,11);
    const windowWidth=bw*.78, front=z+bd*.5;
    p('box',x,base+span*.5,front+.035,windowWidth,span-.29,.082,GLASS,6);
    p('box',x,base+span*.5,z-bd*.5-.031,windowWidth,span-.29,.076,GLASS,6);
    for (const side of [-1,1]) {
      p('box',x+side*(bw*.50+.024),base+span*.5,z,bd*.70,span-.32,.071,GLASS,6,{yaw:Math.PI/2});
    }
    if (facade==='vertical' || facade==='screen') {
      const bars=facade==='vertical'?5:8;
      for (let n=1;n<=bars;n++) {
        const px=x+bw*(n/(bars+1)-.5);
        p('box',px,base+span*.50,front+.115,facade==='vertical'?.14:.078,span-.05,.29,facade==='screen'?tint:CONCRETE,2);
      }
    }
    const stories=Math.floor(span/2.92);
    for (let j=1;j<=stories;j++) {
      const floor=base+j*span/(stories+1);
      const rail=facade==='balcony'||facade==='loggia';
      if (!rail && j%2 && facade!=='ribbon') continue;
      const deck=facade==='balcony'?1.02:facade==='loggia'?.58:.25;
      const across=bw*(facade==='loggia'?.63:.92);
      p('box',x,floor,front+deck*.41,across,.15,deck,CONCRETE,2);
      if (rail) {
        p('box',x,floor+.43,front+deck*.86,across,.60,.079,0x7d9b9c,8);
        p('box',x,floor+.75,front+deck*.87,across,.063,.096,FRAME,4);
        for (const side of [-1,1]) p('box',x+side*(across*.5-.05),floor+.39,front+deck*.87,.074,.69,.082,FRAME,4);
      }
    }
    if (low===0) {
      p('box',x,base+1.31,front+.052,Math.min(bw*.55,4.1),2.56,.17,0x627c80,8);
      p('box',x,base+2.68,front+.57,Math.min(bw*.69,5.2),.19,1.45,CONCRETE,2);
    }
    const buried=volumes[type.form].some(([ox,oz,ow,od,under])=>under===high &&
      Math.abs(dx-ox)<(width+ow)/2 && Math.abs(dz-oz)<(depth+od)/2);
    if (!buried) roofDetails(p,x,top,z,bw,bd,i===0?type.roof:'service');
  }
}

export function buildResidentialDistrict(world) {
  for (const [index,site] of residentialSites(world.towerSites).entries()) {
    world.towerSites.push(site);
    drawResidence(world.r,site,index+1);
  }
}
