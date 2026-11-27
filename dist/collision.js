import {Renderer,add,cross,dot,meshes,scale,sub,unit} from './render.js';
import {UNDER_X,zoneOf} from './layout.js';

const CELL=5, INV_CELL=1/CELL, EPS=1e-8;
const UNDER_CELL_X=Math.round(UNDER_X/CELL); // 256
const names=new Set(['box','bevel','orb','cylinder','taper','cone','ramp','glass','ring']);
const IDENTITY={};
let meshCache;

// Unrolled scalar ray-AABB entry distance (returns Infinity on miss).
function nearBox6(sx,sy,sz,dx,dy,dz,minX,minY,minZ,maxX,maxY,maxZ,limit,pad) {
  let near=0, far=limit;
  let lo=minX-pad, hi=maxX+pad;
  if (dx>-EPS && dx<EPS) {
    if (sx<lo-EPS || sx>hi+EPS) return Infinity;
  } else {
    const inv=1/dx;
    let a=(lo-sx)*inv, b=(hi-sx)*inv;
    if (a>b) {const t=a;a=b;b=t;}
    if (a>near) near=a;
    if (b<far) far=b;
    if (far<near) return Infinity;
  }
  lo=minY-pad; hi=maxY+pad;
  if (dy>-EPS && dy<EPS) {
    if (sy<lo-EPS || sy>hi+EPS) return Infinity;
  } else {
    const inv=1/dy;
    let a=(lo-sy)*inv, b=(hi-sy)*inv;
    if (a>b) {const t=a;a=b;b=t;}
    if (a>near) near=a;
    if (b<far) far=b;
    if (far<near) return Infinity;
  }
  lo=minZ-pad; hi=maxZ+pad;
  if (dz>-EPS && dz<EPS) {
    if (sz<lo-EPS || sz>hi+EPS) return Infinity;
  } else {
    const inv=1/dz;
    let a=(lo-sz)*inv, b=(hi-sz)*inv;
    if (a>b) {const t=a;a=b;b=t;}
    if (a>near) near=a;
    if (b<far) far=b;
    if (far<near) return Infinity;
  }
  return near;
}

// Reusable scratch record for zero-allocation shape & BVH queries.
const _localHit={t:0,nx:0,ny:0,nz:0};
const _bestHit={t:0,nx:0,ny:0,nz:0,shape:null};

function shapeBoxInto(px,py,pz,dx,dy,dz,limit,out) {
  let near=-Infinity, far=Infinity, enter=-1, exit=-1, enterSign=1, exitSign=1;
  if (dx>-EPS && dx<EPS) {
    if (px<-.5 || px>.5) return false;
  } else {
    const inv=1/dx;
    let a=(-.5-px)*inv, b=(.5-px)*inv;
    const lo=a<b?a:b, hi=a<b?b:a;
    if (lo>near) {near=lo;enter=0;enterSign=dx>0?-1:1;}
    if (hi<far) {far=hi;exit=0;exitSign=dx>0?1:-1;}
    if (far<near) return false;
  }
  if (dy>-EPS && dy<EPS) {
    if (py<-.5 || py>.5) return false;
  } else {
    const inv=1/dy;
    let a=(-.5-py)*inv, b=(.5-py)*inv;
    const lo=a<b?a:b, hi=a<b?b:a;
    if (lo>near) {near=lo;enter=1;enterSign=dy>0?-1:1;}
    if (hi<far) {far=hi;exit=1;exitSign=dy>0?1:-1;}
    if (far<near) return false;
  }
  if (dz>-EPS && dz<EPS) {
    if (pz<-.5 || pz>.5) return false;
  } else {
    const inv=1/dz;
    let a=(-.5-pz)*inv, b=(.5-pz)*inv;
    const lo=a<b?a:b, hi=a<b?b:a;
    if (lo>near) {near=lo;enter=2;enterSign=dz>0?-1:1;}
    if (hi<far) {far=hi;exit=2;exitSign=dz>0?1:-1;}
    if (far<near) return false;
  }
  const outside=near>=0, t=outside?near:far, axis=outside?enter:exit;
  if (axis<0 || t<0 || t>limit) return false;
  const s=outside?enterSign:exitSign;
  out.t=t;
  out.nx=axis===0?s:0;
  out.ny=axis===1?s:0;
  out.nz=axis===2?s:0;
  return true;
}

function triangleData(mesh) {
  const {vertices,indices}=mesh, triangles=[];
  for (let i=0;i<indices.length;i+=3) {
    const i0=indices[i]*8, i1=indices[i+1]*8, i2=indices[i+2]*8;
    const ax=vertices[i0], ay=vertices[i0+1], az=vertices[i0+2];
    const bx=vertices[i1], by=vertices[i1+1], bz=vertices[i1+2];
    const cx=vertices[i2], cy=vertices[i2+1], cz=vertices[i2+2];
    const e1x=bx-ax, e1y=by-ay, e1z=bz-az;
    const e2x=cx-ax, e2y=cy-ay, e2z=cz-az;
    const rx=e1y*e2z-e1z*e2y, ry=e1z*e2x-e1x*e2z, rz=e1x*e2y-e1y*e2x;
    const r2=rx*rx+ry*ry+rz*rz;
    if (r2<EPS) continue;
    const flip=(rx*vertices[i0+3]+ry*vertices[i0+4]+rz*vertices[i0+5])<0?-1:1;
    const invLen=flip/Math.sqrt(r2);
    triangles.push({
      ax,ay,az, e1x,e1y,e1z, e2x,e2y,e2z,
      nx:rx*invLen, ny:ry*invLen, nz:rz*invLen,
      minX:Math.min(ax,bx,cx), minY:Math.min(ay,by,cy), minZ:Math.min(az,bz,cz),
      maxX:Math.max(ax,bx,cx), maxY:Math.max(ay,by,cy), maxZ:Math.max(az,bz,cz)
    });
  }
  return triangles;
}

function split(triangles) {
  let minX=Infinity, minY=Infinity, minZ=Infinity, maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
  for (let i=0;i<triangles.length;i++) {
    const t=triangles[i];
    if (t.minX<minX) minX=t.minX;
    if (t.minY<minY) minY=t.minY;
    if (t.minZ<minZ) minZ=t.minZ;
    if (t.maxX>maxX) maxX=t.maxX;
    if (t.maxY>maxY) maxY=t.maxY;
    if (t.maxZ>maxZ) maxZ=t.maxZ;
  }
  if (triangles.length<=8) return {minX,minY,minZ,maxX,maxY,maxZ,left:null,right:null,triangles};
  const sx=maxX-minX, sy=maxY-minY, sz=maxZ-minZ;
  if (sx>=sy && sx>=sz) triangles.sort((a,b)=>(a.minX+a.maxX)-(b.minX+b.maxX));
  else if (sy>=sz) triangles.sort((a,b)=>(a.minY+a.maxY)-(b.minY+b.maxY));
  else triangles.sort((a,b)=>(a.minZ+a.maxZ)-(b.minZ+b.maxZ));
  const mid=triangles.length>>1;
  return {minX,minY,minZ,maxX,maxY,maxZ,left:split(triangles.slice(0,mid)),right:split(triangles.slice(mid)),triangles:null};
}

function castMeshInto(tree,sx,sy,sz,dx,dy,dz,limit,out) {
  if (nearBox6(sx,sy,sz,dx,dy,dz,tree.minX,tree.minY,tree.minZ,tree.maxX,tree.maxY,tree.maxZ,limit,0)===Infinity) return false;
  const tris=tree.triangles;
  if (!tris) {
    let hit=castMeshInto(tree.left,sx,sy,sz,dx,dy,dz,limit,out);
    if (hit) limit=out.t;
    if (castMeshInto(tree.right,sx,sy,sz,dx,dy,dz,limit,out)) hit=true;
    return hit;
  }
  let hit=false;
  for (let i=0;i<tris.length;i++) {
    const tri=tris[i];
    const px=dy*tri.e2z-dz*tri.e2y, py=dz*tri.e2x-dx*tri.e2z, pz=dx*tri.e2y-dy*tri.e2x;
    const det=tri.e1x*px+tri.e1y*py+tri.e1z*pz;
    if (det>-EPS && det<EPS) continue;
    const inv=1/det;
    const rx=sx-tri.ax, ry=sy-tri.ay, rz=sz-tri.az;
    const u=(rx*px+ry*py+rz*pz)*inv;
    if (u<-EPS || u>1+EPS) continue;
    const qx=ry*tri.e1z-rz*tri.e1y, qy=rz*tri.e1x-rx*tri.e1z, qz=rx*tri.e1y-ry*tri.e1x;
    const v=(dx*qx+dy*qy+dz*qz)*inv;
    if (v<-EPS || u+v>1+EPS) continue;
    const t=(tri.e2x*qx+tri.e2y*qy+tri.e2z*qz)*inv;
    if (t<0 || t>limit) continue;
    limit=t;
    out.t=t;
    out.nx=tri.nx; out.ny=tri.ny; out.nz=tri.nz;
    hit=true;
  }
  return hit;
}

function shapeBoxAny(px,py,pz,dx,dy,dz) {
  let near=-Infinity, far=Infinity;
  if (dx>-EPS && dx<EPS) {
    if (px<-.5 || px>.5) return false;
  } else {
    const inv=1/dx, a=(-.5-px)*inv, b=(.5-px)*inv;
    const lo=a<b?a:b, hi=a<b?b:a;
    if (lo>near) near=lo;
    if (hi<far) far=hi;
    if (far<near) return false;
  }
  if (dy>-EPS && dy<EPS) {
    if (py<-.5 || py>.5) return false;
  } else {
    const inv=1/dy, a=(-.5-py)*inv, b=(.5-py)*inv;
    const lo=a<b?a:b, hi=a<b?b:a;
    if (lo>near) near=lo;
    if (hi<far) far=hi;
    if (far<near) return false;
  }
  if (dz>-EPS && dz<EPS) {
    if (pz<-.5 || pz>.5) return false;
  } else {
    const inv=1/dz, a=(-.5-pz)*inv, b=(.5-pz)*inv;
    const lo=a<b?a:b, hi=a<b?b:a;
    if (lo>near) near=lo;
    if (hi<far) far=hi;
    if (far<near) return false;
  }
  if (near===-Infinity) return false;
  const t=near>=0?near:far;
  return t>=0 && t<=1;
}

function castMeshAny(tree,sx,sy,sz,dx,dy,dz) {
  if (nearBox6(sx,sy,sz,dx,dy,dz,tree.minX,tree.minY,tree.minZ,tree.maxX,tree.maxY,tree.maxZ,1,0)===Infinity) return false;
  const tris=tree.triangles;
  if (!tris) return castMeshAny(tree.left,sx,sy,sz,dx,dy,dz) || castMeshAny(tree.right,sx,sy,sz,dx,dy,dz);
  for (let i=0;i<tris.length;i++) {
    const tri=tris[i];
    const px=dy*tri.e2z-dz*tri.e2y, py=dz*tri.e2x-dx*tri.e2z, pz=dx*tri.e2y-dy*tri.e2x;
    const det=tri.e1x*px+tri.e1y*py+tri.e1z*pz;
    if (det>-EPS && det<EPS) continue;
    const inv=1/det;
    const rx=sx-tri.ax, ry=sy-tri.ay, rz=sz-tri.az;
    const u=(rx*px+ry*py+rz*pz)*inv;
    if (u<-EPS || u>1+EPS) continue;
    const qx=ry*tri.e1z-rz*tri.e1y, qy=rz*tri.e1x-rx*tri.e1z, qz=rx*tri.e1y-ry*tri.e1x;
    const v=(dx*qx+dy*qy+dz*qz)*inv;
    if (v<-EPS || u+v>1+EPS) continue;
    const t=(tri.e2x*qx+tri.e2y*qy+tri.e2z*qz)*inv;
    if (t>=0 && t<=1) return true;
  }
  return false;
}

function meshFor(type) {
  if (!meshCache) meshCache=new Map(Object.entries(meshes()).filter(([kind])=>names.has(kind) && kind!=='box')
    .map(([kind,mesh])=>[kind,split(triangleData(mesh))]));
  return meshCache.get(type);
}

class Shape {
  constructor(type,kind,layer,windowId,isBox,isAA,tree,x,y,z,w,h,sd,minX,minY,minZ,maxX,maxY,maxZ,i0x,i0y,i0z,i1x,i1y,i1z,i2x,i2y,i2z) {
    this.type=type; this.kind=kind; this.layer=layer; this.windowId=windowId;
    this.id=-1; this.zone=0; this.visited=-1; this.disabled=false;
    this.isBox=isBox; this.isAA=isAA; this.tree=tree;
    this.px=x; this.py=y; this.pz=z; this.sx=w; this.sy=h; this.sz=sd;
    this.minX=minX; this.minY=minY; this.minZ=minZ;
    this.maxX=maxX; this.maxY=maxY; this.maxZ=maxZ;
    this.i0x=i0x; this.i0y=i0y; this.i0z=i0z;
    this.i1x=i1x; this.i1y=i1y; this.i1z=i1z;
    this.i2x=i2x; this.i2y=i2y; this.i2z=i2z;
  }
  get p(){return [this.px,this.py,this.pz];}
  get span(){return [this.sx,this.sy,this.sz];}
  get min(){return [this.minX,this.minY,this.minZ];}
  get max(){return [this.maxX,this.maxY,this.maxZ];}
  get inverse(){return [[this.i0x,this.i0y,this.i0z],[this.i1x,this.i1y,this.i1z],[this.i2x,this.i2y,this.i2z]];}
}

// Fast direct world-space slab test for axis-aligned boxes (~96% of city shapes).
function castAABoxInto(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,padding,out) {
  let near=-Infinity, far=Infinity, enter=-1, exit=-1, enterSign=1, exitSign=1;
  let lo=shape.minX-padding, hi=shape.maxX+padding;
  if (invDx===0) {
    if (sx<lo || sx>hi) return false;
  } else {
    const a=(lo-sx)*invDx, b=(hi-sx)*invDx;
    const t0=a<b?a:b, t1=a<b?b:a;
    if (t0>near) {near=t0;enter=0;enterSign=dx>0?-1:1;}
    if (t1<far) {far=t1;exit=0;exitSign=dx>0?1:-1;}
    if (far<near) return false;
  }
  lo=shape.minY-padding; hi=shape.maxY+padding;
  if (invDy===0) {
    if (sy<lo || sy>hi) return false;
  } else {
    const a=(lo-sy)*invDy, b=(hi-sy)*invDy;
    const t0=a<b?a:b, t1=a<b?b:a;
    if (t0>near) {near=t0;enter=1;enterSign=dy>0?-1:1;}
    if (t1<far) {far=t1;exit=1;exitSign=dy>0?1:-1;}
    if (far<near) return false;
  }
  lo=shape.minZ-padding; hi=shape.maxZ+padding;
  if (invDz===0) {
    if (sz<lo || sz>hi) return false;
  } else {
    const a=(lo-sz)*invDz, b=(hi-sz)*invDz;
    const t0=a<b?a:b, t1=a<b?b:a;
    if (t0>near) {near=t0;enter=2;enterSign=dz>0?-1:1;}
    if (t1<far) {far=t1;exit=2;exitSign=dz>0?1:-1;}
    if (far<near) return false;
  }
  const outside=near>=0, t=outside?near:far, axis=outside?enter:exit;
  if (axis<0 || t<0 || t>limit) return false;
  const s=outside?enterSign:exitSign;
  out.t=t;
  out.nx=axis===0?s:0;
  out.ny=axis===1?s:0;
  out.nz=axis===2?s:0;
  out.shape=shape;
  return true;
}

export function castAABoxAny(shape,sx,sy,sz,invDx,invDy,invDz,limit=1) {
  let near=-Infinity, far=Infinity;
  if (invDx===0) {
    if (sx<shape.minX || sx>shape.maxX) return false;
  } else {
    const a=(shape.minX-sx)*invDx, b=(shape.maxX-sx)*invDx;
    const t0=a<b?a:b, t1=a<b?b:a;
    if (t0>near) near=t0;
    if (t1<far) far=t1;
    if (far<near) return false;
  }
  if (invDy===0) {
    if (sy<shape.minY || sy>shape.maxY) return false;
  } else {
    const a=(shape.minY-sy)*invDy, b=(shape.maxY-sy)*invDy;
    const t0=a<b?a:b, t1=a<b?b:a;
    if (t0>near) near=t0;
    if (t1<far) far=t1;
    if (far<near) return false;
  }
  if (invDz===0) {
    if (sz<shape.minZ || sz>shape.maxZ) return false;
  } else {
    const a=(shape.minZ-sz)*invDz, b=(shape.maxZ-sz)*invDz;
    const t0=a<b?a:b, t1=a<b?b:a;
    if (t0>near) near=t0;
    if (t1<far) far=t1;
    if (far<near) return false;
  }
  if (near===-Infinity) return false;
  const t=near>=0?near:far;
  return t>=0 && t<=limit;
}

export function makeShape(type,x,y,z,w,h,d,kind,opts=IDENTITY) {
  if (!names.has(type) || w<.001 || h<.001 || d<.001) return null;
  const sd=type==='glass'?.004:d;
  const isBox=type==='box' || type==='glass';
  const basis=opts.basis;
  if (!basis) {
    const yaw=opts.yaw||0, pitch=opts.pitch||0;
    if (!yaw && !pitch) {
      const ex=w*.5, ey=h*.5, ez=sd*.5;
      return new Shape(
        type,kind,opts.layer,opts.windowId,isBox,isBox,isBox?null:meshFor(type),
        x,y,z,w,h,sd,x-ex,y-ey,z-ez,x+ex,y+ey,z+ez,
        1/w,0,0, 0,1/h,0, 0,0,1/sd
      );
    }
    const c1=Math.cos(yaw), s1=Math.sin(yaw);
    if (!pitch) {
      const ax=c1*w, az=-s1*w, cx=s1*sd, cz=c1*sd;
      const invW=1/w, invH=1/h, invD=1/sd;
      const ex=(Math.abs(ax)+Math.abs(cx))*.5, ey=h*.5, ez=(Math.abs(az)+Math.abs(cz))*.5;
      const isAA=isBox && (Math.abs(c1)<1e-10 || Math.abs(s1)<1e-10);
      return new Shape(
        type,kind,opts.layer,opts.windowId,isBox,isAA,isBox?null:meshFor(type),
        x,y,z,w,h,sd,x-ex,y-ey,z-ez,x+ex,y+ey,z+ez,
        c1*invW,0,-s1*invW, 0,invH,0, s1*invD,0,c1*invD
      );
    }
    const c2=Math.cos(pitch), s2=Math.sin(pitch);
    const ax=c1*w, ay=0, az=-s1*w;
    const bx=s1*s2*h, by=c2*h, bz=c1*s2*h;
    const cx=s1*c2*sd, cy=-s2*sd, cz=c1*c2*sd;
    const r0x=by*cz-bz*cy, r0y=bz*cx-bx*cz, r0z=bx*cy-by*cx;
    const det=ax*r0x+ay*r0y+az*r0z;
    if (det>-1e-14 && det<1e-14) return null;
    const invDet=1/det;
    const i0x=r0x*invDet, i0y=r0y*invDet, i0z=r0z*invDet;
    const i1x=(cy*az-cz*ay)*invDet, i1y=(cz*ax-cx*az)*invDet, i1z=(cx*ay-cy*ax)*invDet;
    const i2x=(ay*bz-az*by)*invDet, i2y=(az*bx-ax*bz)*invDet, i2z=(ax*by-ay*bx)*invDet;
    const ex=(Math.abs(ax)+Math.abs(bx)+Math.abs(cx))*.5;
    const ey=(Math.abs(ay)+Math.abs(by)+Math.abs(cy))*.5;
    const ez=(Math.abs(az)+Math.abs(bz)+Math.abs(cz))*.5;
    const isAA=isBox && (Math.abs(c1)<1e-10 || Math.abs(s1)<1e-10) && (Math.abs(c2)<1e-10 || Math.abs(s2)<1e-10);
    return new Shape(
      type,kind,opts.layer,opts.windowId,isBox,isAA,isBox?null:meshFor(type),
      x,y,z,w,h,sd,x-ex,y-ey,z-ez,x+ex,y+ey,z+ez,
      i0x,i0y,i0z,i1x,i1y,i1z,i2x,i2y,i2z
    );
  }
  const b0=basis[0], b1=basis[1], b2=basis[2];
  const ax=b0[0]*w, ay=b0[1]*w, az=b0[2]*w;
  const bx=b1[0]*h, by=b1[1]*h, bz=b1[2]*h;
  const cx=b2[0]*sd, cy=b2[1]*sd, cz=b2[2]*sd;
  const r0x=by*cz-bz*cy, r0y=bz*cx-bx*cz, r0z=bx*cy-by*cx;
  const det=ax*r0x+ay*r0y+az*r0z;
  if (det>-1e-14 && det<1e-14) return null;
  const invDet=1/det;
  const i0x=r0x*invDet, i0y=r0y*invDet, i0z=r0z*invDet;
  const i1x=(cy*az-cz*ay)*invDet, i1y=(cz*ax-cx*az)*invDet, i1z=(cx*ay-cy*ax)*invDet;
  const i2x=(ay*bz-az*by)*invDet, i2y=(az*bx-ax*bz)*invDet, i2z=(ax*by-ay*bx)*invDet;
  const ex=(Math.abs(ax)+Math.abs(bx)+Math.abs(cx))*.5;
  const ey=(Math.abs(ay)+Math.abs(by)+Math.abs(cy))*.5;
  const ez=(Math.abs(az)+Math.abs(bz)+Math.abs(cz))*.5;
  const isAA=isBox &&
    ((Math.abs(ax)<1e-10?1:0)+(Math.abs(ay)<1e-10?1:0)+(Math.abs(az)<1e-10?1:0)===2) &&
    ((Math.abs(bx)<1e-10?1:0)+(Math.abs(by)<1e-10?1:0)+(Math.abs(bz)<1e-10?1:0)===2) &&
    ((Math.abs(cx)<1e-10?1:0)+(Math.abs(cy)<1e-10?1:0)+(Math.abs(cz)<1e-10?1:0)===2);
  return new Shape(
    type,kind,opts.layer,opts.windowId,isBox,isAA,isBox?null:meshFor(type),
    x,y,z,w,h,sd,x-ex,y-ey,z-ez,x+ex,y+ey,z+ez,
    i0x,i0y,i0z,i1x,i1y,i1z,i2x,i2y,i2z
  );
}

export function castShapeInto(shape,sx,sy,sz,dx,dy,dz,limit,padding,out) {
  if (shape.disabled) return false;
  if (shape.isAA) {
    const invDx=(dx>-EPS && dx<EPS)?0:1/dx;
    const invDy=(dy>-EPS && dy<EPS)?0:1/dy;
    const invDz=(dz>-EPS && dz<EPS)?0:1/dz;
    return castAABoxInto(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,padding,out);
  }
  if (nearBox6(sx,sy,sz,dx,dy,dz,shape.minX,shape.minY,shape.minZ,shape.maxX,shape.maxY,shape.maxZ,limit,padding*1.733)===Infinity) return false;
  const ox=sx-shape.px, oy=sy-shape.py, oz=sz-shape.pz;
  let k0=1, k1=1, k2=1;
  if (padding) {
    const p2=padding*2;
    k0=shape.sx/(shape.sx+p2);
    k1=shape.sy/(shape.sy+p2);
    k2=shape.sz/(shape.sz+p2);
  }
  const ax=(shape.i0x*ox+shape.i0y*oy+shape.i0z*oz)*k0;
  const ay=(shape.i1x*ox+shape.i1y*oy+shape.i1z*oz)*k1;
  const az=(shape.i2x*ox+shape.i2y*oy+shape.i2z*oz)*k2;
  const vx=(shape.i0x*dx+shape.i0y*dy+shape.i0z*dz)*k0;
  const vy=(shape.i1x*dx+shape.i1y*dy+shape.i1z*dz)*k1;
  const vz=(shape.i2x*dx+shape.i2y*dy+shape.i2z*dz)*k2;
  const ok=shape.isBox?shapeBoxInto(ax,ay,az,vx,vy,vz,limit,_localHit)
    :castMeshInto(shape.tree??meshFor(shape.type),ax,ay,az,vx,vy,vz,limit,_localHit);
  if (!ok) return false;
  const n0=_localHit.nx*k0, n1=_localHit.ny*k1, n2=_localHit.nz*k2;
  const wnx=shape.i0x*n0+shape.i1x*n1+shape.i2x*n2;
  const wny=shape.i0y*n0+shape.i1y*n1+shape.i2y*n2;
  const wnz=shape.i0z*n0+shape.i1z*n1+shape.i2z*n2;
  const nLen=Math.sqrt(wnx*wnx+wny*wny+wnz*wnz);
  const invLen=1/(nLen>.00001?nLen:.00001);
  out.t=_localHit.t;
  out.nx=wnx*invLen; out.ny=wny*invLen; out.nz=wnz*invLen;
  out.shape=shape;
  return true;
}

function castShapeIntoFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,padding,out) {
  if (shape.isAA) return castAABoxInto(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,padding,out);
  return castShapeInto(shape,sx,sy,sz,dx,dy,dz,limit,padding,out);
}

function castShapeAnyFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,rx0,ry0,rz0,rx1,ry1,rz1) {
  if (shape.disabled || ry1<shape.minY || ry0>shape.maxY || rx1<shape.minX || rx0>shape.maxX || rz1<shape.minZ || rz0>shape.maxZ) return false;
  if (shape.isAA) return castAABoxAny(shape,sx,sy,sz,invDx,invDy,invDz);
  const ox=sx-shape.px, oy=sy-shape.py, oz=sz-shape.pz;
  const ax=shape.i0x*ox+shape.i0y*oy+shape.i0z*oz;
  const ay=shape.i1x*ox+shape.i1y*oy+shape.i1z*oz;
  const az=shape.i2x*ox+shape.i2y*oy+shape.i2z*oz;
  const vx=shape.i0x*dx+shape.i0y*dy+shape.i0z*dz;
  const vy=shape.i1x*dx+shape.i1y*dy+shape.i1z*dz;
  const vz=shape.i2x*dx+shape.i2y*dy+shape.i2z*dz;
  return shape.isBox?shapeBoxAny(ax,ay,az,vx,vy,vz)
    :castMeshAny(shape.tree??meshFor(shape.type),ax,ay,az,vx,vy,vz);
}

export function castShape(shape,start,delta,limit=1,padding=0) {
  if (!castShapeInto(shape,start[0],start[1],start[2],delta[0],delta[1],delta[2],limit,padding,_bestHit)) return null;
  const t=_bestHit.t;
  return {
    t,
    position:[start[0]+delta[0]*t,start[1]+delta[1]*t,start[2]+delta[2]*t],
    normal:[_bestHit.nx,_bestHit.ny,_bestHit.nz],
    shape
  };
}

export function traceShapes(shapes,start,end,padding=0) {
  const sx=start[0], sy=start[1], sz=start[2];
  const dx=end[0]-sx, dy=end[1]-sy, dz=end[2]-sz;
  const invDx=(dx>-EPS && dx<EPS)?0:1/dx;
  const invDy=(dy>-EPS && dy<EPS)?0:1/dy;
  const invDz=(dz>-EPS && dz<EPS)?0:1/dz;
  let limit=1, found=false;
  for (let i=0;i<shapes.length;i++) {
    const sh=shapes[i];
    if (!sh.disabled && castShapeIntoFast(sh,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,padding,_bestHit)) {
      limit=_bestHit.t;
      found=true;
    }
  }
  if (!found) return null;
  return {
    t:limit,
    position:[sx+dx*limit,sy+dy*limit,sz+dz*limit],
    normal:[_bestHit.nx,_bestHit.ny,_bestHit.nz],
    shape:_bestHit.shape
  };
}

export function collectShapes(draw) {
  const shapes=[];
  const receiver={zone:0,lite:false,add(type,x,y,z,w,h,d,_tint,kind=0,opts=IDENTITY) {
    const shape=makeShape(type,x,y,z,w,h,d,kind,opts);
    if (shape) shapes.push(shape);
  },label(){},beam(...args){Renderer.prototype.beam.call(this,...args);}};
  draw(receiver);
  return shapes;
}

export function actorInRay(actor,start,end,padding=0) {
  const r=actor.isBoss?4.8:actor.giant?2.15:actor.swimming?1.17:1.18;
  const h=actor.isBoss?6.98:actor.giant?3.27:actor.climbing?1.36:actor.swimming?1.12:2.16;
  const sx=start[0], sy=start[1], sz=start[2];
  return nearBox6(sx,sy,sz,end[0]-sx,end[1]-sy,end[2]-sz,
    actor.x-r,actor.y-.21,actor.z-r,actor.x+r,actor.y+h,actor.z+r,1,padding)!==Infinity;
}

export class Geometry {
  constructor(blueprint=null) {
    if (blueprint) {
      this.shapes=blueprint.shapes;
      this.grid0=blueprint.grid0;
      this.grid0MaxY=blueprint.grid0MaxY;
      this.grid1=blueprint.grid1;
      this.grid=blueprint.grid;
      this._visited=new Int32Array(blueprint.shapes.length);
      this._disabled=null;
    } else {
      this.shapes=[];
      // Flat dense grids for Zone 0 ([-160,160]^2) and Zone 1 ([1200,1360]x[-80,80]),
      // with Map fallback for outer-city coordinates and train cabins.
      this.grid0=new Array(4096);
      this.grid0MaxY=new Float32Array(4096).fill(-1e9);
      this.grid1=new Array(1024);
      this.grid=new Map();
      this._visited=null;
      this._disabled=null;
    }
    this.sequence=0;
    this.coats=new WeakMap();
  }

  static fromBlueprint(bp) {
    return new Geometry(bp);
  }

  disableRegion(zoneIndex,minX,maxX,minY,maxY,minZ,maxZ) {
    const shapes=this.shapes;
    if (!shapes.length) return 0;
    let disabled=0;
    if (this._visited) {
      let dis=this._disabled;
      for (let i=0;i<shapes.length;i++) {
        const sh=shapes[i];
        if ((dis && dis[sh.id]) || sh.zone!==zoneIndex) continue;
        if (sh.kind===0 || sh.kind===1 || sh.kind===5 || sh.kind===22 || sh.kind===27) continue;
        if (sh.px>=minX && sh.px<=maxX && sh.py>=minY && sh.py<=maxY && sh.pz>=minZ && sh.pz<=maxZ) {
          if (!dis) dis=this._disabled=new Uint8Array(shapes.length);
          dis[sh.id]=1;
          disabled++;
        }
      }
      return disabled;
    }
    for (let i=0;i<shapes.length;i++) {
      const sh=shapes[i];
      if (sh.disabled || sh.zone!==zoneIndex) continue;
      if (sh.kind===0 || sh.kind===1 || sh.kind===5 || sh.kind===22 || sh.kind===27) continue;
      if (sh.px>=minX && sh.px<=maxX && sh.py>=minY && sh.py<=maxY && sh.pz>=minZ && sh.pz<=maxZ) {
        sh.disabled=true;
        disabled++;
      }
    }
    return disabled;
  }

  track(renderer) {
    const geometry=this;
    return {
      get zone(){return renderer.zone;},
      set zone(value){renderer.zone=value;},
      add(type,x,y,z,w,h,d,tint,kind=0,opts=IDENTITY) {
        const shape=makeShape(type,x,y,z,w,h,d,kind,opts);
        if (shape) {
          shape.zone=renderer.zone;
          geometry.add(shape);
        }
        renderer.add(type,x,y,z,w,h,d,tint,kind,opts);
      },
      beam(...args){Renderer.prototype.beam.call(this,...args);},
      label(...args){renderer.label(...args);},
      seal(){renderer.seal();}
    };
  }

  add(shape) {
    shape.zone=shape.zone ?? zoneOf(shape.px);
    shape.id=this.shapes.length;
    shape.visited=-1;
    this.shapes.push(shape);
    const x0=Math.floor(shape.minX*INV_CELL), x1=Math.floor(shape.maxX*INV_CELL);
    const z0=Math.floor(shape.minZ*INV_CELL), z1=Math.floor(shape.maxZ*INV_CELL);
    const grid0=this.grid0, grid0MaxY=this.grid0MaxY, grid1=this.grid1, grid=this.grid;
    const sMaxY=shape.maxY;
    for (let z=z0;z<=z1;z++) {
      const uz0=z+32, uz1=z+16;
      const inZ0=(uz0&~63)===0, inZ1=(uz1&~31)===0;
      for (let x=x0;x<=x1;x++) {
        const ux0=x+32;
        if (inZ0 && (ux0&~63)===0) {
          const idx=(uz0<<6)|ux0;
          let b=grid0[idx];
          if (!b) grid0[idx]=b=[];
          b.push(shape);
          if (sMaxY>grid0MaxY[idx]) grid0MaxY[idx]=sMaxY;
          continue;
        }
        const ux1=x-(UNDER_CELL_X-16);
        if (inZ1 && (ux1&~31)===0) {
          const idx=(uz1<<5)|ux1;
          let b=grid1[idx];
          if (!b) grid1[idx]=b=[];
          b.push(shape);
          continue;
        }
        const key=z*1024+x;
        let bucket=grid.get(key);
        if (!bucket) {bucket=[];grid.set(key,bucket);}
        bucket.push(shape);
      }
    }
  }

  trace(start,end) {
    const sx=start[0], sy=start[1], sz=start[2];
    const ex=end[0], ey=end[1], ez=end[2];
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    const invDx=(dx>-EPS && dx<EPS)?0:1/dx;
    const invDy=(dy>-EPS && dy<EPS)?0:1/dy;
    const invDz=(dz>-EPS && dz<EPS)?0:1/dz;
    const zone=zoneOf(sx);
    const ry0=(sy<ey?sy:ey)-EPS, ry1=(sy>ey?sy:ey)+EPS;
    let x=Math.floor(sx*INV_CELL), z=Math.floor(sz*INV_CELL);
    const exCell=Math.floor(ex*INV_CELL), ezCell=Math.floor(ez*INV_CELL);
    const grid0=this.grid0, grid0MaxY=this.grid0MaxY, grid1=this.grid1, grid=this.grid;
    const vis=this._visited, dis=this._disabled;
    let limit=1, found=false;
    if (x===exCell && z===ezCell) {
      let candidates;
      const ux0=x+32, uz0=z+32;
      if (((ux0|uz0)&~63)===0) {
        const ci=(uz0<<6)|ux0;
        if (ry0>grid0MaxY[ci]) return null;
        candidates=grid0[ci];
      } else {
        const ux1=x-(UNDER_CELL_X-16), uz1=z+16;
        if (((ux1|uz1)&~31)===0) candidates=grid1[(uz1<<5)|ux1];
        else candidates=grid.get(z*1024+x);
      }
      if (candidates) {
        const rx0=(sx<ex?sx:ex)-EPS, rx1=(sx>ex?sx:ex)+EPS;
        const rz0=(sz<ez?sz:ez)-EPS, rz1=(sz>ez?sz:ez)+EPS;
        for (let i=0;i<candidates.length;i++) {
          const shape=candidates[i];
          if ((dis && dis[shape.id]) || shape.disabled || shape.zone!==zone || ry1<shape.minY || ry0>shape.maxY || rx1<shape.minX || rx0>shape.maxX || rz1<shape.minZ || rz0>shape.maxZ) continue;
          if (castShapeIntoFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,0,_bestHit)) {
            limit=_bestHit.t;
            found=true;
          }
        }
      }
    } else {
      const mark=++this.sequence;
      const stepX=dx>0?1:dx<0?-1:0, stepZ=dz>0?1:dz<0?-1:0;
      const tDeltaX=stepX?CELL/Math.abs(dx):Infinity, tDeltaZ=stepZ?CELL/Math.abs(dz):Infinity;
      let nx=stepX?((x+(stepX>0?1:0))*CELL-sx)*invDx:Infinity;
      let nz=stepZ?((z+(stepZ>0?1:0))*CELL-sz)*invDz:Infinity;
      const cells=Math.abs(exCell-x)+Math.abs(ezCell-z)+3;
      const rx0=(sx<ex?sx:ex)-EPS, rx1=(sx>ex?sx:ex)+EPS;
      const rz0=(sz<ez?sz:ez)-EPS, rz1=(sz>ez?sz:ez)+EPS;
      for (let step=0;step<cells;step++) {
        let candidates;
        const ux0=x+32, uz0=z+32;
        if (((ux0|uz0)&~63)===0) {
          const ci=(uz0<<6)|ux0;
          candidates=ry0>grid0MaxY[ci]?undefined:grid0[ci];
        } else {
          const ux1=x-(UNDER_CELL_X-16), uz1=z+16;
          if (((ux1|uz1)&~31)===0) candidates=grid1[(uz1<<5)|ux1];
          else candidates=grid.get(z*1024+x);
        }
        if (candidates) for (let i=0;i<candidates.length;i++) {
          const shape=candidates[i];
          if ((dis && dis[shape.id]) || shape.disabled || shape.zone!==zone || ry1<shape.minY || ry0>shape.maxY || rx1<shape.minX || rx0>shape.maxX || rz1<shape.minZ || rz0>shape.maxZ) continue;
          if (vis) {
            if (vis[shape.id]===mark) continue;
            vis[shape.id]=mark;
          } else {
            if (shape.visited===mark) continue;
            shape.visited=mark;
          }
          if (castShapeIntoFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,0,_bestHit)) {
            limit=_bestHit.t;
            found=true;
          }
        }
        if ((nx<nz?nx:nz)>limit) break;
        if (nx<=nz) {x+=stepX;nx+=tDeltaX;}
        else {z+=stepZ;nz+=tDeltaZ;}
      }
    }
    if (!found) return null;
    return {
      t:limit,
      position:[sx+dx*limit,sy+dy*limit,sz+dz*limit],
      normal:[_bestHit.nx,_bestHit.ny,_bestHit.nz],
      shape:_bestHit.shape
    };
  }

  // Zero-allocation boolean ray query with grid0MaxY ceiling reject, single-cell fast-path, and first-hit exit.
  traceAny(sx,sy,sz,ex,ey,ez) {
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    const invDx=(dx>-EPS && dx<EPS)?0:1/dx;
    const invDy=(dy>-EPS && dy<EPS)?0:1/dy;
    const invDz=(dz>-EPS && dz<EPS)?0:1/dz;
    const zone=zoneOf(sx);
    const rx0=(sx<ex?sx:ex)-EPS, rx1=(sx>ex?sx:ex)+EPS;
    const ry0=(sy<ey?sy:ey)-EPS, ry1=(sy>ey?sy:ey)+EPS;
    const rz0=(sz<ez?sz:ez)-EPS, rz1=(sz>ez?sz:ez)+EPS;
    let x=Math.floor(sx*INV_CELL), z=Math.floor(sz*INV_CELL);
    const exCell=Math.floor(ex*INV_CELL), ezCell=Math.floor(ez*INV_CELL);
    const grid0=this.grid0, grid0MaxY=this.grid0MaxY, grid1=this.grid1, grid=this.grid;
    const vis=this._visited, dis=this._disabled;
    if (x===exCell && z===ezCell) {
      let candidates;
      const ux0=x+32, uz0=z+32;
      if (((ux0|uz0)&~63)===0) {
        const ci=(uz0<<6)|ux0;
        if (ry0>grid0MaxY[ci]) return false;
        candidates=grid0[ci];
      } else {
        const ux1=x-(UNDER_CELL_X-16), uz1=z+16;
        if (((ux1|uz1)&~31)===0) candidates=grid1[(uz1<<5)|ux1];
        else candidates=grid.get(z*1024+x);
      }
      if (!candidates) return false;
      for (let i=0;i<candidates.length;i++) {
        const shape=candidates[i];
        if (ry0>shape.maxY || ry1<shape.minY || rx1<shape.minX || rx0>shape.maxX || rz1<shape.minZ || rz0>shape.maxZ) continue;
        if ((dis && dis[shape.id]) || shape.disabled || shape.zone!==zone) continue;
        if (shape.isAA ? castAABoxAny(shape,sx,sy,sz,invDx,invDy,invDz) : castShapeAnyFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,rx0,ry0,rz0,rx1,ry1,rz1)) return true;
      }
      return false;
    }
    const mark=++this.sequence;
    const stepX=dx>0?1:dx<0?-1:0, stepZ=dz>0?1:dz<0?-1:0;
    const tDeltaX=stepX?CELL/Math.abs(dx):Infinity, tDeltaZ=stepZ?CELL/Math.abs(dz):Infinity;
    let nx=stepX?((x+(stepX>0?1:0))*CELL-sx)*invDx:Infinity;
    let nz=stepZ?((z+(stepZ>0?1:0))*CELL-sz)*invDz:Infinity;
    const cells=Math.abs(exCell-x)+Math.abs(ezCell-z)+3;
    for (let step=0;step<cells;step++) {
      let candidates;
      const ux0=x+32, uz0=z+32;
      if (((ux0|uz0)&~63)===0) {
        const ci=(uz0<<6)|ux0;
        candidates=ry0>grid0MaxY[ci]?undefined:grid0[ci];
      } else {
        const ux1=x-(UNDER_CELL_X-16), uz1=z+16;
        if (((ux1|uz1)&~31)===0) candidates=grid1[(uz1<<5)|ux1];
        else candidates=grid.get(z*1024+x);
      }
      if (candidates) for (let i=0;i<candidates.length;i++) {
        const shape=candidates[i];
        if (ry0>shape.maxY || ry1<shape.minY || rx1<shape.minX || rx0>shape.maxX || rz1<shape.minZ || rz0>shape.maxZ) continue;
        if ((dis && dis[shape.id]) || shape.disabled || shape.zone!==zone) continue;
        if (vis) {
          if (vis[shape.id]===mark) continue;
          vis[shape.id]=mark;
        } else {
          if (shape.visited===mark) continue;
          shape.visited=mark;
        }
        if (shape.isAA ? castAABoxAny(shape,sx,sy,sz,invDx,invDy,invDz) : castShapeAnyFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,rx0,ry0,rz0,rx1,ry1,rz1)) return true;
      }
      if ((nx<nz?nx:nz)>1) break;
      if (nx<=nz) {x+=stepX;nx+=tDeltaX;}
      else {z+=stepZ;nz+=tDeltaZ;}
    }
    return false;
  }

  traceClearance(start,end,radius) {
    const sx=start[0], sy=start[1], sz=start[2];
    const ex=end[0], ey=end[1], ez=end[2];
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    const invDx=(dx>-EPS && dx<EPS)?0:1/dx;
    const invDy=(dy>-EPS && dy<EPS)?0:1/dy;
    const invDz=(dz>-EPS && dz<EPS)?0:1/dz;
    const mark=++this.sequence, margin=radius*1.733;
    const zone=zoneOf(sx);
    const ry0=(sy<ey?sy:ey)-margin-EPS, ry1=(sy>ey?sy:ey)+margin+EPS;
    const minX=Math.floor(((sx<ex?sx:ex)-margin)*INV_CELL);
    const maxX=Math.floor(((sx>ex?sx:ex)+margin)*INV_CELL);
    const minZ=Math.floor(((sz<ez?sz:ez)-margin)*INV_CELL);
    const maxZ=Math.floor(((sz>ez?sz:ez)+margin)*INV_CELL);
    let limit=1, found=false;
    const grid0=this.grid0, grid1=this.grid1, grid=this.grid;
    const vis=this._visited, dis=this._disabled;
    for (let z=minZ;z<=maxZ;z++) {
      const uz0=z+32, uz1=z+16;
      const inZ0=(uz0&~63)===0, inZ1=(uz1&~31)===0;
      for (let x=minX;x<=maxX;x++) {
        let candidates;
        const ux0=x+32;
        if (inZ0 && (ux0&~63)===0) candidates=grid0[(uz0<<6)|ux0];
        else {
          const ux1=x-(UNDER_CELL_X-16);
          if (inZ1 && (ux1&~31)===0) candidates=grid1[(uz1<<5)|ux1];
          else candidates=grid.get(z*1024+x);
        }
        if (!candidates) continue;
        for (let i=0;i<candidates.length;i++) {
          const shape=candidates[i];
          if ((dis && dis[shape.id]) || shape.disabled || shape.zone!==zone || ry1<shape.minY || ry0>shape.maxY) continue;
          if (vis) {
            if (vis[shape.id]===mark) continue;
            vis[shape.id]=mark;
          } else {
            if (shape.visited===mark) continue;
            shape.visited=mark;
          }
          if (castShapeIntoFast(shape,sx,sy,sz,dx,dy,dz,invDx,invDy,invDz,limit,radius,_bestHit)) {
            limit=_bestHit.t;
            found=true;
          }
        }
      }
    }
    if (!found) return null;
    return {
      t:limit,
      position:[sx+dx*limit,sy+dy*limit,sz+dz*limit],
      normal:[_bestHit.nx,_bestHit.ny,_bestHit.nz],
      shape:_bestHit.shape
    };
  }

  coat(mark,axes,radii) {
    const shape=this.shapes[mark.shape];
    if (!shape) return null;
    if (!this.coats.has(mark)) {
      this.coats.set(mark,surfaceRim(shape,add(mark.p,scale(mark.normal,-.023)),axes,radii,mark.radius));
    }
    return this.coats.get(mark);
  }
}

export function surfaceRim(shape,point,[u,v,n],radii,radius) {
  const rims=radii.map((amount,i)=>{
    const angle=i/radii.length*Math.PI*2;
    return add(scale(u,Math.cos(angle)*amount*radius*1.66),scale(v,Math.sin(angle)*amount*radius*1.35));
  });
  if (shape.type==='box' || shape.type==='glass') {
    const center=sub(point,shape.p);
    let points=rims.map(rim=>add(point,rim));
    const alignment=shape.inverse.map(axis=>Math.abs(dot(n,unit(axis))));
    const face=alignment.indexOf(Math.max(...alignment));
    for (const [i,axis] of shape.inverse.entries()) {
      if (i===face) continue;
      for (const side of [-1,1]) {
        if (!points.length) return [];
        const distance=position=>.5-side*dot(axis,add(center,sub(position,point)));
        let last=points.at(-1), before=distance(last);
        const clipped=[];
        for (const next of points) {
          const after=distance(next);
          if ((before>=0)!==(after>=0)) clipped.push(add(last,scale(sub(next,last),before/(before-after))));
          if (after>=0) clipped.push(next);
          last=next;
          before=after;
        }
        points=clipped;
      }
    }
    return points;
  }
  return rims.map(rim=>{
    for (const amount of [1,.82,.65,.48,.32,.16,.04]) {
      const projected=add(point,scale(rim,amount)), start=add(projected,scale(n,.105));
      const hit=castShape(shape,start,scale(n,-.34));
      if (hit && dot(hit.normal,n)>.70) return hit.position;
    }
    return point;
  });
}
