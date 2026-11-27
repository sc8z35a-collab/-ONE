import {clamp} from './render.js';
import {CITY_RADIUS,INK_REGIONS,PAINT_LAYERS,RAIL,TRACK_LAYER,ZONES,inkOrigin,inkRegion,zoneOf} from './layout.js';
import {STAIRS,STAIR_RUN,STAIR_SEAM,stairFloor,stairLane} from './stairs.js';
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

// Precomputed 2048-entry angular rim^2 LUT for paint.stamp() (eliminates per-pixel sin/cos/atan2).
const RIM_N=2048, RIM_MASK=RIM_N-1, INV_TAU_RIM=RIM_N/(Math.PI*2);
const RIM2_LUT=new Float32Array(RIM_N);
for (let i=0;i<RIM_N;i++) {
  const a=i*(Math.PI*2/RIM_N);
  const rim=.88+.105*Math.sin(a*5)+.082*Math.cos(a*9+.25)+.052*Math.sin(a*17+1.);
  RIM2_LUT[i]=rim*rim;
}
// High-precision minimax atan2 mapped to [0, 2047] (max error < 0.0005 rad = <0.16 bin).
function fastAtan2Idx(y,x) {
  const ax=x<0?-x:x, ay=y<0?-y:y;
  let ang;
  if (ax>=ay) {
    if (ax===0) return 0;
    const z=ay/ax, z2=z*z;
    ang=z*(0.9998660+z2*(-0.3302995+z2*(0.1801410+z2*(-0.0851330+z2*0.0208351))));
    if (x<0) ang=Math.PI-ang;
  } else {
    const z=ax/ay, z2=z*z;
    ang=Math.PI*.5-z*(0.9998660+z2*(-0.3302995+z2*(0.1801410+z2*(-0.0851330+z2*0.0208351))));
    if (x<0) ang=Math.PI-ang;
  }
  if (y<0) ang=-ang;
  return ((ang*INV_TAU_RIM+RIM_N+.5)|0)&RIM_MASK;
}

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

// Ultra-tight 2-team (no-boss) flat-bed kernel (~98% of all ticks): eliminates
// all boss/deltaB memory loads and branches while keeping exact east-neighbor register carry.
function runWordFlat2(
  word,rowBase,colBase,w,canDown,
  surface,cyan,amber,flowX,flowZ,barrierX,barrierZ,
  deltaC,deltaA,touched,changedList,cc,
  hasBarrier,hasStairs,stairEdges,paint,wakeState
) {
  const base0=rowBase+colBase;
  let mE=0, mS=0;
  let cCol=-2, cIdx=-1, cC=0, cA=0, cH=0;
  while (word!==0) {
    const bit=31-Math.clz32(word & -word);
    word&=word-1;
    const col=colBase+bit, base=base0+bit;
    let a, ac, aa, ha;
    if (col===cCol) {
      a=cIdx; ac=cC; aa=cA; ha=cH;
    } else {
      a=surface[base];
      if (a<0) continue;
      ac=cyan[a]; aa=amber[a]; ha=ac+aa;
    }
    if (a<0) continue;
    const dryA=ha<MIN_DEPTH;
    if (col+1<w) {
      const b1=surface[base+1];
      if (b1>=0) {
        const bc=cyan[b1], ba=amber[b1], hb=bc+ba, prev=flowX[base];
        cCol=col+1; cIdx=b1; cC=bc; cA=ba; cH=hb;
        if (!dryA || hb>=MIN_DEPTH) {
          const head=ha-hb;
          if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
            const ah=head<0?-head:head;
            const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
            const pressure=slope<-.12?-.12:slope>.12?.12:slope;
            const flux=prev*.48+pressure*.16;
            const donor=flux>=0?ha:hb;
            const avail=donor>ADHESION?(donor-ADHESION)*MAX_FACE_SHARE:0;
            const af=flux<0?-flux:flux;
            const amount=af<avail?af:avail;
            let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
            if (q!==0 && hasBarrier) {
              let bv=barrierX[base];
              if (bv===0) barrierX[base]=bv=paint.barrier(a,b1)?2:1;
              if (bv===2) q=0;
            }
            if (q!==prev) flowX[base]=q;
            if (q!==0) {
              let c=0, t=0;
              if (q>0) {
                if (ac===ha) c=q;
                else if (aa===ha) t=q;
                else {c=q*ac/ha; t=q-c;}
              } else {
                if (bc===hb) c=q;
                else if (ba===hb) t=q;
                else {c=q*bc/hb; t=q-c;}
              }
              if (c!==0) {deltaC[a]-=c;deltaC[b1]+=c;}
              if (t!==0) {deltaA[a]-=t;deltaA[b1]+=t;}
              if (!touched[a]) {touched[a]=1;changedList[cc++]=a;}
              if (!touched[b1]) {touched[b1]=1;changedList[cc++]=b1;}
              mE|=1<<bit;
            }
          }
        } else if (prev!==0) flowX[base]=0;
      } else {
        cCol=col+1; cIdx=-1;
        if (flowX[base]!==0 && (!hasStairs || !stairEdges.has(base))) flowX[base]=0;
      }
    }
    if (canDown) {
      const b2=surface[base+w];
      if (b2>=0) {
        const bc=cyan[b2], ba=amber[b2], hb=bc+ba, prev=flowZ[base];
        if (!dryA || hb>=MIN_DEPTH) {
          const head=ha-hb;
          if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
            const ah=head<0?-head:head;
            const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
            const pressure=slope<-.12?-.12:slope>.12?.12:slope;
            const flux=prev*.48+pressure*.16;
            const donor=flux>=0?ha:hb;
            const avail=donor>ADHESION?(donor-ADHESION)*MAX_FACE_SHARE:0;
            const af=flux<0?-flux:flux;
            const amount=af<avail?af:avail;
            let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
            if (q!==0 && hasBarrier) {
              let bv=barrierZ[base];
              if (bv===0) barrierZ[base]=bv=paint.barrier(a,b2)?2:1;
              if (bv===2) q=0;
            }
            if (q!==prev) flowZ[base]=q;
            if (q!==0) {
              let c=0, t=0;
              if (q>0) {
                if (ac===ha) c=q;
                else if (aa===ha) t=q;
                else {c=q*ac/ha; t=q-c;}
              } else {
                if (bc===hb) c=q;
                else if (ba===hb) t=q;
                else {c=q*bc/hb; t=q-c;}
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

// Compact monomorphic kernel for a single 32-cell flat-bed word (~92% of all words)
// with east-neighbor register carry across contiguous active bits.
function runWordFlat(
  word,rowBase,colBase,w,canDown,
  surface,cyan,amber,boss,flowX,flowZ,barrierX,barrierZ,
  deltaC,deltaA,deltaB,touched,changedList,cc,
  hasBarrier,hasStairs,stairEdges,paint,wakeState
) {
  const base0=rowBase+colBase;
  let mE=0, mS=0;
  let cCol=-2, cIdx=-1, cC=0, cA=0, cB=0, cH=0;
  while (word!==0) {
    const bit=31-Math.clz32(word & -word);
    word&=word-1;
    const col=colBase+bit, base=base0+bit;
    let a, ac, aa, ab, ha;
    if (col===cCol) {
      a=cIdx; ac=cC; aa=cA; ab=cB; ha=cH;
    } else {
      a=surface[base];
      if (a<0) continue;
      ac=cyan[a]; aa=amber[a]; ab=boss?boss[a]:0; ha=ac+aa+ab;
    }
    if (a<0) continue;
    const dryA=ha<MIN_DEPTH;
    if (col+1<w) {
      const b1=surface[base+1];
      if (b1>=0) {
        const bc=cyan[b1], ba=amber[b1], bb=boss?boss[b1]:0, hb=bc+ba+bb, prev=flowX[base];
        cCol=col+1; cIdx=b1; cC=bc; cA=ba; cB=bb; cH=hb;
        if (!dryA || hb>=MIN_DEPTH) {
          const head=ha-hb;
          if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
            const ah=head<0?-head:head;
            const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
            const pressure=slope<-.12?-.12:slope>.12?.12:slope;
            const flux=prev*.48+pressure*.16;
            const donor=flux>=0?ha:hb;
            const avail=donor>ADHESION?(donor-ADHESION)*MAX_FACE_SHARE:0;
            const af=flux<0?-flux:flux;
            const amount=af<avail?af:avail;
            let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
            if (q!==0 && hasBarrier) {
              let bv=barrierX[base];
              if (bv===0) barrierX[base]=bv=paint.barrier(a,b1)?2:1;
              if (bv===2) q=0;
            }
            if (q!==prev) flowX[base]=q;
            if (q!==0) {
              let c=0, t=0, k=0;
              if (q>0) {
                if (ac===ha) {c=q;}
                else if (aa===ha) {t=q;}
                else if (ab===ha) {k=q;}
                else {const qi=q/ha;c=qi*ac;t=qi*aa;k=q-c-t;}
              } else {
                if (bc===hb) {c=q;}
                else if (ba===hb) {t=q;}
                else if (bb===hb) {k=q;}
                else {const qi=q/hb;c=qi*bc;t=qi*ba;k=q-c-t;}
              }
              if (c!==0) {deltaC[a]-=c;deltaC[b1]+=c;}
              if (t!==0) {deltaA[a]-=t;deltaA[b1]+=t;}
              if (k!==0 && deltaB) {deltaB[a]-=k;deltaB[b1]+=k;}
              if (!touched[a]) {touched[a]=1;changedList[cc++]=a;}
              if (!touched[b1]) {touched[b1]=1;changedList[cc++]=b1;}
              mE|=1<<bit;
            }
          }
        } else if (prev!==0) flowX[base]=0;
      } else {
        cCol=col+1; cIdx=-1;
        if (flowX[base]!==0 && (!hasStairs || !stairEdges.has(base))) flowX[base]=0;
      }
    }
    if (canDown) {
      const b2=surface[base+w];
      if (b2>=0) {
        const bc=cyan[b2], ba=amber[b2], bb=boss?boss[b2]:0, hb=bc+ba+bb, prev=flowZ[base];
        if (!dryA || hb>=MIN_DEPTH) {
          const head=ha-hb;
          if (prev!==0 || head<=-ZERO_HEAD || head>=ZERO_HEAD) {
            const ah=head<0?-head:head;
            const slope=ah>.0015?(head>0?ah-.0015:.0015-ah):0;
            const pressure=slope<-.12?-.12:slope>.12?.12:slope;
            const flux=prev*.48+pressure*.16;
            const donor=flux>=0?ha:hb;
            const avail=donor>ADHESION?(donor-ADHESION)*MAX_FACE_SHARE:0;
            const af=flux<0?-flux:flux;
            const amount=af<avail?af:avail;
            let q=amount>=MIN_FLUX?(flux>0?amount:-amount):0;
            if (q!==0 && hasBarrier) {
              let bv=barrierZ[base];
              if (bv===0) barrierZ[base]=bv=paint.barrier(a,b2)?2:1;
              if (bv===2) q=0;
            }
            if (q!==prev) flowZ[base]=q;
            if (q!==0) {
              let c=0, t=0, k=0;
              if (q>0) {
                if (ac===ha) {c=q;}
                else if (aa===ha) {t=q;}
                else if (ab===ha) {k=q;}
                else {const qi=q/ha;c=qi*ac;t=qi*aa;k=q-c-t;}
              } else {
                if (bc===hb) {c=q;}
                else if (ba===hb) {t=q;}
                else if (bb===hb) {k=q;}
                else {const qi=q/hb;c=qi*bc;t=qi*ba;k=q-c-t;}
              }
              if (c!==0) {deltaC[a]-=c;deltaC[b2]+=c;}
              if (t!==0) {deltaA[a]-=t;deltaA[b2]+=t;}
              if (k!==0 && deltaB) {deltaB[a]-=k;deltaB[b2]+=k;}
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
  surface,cyan,amber,boss,bed,flowX,flowZ,barrierX,barrierZ,
  deltaC,deltaA,deltaB,touched,changedList,cc,
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
    const ac=cyan[a], aa=amber[a], ab=boss?boss[a]:0, ha=ac+aa+ab, dryA=ha<MIN_DEPTH, bedA=bed[a];
    if (col+1<w) {
      const b1=surface[base+1];
      if (b1>=0) {
        const bc=cyan[b1], ba=amber[b1], bb=boss?boss[b1]:0, hb=bc+ba+bb, prev=flowX[base];
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
                let c=0, t=0, k=0;
                if (q>0) {
                  if (ac===ha) {c=q;}
                  else if (aa===ha) {t=q;}
                  else if (ab===ha) {k=q;}
                  else {c=q*(ac/ha);t=q*(aa/ha);k=q-c-t;}
                } else {
                  if (bc===hb) {c=q;}
                  else if (ba===hb) {t=q;}
                  else if (bb===hb) {k=q;}
                  else {c=q*(bc/hb);t=q*(ba/hb);k=q-c-t;}
                }
                if (c!==0) {deltaC[a]-=c;deltaC[b1]+=c;}
                if (t!==0) {deltaA[a]-=t;deltaA[b1]+=t;}
                if (k!==0 && deltaB) {deltaB[a]-=k;deltaB[b1]+=k;}
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
        const bc=cyan[b2], ba=amber[b2], bb=boss?boss[b2]:0, hb=bc+ba+bb, prev=flowZ[base];
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
                let c=0, t=0, k=0;
                if (q>0) {
                  if (ac===ha) {c=q;}
                  else if (aa===ha) {t=q;}
                  else if (ab===ha) {k=q;}
                  else {c=q*(ac/ha);t=q*(aa/ha);k=q-c-t;}
                } else {
                  if (bc===hb) {c=q;}
                  else if (ba===hb) {t=q;}
                  else if (bb===hb) {k=q;}
                  else {c=q*(bc/hb);t=q*(ba/hb);k=q-c-t;}
                }
                if (c!==0) {deltaC[a]-=c;deltaC[b2]+=c;}
                if (t!==0) {deltaA[a]-=t;deltaA[b2]+=t;}
                if (k!==0 && deltaB) {deltaB[a]-=k;deltaB[b2]+=k;}
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
  count,list,cyan,amber,deltaC,deltaA,boss,deltaB,touched,ownerArr,pixels,floorByte,
  dirtyRows,countArr,zoneCount,ls,w,tilesWide,regionTiles,netDirty,netTiles,paint
) {
  const ls2=ls*2, ls3=ls*3, ls4=ls*4, ls5=ls*5, ls6=ls*6;
  const isDefaultW=w===640;
  const zoneBossCount=paint.zoneBossCount;
  const wetWords=paint.wetTileWords, wetStride=paint.wetTileStride, twpr=paint.tileWordsPerRow;
  let dMask=paint.dirtyMask, changedAny=false;
  for (let i=0;i<count;i++) {
    const idx=list[i];
    const dc=deltaC[idx], da=deltaA[idx], db=deltaB?deltaB[idx]:0;
    let nc=cyan[idx], na=amber[idx], nb=boss?boss[idx]:0;
    if (dc!==0) {cyan[idx]=nc+dc;nc=cyan[idx];deltaC[idx]=0;}
    if (da!==0) {amber[idx]=na+da;na=amber[idx];deltaA[idx]=0;}
    if (db!==0 && boss) {boss[idx]=nb+db;nb=boss[idx];deltaB[idx]=0;}
    touched[idx]=0;
    const depth=nc+na+nb;
    const ow=depth<COVERAGE?0:(nb>nc && nb>na)?3:nc>=na?1:2;
    const prev=ownerArr[idx];
    const thick=depth>=.085?255:depth<=0?0:(depth*3000+.5)|0;
    const pi=idx<<2;
    if (ow===prev && pixels[pi+2]===thick && (depth<=0 || pixels[pi+3]!==0)) continue;
    const layer=idx<ls?0:idx<ls2?1:idx<ls3?2:idx<ls4?3:idx<ls5?4:idx<ls6?5:6;
    if (ow!==prev) {
      const zIdx=ZONE_FOR_LAYER[layer];
      const zc=zoneCount[zIdx];
      if (prev===1 || prev===2) {countArr[prev-1]--;zc[prev-1]--;}
      else if (prev===3) {paint.bossCount--;zoneBossCount[zIdx]--;}
      if (ow===1 || ow===2) {countArr[ow-1]++;zc[ow-1]++;}
      else if (ow===3) {paint.bossCount++;zoneBossCount[zIdx]++;}
      ownerArr[idx]=ow;
      pixels[pi]=(ow===1 || ow===3)?255:0;
      pixels[pi+1]=(ow===2 || ow===3)?255:0;
    }
    pixels[pi+2]=thick;
    pixels[pi+3]=depth>0?floorByte[idx]:0;
    const loc=idx-layer*ls;
    const row=isDefaultW?((loc>>7)*52429)>>>18:(loc/w)|0;
    const col=loc-row*w;
    if (depth>0) {
      if (wetWords) {
        const tx=col>>4;
        wetWords[layer*wetStride+(row>>4)*twpr+(tx>>5)]|=1<<(tx&31);
      }
      if (layer===0 || layer===1 || layer===4) {
        const ab=paint.activeBox;
        if (ab) {
          const wx=(col+.5)*paint.invW-paint.boundX, wz=(row+.5)*paint.invH-paint.boundZ;
          if (wx-1<ab[0]) ab[0]=wx-1;
          if (wx+1>ab[1]) ab[1]=wx+1;
          if (wz-1<ab[2]) ab[2]=wz-1;
          if (wz+1>ab[3]) ab[3]=wz+1;
        }
      }
    }
    const at=layer<<1;
    if (row<dirtyRows[at]) dirtyRows[at]=row;
    if (row>dirtyRows[at+1]) dirtyRows[at+1]=row;
    dMask|=1<<layer;
    changedAny=true;
    if (netDirty) {
      const id=layer*regionTiles+(row>>4)*tilesWide+(col>>4);
      netDirty.add(id);
      netTiles.add(id);
    }
  }
  paint.dirtyMask=dMask;
  if (changedAny) paint.version=(paint.version+1)|0;
}

// Shared scratch buffers for zero-alloc analytic Paint.setWorld rasterization.
let _swY=null, _swLayer=null, _swBlocked=null, _swStair=null;

function initZoneCells(cellY,cellLayer,cellBlocked,cellStair,w,left,right,top,bottom,baseY,baseLayer,zIdx,zBoundX,zBoundZ,boundX,boundZ,invW,invH) {
  const rad=.095, limX=zBoundX-rad, limZ=zBoundZ-rad;
  const cityR2=(CITY_RADIUS-rad)*(CITY_RADIUS-rad);
  for (let iz=top;iz<=bottom;iz++) {
    const z=(iz+.5)*invH-boundZ, rb=iz*w;
    if (zIdx>0 && (z<-limZ || z>limZ)) {
      cellBlocked.fill(1,rb+left,rb+right+1);
      continue;
    }
    cellY.fill(baseY,rb+left,rb+right+1);
    cellLayer.fill(baseLayer,rb+left,rb+right+1);
    cellStair.fill(0,rb+left,rb+right+1);
    if (zIdx===0) {
      // Zone 0 BOUNDS=[53.5,35] sits completely inside CITY_RADIUS=500; fast check corners!
      const xEdge=Math.max(Math.abs((left+.5)*invW-boundX),Math.abs((right+.5)*invW-boundX));
      if (xEdge*xEdge+z*z<=cityR2) {
        cellBlocked.fill(0,rb+left,rb+right+1);
      } else {
        for (let ix=left;ix<=right;ix++) {
          const lx=(ix+.5)*invW-boundX;
          cellBlocked[rb+ix]=(lx*lx+z*z>cityR2)?1:0;
        }
      }
    } else {
      cellBlocked.fill(0,rb+left,rb+right+1);
      for (let ix=left;ix<=right;ix++) {
        const lx=(ix+.5)*invW-boundX;
        if (lx<-limX || lx>limX) cellBlocked[rb+ix]=1;
        else break;
      }
      for (let ix=right;ix>=left;ix--) {
        const lx=(ix+.5)*invW-boundX;
        if (lx<-limX || lx>limX) cellBlocked[rb+ix]=1;
        else break;
      }
    }
  }
}

function rasterizeSlabs(cellY,cellLayer,slabs,w,left,right,top,bottom,zx,boundX,boundZ,invW,invH,scaleX,scaleZ) {
  for (let si=slabs.length-1;si>=0;si--) {
    const s=slabs[si];
    const ix0=Math.max(left,Math.ceil((s.x0-zx+boundX)*scaleX-.5));
    const ix1=Math.min(right,Math.floor((s.x1-zx+boundX)*scaleX-.5));
    const iz0=Math.max(top,Math.ceil((s.z0+boundZ)*scaleZ-.5));
    const iz1=Math.min(bottom,Math.floor((s.z1+boundZ)*scaleZ-.5));
    if (ix0>ix1 || iz0>iz1) continue;
    const sLayer=s.layer, sFrom=s.from, sDy=s.dy;
    if (!sDy) {
      for (let iz=iz0;iz<=iz1;iz++) {
        const rb=iz*w;
        cellY.fill(sFrom,rb+ix0,rb+ix1+1);
        cellLayer.fill(sLayer,rb+ix0,rb+ix1+1);
      }
    } else if (s.isX) {
      const xOff=zx-boundX-s.x0, invS=s.invSpan;
      for (let iz=iz0;iz<=iz1;iz++) {
        const rb=iz*w;
        for (let ix=ix0;ix<=ix1;ix++) {
          cellY[rb+ix]=sFrom+sDy*((ix+.5)*invW+xOff)*invS;
          cellLayer[rb+ix]=sLayer;
        }
      }
    } else {
      const zOff=-boundZ-s.z0, invS=s.invSpan;
      for (let iz=iz0;iz<=iz1;iz++) {
        const yVal=sFrom+sDy*((iz+.5)*invH+zOff)*invS, rb=iz*w;
        cellY.fill(yVal,rb+ix0,rb+ix1+1);
        cellLayer.fill(sLayer,rb+ix0,rb+ix1+1);
      }
    }
  }
}

function rasterizeSolids(cellY,cellBlocked,boxes,w,left,right,top,bottom,zx,boundX,boundZ,invW,invH,scaleX,scaleZ,minFloorY,maxFloorY) {
  const rad=.095, rad2=rad*rad;
  const minYCut=minFloorY+.05, maxYCut=maxFloorY+1.68;
  for (let bi=0;bi<boxes.length;bi++) {
    const b=boxes[bi];
    const by0=b.y0, by1=b.y1;
    if (by1<=minYCut || by0>=maxYCut) continue;
    const ix0=Math.max(left,Math.floor((b.x0-rad-zx+boundX)*scaleX));
    const ix1=Math.min(right,Math.ceil((b.x1+rad-zx+boundX)*scaleX));
    const iz0=Math.max(top,Math.floor((b.z0-rad+boundZ)*scaleZ));
    const iz1=Math.min(bottom,Math.ceil((b.z1+rad+boundZ)*scaleZ));
    if (ix0>ix1 || iz0>iz1) continue;
    const bx0=b.x0, bx1=b.x1, bz0=b.z0, bz1=b.z1;
    const coversAllY=by0<=minYCut && by1>=maxYCut;
    const inX0=Math.max(ix0,Math.ceil((bx0-zx+boundX)*scaleX-.5));
    const inX1=Math.min(ix1,Math.floor((bx1-zx+boundX)*scaleX-.5));
    for (let iz=iz0;iz<=iz1;iz++) {
      const z=(iz+.5)*invH-boundZ;
      const dz=z<bz0?z-bz0:z>bz1?z-bz1:0;
      const dz2=dz*dz;
      if (dz2>=rad2) continue;
      const rb=iz*w;
      if (coversAllY && dz2===0 && inX0<=inX1) {
        cellBlocked.fill(1,rb+inX0,rb+inX1+1);
        for (let ix=ix0;ix<inX0;ix++) {
          const x=(ix+.5)*invW-boundX+zx, dx=x-bx0;
          if (dx*dx<rad2) cellBlocked[rb+ix]=1;
        }
        for (let ix=inX1+1;ix<=ix1;ix++) {
          const x=(ix+.5)*invW-boundX+zx, dx=x-bx1;
          if (dx*dx<rad2) cellBlocked[rb+ix]=1;
        }
        continue;
      }
      for (let ix=ix0;ix<=ix1;ix++) {
        const base=rb+ix;
        if (cellBlocked[base]) continue;
        const fy=cellY[base];
        if (fy+.05>=by1 || fy+1.68<=by0) continue;
        const x=(ix+.5)*invW-boundX+zx;
        const dx=x<bx0?x-bx0:x>bx1?x-bx1:0;
        if (dx*dx+dz2<rad2) cellBlocked[base]=1;
      }
    }
  }
}

function commitZoneCells(paint,cellY,cellLayer,cellBlocked,cellStair,w,left,right,top,bottom,zx,baseY,baseLayer,boundX,boundZ,invW,invH) {
  const layerSize=paint.layerSize, mask=paint.mask, floorByte=paint.floorByte;
  const surface=paint.surface, bed=paint.bed, visualOnly=paint.visualOnly;
  const zoneTotal=paint.zoneTotal, stairCells=paint.stairCells;
  const baseByte=encodeFilmHeight(baseY);
  const baseLayerOff=baseLayer*layerSize, baseRegOff=REGION_FOR_LAYER[baseLayer]*layerSize;
  const baseZone=ZONE_FOR_LAYER[baseLayer];
  let addedTotal=0, addedBaseZone=0;
  for (let iz=top;iz<=bottom;iz++) {
    const z=(iz+.5)*invH-boundZ, rb=iz*w;
    for (let ix=left;ix<=right;ix++) {
      const base=rb+ix;
      if (cellBlocked[base]) continue;
      const stCode=cellStair[base];
      if (!stCode) {
        const layer=cellLayer[base], fy=cellY[base];
        if (layer===baseLayer && fy===baseY) {
          const index=baseLayerOff+base;
          mask[index]=1;
          floorByte[index]=baseByte;
          if (!visualOnly) {
            surface[baseRegOff+base]=index;
            bed[index]=baseY;
          }
          addedTotal++;
          addedBaseZone++;
        } else {
          const index=base+layer*layerSize;
          mask[index]=1;
          floorByte[index]=encodeFilmHeight(fy);
          if (!visualOnly) {
            surface[REGION_FOR_LAYER[layer]*layerSize+base]=index;
            bed[index]=fy;
          }
          addedTotal++;
          zoneTotal[ZONE_FOR_LAYER[layer]]++;
        }
      } else {
        const layer=cellLayer[base], fy=cellY[base];
        const x=(ix+.5)*invW-boundX+zx;
        const lane=stairLane(x,z);
        if (lane.level!==(lane.t<=STAIR_SEAM?0:1)) continue;
        const index=base+layer*layerSize;
        const regionBase=REGION_FOR_LAYER[layer]*layerSize+base;
        stairCells.set(base,{stair:STAIRS[stCode-1],index,regionBase});
        mask[index]=1;
        floorByte[index]=encodeFilmHeight(fy);
        if (!visualOnly) {
          surface[regionBase]=index;
          bed[index]=fy;
        }
        addedTotal++;
        zoneTotal[ZONE_FOR_LAYER[layer]]++;
      }
    }
  }
  zoneTotal[baseZone]+=addedBaseZone;
  paint.total+=addedTotal;
}

// Content-addressed static Paint topology snapshot cache (shared immutable
// mask/floorByte/surface/bed/flatWordMask/stairs across Worlds with identical blueprints).
const _PAINT_TOPO_CACHE=new Map();

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
    this._cellCount=n;
    this._regionCellCount=this.layerSize*INK_REGIONS;
    this.layers=PAINT_LAYERS;
    this.pixels=new Uint8Array(n*4);
    this._mask=null;
    this._floorByte=null;
    this._sharedTopology=false;
    this.owner=new Uint8Array(n);
    this.count=[0,0];
    this.bossCount=0;
    this.bossDirty=false;
    this.total=0;
    this.zoneCount=ZONES.map(()=>[0,0]);
    this.zoneBossCount=ZONES.map(()=>0);
    this.zoneTotal=ZONES.map(()=>0);
    this.dirtyMask=(1<<this.layers)-1;
    this.version=1;
    this._hasWorld=false;
    // First and last changed row of each layer, so the renderer uploads only
    // the band of the ink texture that moved.
    this.dirtyRows=new Int32Array(PAINT_LAYERS*2);
    this.touchLayers((1<<this.layers)-1);
    this.visualOnly=visualOnly;
    this.tilesWide=Math.ceil(this.w/TILE);
    this.tilesHigh=Math.ceil(this.h/TILE);
    this.regionTiles=this.tilesWide*this.tilesHigh;
    this.tileWordsPerRow=(this.tilesWide+31)>>>5;
    this.wetTileStride=this.tilesHigh*this.tileWordsPerRow;
    this.wetTileWords=new Uint32Array(PAINT_LAYERS*this.wetTileStride);
    // Conservative world XZ bounds [minX,maxX,minZ,maxZ] of Zone-0 painted cells (layers 0,1,4).
    this.activeBox=new Float32Array([Infinity,-Infinity,Infinity,-Infinity]);
    this.stairCells=new Map();
    this.barrierWorld=null;
    this._surface=null;
    this._bed=null;
    this._deltaC=null;
    this._deltaA=null;
    this._deltaB=null;
    this._touched=null;
    this._barrierX=null;
    this._barrierZ=null;
    if (visualOnly) return;
    this.cyan=new Float32Array(n);
    this.amber=new Float32Array(n);
    this.boss=new Float32Array(n);
    this.flowX=new Float32Array(this._regionCellCount);
    this.flowZ=new Float32Array(this._regionCellCount);
    this.flowTileWords=new Uint32Array(INK_REGIONS*this.wetTileStride);
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

  get mask() {return this._mask ?? (this._mask=new Uint8Array(this._cellCount));}
  set mask(v) {this._mask=v;}
  get floorByte() {return this._floorByte ?? (this._floorByte=new Uint8Array(this._cellCount));}
  set floorByte(v) {this._floorByte=v;}
  get surface() {return this.visualOnly?undefined:(this._surface ?? (this._surface=new Int32Array(this._regionCellCount).fill(-1)));}
  set surface(v) {this._surface=v;}
  get bed() {return this.visualOnly?undefined:(this._bed ?? (this._bed=new Float32Array(this._cellCount)));}
  set bed(v) {this._bed=v;}
  get deltaC() {return this.visualOnly?undefined:(this._deltaC ?? (this._deltaC=new Float32Array(this._cellCount)));}
  set deltaC(v) {this._deltaC=v;}
  get deltaA() {return this.visualOnly?undefined:(this._deltaA ?? (this._deltaA=new Float32Array(this._cellCount)));}
  set deltaA(v) {this._deltaA=v;}
  get deltaB() {return this.visualOnly?undefined:(this._deltaB ?? (this._deltaB=new Float32Array(this._cellCount)));}
  set deltaB(v) {this._deltaB=v;}
  get touched() {return this.visualOnly?undefined:(this._touched ?? (this._touched=new Uint8Array(this._cellCount)));}
  set touched(v) {this._touched=v;}
  get barrierX() {return this.visualOnly?undefined:(this._barrierX ?? (this._barrierX=new Uint8Array(this._regionCellCount)));}
  set barrierX(v) {this._barrierX=v;}
  get barrierZ() {return this.visualOnly?undefined:(this._barrierZ ?? (this._barrierZ=new Uint8Array(this._regionCellCount)));}
  set barrierZ(v) {this._barrierZ=v;}

  growChangedList(minLen) {
    let cap=this.changedList.length;
    while (cap<minLen) cap<<=1;
    const next=new Int32Array(cap);
    next.set(this.changedList);
    this.changedList=next;
    return next;
  }

  // Analytic Slab & Obstacle Span Rasterizer with Content-Addressed Static Topology
  // Snapshot Cache: shares immutable topology buffers across unmodified blueprint worlds.
  setWorld(world) {
    this.barrierWorld=world.geometry??null;
    const cacheable=!!(world._blueprintId>0 && !world._solidsVersion && !world.dynamicStage?.active);
    const cacheKey=cacheable?(this.w+'x'+this.h+':'+(this.visualOnly?1:0)+':'+world._blueprintId):'';
    if (cacheable) {
      const snap=_PAINT_TOPO_CACHE.get(cacheKey);
      if (snap) {
        if (this._hasWorld) {
          this._barrierX?.fill(0);
          this._barrierZ?.fill(0);
        }
        this._hasWorld=true;
        this._sharedTopology=true;
        this._mask=snap.mask;
        this._floorByte=snap.floorByte;
        this._surface=snap.surface;
        this._bed=snap.bed;
        this.stairCells=snap.stairCells;
        if (!this.visualOnly) {
          this.stairEdges=snap.stairEdges;
          this.stairTiles=snap.stairTiles;
        }
        this.total=snap.total;
        for (let i=0;i<snap.zoneTotal.length;i++) this.zoneTotal[i]=snap.zoneTotal[i];
        return;
      }
    }
    this.total=0;
    this.zoneTotal.fill(0);
    if (this._sharedTopology || !this._mask) {
      this._mask=new Uint8Array(this._cellCount);
      this._floorByte=new Uint8Array(this._cellCount);
      this.stairCells=new Map();
      if (!this.visualOnly) {
        this._surface=new Int32Array(this._regionCellCount).fill(-1);
        this._bed=new Float32Array(this._cellCount);
        this.stairEdges=new Map();
        this.stairTiles=new Map();
      }
      this._sharedTopology=false;
    } else if (this._hasWorld) {
      this._mask.fill(0);
      this._floorByte.fill(0);
      this._surface?.fill(-1);
      this.stairCells.clear();
      this.stairEdges?.clear();
      this.stairTiles?.clear();
    }
    if (this._hasWorld) {
      this._barrierX?.fill(0);
      this._barrierZ?.fill(0);
    }
    this._hasWorld=true;
    const w=this.w, h=this.h, boundX=this.boundX, boundZ=this.boundZ, layerSize=this.layerSize;
    const invW=this.invW, invH=this.invH, scaleX=1/invW, scaleZ=1/invH;
    const mask=this._mask, floorByte=this._floorByte, surface=this._surface, bed=this._bed;
    const visualOnly=this.visualOnly, zoneTotal=this.zoneTotal;

    const useAnalytic=!!(world.zoneSlabs && world.solids && !world.dynamicStage?.active);
    if (useAnalytic) {
      if (!_swY || _swY.length<layerSize) {
        _swY=new Float32Array(layerSize);
        _swLayer=new Uint8Array(layerSize);
        _swBlocked=new Uint8Array(layerSize);
        _swStair=new Int8Array(layerSize);
      }
      const cellY=_swY, cellLayer=_swLayer, cellBlocked=_swBlocked, cellStair=_swStair;
      const solidBoxes=world._solidBoxes, boxes=world._boxes, dis=world._solidDisabled, solids=world.solids;
      const zoneSolids=[[],[],[],[]];
      for (let i=0;i<solids.length;i++) {
        if (dis && dis[i]) continue;
        const raw=solids[i];
        const box=boxes?boxes[i]:solidBoxes?.get(raw);
        if (box?.disabled) continue;
        const x0=box?box.x0:raw.min[0];
        zoneSolids[zoneOf(x0)].push(box??{x0:raw.min[0],y0:raw.min[1],z0:raw.min[2],x1:raw.max[0],y1:raw.max[1],z1:raw.max[2]});
      }
      for (let zIdx=0;zIdx<ZONES.length;zIdx++) {
        const zone=ZONES[zIdx];
        const [zBoundX,zBoundZ]=zone.bounds, zx=zone.x, baseY=zone.y, baseLayer=zone.layer;
        const left=Math.floor((1-zBoundX/boundX)*.5*w);
        const right=w-1-left;
        const top=Math.floor((1-zBoundZ/boundZ)*.5*h);
        const bottom=h-1-top;
        initZoneCells(cellY,cellLayer,cellBlocked,cellStair,w,left,right,top,bottom,baseY,baseLayer,zIdx,zBoundX,zBoundZ,boundX,boundZ,invW,invH);
        const slabs=world.zoneSlabs[zIdx];
        if (slabs.length) rasterizeSlabs(cellY,cellLayer,slabs,w,left,right,top,bottom,zx,boundX,boundZ,invW,invH,scaleX,scaleZ);
        let minFloorY=baseY, maxFloorY=world.zoneMaxFloorY?world.zoneMaxFloorY[zIdx]:baseY+12;
        if (zIdx<2) {
          if (zIdx===0) minFloorY=Math.min(minFloorY,-5);
          for (let stIdx=0;stIdx<STAIRS.length;stIdx++) {
            const st=STAIRS[stIdx];
            const sxA=st.x, sxB=st.x+st.dir*STAIR_RUN;
            const minSX=sxA<sxB?sxA:sxB, maxSX=sxA>sxB?sxA:sxB;
            const ix0=Math.max(left,Math.floor((minSX+boundX)*scaleX)-1);
            const ix1=Math.min(right,Math.ceil((maxSX+boundX)*scaleX)+1);
            const iz0=Math.max(top,Math.floor((st.z-1.5+boundZ)*scaleZ)-1);
            const iz1=Math.min(bottom,Math.ceil((st.z+1.5+boundZ)*scaleZ)+1);
            for (let iz=iz0;iz<=iz1;iz++) {
              const z=(iz+.5)*invH-boundZ, rb=iz*w;
              for (let ix=ix0;ix<=ix1;ix++) {
                const x=(ix+.5)*invW-boundX+zx;
                const fl=stairFloor(x,z);
                if (!fl) continue;
                const base=rb+ix;
                cellY[base]=fl.y;
                cellLayer[base]=fl.layer;
                cellStair[base]=stIdx+1;
                if (fl.y<minFloorY) minFloorY=fl.y;
                if (fl.y>maxFloorY) maxFloorY=fl.y;
              }
            }
          }
        }
        if (zIdx===0 && world.elevatedList?.length) {
          const elList=world.elevatedList;
          for (let ei=0;ei<elList.length;ei++) {
            const r=elList[ei];
            const ix0=Math.max(left,Math.ceil((r.x0+boundX)*scaleX-.5));
            const ix1=Math.min(right,Math.floor((r.x1+boundX)*scaleX-.5));
            const iz0=Math.max(top,Math.ceil((r.z0+boundZ)*scaleZ-.5));
            const iz1=Math.min(bottom,Math.floor((r.z1+boundZ)*scaleZ-.5));
            if (ix0>ix1 || iz0>iz1) continue;
            for (let iz=iz0;iz<=iz1;iz++) {
              const z=(iz+.5)*invH-boundZ, ramp=r.invZ*(r.z1-z), rb=iz*w;
              const rLo=ramp-.045, rHi=ramp-2.165;
              for (let ix=ix0;ix<=ix1;ix++) {
                const base=rb+ix, fy=cellY[base];
                if (fy<rLo && fy>rHi) cellBlocked[base]=1;
              }
            }
          }
        }
        if (zoneSolids[zIdx].length) {
          rasterizeSolids(cellY,cellBlocked,zoneSolids[zIdx],w,left,right,top,bottom,zx,boundX,boundZ,invW,invH,scaleX,scaleZ,minFloorY,maxFloorY);
        }
        commitZoneCells(this,cellY,cellLayer,cellBlocked,cellStair,w,left,right,top,bottom,zx,baseY,baseLayer,boundX,boundZ,invW,invH);
      }
    } else {
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
    const tIz0=Math.max(0,Math.ceil((RAIL.z-RAIL.halfWidth+boundZ)*scaleZ-.5));
    const tIz1=Math.min(h-1,Math.floor((RAIL.z+RAIL.halfWidth+boundZ)*scaleZ-.5));
    const tIx0=Math.max(0,Math.ceil((-RAIL.edge+boundX)*scaleX-.5));
    const tIx1=Math.min(w-1,Math.floor((RAIL.edge+boundX)*scaleX-.5));
    for (let iz=tIz0;iz<=tIz1;iz++) {
      const z=(iz+.5)*invH-boundZ;
      if (Math.abs(z-RAIL.z)>=RAIL.halfWidth) continue;
      const rowBase=iz*w;
      for (let ix=tIx0;ix<=tIx1;ix++) {
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
    if (!visualOnly) {
      bed._flatWordMask=cacheable?buildFlatWordMask(surface,bed,w,h,layerSize,this.wordsPerRow):null;
    }
    if (cacheable) {
      this._sharedTopology=true;
      _PAINT_TOPO_CACHE.set(cacheKey,{
        mask,floorByte,surface,bed,
        stairCells:this.stairCells,
        stairEdges:visualOnly?null:this.stairEdges,
        stairTiles:visualOnly?null:this.stairTiles,
        total:this.total,
        zoneTotal:this.zoneTotal.slice()
      });
    }
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
    this.version=(this.version+1)|0;
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
    this.version=(this.version+1)|0;
  }

  expandActive(x,z,pad=1) {
    const ab=this.activeBox;
    if (x-pad<ab[0]) ab[0]=x-pad;
    if (x+pad>ab[1]) ab[1]=x+pad;
    if (z-pad<ab[2]) ab[2]=z-pad;
    if (z+pad>ab[3]) ab[3]=z+pad;
  }

  reset() {
    for (const buffer of [
      this.owner,this.pixels,this.cyan,this.amber,this.boss,this._deltaC,this._deltaA,this._deltaB,
      this.flowX,this.flowZ,this.flowTileWords,this._touched,this.awakeBits,this.workBits,
      this.awakeRowMask,this.workRowMask,this.wetTileWords
    ]) if (buffer) buffer.fill(0);
    this.activeBox[0]=Infinity;
    this.activeBox[1]=-Infinity;
    this.activeBox[2]=Infinity;
    this.activeBox[3]=-Infinity;
    this.awakeCount=0;
    this.workCount=0;
    this.changedCount=0;
    this.stairAwake=false;
    this.stairWork=false;
    this.netDirty?.clear();
    this.netTiles?.clear();
    this.count=[0,0];
    this.bossCount=0;
    this.bossDirty=false;
    this.zoneCount=ZONES.map(()=>[0,0]);
    this.zoneBossCount.fill(0);
    this.time=0;
    this.touchLayers((1<<this.layers)-1);
  }

  // Hierarchical 16x16 Wet-Tile Bitboard Wash: visits ONLY non-empty painted tiles
  // via CLZ bit iteration with lazy dry-tile eviction (100% bit-identical to full scan).
  wash(layerMask,amount,minX=-Infinity,maxX=Infinity,minZ=-Infinity,maxZ=Infinity) {
    if (this.visualOnly || !(amount>0)) return 0;
    const w=this.w, h=this.h, ls=this.layerSize, bx=this.boundX, bz=this.boundZ;
    const cyan=this.cyan, amber=this.amber, boss=this.boss, flowX=this.flowX, flowZ=this.flowZ;
    const ownerArr=this.owner, pixels=this.pixels, floorByte=this.floorByte;
    const countArr=this.count, zoneCount=this.zoneCount, zoneBossCount=this.zoneBossCount;
    const dirtyRows=this.dirtyRows, wetWords=this.wetTileWords;
    const wetStride=this.wetTileStride, twpr=this.tileWordsPerRow;
    const netDirty=this.netDirty, netTiles=this.netTiles, tilesWide=this.tilesWide, regionTiles=this.regionTiles;
    const v0=Number.isFinite(minZ)?Math.max(0,Math.floor(((minZ/bz+1)*.5)*h)):0;
    const v1=Number.isFinite(maxZ)?Math.min(h-1,Math.ceil(((maxZ/bz+1)*.5)*h)):h-1;
    if (v0>v1) return 0;
    const tz0=v0>>4, tz1=v1>>4;
    const fullClear=amount>=1;
    let washed=0, dMask=this.dirtyMask;
    for (let layer=0;layer<this.layers;layer++) {
      if (!(layerMask & (1<<layer))) continue;
      const origin=inkOrigin(layer), regionBase=REGION_FOR_LAYER[layer]*ls;
      const u0=Number.isFinite(minX)?Math.max(0,Math.floor((((minX-origin)/bx+1)*.5)*w)):0;
      const u1=Number.isFinite(maxX)?Math.min(w-1,Math.ceil((((maxX-origin)/bx+1)*.5)*w)):w-1;
      if (u0>u1) continue;
      const tx0=u0>>4, tx1=u1>>4;
      const tw0=tx0>>5, tw1=tx1>>5;
      const baseLayer=layer*ls, layerWordOff=layer*wetStride;
      const zIdx=ZONE_FOR_LAYER[layer], zc=zoneCount[zIdx], at=layer<<1;
      let dMin=dirtyRows[at], dMax=dirtyRows[at+1], layerDirty=false;
      for (let tz=tz0;tz<=tz1;tz++) {
        const tileV0=tz<<4, tileV1=tileV0+15<h?tileV0+15:h-1;
        const sv0=v0>tileV0?v0:tileV0, sv1=v1<tileV1?v1:tileV1;
        const rowWordOff=layerWordOff+tz*twpr;
        for (let tw=tw0;tw<=tw1;tw++) {
          let bits=wetWords[rowWordOff+tw];
          if (bits===0) continue;
          const baseTx=tw<<5;
          let clearedMask=0;
          while (bits!==0) {
            const bit=31-Math.clz32(bits & -bits);
            bits&=bits-1;
            const tx=baseTx+bit;
            if (tx<tx0 || tx>tx1) continue;
            const tileU0=tx<<4, tileU1=tileU0+15<w?tileU0+15:w-1;
            const su0=u0>tileU0?u0:tileU0, su1=u1<tileU1?u1:tileU1;
            const fullTile=(su0===tileU0 && su1===tileU1 && sv0===tileV0 && sv1===tileV1);
            let tileHasInk=false, tileDirty=false;
            for (let v=sv0;v<=sv1;v++) {
              const rowOff=v*w;
              let rowDirty=false;
              for (let u=su0;u<=su1;u++) {
                const local=rowOff+u, idx=baseLayer+local;
                const c=cyan[idx], a=amber[idx], b=boss[idx], depth=c+a+b;
                if (depth===0) continue;
                const next=fullClear?0:depth-amount;
                let nc, na, nb, newDepth;
                if (next<COVERAGE) {
                  nc=0; na=0; nb=0; newDepth=0;
                  cyan[idx]=0; amber[idx]=0; boss[idx]=0;
                  flowX[regionBase+local]=0;
                  flowZ[regionBase+local]=0;
                } else {
                  const scale=next/depth;
                  nc=cyan[idx]=c*scale;
                  na=amber[idx]=a*scale;
                  nb=boss[idx]=b*scale;
                  newDepth=nc+na+nb;
                  if (newDepth>0) tileHasInk=true;
                }
                const ow=newDepth<COVERAGE?0:(nb>nc && nb>na)?3:nc>=na?1:2;
                const prev=ownerArr[idx];
                if (ow!==prev) {
                  if (prev===1 || prev===2) {countArr[prev-1]--;zc[prev-1]--;}
                  else if (prev===3) {this.bossCount--;zoneBossCount[zIdx]--;}
                  if (ow===1 || ow===2) {countArr[ow-1]++;zc[ow-1]++;}
                  else if (ow===3) {this.bossCount++;zoneBossCount[zIdx]++;}
                  ownerArr[idx]=ow;
                }
                const cr=(ow===1 || ow===3)?255:0, cg=(ow===2 || ow===3)?255:0;
                const thick=newDepth>=.085?255:newDepth<=0?0:(newDepth*3000+.5)|0;
                const pi=idx<<2;
                if (prev!==ow || pixels[pi]!==cr || pixels[pi+1]!==cg || pixels[pi+2]!==thick || (newDepth>0 && pixels[pi+3]===0)) {
                  pixels[pi]=cr;
                  pixels[pi+1]=cg;
                  pixels[pi+2]=thick;
                  pixels[pi+3]=newDepth>0?floorByte[idx]:0;
                  rowDirty=true;
                }
                washed++;
              }
              if (rowDirty) {
                if (v<dMin) dMin=v;
                if (v>dMax) dMax=v;
                tileDirty=true;
                layerDirty=true;
              }
            }
            if (tileDirty && netDirty) {
              const id=layer*regionTiles+tz*tilesWide+tx;
              netDirty.add(id);
              netTiles.add(id);
            }
            if (fullTile && !tileHasInk) clearedMask|=1<<bit;
          }
          if (clearedMask) wetWords[rowWordOff+tw]&=~clearedMask;
        }
      }
      if (layerDirty) {
        dirtyRows[at]=dMin;
        dirtyRows[at+1]=dMax;
        dMask|=1<<layer;
      }
    }
    if (washed>0) {
      this.dirtyMask=dMask;
      this.version=(this.version+1)|0;
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
    return i>=0?this.cyan[i]+this.amber[i]+(this.boss?this.boss[i]:0):0;
  }

  surfaceIndex(x,z,layer) {
    const index=this.index(x,z,layer);
    if (index<0 || this.mask[index] || layer!==0 && layer!==2) return index;
    const other=this.stairCells.get(index%this.layerSize);
    return other && stairLane(x,z)?.stair===other.stair?other.index:index;
  }

  publish(index) {
    const a=this.cyan[index], b=this.amber[index], bk=this.boss?this.boss[index]:0, depth=a+b+bk;
    const owner=depth<COVERAGE ? 0 : (bk>a && bk>b) ? 3 : a>=b ? 1 : 2;
    const previous=this.owner[index];
    const ls=this.layerSize;
    const layer=index<ls?0:index<ls*2?1:index<ls*3?2:index<ls*4?3:index<ls*5?4:index<ls*6?5:6;
    if (owner!==previous) {
      const zIdx=ZONE_FOR_LAYER[layer];
      const count=this.zoneCount[zIdx];
      if (previous===1 || previous===2) {this.count[previous-1]--;count[previous-1]--;}
      else if (previous===3) {this.bossCount--;this.zoneBossCount[zIdx]--;}
      if (owner===1 || owner===2) {this.count[owner-1]++;count[owner-1]++;}
      else if (owner===3) {this.bossCount++;this.zoneBossCount[zIdx]++;}
      this.owner[index]=owner;
    }
    const c=(owner===1 || owner===3)?255:0, amber=(owner===2 || owner===3)?255:0;
    const thickness=depth>=.085?255:depth<=0?0:(depth*3000+.5)|0;
    const i=index<<2, pixels=this.pixels;
    if (depth>0) {
      const local=index-layer*ls, w=this.w;
      const row=w===640?((local>>7)*52429)>>>18:(local/w)|0;
      const col=local-row*w;
      if (this.wetTileWords) {
        const tx=col>>4;
        this.wetTileWords[layer*this.wetTileStride+(row>>4)*this.tileWordsPerRow+(tx>>5)]|=1<<(tx&31);
      }
      if (layer===0 || layer===1 || layer===4) {
        this.expandActive((col+.5)*this.invW-this.boundX,(row+.5)*this.invH-this.boundZ,1);
      }
    }
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
      this.version=(this.version+1)|0;
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
    if (x0>x1 || z0>z1) return 0;
    if (layer===0 || layer===1 || layer===4) this.expandActive(x,z,radius*1.25+1);
    let taken=0, ac=this.awakeCount, anyChanged=false;
    const isBoss=team===2 || team===-1;
    if (isBoss) this.bossDirty=true;
    const targetOwner=isBoss?3:team+1;
    const pigment=isBoss?this.boss:team===0?this.cyan:this.amber;
    const bossArr=this.boss, cyan=this.cyan, amber=this.amber;
    const mask=this.mask, layerOffset=layer*layerSize;
    const ownerArr=this.owner, pixels=this.pixels, floorByte=this.floorByte;
    const countArr=this.count, zoneCount=this.zoneCount, zoneBossCount=this.zoneBossCount;
    const dirtyRows=this.dirtyRows, wetWords=this.wetTileWords;
    const wetStride=this.wetTileStride, twpr=this.tileWordsPerRow;
    const netDirty=this.netDirty, netTiles=this.netTiles, tilesWide=this.tilesWide, regionTiles=this.regionTiles;
    const awakeBits=this.awakeBits, awakeRowMask=this.awakeRowMask, awakeRows=this.awakeRows;
    const wpr=this.wordsPerRow;
    const phaseOff=((Math.round(phase*INV_TAU_RIM)%RIM_N)+RIM_N)&RIM_MASK;
    const defaultZIdx=ZONE_FOR_LAYER[layer], defaultZc=zoneCount[defaultZIdx];
    const atDefault=layer<<1;
    let dMin=dirtyRows[atDefault], dMax=dirtyRows[atDefault+1], defLayerDirty=false;
    const layerWetOff=layer*wetStride;
    for (let iz=z0;iz<=z1;iz++) {
      const v=(iz+.5-cz)*invRz, v2=v*v;
      if (v2>1.19) continue;
      const rowBase=iz*w, tz=iz>>4;
      const defRow=region*h+iz, defBitRow=defRow*wpr;
      let defRowDirty=false;
      for (let ix=x0;ix<=x1;ix++) {
        const u=(ix+.5-cx)*invRx, d2=u*u+v2;
        if (d2>1.19) continue;
        const base=rowBase+ix;
        if (!stair) {
          const index=layerOffset+base;
          if (!mask[index]) continue;
          const rim2=RIM2_LUT[(fastAtan2Idx(v,u)+phaseOff)&RIM_MASK];
          if (d2>=rim2) continue;
          const amount=depth*(.23+.77*(1-d2/rim2));
          if (!isBoss && bossArr[index]>0) bossArr[index]=Math.max(0,bossArr[index]-amount*1.25);
          else if (isBoss) {
            if (cyan[index]>0) cyan[index]=Math.max(0,cyan[index]-amount*.35);
            if (amber[index]>0) amber[index]=Math.max(0,amber[index]-amount*.35);
          }
          pigment[index]+=amount;
          const ca=cyan[index], cb=amber[index], bk=bossArr[index], dp=ca+cb+bk;
          const ow=dp<COVERAGE?0:(bk>ca && bk>cb)?3:ca>=cb?1:2;
          const prev=ownerArr[index];
          if (ow!==prev) {
            if (prev===1 || prev===2) {countArr[prev-1]--;defaultZc[prev-1]--;}
            else if (prev===3) {this.bossCount--;zoneBossCount[defaultZIdx]--;}
            if (ow===1 || ow===2) {countArr[ow-1]++;defaultZc[ow-1]++;}
            else if (ow===3) {this.bossCount++;zoneBossCount[defaultZIdx]++;}
            ownerArr[index]=ow;
            if (ow===targetOwner) taken++;
          }
          const cr=(ow===1 || ow===3)?255:0, cg=(ow===2 || ow===3)?255:0;
          const thick=dp>=.085?255:dp<=0?0:(dp*3000+.5)|0;
          const pi=index<<2;
          if (prev!==ow || pixels[pi]!==cr || pixels[pi+1]!==cg || pixels[pi+2]!==thick || (dp>0 && pixels[pi+3]===0)) {
            pixels[pi]=cr;
            pixels[pi+1]=cg;
            pixels[pi+2]=thick;
            pixels[pi+3]=dp>0?floorByte[index]:0;
            defRowDirty=true;
            if (netDirty) {
              const id=layer*regionTiles+tz*tilesWide+(ix>>4);
              netDirty.add(id);
              netTiles.add(id);
            }
          }
          const tx=ix>>4;
          wetWords[layerWetOff+tz*twpr+(tx>>5)]|=1<<(tx&31);
          const w0=ix>>>5;
          awakeBits[defBitRow+w0]|=1<<(ix&31);
          if (awakeRowMask[defRow]===0) awakeRows[ac++]=defRow;
          awakeRowMask[defRow]|=1<<w0;
          if (ix>0) {
            const xm=ix-1, wm=xm>>>5;
            awakeBits[defBitRow+wm]|=1<<(xm&31);
            awakeRowMask[defRow]|=1<<wm;
          }
          if (iz>0) {
            const rUp=defRow-1;
            awakeBits[rUp*wpr+w0]|=1<<(ix&31);
            if (awakeRowMask[rUp]===0) awakeRows[ac++]=rUp;
            awakeRowMask[rUp]|=1<<w0;
          }
        } else {
          const stairCell=this.stairCells.get(base);
          const onStair=stairCell && stairCell.stair===stair;
          const index=onStair?stairCell.index:layerOffset+base;
          if (!mask[index]) continue;
          const rim2=RIM2_LUT[(fastAtan2Idx(v,u)+phaseOff)&RIM_MASK];
          if (d2>=rim2) continue;
          const amount=depth*(.23+.77*(1-d2/rim2));
          if (!isBoss && bossArr[index]>0) bossArr[index]=Math.max(0,bossArr[index]-amount*1.25);
          else if (isBoss) {
            if (cyan[index]>0) cyan[index]=Math.max(0,cyan[index]-amount*.35);
            if (amber[index]>0) amber[index]=Math.max(0,amber[index]-amount*.35);
          }
          pigment[index]+=amount;
          if (this.publish(index)===targetOwner) taken++;
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
      if (defRowDirty) {
        if (iz<dMin) dMin=iz;
        if (iz>dMax) dMax=iz;
        defLayerDirty=true;
        anyChanged=true;
      }
    }
    if (defLayerDirty) {
      dirtyRows[atDefault]=dMin;
      dirtyRows[atDefault+1]=dMax;
      this.dirtyMask|=1<<layer;
    }
    if (anyChanged) this.version=(this.version+1)|0;
    this.awakeCount=ac;
    return taken;
  }

  markFlowTile(base) {
    if (!this.flowTileWords) return;
    const ls=this.layerSize, reg=(base/ls)|0, loc=base-reg*ls;
    const w=this.w, z=w===640?((loc>>7)*52429)>>>18:(loc/w)|0, tx=(loc-z*w)>>4;
    this.flowTileWords[reg*this.wetTileStride+(z>>4)*this.tileWordsPerRow+(tx>>5)]|=1<<(tx&31);
  }

  kick(x,z,layer,vx,vz) {
    const index=this.surfaceIndex(x,z,layer);
    if (index<0 || !this.mask[index]) return;
    const ls=this.layerSize;
    const l=index<ls?0:index<ls*2?1:index<ls*3?2:index<ls*4?3:index<ls*5?4:index<ls*6?5:6;
    const base=(index-l*ls)+REGION_FOR_LAYER[l]*ls;
    this.flowX[base]+=clamp(vx,-8,8)*.00115;
    this.flowZ[base]+=clamp(vz,-8,8)*.00115;
    this.markFlowTile(base);
    this.wake(base);
  }

  depositDrop(x,z,layer,team,volume,vx,vz) {
    if (layer===undefined) return false;
    const index=this.surfaceIndex(x,z,layer);
    if (!this.mask[index]) return false;
    const isBoss=team===2 || team===-1;
    if (isBoss) this.bossDirty=true;
    const pigment=isBoss?this.boss:team===0?this.cyan:this.amber;
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
    const ac=this.cyan[a], aa=this.amber[a], ab=this.boss[a];
    const bc=this.cyan[b], ba=this.amber[b], bb=this.boss[b];
    const ha=ac+aa+ab, hb=bc+ba+bb;
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
    const c=q>0?q*(ac/ha):q*(bc/hb);
    const t=q>0?q*(aa/ha):q*(ba/hb);
    const k=q-c-t;
    this.deltaC[a]-=c;
    this.deltaC[b]+=c;
    this.deltaA[a]-=t;
    this.deltaA[b]+=t;
    this.deltaB[a]-=k;
    this.deltaB[b]+=k;
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
        this.markFlowTile(from);
        this.wake(from);
        this.wake(to);
      }
    }
  }

  flowRows(startIdx,endIdx) {
    const w=this.w, h=this.h, wpr=this.wordsPerRow;
    const hasBoss=!!this.bossDirty || this.bossCount>0;
    const surface=this.surface, cyan=this.cyan, amber=this.amber, boss=hasBoss?this.boss:null, bed=this.bed;
    const flowX=this.flowX, flowZ=this.flowZ, barrierX=this.barrierX, barrierZ=this.barrierZ;
    const deltaC=this.deltaC, deltaA=this.deltaA, deltaB=hasBoss?this.deltaB:null, touched=this.touched;
    const flowWords=this.flowTileWords, wetStride=this.wetTileStride, twpr=this.tileWordsPerRow;
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
      const reg=(row/h)|0, z=row-reg*h, rowBase=row*w, bitRow=row*wpr, canDown=z+1<h;
      const rowFlat=flatMask?flatMask[row]:0;
      const rowFlowOff=reg*wetStride+(z>>4)*twpr;
      while (rMask!==0) {
        const wIdx=31-Math.clz32(rMask & -rMask);
        rMask&=rMask-1;
        const word=workBits[bitRow+wIdx];
        workBits[bitRow+wIdx]=0;
        if (word===0) continue;
        if (cc+96>=changedList.length) changedList=this.growChangedList(cc+96);
        const colBase=wIdx<<5;
        if ((rowFlat & (1<<wIdx))!==0) {
          if (!hasBoss) {
            cc=runWordFlat2(
              word,rowBase,colBase,w,canDown,
              surface,cyan,amber,flowX,flowZ,barrierX,barrierZ,
              deltaC,deltaA,touched,changedList,cc,
              hasBarrier,hasStairs,stairEdges,this,wakeState
            );
          } else {
            cc=runWordFlat(
              word,rowBase,colBase,w,canDown,
              surface,cyan,amber,boss,flowX,flowZ,barrierX,barrierZ,
              deltaC,deltaA,deltaB,touched,changedList,cc,
              hasBarrier,hasStairs,stairEdges,this,wakeState
            );
          }
        } else {
          cc=runWordSloped(
            word,rowBase,colBase,w,canDown,
            surface,cyan,amber,boss,bed,flowX,flowZ,barrierX,barrierZ,
            deltaC,deltaA,deltaB,touched,changedList,cc,
            hasBarrier,hasStairs,stairEdges,this,wakeState
          );
        }
        const mE=wakeState.mE, mS=wakeState.mS, mAny=mE|mS;
        if (mAny!==0) {
          propagateWordWake(mE,mS,row,z,wIdx,bitRow,canDown,wpr,awakeBits,awakeRowMask,awakeRows,wakeState);
          if (flowWords) {
            if (mAny & 0xffff) {const tx=wIdx<<1; flowWords[rowFlowOff+(tx>>5)]|=1<<(tx&31);}
            if (mAny & 0xffff0000) {const tx=(wIdx<<1)+1; flowWords[rowFlowOff+(tx>>5)]|=1<<(tx&31);}
          }
        }
      }
    }
    this.changedCount=cc;
    this.awakeCount=wakeState.n;
  }

  settle() {
    const count=this.changedCount;
    if (!count) return;
    const hasBoss=!!this.bossDirty || this.bossCount>0;
    runSettle(
      count,this.changedList,this.cyan,this.amber,this.deltaC,this.deltaA,hasBoss?this.boss:null,hasBoss?this.deltaB:null,
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
    if (team===2 || team===-1) {
      const bc=zone===null?this.bossCount:this.zoneBossCount[zone];
      return bc*100/Math.max(1,total);
    }
    const count=zone===null?this.count:this.zoneCount[zone];
    return count[team]*100/Math.max(1,total);
  }
}
