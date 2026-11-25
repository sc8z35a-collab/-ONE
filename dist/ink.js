import {clamp} from './render.js';
import {INK_REGIONS,PAINT_LAYERS,RAIL,TRACK_LAYER,ZONES,inkOrigin,inkRegion} from './layout.js';
import {STAIR_SEAM,stairLane} from './stairs.js';
import {FILM_STEP,encodeFilmHeight,filmFlux} from './ink-fluid.js';

export const FLOOR_PAINT_RADIUS=Math.sqrt(1.25);
export const WALL_PAINT_RADIUS=Math.sqrt(2*1.7);
export const surfacePaintRadius=normal=>Math.abs(normal[1])<.54?WALL_PAINT_RADIUS:FLOOR_PAINT_RADIUS;

const TILE=16;
const COVERAGE=.0027;
const ADHESION=.0022, MIN_FLUX=.00044, MAX_FACE_SHARE=.205;
const MIN_DEPTH=ADHESION+MIN_FLUX/MAX_FACE_SHARE;
// Algebraic exact zero-flux threshold when previous face flux is 0:
// (|head| - 0.0015) * 0.16 < MIN_FLUX  <=>  |head| < 0.00425.
const ZERO_HEAD=.0015+MIN_FLUX/.16;
const ZONE_FOR_LAYER=Int8Array.from({length:PAINT_LAYERS},(_,layer)=>ZONES.findIndex(zone=>zone.inkMask & (1<<layer)));
const REGION_FOR_LAYER=Int8Array.from({length:PAINT_LAYERS},(_,layer)=>inkRegion(layer));

function buildFlatWordMask(surface,bed,w,h,layerSize,wordsPerRow) {
  const mask=new Uint32Array(h*INK_REGIONS);
  for (let reg=0;reg<INK_REGIONS;reg++) {
    const ro=reg*layerSize, rowOff0=reg*h;
    for (let z=0;z<h;z++) {
      const r0=ro+z*w, hasDown=z+1<h, r1=r0+w;
      let rowBits=0;
      for (let wIdx=0;wIdx<wordsPerRow;wIdx++) {
        const x0=wIdx<<5, xEnd=x0+32<w?x0+32:w, xEast=x0+33<w?x0+33:w;
        let b0=NaN, flat=1;
        for (let x=x0;x<xEast;x++) {
          const a=surface[r0+x];
          if (a>=0) {
            if (b0!==b0) b0=bed[a];
            else if (bed[a]!==b0) {flat=0;break;}
          }
        }
        if (flat && hasDown) {
          for (let x=x0;x<xEnd;x++) {
            const a=surface[r1+x];
            if (a>=0) {
              if (b0!==b0) b0=bed[a];
              else if (bed[a]!==b0) {flat=0;break;}
            }
          }
        }
        if (flat) rowBits|=1<<wIdx;
      }
      mask[rowOff0+z]=rowBits;
    }
  }
  return mask;
}

// Propagates active-cell wakes for one 32-cell word via SIMD-style bit shifts.
function propagateWordWake(mE,mS,row,z,wIdx,bitRow,canDown,wordsPerRow,awakeBits,awakeRowMask,awakeRows,wakeState) {
  let ac=wakeState.n;
  const modCur=(mE | mS) | (mE<<1);
  awakeBits[bitRow+wIdx]|=modCur | (modCur>>>1);
  if (awakeRowMask[row]===0) awakeRows[ac++]=row;
  awakeRowMask[row]|=1<<wIdx;
  if ((modCur & 1)!==0 && wIdx>0) {
    awakeBits[bitRow+wIdx-1]|=0x80000000;
    awakeRowMask[row]|=1<<(wIdx-1);
  }
  if (mE<0 && wIdx+1<wordsPerRow) {
    awakeBits[bitRow+wIdx+1]|=1;
    awakeRowMask[row]|=1<<(wIdx+1);
  }
  if (z>0) {
    const rUp=row-1, bUp=bitRow-wordsPerRow;
    awakeBits[bUp+wIdx]|=modCur;
    if (awakeRowMask[rUp]===0) awakeRows[ac++]=rUp;
    awakeRowMask[rUp]|=1<<wIdx;
    if (mE<0 && wIdx+1<wordsPerRow) {
      awakeBits[bUp+wIdx+1]|=1;
      awakeRowMask[rUp]|=1<<(wIdx+1);
    }
  }
  if (mS!==0 && canDown) {
    const rDn=row+1, bDn=bitRow+wordsPerRow;
    awakeBits[bDn+wIdx]|=mS | (mS>>>1);
    if (awakeRowMask[rDn]===0) awakeRows[ac++]=rDn;
    awakeRowMask[rDn]|=1<<wIdx;
    if ((mS & 1)!==0 && wIdx>0) {
      awakeBits[bDn+wIdx-1]|=0x80000000;
      awakeRowMask[rDn]|=1<<(wIdx-1);
    }
  }
  wakeState.n=ac;
}

// Compact monomorphic kernel for a single 32-cell flat-bed word (~92% of all words).
function runWordFlat(
  word,rowBase,colBase,w,canDown,
  surface,cyan,amber,flowX,flowZ,barrierX,barrierZ,
  deltaC,deltaA,touched,changedList,cc,
  hasBarrier,hasStairs,stairEdges,paint,wakeState
) {
  const base0=rowBase+colBase;
  let mE=0, mS=0;
  while (word!==0) {
    const bit=31-Math.clz32(word & -word);
    word&=word-1;
    const col=colBase+bit, base=base0+bit;
    const a=surface[base];
    if (a<0) continue;
    const ac=cyan[a], ha=ac+amber[a], dryA=ha<MIN_DEPTH;
    if (col+1<w) {
      const b1=surface[base+1];
      if (b1>=0) {
        const bc=cyan[b1], hb=bc+amber[b1], prev=flowX[base];
        if (!dryA || hb>=MIN_DEPTH) {
          const head=ha-hb;
          if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
            const ah=Math.abs(head);
            const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
            const pressure=Math.max(-.12,Math.min(.12,slope));
            const flux=prev*.48+pressure*.16;
            const donor=flux>=0?ha:hb;
            const amount=Math.min(Math.abs(flux),Math.max(0,donor-ADHESION)*MAX_FACE_SHARE);
            let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
            if (q!==0 && hasBarrier) {
              let bv=barrierX[base];
              if (bv===0) barrierX[base]=bv=paint.barrier(a,b1)?2:1;
              if (bv===2) q=0;
            }
            if (q!==prev) flowX[base]=q;
            if (q!==0) {
              let c, t;
              if (q>0) {
                if (ac===ha) {c=q;t=0;}
                else if (ac===0) {c=0;t=q;}
                else {c=q*(ac/ha);t=q-c;}
              } else {
                if (bc===hb) {c=q;t=0;}
                else if (bc===0) {c=0;t=q;}
                else {c=q*(bc/hb);t=q-c;}
              }
              if (c!==0) {deltaC[a]-=c;deltaC[b1]+=c;}
              if (t!==0) {deltaA[a]-=t;deltaA[b1]+=t;}
              if (!touched[a]) {touched[a]=1;changedList[cc++]=a;}
              if (!touched[b1]) {touched[b1]=1;changedList[cc++]=b1;}
              mE|=1<<bit;
            }
          }
        } else if (prev!==0) flowX[base]=0;
      } else if (flowX[base]!==0 && (!hasStairs || !stairEdges.has(base))) flowX[base]=0;
    }
    if (canDown) {
      const b2=surface[base+w];
      if (b2>=0) {
        const bc=cyan[b2], hb=bc+amber[b2], prev=flowZ[base];
        if (!dryA || hb>=MIN_DEPTH) {
          const head=ha-hb;
          if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
            const ah=Math.abs(head);
            const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
            const pressure=Math.max(-.12,Math.min(.12,slope));
            const flux=prev*.48+pressure*.16;
            const donor=flux>=0?ha:hb;
            const amount=Math.min(Math.abs(flux),Math.max(0,donor-ADHESION)*MAX_FACE_SHARE);
            let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
            if (q!==0 && hasBarrier) {
              let bv=barrierZ[base];
              if (bv===0) barrierZ[base]=bv=paint.barrier(a,b2)?2:1;
              if (bv===2) q=0;
            }
            if (q!==prev) flowZ[base]=q;
            if (q!==0) {
              let c, t;
              if (q>0) {
                if (ac===ha) {c=q;t=0;}
                else if (ac===0) {c=0;t=q;}
                else {c=q*(ac/ha);t=q-c;}
              } else {
                if (bc===hb) {c=q;t=0;}
                else if (bc===0) {c=0;t=q;}
                else {c=q*(bc/hb);t=q-c;}
              }
              if (c!==0) {deltaC[a]-=c;deltaC[b2]+=c;}
              if (t!==0) {deltaA[a]-=t;deltaA[b2]+=t;}
              if (!touched[a]) {touched[a]=1;changedList[cc++]=a;}
              if (!touched[b2]) {touched[b2]=1;changedList[cc++]=b2;}
              mS|=1<<bit;
            }
          }
        } else if (prev!==0) flowZ[base]=0;
      } else if (flowZ[base]!==0) flowZ[base]=0;
    }
  }
  wakeState.mE=mE;
  wakeState.mS=mS;
  return cc;
}

// General kernel for sloped/ramp/stair 32-cell words (~8% of words).
function runWordSloped(
  word,rowBase,colBase,w,canDown,
  surface,cyan,amber,bed,flowX,flowZ,barrierX,barrierZ,
  deltaC,deltaA,touched,changedList,cc,
  hasBarrier,hasStairs,stairEdges,paint,wakeState
) {
  const base0=rowBase+colBase;
  let mE=0, mS=0;
  while (word!==0) {
    const bit=31-Math.clz32(word & -word);
    word&=word-1;
    const col=colBase+bit, base=base0+bit;
    const a=surface[base];
    if (a<0) continue;
    const ac=cyan[a], ha=ac+amber[a], dryA=ha<MIN_DEPTH, bedA=bed[a];
    if (col+1<w) {
      const b1=surface[base+1];
      if (b1>=0) {
        const bc=cyan[b1], hb=bc+amber[b1], prev=flowX[base];
        if (!dryA || hb>=MIN_DEPTH) {
          const bd=bedA-bed[b1];
          if (bd<=.41 && bd>=-.41) {
            const head=bd+ha-hb;
            if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
              const ah=Math.abs(head);
              const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
              const pressure=Math.max(-.12,Math.min(.12,slope));
              const flux=prev*.48+pressure*.16;
              const donor=flux>=0?ha:hb;
              const amount=Math.min(Math.abs(flux),Math.max(0,donor-ADHESION)*MAX_FACE_SHARE);
              let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
              if (q!==0 && hasBarrier) {
                let bv=barrierX[base];
                if (bv===0) barrierX[base]=bv=paint.barrier(a,b1)?2:1;
                if (bv===2) q=0;
              }
              if (q!==prev) flowX[base]=q;
              if (q!==0) {
                let c, t;
                if (q>0) {
                  if (ac===ha) {c=q;t=0;}
                  else if (ac===0) {c=0;t=q;}
                  else {c=q*(ac/ha);t=q-c;}
                } else {
                  if (bc===hb) {c=q;t=0;}
                  else if (bc===0) {c=0;t=q;}
                  else {c=q*(bc/hb);t=q-c;}
                }
                if (c!==0) {deltaC[a]-=c;deltaC[b1]+=c;}
                if (t!==0) {deltaA[a]-=t;deltaA[b1]+=t;}
                if (!touched[a]) {touched[a]=1;changedList[cc++]=a;}
                if (!touched[b1]) {touched[b1]=1;changedList[cc++]=b1;}
                mE|=1<<bit;
              }
            }
          } else if (prev!==0) flowX[base]=0;
        } else if (prev!==0) flowX[base]=0;
      } else if (flowX[base]!==0 && (!hasStairs || !stairEdges.has(base))) flowX[base]=0;
    }
    if (canDown) {
      const b2=surface[base+w];
      if (b2>=0) {
        const bc=cyan[b2], hb=bc+amber[b2], prev=flowZ[base];
        if (!dryA || hb>=MIN_DEPTH) {
          const bd=bedA-bed[b2];
          if (bd<=.41 && bd>=-.41) {
            const head=bd+ha-hb;
            if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
              const ah=Math.abs(head);
              const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
              const pressure=Math.max(-.12,Math.min(.12,slope));
              const flux=prev*.48+pressure*.16;
              const donor=flux>=0?ha:hb;
              const amount=Math.min(Math.abs(flux),Math.max(0,donor-ADHESION)*MAX_FACE_SHARE);
              let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
              if (q!==0 && hasBarrier) {
                let bv=barrierZ[base];
                if (bv===0) barrierZ[base]=bv=paint.barrier(a,b2)?2:1;
                if (bv===2) q=0;
              }
              if (q!==prev) flowZ[base]=q;
              if (q!==0) {
                let c, t;
                if (q>0) {
                  if (ac===ha) {c=q;t=0;}
                  else if (ac===0) {c=0;t=q;}
                  else {c=q*(ac/ha);t=q-c;}
                } else {
                  if (bc===hb) {c=q;t=0;}
                  else if (bc===0) {c=0;t=q;}
                  else {c=q*(bc/hb);t=q-c;}
                }
                if (c!==0) {deltaC[a]-=c;deltaC[b2]+=c;}
                if (t!==0) {deltaA[a]-=t;deltaA[b2]+=t;}
                if (!touched[a]) {touched[a]=1;changedList[cc++]=a;}
                if (!touched[b2]) {touched[b2]=1;changedList[cc++]=b2;}
                mS|=1<<bit;
              }
            }
          } else if (prev!==0) flowZ[base]=0;
        } else if (prev!==0) flowZ[base]=0;
      } else if (flowZ[base]!==0) flowZ[base]=0;
    }
  }
  wakeState.mE=mE;
  wakeState.mS=mS;
  return cc;
}

// Inlined fast-skip settle kernel: skips unchanged pixels and avoids divisions.
function runSettle(
  count,list,cyan,amber,deltaC,deltaA,touched,ownerArr,pixels,floorByte,
  dirtyRows,countArr,zoneCount,ls,w,tilesWide,regionTiles,netDirty,netTiles,paint
) {
  const ls2=ls*2, ls3=ls*3, ls4=ls*4, ls5=ls*5, ls6=ls*6;
  const isDefaultW=w===640;
  let dMask=paint.dirtyMask;
  for (let i=0;i<count;i++) {
    const idx=list[i];
    const dc=deltaC[idx], da=deltaA[idx];
    let nc=cyan[idx], na=amber[idx];
    if (dc!==0) {cyan[idx]=nc+dc;nc=cyan[idx];deltaC[idx]=0;}
    if (da!==0) {amber[idx]=na+da;na=amber[idx];deltaA[idx]=0;}
    touched[idx]=0;
    const depth=nc+na;
    const ow=depth<COVERAGE?0:nc>=na?1:2;
    const prev=ownerArr[idx];
    const thick=depth>=.085?255:depth<=0?0:(depth*3000+.5)|0;
    const pi=idx<<2;
    if (ow===prev && pixels[pi+2]===thick && (depth<=0 || pixels[pi+3]!==0)) continue;
    const layer=idx<ls?0:idx<ls2?1:idx<ls3?2:idx<ls4?3:idx<ls5?4:idx<ls6?5:6;
    if (ow!==prev) {
      const zc=zoneCount[ZONE_FOR_LAYER[layer]];
      if (prev) {countArr[prev-1]--;zc[prev-1]--;}
      if (ow) {countArr[ow-1]++;zc[ow-1]++;}
      ownerArr[idx]=ow;
      pixels[pi]=ow===1?255:0;
      pixels[pi+1]=ow===2?255:0;
    }
    pixels[pi+2]=thick;
    pixels[pi+3]=depth>0?floorByte[idx]:0;
    const loc=idx-layer*ls;
    const row=isDefaultW?((loc>>7)*52429)>>>18:(loc/w)|0;
    const at=layer<<1;
    if (row<dirtyRows[at]) dirtyRows[at]=row;
    if (row>dirtyRows[at+1]) dirtyRows[at+1]=row;
    dMask|=1<<layer;
    if (netDirty) {
      const col=loc-row*w;
      const id=layer*regionTiles+(row>>4)*tilesWide+(col>>4);
      netDirty.add(id);
      netTiles.add(id);
    }
  }
  paint.dirtyMask=dMask;
}

// Depth and signed face flux in a thin viscous film. An edge transfers pigment
// to its neighbor, including across a ramp-to-road seam, without creating mass.
export class Paint {
  constructor({width=640,height=448,visualOnly=false}={}) {
    this.w=width;
    this.h=height;
    this.boundX=Math.max(...ZONES.map(zone=>zone.bounds[0]))+2.5;
    this.boundZ=Math.max(...ZONES.map(zone=>zone.bounds[1]))+3.2;
    this.invW=2*this.boundX/this.w;
    this.invH=2*this.boundZ/this.h;
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
    // First and last changed row of each layer, so the renderer uploads only
    // the band of the ink texture that moved.
    this.dirtyRows=new Int32Array(PAINT_LAYERS*2);
    this.touchLayers((1<<this.layers)-1);
    this.visualOnly=visualOnly;
    this.tilesWide=Math.ceil(this.w/TILE);
    this.tilesHigh=Math.ceil(this.h/TILE);
    this.regionTiles=this.tilesWide*this.tilesHigh;
    this.stairCells=new Map();
    this.barrierWorld=null;
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
    this.changedList=new Int32Array(65536);
    this.changedCount=0;
    this.wordsPerRow=(this.w+31)>>>5;
    const totalRows=this.h*INK_REGIONS;
    this.totalRows=totalRows;
    this.awakeBits=new Uint32Array(totalRows*this.wordsPerRow);
    this.workBits=new Uint32Array(totalRows*this.wordsPerRow);
    this.awakeRowMask=new Uint32Array(totalRows);
    this.workRowMask=new Uint32Array(totalRows);
    this.awakeRows=new Int32Array(totalRows);
    this.workRows=new Int32Array(totalRows);
    this.awakeCount=0;
    this.workCount=0;
    this._wakeState={n:0,mE:0,mS:0};
    this.stairEdges=new Map();
    this.stairTiles=new Map();
    this.stairAwake=false;
    this.stairWork=false;
    this.time=0;
    this.netDirty=null;
    this.netTiles=null;
  }

  growChangedList(minLen) {
    let cap=this.changedList.length;
    while (cap<minLen) cap<<=1;
    const next=new Int32Array(cap);
    next.set(this.changedList);
    this.changedList=next;
    return next;
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
    const w=this.w, h=this.h, boundX=this.boundX, boundZ=this.boundZ, layerSize=this.layerSize;
    const invW=this.invW, invH=this.invH;
    const mask=this.mask, floorByte=this.floorByte, surface=this.surface, bed=this.bed;
    const visualOnly=this.visualOnly, zoneTotal=this.zoneTotal;
    for (const zone of ZONES) {
      const [zBoundX,zBoundZ]=zone.bounds, zx=zone.x;
      const left=Math.floor((1-zBoundX/boundX)*.5*w);
      const right=w-1-left;
      const top=Math.floor((1-zBoundZ/boundZ)*.5*h);
      const bottom=h-1-top;
      for (let iz=top;iz<=bottom;iz++) {
        const z=(iz+.5)*invH-boundZ, rowBase=iz*w;
        for (let ix=left;ix<=right;ix++) {
          const x=(ix+.5)*invW-boundX+zx;
          const floor=world.floor(x,z);
          if (world.blocked(x,floor.y+.025,z,.095)) continue;
          const base=rowBase+ix, index=base+floor.layer*layerSize;
          const regionBase=REGION_FOR_LAYER[floor.layer]*layerSize+base;
          if (floor.stair) {
            const lane=stairLane(x,z);
            if (lane.level!==(lane.t<=STAIR_SEAM?0:1)) continue;
            this.stairCells.set(base,{stair:floor.stair,index,regionBase});
          }
          mask[index]=1;
          floorByte[index]=encodeFilmHeight(floor.y);
          if (!visualOnly) {
            surface[regionBase]=index;
            bed[index]=floor.y;
          }
          this.total++;
          zoneTotal[ZONE_FOR_LAYER[floor.layer]]++;
        }
      }
    }
    if (!visualOnly) {
      for (const [base,left] of this.stairCells) {
        const right=this.stairCells.get(base+1);
        if (base%w===w-1 || right?.stair!==left.stair ||
            ((left.regionBase/layerSize)|0)===((right.regionBase/layerSize)|0)) continue;
        this.stairEdges.set(left.regionBase,right.regionBase);
        const a=this.tileAt(left.regionBase), c=this.tileAt(right.regionBase);
        if (!this.stairTiles.has(a)) this.stairTiles.set(a,new Set());
        if (!this.stairTiles.has(c)) this.stairTiles.set(c,new Set());
        this.stairTiles.get(a).add(c);
        this.stairTiles.get(c).add(a);
      }
    }
    const trackBase=TRACK_LAYER*layerSize, trackRegion=2*layerSize;
    const trackByte=encodeFilmHeight(RAIL.y), trackZone=ZONE_FOR_LAYER[TRACK_LAYER];
    for (let iz=0;iz<h;iz++) {
      const z=(iz+.5)*invH-boundZ;
      if (Math.abs(z-RAIL.z)>=RAIL.halfWidth) continue;
      const rowBase=iz*w;
      for (let ix=0;ix<w;ix++) {
        const x=(ix+.5)*invW-boundX;
        if (Math.abs(x)>=RAIL.edge) continue;
        const base=rowBase+ix, index=trackBase+base;
        mask[index]=1;
        floorByte[index]=trackByte;
        if (!visualOnly) {
          surface[trackRegion+base]=index;
          bed[index]=RAIL.y;
        }
        this.total++;
        zoneTotal[trackZone]++;
      }
    }
    if (!visualOnly) bed._flatWordMask=null;
  }

  clearRows(mask=-1) {
    for (let layer=0;layer<this.layers;layer++) {
      if (!(mask & (1<<layer))) continue;
      this.dirtyRows[layer*2]=this.h;
      this.dirtyRows[layer*2+1]=-1;
    }
  }

  // Marks a whole layer for upload (a reset, a new texture, a restored room).
  touchLayers(mask) {
    this.dirtyMask|=mask;
    for (let layer=0;layer<this.layers;layer++) {
      if (!(mask & (1<<layer))) continue;
      this.dirtyRows[layer*2]=0;
      this.dirtyRows[layer*2+1]=this.h-1;
    }
  }

  touchRow(layer,row) {
    const at=layer*2;
    if (row<this.dirtyRows[at]) this.dirtyRows[at]=row;
    if (row>this.dirtyRows[at+1]) this.dirtyRows[at+1]=row;
    this.dirtyMask|=1<<layer;
  }

  reset() {
    for (const buffer of [
      this.owner,this.pixels,this.cyan,this.amber,this.deltaC,this.deltaA,
      this.flowX,this.flowZ,this.touched,this.awakeBits,this.workBits,
      this.awakeRowMask,this.workRowMask
    ]) buffer.fill(0);
    this.awakeCount=0;
    this.workCount=0;
    this.changedCount=0;
    this.stairAwake=false;
    this.stairWork=false;
    this.netDirty?.clear();
    this.netTiles?.clear();
    this.count=[0,0];
    this.zoneCount=ZONES.map(()=>[0,0]);
    this.time=0;
    this.touchLayers((1<<this.layers)-1);
  }

  // Washes away ink across the specified layers and optional world-coordinate box
  // (used by rain, tsunami waves, and underground flooding). Skips dry cells.
  wash(layerMask,amount,minX=-Infinity,maxX=Infinity,minZ=-Infinity,maxZ=Infinity) {
    if (this.visualOnly || !(amount>0)) return 0;
    const w=this.w, h=this.h, ls=this.layerSize, bx=this.boundX, bz=this.boundZ;
    const cyan=this.cyan, amber=this.amber, flowX=this.flowX, flowZ=this.flowZ;
    const v0=Number.isFinite(minZ)?Math.max(0,Math.floor(((minZ/bz+1)*.5)*h)):0;
    const v1=Number.isFinite(maxZ)?Math.min(h-1,Math.ceil(((maxZ/bz+1)*.5)*h)):h-1;
    if (v0>v1) return 0;
    let washed=0;
    for (let layer=0;layer<this.layers;layer++) {
      if (!(layerMask & (1<<layer))) continue;
      const origin=inkOrigin(layer), regionBase=REGION_FOR_LAYER[layer]*ls;
      const u0=Number.isFinite(minX)?Math.max(0,Math.floor((((minX-origin)/bx+1)*.5)*w)):0;
      const u1=Number.isFinite(maxX)?Math.min(w-1,Math.ceil((((maxX-origin)/bx+1)*.5)*w)):w-1;
      if (u0>u1) continue;
      const baseLayer=layer*ls;
      for (let v=v0;v<=v1;v++) {
        const rowOff=v*w;
        for (let u=u0;u<=u1;u++) {
          const local=rowOff+u, idx=baseLayer+local;
          const c=cyan[idx], a=amber[idx], depth=c+a;
          if (depth===0) continue;
          const next=amount>=1?0:depth-amount;
          if (next<COVERAGE) {
            cyan[idx]=0;
            amber[idx]=0;
            flowX[regionBase+local]=0;
            flowZ[regionBase+local]=0;
          } else {
            const scale=next/depth;
            cyan[idx]=c*scale;
            amber[idx]=a*scale;
          }
          this.publish(idx);
          washed++;
        }
      }
    }
    return washed;
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
    const ls=this.layerSize;
    const layer=index<ls?0:index<ls*2?1:index<ls*3?2:index<ls*4?3:index<ls*5?4:index<ls*6?5:6;
    if (owner!==previous) {
      const count=this.zoneCount[ZONE_FOR_LAYER[layer]];
      if (previous) {this.count[previous-1]--;count[previous-1]--;}
      if (owner) {this.count[owner-1]++;count[owner-1]++;}
      this.owner[index]=owner;
    }
    const c=owner===1?255:0, amber=owner===2?255:0;
    const thickness=depth>=.085?255:depth<=0?0:(depth*3000+.5)|0;
    const i=index<<2, pixels=this.pixels;
    if (previous!==owner || pixels[i]!==c || pixels[i+1]!==amber || pixels[i+2]!==thickness || (depth>0 && pixels[i+3]===0)) {
      pixels[i]=c;
      pixels[i+1]=amber;
      pixels[i+2]=thickness;
      pixels[i+3]=depth>0?this.floorByte[index]:0;
      const local=index-layer*ls, w=this.w;
      const row=w===640?((local>>7)*52429)>>>18:(local/w)|0;
      const at=layer<<1;
      if (row<this.dirtyRows[at]) this.dirtyRows[at]=row;
      if (row>this.dirtyRows[at+1]) this.dirtyRows[at+1]=row;
      this.dirtyMask|=1<<layer;
      if (this.netDirty) {
        const col=local-row*w;
        const id=layer*this.regionTiles+(row>>4)*this.tilesWide+(col>>4);
        this.netDirty.add(id);
        this.netTiles.add(id);
      }
    }
    return owner!==previous ? owner : 0;
  }

  tileAt(base) {
    const layerSize=this.layerSize, region=(base/layerSize)|0, local=base-region*layerSize;
    const w=this.w, z=(local/w)|0, x=local-z*w;
    return region*this.regionTiles+(z>>4)*this.tilesWide+(x>>4);
  }

  wake(base) {
    const ls=this.layerSize, reg=(base/ls)|0, loc=base-reg*ls;
    const w=this.w, z=w===640?((loc>>7)*52429)>>>18:(loc/w)|0, x=loc-z*w;
    const row=reg*this.h+z, wpr=this.wordsPerRow, bitRow=row*wpr;
    const awakeBits=this.awakeBits, awakeRowMask=this.awakeRowMask, awakeRows=this.awakeRows;
    const w0=x>>>5;
    awakeBits[bitRow+w0]|=1<<(x&31);
    if (awakeRowMask[row]===0) awakeRows[this.awakeCount++]=row;
    awakeRowMask[row]|=1<<w0;
    if (x>0) {
      const xm=x-1, wm=xm>>>5;
      awakeBits[bitRow+wm]|=1<<(xm&31);
      awakeRowMask[row]|=1<<wm;
    }
    if (z>0) {
      const rUp=row-1;
      awakeBits[rUp*wpr+w0]|=1<<(x&31);
      if (awakeRowMask[rUp]===0) awakeRows[this.awakeCount++]=rUp;
      awakeRowMask[rUp]|=1<<w0;
    }
    if (this.stairEdges.size) this.stairAwake=true;
  }

  stampGround(x,z,radius,team,layer,phase,depth) {
    return this.stamp(x,z,radius*FLOOR_PAINT_RADIUS,team,layer,phase,depth);
  }

  stamp(x,z,radius,team,layer,phase=0,depth=.036) {
    const region=REGION_FOR_LAYER[layer];
    const stair=(layer===0 || layer===2)?stairLane(x,z)?.stair:null;
    const w=this.w, h=this.h, layerSize=this.layerSize;
    const cx=((x-inkOrigin(layer))/this.boundX+1)*.5*w, cz=(z/this.boundZ+1)*.5*h;
    const rx=radius*w/(2*this.boundX), rz=radius*h/(2*this.boundZ);
    const invRx=1/rx, invRz=1/rz;
    const x0=Math.max(0,Math.floor(cx-rx*1.18)), x1=Math.min(w-1,Math.ceil(cx+rx*1.18));
    const z0=Math.max(0,Math.floor(cz-rz*1.18)), z1=Math.min(h-1,Math.ceil(cz+rz*1.18));
    let taken=0, ac=this.awakeCount;
    const pigment=team===0?this.cyan:this.amber, mask=this.mask, layerOffset=layer*layerSize;
    const awakeBits=this.awakeBits, awakeRowMask=this.awakeRowMask, awakeRows=this.awakeRows;
    const wpr=this.wordsPerRow;
    for (let iz=z0;iz<=z1;iz++) {
      const v=(iz+.5-cz)*invRz, v2=v*v;
      if (v2>1.19) continue;
      const rowBase=iz*w;
      for (let ix=x0;ix<=x1;ix++) {
        const u=(ix+.5-cx)*invRx, d2=u*u+v2;
        if (d2>1.19) continue;
        const base=rowBase+ix, stairCell=stair?this.stairCells.get(base):null;
        const onStair=stairCell && stairCell.stair===stair;
        const index=onStair?stairCell.index:layerOffset+base;
        if (!mask[index]) continue;
        const angle=Math.atan2(v,u)+phase;
        const rim=.88+.105*Math.sin(angle*5)+.082*Math.cos(angle*9+.25)+.052*Math.sin(angle*17+1.);
        const rim2=rim*rim;
        if (d2>=rim2) continue;
        const amount=depth*(.23+.77*(1-d2/rim2));
        pigment[index]+=amount;
        if (this.publish(index)===team+1) taken++;
        const reg=onStair?((stairCell.regionBase/layerSize)|0):region;
        const row=reg*h+iz, bitRow=row*wpr, w0=ix>>>5;
        awakeBits[bitRow+w0]|=1<<(ix&31);
        if (awakeRowMask[row]===0) awakeRows[ac++]=row;
        awakeRowMask[row]|=1<<w0;
        if (ix>0) {
          const xm=ix-1, wm=xm>>>5;
          awakeBits[bitRow+wm]|=1<<(xm&31);
          awakeRowMask[row]|=1<<wm;
        }
        if (iz>0) {
          const rUp=row-1;
          awakeBits[rUp*wpr+w0]|=1<<(ix&31);
          if (awakeRowMask[rUp]===0) awakeRows[ac++]=rUp;
          awakeRowMask[rUp]|=1<<w0;
        }
        if (onStair) this.stairAwake=true;
      }
    }
    this.awakeCount=ac;
    return taken;
  }

  kick(x,z,layer,vx,vz) {
    const index=this.surfaceIndex(x,z,layer);
    if (index<0 || !this.mask[index]) return;
    const ls=this.layerSize;
    const l=index<ls?0:index<ls*2?1:index<ls*3?2:index<ls*4?3:index<ls*5?4:index<ls*6?5:6;
    const base=(index-l*ls)+REGION_FOR_LAYER[l]*ls;
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
    const ls=this.layerSize;
    const la=a<ls?0:a<ls*2?1:a<ls*3?2:a<ls*4?3:a<ls*5?4:a<ls*6?5:6;
    const lb=b<ls?0:b<ls*2?1:b<ls*3?2:b<ls*4?3:b<ls*5?4:b<ls*6?5:6;
    const origin=inkOrigin(la);
    if (origin!==inkOrigin(lb)) return false;
    const ba=this.bed[a], bb=this.bed[b], y=(ba>bb?ba:bb)+.067;
    const w=this.w, invW=this.invW, invH=this.invH, bx0=this.boundX, bz0=this.boundZ;
    const ca=a-la*ls, az=w===640?((ca>>7)*52429)>>>18:(ca/w)|0, ax=ca-az*w;
    const cb=b-lb*ls, bz=w===640?((cb>>7)*52429)>>>18:(cb/w)|0, bx=cb-bz*w;
    const sx=origin+(ax+.5)*invW-bx0, sz=(az+.5)*invH-bz0;
    const ex=origin+(bx+.5)*invW-bx0, ez=(bz+.5)*invH-bz0;
    const bw=this.barrierWorld;
    if (bw.traceAny) return bw.traceAny(sx,y,sz,ex,y,ez);
    return !!bw.trace([sx,y,sz],[ex,y,ez]);
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
    if (this.changedCount+2>=this.changedList.length) this.growChangedList(this.changedCount+2);
    if (!this.touched[a]) {
      this.touched[a]=1;
      this.changedList[this.changedCount++]=a;
    }
    if (!this.touched[b]) {
      this.touched[b]=1;
      this.changedList[this.changedCount++]=b;
    }
    return true;
  }

  // Swaps the 2-level bitboard frontier into the work buffers and sorts active rows ascending.
  takeWork() {
    let tmp=this.workBits; this.workBits=this.awakeBits; this.awakeBits=tmp;
    tmp=this.workRowMask; this.workRowMask=this.awakeRowMask; this.awakeRowMask=tmp;
    tmp=this.workRows; this.workRows=this.awakeRows; this.awakeRows=tmp;
    const rc=this.awakeCount;
    this.workCount=rc;
    this.awakeCount=0;
    this.stairWork=this.stairAwake || (rc>0 && this.stairEdges.size>0);
    this.stairAwake=false;
    const wr=this.workRows;
    for (let i=1;i<rc;i++) {
      const v=wr[i];
      let j=i-1;
      while (j>=0 && wr[j]>v) {wr[j+1]=wr[j];j--;}
      wr[j+1]=v;
    }
  }

  flowStairs() {
    const edges=this.stairEdges;
    if (!edges.size) return;
    const surface=this.surface, flowX=this.flowX;
    for (const [from,to] of edges) {
      const a=surface[from], b=surface[to];
      if (a<0 || b<0) continue;
      if (this.edge(a,b,flowX,from)) {
        this.wake(from);
        this.wake(to);
      }
    }
  }

  flowRows(startIdx,endIdx) {
    const w=this.w, h=this.h, wpr=this.wordsPerRow;
    const surface=this.surface, cyan=this.cyan, amber=this.amber, bed=this.bed;
    const flowX=this.flowX, flowZ=this.flowZ, barrierX=this.barrierX, barrierZ=this.barrierZ;
    const deltaC=this.deltaC, deltaA=this.deltaA, touched=this.touched;
    let changedList=this.changedList;
    const workBits=this.workBits, workRowMask=this.workRowMask, workRows=this.workRows;
    const awakeBits=this.awakeBits, awakeRowMask=this.awakeRowMask, awakeRows=this.awakeRows;
    let flatMask=bed._flatWordMask;
    if (flatMask===null) flatMask=bed._flatWordMask=buildFlatWordMask(surface,bed,w,h,this.layerSize,wpr);
    const hasBarrier=!!this.barrierWorld;
    const stairEdges=this.stairEdges, hasStairs=stairEdges.size>0;
    const wakeState=this._wakeState;
    wakeState.n=this.awakeCount;
    let cc=this.changedCount;
    for (let ri=startIdx;ri<endIdx;ri++) {
      const row=workRows[ri];
      let rMask=workRowMask[row];
      if (rMask===0) continue;
      workRowMask[row]=0;
      const z=row%h, rowBase=row*w, bitRow=row*wpr, canDown=z+1<h;
      const rowFlat=flatMask?flatMask[row]:0;
      while (rMask!==0) {
        const wIdx=31-Math.clz32(rMask & -rMask);
        rMask&=rMask-1;
        const word=workBits[bitRow+wIdx];
        workBits[bitRow+wIdx]=0;
        if (word===0) continue;
        if (cc+96>=changedList.length) changedList=this.growChangedList(cc+96);
        const colBase=wIdx<<5;
        if ((rowFlat & (1<<wIdx))!==0) {
          cc=runWordFlat(
            word,rowBase,colBase,w,canDown,
            surface,cyan,amber,flowX,flowZ,barrierX,barrierZ,
            deltaC,deltaA,touched,changedList,cc,
            hasBarrier,hasStairs,stairEdges,this,wakeState
          );
        } else {
          cc=runWordSloped(
            word,rowBase,colBase,w,canDown,
            surface,cyan,amber,bed,flowX,flowZ,barrierX,barrierZ,
            deltaC,deltaA,touched,changedList,cc,
            hasBarrier,hasStairs,stairEdges,this,wakeState
          );
        }
        const mE=wakeState.mE, mS=wakeState.mS;
        if ((mE | mS)!==0) {
          propagateWordWake(mE,mS,row,z,wIdx,bitRow,canDown,wpr,awakeBits,awakeRowMask,awakeRows,wakeState);
        }
      }
    }
    this.changedCount=cc;
    this.awakeCount=wakeState.n;
  }

  settle() {
    const count=this.changedCount;
    if (!count) return;
    runSettle(
      count,this.changedList,this.cyan,this.amber,this.deltaC,this.deltaA,
      this.touched,this.owner,this.pixels,this.floorByte,this.dirtyRows,
      this.count,this.zoneCount,this.layerSize,this.w,this.tilesWide,
      this.regionTiles,this.netDirty,this.netTiles,this
    );
    this.changedCount=0;
  }

  tick() {
    this.takeWork();
    if (this.workCount) {
      this.flowRows(0,this.workCount);
      this.workCount=0;
    }
    if (this.stairWork) {
      this.flowStairs();
      this.stairWork=false;
    }
    this.settle();
  }

  advance(dt) {
    this.time+=dt;
    if (!(this.slices>1)) {
      while (this.time>=FILM_STEP) {
        this.time-=FILM_STEP;
        if (this.awakeCount || this.stairAwake) this.tick();
      }
      return;
    }
    // On a display the work of one film step is spread over the frames up to
    // the next step, so no single frame carries the whole solver.
    while (this.time>=FILM_STEP) {
      this.time-=FILM_STEP;
      if (this.workCount || this.stairWork) this.runQueue(this.workCount);
      if (this.awakeCount || this.stairAwake) this.takeWork();
    }
    if (this.workCount || this.stairWork) {
      const frames=Math.max(1,Math.min(this.slices,Math.ceil((FILM_STEP-this.time)/Math.max(dt,.002))));
      this.runQueue(Math.ceil(this.workCount/frames));
    }
  }

  runQueue(count) {
    const end=this.workCount;
    const start=Math.max(0,end-count);
    if (start<end) {
      this.flowRows(start,end);
      this.workCount=start;
    }
    if (this.workCount===0 && this.stairWork) {
      this.flowStairs();
      this.stairWork=false;
    }
    this.settle();
  }

  percent(team,zone=null) {
    const total=zone===null?this.total:this.zoneTotal[zone];
    const count=zone===null?this.count:this.zoneCount[zone];
    return count[team]*100/Math.max(1,total);
  }
}
