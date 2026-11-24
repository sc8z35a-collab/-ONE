import {UNDER_X,UNDER_Y,localX,zoneOf} from './layout.js';

export const STAIRS=[
  {id:'NW',name:'北西',x:-46.3,z:-13.25,dir:1},
  {id:'SW',name:'南西',x:-46.3,z:12.1,dir:1},
  {id:'NE',name:'北東',x:46.3,z:-13.55,dir:-1},
  {id:'SE',name:'南東',x:46.3,z:12.1,dir:-1}
];
const FLIGHT=6.84, LANDING=1.64, TREADS=22;
export const STAIR_RUN=2*FLIGHT+LANDING;
export const STAIR_SEAM=FLIGHT+LANDING*.5;
export const STAIR_VIEW_MARGIN=1.32;
const HALF=1.47, WALL=HALF+.13, EDGE=HALF+.03;
const RISE=-UNDER_Y/(2*TREADS), GOING=FLIGHT/TREADS;
const CREAM=0xe6e1c9, GREEN=0x527d75, TRIM=0x697e78, TACTILE=0xcfac57;

function stairY(t) {
  if (t<FLIGHT) return -Math.min(TREADS,Math.floor(t/GOING)+1)*RISE;
  if (t<FLIGHT+LANDING) return UNDER_Y*.5;
  return UNDER_Y*.5-Math.min(TREADS,Math.floor((t-FLIGHT-LANDING)/GOING)+1)*RISE;
}

export function stairPoint(stair,level,t=level===0?-1.0:STAIR_RUN+1.0) {
  return {x:(level===1?UNDER_X:0)+stair.x+stair.dir*t,z:stair.z};
}

export function stairAt(x,z,margin=0) {
  const level=zoneOf(x);
  if (level>=2 || z<-15.25-margin || z>15.25+margin || (z>-10.5+margin && z<10.5-margin)) return null;
  const lx=localX(x);
  if (lx<-46.3-margin || lx>46.3+margin || (lx>-30.8+margin && lx<30.8-margin)) return null;
  for (let i=0;i<4;i++) {
    const stair=STAIRS[i];
    const t=(lx-stair.x)*stair.dir;
    if (t<-margin || t>STAIR_RUN+margin) continue;
    const dz=z-stair.z;
    if (dz<-HALF-margin || dz>HALF+margin) continue;
    return {stair,t,level};
  }
  return null;
}

export function stairLane(x,z,margin=0) {
  const p=stairAt(x,z,margin);
  return p && (p.level===0?p.t<=STAIR_SEAM+.68:p.t>=STAIR_SEAM-.68)?p:null;
}

export function stairNeighborShift(x,z,radius) {
  const lane=stairLane(x,z);
  return lane && Math.abs(lane.t-STAIR_SEAM)<radius?(lane.level===0?UNDER_X:-UNDER_X):0;
}

export function stairFloor(x,z) {
  const level=zoneOf(x);
  if (level>=2 || z<-15.25 || z>15.25 || (z>-10.5 && z<10.5)) return null;
  const lx=localX(x);
  if (lx<-46.3 || lx>46.3 || (lx>-30.8 && lx<30.8)) return null;
  for (let i=0;i<4;i++) {
    const stair=STAIRS[i];
    const t=(lx-stair.x)*stair.dir;
    if (t<0 || t>STAIR_RUN) continue;
    const dz=z-stair.z;
    if (dz<-HALF || dz>HALF) continue;
    if (level===0?t<=STAIR_SEAM+.68:t>=STAIR_SEAM-.68) return {y:stairY(t),layer:level===1?2:0,stair};
    return null;
  }
  return null;
}

export function stairFloorY(x,z) {
  const level=zoneOf(x);
  if (level>=2 || z<-15.25 || z>15.25 || (z>-10.5 && z<10.5)) return NaN;
  const lx=localX(x);
  if (lx<-46.3 || lx>46.3 || (lx>-30.8 && lx<30.8)) return NaN;
  for (let i=0;i<4;i++) {
    const stair=STAIRS[i];
    const t=(lx-stair.x)*stair.dir;
    if (t<0 || t>STAIR_RUN) continue;
    const dz=z-stair.z;
    if (dz<-HALF || dz>HALF) continue;
    return (level===0?t<=STAIR_SEAM+.68:t>=STAIR_SEAM-.68)?stairY(t):NaN;
  }
  return NaN;
}

export function stairCrossing(x,z,nx,nz,y) {
  const at=stairAt(x,z), next=at && stairAt(nx,nz);
  if (!next || next.stair!==at.stair || Math.abs(y-UNDER_Y*.5)>2.1) return nx;
  if (at.level===0 && at.t<=STAIR_SEAM && next.t>STAIR_SEAM) return nx+UNDER_X;
  if (at.level===1 && at.t>STAIR_SEAM && next.t<=STAIR_SEAM) return nx-UNDER_X;
  return nx;
}

export function stairRay(start,end) {
  const level=zoneOf(start[0]), dx=end[0]-start[0];
  if (level>=2 || Math.abs(dx)<.00001 || Math.min(start[1],end[1])>-.97 || Math.max(start[1],end[1])<-4.3) return null;
  const origin=level===1?UNDER_X:0;
  for (const stair of STAIRS) {
    if (Math.sign(dx)!==stair.dir*(level===0?1:-1)) continue;
    const seam=stair.x+origin+stair.dir*STAIR_SEAM, crossing=(seam-start[0])/dx;
    if (crossing< -1e-7 || crossing>1+1e-7) continue;
    const t=Math.max(0,Math.min(1,crossing));
    const y=start[1]+(end[1]-start[1])*t, z=start[2]+(end[2]-start[2])*t;
    if (Math.abs(z-stair.z)>HALF || y<UNDER_Y*.5-.13 || y>-1.14) continue;
    return {t,point:[seam,y,z],shift:level===0?UNDER_X:-UNDER_X};
  }
  return null;
}

export function stairEnd(start,end) {
  const seam=stairRay(start,end);
  return seam?[end[0]+seam.shift,end[1],end[2]]:end;
}

function cuts(origin) {
  return STAIRS.map(stair=>{
    const end=stair.x+stair.dir*(STAIR_SEAM+.76);
    return {x0:origin+Math.min(stair.x,end),x1:origin+Math.max(stair.x,end),z0:stair.z-EDGE,z1:stair.z+EDGE};
  });
}

export function cutStairOpenings(r,x,y,z,w,h,d,tint,kind,origin=0) {
  let panels=[{x0:x-w/2,x1:x+w/2,z0:z-d/2,z1:z+d/2}];
  for (const hole of cuts(origin)) {
    panels=panels.flatMap(p=>{
      const x0=Math.max(p.x0,hole.x0),x1=Math.min(p.x1,hole.x1),z0=Math.max(p.z0,hole.z0),z1=Math.min(p.z1,hole.z1);
      if (x0>=x1 || z0>=z1) return [p];
      return [{...p,x1:x0},{...p,x0:x1},{x0,x1,z0:p.z0,z1:z0},{x0,x1,z0:z1,z1:p.z1}]
        .filter(a=>a.x1-a.x0>.001 && a.z1-a.z0>.001);
    });
  }
  for (const p of panels) r.add('box',(p.x0+p.x1)/2,y,(p.z0+p.z1)/2,p.x1-p.x0,h,p.z1-p.z0,tint,kind);
}

export function buildStairs(world,level) {
  const r=world.r, layer=level===1?2:0;
  const shared={stairDuplicate:level===1};
  for (const stair of STAIRS) {
    const x=t=>stairPoint(stair,level,t).x, z=stair.z, dir=stair.dir;
    const tread=(t,y,length,tint,nosing=true)=>{
      const stairDuplicate=(t<STAIR_SEAM?0:1)!==level;
      r.add('box',x(t+length*.5),y-.119,z,length,.238,EDGE*2,tint,15,{layer,stairDuplicate});
      if (nosing) r.add('box',x(t+.027),y+.008,z,.048,.015,HALF*1.90,0x89918a,4,{stairDuplicate});
    };
    for (let i=0;i<TREADS;i++) {
      tread(i*GOING,-(i+1)*RISE,GOING,0xbbbbae);
      tread(FLIGHT+LANDING+i*GOING,UNDER_Y*.5-(i+1)*RISE,GOING,0xaeb4a7);
    }
    tread(FLIGHT,UNDER_Y*.5,LANDING*.5,0xbfc3b2);
    tread(STAIR_SEAM,UNDER_Y*.5,LANDING*.5,0xbfc3b2,false);
    for (const side of [-1,1]) {
      world.solid(x(STAIR_RUN*.5-.06),-4.27,z+side*WALL,STAIR_RUN+.24,8.52,.23,0xa3aea3,13,shared);
      if (level===0) world.solid(x((STAIR_SEAM+.82)*.5),.35,z+side*WALL,STAIR_SEAM+.85,.77,.26,0xa4b6ac,13);
      for (const [start,end,y0,y1] of [[.08,FLIGHT,0,-4],[FLIGHT,FLIGHT+LANDING,-4,-4],[FLIGHT+LANDING,STAIR_RUN,-4,-8]]) {
        const rz=z+side*(HALF-.13);
        for (const h of [.49,.88]) r.beam([x(start),y0+h,rz],[x(end),y1+h,rz],.058,.058,GREEN,4,shared);
        for (let t=start+.25;t<end;t+=1.17) {
          const y=stairY(t);
          r.add('cylinder',x(t),y+.49,rz,.054,.92,.054,TRIM,4,shared);
        }
      }
      for (const t of [2.9,5.7,8.8,11.7,14.3]) {
        const rz=z+side*(HALF+.012), y=stairY(t)+1.65;
        r.add('box',x(t),y,rz,.58,.19,.056,0x667a71,4,shared);
        r.add('box',x(t),y-.011,rz-side*.038,.45,.09,.024,0xf4e9c9,3,shared);
      }
    }
    const roofFrom=FLIGHT-.5, roofTo=STAIR_RUN+.07;
    world.solid(x((roofFrom+roofTo)*.5),-1.06,z,roofTo-roofFrom,.29,2*WALL+.20,0x7d8d83,13,shared);
    r.add('box',x(STAIR_SEAM),-1.22,z,.95,.026,.15,0xf7e9c1,3,shared);
    r.add('box',x(12.48),-1.22,z,1.08,.026,.16,0xf7e9c1,3,shared);
    r.add('box',x(STAIR_SEAM),-3.986,z,.13,.029,HALF*2-.16,TACTILE,4,shared);
    if (level===0) {
      for (const s of [-1,1]) world.solid(x(.25),1.22,z+s*(WALL+.025),.18,2.44,.20,GREEN,4);
      r.add('bevel',x(.65),2.48,z,2.25,.16,3.59,0xb9c7bb,8);
      r.add('box',x(.034),2.22,z,.15,.42,3.31,GREEN,2);
      r.label('B1 STAIRS',x(-.061),2.22,z,3.02,.34,CREAM,-dir*Math.PI/2);
      world.solid(x(STAIR_SEAM+.86),.38,z,.19,.78,2*WALL+.14,0xa4b6ac,13);
      r.add('box',x(-.45),.015,z,.53,.028,HALF*2+.06,TACTILE,4);
    } else {
      world.solid(x(FLIGHT-.66),-6.72,z,.22,2.58,HALF*2+.05,0xa3aea3,13);
      r.add('box',x(STAIR_RUN+.06),-5.79,z,.17,.41,3.05,GREEN,2);
      r.label('STREET EXIT',x(STAIR_RUN+.157),-5.79,z,2.83,.33,CREAM,dir*Math.PI/2);
      r.label('B1 EXCHANGE',x(STAIR_RUN-.037),-5.79,z,2.83,.33,CREAM,-dir*Math.PI/2);
      r.add('box',x(STAIR_RUN+.49),UNDER_Y+.014,z,.58,.027,HALF*2,TACTILE,4);
    }
  }
}
