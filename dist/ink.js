import {clamp} from './render.js';
import {INK_REGIONS,PAINT_LAYERS,RAIL,TRACK_LAYER,ZONES,inkOrigin,inkRegion} from './layout.js';
import {STAIR_SEAM,stairLane} from './stairs.js';
import {FILM_STEP,encodeFilmHeight,filmFlux} from './ink-fluid.js';

export const FLOOR_PAINT_RADIUS=Math.sqrt(1.25);
export const WALL_PAINT_RADIUS=Math.sqrt(2*1.7);
export const surfacePaintRadius=normal=>Math.abs(normal[1])<.54?WALL_PAINT_RADIUS:FLOOR_PAINT_RADIUS;

const TILE=16;
const COVERAGE=.0027;
const ZONE_FOR_LAYER=Array.from({length:PAINT_LAYERS},(_,layer)=>ZONES.findIndex(zone=>zone.inkMask & (1<<layer)));

// Depth and signed face flux in a thin viscous film. An edge transfers pigment
// to its neighbor, including across a ramp-to-road seam, without creating mass.
export class Paint {
  constructor({width=640,height=448,visualOnly=false}={}) {
    this.w=width;
    this.h=height;
    this.boundX=Math.max(...ZONES.map(zone=>zone.bounds[0]))+2.5;
    this.boundZ=Math.max(...ZONES.map(zone=>zone.bounds[1]))+3.2;
    this.cellArea=4*this.boundX*this.boundZ/(this.w*this.h);
    this.layerSize=this.w*this.h;
    const n=this.layerSize*PAINT_LAYERS;
    this.layers=PAINT_LAYERS;
    this.pixels=new Uint8Array(n*4);
    this.mask=new Uint8Array(n);
    this.floorByte=new Uint8Array(n);
    this.owner=new Uint8Array(n);
    this.count=[0,0];
    this.total=0;
    this.zoneCount=ZONES.map(()=>[0,0]);
    this.zoneTotal=ZONES.map(()=>0);
    this.dirtyMask=(1<<this.layers)-1;
    this.visualOnly=visualOnly;
    this.tilesWide=Math.ceil(this.w/TILE);
    this.tilesHigh=Math.ceil(this.h/TILE);
    this.stairCells=new Map();
    if (visualOnly) return;
    this.surface=new Int32Array(this.layerSize*INK_REGIONS).fill(-1);
    this.bed=new Float32Array(n);
    this.cyan=new Float32Array(n);
    this.amber=new Float32Array(n);
    this.deltaC=new Float32Array(n);
    this.deltaA=new Float32Array(n);
    this.flowX=new Float32Array(this.layerSize*INK_REGIONS);
    this.flowZ=new Float32Array(this.layerSize*INK_REGIONS);
    this.barrierX=new Uint8Array(this.flowX.length);
    this.barrierZ=new Uint8Array(this.flowZ.length);
    this.touched=new Uint8Array(n);
    this.changed=[];
    this.regionTiles=this.tilesWide*this.tilesHigh;
    this.stairEdges=new Map();
    this.stairTiles=new Map();
    this.awake=new Set();
    this.time=0;
    this.netDirty=null;
    this.netTiles=null;
  }

  setWorld(world) {
    this.total=0;
    this.zoneTotal.fill(0);
    this.mask.fill(0);
    this.floorByte.fill(0);
    this.surface?.fill(-1);
    this.stairCells.clear();
    this.stairEdges?.clear();
    this.stairTiles?.clear();
    this.barrierX?.fill(0);
    this.barrierZ?.fill(0);
    this.barrierWorld=world.geometry??null;
    for (const zone of ZONES) {
      const [boundX,boundZ]=zone.bounds;
      const left=Math.floor((1-boundX/this.boundX)*.5*this.w);
      const right=this.w-1-left;
      const top=Math.floor((1-boundZ/this.boundZ)*.5*this.h);
      const bottom=this.h-1-top;
      for (let iz=top;iz<=bottom;iz++) for (let ix=left;ix<=right;ix++) {
        const x=((ix+.5)/this.w*2-1)*this.boundX+zone.x;
        const z=((iz+.5)/this.h*2-1)*this.boundZ;
        if (!world.stand(x,z,.095)) continue;
        const floor=world.floor(x,z), base=iz*this.w+ix, index=base+floor.layer*this.layerSize;
        const regionBase=inkRegion(floor.layer)*this.layerSize+base;
        if (floor.stair) {
          const lane=stairLane(x,z);
          if (lane.level!==(lane.t<=STAIR_SEAM?0:1)) continue;
          this.stairCells.set(base,{stair:floor.stair,index,regionBase});
        }
        this.mask[index]=1;
        this.floorByte[index]=encodeFilmHeight(floor.y);
        if (!this.visualOnly) {
          this.surface[regionBase]=index;
          this.bed[index]=floor.y;
        }
        this.total++;
        this.zoneTotal[ZONE_FOR_LAYER[floor.layer]]++;
      }
    }
    if (!this.visualOnly) for (const [base,left] of this.stairCells) {
      const right=this.stairCells.get(base+1);
      if (base%this.w===this.w-1 || right?.stair!==left.stair ||
          Math.floor(left.regionBase/this.layerSize)===Math.floor(right.regionBase/this.layerSize)) continue;
      this.stairEdges.set(left.regionBase,right.regionBase);
      const a=this.tileAt(left.regionBase), c=this.tileAt(right.regionBase);
      if (!this.stairTiles.has(a)) this.stairTiles.set(a,new Set());
      if (!this.stairTiles.has(c)) this.stairTiles.set(c,new Set());
      this.stairTiles.get(a).add(c);
      this.stairTiles.get(c).add(a);
    }
    for (let iz=0;iz<this.h;iz++) {
      const z=((iz+.5)/this.h*2-1)*this.boundZ;
      if (Math.abs(z-RAIL.z)>=RAIL.halfWidth) continue;
      for (let ix=0;ix<this.w;ix++) {
        const x=((ix+.5)/this.w*2-1)*this.boundX;
        if (Math.abs(x)>=RAIL.edge) continue;
        const base=iz*this.w+ix, index=TRACK_LAYER*this.layerSize+base;
        this.mask[index]=1;
        this.floorByte[index]=encodeFilmHeight(RAIL.y);
        if (!this.visualOnly) {
          this.surface[2*this.layerSize+base]=index;
          this.bed[index]=RAIL.y;
        }
        this.total++;
        this.zoneTotal[ZONE_FOR_LAYER[TRACK_LAYER]]++;
      }
    }
  }

  reset() {
    for (const buffer of [this.owner,this.pixels,this.cyan,this.amber,this.deltaC,this.deltaA,this.flowX,this.flowZ,this.touched]) buffer.fill(0);
    this.awake.clear();
    this.netDirty?.clear();
    this.netTiles?.clear();
    this.changed.length=0;
    this.count=[0,0];
    this.zoneCount=ZONES.map(()=>[0,0]);
    this.time=0;
    this.dirtyMask=(1<<this.layers)-1;
  }

  index(x,z,layer) {
    const u=Math.floor(((x-inkOrigin(layer))/this.boundX+1)*.5*this.w), v=Math.floor((z/this.boundZ+1)*.5*this.h);
    if (u<0 || u>=this.w || v<0 || v>=this.h) return -1;
    return layer*this.layerSize+v*this.w+u;
  }

  hasSurface(x,z,layer) {
    return layer!==undefined && this.mask[this.surfaceIndex(x,z,layer)]===1;
  }

  get(x,z,layer=0) {
    return this.owner[this.surfaceIndex(x,z,layer)] || 0;
  }

  depthAt(x,z,layer=0) {
    const i=this.surfaceIndex(x,z,layer);
    return i>=0?this.cyan[i]+this.amber[i]:0;
  }

  surfaceIndex(x,z,layer) {
    const index=this.index(x,z,layer);
    if (index<0 || this.mask[index] || layer!==0 && layer!==2) return index;
    const other=this.stairCells.get(index%this.layerSize);
    return other && stairLane(x,z)?.stair===other.stair?other.index:index;
  }

  publish(index) {
    const a=this.cyan[index], b=this.amber[index], depth=a+b;
    const owner=depth<COVERAGE ? 0 : a>=b ? 1 : 2;
    const previous=this.owner[index];
    const layer=Math.floor(index/this.layerSize);
    if (owner!==previous) {
      const count=this.zoneCount[ZONE_FOR_LAYER[layer]];
      if (previous) {this.count[previous-1]--;count[previous-1]--;}
      if (owner) {this.count[owner-1]++;count[owner-1]++;}
      this.owner[index]=owner;
    }
    const c=owner===1?255:0, amber=owner===2?255:0;
    const thickness=Math.round(255*clamp(depth/.085,0,1));
    const i=index*4;
    if (previous!==owner || this.pixels[i]!==c || this.pixels[i+1]!==amber || this.pixels[i+2]!==thickness) {
      this.pixels[i]=c;
      this.pixels[i+1]=amber;
      this.pixels[i+2]=thickness;
      this.pixels[i+3]=depth>0?this.floorByte[index]:0;
      this.dirtyMask|=1<<layer;
      if (this.netDirty) {
        const base=index%this.layerSize;
        const tile=Math.floor(base/this.w/TILE)*this.tilesWide+Math.floor((base%this.w)/TILE);
        const id=layer*this.regionTiles+tile;
        this.netDirty.add(id);
        this.netTiles.add(id);
      }
    }
    return owner!==previous ? owner : 0;
  }

  tileAt(base) {
    const region=Math.floor(base/this.layerSize), local=base%this.layerSize;
    const x=local%this.w, z=Math.floor(local/this.w);
    return region*this.regionTiles+Math.floor(z/TILE)*this.tilesWide+Math.floor(x/TILE);
  }

  wake(base) {
    const local=base%this.layerSize, x=local%this.w, z=Math.floor(local/this.w);
    const tile=this.tileAt(base);
    this.awake.add(tile);
    if (x && x%TILE===0) this.awake.add(tile-1);
    if (z && z%TILE===0) this.awake.add(tile-this.tilesWide);
  }

  stampGround(x,z,radius,team,layer,phase,depth) {
    return this.stamp(x,z,radius*FLOOR_PAINT_RADIUS,team,layer,phase,depth);
  }

  stamp(x,z,radius,team,layer,phase=0,depth=.036) {
    const region=inkRegion(layer);
    const stair=(layer===0 || layer===2)?stairLane(x,z)?.stair:null;
    const cx=((x-inkOrigin(layer))/this.boundX+1)*.5*this.w, cz=(z/this.boundZ+1)*.5*this.h;
    const rx=radius*this.w/(2*this.boundX), rz=radius*this.h/(2*this.boundZ);
    const x0=Math.max(0,Math.floor(cx-rx*1.18)), x1=Math.min(this.w-1,Math.ceil(cx+rx*1.18));
    const z0=Math.max(0,Math.floor(cz-rz*1.18)), z1=Math.min(this.h-1,Math.ceil(cz+rz*1.18));
    let taken=0, wetted=0;
    const pigment=team===0?this.cyan:this.amber;
    for (let iz=z0;iz<=z1;iz++) for (let ix=x0;ix<=x1;ix++) {
      const base=iz*this.w+ix, stairCell=stair?this.stairCells.get(base):null;
      const onStair=stairCell && stairCell.stair===stair;
      const index=onStair?stairCell.index:layer*this.layerSize+base;
      if (!this.mask[index]) continue;
      const u=(ix+.5-cx)/rx, v=(iz+.5-cz)/rz, d2=u*u+v*v;
      if (d2>1.19) continue;
      const angle=Math.atan2(v,u)+phase;
      const rim=.88+.105*Math.sin(angle*5)+.082*Math.cos(angle*9+.25)+.052*Math.sin(angle*17+1.);
      const rim2=rim*rim;
      if (d2>=rim2) continue;
      const amount=depth*(.23+.77*(1-d2/rim2));
      pigment[index]+=amount;
      wetted|=1<<(onStair?Math.floor(stairCell.regionBase/this.layerSize):region);
      if (this.publish(index)===team+1) taken++;
    }
    if (wetted) {
      const left=Math.max(0,Math.floor((x0-1)/TILE)),right=Math.floor(x1/TILE);
      const top=Math.max(0,Math.floor((z0-1)/TILE)),bottom=Math.floor(z1/TILE);
      for (let region=0;region<INK_REGIONS;region++) {
        if (!(wetted & (1<<region))) continue;
        for (let z=top;z<=bottom;z++) for (let x=left;x<=right;x++) this.awake.add(region*this.regionTiles+z*this.tilesWide+x);
      }
    }
    return taken;
  }

  kick(x,z,layer,vx,vz) {
    const index=this.surfaceIndex(x,z,layer);
    if (index<0 || !this.mask[index]) return;
    const base=index%this.layerSize+inkRegion(Math.floor(index/this.layerSize))*this.layerSize;
    this.flowX[base]+=clamp(vx,-8,8)*.00115;
    this.flowZ[base]+=clamp(vz,-8,8)*.00115;
    this.wake(base);
  }

  depositDrop(x,z,layer,team,volume,vx,vz) {
    if (layer===undefined) return false;
    const index=this.surfaceIndex(x,z,layer);
    if (!this.mask[index]) return false;
    const pigment=team===0?this.cyan:this.amber;
    pigment[index]+=volume/this.cellArea;
    this.publish(index);
    this.kick(x,z,layer,vx,vz);
    return true;
  }

  barrier(a,b) {
    const origin=inkOrigin(Math.floor(a/this.layerSize));
    if (origin!==inkOrigin(Math.floor(b/this.layerSize))) return false;
    const y=Math.max(this.bed[a],this.bed[b])+.067;
    const point=index=>{
      const cell=index%this.layerSize;
      return [origin+((cell%this.w+.5)/this.w*2-1)*this.boundX,y,
        ((Math.floor(cell/this.w)+.5)/this.h*2-1)*this.boundZ];
    };
    return !!this.barrierWorld.trace(point(a),point(b));
  }

  edge(a,b,flow,base,barriers) {
    if (b<0) {
      flow[base]=0;
      return false;
    }
    const ac=this.cyan[a], aa=this.amber[a], bc=this.cyan[b], ba=this.amber[b];
    const ha=ac+aa, hb=bc+ba;
    const q=filmFlux(ha,hb,this.bed[a]-this.bed[b],flow[base]);
    flow[base]=q;
    if (!q) return false;
    if (barriers && this.barrierWorld) {
      if (!barriers[base]) barriers[base]=this.barrier(a,b)?2:1;
      if (barriers[base]===2) {
        flow[base]=0;
        return false;
      }
    }
    const c=q*(q>0?ac/ha:bc/hb), t=q-c;
    this.deltaC[a]-=c;
    this.deltaC[b]+=c;
    this.deltaA[a]-=t;
    this.deltaA[b]+=t;
    if (!this.touched[a]) {
      this.touched[a]=1;
      this.changed.push(a);
    }
    if (!this.touched[b]) {
      this.touched[b]=1;
      this.changed.push(b);
    }
    return true;
  }

  tick() {
    const tiles=this.awake;
    this.awake=new Set();
    const {w,h,surface}=this;
    for (const tile of tiles) {
      const neighbors=this.stairTiles.get(tile);
      if (neighbors) for (const next of neighbors) tiles.add(next);
    }
    for (const tile of tiles) {
      const region=Math.floor(tile/this.regionTiles), local=tile%this.regionTiles;
      const sx=(local%this.tilesWide)*TILE, sz=Math.floor(local/this.tilesWide)*TILE;
      const ex=Math.min(w,sx+TILE), ez=Math.min(h,sz+TILE);
      const joined=this.stairTiles.has(tile);
      let active=false;
      for (let z=sz;z<ez;z++) for (let x=sx;x<ex;x++) {
        const base=region*this.layerSize+z*w+x, a=surface[base];
        if (a<0) continue;
        const bridge=joined?this.stairEdges.get(base):undefined;
        const across=x+1<w && this.edge(a,surface[bridge??base+1],this.flowX,base,this.barrierX);
        const down=z+1<h && this.edge(a,surface[base+w],this.flowZ,base,this.barrierZ);
        if (!across && !down) continue;
        active=true;
        if (x===sx && sx>0) this.awake.add(tile-1);
        if (z===sz && sz>0) this.awake.add(tile-this.tilesWide);
        if (across && bridge!==undefined) this.awake.add(this.tileAt(bridge));
        else if (across && x+1===ex) this.awake.add(tile+1);
        if (down && z+1===ez) this.awake.add(tile+this.tilesWide);
      }
      if (active) this.awake.add(tile);
    }
    for (const index of this.changed) {
      this.cyan[index]+=this.deltaC[index];
      this.amber[index]+=this.deltaA[index];
      this.deltaC[index]=this.deltaA[index]=0;
      this.touched[index]=0;
      this.publish(index);
    }
    this.changed.length=0;
  }

  advance(dt) {
    this.time+=dt;
    while (this.time>=FILM_STEP) {
      this.time-=FILM_STEP;
      if (this.awake.size) this.tick();
    }
  }

  percent(team,zone=null) {
    const total=zone===null?this.total:this.zoneTotal[zone];
    const count=zone===null?this.count:this.zoneCount[zone];
    return count[team]*100/Math.max(1,total);
  }
}
