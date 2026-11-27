import {TAU,add,clamp,scale,sub,mix} from './render.js';

import {BOUNDS,CITY_RADIUS,METRO,RAIL,UNDER_X,UNDER_Y,ZONES,cityExit,floorBounds,inCity,isUnder,localX,railEnd,sameLevel,zoneOf} from './layout.js';
import {buildRail,buildUnderground,railLoopSites} from './levels.js';
import {buildMetro,buildCabin} from './metro-stage.js';
import {buildStairs,cutStairOpenings,stairAt,stairCrossing,stairFloor,stairFloorY} from './stairs.js';
import {Geometry} from './collision.js';
import {buildResidentialDistrict,residentialLot} from './residential.js';
import {buildStreetFacilities} from './street-facilities.js';
import {floorWeathering,wallWeathering} from './weathering.js';
import {apartmentEntry,buildApartmentEntry} from './apartment-entries.js';
import {buildBreakableBlocks,prepareStageObjects} from './stage-objects.js';
import {APPROACH_LOT,buildElevatedApproach,buildOuterCity} from './outer-city.js';

export {BOUNDS};
export const SPAWN_X = 47.0;
export const TEAM = [0x09bfa9,0xf06b2c];
export const TEAM_INK = [0x10d8be,0xff6c33];
const STEEL = 0x77818a, WHITE = 0xf0eee0;
const CELL = 5, INV_CELL = 1/CELL, UNDER_CELL_X = Math.round(UNDER_X/CELL);
const T = Math.PI / 2;
const ZONE_FLOORS = ZONES.map(({y,layer})=>Object.freeze({y,layer}));
const panelColors = [0xcebba2,0xaab6b1,0xc7c5af,0xb9c7cb,0xe1d0b7,0xd2bfaf,0xa2b4bc];

export function randomGenerator(seed) {
  const next=() => {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    return seed / 4294967296;
  };
  next.state=()=>seed;
  return next;
}

const _rayBoxHit={t:0,axis:1,sign:1};

function rayBoxInto(sx,sy,sz,dx,dy,dz,box,limit,out) {
  let near=0, far=limit, axis=1, sign=1;
  const x0=box.x0??box.min[0], x1=box.x1??box.max[0];
  if (dx>-.00001 && dx<.00001) {
    if (sx<x0 || sx>x1) return false;
  } else {
    const inv=1/dx, u=(x0-sx)*inv, w=(x1-sx)*inv;
    const enter=u<w?u:w, leave=u<w?w:u;
    if (enter>near) {near=enter;axis=0;sign=u<w?-1:1;}
    if (leave<far) far=leave;
    if (far<near) return false;
  }
  const y0=box.y0??box.min[1], y1=box.y1??box.max[1];
  if (dy>-.00001 && dy<.00001) {
    if (sy<y0 || sy>y1) return false;
  } else {
    const inv=1/dy, u=(y0-sy)*inv, w=(y1-sy)*inv;
    const enter=u<w?u:w, leave=u<w?w:u;
    if (enter>near) {near=enter;axis=1;sign=u<w?-1:1;}
    if (leave<far) far=leave;
    if (far<near) return false;
  }
  const z0=box.z0??box.min[2], z1=box.z1??box.max[2];
  if (dz>-.00001 && dz<.00001) {
    if (sz<z0 || sz>z1) return false;
  } else {
    const inv=1/dz, u=(z0-sz)*inv, w=(z1-sz)*inv;
    const enter=u<w?u:w, leave=u<w?w:u;
    if (enter>near) {near=enter;axis=2;sign=u<w?-1:1;}
    if (leave<far) far=leave;
    if (far<near) return false;
  }
  out.t=near; out.axis=axis; out.sign=sign;
  return true;
}

export function rayBox(start,delta,box) {
  if (!rayBoxInto(start[0],start[1],start[2],delta[0],delta[1],delta[2],box,1,_rayBoxHit)) return null;
  const normal = [0,0,0];
  normal[_rayBoxHit.axis] = _rayBoxHit.sign;
  return {t:_rayBoxHit.t,normal};
}

let _WORLD_BLUEPRINT=null;
let _NEXT_BLUEPRINT_ID=1;

function cloneOpts(opts) {
  if (!opts) return undefined;
  const b=opts.basis;
  if (b) {
    return {
      ...opts,
      basis:[[b[0][0],b[0][1],b[0][2]],[b[1][0],b[1][1],b[1][2]],[b[2][0],b[2][1],b[2][2]]]
    };
  }
  for (const _ in opts) return {...opts};
  return undefined;
}

function buildWorldBlueprint() {
  const addZone=[], addType=[], addX=[], addY=[], addZ=[], addW=[], addH=[], addD=[], addTint=[], addKind=[], addOpts=[];
  const labels=[];
  const rec={
    zone:0,
    add(type,x,y,z,w,h,d,tint,kind,opts) {
      addZone.push(this.zone);
      addType.push(type);
      addX.push(x); addY.push(y); addZ.push(z);
      addW.push(w); addH.push(h); addD.push(d);
      addTint.push(Array.isArray(tint)?[tint[0],tint[1],tint[2]]:(tint??0));
      addKind.push(kind===undefined?0:kind);
      addOpts.push(cloneOpts(opts));
    },
    label(name,x,y,z,w,h,tint,yaw,pitch,opts) {
      labels.push([this.zone,name,x,y,z,w,h,Array.isArray(tint)?[tint[0],tint[1],tint[2]]:tint,yaw,pitch,cloneOpts(opts)]);
    },
    beam() {},
    seal() {}
  };
  const bp=Object.create(World.prototype);
  bp.geometry=new Geometry();
  bp.r=bp.geometry.track(rec);
  bp.solids=[];
  bp.slabs=[];
  bp.towerSites=[APPROACH_LOT];
  bp.homes=[];
  bp.elevated=[];
  bp.objects=[];
  bp.vehicleDefs=[];
  bp.destructibles=[];
  bp._destructibleIds=new Set();
  bp.rng=randomGenerator(784301);
  bp.build();
  buildRail(bp);
  buildStairs(bp,0);
  bp.sealAlleys();
  rec.zone=1;
  buildUnderground(bp);
  buildMetro(bp);
  buildStairs(bp,1);
  rec.zone=2;
  buildCabin(bp,METRO);
  rec.zone=3;
  buildCabin(bp,RAIL);
  rec.zone=0;
  bp.stageParts=prepareStageObjects(bp.objects);
  bp.indexSolids();
  const solidIndex=new Map();
  for (let i=0;i<bp.solids.length;i++) solidIndex.set(bp.solids[i],i);
  const destructibleTemplates=bp.destructibles.map(def=>{
    const solidIndices=def.solids?def.solids.map(s=>solidIndex.get(s)??-1):null;
    const obstacleIndices=def.obstacles?def.obstacles.map(s=>solidIndex.get(s)??-1):null;
    return {def,solidIndices,obstacleIndices};
  });
  return {
    id:_NEXT_BLUEPRINT_ID++,
    geometry:bp.geometry,
    solids:bp.solids,
    boxes:bp._boxes,
    grid0:bp.grid0,
    grid1:bp.grid1,
    collisionGrid:bp.collisionGrid,
    slabs:bp.slabs,
    zoneSlabs:bp.zoneSlabs,
    slabBounds:bp.slabBounds,
    zoneMaxFloorY:bp.zoneMaxFloorY,
    towerSites:bp.towerSites,
    homes:bp.homes,
    elevated:bp.elevated,
    elevatedList:bp.elevatedList,
    elevX0:bp.elevX0, elevX1:bp.elevX1, elevZ0:bp.elevZ0, elevZ1:bp.elevZ1,
    objects:bp.objects,
    vehicleDefs:bp.vehicleDefs,
    stageParts:bp.stageParts,
    destructibleTemplates,
    rngState:bp.rng.state(),
    addCount:addType.length,
    addZone:Uint8Array.from(addZone),
    addType,
    addX:Float64Array.from(addX),
    addY:Float64Array.from(addY),
    addZ:Float64Array.from(addZ),
    addW:Float64Array.from(addW),
    addH:Float64Array.from(addH),
    addD:Float64Array.from(addD),
    addTint,
    addKind:Uint8Array.from(addKind),
    addOpts,
    labels
  };
}

export class World {
  constructor(renderer,scene=null) {
    if (!scene) {
      if (!_WORLD_BLUEPRINT) _WORLD_BLUEPRINT=buildWorldBlueprint();
      this._initFromBlueprint(_WORLD_BLUEPRINT,renderer);
      return;
    }
    this._blueprintId=0;
    this._solidsVersion=0;
    this._solidDisabled=null;
    this._solidSeen=null;
    this._boxes=null;
    this.geometry=new Geometry();
    this.r=this.geometry.track(renderer);
    this.solids=scene.solids ?? [];
    this.slabs=scene.slabs ?? [];
    this.towerSites=[APPROACH_LOT];
    this.homes=scene.homes ?? [];
    this.elevated=scene.elevated ?? [];
    this.objects=scene.objects ?? [];
    this.vehicleDefs=scene.vehicles ?? [];
    this.destructibles=[];
    this._destructibleIds=new Set();
    this.rng=randomGenerator(784301);
    this.loadParts(this.r,scene.parts);
    renderer.zone=0;
    this.stageParts=prepareStageObjects(this.objects);
    this.indexSolids();
    this.buildBakedDestructibles();
    renderer.seal();
    this.r=renderer;
  }

  _initFromBlueprint(bp,renderer) {
    this._blueprintId=bp.id;
    this._solidsVersion=0;
    this.geometry=Geometry.fromBlueprint(bp.geometry);
    const nSolids=bp.solids.length;
    const solids=new Array(nSolids);
    const srcSolids=bp.solids;
    for (let i=0;i<nSolids;i++) {
      const s=srcSolids[i];
      solids[i]={min:s.min,max:s.max,ray:s.ray,paintLayer:s.paintLayer,_idx:i};
    }
    this.solids=solids;
    this._boxes=bp.boxes;
    this._solidBoxes=null;
    this._solidDisabled=null;
    this._solidSeen=new Int32Array(nSolids);
    this._traceSeq=0;
    this.grid0=bp.grid0;
    this.grid1=bp.grid1;
    this.collisionGrid=bp.collisionGrid;
    this.slabs=bp.slabs;
    this.zoneSlabs=bp.zoneSlabs;
    this.slabBounds=bp.slabBounds;
    this.zoneMaxFloorY=bp.zoneMaxFloorY;
    this.towerSites=bp.towerSites;
    this.homes=bp.homes;
    this.elevated=bp.elevated;
    this.elevatedList=bp.elevatedList;
    this.elevX0=bp.elevX0; this.elevX1=bp.elevX1; this.elevZ0=bp.elevZ0; this.elevZ1=bp.elevZ1;
    this.objects=bp.objects;
    this.vehicleDefs=bp.vehicleDefs;
    this.stageParts=bp.stageParts;
    const dTpl=bp.destructibleTemplates, dLen=dTpl.length;
    const destructibles=new Array(dLen);
    for (let i=0;i<dLen;i++) {
      const {def,solidIndices,obstacleIndices}=dTpl[i];
      const copy={...def};
      if (solidIndices) {
        const arr=new Array(solidIndices.length);
        for (let j=0;j<solidIndices.length;j++) arr[j]=solidIndices[j]>=0?solids[solidIndices[j]]:def.solids[j];
        copy.solids=arr;
      }
      if (obstacleIndices) {
        const arr=new Array(obstacleIndices.length);
        for (let j=0;j<obstacleIndices.length;j++) arr[j]=obstacleIndices[j]>=0?solids[obstacleIndices[j]]:def.obstacles[j];
        copy.obstacles=arr;
      }
      destructibles[i]=copy;
    }
    this.destructibles=destructibles;
    this._destructibleIds=null;
    this.rng=randomGenerator(bp.rngState);
    const n=bp.addCount;
    const addZone=bp.addZone, addType=bp.addType, addX=bp.addX, addY=bp.addY, addZ=bp.addZ;
    const addW=bp.addW, addH=bp.addH, addD=bp.addD, addTint=bp.addTint, addKind=bp.addKind, addOpts=bp.addOpts;
    let curZone=-1;
    for (let i=0;i<n;i++) {
      const z=addZone[i];
      if (z!==curZone) {renderer.zone=z; curZone=z;}
      renderer.add(addType[i],addX[i],addY[i],addZ[i],addW[i],addH[i],addD[i],addTint[i],addKind[i],addOpts[i]);
    }
    const labels=bp.labels;
    for (let i=0;i<labels.length;i++) {
      const l=labels[i];
      if (l[0]!==curZone) {renderer.zone=l[0]; curZone=l[0];}
      renderer.label(l[1],l[2],l[3],l[4],l[5],l[6],l[7],l[8],l[9],l[10]);
    }
    renderer.zone=0;
    renderer.seal();
    this.r=renderer;
  }

  registerDestructible(def) {
    if (!def) return def;
    if (!this._destructibleIds) {
      this._destructibleIds=new Set();
      for (let i=0;i<this.destructibles.length;i++) this._destructibleIds.add(this.destructibles[i].id);
    }
    if (this._destructibleIds.has(def.id)) return def;
    this._destructibleIds.add(def.id);
    this.destructibles.push(def);
    return def;
  }

  buildBakedDestructibles() {
    for (let i=0;i<this.solids.length;i++) {
      const s=this.solids[i];
      if (!s || zoneOf(s.min[0])!==0) continue;
      const w=s.max[0]-s.min[0], h=s.max[1]-s.min[1], d=s.max[2]-s.min[2];
      const cx=(s.min[0]+s.max[0])*.5, cy=(s.min[1]+s.max[1])*.5, cz=(s.min[2]+s.max[2])*.5;
      // Skip underground foundations, walkable floor slabs, ramps, rails, and walk-in apartment interiors.
      if (s.max[1]<=0.2 || h<0.45 || (w>45 && d>45)) continue;
      if (this.homes.some(hm=>cx>=hm.x0-0.8 && cx<=hm.x1+0.8 && cz>=hm.z0-0.8 && cz<=hm.z1+0.8)) continue;
      if (Math.abs(cz)<15 && (Math.abs(cx)>38 && Math.abs(cx)<50)) continue; // keep stairs/station ends clear
      const isBuilding=h>=6.5 || (w>=7 && d>=5 && h>=3);
      const isShop=!isBuilding && h>=2.2 && (w>=2.5 || d>=2.5);
      const kind=isBuilding?'building':isShop?'shop':'object';
      if (!isBuilding && !isShop && w>8) continue; // skip long road barriers/highway spans
      this.registerDestructible({
        id:'baked-'+i,kind,material:h<3 && w<3?'wood':'concrete',
        x:cx,y:cy,z:cz,w,h,d,yaw:0,tint:0xbab8aa,matKind:isBuilding?10:2,
        minY:Math.max(0.14,s.min[1]),maxY:s.max[1]+0.8,solids:[s]
      });
    }
  }

  loadParts(renderer,parts) {
    for (let i=0;i<parts.length;i++) {
      const p=parts[i];
      renderer.zone=p[0];
      if (p[1]==='label') renderer.label(p[2],p[3],p[4],p[5],p[6],p[7],p[8],p[9],p[10]);
      else renderer.add(p[1],p[2],p[3],p[4],p[5],p[6],p[7],p[8],p[9],p[10]);
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
  // follow. Wider passages stay open. Uses O(N log N) spatial hashing & sweep.
  sealAlleys(maxGap=2.6,inset=.12) {
    const solids=this.solids;
    const cellMap=new Map();
    const rawBuildings=[];
    const CELL_S=16, INV_S=1/CELL_S;
    for (let i=0;i<solids.length;i++) {
      const b=solids[i];
      if (zoneOf(b.min[0])!==0) continue;
      const x0=b.min[0], x1=b.max[0], z0=b.min[2], z1=b.max[2];
      const cx0=Math.floor(x0*INV_S), cx1=Math.floor(x1*INV_S);
      const cz0=Math.floor(z0*INV_S), cz1=Math.floor(z1*INV_S);
      for (let cz=cz0;cz<=cz1;cz++) {
        for (let cx=cx0;cx<=cx1;cx++) {
          const key=cz*1024+cx;
          let list=cellMap.get(key);
          if (!list) {list=[];cellMap.set(key,list);}
          list.push(b);
        }
      }
      if (b.min[1]<.5 && b.max[1]>2.4 && x1-x0>1.2 && z1-z0>1.2) rawBuildings.push(b);
    }
    // Preserve exact height() stacking semantics via O(1) cell lookup (iterates solids in insertion order).
    const buildings=[];
    for (let i=0;i<rawBuildings.length;i++) {
      const b=rawBuildings[i];
      const x=(b.min[0]+b.max[0])*.5, z=(b.min[2]+b.max[2])*.5;
      let top=b.max[1];
      const list=cellMap.get(Math.floor(z*INV_S)*1024+Math.floor(x*INV_S));
      if (list) {
        for (let j=0;j<list.length;j++) {
          const c=list[j];
          if (x>c.min[0] && x<c.max[0] && z>c.min[2] && z<c.max[2] && c.min[1]<=top+.3) {
            if (c.max[1]>top) top=c.max[1];
          }
        }
      }
      buildings.push({min:b.min,max:[b.max[0],top,b.max[2]]});
    }
    const fills=[];
    // Sweep-and-prune separately along X (k=0) and Z (k=2) in O(B log B).
    for (let axis=0;axis<2;axis++) {
      const k=axis===0?0:2, o=2-k;
      const byMin=buildings.slice().sort((p,q)=>p.min[k]-q.min[k]);
      const n=byMin.length;
      for (let i=0;i<n;i++) {
        const a=byMin[i], from=a.max[k], aLo=a.min[o], aHi=a.max[o], aTop=a.max[1];
        const maxTo=from+maxGap;
        // Binary search or scan forward: only buildings with b.min[k] in (from+0.05, from+maxGap) match!
        // Since byMin is sorted by min[k], start from lower bound where b.min[k] > from + 0.05.
        let loIdx=i+1, hiIdx=n;
        const minTo=from+.05;
        while (loIdx<hiIdx) {
          const mid=(loIdx+hiIdx)>>1;
          if (byMin[mid].min[k]<=minTo) loIdx=mid+1;
          else hiIdx=mid;
        }
        for (let j=loIdx;j<n;j++) {
          const b=byMin[j], to=b.min[k];
          if (to>=maxTo) break;
          const lo=(aLo>b.min[o]?aLo:b.min[o])+inset;
          const hi=(aHi<b.max[o]?aHi:b.max[o])-inset;
          if (hi-lo<.6) continue;
          fills.push({k,from,to,lo,hi,top:aTop<b.max[1]?aTop:b.max[1]});
        }
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
    const s={min:[x-w/2,y-h/2,z-d/2],max:[x+w/2,y+h/2,z+d/2],ray,paintLayer};
    this.solids.push(s);
    return s;
  }

  disableSolid(raw) {
    if (this._boxes) {
      const idx=raw?._idx;
      if (idx>=0) {
        if (!this._solidDisabled) this._solidDisabled=new Uint8Array(this.solids.length);
        this._solidDisabled[idx]=1;
        this._solidsVersion++;
      }
      return;
    }
    const box=this._solidBoxes?.get(raw);
    if (box) {box.disabled=true;this._solidsVersion++;}
  }

  disableRegion(zoneIndex,minX,maxX,minY,maxY,minZ,maxZ) {
    const disabled=this.geometry?.disableRegion(zoneIndex,minX,maxX,minY,maxY,minZ,maxZ)??0;
    if (disabled) this._solidsVersion++;
    return disabled;
  }

  indexSolids() {
    this.grid0=new Array(4096);
    this.grid1=new Array(1024);
    this.collisionGrid=new Map();
    this._solidBoxes=new WeakMap();
    const boxes=new Array(this.solids.length);
    this._boxes=boxes;
    this._traceSeq=0;
    const grid0=this.grid0, grid1=this.grid1, grid=this.collisionGrid;
    for (let i=0;i<this.solids.length;i++) {
      const raw=this.solids[i];
      const x0=raw.min[0], y0=raw.min[1], z0=raw.min[2];
      const x1=raw.max[0], y1=raw.max[1], z1=raw.max[2];
      const box={idx:i,x0,y0,z0,x1,y1,z1,ray:raw.ray,paintLayer:raw.paintLayer,disabled:false,_seen:0};
      boxes[i]=box;
      this._solidBoxes.set(raw,box);
      const cx0=Math.floor(x0*INV_CELL), cx1=Math.floor(x1*INV_CELL);
      const cz0=Math.floor(z0*INV_CELL), cz1=Math.floor(z1*INV_CELL);
      for (let z=cz0;z<=cz1;z++) {
        const uz0=z+32, uz1=z+16;
        const inZ0=(uz0&~63)===0, inZ1=(uz1&~31)===0;
        for (let x=cx0;x<=cx1;x++) {
          const ux0=x+32;
          if (inZ0 && (ux0&~63)===0) {
            const idx=(uz0<<6)|ux0;
            let b=grid0[idx];
            if (!b) grid0[idx]=b=[];
            b.push(box);
            continue;
          }
          const ux1=x-(UNDER_CELL_X-16);
          if (inZ1 && (ux1&~31)===0) {
            const idx=(uz1<<5)|ux1;
            let b=grid1[idx];
            if (!b) grid1[idx]=b=[];
            b.push(box);
            continue;
          }
          const key=z*1024+x;
          let b=grid.get(key);
          if (!b) {b=[];grid.set(key,b);}
          b.push(box);
        }
      }
    }
    // Partition slabs by zone with tight per-zone AABBs for O(1) early reject.
    this.zoneSlabs=ZONES.map(()=>[]);
    this.slabBounds=ZONES.map(()=>({x0:Infinity,x1:-Infinity,z0:Infinity,z1:-Infinity}));
    this.zoneMaxFloorY=ZONES.map(z=>z.y);
    for (let i=0;i<this.slabs.length;i++) {
      const raw=this.slabs[i], z=zoneOf(raw.x0);
      const isX=raw.axis==='x';
      const invSpan=1/(isX?raw.x1-raw.x0:raw.z1-raw.z0);
      const dy=raw.to-raw.from;
      const s={
        x0:raw.x0,x1:raw.x1,z0:raw.z0,z1:raw.z1,
        from:raw.from,to:raw.to,layer:raw.layer,
        isX,invSpan,dy,
        flatResult:dy===0?Object.freeze({y:raw.from,layer:raw.layer}):null
      };
      this.zoneSlabs[z].push(s);
      const b=this.slabBounds[z];
      if (s.x0<b.x0) b.x0=s.x0;
      if (s.x1>b.x1) b.x1=s.x1;
      if (s.z0<b.z0) b.z0=s.z0;
      if (s.z1>b.z1) b.z1=s.z1;
      const top=s.from>s.to?s.from:s.to;
      if (top>this.zoneMaxFloorY[z]) this.zoneMaxFloorY[z]=top;
    }
    this.elevX0=Infinity; this.elevX1=-Infinity; this.elevZ0=Infinity; this.elevZ1=-Infinity;
    this.elevatedList=[];
    for (let i=0;i<this.elevated.length;i++) {
      const raw=this.elevated[i];
      const r={x0:raw.x0,x1:raw.x1,z0:raw.z0,z1:raw.z1,high:raw.high,invZ:raw.high/(raw.z1-raw.z0)};
      this.elevatedList.push(r);
      if (r.x0<this.elevX0) this.elevX0=r.x0;
      if (r.x1>this.elevX1) this.elevX1=r.x1;
      if (r.z0<this.elevZ0) this.elevZ0=r.z0;
      if (r.z1>this.elevZ1) this.elevZ1=r.z1;
    }
  }

  cellBoxes(cx,cz) {
    const ux0=cx+32, uz0=cz+32;
    if (((ux0|uz0)&~63)===0) return this.grid0[(uz0<<6)|ux0];
    const ux1=cx-(UNDER_CELL_X-16), uz1=cz+16;
    if (((ux1|uz1)&~31)===0) return this.grid1[(uz1<<5)|ux1];
    return this.collisionGrid.get(cz*1024+cx);
  }

  solid(x,y,z,w,h,d,tint,kind = 2,opts) {
    this.r.add('box',x,y,z,w,h,d,tint,kind,opts);
    return this.obstacle(x,y,z,w,h,d);
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
    const zone=zoneOf(x);
    const b=this.slabBounds[zone];
    if (x>=b.x0 && x<=b.x1 && z>=b.z0 && z<=b.z1) {
      const slabs=this.zoneSlabs[zone];
      for (let i=0;i<slabs.length;i++) {
        const s=slabs[i];
        if (x<s.x0 || x>s.x1 || z<s.z0 || z>s.z1) continue;
        if (s.flatResult) {
          return this.dynamicStage?.active?this.dynamicStage.floorOverlay(x,z,s.flatResult):s.flatResult;
        }
        const t=s.isX?(x-s.x0)*s.invSpan:(z-s.z0)*s.invSpan;
        const hit={y:s.from+s.dy*t,layer:s.layer};
        return this.dynamicStage?.active?this.dynamicStage.floorOverlay(x,z,hit):hit;
      }
    }
    const base=ZONE_FLOORS[zone];
    return this.dynamicStage?.active?this.dynamicStage.floorOverlay(x,z,base):base;
  }

  // Zero-allocation scalar floor height query for stand(), trace(), Navigation.clear().
  floorY(x,z) {
    const sy=stairFloorY(x,z);
    if (sy===sy) return sy;
    const zone=zoneOf(x);
    const b=this.slabBounds[zone];
    let y=ZONE_FLOORS[zone].y;
    if (x>=b.x0 && x<=b.x1 && z>=b.z0 && z<=b.z1) {
      const slabs=this.zoneSlabs[zone];
      for (let i=0;i<slabs.length;i++) {
        const s=slabs[i];
        if (x<s.x0 || x>s.x1 || z<s.z0 || z>s.z1) continue;
        y=!s.dy?s.from:s.from+s.dy*(s.isX?(x-s.x0)*s.invSpan:(z-s.z0)*s.invSpan);
        break;
      }
    }
    return this.dynamicStage?.active?this.dynamicStage.floorOverlay(x,z,{y,layer:0}).y:y;
  }

  elevatedHeight(x,z) {
    if (x<this.elevX0 || x>this.elevX1 || z<this.elevZ0 || z>this.elevZ1) return -Infinity;
    const list=this.elevatedList;
    for (let i=0;i<list.length;i++) {
      const ramp=list[i];
      if (x>=ramp.x0 && x<=ramp.x1 && z>=ramp.z0 && z<=ramp.z1) {
        return ramp.invZ*(ramp.z1-z);
      }
    }
    return -Infinity;
  }

  support(x,y,z) {
    const base=this.floor(x,z);
    const ramp=this.elevatedHeight(x,z);
    let top=ramp<=y+.32?(ramp>base.y?ramp:base.y):base.y;
    if (y<base.y+.22 && top===base.y && !this.dynamicStage?.active) return base;
    const boxes=this.cellBoxes(Math.floor(x*INV_CELL),Math.floor(z*INV_CELL));
    if (boxes) {
      const maxY=y+.095, dis=this._solidDisabled;
      for (let i=0;i<boxes.length;i++) {
        const b=boxes[i];
        if ((dis && dis[b.idx]) || b.disabled || b.y1<=top+.12 || b.y1>maxY || x<=b.x0+.05 || x>=b.x1-.05 || z<=b.z0+.05 || z>=b.z1-.05) continue;
        top=b.y1;
      }
    }
    const res=top>base.y?{y:top,layer:base.layer,raised:true}:base;
    return this.dynamicStage?.active?this.dynamicStage.supportOverlay(x,y,z,res):res;
  }

  blocked(x,y,z,radius = .41,height = 1.68) {
    const zone=zoneOf(x);
    if (zone===0) {
      if (!inCity(x,z,radius)) return true;
    } else {
      const bounds=ZONES[zone].bounds;
      const lx=x-ZONES[zone].x;
      if (lx<-bounds[0]+radius || lx>bounds[0]-radius || z<-bounds[1]+radius || z>bounds[1]-radius) return true;
    }
    if (this.dynamicStage?.active && this.dynamicStage.blocked(x,y,z,radius,height)) return true;
    const ramp=this.elevatedHeight(x,z);
    if (y<ramp-.020 && y+height>ramp-.46) return true;
    const r2=radius*radius, yLo=y+.025, yHi=y+height-.025;
    const col0=Math.floor((x-radius)*INV_CELL), col1=Math.floor((x+radius)*INV_CELL);
    const row0=Math.floor((z-radius)*INV_CELL), row1=Math.floor((z+radius)*INV_CELL);
    const grid0=this.grid0, grid1=this.grid1, grid=this.collisionGrid, dis=this._solidDisabled;
    if (col0===col1 && row0===row1) {
      let boxes;
      const ux0=col0+32, uz0=row0+32;
      if (((ux0|uz0)&~63)===0) boxes=grid0[(uz0<<6)|ux0];
      else {
        const ux1=col0-(UNDER_CELL_X-16), uz1=row0+16;
        if (((ux1|uz1)&~31)===0) boxes=grid1[(uz1<<5)|ux1];
        else boxes=grid.get(row0*1024+col0);
      }
      if (!boxes) return false;
      for (let i=0;i<boxes.length;i++) {
        const b=boxes[i];
        if ((dis && dis[b.idx]) || b.disabled || yLo>=b.y1 || yHi<=b.y0) continue;
        const dx=x<b.x0?x-b.x0:x>b.x1?x-b.x1:0;
        const dz=z<b.z0?z-b.z0:z>b.z1?z-b.z1:0;
        if (dx*dx+dz*dz<r2) return true;
      }
      return false;
    }
    for (let row=row0;row<=row1;row++) {
      const uz0=row+32, uz1=row+16;
      const inZ0=(uz0&~63)===0, inZ1=(uz1&~31)===0;
      for (let col=col0;col<=col1;col++) {
        let boxes;
        const ux0=col+32;
        if (inZ0 && (ux0&~63)===0) boxes=grid0[(uz0<<6)|ux0];
        else {
          const ux1=col-(UNDER_CELL_X-16);
          if (inZ1 && (ux1&~31)===0) boxes=grid1[(uz1<<5)|ux1];
          else boxes=grid.get(row*1024+col);
        }
        if (!boxes) continue;
        for (let i=0;i<boxes.length;i++) {
          const b=boxes[i];
          if ((dis && dis[b.idx]) || b.disabled || yLo>=b.y1 || yHi<=b.y0) continue;
          const dx=x<b.x0?x-b.x0:x>b.x1?x-b.x1:0;
          const dz=z<b.z0?z-b.z0:z>b.z1?z-b.z1:0;
          if (dx*dx+dz*dz<r2) return true;
        }
      }
    }
    return false;
  }

  stand(x,z,radius=.48) {
    return !this.blocked(x,this.floorY(x,z)+.025,z,radius);
  }

  step(actor,dx,dz,allow) {
    for (let k=0;k<2;k++) {
      const rawX=actor.x+(k===0?dx:0), z=actor.z+(k===1?dz:0);
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
    const sx=start[0], sy=start[1], sz=start[2];
    const ex=end[0], ey=end[1], ez=end[2];
    const zone=zoneOf(sx);
    if (zone===0 && (sx<-BOUNDS[0] || sx>BOUNDS[0] || ex<-BOUNDS[0] || ex>BOUNDS[0] ||
        sz<-BOUNDS[1] || sz>BOUNDS[1] || ez<-BOUNDS[1] || ez>BOUNDS[1])) return this.traceExact(start,end);
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    let bestT=Infinity, bestAxis=1, bestSign=1, bestLayer=undefined, bestNormal=null;
    const minX=Math.floor((sx<ex?sx:ex)*INV_CELL), maxX=Math.floor((sx>ex?sx:ex)*INV_CELL);
    const minZ=Math.floor((sz<ez?sz:ez)*INV_CELL), maxZ=Math.floor((sz>ez?sz:ez)*INV_CELL);
    const multi=minX!==maxX || minZ!==maxZ;
    const mark=multi?++this._traceSeq:0;
    const grid0=this.grid0, grid1=this.grid1, grid=this.collisionGrid;
    const dis=this._solidDisabled, seen=this._solidSeen;
    for (let z=minZ;z<=maxZ;z++) {
      const uz0=z+32, uz1=z+16;
      const inZ0=(uz0&~63)===0, inZ1=(uz1&~31)===0;
      for (let x=minX;x<=maxX;x++) {
        let boxes;
        const ux0=x+32;
        if (inZ0 && (ux0&~63)===0) boxes=grid0[(uz0<<6)|ux0];
        else {
          const ux1=x-(UNDER_CELL_X-16);
          if (inZ1 && (ux1&~31)===0) boxes=grid1[(uz1<<5)|ux1];
          else boxes=grid.get(z*1024+x);
        }
        if (!boxes) continue;
        for (let i=0;i<boxes.length;i++) {
          const box=boxes[i];
          if ((dis && dis[box.idx]) || box.disabled || !box.ray || zoneOf(box.x0)!==zone) continue;
          if (multi) {
            if (seen) {
              if (seen[box.idx]===mark) continue;
              seen[box.idx]=mark;
            } else {
              if (box._seen===mark) continue;
              box._seen=mark;
            }
          }
          const limit=bestT<1?bestT:1;
          if (rayBoxInto(sx,sy,sz,dx,dy,dz,box,limit,_rayBoxHit) && _rayBoxHit.t<bestT) {
            bestT=_rayBoxHit.t;
            bestAxis=_rayBoxHit.axis;
            bestSign=_rayBoxHit.sign;
            bestLayer=(box.paintLayer!==undefined && bestAxis===1 && bestSign>0)?box.paintLayer:undefined;
          }
        }
      }
    }
    const maxFloorY=this.zoneMaxFloorY[zone];
    if (sy<=maxFloorY || ey<=maxFloorY) {
      const baseY=ZONE_FLOORS[zone].y;
      const sb=this.slabBounds[zone];
      const rx0=sx<ex?sx:ex, rx1=sx>ex?sx:ex, rz0=sz<ez?sz:ez, rz1=sz>ez?sz:ez;
      const hitsSlabs=rx1>=sb.x0 && rx0<=sb.x1 && rz1>=sb.z0 && rz0<=sb.z1;
      const hitsStairs=zone<2 && !(rz1<-15.25 || rz0>15.25 || (rz0>-10.5 && rz1<10.5));
      if (!hitsSlabs && !hitsStairs && !this.dynamicStage?.active) {
        // Pure flat-base analytic intersection in O(1) (no 0.24m ray marching).
        if (sy>baseY && ey<=baseY && dy<-1e-8) {
          const t=(baseY-sy)/dy;
          if (t>=0 && t<bestT) {
            const hx=sx+dx*t, hz=sz+dz*t, lx=hx-ZONES[zone].x;
            const bounds=ZONES[zone].bounds;
            if (zoneOf(hx)===zone && lx>-(bounds[0]+2) && lx<bounds[0]+2 && hz>-(bounds[1]+2) && hz<bounds[1]+2) {
              bestT=t;
              bestNormal=[0,1,0];
              bestLayer=ZONE_FLOORS[zone].layer;
            }
          }
        }
      } else {
        const samples=Math.ceil(Math.sqrt(dx*dx+dy*dy+dz*dz)/.24);
        const bounds=ZONES[zone].bounds, bxLim=bounds[0]+2, bzLim=bounds[1]+2, zOrigin=ZONES[zone].x;
        let lastT=0;
        for (let i=1;i<=samples;i++) {
          const t=i/samples;
          if (lastT>=bestT) break;
          const px=sx+dx*t, py=sy+dy*t, pz=sz+dz*t;
          if (zoneOf(px)===zone) {
            const lx=px-zOrigin;
            if (lx>-bxLim && lx<bxLim && pz>-bzLim && pz<bzLim && py<=this.floorY(px,pz)) {
              let low=lastT, high=t;
              for (let j=0;j<5;j++) {
                const mid=(low+high)*.5;
                if (sy+dy*mid<=this.floorY(sx+dx*mid,sz+dz*mid)) high=mid;
                else low=mid;
              }
              if (high<bestT) {
                const hx=sx+dx*high, hz=sz+dz*high;
                const surface=this.floor(hx,hz);
                const dgx=this.floorY(hx+.08,hz)-this.floorY(hx-.08,hz);
                const dgz=this.floorY(hx,hz+.08)-this.floorY(hx,hz-.08);
                const adx=dgx<0?-dgx:dgx, adz=dgz<0?-dgz:dgz;
                const vertical=(adx>adz?adx:adz)>.32;
                bestT=high;
                bestNormal=vertical?(adx>adz?[-Math.sign(dgx),0,0]:[0,0,-Math.sign(dgz)]):[0,1,0];
                bestLayer=vertical?undefined:surface.layer;
              }
              break;
            }
          }
          lastT=t;
        }
      }
    }
    if (bestT===Infinity) return null;
    if (!bestNormal) {
      bestNormal=[0,0,0];
      bestNormal[bestAxis]=bestSign;
    }
    return {t:bestT,normal:bestNormal,layer:bestLayer,position:[sx+dx*bestT,sy+dy*bestT,sz+dz*bestT]};
  }

  traceExact(start,end,clearance=0) {
    const hit=clearance?this.geometry.traceClearance(start,end,clearance):this.geometry.trace(start,end);
    const sx=start[0], sz=start[2], ex=end[0], ez=end[2];
    let edge=null;
    if (zoneOf(sx)===0) {
      const r=CITY_RADIUS-clearance, r2=r*r;
      if (sx*sx+sz*sz>r2 || ex*ex+ez*ez>r2) edge=cityExit(start,end,clearance);
    }
    if (edge!==null && (!hit || edge<hit.t)) {
      const position=add(start,scale(sub(end,start),edge));
      const length=Math.sqrt(position[0]*position[0]+position[2]*position[2])||1;
      return {t:edge,position,normal:[-position[0]/length,0,-position[2]/length],boundary:true};
    }
    if (!hit) return null;
    const p=hit.position, x=p[0], y=p[1], z=p[2], shape=hit.shape, k=shape.kind;
    if (hit.normal[1]>.54 && k>=0 && k<31 && (((1<<k)&0x08408022)!==0)) {
      const floor=this.floor(x,z);
      if (shape.layer!==undefined && (shape.layer===4 || k===15 || Math.abs(y-floor.y)<.26)) hit.layer=shape.layer;
      else if (Math.abs(y-floor.y)<.17 && shape.sx*shape.sz>.24) hit.layer=floor.layer;
    }
    return hit;
  }

  // Zero-allocation boolean visibility ray test against static world geometry & city boundary.
  traceExactAny(sx,sy,sz,ex,ey,ez) {
    if (this.geometry.traceAny(sx,sy,sz,ex,ey,ez)) return true;
    if (zoneOf(sx)===0) {
      const r2=CITY_RADIUS*CITY_RADIUS;
      if (sx*sx+sz*sz>r2 || ex*ex+ez*ez>r2) return cityExit([sx,sy,sz],[ex,ey,ez],0)!==null;
    }
    return false;
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
    const so=this.solid(x,y+.29,z,w,.58,depth,tint,1);
    r.add('box',x,y+.58,z,w-.06,.09,depth*.67,0xe1decd,1);
    r.add('box',x,y+.12,z,w+.10,.23,depth+.14,0x9e9e94,1);
    for (let i=0;i<Math.floor(w/.44);i++) {
      const bx=x-w/2+.26+i*.44;
      for (const sign of [-1,1]) r.add('box',bx,y+.34,z+sign*(depth/2+.013),.26,.205,.026,i%2?0xe4af45:0x646053,2);
    }
    this.registerDestructible({
      id:'barrier-'+Math.round(x*10)+'_'+Math.round(z*10),kind:'object',material:'concrete',
      x,y:y+.32,z,w:w+.2,h:.72,d:depth+.2,tint,matKind:1,minY:y+0.02,maxY:y+0.9,solids:so?[so]:[]
    });
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
    const so=this.solid(x,1.18,z,2.7,2.36,2.15,tint,2);
    r.add('box',x,2.40,z,2.93,.14,2.37,0xd1cbbb,2);
    r.add('box',x,1.39,z+1.08*sign,2.37,.94,.063,0x4e6364,8);
    r.add('box',x,.90,z+1.24*sign,2.49,.16,.43,0xa59d86,4);
    r.add('box',x,2.03,z+1.10*sign,2.43,.35,.09,tint,2);
    r.label(label,x,2.04,z+1.152*sign,2.35,.33,WHITE,sign===1?0:Math.PI);
    for (let i=0;i<4;i++) r.add('box',x-.82+i*.55,1.4,z+1.12*sign,.05,1,.06,0x9eaaa5,4);
    for (let i=0;i<9;i++) r.add('box',x-1.02+i*.25,2.24,z+1.30*sign,.24,.075,.58,i%2?tint:0xece6d2,2);
    this.registerDestructible({
      id:'kiosk-'+label+'-'+Math.round(x),kind:'object',material:'wood',
      x,y:1.25,z,w:3.1,h:2.55,d:2.9,tint,matKind:2,minY:0.14,maxY:2.8,solids:so?[so]:[]
    });
  }

  container(x,z,tint,w=6.3,d=2.55,y=0) {
    const r=this.r,h=2.65;
    const so=this.solid(x,y+h/2,z,w,h,d,tint,2);
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
    this.registerDestructible({
      id:'container-'+Math.round(x*10)+'_'+Math.round(z*10),kind:'object',material:'metal',
      x,y:y+h/2,z,w:w+.4,h:h+.2,d:d+.4,tint,matKind:2,minY:y+0.12,maxY:y+h+0.4,solids:so?[so]:[]
    });
  }

  vehicle(x,z,tint,style=0,dir=1) {
    this.vehicleDefs.push({id:'car-'+this.vehicleDefs.length,x,z,tint,style,dir});
  }

  shop(x,z,sign,w,h,d,tint,label,style,wear) {
    const r=this.r,front=z+sign*d/2, facing=sign===1?0:Math.PI;
    const entry=apartmentEntry(wear), kind=style===1?13:style===3?11:2;
    let shopSolid=null;
    if (entry) buildApartmentEntry(this,entry,{x,front,sign,w,h,d,tint,kind});
    else shopSolid=this.solid(x,h/2,z,w,h,d,tint,kind);
    if (shopSolid) {
      this.registerDestructible({
        id:'street-shop-'+wear,kind:'building',material:'concrete',
        x,y:h/2,z,w:w+.35,h:h+.5,d:d+.6,tint,matKind:kind,minY:0.15,maxY:h+1.2,solids:[shopSolid]
      });
    }
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

  tower(x,z,w,d,h,tint) {
    const r=this.r;
    const side=Math.sign(z) || 1;
    const lot=residentialLot(w,d,h);
    const halfW=lot.width/2, halfD=lot.depth/2;
    if (Math.abs(z)>40 && Math.abs(x)<57) z=side*Math.max(Math.abs(z),41+halfD);
    const besideTunnel=Math.abs(x)+halfW>RAIL.edge && Math.abs(x)-halfW<railEnd(RAIL);
    for (;;) {
      if (besideTunnel && Math.abs(z-RAIL.z)<halfD+2.5) z=RAIL.z+side*(halfD+3.4);
      const overlap=this.towerSites.find(site=>Math.abs(x-site.x)<halfW+site.halfW && Math.abs(z-site.z)<halfD+site.halfD);
      if (!overlap) break;
      z=overlap.z+side*(halfD+overlap.halfD+.45);
    }
    this.towerSites.push({x,z,halfW,halfD});
    r.add('box',x,-.08,z,lot.width,.19,lot.depth,0xa7aba1,1);
    r.add('box',x,-lot.foundationDepthBelowGrade/2,z,lot.foundationWidth,lot.foundationDepthBelowGrade,lot.foundationDepth,0x858985,2);
    r.add('bevel',x,lot.podium/2,z,lot.foundationWidth,lot.podium,lot.foundationDepth,0xc8c3b3,2);
    r.add('box',x,(h+3.15)/2-.2,z,w,h-3.15,d,tint,11);
    // The tower is solid, lobby included: nobody walks into it. Shots keep
    // hitting its drawn shape, so this box only stops bodies.
    const towerOb=this.obstacle(x,h/2,z,w+.2,h+.2,d+.2,false);
    this.registerDestructible({
      id:'tower-'+Math.round(x)+'_'+Math.round(z),kind:'building',material:'concrete',
      x,y:h*.5,z,w:w+.4,h:h+3.2,d:d+.4,tint,matKind:11,minY:0.14,maxY:h+4.0,solids:towerOb?[towerOb]:[]
    });
    r.add('box',x,1.39,z,w-.68,2.78,d-.68,0x7f928d,8);
    for (const sx of [-1,1]) for (const sz of [-1,1])
      r.add('box',x+sx*(w*.5-.17),1.43,z+sz*(d*.5-.17),.34,2.86,.34,tint,2);
    r.add('box',x,2.94,z,w+.33,.28,d+.33,0xc6c9ba,2);
    r.add('box',x,h+.11,z,w+.20,.28,d+.20,0xbec9c8,2);
    for (let floor=0;floor<h;floor+=6.3) {
      r.add('box',x,floor,z,w+.19,.16,d+.21,0xc8d0ca,2);
    }
    for (const sign of [-1,1]) {
      r.add('box',x+sign*(w/2-.21),h/2,z,.34,h+.1,d+.22,0xc1c9c4,2);
      r.add('box',x,h/2,z+sign*(d/2-.11),w+.27,h+.2,.21,tint,11);
    }
    r.add('box',x+w*.10,h+1.02,z-d*.09,w*.43,1.78,d*.43,0xc9cec4,2);
    r.add('cylinder',x+w*.22,h+2.9,z-d*.17,.14,3.0,.14,0x848f8d,4);
    for (const side of [-1,1]) {
      for (let floor=0;floor<Math.min(3,Math.floor(h/3.15));floor++) {
        const y=1.54+floor*3.15, across=Math.max(1,Math.floor((w-.7)/2.15)), step=(w-.64)/across;
        for (let col=0;col<across;col++) {
          const px=x-w*.5+.32+step*(col+.5), pz=z+side*(d*.5+.043);
          r.add('bevel',px,y,pz,step-.21,1.84,.12,0x526c6b,4);
          r.add('box',px,y,pz+side*.065,step-.36,1.66,.025,0x91afa9,8);
          r.add('box',px,y-.94,pz+side*.10,step-.13,.11,.28,0xc4c8b6,2);
          r.add('box',px,y,pz+side*.086,.055,1.68,.046,0xb1bbb1,4);
        }
      }
    }
    for (const sign of [-1,1]) {
      const rx=x+sign*w*.28;
      r.add('bevel',rx,h+.37,z+d*.20,w*.25,.58,d*.24,0x84958d,4);
      for (let slot=0;slot<5;slot++) r.add('box',rx,h+.68,z+d*(.12+slot*.04),w*.20,.029,.045,0x4e6661,4);
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
    this.solid(x,y,-.4,w,.86,89,0xa0a5a0,1);
    for (const side of [-1,1]) {
      this.solid(x+side*w/2,y+.68,-.4,.52,.74,89.12,0xc7c5b8,1);
      r.add('box',x+side*(w/2-.2),y-.42,-.4,.56,.47,89.14,0x86918d,4);
      r.add('box',x+side*3.08,y-.49,-.4,.28,.38,88.8,0x697874,4);
      for (let z=-43;z<43;z+=2.65) r.add('box',x+side*(w/2+.023),y+.77,z,.61,.24,.21,0xbfc6bd,2);
    }
    this.solid(x,y+.68,-44.81,w,.74,.26,0xc7c5b8,1);
    for (let z=-42;z<43;z+=3.4) r.add('box',x,y-.50,z,w-.29,.29,.21,0x74817b,4);
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
    cutStairOpenings(r,-36,-.26,0,280,.52,384,0xb9b7ab,1);
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
    this.vehicle(-31.2,5.1,0x3fcbb8,0,1);
    this.vehicle(31.2,-5.1,0xf28749,0,-1);
    this.kiosk(-3.8,-16.58,1,0x9d8263,'COFFEE');
    this.kiosk(3.4,16.1,-1,0x66877e,'KIOSK');
    for (const [x,z,w] of [[-12,8.9,4.5],[12,-7.8,4.8],[-20.6,17.8,3.0],[22.4,-10.1,2.55],[-1.6,-11.4,3.3],[.9,10.2,3.75]]) this.barrier(x,z,w);
    for (const [x,z] of [[-32,7.8],[-6,9.4],[15.6,-9.5],[30,-9.0],[-33,-9.1],[-1,-18.8],[4,20]]) {
      const tint=R()>.5?0xac9c78:0x96a7a0;
      const po=this.solid(x,.33,z,1.55,.66,.82,tint,1);
      r.add('box',x,.67,z,1.60,.13,.87,0xaca38f,1);
      r.add('box',x,.73,z,1.39,.043,.66,0x75705d,1);
      for (let i=0;i<13;i++) {
        const px=x-.61+R()*1.22,pz=z-.26+R()*.52;
        r.add('orb',px,.81+R()*.28,pz,.30+R()*.18,.25+R()*.31,.31,[.30+R()*.23,.44+R()*.24,.29+R()*.16],14);
      }
      this.registerDestructible({
        id:'planter-'+Math.round(x*10)+'_'+Math.round(z*10),kind:'object',material:'clay',
        x,y:.45,z,w:1.65,h:1.05,d:.95,tint,matKind:1,minY:0.05,maxY:1.4,solids:po?[po]:[]
      });
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
    buildResidentialDistrict(this);
    floorWeathering(r,41,-46,.013,25.7,3.0,1.24,0xbab19c);
    floorWeathering(r,42,42,0,-12.7,2.8,1.43,0xb9b7ab);
    wallWeathering(r,43,0,.80,4.742,0,5.4,.56,0x54776b);
    floorWeathering(r,44,35,.102,7.77,4.2,.39,0xd7d3bf);
    floorWeathering(r,45,-14,0,12.7,4.7,1.9,0xb9b7ab);
    // Towers keep clear of the elevated loop (layout.js RAIL_LOOP).
    this.towerSites.push(...railLoopSites());
    for (const sign of [-1,1]) {
      for (let i=0;i<12;i++) {
        const x=-59+i*11.2+R()*3, z=sign*(43.5+R()*13);
        this.tower(x,z,6.5+R()*6,6+R()*7,12.6+R()*34,panelColors[(i+3)%panelColors.length]);
        const farX=-88+i*15.8+R()*4.5;
        this.tower(farX,sign*(60+R()*12),8+R()*8,9+R()*8,20+R()*37,0x9aadb3);
      }
    }
    for (const side of [-1,1]) {
      // Beyond the loop's curves: east of it, and west past the apartment blocks.
      for (let i=0;i<7;i++) this.tower(side>0?96+R()*14:-(152+R()*10),-36+i*12,7+R()*7,6+R()*7,9+R()*27,panelColors[(i+2)%panelColors.length]);
    }
    for (const [a,b] of [[[-37,6.9,9.5],[-20,6.7,-20.9]],[[-20,6.7,-20.9],[4,9.6,-20.8]],[[-37,9.7,-22],[36,9.1,-22]],[[12.8,12.8,-24],[30,8.0,19.9]]]) {
      const cable=(t)=>[mix(a[0],b[0],t),mix(a[1],b[1],t)-Math.sin(t*Math.PI)*.62,mix(a[2],b[2],t)];
      for (let j=0;j<12;j++) r.beam(cable(j/12),cable((j+1)/12),.031,.034,0x525e59,4);
    }
    buildOuterCity(this);
    this.encloseArenaWithApartments();
  }

  // Encloses all four sides of the arena with continuous apartment buildings so
  // nobody can walk, jump, or climb out of the map. Where the elevated train
  // loop exits east and west, an apartment-integrated railway tunnel portal
  // lets the train pass cleanly while blocking players and NPCs.
  encloseArenaWithApartments() {
    const r=this.r;
    const addApartment=(x,z,w,h,d,yaw,tint,style,topGuard=true)=>{
      const rot=Math.abs(Math.sin(yaw))>.5;
      r.add('box',x,h*.5,z,rot?d:w,h,rot?w:d,tint,10,{yaw,label:style});
      this.obstacle(x,h*.5,z,w,h,d);
      // Rooftop parapet and cornice cap
      r.add('box',x,h+.18,z,w+.24,.36,d+.24,0xb4b3a6,1);
      r.add('box',x,h+.62,z,Math.min(w*.34,4.2),.72,Math.min(d*.34,3.6),0x8f9993,4);
      // Architectural horizontal slab bands along the street-facing side
      const cy=Math.cos(yaw), sy=Math.sin(yaw);
      const faceX=x+sy*(rot?w*.5:d*.5), faceZ=z+cy*(rot?d*.5:w*.5);
      for (let fy=3.2;fy<h-.8;fy+=3.0) {
        if (rot) r.add('box',faceX+Math.sign(sy)*.08,fy,z,.18,.14,d-.2,0xc5c1b2,1);
        else r.add('box',x,fy,faceZ+Math.sign(cy)*.08,w-.2,.14,.18,0xc5c1b2,1);
      }
      // Invisible actor-only roof guard prevents ink-climbing over the perimeter out of bounds.
      if (topGuard) this.obstacle(x,h+6.5,z,w,13,d,false);
    };

    // 1. North & South continuous apartment backing walls behind the shop/home row
    //    (z = ±34.65 .. ±39.6), sealing all street alleys while leaving the 3 enterable
    //    apartment interiors (|z| <= 34.49) and the overhead highway (x ∈ [6,16], y >= 12.6) clear.
    for (const sign of [-1,1]) {
      const z=sign*37.15, d=4.9, yaw=sign>0?Math.PI:0;
      // West of elevated highway
      addApartment(-25.0,z,62.0,16.4,d,yaw,0xc6bca8,0,true);
      // Directly underneath elevated highway (capped at 10.4m so highway at 12.67m clears cleanly)
      addApartment(11.0,z,10.0,10.4,d,yaw,0xb5bbb3,1,false);
      // East of elevated highway
      addApartment(36.0,z,40.0,15.8,d,yaw,0xc0b39f,2,true);
    }

    // 2. East & West apartment walls (x = ±55.6 .. ±63.6) spanning z = -39.6 .. +39.6,
    //    with integrated railway tunnel portals at z = RAIL.z (-28.65).
    const railMinZ=RAIL.z-3.15, railMaxZ=RAIL.z+3.15; // [-31.8, -25.5]
    for (const side of [-1,1]) {
      const x=side*59.4, w=7.6, yaw=side>0?-T:T;
      // South corner tower connecting into South row (z = 18 .. 39.6)
      addApartment(x,28.8,w,17.8,21.6,yaw,0xc7b8a2,0,true);
      // Mid-south apartment block (z = 4 .. 18). West block uses a 5.0m podium with
      // upper apartment sky-bridge (y = 11.5..18.2m) and continuous actor-only barrier
      // across the skyway so actors cannot exit while high lob shots clear cleanly.
      if (side<0) {
        addApartment(x,11.0,w,5.0,14.0,yaw,0xb78871,1,false);
        const skyH=6.7;
        r.add('box',x,11.5+skyH*.5,11.0,14.0,skyH,w,0xb78871,10,{yaw,label:1});
        this.obstacle(x,11.5+skyH*.5,11.0,w,skyH,14.0);
        r.add('box',x,11.5+skyH+.18,11.0,w+.24,.36,14.24,0xb4b3a6,1);
        this.obstacle(x,14.5,11.0,w,20.0,14.0,false);
      } else {
        addApartment(x,11.0,w,15.2,14.0,yaw,0xb78871,1,true);
      }
      // Central road-closing apartment block (z = -10 .. 4)
      addApartment(x,-3.0,w,side<0?13.6:14.8,14.0,yaw,0xaeb8b5,2,true);
      // North-of-road apartment block reaching up to the train portal (z = -25.5 .. -10)
      addApartment(x,-17.75,w,16.8,15.5,yaw,0xc9c3af,0,true);
      // North corner tower beyond the train portal connecting into North row (z = -39.6 .. -31.8)
      addApartment(x,-35.7,w,18.4,7.8,yaw,0xa6b6bb,3,true);

      // ---- Railway Tunnel Portal integrated into the East/West apartment block ----
      const portalZ=RAIL.z, portalSpan=railMaxZ-railMinZ;
      // Solid concrete/apartment ground-floor viaduct base beneath the elevated track (y = 0 .. 5.12)
      this.solid(x,2.56,portalZ,w,5.12,portalSpan+.2,0x8e958e,13);
      // Upper apartment stories bridging seamlessly OVER the railway tunnel (y = 10.7 .. 19.0)
      const bridgeH=8.3;
      this.solid(x,10.7+bridgeH*.5,portalZ,w,bridgeH,portalSpan+.6,0xc2b9a5,10);
      r.add('box',x,19.18,portalZ,w+.24,.36,portalSpan+.8,0xb4b3a6,1);
      this.obstacle(x,25.5,portalZ,w,13,portalSpan+.8,false);
      // Reinforced concrete portal arch frame, piers, dark tunnel surround, and warning lights
      const innerFace=side*(59.4-w*.5);
      for (const pz of [railMinZ+.18,railMaxZ-.18]) {
        this.solid(x,7.9,pz,w+.12,5.6,.42,0x6e7975,13);
        r.add('box',innerFace-side*.16,7.9,pz,.34,5.6,.52,0x55635f,4);
        r.add('box',innerFace-side*.35,6.4,pz,.08,1.1,.28,0xe6b84c,3);
      }
      // Portal lintel beam & illuminated 07 LINE tunnel sign facing into the arena
      r.add('box',innerFace-side*.20,10.82,portalZ,.48,.68,portalSpan+.9,0x495a55,4);
      r.add('box',innerFace-side*.46,10.82,portalZ,.08,.48,4.1,0x356b60,2);
      r.label('07 LINE TUNNEL',innerFace-side*.52,10.82,portalZ,3.85,.42,WHITE,yaw);
      for (const lz of [-2.4,2.4]) r.add('orb',innerFace-side*.46,10.32,portalZ+lz,.22,.22,.22,0xffc766,3);
      // Actor-only tunnel barrier: lets the elevated train glide through freely while blocking players/NPCs.
      this.obstacle(side*55.6,7.9,portalZ,1.4,5.5,portalSpan,false);
    }
  }
}
