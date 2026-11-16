import {floorWeathering,wallWeathering} from './weathering.js';

const PAVING=0xa9b0a7;
// Lots in a row touch (the hair of a gap keeps parcel lines from overlapping;
// the blocks bridge it).
const ROW_GAP=.02;

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
    const gap=ROW_GAP, width=group.reduce((sum,a)=>sum+a.lot.width,0)+(group.length-1)*gap;
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

// Facade styles of the drawn apartment texture sheet (surfaces.js
// 'apartments'): the front of every block shows one of these; backs show
// open corridors and the ends plain gable walls.
export const APARTMENT_STYLES=['balcony','loggia','ribbon','vertical','screen','brick','glass'];
// Street-facing setback of the blocks; the lots themselves touch.
const SETBACK=1.6;

function facadeStyle(type) {
  const r=type.tint>>16&255, g=type.tint>>8&255;
  if (r>g+24) return APARTMENT_STYLES.indexOf('brick');
  if (type.form==='pin' || type.floors>=18) return APARTMENT_STYLES.indexOf('glass');
  return Math.max(0,APARTMENT_STYLES.indexOf(type.facade));
}

// One block = one box. Its balconies, windows, corridors and gable walls are
// all in the facade texture, so a whole block costs twelve triangles. Blocks
// span their full lot width, so neighbours in a row stand wall to wall, and
// every block is solid: nobody walks into or between them.
function drawResidence(world,site,wear) {
  const r=world.r, {type,lot}=site, p=parcelArtist(r,site);
  const cy=Math.cos(site.yaw), sy=Math.sin(site.yaw);
  const width=lot.width+ROW_GAP, depth=type.depth, height=type.height;
  const dz=lot.depth*.5-SETBACK-depth*.5;
  p('box',0,-.08,0,width,.19,lot.depth,PAVING,1);
  p('box',0,height*.5,dz,width,height,depth,type.tint,10,{label:facadeStyle(type)});
  // The same block as a collision box, axis-aligned (blocks face the four axes).
  const cx=site.x+dz*sy, cz=site.z+dz*cy;
  const spanX=Math.abs(cy)*width+Math.abs(sy)*depth, spanZ=Math.abs(sy)*width+Math.abs(cy)*depth;
  world.obstacle(cx,height*.5,cz,spanX,height,spanZ,false);
  const front=dz+depth*.5;
  if (wear===22 || wear===29 || wear===30) {
    const walk=front+SETBACK*.5;
    floorWeathering(r,wear,site.x+walk*sy,.063,site.z+walk*cy,Math.abs(sy)>.5?SETBACK-.2:width-.72,
      Math.abs(sy)>.5?width-.72:SETBACK-.2,PAVING);
  } else {
    wallWeathering(r,wear,site.x+(front+.02)*sy,.04,site.z+(front+.02)*cy,site.yaw,width-.8,.9,type.tint,Math.round(site.x));
  }
}

export function buildResidentialDistrict(world) {
  for (const [index,site] of residentialSites(world.towerSites).entries()) {
    world.towerSites.push(site);
    drawResidence(world,site,index+1);
  }
}
