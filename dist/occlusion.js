// Conservative CPU Hi-Z Software Occlusion Culler.
// Uses area-sorted SoA occluder storage with Top-72 min-heap selection, 12-multiply
// incremental corner projection for axis-aligned buildings, analytical scanline-span
// convex-quad rasterization, and O(1) convex-center + MAX-Z pyramid visibility tests.

const W=64, H=36;
const W1=32, H1=18;
const W2=16, H2=9;
const W3=8, H3=5;
const TOP_K=72;
const HW=W*.5, HH=H*.5;

// Outward CCW faces of unit box corners 0..7:
// 0:(-,-,-) 1:(+,-,-) 2:(+,-,+) 3:(-,-,+) 4:(-,+,-) 5:(+,+,-) 6:(+,+,+) 7:(-,+,+)
const FACES=new Uint8Array([
  0,1,2,3, // -Y
  7,6,5,4, // +Y
  3,2,6,7, // +Z
  1,0,4,5, // -Z
  0,3,7,4, // -X
  2,1,5,6  // +X
]);

const BOX_SIGNS=new Int8Array([
  -1,-1,-1,  1,-1,-1,  1,-1, 1, -1,-1, 1,
  -1, 1,-1,  1, 1,-1,  1, 1, 1, -1, 1, 1
]);

export class OccluderCuller {
  constructor() {
    this.z0=new Float32Array(W*H);
    this.z1=new Float32Array(W1*H1);
    this.z2=new Float32Array(W2*H2);
    this.z3=new Float32Array(W3*H3);
    this.occluders=[]; // Compatibility handle exposing .length
    this.active=false;
    this.vp=null;
    this._cap=256;
    this._count=0;
    this._dirty=false;
    this._minX=new Float32Array(256);
    this._minY=new Float32Array(256);
    this._minZ=new Float32Array(256);
    this._maxX=new Float32Array(256);
    this._maxY=new Float32Array(256);
    this._maxZ=new Float32Array(256);
    this._area=new Float32Array(256);
    this._isAA=new Uint8Array(256);
    this._corners=new Float32Array(256*24);
    this._sMinX=null; this._sMinY=null; this._sMinZ=null;
    this._sMaxX=null; this._sMaxY=null; this._sMaxZ=null;
    this._sArea=null; this._sIsAA=null; this._sCorners=null;
    this._sx=new Float32Array(8);
    this._sy=new Float32Array(8);
    this._sz=new Float32Array(8);
    this._heapIdx=new Int32Array(TOP_K);
    this._heapScore=new Float32Array(TOP_K);
    this._z0Min=1;
    this._sx0=0; this._sx4=0; this._sx8=0; this._sx12=0;
    this._sy0=0; this._sy4=0; this._sy8=0; this._sy12=0;
    this._m2=0;  this._m6=0;  this._m10=0; this._m14=0;
    this._m3=0;  this._m7=0;  this._m11=0; this._m15=0;
  }

  clear() {
    this._count=0;
    this._dirty=false;
    this.occluders.length=0;
    this.active=false;
  }

  _grow() {
    const nc=this._cap*2;
    const gF=(a,s)=>{const b=new Float32Array(nc*s); b.set(a); return b;};
    const gU=a=>{const b=new Uint8Array(nc); b.set(a); return b;};
    this._minX=gF(this._minX,1); this._minY=gF(this._minY,1); this._minZ=gF(this._minZ,1);
    this._maxX=gF(this._maxX,1); this._maxY=gF(this._maxY,1); this._maxZ=gF(this._maxZ,1);
    this._area=gF(this._area,1);
    this._isAA=gU(this._isAA);
    this._corners=gF(this._corners,24);
    this._cap=nc;
  }

  // Registers a large solid opaque static box (already packed in `data` at offset `o`).
  addBoxFromPacked(data,o) {
    const a0x=data[o], a0y=data[o+1], a0z=data[o+2];
    const a1x=data[o+4], a1y=data[o+5], a1z=data[o+6];
    const a2x=data[o+8], a2y=data[o+9], a2z=data[o+10];
    const w2=a0x*a0x+a0y*a0y+a0z*a0z;
    const h2=a1x*a1x+a1y*a1y+a1z*a1z;
    const d2=a2x*a2x+a2y*a2y+a2z*a2z;
    if (h2<4.84 || (w2<9.0 && d2<9.0)) return;
    const w=Math.sqrt(w2), h=Math.sqrt(h2), d=Math.sqrt(d2);
    const px=data[o+12], py=data[o+13], pz=data[o+14];
    const hx=a0x*.5, hy=a0y*.5, hz=a0z*.5;
    const ux=a1x*.5, uy=a1y*.5, uz=a1z*.5;
    const fx=a2x*.5, fy=a2y*.5, fz=a2z*.5;
    const ex=Math.abs(hx)+Math.abs(ux)+Math.abs(fx);
    const ey=Math.abs(hy)+Math.abs(uy)+Math.abs(fy);
    const ez=Math.abs(hz)+Math.abs(uz)+Math.abs(fz);
    const idx=this._count++;
    if (idx>=this._cap) this._grow();
    this._minX[idx]=px-ex; this._minY[idx]=py-ey; this._minZ[idx]=pz-ez;
    this._maxX[idx]=px+ex; this._maxY[idx]=py+ey; this._maxZ[idx]=pz+ez;
    this._area[idx]=w*h+h*d+w*d;
    const aa=(a0x>0 && a1y>0 && a2z>0 && a0y===0 && a0z===0 && a1x===0 && a1z===0 && a2x===0 && a2y===0)?1:0;
    this._isAA[idx]=aa;
    if (!aa) {
      const c=this._corners, base=idx*24;
      for (let i=0;i<8;i++) {
        const s0=BOX_SIGNS[i*3], s1=BOX_SIGNS[i*3+1], s2=BOX_SIGNS[i*3+2], bo=base+i*3;
        c[bo]=px+s0*hx+s1*ux+s2*fx;
        c[bo+1]=py+s0*hy+s1*uy+s2*fy;
        c[bo+2]=pz+s0*hz+s1*uz+s2*fz;
      }
    }
    this._dirty=true;
    this.occluders.length=this._count;
  }

  _rebuildIndex() {
    const n=this._count, area=this._area;
    const order=new Int32Array(n);
    for (let i=0;i<n;i++) order[i]=i;
    order.sort((a,b)=>area[b]-area[a]);
    const sMinX=new Float32Array(n), sMinY=new Float32Array(n), sMinZ=new Float32Array(n);
    const sMaxX=new Float32Array(n), sMaxY=new Float32Array(n), sMaxZ=new Float32Array(n);
    const sArea=new Float32Array(n), sIsAA=new Uint8Array(n), sCorners=new Float32Array(n*24);
    for (let i=0;i<n;i++) {
      const src=order[i];
      sMinX[i]=this._minX[src]; sMinY[i]=this._minY[src]; sMinZ[i]=this._minZ[src];
      sMaxX[i]=this._maxX[src]; sMaxY[i]=this._maxY[src]; sMaxZ[i]=this._maxZ[src];
      sArea[i]=area[src]; sIsAA[i]=this._isAA[src];
      if (!sIsAA[i]) sCorners.set(this._corners.subarray(src*24,src*24+24),i*24);
    }
    this._sMinX=sMinX; this._sMinY=sMinY; this._sMinZ=sMinZ;
    this._sMaxX=sMaxX; this._sMaxY=sMaxY; this._sMaxZ=sMaxZ;
    this._sArea=sArea; this._sIsAA=sIsAA; this._sCorners=sCorners;
    this._dirty=false;
  }

  _projOBB(idxO,sx,sy,sz) {
    const corners=this._sCorners, base=idxO*24;
    const m2=this._m2, m6=this._m6, m10=this._m10, m14=this._m14;
    const m3=this._m3, m7=this._m7, m11=this._m11, m15=this._m15;
    const sx0=this._sx0, sx4=this._sx4, sx8=this._sx8, sx12=this._sx12;
    const sy0=this._sy0, sy4=this._sy4, sy8=this._sy8, sy12=this._sy12;
    for (let i=0;i<8;i++) {
      const bo=base+i*3, x=corners[bo], y=corners[bo+1], z=corners[bo+2];
      const cw=m3*x+m7*y+m11*z+m15;
      if (cw<=.25) return false;
      const inv=1/cw;
      sx[i]=(sx0*x+sx4*y+sx8*z+sx12)*inv;
      sy[i]=(sy0*x+sy4*y+sy8*z+sy12)*inv;
      sz[i]=(m2*x+m6*y+m10*z+m14)*inv;
    }
    return true;
  }

  _selectTopK(ex,ey,ez,planes) {
    const n=this._count;
    const minX=this._sMinX, minY=this._sMinY, minZ=this._sMinZ;
    const maxX=this._sMaxX, maxY=this._sMaxY, maxZ=this._sMaxZ;
    const area=this._sArea, heapIdx=this._heapIdx, heapScore=this._heapScore;
    let topN=0, minScore=.018;
    for (let i=0;i<n;i++) {
      const ar=area[i];
      if (ar<=minScore) break;
      const x0=minX[i], x1=maxX[i], y0=minY[i], y1=maxY[i], z0v=minZ[i], z1v=maxZ[i];
      const dx=Math.max(x0-ex,0,ex-x1);
      const dy=Math.max(y0-ey,0,ey-y1);
      const dz=Math.max(z0v-ez,0,ez-z1v);
      const score=ar/(dx*dx+dy*dy+dz*dz+1);
      if (score<=minScore) continue;
      if (ex>=x0-.6 && ex<=x1+.6 && ey>=y0-.6 && ey<=y1+.6 && ez>=z0v-.6 && ez<=z1v+.6) continue;
      let vis=true;
      for (let p=0;p<6;p++) {
        const pl=planes[p];
        if (pl[0]*(pl[0]>=0?x1:x0)+pl[1]*(pl[1]>=0?y1:y0)+pl[2]*(pl[2]>=0?z1v:z0v)+pl[3]<0) {vis=false;break;}
      }
      if (!vis) continue;
      if (topN<TOP_K) {
        let pos=topN++;
        while (pos>0) {
          const par=(pos-1)>>1;
          if (heapScore[par]<=score) break;
          heapScore[pos]=heapScore[par]; heapIdx[pos]=heapIdx[par];
          pos=par;
        }
        heapScore[pos]=score; heapIdx[pos]=i;
        if (topN===TOP_K) minScore=heapScore[0];
      } else {
        let pos=0;
        for (;;) {
          const l=(pos<<1)+1;
          if (l>=TOP_K) break;
          const r=l+1, s=(r<TOP_K && heapScore[r]<heapScore[l])?r:l;
          if (score<=heapScore[s]) break;
          heapScore[pos]=heapScore[s]; heapIdx[pos]=heapIdx[s];
          pos=s;
        }
        heapScore[pos]=score; heapIdx[pos]=i;
        minScore=heapScore[0];
      }
    }
    return topN;
  }

  build(vp,eye,planes,flipWinding=false,clipMinY=-Infinity) {
    this.vp=vp;
    this.active=false;
    if (!this._count) return;
    if (this._dirty) this._rebuildIndex();
    const ex=eye[0], ey=eye[1], ez=eye[2];
    const topN=this._selectTopK(ex,ey,ez,planes);
    if (!topN) return;
    const minX=this._sMinX, minY=this._sMinY, minZ=this._sMinZ;
    const maxX=this._sMaxX, maxY=this._sMaxY, maxZ=this._sMaxZ;
    const isAA=this._sIsAA, heapIdx=this._heapIdx;

    const m2=vp[2], m6=vp[6], m10=vp[10], m14=vp[14];
    const m3=vp[3], m7=vp[7], m11=vp[11], m15=vp[15];
    const sx0=(vp[0]+m3)*HW, sx4=(vp[4]+m7)*HW, sx8=(vp[8]+m11)*HW, sx12=(vp[12]+m15)*HW;
    const sy0=(vp[1]+m3)*HH, sy4=(vp[5]+m7)*HH, sy8=(vp[9]+m11)*HH, sy12=(vp[13]+m15)*HH;
    this._sx0=sx0; this._sx4=sx4; this._sx8=sx8; this._sx12=sx12;
    this._sy0=sy0; this._sy4=sy4; this._sy8=sy8; this._sy12=sy12;
    this._m2=m2;   this._m6=m6;   this._m10=m10; this._m14=m14;
    this._m3=m3;   this._m7=m7;   this._m11=m11; this._m15=m15;

    const z0=this.z0;
    z0.fill(1);
    const sx=this._sx, sy=this._sy, sz=this._sz;
    let wrote=0, z0Min=1;

    for (let k=0;k<topN;k++) {
      const idxO=heapIdx[k];
      let faceMask=63;
      if (isAA[idxO]) {
        const bx0=minX[idxO], bx1=maxX[idxO], by1=maxY[idxO], bz0=minZ[idxO], bz1=maxZ[idxO];
        let by0=minY[idxO], clippedBottom=false;
        if (by0<clipMinY) {
          if (by1<=clipMinY+.2) continue;
          by0=clipMinY;
          clippedBottom=true;
        }
        faceMask=((ey<by0 && !clippedBottom)?1:0)|(ey>by1?2:0)|(ez>bz1?4:0)|(ez<bz0?8:0)|(ex<bx0?16:0)|(ex>bx1?32:0);
        if (!faceMask) continue;
        const dx=bx1-bx0, dy=by1-by0, dz=bz1-bz0;
        const w0=m3*bx0+m7*by0+m11*bz0+m15, dwX=m3*dx, dwY=m7*dy, dwZ=m11*dz;
        if (w0+Math.min(dwX,0)+Math.min(dwY,0)+Math.min(dwZ,0)<=.25) continue;
        const cx0=sx0*bx0+sx4*by0+sx8*bz0+sx12, dcxX=sx0*dx, dcxY=sx4*dy, dcxZ=sx8*dz;
        const cy0=sy0*bx0+sy4*by0+sy8*bz0+sy12, dcyX=sy0*dx, dcyY=sy4*dy, dcyZ=sy8*dz;
        const cz0=m2*bx0+m6*by0+m10*bz0+m14,    dczX=m2*dx,  dczY=m6*dy,  dczZ=m10*dz;
        for (let yb=0;yb<2;yb++) {
          const o=yb<<2, wB=w0+yb*dwY, cxB=cx0+yb*dcxY, cyB=cy0+yb*dcyY, czB=cz0+yb*dczY;
          let inv=1/wB; sx[o]=cxB*inv; sy[o]=cyB*inv; sz[o]=czB*inv;
          inv=1/(wB+dwX); sx[o+1]=(cxB+dcxX)*inv; sy[o+1]=(cyB+dcyX)*inv; sz[o+1]=(czB+dczX)*inv;
          inv=1/(wB+dwX+dwZ); sx[o+2]=(cxB+dcxX+dcxZ)*inv; sy[o+2]=(cyB+dcyX+dcyZ)*inv; sz[o+2]=(czB+dczX+dczZ)*inv;
          inv=1/(wB+dwZ); sx[o+3]=(cxB+dcxZ)*inv; sy[o+3]=(cyB+dcyZ)*inv; sz[o+3]=(czB+dczZ)*inv;
        }
      } else {
        if (minY[idxO]<clipMinY) continue;
        if (!this._projOBB(idxO,sx,sy,sz)) continue;
      }
      for (let fi=0;fi<6;fi++) {
        if (!(faceMask & (1<<fi))) continue;
        const f=fi<<2;
        const i0=FACES[f], i1=FACES[flipWinding?f+3:f+1], i2=FACES[f+2], i3=FACES[flipWinding?f+1:f+3];
        const x0=sx[i0], y0=sy[i0], z0v=sz[i0];
        const x1=sx[i1], y1=sy[i1], z1v=sz[i1];
        const x2=sx[i2], y2=sy[i2], z2v=sz[i2];
        const area2=(x1-x0)*(y2-y0)-(y1-y0)*(x2-x0);
        if (area2<=1) continue;
        const x3=sx[i3], y3=sy[i3], z3v=sz[i3];
        const rx0=Math.max(0,Math.ceil(Math.min(x0,x1,x2,x3)));
        const rx1=Math.min(W-1,Math.floor(Math.max(x0,x1,x2,x3))-1);
        const ry0=Math.max(0,Math.ceil(Math.min(y0,y1,y2,y3)));
        const ry1=Math.min(H-1,Math.floor(Math.max(y0,y1,y2,y3))-1);
        if (rx0>rx1 || ry0>ry1) continue;

        const a0=y0-y1, b0=x1-x0, c0=(y1-y0)*x0-(x1-x0)*y0-.5*(Math.abs(a0)+Math.abs(b0));
        const a1=y1-y2, b1=x2-x1, c1=(y2-y1)*x1-(x2-x1)*y1-.5*(Math.abs(a1)+Math.abs(b1));
        const a2=y2-y3, b2=x3-x2, c2=(y3-y2)*x2-(x3-x2)*y2-.5*(Math.abs(a2)+Math.abs(b2));
        const a3=y3-y0, b3=x0-x3, c3=(y0-y3)*x3-(x0-x3)*y3-.5*(Math.abs(a3)+Math.abs(b3));
        const invA=1/area2;
        const dzdx=((z1v-z0v)*(y2-y0)-(z2v-z0v)*(y1-y0))*invA;
        const dzdy=((x1-x0)*(z2v-z0v)-(x2-x0)*(z1v-z0v))*invA;
        const zBias=.5*(Math.abs(dzdx)+Math.abs(dzdy))+.0006;
        const zCap=Math.max(z0v,z1v,z2v,z3v)+.0006;

        const cx0=rx0+.5, cy0=ry0+.5;
        let r0=a0*cx0+b0*cy0+c0, r1=a1*cx0+b1*cy0+c1, r2=a2*cx0+b2*cy0+c2, r3=a3*cx0+b3*cy0+c3;
        let zRow=z0v+(cx0-x0)*dzdx+(cy0-y0)*dzdy+zBias;
        let faceWrote=0;
        for (let py=ry0;py<=ry1;py++, r0+=b0, r1+=b1, r2+=b2, r3+=b3, zRow+=dzdy) {
          let e0=r0, e1=r1, e2=r2, e3=r3, zc=zRow, hit=0, idx=py*W+rx0;
          for (let px=rx0;px<=rx1;px++, idx++, e0+=a0, e1+=a1, e2+=a2, e3+=a3, zc+=dzdx) {
            if (e0>=0 && e1>=0 && e2>=0 && e3>=0) {
              hit=1;
              const zv=Math.min(zCap,zc);
              if (zv<z0[idx]) {z0[idx]=zv; faceWrote=1;}
            } else if (hit) {
              break;
            }
          }
        }
        if (faceWrote) {
          wrote=1;
          z0Min=Math.min(z0Min,z0v,z1v,z2v,z3v);
        }
      }
    }
    if (!wrote) return;
    this._z0Min=z0Min;
    this._buildPyramid();
    this.active=true;
  }

  _buildPyramid() {
    const z0=this.z0, z1=this.z1, z2=this.z2, z3=this.z3;
    for (let y=0;y<H1;y++) {
      const r0=(y<<1)*W, r1=r0+W, o=y*W1;
      for (let x=0;x<W1;x++) {
        const x2=x<<1;
        z1[o+x]=Math.max(z0[r0+x2],z0[r0+x2+1],z0[r1+x2],z0[r1+x2+1]);
      }
    }
    for (let y=0;y<H2;y++) {
      const r0=(y<<1)*W1, r1=r0+W1, o=y*W2;
      for (let x=0;x<W2;x++) {
        const x2=x<<1;
        z2[o+x]=Math.max(z1[r0+x2],z1[r0+x2+1],z1[r1+x2],z1[r1+x2+1]);
      }
    }
    for (let y=0;y<H3;y++) {
      const y2=y<<1, r0=Math.min(y2,H2-1)*W2, r1=Math.min(y2+1,H2-1)*W2, o=y*W3;
      for (let x=0;x<W3;x++) {
        const x2=x<<1;
        z3[o+x]=Math.max(z2[r0+x2],z2[r0+x2+1],z2[r1+x2],z2[r1+x2+1]);
      }
    }
  }

  // Returns false ONLY when the entire AABB is provably behind rasterized occluders.
  isBoxVisible(min,max,ox) {
    if (!this.active) return true;
    const x0=min[0]+ox, y0=min[1], z0=min[2];
    const dx=max[0]-min[0], dy=max[1]-min[1], dz=max[2]-min[2];
    const m3=this._m3, m7=this._m7, m11=this._m11;
    const w000=m3*x0+m7*y0+m11*z0+this._m15, dwX=m3*dx, dwY=m7*dy, dwZ=m11*dz;
    const wMin=w000+Math.min(dwX,0)+Math.min(dwY,0)+Math.min(dwZ,0);
    if (wMin<=.15) return true;

    const sx0=this._sx0, sx4=this._sx4, sx8=this._sx8;
    const cx000=sx0*x0+sx4*y0+sx8*z0+this._sx12, dcxX=sx0*dx, dcxY=sx4*dy, dcxZ=sx8*dz;
    if (cx000+Math.max(dcxX,0)+Math.max(dcxY,0)+Math.max(dcxZ,0)<0) return false;
    if (cx000-W*w000+Math.min(dcxX-W*dwX,0)+Math.min(dcxY-W*dwY,0)+Math.min(dcxZ-W*dwZ,0)>=0) return false;

    const sy0=this._sy0, sy4=this._sy4, sy8=this._sy8;
    const cy000=sy0*x0+sy4*y0+sy8*z0+this._sy12, dcyX=sy0*dx, dcyY=sy4*dy, dcyZ=sy8*dz;
    if (cy000+Math.max(dcyX,0)+Math.max(dcyY,0)+Math.max(dcyZ,0)<0) return false;
    if (cy000-H*w000+Math.min(dcyX-H*dwX,0)+Math.min(dcyY-H*dwY,0)+Math.min(dcyZ-H*dwZ,0)>=0) return false;

    const czMin=this._m2*(dwX<0?x0+dx:x0)+this._m6*(dwY<0?y0+dy:y0)+this._m10*(dwZ<0?z0+dz:z0)+this._m14;
    const minZ=czMin/wMin;
    if (minZ<=this._z0Min) return true;

    // 1-division convex-center early-visible witness.
    const invMid=1/(w000+.5*(dwX+dwY+dwZ));
    const mx=((cx000+.5*(dcxX+dcxY+dcxZ))*invMid)|0;
    const my=((cy000+.5*(dcyX+dcyY+dcyZ))*invMid)|0;
    if (mx>=0 && mx<W && my>=0 && my<H && minZ<=this.z0[my*W+mx]) return true;

    let minSx=1e9, maxSx=-1e9, minSy=1e9, maxSy=-1e9;
    for (let b=0;b<4;b++) {
      const ix=b&1, iy=b>>1;
      const cx=cx000+ix*dcxX+iy*dcxY;
      const cy=cy000+ix*dcyX+iy*dcyY;
      const w=w000+ix*dwX+iy*dwY;
      const inv0=1/w, sxA=cx*inv0, syA=cy*inv0;
      minSx=Math.min(minSx,sxA); maxSx=Math.max(maxSx,sxA);
      minSy=Math.min(minSy,syA); maxSy=Math.max(maxSy,syA);
      const inv1=1/(w+dwZ), sxB=(cx+dcxZ)*inv1, syB=(cy+dcyZ)*inv1;
      minSx=Math.min(minSx,sxB); maxSx=Math.max(maxSx,sxB);
      minSy=Math.min(minSy,syB); maxSy=Math.max(maxSy,syB);
    }

    const ix0=Math.max(0,minSx|0), ix1=Math.min(W-1,maxSx|0);
    const iy0=Math.max(0,minSy|0), iy1=Math.min(H-1,maxSy|0);
    const span=Math.max(ix1-ix0+1,iy1-iy0+1);
    let buf, bw, tx0, tx1, ty0, ty1;
    if (span<=2) {buf=this.z0;bw=W;tx0=ix0;tx1=ix1;ty0=iy0;ty1=iy1;}
    else if (span<=4) {buf=this.z1;bw=W1;tx0=ix0>>1;tx1=ix1>>1;ty0=iy0>>1;ty1=iy1>>1;}
    else if (span<=8) {buf=this.z2;bw=W2;tx0=ix0>>2;tx1=ix1>>2;ty0=iy0>>2;ty1=iy1>>2;}
    else {buf=this.z3;bw=W3;tx0=ix0>>3;tx1=Math.min(W3-1,ix1>>3);ty0=iy0>>3;ty1=Math.min(H3-1,iy1>>3);}
    for (let y=ty0;y<=ty1;y++) {
      const row=y*bw;
      for (let x=tx0;x<=tx1;x++) if (minZ<=buf[row+x]) return true;
    }
    return false;
  }
}
