import {CITY_RADIUS} from './layout.js';
import {residentialLot} from './residential.js';
import {wallWeathering} from './weathering.js';

const MATERIALS=[
  [0xc7b59e,0x8b6958,0xc7b6a1],
  [0x9aadaf,0x4f6f78,0xb8c4bf],
  [0xbfbca2,0x757b69,0xcad0b9],
  [0xb38974,0x815e50,0xccb096],
  [0xc0c1bf,0x62757c,0xa6bbb9]
];
const FORMS=['slab','setback','ell','twin','offset','tower'];
const CREAM=0xe9debd, ROAD=0x777f7d;
const ANGLES=12, RINGS=[222,325,432];

export const OUTER_BUILDINGS=FORMS.flatMap((form,style)=>MATERIALS.map(([tint,trim,roof],edition)=>{
  const floors=[4,10,7,14,12,19][style]+edition*[1,2,1,2,3,3][style];
  return {
    id:style*5+edition,form,tint,trim,roof,
    width:[14,26,24,29,19,16][style]+edition*1.55,
    depth:[11,19,18,19,15,16][style]+edition*1.18,
    height:floors*(2.88+edition*.1),floors
  };
}));

const RAMP={x0:7.15,x1:14.65,z0:44.02,z1:95.5,high:12.83};
export const ELEVATED_APPROACH=Object.freeze(RAMP);
export const APPROACH_LOT={x:10.9,z:(RAMP.z0+RAMP.z1)/2,halfW:5.45,halfD:(RAMP.z1-RAMP.z0)/2+2};

function ground(world) {
  const r=world.r;
  for (const [first,last] of [[-500,-192],[-192,192],[192,500]]) {
    for (let lo=first;lo<last;lo+=24) {
      const hi=Math.min(lo+24,last);
      const nearest=lo*hi<=0?0:Math.min(Math.abs(lo),Math.abs(hi));
      const half=Math.sqrt(CITY_RADIUS**2-nearest**2)+.1;
      const spans=first===-192?[[-half,-176],[104,half]]:[[-half,half]];
      for (const [a,b] of spans) if (b>a) {
        r.add('box',(a+b)/2,-.26,(lo+hi)/2,b-a,.52,hi-lo,0xaeb9a1,27);
      }
    }
  }
  for (let i=0;i<96;i++) {
    const a=(i+.5)*Math.PI/48, radius=CITY_RADIUS-1.25;
    const x=Math.sin(a)*radius,z=Math.cos(a)*radius;
    r.add('box',x,.30,z,32.65,.60,.46,0x9ea99a,13,{yaw:a});
    r.add('box',x,.63,z,32.69,.092,.55,0xd5d6bd,4,{yaw:a});
    r.add('box',x,1.62,z,32.65,.075,.075,0x677f78,4,{yaw:a});
    for (const y of [1.02,1.31]) r.add('box',x,y,z,32.65,.042,.039,0x7e9690,4,{yaw:a});
    r.add('bevel',x,1.02,z,.24,2.04,.28,0xaab6a5,4,{yaw:a});
  }
}

function street(r,a,b,width) {
  const dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz),yaw=Math.atan2(dx,dz);
  const x=(a[0]+b[0])/2,z=(a[1]+b[1])/2;
  r.add('box',x,-.015,z,width+2.4,.038,length+.25,0xc3c7b1,1,{yaw});
  r.add('box',x,.004,z,width,.018,length,ROAD,5,{yaw});
  for (let at=3;at<length-2;at+=13) {
    r.add('box',a[0]+dx*at/length,.016,a[1]+dz*at/length,.12,.006,2.65,CREAM,22,{yaw});
  }
}

function volumes(profile) {
  switch (profile.form) {
    case 'slab': return [[0,0,1,1,0,1]];
    case 'setback': return [[0,0,1,1,0,.46],[-.06,-.10,.78,.76,.46,.78],[-.13,-.17,.59,.56,.78,1]];
    case 'ell': return [[-.25,0,.50,1,0,1],[.25,-.26,.50,.48,0,.72]];
    case 'twin': return [[-.30,0,.40,.87,0,1],[.30,0,.40,1,0,.81],[0,0,.20,.54,.40,.56]];
    case 'offset': return [[-.11,.01,.78,.82,0,.28],[.08,-.09,.84,.82,.28,.66],[-.10,.12,.68,.72,.66,1]];
    default: return [[0,0,1,1,0,.20],[0,-.055,.67,.72,.20,1]];
  }
}

function residence(world,x,z,profile) {
  const {id,width:w,depth:d,height:h,tint,trim,roof,form}=profile,r=world.r;
  const lot=residentialLot(w,d,h);
  const bSolids=[];
  world.solid(x,-lot.foundationDepthBelowGrade/2,z,lot.foundationWidth,lot.foundationDepthBelowGrade,
    lot.foundationDepth,0x858c82,2);
  r.add('box',x,-.029,z,lot.width,.083,lot.depth,0xc3c0aa,1);
  bSolids.push(world.solid(x,lot.podium*.32,z,lot.foundationWidth,lot.podium*.64,lot.foundationDepth,roof,13));
  const base=lot.podium*.64;
  for (const [ox,oz,bw,bd,low,high] of volumes(profile)) {
    const px=x+ox*w,pz=z+oz*d,sw=bw*w,sd=bd*d,span=(high-low)*h,bottom=base+low*h,top=bottom+span;
    bSolids.push(world.solid(px,bottom+span*.5,pz,sw,span,sd,tint,11));
    bSolids.push(world.solid(px,top+.055,pz,sw+.09,.11,sd+.09,roof,2));
    const front=pz+sd/2;
    if (low===0) {
      bSolids.push(world.solid(px,bottom+1.35,front+.039,Math.min(sw*.47,4.6),2.64,.102,trim,8));
      r.add('box',px,bottom+2.72,front+.40,Math.min(sw*.59,5.6),.21,.85,roof,4);
      wallWeathering(r,id%20+1,px+sw*.33,bottom+.05,front,0,sw*.26,Math.min(2.65,span),tint,id);
    }
    for (const side of [-1,1]) {
      const cx=px+side*(sw*.5-.17);
      r.add('box',cx,bottom+span/2,front+.019,.26,span,.11,trim,4);
      r.add('box',cx,bottom+span/2,pz-sd*.5-.020,.30,span,.14,roof,4);
    }
    const step=(form==='slab'||form==='ell'?2:3)*(2.88+id%5*.1);
    for (let y=bottom+step;y<top-.4;y+=step) {
      r.add('box',px,y,front+.082,sw*.86,.13,form==='slab'?.48:.17,roof,2);
      if (form==='slab'||form==='ell') r.add('box',px,y+.38,front+.29,sw*.84,.62,.068,trim,8);
    }
    if (high===1) {
      bSolids.push(world.solid(px+sw*.21,top+.61,pz-sd*.18,sw*.23,1.12,sd*.27,roof,4));
      r.add('cylinder',px+sw*.22,top+2.2,pz-sd*.19,.11,2.18,.11,trim,4);
    }
  }
  world.registerDestructible?.({
    id:'outer-'+Math.round(x)+'_'+Math.round(z),kind:'building',material:'concrete',
    x,y:h*.5+base*.5,z,w:w+1.5,h:h+base+2.6,d:d+1.5,tint,matKind:11,minY:0.12,maxY:h+base+4,
    solids:bSolids.filter(Boolean)
  });
}

function facilities(world) {
  const r=world.r;
  // Abandoned depot with exposed edges and a clear entrance.
  const depotSolids=[];
  for (const [dx,z,w,h,d] of [[0,177,20,4.3,.42],[-9.75,184,.45,5.3,14],[9.75,187,.45,3.7,8],[-5.1,190,9.5,2.35,.44]]) {
    depotSolids.push(world.solid(-176+dx,h/2,z,w,h,d,0x9e8975,13));
  }
  r.add('box',-176,-.010,183.5,21,.052,15,0xaaa495,1);
  for (const [dx,dz] of [[-6,3],[7,-2],[8,5]]) depotSolids.push(world.solid(-176+dx,.31,183+dz,1.95,.62,1.1,0x847c6d,13));
  wallWeathering(r,18,-176,.24,177.21,0,18.8,3.6,0x9e8975);
  world.registerDestructible?.({
    id:'outer-depot',kind:'shop',material:'brick',
    x:-176,y:2.6,z:183.5,w:21,h:5.4,d:15,tint:0x9e8975,matKind:13,minY:0.12,maxY:6,
    solids:depotSolids.filter(Boolean)
  });

  // Walk-in convenience shop on its own lot.
  const x=172,z=165, martSolids=[];
  r.add('box',x,-.009,z,15,.041,12,0xbdbda5,1);
  martSolids.push(world.solid(x,1.69,z-3.75,11.8,3.38,.24,0xb7bcac,13));
  for (const side of [-1,1]) {
    martSolids.push(world.solid(x+side*5.81,1.69,z,.24,3.38,7.6,0xb7bcac,13));
    martSolids.push(world.solid(x+side*3.53,1.24,z+3.75,4.51,2.48,.12,0x709b98,8));
    martSolids.push(world.solid(x+side*3.23,.76,z-.55,2.62,1.52,.68,0xa5ab93,2));
    for (let i=0;i<7;i++) r.add('box',x+side*3.23+(i-3)*.31,1.63,z-.55,.21,.22,.42,[0xdfba63,0x8fa8ac,0xb77458][i%3],2);
  }
  martSolids.push(world.solid(x,3.32,z,12.14,.33,7.92,0xbfc6b5,2));
  martSolids.push(world.solid(x,2.92,z+3.80,11.93,.72,.35,0x467f71,4));
  r.add('box',x,3.12,z+3.988,11.83,.12,.025,0xde994f,3);
  r.label('CORNER MART',x,2.88,z+3.99,5.36,.43,CREAM);
  r.add('box',x,3.115,z+2.41,7.94,.039,.39,0xf5edd2,3);
  world.registerDestructible?.({
    id:'outer-cornermart',kind:'shop',material:'concrete',
    x,y:1.8,z,w:12.6,h:3.6,d:8.6,tint:0xb7bcac,matKind:13,minY:0.12,maxY:4.2,
    solids:martSolids.filter(Boolean)
  });

  // Open parking deck with wheel stops and a drive aisle.
  const px=-160,pz=-180;
  r.add('box',px,-.014,pz,26,.063,20,ROAD,5);
  for (const side of [-1,1]) {
    for (let i=0;i<9;i++) {
      const bx=px+(i-4)*2.75;
      r.add('box',bx,.023,pz+side*6.05,.082,.012,4.55,CREAM,22);
      world.solid(bx+1.30,.073,pz+side*8.46,1.62,.146,.24,0xbab7a1,2);
    }
    for (const bx of [px-12.3,px+12.3]) world.solid(bx,1.58,pz+side*8.9,.42,3.16,.52,0x8c998f,13);
  }
  world.solid(px,3.23,pz,26.4,.33,19.1,0xa2aaa1,2);
  r.label('PARKING',px,3.25,pz+9.57,5,.28,CREAM);
}

export function buildOuterCity(world) {
  const r=world.r;
  ground(world);
  for (const sign of [-1,1]) {
    street(r,[sign*59,0],[sign*476,0],9.1);
    street(r,[0,sign*101],[0,sign*476],8.4);
  }
  street(r,[0,103],[10.9,103],5.0);
  const nodes=Array.from({length:ANGLES},(_,i)=>[Math.cos(i*Math.PI/6),Math.sin(i*Math.PI/6)]);
  for (const [ring,radius] of RINGS.entries()) for (const [i,[dx,dz]] of nodes.entries()) {
    const x=dx*radius,z=dz*radius;
    const [nx,nz]=nodes[(i+1)%ANGLES];
    street(r,[x,z],[nx*radius,nz*radius],ring===1?8.1:6.0);
    // Corner setbacks leave the ring roads and all four radial roads clear.
    const angle=(i+.5)*Math.PI/6, cx=(radius+32)*Math.cos(angle),cz=(radius+32)*Math.sin(angle);
    const profile=OUTER_BUILDINGS[(ring*ANGLES+i)%OUTER_BUILDINGS.length];
    const sx=(x+nx*radius)*.5,sz=(z+nz*radius)*.5;
    const length=Math.hypot(cx-sx,cz-sz);
    street(r,[sx,sz],[cx-(cx-sx)*14/length,cz-(cz-sz)*14/length],3.75);
    residence(world,cx,cz,profile);
  }
  street(r,[-222,0],[-176,176],4.5);
  street(r,[222,0],[172,172],4.5);
  street(r,[-222,0],[-160,-168],4.5);
  facilities(world);
}

export function buildElevatedApproach(world) {
  const r=world.r,{x0,x1,z0,z1,high}=ELEVATED_APPROACH;
  const x=(x0+x1)/2,z=(z0+z1)/2,run=z1-z0,w=x1-x0;
  const angle=Math.atan2(high,run);
  world.elevated.push(ELEVATED_APPROACH);
  const yAt=at=>high*(z1-at)/run;
  r.add('box',x,high/2-.24,z,w,.46,Math.hypot(run,high),0x909b96,5,{pitch:angle});
  for (const side of [-1,1]) {
    const edge=x+side*(w*.5-.13);
    r.add('box',edge,high/2+.42,z,.26,.91,Math.hypot(run,high),0xb1b7ab,13,{pitch:angle});
    r.add('box',edge,high/2+.91,z,.19,.095,Math.hypot(run,high),0x658179,4,{pitch:angle});
    for (let at=z0+.9;at<z1-1;at+=2.4) {
      const h=yAt(at);
      world.obstacle(edge,h+.34,at,.26,.69,2.42,false);
    }
  }
  for (const at of [49,59,69,79,88]) {
    const y=yAt(at)-.47;
    world.solid(x,y/2,at,1.04,y,1.06,0xa8afa1,13);
    r.add('box',x,y-.10,at,w-.21,.32,1.15,0x7a8a82,4);
  }
  for (let at=47;at<94;at+=3.7) r.add('box',x,yAt(at)+.007,at,.115,.015,1.61,CREAM,22,{pitch:angle});
  r.add('box',x,-.016,99.5,w+2,.05,8,ROAD,5);
  r.add('box',x-4.78,1.50,96.2,.13,3,.13,0x7c8a7c,4);
  r.add('box',x-4.78,2.46,96.2,2.30,.51,.14,0x527d75,2);
  r.label('ROUTE 07',x-4.78,2.46,96.28,1.98,.34,CREAM);
}
