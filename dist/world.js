import {TAU,add,clamp,scale,sub,mix} from './render.js';

import {BOUNDS,ENCLOSURE,METRO,RAIL,UNDER_Y,ZONES,cityExit,floorBounds,inCity,isUnder,localX,railEnd,sameLevel,zoneOf} from './layout.js';
import {buildRail,buildUnderground} from './levels.js';
import {buildMetro,buildCabin} from './metro-stage.js';
import {buildStairs,cutStairOpenings,stairAt,stairCrossing,stairFloor} from './stairs.js';
import {Geometry} from './collision.js';
import {buildEnclosure} from './enclosure.js';
import {buildStreetFacilities} from './street-facilities.js';
import {floorWeathering,wallWeathering} from './weathering.js';
import {apartmentEntry,buildApartmentEntry} from './apartment-entries.js';
import {buildBreakableBlocks,prepareStageObjects} from './stage-objects.js';
import {buildElevatedApproach} from './elevated-approach.js';

export {BOUNDS};
export const SPAWN_X = 47.0;
export const TEAM = [0x09bfa9,0xf06b2c];
export const TEAM_INK = [0x10d8be,0xff6c33];
const STEEL = 0x77818a, WHITE = 0xf0eee0;
const CELL = 5;
const T = Math.PI / 2;
const panelColors = [0xcebba2,0xaab6b1,0xc7c5af,0xb9c7cb,0xe1d0b7,0xd2bfaf,0xa2b4bc];

export function randomGenerator(seed) {
  const next=() => {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    return seed / 4294967296;
  };
  next.state=()=>seed;
  return next;
}

export function rayBox(start,delta,box) {
  let near = 0, far = 1, axis = 1, sign = 1;
  for (let k = 0; k < 3; k++) {
    const lo = box.min[k], hi = box.max[k], p = start[k], v = delta[k];
    if (Math.abs(v)<.00001) {
      if (p<lo || p>hi) return null;
      continue;
    }
    const u = (lo-p)/v, w = (hi-p)/v, enter = Math.min(u,w);
    if (enter > near) {
      near = enter;
      axis = k;
      sign = u < w ? -1 : 1;
    }
    far = Math.min(far,Math.max(u,w));
    if (far < near) return null;
  }
  const normal = [0,0,0];
  normal[axis] = sign;
  return {t:near,normal};
}

export class World {
  constructor(renderer,scene=null) {
    this.geometry=new Geometry();
    this.r=this.geometry.track(renderer);
    this.solids=scene?.solids ?? [];
    this.slabs=scene?.slabs ?? [];
    this.homes=scene?.homes ?? [];
    this.elevated=scene?.elevated ?? [];
    this.objects=scene?.objects ?? [];
    this.rng=randomGenerator(784301);
    if (scene) {
      this.loadParts(this.r,scene.parts);
    } else {
      this.build();
      buildRail(this);
      buildStairs(this,0);
      this.sealAlleys();
      renderer.zone=1;
      buildUnderground(this);
      buildMetro(this);
      buildStairs(this,1);
      renderer.zone=2;
      buildCabin(this,METRO);
      renderer.zone=3;
      buildCabin(this,RAIL);
    }
    renderer.zone=0;
    this.stageParts=prepareStageObjects(this.objects);
    this.indexSolids();
    renderer.seal();
    this.r=renderer;
  }

  loadParts(renderer,parts) {
    for (const [zone,type,...args] of parts) {
      renderer.zone=zone;
      if (type==='label') renderer.label(...args);
      else renderer.add(type,...args);
    }
    renderer.zone=0;
  }

  rebuildRenderer(renderer,scene) {
    if (scene) {
      this.loadParts(renderer,scene.parts);
      renderer.seal();
    } else new World(renderer);
    this.r=renderer;
  }

  // Neighbouring buildings with a narrow gap between them get an infill wall,
  // so nobody (squid form included) can slip into an alley the camera cannot
  // follow. Wider passages stay open.
  sealAlleys(maxGap=2.6,inset=.12) {
    const ground=this.solids.filter(b=>zoneOf(b.min[0])===0);
    // A building's full height: the tallest solid stacked over its footprint.
    const height=b=>{
      const x=(b.min[0]+b.max[0])/2, z=(b.min[2]+b.max[2])/2;
      let top=b.max[1];
      for (const c of ground) if (x>c.min[0] && x<c.max[0] && z>c.min[2] && z<c.max[2] && c.min[1]<=top+.3) top=Math.max(top,c.max[1]);
      return top;
    };
    const buildings=ground.filter(b=>b.min[1]<.5 && b.max[1]>2.4 && b.max[0]-b.min[0]>1.2 && b.max[2]-b.min[2]>1.2)
      .map(b=>Object.assign(Object.create(null),{min:b.min,max:[b.max[0],height(b),b.max[2]]}));
    const fills=[];
    for (let i=0;i<buildings.length;i++) for (let j=i+1;j<buildings.length;j++) {
      const a=buildings[i], b=buildings[j];
      for (const k of [0,2]) {
        const o=2-k, [first,second]=a.max[k]<=b.min[k]?[a,b]:[b,a];
        const from=first.max[k], to=second.min[k];
        if (to-from<=.05 || to-from>=maxGap) continue;
        const lo=Math.max(a.min[o],b.min[o])+inset, hi=Math.min(a.max[o],b.max[o])-inset;
        if (hi-lo<.6) continue;
        fills.push({k,from,to,lo,hi,top:Math.min(a.max[1],b.max[1])});
      }
    }
    // Several solids of one building can face the same gap: merge their fills.
    const merged=[];
    for (const fill of fills.sort((p,q)=>p.k-q.k || p.from-q.from || p.lo-q.lo)) {
      const last=merged.find(m=>m.k===fill.k && Math.abs(m.from-fill.from)<.02 && Math.abs(m.to-fill.to)<.02 && fill.lo<=m.hi+.01);
      if (last) {
        last.hi=Math.max(last.hi,fill.hi);
        last.top=Math.max(last.top,fill.top);
      } else merged.push({...fill});
    }
    for (const {k,from,to,lo,hi,top} of merged) {
      const across=(from+to)/2, along=(lo+hi)/2, span=to-from, length=hi-lo;
      if (k===0) this.solid(across,top/2,along,span,top,length,0xb1b0a4,2);
      else this.solid(along,top/2,across,length,top,span,0xb1b0a4,2);
    }
    return merged.length;
  }

  obstacle(x,y,z,w,h,d,ray = true,paintLayer=undefined) {
    this.solids.push({min:[x-w/2,y-h/2,z-d/2],max:[x+w/2,y+h/2,z+d/2],ray,paintLayer});
  }

  indexSolids() {
    this.collisionGrid=new Map();
    for (const box of this.solids) {
      for (let z=Math.floor(box.min[2]/CELL);z<=Math.floor(box.max[2]/CELL);z++) {
        for (let x=Math.floor(box.min[0]/CELL);x<=Math.floor(box.max[0]/CELL);x++) {
          const key=z*1024+x;
          if (!this.collisionGrid.has(key)) this.collisionGrid.set(key,[]);
          this.collisionGrid.get(key).push(box);
        }
      }
    }
  }

  solid(x,y,z,w,h,d,tint,kind = 2,opts) {
    this.r.add('box',x,y,z,w,h,d,tint,kind,opts);
    this.obstacle(x,y,z,w,h,d);
  }

  deck(x0,x1,z0,z1,height,tint) {
    const x=(x0+x1)/2,z=(z0+z1)/2,w=x1-x0,d=z1-z0;
    const under=isUnder(x), bed=under?UNDER_Y:0, layer=under?3:1;
    this.slabs.push({x0,x1,z0,z1,from:bed+height,to:bed+height,axis:'x',layer});
    this.r.add('box',x,bed+height/2-.015,z,w,height+.03,d,tint,1,{layer});
  }

  ramp(x0,x1,z0,z1,from,to,axis,tint) {
    const under=isUnder(x0), bed=under?UNDER_Y:0, layer=under?3:1;
    this.slabs.push({x0,x1,z0,z1,from:bed+from,to:bed+to,axis,layer});
    const length = axis==='x' ? x1-x0 : z1-z0;
    const width = axis==='x' ? z1-z0 : x1-x0;
    const yaw = (axis==='x' ? 0 : -T) + (from<to ? 0 : Math.PI);
    const top = Math.max(from,to);
    this.r.add('ramp',(x0+x1)/2,bed+top/2,(z0+z1)/2,length,top,width,tint,1,{yaw,layer});
  }

  floor(x,z) {
    const stair=stairFloor(x,z);
    if (stair) return stair;
    for (const s of this.slabs) {
      if (x<s.x0 || x>s.x1 || z<s.z0 || z>s.z1) continue;
      const t = s.axis==='x' ? (x-s.x0)/(s.x1-s.x0) : (z-s.z0)/(s.z1-s.z0);
      return {y:mix(s.from,s.to,t),layer:s.layer};
    }
    const {y,layer}=ZONES[zoneOf(x)];
    return {y,layer};
  }

  elevatedHeight(x,z) {
    for (const ramp of this.elevated) {
      if (x>=ramp.x0 && x<=ramp.x1 && z>=ramp.z0 && z<=ramp.z1) {
        return ramp.high*(ramp.z1-z)/(ramp.z1-ramp.z0);
      }
    }
    return -Infinity;
  }

  support(x,y,z) {
    const base=this.floor(x,z);
    const ramp=this.elevatedHeight(x,z);
    let top=ramp<=y+.32?Math.max(base.y,ramp):base.y;
    if (y<base.y+.22 && top===base.y) return base;
    const boxes=this.collisionGrid.get(Math.floor(z/CELL)*1024+Math.floor(x/CELL));
    if (boxes) for (const {min,max} of boxes) {
      if (max[1]<=top+.12 || max[1]>y+.095 || x<=min[0]+.05 || x>=max[0]-.05 || z<=min[2]+.05 || z>=max[2]-.05) continue;
      top=max[1];
    }
    return top>base.y?{y:top,layer:base.layer,raised:true}:base;
  }

  blocked(x,y,z,radius = .41,height = 1.68) {
    const bounds=floorBounds(x);
    if (zoneOf(x)===0 ? !inCity(x,z,radius) :
        Math.abs(localX(x))>bounds[0]-radius || Math.abs(z)>bounds[1]-radius) return true;
    const ramp=this.elevatedHeight(x,z);
    if (y<ramp-.020 && y+height>ramp-.46) return true;
    for (let row=Math.floor((z-radius)/CELL);row<=Math.floor((z+radius)/CELL);row++) {
      for (let col=Math.floor((x-radius)/CELL);col<=Math.floor((x+radius)/CELL);col++) {
        const boxes=this.collisionGrid.get(row*1024+col);
        if (!boxes) continue;
        for (const {min,max} of boxes) {
          if (y>=max[1]-.025 || y+height<=min[1]+.025) continue;
          const dx=x-clamp(x,min[0],max[0]), dz=z-clamp(z,min[2],max[2]);
          if (dx*dx+dz*dz<radius*radius) return true;
        }
      }
    }
    return false;
  }

  stand(x,z,radius=.48) {
    return !this.blocked(x,this.floor(x,z).y+.025,z,radius);
  }

  step(actor,dx,dz,allow) {
    for (const [sx,sz] of [[dx,0],[0,dz]]) {
      const rawX=actor.x+sx,z=actor.z+sz;
      if (!sameLevel(actor.x,rawX)) continue;
      const x=stairCrossing(actor.x,actor.z,rawX,z,actor.y);
      const ground=this.support(x,actor.y+.13,z).y;
      const y=Math.max(actor.y,ground)+.018;
      const radius=actor.radius??(actor.swimming?.33:.4), height=actor.height??(actor.swimming?.58:1.72);
      if (ground>actor.y+.37 || this.blocked(x,y,z,radius,height) || allow && !allow(x,y,z,radius,height)) continue;
      actor.x=x;
      actor.z=z;
      if (ground>actor.y) actor.y=ground;
    }
  }

  trace(start,end) {
    if (zoneOf(start[0])===0 && (Math.abs(start[0])>BOUNDS[0] || Math.abs(end[0])>BOUNDS[0] ||
        Math.abs(start[2])>BOUNDS[1] || Math.abs(end[2])>BOUNDS[1])) return this.traceExact(start,end);
    const delta=sub(end,start);
    let best=null;
    const minX=Math.floor(Math.min(start[0],end[0])/CELL), maxX=Math.floor(Math.max(start[0],end[0])/CELL);
    const minZ=Math.floor(Math.min(start[2],end[2])/CELL), maxZ=Math.floor(Math.max(start[2],end[2])/CELL);
    const seen=minX!==maxX || minZ!==maxZ ? new Set() : null;
    for (let z=minZ;z<=maxZ;z++) for (let x=minX;x<=maxX;x++) {
      const boxes=this.collisionGrid.get(z*1024+x);
      if (!boxes) continue;
      for (const box of boxes) {
        if (!box.ray || !sameLevel(box.min[0],start[0]) || seen?.has(box)) continue;
        seen?.add(box);
        const hit=rayBox(start,delta,box);
        if (hit && (!best || hit.t<best.t)) {
          if (box.paintLayer!==undefined && hit.normal[1]>.5) hit.layer=box.paintLayer;
          best=hit;
        }
      }
    }
    const samples=Math.ceil(Math.hypot(...delta)/.24);
    const bounds=floorBounds(start[0]);
    let lastT=0;
    for (let i=1;i<=samples;i++) {
      const t=i/samples;
      if (best && lastT>=best.t) break;
      const [x,y,z]=add(start,scale(delta,t));
      if (sameLevel(x,start[0]) && Math.abs(localX(x))<bounds[0]+2 && Math.abs(z)<bounds[1]+2 && y<=this.floor(x,z).y) {
        let low=lastT, high=t;
        for (let j=0;j<5;j++) {
          const mid=(low+high)/2;
          const [mx,my,mz]=add(start,scale(delta,mid));
          if (my<=this.floor(mx,mz).y) high=mid;
          else low=mid;
        }
        if (!best || high<best.t) {
          const px=start[0]+delta[0]*high, pz=start[2]+delta[2]*high;
          const surface=this.floor(px,pz);
          const prev=this.floor(px-.08,pz).y, next=this.floor(px+.08,pz).y;
          const prevZ=this.floor(px,pz-.08).y, nextZ=this.floor(px,pz+.08).y;
          const dx=next-prev,dz=nextZ-prevZ;
          const vertical=Math.max(Math.abs(dx),Math.abs(dz))>.32;
          best={t:high,normal:vertical ? (Math.abs(dx)>Math.abs(dz)?[-Math.sign(dx),0,0]:[0,0,-Math.sign(dz)]) : [0,1,0],layer:vertical?undefined:surface.layer};
        }
        break;
      }
      lastT=t;
    }
    return best ? {...best,position:add(start,scale(delta,best.t))} : null;
  }

  traceExact(start,end,clearance=0) {
    const hit=clearance?this.geometry.traceClearance(start,end,clearance):this.geometry.trace(start,end);
    const edge=zoneOf(start[0])===0?cityExit(start,end,clearance):null;
    if (edge!==null && (!hit || edge<hit.t)) {
      const position=add(start,scale(sub(end,start),edge));
      const length=Math.hypot(position[0],position[2])||1;
      return {t:edge,position,normal:[-position[0]/length,0,-position[2]/length],boundary:true};
    }
    if (!hit) return null;
    const [x,y,z]=hit.position, {shape,normal}=hit;
    if (normal[1]>.54 && [1,5,15,22,27].includes(shape.kind)) {
      const floor=this.floor(x,z);
      if (shape.layer!==undefined && (shape.layer===4 || shape.kind===15 || Math.abs(y-floor.y)<.26)) hit.layer=shape.layer;
      else if (Math.abs(y-floor.y)<.17 && shape.span[0]*shape.span[2]>.24) hit.layer=floor.layer;
    }
    return hit;
  }

  rail(a,b,tint=STEEL,posts=5) {
    const r=this.r;
    for (const height of [.41,.90]) r.beam(add(a,[0,height,0]),add(b,[0,height,0]),.068,.068,tint,4);
    for (let i=0;i<=posts;i++) {
      const x=mix(a[0],b[0],i/posts),y=mix(a[1],b[1],i/posts),z=mix(a[2],b[2],i/posts);
      r.add('box',x,y+.48,z,.085,.96,.085,tint,4);
      r.add('box',x,y+.028,z,.205,.056,.205,0x696c6a,4);
      for (const o of [-.07,.07]) r.add('cylinder',x+o,y+.07,z+.07,.046,.035,.046,0xadb4ad,4);
    }
  }

  barrier(x,z,w,depth=.66,tint=0xc8c5b4,y=0) {
    const r=this.r;
    this.solid(x,y+.29,z,w,.58,depth,tint,1);
    r.add('box',x,y+.58,z,w-.06,.09,depth*.67,0xe1decd,1);
    r.add('box',x,y+.12,z,w+.10,.23,depth+.14,0x9e9e94,1);
    for (let i=0;i<Math.floor(w/.44);i++) {
      const bx=x-w/2+.26+i*.44;
      for (const sign of [-1,1]) r.add('box',bx,y+.34,z+sign*(depth/2+.013),.26,.205,.026,i%2?0xe4af45:0x646053,2);
    }
  }

  pole(x,z,h=5.4,sign=1) {
    const r=this.r;
    r.add('box',x,.13,z,.49,.26,.49,0x999d92,1);
    r.add('cylinder',x,h/2,z,.16,h,.16,0x687777,4);
    r.add('cylinder',x,.57,z,.22,1.12,.22,0x787f78,4);
    r.beam([x,h-.4,z],[x,h+.14,z+.66*sign],.09,.10,0x6a7779,4);
    r.beam([x,h+.14,z+.66*sign],[x,h+.14,z+1.21*sign],.09,.10,0x6a7779,4);
    r.add('box',x,h+.14,z+1.13*sign,.30,.14,.68,0x757f7a,4);
    r.add('box',x,h+.064,z+1.20*sign,.24,.02,.41,WHITE,0);
  }

  kiosk(x,z,sign,tint,label) {
    const r=this.r;
    this.solid(x,1.18,z,2.7,2.36,2.15,tint,2);
    r.add('box',x,2.40,z,2.93,.14,2.37,0xd1cbbb,2);
    r.add('box',x,1.39,z+1.08*sign,2.37,.94,.063,0x4e6364,8);
    r.add('box',x,.90,z+1.24*sign,2.49,.16,.43,0xa59d86,4);
    r.add('box',x,2.03,z+1.10*sign,2.43,.35,.09,tint,2);
    r.label(label,x,2.04,z+1.152*sign,2.35,.33,WHITE,sign===1?0:Math.PI);
    for (let i=0;i<4;i++) r.add('box',x-.82+i*.55,1.4,z+1.12*sign,.05,1,.06,0x9eaaa5,4);
    for (let i=0;i<9;i++) r.add('box',x-1.02+i*.25,2.24,z+1.30*sign,.24,.075,.58,i%2?tint:0xece6d2,2);
  }

  container(x,z,tint,w=6.3,d=2.55,y=0) {
    const r=this.r,h=2.65;
    this.solid(x,y+h/2,z,w,h,d,tint,2);
    for (const s of [-1,1]) {
      for (const hy of [.12,h-.11]) r.add('box',x,y+hy,z+s*d/2,w+.09,.16,.15,tint,4);
      for (let k=-w/2+.22;k<w/2-.12;k+=.34) r.add('box',x+k,y+h/2,z+s*(d/2+.036),.13,h-.24,.095,tint,4);
      for (const off of [-w/2+.09,w/2-.09]) r.add('box',x+off,y+h/2,z+s*(d/2+.07),.17,h,.14,tint,4);
      r.add('box',x+s*(w/2+.04),y+1.33,z,.08,2.26,d-.21,tint,2);
      for (const oz of [-.92,-.23,.23,.92]) {
        r.add('cylinder',x+s*(w/2+.11),y+1.38,z+oz,.048,2.18,.048,0xb0b1a3,4);
        for (const j of [.44,1.27,2.17]) r.add('box',x+s*(w/2+.11),y+j,z+oz,.12,.09,.20,0x808780,4);
      }
      r.label(s>0?'A-17':'FREIGHT',x+s*.35,y+1.46,z+s*(d/2+.093),2.6,.65,WHITE,s===1?0:Math.PI);
    }
  }

  vehicle(x,z,tint,style=0,dir=1) {
    const r=this.r,w=style===2?4.90:4.38, d=style===2?1.96:1.70;
    const trim=0x959f9e, rubber=0x293438, glass=0x405e68;
    const p=(type,dx,y,dz,sx,sy,sz,c,k=2,opts={})=>r.add(type,x+dx*dir,y,z+dz*dir,sx,sy,sz,c,k,opts);
    this.obstacle(x,.76,z,w,1.48,d+.14);
    p('box',0,.39,0,w-.16,.28,d-.06,rubber,4);
    p('bevel',0,.65,0,w-.04,.45,d,tint,4);
    p('bevel',.40,.875,0,w-.86,.25,d-.10,tint,4);
    p('box',w/2-.57,.79,0,1.06,.20,d-.08,tint,4);
    p('box',-w/2+.54,.83,0,1.04,.27,d-.06,tint,2);
    for (const sign of [-1,1]) {
      p('box',sign*(w/2-.04),.46,0,.19,.17,d+.09,trim,4);
      p('box',sign*(w/2-.04),.66,0,.13,.25,d-.10,0x505b58,4);
      p('box',sign*(w/2+.06),.66,0,.021,.12,.33,0xddded3,0);
      for (const oz of [-.57,.57]) {
        p('box',sign*(w/2+.03),.735,oz,.045,.155,.31,sign>0?0xf5eacc:0xb33c2b,3);
        p('box',sign*(w/2+.06),.735,oz+.14,.04,.155,.08,0xe5a83b,2);
      }
      for (const ox of [-w*.315,w*.303]) {
        p('cylinder',ox,.38,sign*(d/2+.015),.71,.24,.71,rubber,2,{pitch:T});
        p('cylinder',ox,.38,sign*(d/2+.151),.49,.05,.49,0x6b7777,4,{pitch:T});
        p('cylinder',ox,.38,sign*(d/2+.183),.34,.026,.34,0xc3c7bf,4,{pitch:T});
        for (let j=0;j<5;j++) {
          const a=j/5*TAU;
          p('cylinder',ox+Math.sin(a)*.094,.38+Math.cos(a)*.094,sign*(d/2+.20),.037,.02,.037,0x757d78,4,{pitch:T});
        }
      }
      p('box',-.06,1.10,sign*(d/2-.12),1.66,.45,.05,glass,8);
      p('box',-.81,1.12,sign*(d/2-.12),.084,.50,.08,tint,4);
      p('box',-.13,1.14,sign*(d/2-.105),.073,.46,.07,tint,4);
      p('box',.73,1.12,sign*(d/2-.12),.088,.50,.08,tint,4);
      p('box',.57,.91,sign*(d/2-.025),.34,.049,.07,trim,4);
      p('box',.78,1.08,sign*(d/2+.13),.23,.16,.22,0x667774,4);
      p('box',0,.51,sign*(d/2+.03),1.72,.037,.038,0xa3b0a8,4);
    }
    p('bevel',-.07,1.39,0,1.65,.115,d-.22,tint,4);
    p('box',.76,1.15,0,d-.20,.50,.076,glass,8,{yaw:T,pitch:.42*dir});
    p('box',-.92,1.17,0,d-.24,.48,.08,glass,8,{yaw:T,pitch:-.35*dir});
    if (style===1) {
      p('box',-w/2+.57,.955,0,1.10,.12,d-.12,0x8c978a,4);
      for (const sign of [-1,1]) p('box',-w/2+.55,1.08,sign*(d/2-.09),1.2,.22,.12,tint,2);
    } else if (style===2) {
      p('box',-w/2+.76,1.16,0,1.47,.83,d-.07,0xd7d4bc,2);
      for (let i=0;i<5;i++) p('box',-w/2+.18+i*.28,1.22,d/2,.055,.68,.06,0xbebcab,2);
    }
  }

  shop(x,z,sign,w,h,d,tint,label,style,wear) {
    const r=this.r,front=z+sign*d/2, facing=sign===1?0:Math.PI;
    const entry=apartmentEntry(wear), kind=style===1?13:style===3?11:2;
    if (entry) buildApartmentEntry(this,entry,{x,front,sign,w,h,d,tint,kind});
    else this.solid(x,h/2,z,w,h,d,tint,kind);
    for (const ht of entry?[3.25,h-.2]:[.3,2.78,3.25,h-.2]) r.add('box',x,ht,front+sign*.065,w+.12,.13,.19,0xc3bdae,1);
    if (wear===22 || wear===29 || wear===30) {
      floorWeathering(r,wear,x,0,front+sign*.85,w-.5,1.38,0xb9b7ab);
    } else if (entry) {
      const half=(w-1.58)*.5;
      for (const side of [-1,1]) wallWeathering(r,wear,x+side*(w+1.58)*.25,.025,front+sign*.77,
        facing,half-.12,.49,entry.wall,Math.round(x*100));
    } else {
      wallWeathering(r,wear,x,.025,front,facing,w-.35,.49,tint,Math.round(x*100));
    }
    const base=0x626e68;
    if (!entry) r.add('box',x,1.48,front+sign*.08,w-.28,2.33,.17,base,2);
    const columns=Math.max(3,Math.round(w/1.48)), cell=(w-.44)/columns;
    for (let i=0;!entry && i<columns;i++) {
      const px=x-w/2+.22+(i+.5)*cell;
      r.add('box',px,1.41,front+sign*.187,cell-.15,1.9,.041,i%3===0?0x858a77:0x638389,8);
      r.add('box',px,2.38,front+sign*.215,cell-.07,.063,.08,0xb8beb5,4);
      r.add('box',px,.54,front+sign*.215,cell-.07,.081,.08,0x9da69a,4);
      r.add('box',px-cell/2+.065,1.47,front+sign*.227,.092,2.12,.11,0xbcc0b1,4);
      r.add('box',px,1.43,front+sign*.224,cell-.06,.052,.081,0xa3ad9e,4);
      if (i%3===1) r.add('box',px+.30,1.18,front+sign*.26,.052,.34,.083,0xd9dcd0,4);
    }
    const signColors=[0x447a74,0x9c503a,0x697e62,0x445c71,0x91643c];
    const signTint=signColors[Math.floor(this.rng()*signColors.length)];
    const signWidth=Math.min(w-.58,5.35);
    if (!entry) {
      r.add('box',x,3.02,front+sign*.24,signWidth,.45,.23,signTint,2);
      r.label(label,x,3.026,front+sign*.361,signWidth-.14,.45,WHITE,facing);
    }
    for (let j=0;!entry && j<Math.ceil(signWidth/.31);j++) {
      const px=x-signWidth/2+.15+j*.31;
      r.add('box',px,2.74,front+sign*.49,.302,.08,.91,j%2?0xf0e7d4:signTint,2,{pitch:sign*.16});
    }
    for (let row=0;3.89+row*2.36<h-.7;row++) {
      const ht=3.89+row*2.36;
      if (style===3 && row%2===1) continue;
      r.add('box',x,ht-.65,front+sign*.08,w+.10,.08,.19,0xa7a99e,1);
      for (let i=0;i<columns;i++) {
        const px=x-w/2+.22+(i+.5)*cell;
        r.add('box',px,ht,front+sign*.051,cell-.24,1.11,.11,0x7c8e8e,8);
        r.add('box',px,ht-.56,front+sign*.13,cell-.13,.075,.12,0xd5d3bf,1);
        r.add('box',px,ht,front+sign*.12,.055,1.08,.058,0xbcc7bd,4);
        if (style===0 && i%2===0) {
          r.add('box',px,ht-.67,front+sign*.49,cell-.13,.13,.91,0xb7b4a8,1);
          r.add('box',px,ht-.34,front+sign*.91,cell-.15,.54,.065,0x6e8782,8);
          r.add('box',px,ht-.066,front+sign*.91,cell-.10,.055,.073,0x8b9286,4);
          if (row%2===0) r.add('orb',px+.31,ht-.35,front+sign*.75,.31,.40,.27,0x759052,14);
        } else if (style===2) {
          r.add('box',px-cell*.46,ht+.04,front+sign*.19,.12,1.60,.24,0x8e9f96,4);
          if (i%2===1) r.add('box',px+.29,ht-.55,front+sign*.24,.38,.25,.28,0xc2c5b5,4);
        }
      }
    }
    r.add('box',x,h+.19,z,w+.35,.38,d+.36,0xb6b5a8,1);
    r.add('box',x+w*.22,h+.54,z-d*.20,1.25,.56,1.13,0xb4b9af,4);
    for (let k=0;k<4;k++) r.add('box',x+w*.22-.45+.30*k,h+.57,z-d*.20+.582,.09,.39,.05,0x5e7575,4);
    if (w>7.8) {
      const x0=x-w*.39;
      r.add('box',x0,h*.61,front+sign*.12,.18,h*.69,.19,0x83938e,4);
      r.add('box',x0+.20,h*.61,front+sign*.12,.09,h*.69,.14,0xb6b8a8,4);
    }
  }

  canopy() {
    const r=this.r;
    const tints=[0xe2e9e3,0xf2eee0,0xdbe4dd,0xd5e4e1,0xe8ded0];
    const arch=(x,k)=>{
      const t=k/10;
      return [x,12.95-3.35*Math.sin(t*Math.PI*.86)+.16*Math.cos(x*.19),-30.65+13.90*t];
    };
    for (let i=0;i<19;i++) {
      const x=-37.1+i*3.52;
      const dx=3.34;
      for (let j=0;j<10;j++) {
        const a=arch(x,j),b=arch(x,j+1), c=arch(x+dx,j),d=arch(x+dx,j+1);
        r.beam(a,b,.11,.15,0x657370,4);
        r.beam(c,d,.10,.13,0x657370,4);
        r.beam(a,c,.105,.11,0x73827f,4);
        for (let k=0;k<5;k++) {
          const px=x+.39+k*.63;
          const u=arch(px,j+.06),v=arch(px,j+.93);
          r.beam(u,v,.604,.045,tints[(i+j+k)%tints.length],0);
        }
      }
      r.beam([x,15.55,-31.1],arch(x,8),.07,.07,0x85928b,4);
      r.beam([x,15.48,-31.14],arch(x,3),.075,.075,0x85928b,4);
      r.add('box',x,14.45,-31.2,.19,2.45,.22,0x838b7f,4);
    }
  }

  highway() {
    const r=this.r;
    const x=10.9,w=8.4,y=12.24;
    // The deck runs from the north wall of fronts to the approach ramp.
    const north=-40.75, south=44.05, mid=(north+south)/2, run=south-north;
    this.solid(x,y,mid,w,.86,run,0xa0a5a0,1);
    for (const side of [-1,1]) {
      this.solid(x+side*w/2,y+.68,mid,.52,.74,run+.12,0xc7c5b8,1);
      r.add('box',x+side*(w/2-.2),y-.42,mid,.56,.47,run+.14,0x86918d,4);
      r.add('box',x+side*3.08,y-.49,mid,.28,.38,run-.2,0x697874,4);
      for (let z=north+1.6;z<43;z+=2.65) r.add('box',x+side*(w/2+.023),y+.77,z,.61,.24,.21,0xbfc6bd,2);
    }
    this.solid(x,y+.68,north+.13,w,.74,.26,0xc7c5b8,1);
    for (let z=north+1.6;z<43;z+=3.4) r.add('box',x,y-.50,z,w-.29,.29,.21,0x74817b,4);
    for (const z of [-33.3,-14.4,13.85,31.25]) {
      this.solid(x,5.87,z,1.62,11.74,1.67,0xa7aaa0,1);
      r.add('box',x,.26,z,2.21,.52,2.09,0xb4b5a8,1);
      r.add('box',x,10.53,z,1.98,.82,1.98,0x8d9690,1);
      r.add('box',x,11.56,z,7.88,.64,1.59,0x8d9891,4);
      for (let j=0;j<4;j++) r.add('box',x-2.7+j*1.8,11.85,z,.39,.28,1.34,0x5e6c68,4);
    }
    for (const z of [-17,-5,7,19]) {
      r.add('box',x,y-.65,z,2.08,.13,.34,0x626f6c,4);
      r.add('box',x,y-.723,z,1.85,.02,.24,0xe8e8d4,0);
    }
    const walkY=8.3,z=17.6;
    r.add('box',8.8,walkY,z,36,.45,3.55,0x89978e,4);
    for (const sign of [-1,1]) {
      r.add('box',8.8,walkY+.86,z+sign*1.77,36.12,.21,.11,0x8d9f99,4);
      r.add('box',8.8,walkY+.52,z+sign*1.74,36.10,.072,.083,0x99a7a0,4);
      for (let x=-9;x<26.8;x+=1.35) r.add('box',x,walkY+.57,z+sign*1.73,.080,.81,.094,0x859790,4);
      r.beam([-9,walkY-.42,z+sign*1.53],[26.8,walkY-.42,z+sign*1.53],.16,.20,0x697b74,4);
      for (let x=-9;x<23;x+=3.8) r.beam([x,walkY+.16,z+sign*1.59],[x+3.8,walkY-.60,z+sign*1.59],.105,.115,0x758680,4);
    }
    for (const px of [-8.4,26.5]) {
      this.solid(px,4.0,z,.86,8.02,.99,0xa6ada1,1);
      r.add('box',px,.16,z,1.35,.32,1.44,0xbcbfb1,1);
    }
  }

  streetDetails() {
    const r=this.r;
    for (const x of [-25.92,19.1]) {
      for (const side of [-1,1]) {
        const z=side*7.93;
        r.add('box',x,.09,z,.46,.18,.43,0xa5aaa0,1);
        r.add('cylinder',x,2.05,z,.12,4.1,.12,0x717c73,4);
        r.beam([x,3.85,z],[x,3.85,z-side*1.52],.095,.10,0x79837a,4);
        const front=x+(x<0?.105:-.105), yaw=x<0?T:-T;
        r.add('box',x,3.56,z-side*1.44,.23,.74,.32,0x545d56,4);
        for (const [level,tint] of [[.23,0x9d5943],[0,0xd2b462],[-.23,0x698778]]) {
          r.add('cylinder',front,3.56+level,z-side*1.44,.151,.068,.151,tint,8,{basis:[[0,0,1],[1,0,0],[0,1,0]]});
        }
        r.add('box',x,2.32,z,.20,.34,.26,0x5f6d65,4);
        r.add('box',x+(x<0?.08:-.08),2.26,z,.06,.14,.13,0xe4cab1,0);
        r.add('box',x,4.02,z-side*.65,.15,.24,1.13,0x5c7b6d,2);
        r.label('ROUTE 07',x+(x<0?.077:-.077),4.02,z-side*.65,1.08,.22,WHITE,yaw);
        for (let i=0;i<12;i++) {
          const px=x-.72+(i%6)*.245,pz=side*(7.69+Math.floor(i/6)*.17);
          for (const j of [-.037,.037]) r.add('cylinder',px+j,.11,pz,.057,.021,.056,0xc4ac6b,4);
        }
      }
    }
    for (const x of [-29.8,-23.5,-6.9,7.0,16.0,27.9]) for (const sign of [-1,1]) {
      const z=sign*7.31;
      r.add('box',x,.011,z,.72,.013,.35,0x65726d,4);
      for (let j=0;j<8;j++) r.add('box',x-.29+.082*j,.021,z,.033,.014,.29,0xa1a99c,4);
    }
    for (const [x,z] of [[-33.5,-20.6],[-18.6,-10.1],[-8.4,-19.3],[13.4,7.8],[22.5,19.1],[32.6,7.9]]) {
      for (let j=0;j<3;j++) {
        const px=x+j*.44;
        r.add('box',px,.035,z,.30,.07,.30,0x555f5b,2);
        r.add('taper',px,.26,z,.236,.40,.236,0xd98842,2);
        r.add('cylinder',px,.29,z,.196,.075,.196,0xe4dbb6,2);
      }
    }
    for (const [x,z,side] of [[-34,-20.46,1],[-9.7,-20.25,1],[1.9,21.37,-1],[21.6,-20.48,1],[35.8,20.99,-1]]) {
      r.add('box',x,.38,z,1.04,.76,.39,0x7c8981,4);
      r.add('box',x,.68,z+side*.215,.94,.062,.028,0xb4b9a9,4);
      r.add('box',x,.39,z+side*.216,.045,.49,.041,0x626f65,4);
      r.add('box',x+.29,.41,z+side*.214,.12,.058,.042,0xb5bbb0,4);
      r.add('box',x-.29,.41,z+side*.214,.12,.058,.042,0xb5bbb0,4);
      for (let j=0;j<6;j++) r.add('box',x-.37+j*.145,.23,z+side*.216,.082,.035,.042,0x56655c,4);
      r.label('P-02',x,.57,z+side*.247,.58,.16,0xe5e6d4,side===1?0:Math.PI);
    }
    for (const side of [-1,1]) {
      const z=side*4.73;
      r.beam([-4.51,1.84,z],[4.51,1.84,z],.11,.13,0x838f84,4);
      for (let i=0;i<7;i++) {
        const x=-3.98+i*1.32;
        r.add('box',x,.88,z,.18,1.69,.13,0xa9afa0,4);
        r.add('box',x,.48,z+side*.09,.29,.16,.12,0x8c988a,4);
      }
      for (const sign of [-1,1]) {
        r.add('box',sign*4.55,2.445,z-side*.50,.33,.04,1.16,0xd3b46f,1);
        r.add('box',sign*4.55,2.445,z-side*1.77,.33,.04,1.16,0xd3b46f,1);
      }
    }
  }

  tree(x,z,height,tint) {
    const r=this.r;
    this.solid(x,.27,z,1.84,.54,1.57,0xc7bc9f,1);
    r.add('bevel',x,.56,z,1.93,.20,1.69,0xdecfa9,1);
    r.add('box',x,.67,z,1.63,.045,1.42,0x776c50,13);
    r.add('taper',x,height*.38,z,.34,height*.66,.32,0x8a7256,13);
    for (let i=0;i<9;i++) {
      const a=i*2.399, drift=.37+this.rng()*.69, y=height*(.68+this.rng()*.32);
      const branch=[x+Math.cos(a)*drift,y,z+Math.sin(a)*drift];
      r.beam([x,height*.46,z],branch,.082,.081,0x8b785a,13);
      r.add('orb',...branch,1.33+this.rng()*.98,1.04+this.rng()*.87,1.42+this.rng()*.76,i%3===0?0x96ad5d:tint,14);
    }
  }

  districts() {
    const r=this.r;
    for (const sign of [-1,1]) {
      const z=sign*24.8;
      r.add('box',0,-.026,z,111,.072,8.9,sign<0?0xa5a298:0xbab19c,sign<0?5:1);
      r.add('box',0,.036,z+sign*4.40,111,.072,.18,0xded4b7,1);
      for (let x=-52;x<=52;x+=4.0) {
        r.add('box',x,.021,z,1.67,.018,.080,0xe5dcc3,1);
        r.add('box',x,.033,z+sign*4.2,3.85,.023,.071,0xb2985e,1);
      }
      for (const x of [-48,-38,-25,-11,4,23,38,48]) this.pole(x,z+sign*4.31,4.56,-sign);
    }
    this.deck(-10.9,8.8,-29.7,-22.7,1.08,0xd4d6c2);
    this.ramp(-16.0,-10.9,-28.1,-23.2,0,1.08,'x',0xc5c9b6);
    this.ramp(8.8,13.9,-28.1,-23.2,1.08,0,'x',0xc5c9b6);
    this.rail([-10.9,1.08,-29.62],[8.8,1.08,-29.62],0x718782,13);
    r.add('box',-1.0,4.1,-26.2,17.8,.16,5.2,0xc2d6cf,8);
    for (const x of [-9.3,-3.9,2.1,7.2]) {
      for (const z of [-28.6,-24.0]) {
        this.solid(x,2.58,z,.18,3.0,.18,0x6a7b72,4);
        r.beam([x,3.93,z],[x+.64,4.05,z+.38],.09,.09,0x6b8e83,4);
      }
      r.add('box',x,4.16,-26.25,.16,.17,5.25,0x7c9a92,4);
      r.add('box',x,1.64,-28.1,1.86,.12,.51,0x987a53,13);
      for (const dx of [-.7,.7]) r.add('box',x+dx,1.35,-28.1,.10,.50,.34,0x7c8479,4);
    }
    r.add('box',-1.0,3.52,-23.92,9.0,.61,.17,0x39766e,2);
    r.label('METRO',-1.0,3.52,-23.815,7.2,.55,WHITE);
    r.label('NORTH LINE',-1.0,1.02,-22.665,9.2,.39,0x527269);

    for (const [x,z,tint] of [[-37,24.4,0xa65d42],[-22,26.2,0x7c8c59],[-7,27.0,0xa98548],[8.4,24.9,0x648489],[23.2,26.5,0xa9664d],[41.9,23.9,0x6e8d78]]) {
      this.kiosk(x,z,-1,tint,'MARKET');
      const front=z-1.76;
      r.add('box',x,2.53,front,3.62,.14,1.62,tint,2,{pitch:-.13});
      for (let i=0;i<10;i++) r.add('box',x-1.64+i*.36,2.54,front,.18,.145,1.59,0xf0e7ce,0,{pitch:-.13});
      for (const dx of [-1.68,1.68]) {
        r.add('cylinder',x+dx,1.19,front-.71,.095,2.38,.095,0x76847a,4);
        r.add('bevel',x+dx*.69,.28,front+.12,.52,.54,.45,0x9e8e63,13);
      }
    }
    for (const [x,z,h,t] of [[-41,-19,4.3,0x7d9a56],[-29,-25,5.1,0x809756],[21,-27.9,4.1,0x6d9452],[40,-23.2,5.5,0x729c57],[-45,16,5.0,0x809953],[-17,21.7,4.3,0x719253],[0,20.2,4.4,0x7c9b5a],[17.9,21.8,5.2,0x809a52],[45,17,5.3,0x789656]]) this.tree(x,z,h,t);
    for (const [x,z,w] of [[-45,-16,3.1],[-35,-27,4.0],[31,-20,4.1],[43,-11,3.5],[-41,16.45,4.2],[-32,29.4,3.6],[27,21.7,3.3],[39,14.3,3.45]]) this.barrier(x,z,w,.71);
    this.vehicle(-43.8,4.86,0xd8b589,1,1);
    this.vehicle(-37.5,-5.22,0x688f86,0,1);
    this.vehicle(38.1,5.29,0x9f654a,0,-1);
    this.vehicle(44.4,-4.72,0x809299,2,-1);
    this.vehicle(-36.9,-25.43,0xcda671,0,-1);
    this.vehicle(33.7,-24.58,0x758988,2,1);
    for (const [x,z] of [[-37,-9.2],[-23.6,-19.1],[25.1,-19.7],[41,10.6],[-43,10.7],[-28,18.7]]) {
      for (let j=0;j<3;j++) {
        r.add('cylinder',x+j*.54,.43,z,.15,.86,.15,0x69736c,4);
        r.add('cylinder',x+j*.54,.65,z,.158,.13,.158,0xc4ad61,2);
      }
    }
    for (const [x,z,tint,label] of [[-33.5,-19,0x487c73,'NORTH LINE'],[33.5,18.4,0x986341,'MARKET'],[-29,19.4,0x986341,'MARKET']]) {
      r.add('box',x,1.49,z,.13,2.98,.15,0x6c796d,4);
      r.add('box',x,2.48,z,2.58,.46,.13,tint,2);
      r.label(label,x,2.48,z+.078,2.46,.41,WHITE);
      r.label(label,x,2.48,z-.078,2.46,.41,WHITE,Math.PI);
    }
  }

  build() {
    const r=this.r, R=this.rng;
    // Ground only inside the ring of fronts (and under the approach lane).
    const [ring,lane]=ENCLOSURE;
    cutStairOpenings(r,(ring.x0+ring.x1)/2,-.26,(ring.z0+ring.z1)/2,ring.x1-ring.x0,.52,ring.z1-ring.z0,0xb9b7ab,1);
    r.add('box',(lane.x0+lane.x1)/2,-.26,(ring.z1+lane.z1)/2,lane.x1-lane.x0,.52,lane.z1-ring.z1,0xb9b7ab,1);
    r.add('box',0,-.15,0,114,.306,15.15,0x777e7b,5);
    for (const side of [-1,1]) {
      r.add('box',0,.051,side*7.77,113.5,.1,.44,0xd7d3bf,1);
      cutStairOpenings(r,0,.029,side*9.44,113.5,.052,2.80,0xc5c6b7,1);
      for (let x=-54;x<=54;x+=3.1) {
        r.add('box',x,.012,side*7.43,2.98,.013,.095,0xe9d9a9,22,{layer:0});
        r.add('box',x,.013,side*9.44,.032,.012,2.7,0xa1a6a0,1);
      }
      for (const x of [-48,-36,-25,-13,0,13,25,36,48]) this.pole(x,side*9.3,5.1,-side);
    }
    for (let x=-54;x<=54;x+=4.5) r.add('box',x,.013,.03,2.7,.012,.13,0xf2dd9c,22,{layer:0});
    for (const x of [-24.3,20.7]) {
      for (let z=-6.72;z<7;z+=.89) r.add('box',x,.015,z,2.55,.017,.54,0xded398,22,{layer:0});
      for (const sign of [-1,1]) r.add('box',x+sign*1.65,.016,0,.085,.018,14.48,0xddd5b2,22,{layer:0});
    }
    for (let i=0;i<35;i++) {
      const x=-53+R()*106,z=(R()>.5?1:-1)*(2+R()*27.0);
      const capWidth=.45+R()*.2, capDepth=.45+R()*.2;
      if (stairAt(x,z,.32)) continue;
      r.add('cylinder',x,.010,z,capWidth,.015,capDepth,0x6d7775,4);
      r.add('cylinder',x,.018,z,.30,.013,.30,0x808781,4);
    }
    for (const side of [-1,1]) {
      const x=side*SPAWN_X;
      r.add('cylinder',x,.008,0,5.5,.016,5.5,side<0?0x509d92:0xbd7d56,5);
      r.add('cylinder',x,.015,0,4.95,.017,4.95,0x758483,5);
      r.label('07',x,.029,0,2.5,1.75,WHITE,side<0?T:-T,-T);
      for (let j=0;j<8;j++) {
        const a=j/8*TAU;
        r.add('box',x+Math.cos(a)*2.83,.023,Math.sin(a)*2.83,.36,.032,.12,side<0?0x58b1a5:0xc28c62,2,{yaw:-a});
      }
    }
    this.deck(-4.6,4.6,-4.65,4.65,2.42,0xc5c8bb);
    this.ramp(-12.2,-4.6,-2.65,2.65,0,2.42,'x',0xbcc2b4);
    this.ramp(4.6,12.2,-2.65,2.65,2.42,0,'x',0xbcc2b4);
    for (const sign of [-1,1]) {
      this.rail([-4.55,2.42,sign*4.62],[4.55,2.42,sign*4.62],0x67837b,6);
      this.rail([-12.15,0,sign*2.65],[-4.65,2.41,sign*2.65],0x81978c,5);
      this.rail([4.65,2.41,sign*2.65],[12.15,0,sign*2.65],0x81978c,5);
      this.obstacle(0,2.86,sign*4.62,9.20,.85,.11,false);
      r.add('box',0,1.11,sign*4.661,7.55,.64,.14,0x54776b,2);
      r.label('07 / CENTRAL',0,1.12,sign*4.738,4.40,.59,WHITE,sign===1?0:Math.PI);
      r.add('box',0,.21,sign*4.71,9.45,.37,.19,0x929b91,4);
    }
    this.barrier(-1.3,-2.3,2.30,.57,0xc4c6b4,2.42);
    this.barrier(1.4,2.50,2.5,.56,0xc4c6b4,2.42);
    this.deck(-28.8,-20.5,-18.3,-11.2,1.16,0xc5c2b0);
    this.ramp(-28.8,-20.5,-11.2,-7.6,1.16,0,'z',0xc5c2b0);
    this.deck(20.5,29.2,11.3,18.35,1.16,0xc5c2b0);
    this.ramp(20.5,29.2,7.65,11.3,0,1.16,'z',0xc5c2b0);
    this.rail([-28.75,1.16,-18.24],[-20.55,1.16,-18.24],0x7b8981,6);
    this.rail([20.55,1.16,18.28],[29.16,1.16,18.28],0x7b8981,6);

    this.container(-14.3,-13.4,0x688e89);
    this.container(15.0,12.1,0xa97550,6.0,2.49);
    this.container(-15.0,15.3,0x89916b,5.50,2.65);
    this.container(19.45,-15.65,0x8a9fa4,5.72,2.52);
    this.container(-24.1,-15.6,0xbda77d,5.40,2.46,1.16);
    this.container(25.75,14.96,0x708b87,5.48,2.36,1.16);
    this.vehicle(-17.85,-3.80,0x60988b,1,1);
    this.vehicle(17.20,4.32,0xa66b57,0,-1);
    this.vehicle(-25.2,13.3,0xa7a28b,2,1);
    this.vehicle(7.5,-11.56,0x869b9d,0,1);
    this.vehicle(32.2,-17.15,0xb88d63,1,-1);
    this.vehicle(33.8,16.2,0x778794,0,1);
    this.vehicle(-34.5,-16.0,0x8e9f86,0,1);
    this.kiosk(-3.8,-16.58,1,0x9d8263,'COFFEE');
    this.kiosk(3.4,16.1,-1,0x66877e,'KIOSK');
    for (const [x,z,w] of [[-12,8.9,4.5],[12,-7.8,4.8],[-20.6,17.8,3.0],[22.4,-10.1,2.55],[-1.6,-11.4,3.3],[.9,10.2,3.75]]) this.barrier(x,z,w);
    for (const [x,z] of [[-32,7.8],[-6,9.4],[15.6,-9.5],[30,-9.0],[-33,-9.1],[-1,-18.8],[4,20]]) {
      const tint=R()>.5?0xac9c78:0x96a7a0;
      this.solid(x,.33,z,1.55,.66,.82,tint,1);
      r.add('box',x,.67,z,1.60,.13,.87,0xaca38f,1);
      r.add('box',x,.73,z,1.39,.043,.66,0x75705d,1);
      for (let i=0;i<13;i++) {
        const px=x-.61+R()*1.22,pz=z-.26+R()*.52;
        r.add('orb',px,.81+R()*.28,pz,.30+R()*.18,.25+R()*.31,.31,[.30+R()*.23,.44+R()*.24,.29+R()*.16],14);
      }
    }
    this.highway();
    buildElevatedApproach(this);

    const labels=['REPAIR','24H MARKET','SERVICE BAY','GARAGE','CITY WORKS','METRO','WORKSHOP','DELIVERY','WAREHOUSE','PARKING'];
    for (const sign of [-1,1]) {
      let x=-56;
      for (let i=0;i<15;i++) {
        const w=6.3+R()*2.5, d=4.6+R()*2.5, h=(sign===-1?12.0:8.0)+R()*7.3;
        const entry= i===4 || i===10 ? 3.4 : .35+R()*.8;
        const underRoad=x<15.7 && x+w>6.2;
        this.shop(x+w/2,sign*(31.9+d/2+R()*1.3),-sign,w-entry,underRoad?Math.min(h,10.74):h,d,panelColors[i%panelColors.length],labels[(i+(sign===1?4:0))%labels.length],(i+(sign===1?1:0))%4,i+1+(sign===1?15:0));
        x+=w;
      }
    }
    this.canopy();
    this.streetDetails();
    this.districts();
    buildStreetFacilities(this);
    buildBreakableBlocks(this);
    floorWeathering(r,41,-46,.013,25.7,3.0,1.24,0xbab19c);
    floorWeathering(r,42,42,0,-12.7,2.8,1.43,0xb9b7ab);
    wallWeathering(r,43,0,.80,4.742,0,5.4,.56,0x54776b);
    floorWeathering(r,44,35,.102,7.77,4.2,.39,0xd7d3bf);
    floorWeathering(r,45,-14,0,12.7,4.7,1.9,0xb9b7ab);
    // The city ends at a thin ring of building fronts; nothing stands beyond it.
    buildEnclosure(this);
    for (const side of [-1,1]) {
      for (const sign of [-1,1]) {
        r.add('box',side*55.1,.64,sign*15.23,.43,1.28,14.6,0xa6a99d,1);
        this.rail([side*55.1,1.27,sign*8.0],[side*55.1,1.27,sign*22.3],0x879592,8);
        r.add('box',side*55.6,2.5,sign*6.9,.25,5.0,.25,0x87938b,4);
      }
      r.add('box',side*55.6,4.25,0,.22,.38,13.75,0x809086,4);
      r.add('box',side*55.47,3.87,0,.18,.86,3.71,0x528274,2);
      r.label('ROUTE 07',side*55.36,3.88,0,3.45,.78,WHITE,side>0?-T:T);
    }
    for (const [a,b] of [[[-37,6.9,9.5],[-20,6.7,-20.9]],[[-20,6.7,-20.9],[4,9.6,-20.8]],[[-37,9.7,-22],[36,9.1,-22]],[[12.8,12.8,-24],[30,8.0,19.9]]]) {
      const cable=(t)=>[mix(a[0],b[0],t),mix(a[1],b[1],t)-Math.sin(t*Math.PI)*.62,mix(a[2],b[2],t)];
      for (let j=0;j<12;j++) r.beam(cable(j/12),cable((j+1)/12),.031,.034,0x525e59,4);
    }
    r.add('box',-57.2,.07,1.5,4.9,.17,11.3,0x8d9b93,1);
    r.add('box',57.2,.07,1.5,4.9,.17,11.3,0x8d9b93,1);
  }
}
