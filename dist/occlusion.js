// Conservative CPU Hi-Z Software Occlusion Culler.
// Rasterizes the nearest large solid buildings onto a tiny 64x36 L1-resident
// depth buffer using inner-conservative 4-edge convex-quad coverage and exact
// screen-space linear depth bounds, builds a 4-level MAX-Z pyramid, and rejects
// provably hidden static chunks in O(1) before any GPU draw call.

const W=64, H=36;
const W1=32, H1=18;
const W2=16, H2=9;
const W3=8, H3=5;

// Outward CCW faces of unit box corners 0..7:
// 0:(-,-,-) 1:(+,-,-) 2:(+,-,+) 3:(-,-,+) 4:(-,+,-) 5:(+,+,-) 6:(+,+,+) 7:(-,+,+)
const FACES=[
  0,1,2,3, // -Y
  7,6,5,4, // +Y
  3,2,6,7, // +Z
  1,0,4,5, // -Z
  0,3,7,4, // -X
  2,1,5,6  // +X
];

const BOX_SIGNS=[
  -1,-1,-1,  1,-1,-1,  1,-1, 1, -1,-1, 1,
  -1, 1,-1,  1, 1,-1,  1, 1, 1, -1, 1, 1
];

export class OccluderCuller {
  constructor() {
    this.z0=new Float32Array(W*H);
    this.z1=new Float32Array(W1*H1);
    this.z2=new Float32Array(W2*H2);
    this.z3=new Float32Array(W3*H3);
    this.occluders=[];
    this.active=false;
    this.vp=null;
    // Scratch buffers for zero per-frame allocation.
    this._sx=new Float32Array(8);
    this._sy=new Float32Array(8);
    this._sz=new Float32Array(8);
    this._cand=[];
  }

  clear() {
    this.occluders.length=0;
    this.active=false;
  }

  // Registers a large solid opaque static box (already packed in `data` at offset `o`).
  addBoxFromPacked(data,o) {
    const a0x=data[o], a0y=data[o+1], a0z=data[o+2];
    const a1x=data[o+4], a1y=data[o+5], a1z=data[o+6];
    const a2x=data[o+8], a2y=data[o+9], a2z=data[o+10];
    const px=data[o+12], py=data[o+13], pz=data[o+14];
    const w=Math.sqrt(a0x*a0x+a0y*a0y+a0z*a0z), h=Math.sqrt(a1x*a1x+a1y*a1y+a1z*a1z), d=Math.sqrt(a2x*a2x+a2y*a2y+a2z*a2z);
    if (h<2.2 || (w<3.0 && d<3.0)) return;
    const hx=a0x*.5, hy=a0y*.5, hz=a0z*.5;
    const ux=a1x*.5, uy=a1y*.5, uz=a1z*.5;
    const fx=a2x*.5, fy=a2y*.5, fz=a2z*.5;
    const ex=Math.abs(hx)+Math.abs(ux)+Math.abs(fx);
    const ey=Math.abs(hy)+Math.abs(uy)+Math.abs(fy);
    const ez=Math.abs(hz)+Math.abs(uz)+Math.abs(fz);
    // Precompute the 8 world corners once at seal() time.
    const corners=new Float32Array(24);
    for (let i=0;i<8;i++) {
      const s0=BOX_SIGNS[i*3], s1=BOX_SIGNS[i*3+1], s2=BOX_SIGNS[i*3+2];
      corners[i*3]=px+s0*hx+s1*ux+s2*fx;
      corners[i*3+1]=py+s0*hy+s1*uy+s2*fy;
      corners[i*3+2]=pz+s0*hz+s1*uz+s2*fz;
    }
    this.occluders.push({
      px,py,pz,
      minX:px-ex, minY:py-ey, minZ:pz-ez,
      maxX:px+ex, maxY:py+ey, maxZ:pz+ez,
      area:w*h+h*d+w*d,
      score:0,
      corners
    });
  }

  build(vp,eye,planes) {
    this.vp=vp;
    this.active=false;
    const occs=this.occluders;
    if (!occs.length) return;
    const ex=eye[0], ey=eye[1], ez=eye[2];
    const cand=this._cand;
    cand.length=0;
    for (let i=0;i<occs.length;i++) {
      const o=occs[i];
      // Skip if camera is inside or too close to this occluder box.
      if (ex>=o.minX-.6 && ex<=o.maxX+.6 && ey>=o.minY-.6 && ey<=o.maxY+.6 && ez>=o.minZ-.6 && ez<=o.maxZ+.6) continue;
      // Frustum test.
      let vis=true;
      for (let p=0;p<6;p++) {
        const pl=planes[p];
        const x=pl[0]>=0?o.maxX:o.minX, y=pl[1]>=0?o.maxY:o.minY, z=pl[2]>=0?o.maxZ:o.minZ;
        if (pl[0]*x+pl[1]*y+pl[2]*z+pl[3]<0) {vis=false;break;}
      }
      if (!vis) continue;
      const dx=Math.max(o.minX-ex,0,ex-o.maxX);
      const dy=Math.max(o.minY-ey,0,ey-o.maxY);
      const dz=Math.max(o.minZ-ez,0,ez-o.maxZ);
      const d2=dx*dx+dy*dy+dz*dz+1;
      o.score=o.area/d2;
      if (o.score<.018) continue;
      cand.push(o);
    }
    if (!cand.length) return;
    // Rasterize largest projected occluders first (cap at 72 for <0.2ms budget).
    cand.sort((a,b)=>b.score-a.score);
    const limit=Math.min(cand.length,72);
    const z0=this.z0;
    z0.fill(1);
    const m0=vp[0],m1=vp[1],m2=vp[2],m3=vp[3];
    const m4=vp[4],m5=vp[5],m6=vp[6],m7=vp[7];
    const m8=vp[8],m9=vp[9],m10=vp[10],m11=vp[11];
    const m12=vp[12],m13=vp[13],m14=vp[14],m15=vp[15];
    const sx=this._sx, sy=this._sy, sz=this._sz;
    let wrote=0;
    for (let k=0;k<limit;k++) {
      const c=cand[k].corners;
      let behind=false;
      for (let i=0;i<8;i++) {
        const x=c[i*3], y=c[i*3+1], z=c[i*3+2];
        const cw=m3*x+m7*y+m11*z+m15;
        if (cw<=.25) {behind=true;break;}
        const inv=1/cw;
        sx[i]=((m0*x+m4*y+m8*z+m12)*inv*.5+.5)*W;
        sy[i]=((m1*x+m5*y+m9*z+m13)*inv*.5+.5)*H;
        sz[i]=(m2*x+m6*y+m10*z+m14)*inv;
      }
      if (behind) continue;
      for (let f=0;f<24;f+=4) {
        const i0=FACES[f], i1=FACES[f+1], i2=FACES[f+2], i3=FACES[f+3];
        const x0=sx[i0], y0=sy[i0], z0v=sz[i0];
        const x1=sx[i1], y1=sy[i1], z1v=sz[i1];
        const x2=sx[i2], y2=sy[i2], z2v=sz[i2];
        const x3=sx[i3], y3=sy[i3], z3v=sz[i3];
        const area2=(x1-x0)*(y2-y0)-(y1-y0)*(x2-x0);
        if (area2<=1) continue; // Back-facing or tiny (<0.5 cell)
        const bx0=Math.max(0,Math.ceil(Math.min(x0,x1,x2,x3)));
        const bx1=Math.min(W-1,Math.floor(Math.max(x0,x1,x2,x3))-1);
        if (bx0>bx1) continue;
        const by0=Math.max(0,Math.ceil(Math.min(y0,y1,y2,y3)));
        const by1=Math.min(H-1,Math.floor(Math.max(y0,y1,y2,y3))-1);
        if (by0>by1) continue;
        // 4 inward-shifted edge equations: e_i(x+0.5, y+0.5) >= 0 guarantees all 4 cell corners inside quad.
        const a0=y0-y1, b0=x1-x0, c0=(y1-y0)*x0-(x1-x0)*y0-.5*(Math.abs(a0)+Math.abs(b0));
        const a1=y1-y2, b1=x2-x1, c1=(y2-y1)*x1-(x2-x1)*y1-.5*(Math.abs(a1)+Math.abs(b1));
        const a2=y2-y3, b2=x3-x2, c2=(y3-y2)*x2-(x3-x2)*y2-.5*(Math.abs(a2)+Math.abs(b2));
        const a3=y3-y0, b3=x0-x3, c3=(y0-y3)*x3-(x0-x3)*y3-.5*(Math.abs(a3)+Math.abs(b3));
        // Exact linear depth plane z(px, py) across perspective-projected planar quad.
        const invA=1/area2;
        const dzdx=((z1v-z0v)*(y2-y0)-(z2v-z0v)*(y1-y0))*invA;
        const dzdy=((x1-x0)*(z2v-z0v)-(x2-x0)*(z1v-z0v))*invA;
        const zBias=.5*(Math.abs(dzdx)+Math.abs(dzdy))+.0006;
        const zCap=Math.max(z0v,z1v,z2v,z3v)+.0006;
        for (let py=by0;py<=by1;py++) {
          const cy=py+.5;
          const row=py*W;
          const r0=b0*cy+c0, r1=b1*cy+c1, r2=b2*cy+c2, r3=b3*cy+c3;
          const zr=z0v+(cy-y0)*dzdy+zBias;
          for (let px=bx0;px<=bx1;px++) {
            const cx=px+.5;
            if (a0*cx+r0>=0 && a1*cx+r1>=0 && a2*cx+r2>=0 && a3*cx+r3>=0) {
              const zc=Math.min(zCap,zr+(cx-x0)*dzdx);
              const idx=row+px;
              if (zc<z0[idx]) {z0[idx]=zc;wrote++;}
            }
          }
        }
      }
    }
    if (!wrote) return;
    // Build 4-level conservative MAX-Z pyramid.
    const z1=this.z1, z2=this.z2, z3=this.z3;
    for (let y=0;y<H1;y++) {
      const r0=(y*2)*W, r1=r0+W, o=y*W1;
      for (let x=0;x<W1;x++) {
        const x2=x*2;
        const a=z0[r0+x2], b=z0[r0+x2+1], c=z0[r1+x2], d=z0[r1+x2+1];
        z1[o+x]=Math.max(a,b,c,d);
      }
    }
    for (let y=0;y<H2;y++) {
      const r0=(y*2)*W1, r1=r0+W1, o=y*W2;
      for (let x=0;x<W2;x++) {
        const x2=x*2;
        const a=z1[r0+x2], b=z1[r0+x2+1], c=z1[r1+x2], d=z1[r1+x2+1];
        z2[o+x]=Math.max(a,b,c,d);
      }
    }
    for (let y=0;y<H3;y++) {
      const r0=Math.min(y*2,H2-1)*W2, r1=Math.min(y*2+1,H2-1)*W2, o=y*W3;
      for (let x=0;x<W3;x++) {
        const x2=x*2;
        const a=z2[r0+x2], b=z2[r0+x2+1], c=z2[r1+x2], d=z2[r1+x2+1];
        z3[o+x]=Math.max(a,b,c,d);
      }
    }
    this.active=true;
  }

  // Returns false ONLY when the entire AABB is provably behind rasterized occluders.
  isBoxVisible(min,max,ox) {
    if (!this.active) return true;
    const vp=this.vp;
    const m0=vp[0],m1=vp[1],m2=vp[2],m3=vp[3];
    const m4=vp[4],m5=vp[5],m6=vp[6],m7=vp[7];
    const m8=vp[8],m9=vp[9],m10=vp[10],m11=vp[11];
    const m12=vp[12],m13=vp[13],m14=vp[14],m15=vp[15];
    const x0=min[0]+ox, x1=max[0]+ox, y0=min[1], y1=max[1], z0=min[2], z1=max[2];
    let minSx=W, maxSx=-1, minSy=H, maxSy=-1, minZ=1;
    for (let b=0;b<8;b++) {
      const x=(b&1)?x1:x0, y=(b&2)?y1:y0, z=(b&4)?z1:z0;
      const cw=m3*x+m7*y+m11*z+m15;
      if (cw<=.15) return true; // Crosses near plane: conservatively visible.
      const inv=1/cw;
      const sx=((m0*x+m4*y+m8*z+m12)*inv*.5+.5)*W;
      const sy=((m1*x+m5*y+m9*z+m13)*inv*.5+.5)*H;
      const sz=(m2*x+m6*y+m10*z+m14)*inv;
      if (sx<minSx) minSx=sx;
      if (sx>maxSx) maxSx=sx;
      if (sy<minSy) minSy=sy;
      if (sy>maxSy) maxSy=sy;
      if (sz<minZ) minZ=sz;
    }
    const ix0=Math.max(0,Math.floor(minSx)), ix1=Math.min(W-1,Math.floor(maxSx));
    const iy0=Math.max(0,Math.floor(minSy)), iy1=Math.min(H-1,Math.floor(maxSy));
    if (ix0>ix1 || iy0>iy1) return false;
    const span=Math.max(ix1-ix0+1,iy1-iy0+1);
    let buf, bw, tx0, tx1, ty0, ty1;
    if (span<=2) {buf=this.z0;bw=W;tx0=ix0;tx1=ix1;ty0=iy0;ty1=iy1;}
    else if (span<=4) {buf=this.z1;bw=W1;tx0=ix0>>1;tx1=ix1>>1;ty0=iy0>>1;ty1=iy1>>1;}
    else if (span<=8) {buf=this.z2;bw=W2;tx0=ix0>>2;tx1=ix1>>2;ty0=iy0>>2;ty1=iy1>>2;}
    else {buf=this.z3;bw=W3;tx0=ix0>>3;tx1=Math.min(W3-1,ix1>>3);ty0=iy0>>3;ty1=Math.min(H3-1,iy1>>3);}
    for (let y=ty0;y<=ty1;y++) {
      const row=y*bw;
      for (let x=tx0;x<=tx1;x++) {
        if (minZ<=buf[row+x]) return true;
      }
    }
    return false;
  }
}
