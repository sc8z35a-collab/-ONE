import {Renderer,add,cross,dot,instanceBasis,meshes,scale,sub,unit} from './render.js';
import {zoneOf} from './layout.js';

const CELL=5, EPS=1e-8;
const names=new Set(['box','bevel','orb','cylinder','taper','cone','ramp','glass','ring']);
const UNIT_MIN=[-.5,-.5,-.5], UNIT_MAX=[.5,.5,.5], IDENTITY={};
let meshCache;

function nearBox(start,delta,min,max,limit=1,padding=0) {
  let near=0,far=limit;
  for (let k=0;k<3;k++) {
    const o=start[k],d=delta[k],lo=min[k]-padding,hi=max[k]+padding;
    if (Math.abs(d)<EPS) {
      if (o<lo-EPS || o>hi+EPS) return Infinity;
    } else {
      const a=(lo-o)/d,b=(hi-o)/d;
      near=Math.max(near,Math.min(a,b));
      far=Math.min(far,Math.max(a,b));
      if (far<near) return Infinity;
    }
  }
  return near;
}

function shapeBox(start,delta,limit) {
  let near=-Infinity,far=Infinity,enter=-1,exit=-1,enterSign=1,exitSign=1;
  for (let k=0;k<3;k++) {
    const p=start[k],d=delta[k];
    if (Math.abs(d)<EPS) {
      if (p<-.5 || p>.5) return null;
      continue;
    }
    const a=(-.5-p)/d,b=(.5-p)/d,lo=Math.min(a,b),hi=Math.max(a,b);
    if (lo>near) {near=lo;enter=k;enterSign=d>0?-1:1;}
    if (hi<far) {far=hi;exit=k;exitSign=d>0?1:-1;}
    if (far<near) return null;
  }
  const outside=near>=0,t=outside?near:far,axis=outside?enter:exit;
  if (axis<0 || t<0 || t>limit) return null;
  const normal=[0,0,0];
  normal[axis]=outside?enterSign:exitSign;
  return {t,normal};
}

function triangleData(mesh) {
  const {vertices,indices}=mesh, triangles=[];
  for (let i=0;i<indices.length;i+=3) {
    const [a,b,c]=[indices[i],indices[i+1],indices[i+2]].map(k=>vertices.slice(k*8,k*8+3));
    const e1=sub(b,a),e2=sub(c,a), raw=cross(e1,e2);
    if (dot(raw,raw)<EPS) continue;
    const n=vertices.slice(indices[i]*8+3,indices[i]*8+6);
    triangles.push({a,e1,e2,normal:unit(dot(raw,n)<0?scale(raw,-1):raw),
      min:a.map((v,k)=>Math.min(v,b[k],c[k])),max:a.map((v,k)=>Math.max(v,b[k],c[k]))});
  }
  return triangles;
}

function split(triangles) {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for (const t of triangles) for (let k=0;k<3;k++) {
    min[k]=Math.min(min[k],t.min[k]);
    max[k]=Math.max(max[k],t.max[k]);
  }
  if (triangles.length<=8) return {min,max,triangles};
  let axis=0;
  for (let k=1;k<3;k++) if (max[k]-min[k]>max[axis]-min[axis]) axis=k;
  triangles.sort((a,b)=>(a.min[axis]+a.max[axis])-(b.min[axis]+b.max[axis]));
  const mid=Math.floor(triangles.length/2);
  return {min,max,left:split(triangles.slice(0,mid)),right:split(triangles.slice(mid))};
}

function castMesh(tree,start,delta,limit) {
  if (nearBox(start,delta,tree.min,tree.max,limit)===Infinity) return null;
  if (!tree.triangles) {
    const a=castMesh(tree.left,start,delta,limit), b=castMesh(tree.right,start,delta,a?.t??limit);
    return b ?? a;
  }
  let hit=null;
  for (const tri of tree.triangles) {
    const p=cross(delta,tri.e2), det=dot(tri.e1,p);
    if (Math.abs(det)<EPS) continue;
    const inverse=1/det, diff=sub(start,tri.a), u=dot(diff,p)*inverse;
    if (u< -EPS || u>1+EPS) continue;
    const q=cross(diff,tri.e1),v=dot(delta,q)*inverse;
    if (v< -EPS || u+v>1+EPS) continue;
    const t=dot(tri.e2,q)*inverse;
    if (t<0 || t>limit) continue;
    limit=t;
    hit={t,normal:tri.normal};
  }
  return hit;
}

function meshFor(type) {
  if (!meshCache) meshCache=new Map(Object.entries(meshes()).filter(([kind])=>names.has(kind) && kind!=='box')
    .map(([kind,mesh])=>[kind,split(triangleData(mesh))]));
  return meshCache.get(type);
}

export function makeShape(type,x,y,z,w,h,d,kind,opts=IDENTITY) {
  if (!names.has(type) || Math.min(w,h,d)<.001) return null;
  const p=[x,y,z], size=[w,h,type==='glass'?.004:d], axes=instanceBasis(opts);
  const columns=axes.map((axis,k)=>scale(axis,size[k]));
  const determinant=dot(columns[0],cross(columns[1],columns[2]));
  if (Math.abs(determinant)<1e-14) return null;
  const inverse=[cross(columns[1],columns[2]),cross(columns[2],columns[0]),cross(columns[0],columns[1])]
    .map(row=>scale(row,1/determinant));
  const extent=p.map((_,i)=>(Math.abs(columns[0][i])+Math.abs(columns[1][i])+Math.abs(columns[2][i]))*.5);
  return {type,p,inverse,min:sub(p,extent),max:add(p,extent),kind,layer:opts.layer,windowId:opts.windowId,span:size,id:-1};
}

export function castShape(shape,start,delta,limit=1,padding=0) {
  if (nearBox(start,delta,shape.min,shape.max,limit,padding*1.733)===Infinity) return null;
  const inverse=padding?shape.inverse.map((axis,i)=>scale(axis,shape.span[i]/(shape.span[i]+2*padding))):shape.inverse;
  const offset=sub(start,shape.p), a=inverse.map(axis=>dot(axis,offset)), v=inverse.map(axis=>dot(axis,delta));
  const hit=shape.type==='box' || shape.type==='glass'?shapeBox(a,v,limit):castMesh(meshFor(shape.type),a,v,limit);
  if (!hit) return null;
  const n=hit.normal;
  return {t:hit.t,position:add(start,scale(delta,hit.t)),
    normal:unit(add(add(scale(inverse[0],n[0]),scale(inverse[1],n[1])),scale(inverse[2],n[2]))),shape};
}

export function traceShapes(shapes,start,end,padding=0) {
  const delta=sub(end,start);
  let best=null;
  for (const shape of shapes) {
    const hit=castShape(shape,start,delta,best?.t??1,padding);
    if (hit) best=hit;
  }
  return best;
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
  return nearBox(start,sub(end,start),[actor.x-r,actor.y-.21,actor.z-r],[actor.x+r,actor.y+h,actor.z+r],1,padding)!==Infinity;
}

export class Geometry {
  constructor() {
    this.shapes=[];
    this.grid=new Map();
    this.sequence=0;
    this.coats=new WeakMap();
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
    shape.zone??=zoneOf(shape.p[0]);
    shape.id=this.shapes.length;
    shape.visited=-1;
    this.shapes.push(shape);
    const [min,,lo]=shape.min,[max,,hi]=shape.max;
    for (let z=Math.floor(lo/CELL);z<=Math.floor(hi/CELL);z++) for (let x=Math.floor(min/CELL);x<=Math.floor(max/CELL);x++) {
      const key=z*1024+x;
      let bucket=this.grid.get(key);
      if (!bucket) {bucket=[];this.grid.set(key,bucket);}
      bucket.push(shape);
    }
  }

  trace(start,end) {
    const delta=sub(end,start), mark=++this.sequence;
    const zone=zoneOf(start[0]);
    let x=Math.floor(start[0]/CELL),z=Math.floor(start[2]/CELL);
    const sx=Math.sign(delta[0]),sz=Math.sign(delta[2]);
    const dx=sx?CELL/Math.abs(delta[0]):Infinity,dz=sz?CELL/Math.abs(delta[2]):Infinity;
    let nx=sx?((x+(sx>0?1:0))*CELL-start[0])/delta[0]:Infinity;
    let nz=sz?((z+(sz>0?1:0))*CELL-start[2])/delta[2]:Infinity;
    let best=null;
    const cells=Math.abs(Math.floor(end[0]/CELL)-x)+Math.abs(Math.floor(end[2]/CELL)-z)+3;
    for (let step=0;step<cells;step++) {
      const candidates=this.grid.get(z*1024+x);
      if (candidates) for (const shape of candidates) {
        if (shape.visited===mark || shape.zone!==zone) continue;
        shape.visited=mark;
        const hit=castShape(shape,start,delta,best?.t??1);
        if (hit) best=hit;
      }
      if (Math.min(nx,nz)>(best?.t??1)) break;
      if (nx<=nz) {x+=sx;nx+=dx;}
      else {z+=sz;nz+=dz;}
    }
    return best;
  }

  traceClearance(start,end,radius) {
    const delta=sub(end,start), mark=++this.sequence, margin=radius*1.733;
    const zone=zoneOf(start[0]);
    const minX=Math.floor((Math.min(start[0],end[0])-margin)/CELL);
    const maxX=Math.floor((Math.max(start[0],end[0])+margin)/CELL);
    const minZ=Math.floor((Math.min(start[2],end[2])-margin)/CELL);
    const maxZ=Math.floor((Math.max(start[2],end[2])+margin)/CELL);
    let best=null;
    for (let z=minZ;z<=maxZ;z++) for (let x=minX;x<=maxX;x++) {
      const candidates=this.grid.get(z*1024+x);
      if (!candidates) continue;
      for (const shape of candidates) {
        if (shape.visited===mark || shape.zone!==zone) continue;
        shape.visited=mark;
        const hit=castShape(shape,start,delta,best?.t??1,radius);
        if (hit) best=hit;
      }
    }
    return best;
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
