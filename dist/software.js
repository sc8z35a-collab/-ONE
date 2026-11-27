import {FILM_HEIGHT_TOLERANCE,decodeFilmHeight} from './ink-fluid.js';
import {OccluderCuller} from './occlusion.js';
import {Renderer,SUN,STRIDE,clamp,cross,dot,hazardDisk,labelAtlas,mantleMesh,meshes,mix,multiply,packInstance,perspective,sub,unit,view} from './render.js';

import {CITY_RADIUS,ZONES,inkOrigin,inkY,interiorBlend,zoneOf} from './layout.js';

const NEAR=.12;
const TAN_HALF_FOV=Math.tan(58*Math.PI/360);
const CITY_R2=CITY_RADIUS*CITY_RADIUS;
const CYAN0=16, CYAN1=207, CYAN2=186;
const AMBER0=239, AMBER1=103, AMBER2=52;
const SUN0=SUN[0], SUN1=SUN[1], SUN2=SUN[2];
const transparent=kind=>kind===7 || kind===12 || kind===16 || kind===17 || kind===24;
const pack=(r,g,b)=>(255<<24)|((b>255?255:b<0?0:b)<<16)|((g>255?255:g<0?0:g)<<8)|(r>255?255:r<0?0:r);

// Exact fast integer powers for Blinn-Phong specular (pow(x, 65) and pow(x, 95)).
function pow65(x) {
  let x2=x*x, x4=x2*x2, x8=x4*x4, x16=x8*x8, x32=x16*x16;
  return x32*x32*x;
}
function pow95(x) {
  let x2=x*x, x4=x2*x2, x8=x4*x4, x16=x8*x8, x32=x16*x16, x64=x32*x32;
  return x64*x16*x8*x4*x2*x;
}

// Builds a static baked instance with zero intermediate slice/array allocations.
function buildInstance(list,i,mesh) {
  const px=list[i+12], py=list[i+13], pz=list[i+14];
  const ax=list[i], ay=list[i+1], az=list[i+2];
  const bx=list[i+4], by=list[i+5], bz=list[i+6];
  const cx=list[i+8], cy=list[i+9], cz=list[i+10];
  const a2=ax*ax+ay*ay+az*az, b2=bx*bx+by*by+bz*bz, c2=cx*cx+cy*cy+cz*cz;
  const n0x=by*cz-bz*cy, n0y=bz*cx-bx*cz, n0z=bx*cy-by*cx;
  const n1x=cy*az-cz*ay, n1y=cz*ax-cx*az, n1z=cx*ay-cy*ax;
  const n2x=ay*bz-az*by, n2y=az*bx-ax*bz, n2z=ax*by-ay*bx;
  const det=ax*n0x+ay*n0y+az*n0z;
  const invDet=det?1/det:0;
  const m0x=n0x*invDet, m0y=n0y*invDet, m0z=n0z*invDet;
  const m1x=n1x*invDet, m1y=n1y*invDet, m1z=n1z*invDet;
  const m2x=n2x*invDet, m2y=n2y*invDet, m2z=n2z*invDet;

  const mv=mesh.vertices, mlen=mv.length;
  const v=new Float32Array(mlen);
  for (let j=0;j<mlen;j+=8) {
    const x=mv[j], y=mv[j+1], z=mv[j+2];
    const nx=mv[j+3], ny=mv[j+4], nz=mv[j+5];
    v[j]=px+ax*x+bx*y+cx*z;
    v[j+1]=py+ay*x+by*y+cy*z;
    v[j+2]=pz+az*x+bz*y+cz*z;
    v[j+3]=m0x*nx+m1x*ny+m2x*nz;
    v[j+4]=m0y*nx+m1y*ny+m2y*nz;
    v[j+5]=m0z*nx+m1z*ny+m2z*nz;
    v[j+6]=mv[j+6];
    v[j+7]=mv[j+7];
  }
  const idx=mesh.indices, ilen=idx.length;
  const faces=new Float32Array(ilen);
  for (let j=0;j<ilen;j+=3) {
    const ia=idx[j]*8, ib=idx[j+1]*8, ic=idx[j+2]*8;
    const fx=v[ia+3]+v[ib+3]+v[ic+3];
    const fy=v[ia+4]+v[ib+4]+v[ic+4];
    const fz=v[ia+5]+v[ib+5]+v[ic+5];
    const fl=Math.sqrt(fx*fx+fy*fy+fz*fz);
    const invF=fl>1e-5?1/fl:1e5;
    faces[j]=fx*invF; faces[j+1]=fy*invF; faces[j+2]=fz*invF;
  }
  const kind=list[i+19];
  return {
    px,py,pz,v,faces,radius:.5*Math.sqrt(a2+b2+c2),indices:idx,vLen:mlen,
    cr:list[i+16],cg:list[i+17],cb:list[i+18],kind,label:list[i+20],
    layer:list[i+21],stairDuplicate:list[i+22]>0,effect:list[i+23],
    isTrans:transparent(kind)
  };
}

// Writes a dynamic instance directly into caller-provided scratch buffers (zero allocations).
function fillScratchInstance(out,list,i,mesh) {
  const px=list[i+12], py=list[i+13], pz=list[i+14];
  const ax=list[i], ay=list[i+1], az=list[i+2];
  const bx=list[i+4], by=list[i+5], bz=list[i+6];
  const cx=list[i+8], cy=list[i+9], cz=list[i+10];
  const n0x=by*cz-bz*cy, n0y=bz*cx-bx*cz, n0z=bx*cy-by*cx;
  const n1x=cy*az-cz*ay, n1y=cz*ax-cx*az, n1z=cx*ay-cy*ax;
  const n2x=ay*bz-az*by, n2y=az*bx-ax*bz, n2z=ax*by-ay*bx;
  const det=ax*n0x+ay*n0y+az*n0z;
  const invDet=det?1/det:0;
  const m0x=n0x*invDet, m0y=n0y*invDet, m0z=n0z*invDet;
  const m1x=n1x*invDet, m1y=n1y*invDet, m1z=n1z*invDet;
  const m2x=n2x*invDet, m2y=n2y*invDet, m2z=n2z*invDet;

  const mv=mesh.vertices, mlen=mv.length;
  let v=out.v;
  if (v.length<mlen) v=out.v=new Float32Array(mlen);
  for (let j=0;j<mlen;j+=8) {
    const x=mv[j], y=mv[j+1], z=mv[j+2];
    const nx=mv[j+3], ny=mv[j+4], nz=mv[j+5];
    v[j]=px+ax*x+bx*y+cx*z;
    v[j+1]=py+ay*x+by*y+cy*z;
    v[j+2]=pz+az*x+bz*y+cz*z;
    v[j+3]=m0x*nx+m1x*ny+m2x*nz;
    v[j+4]=m0y*nx+m1y*ny+m2y*nz;
    v[j+5]=m0z*nx+m1z*ny+m2z*nz;
    v[j+6]=mv[j+6];
    v[j+7]=mv[j+7];
  }
  const idx=mesh.indices, ilen=idx.length;
  let faces=out.faces;
  if (faces.length<ilen) faces=out.faces=new Float32Array(ilen);
  for (let j=0;j<ilen;j+=3) {
    const ia=idx[j]*8, ib=idx[j+1]*8, ic=idx[j+2]*8;
    const fx=v[ia+3]+v[ib+3]+v[ic+3];
    const fy=v[ia+4]+v[ib+4]+v[ic+4];
    const fz=v[ia+5]+v[ib+5]+v[ic+5];
    const fl=Math.sqrt(fx*fx+fy*fy+fz*fz);
    const invF=fl>1e-5?1/fl:1e5;
    faces[j]=fx*invF; faces[j+1]=fy*invF; faces[j+2]=fz*invF;
  }
  out.px=px; out.py=py; out.pz=pz;
  out.indices=idx; out.vLen=mlen;
  out.cr=list[i+16]; out.cg=list[i+17]; out.cb=list[i+18];
  out.kind=list[i+19]; out.label=list[i+20]; out.layer=list[i+21];
  out.stairDuplicate=list[i+22]>0; out.effect=list[i+23];
  out.isTrans=transparent(out.kind);
  return out;
}

function filmOwnerFast(pixels,ownerArr,pw,ph,layer,u,v,y,tolerance) {
  const x=u<0?-1:(u|0), z=v<0?-1:(v|0);
  if (x<0 || x>=pw || z<0 || z>=ph) return 0;
  const a=layer+z*pw+x;
  const dx=x+1<pw?1:0, dz=z+1<ph?pw:0;
  const b=a+dx, c=a+dz, d=c+dx;
  const da=pixels[(a<<2)+3], db=pixels[(b<<2)+3], dc=pixels[(c<<2)+3], dd=pixels[(d<<2)+3];
  // Fast dry-pixel exit: 70-95% of ground pixels have zero film depth on all 4 taps!
  if ((da|db|dc|dd)===0) return 0;
  const aTeam=(da>0 && Math.abs(y-decodeFilmHeight(da))<tolerance)?ownerArr[a]:0;
  const bTeam=(db>0 && Math.abs(y-decodeFilmHeight(db))<tolerance)?ownerArr[b]:0;
  const cTeam=(dc>0 && Math.abs(y-decodeFilmHeight(dc))<tolerance)?ownerArr[c]:0;
  const dTeam=(dd>0 && Math.abs(y-decodeFilmHeight(dd))<tolerance)?ownerArr[d]:0;
  if (aTeam===bTeam && aTeam===cTeam && aTeam===dTeam) return aTeam;
  const tx=u-x, tz=v-z, itx=1-tx, itz=1-tz;
  const aw=itx*itz, bw=tx*itz, cw=itx*tz, dw=tx*tz;
  const cyan=(aTeam===1?aw:0)+(bTeam===1?bw:0)+(cTeam===1?cw:0)+(dTeam===1?dw:0);
  const amber=(aTeam===2?aw:0)+(bTeam===2?bw:0)+(cTeam===2?cw:0)+(dTeam===2?dw:0);
  return cyan+amber<.51?0:cyan>=amber?1:2;
}

// 16 logarithmic depth buckets for front-to-back Early-Z sorting of opaque geometry.
const BUCKET_COUNT=16;
function depthBucket(dist) {
  if (dist<=4) return 0;
  if (dist<=8) return 1;
  if (dist<=13) return 2;
  if (dist<=19) return 3;
  if (dist<=26) return 4;
  if (dist<=35) return 5;
  if (dist<=46) return 6;
  if (dist<=60) return 7;
  if (dist<=78) return 8;
  if (dist<=100) return 9;
  if (dist<=130) return 10;
  if (dist<=175) return 11;
  if (dist<=240) return 12;
  if (dist<=340) return 13;
  if (dist<=520) return 14;
  return 15;
}

const ZONE_KEYS=['static','lower','cabin','railCabin'];
function makeBatch(cap=64) {return {data:new Float32Array(cap*STRIDE),count:0};}
function pushBatch(batch,x,y,z,w,h,d,tint,kind,opts) {
  let off=batch.count*STRIDE, data=batch.data;
  if (off+STRIDE>data.length) {
    const next=new Float32Array(data.length*2);
    next.set(data);
    batch.data=data=next;
  }
  packInstance(data,off,x,y,z,w,h,d,tint,kind,opts);
  batch.count++;
}

export class SoftwareRenderer {
  constructor(canvas) {
    this.canvas=canvas;
    this.cpuRenderer=true;
    this.zone=0;
    this.lite=false;
    this.ctx=canvas.getContext('2d',{alpha:false});
    if (!this.ctx) throw new Error('Canvas 2D が利用できません。');
    this.mesh=meshes(true);
    this.batchNames=Object.keys(this.mesh);
    this.batches=Object.fromEntries(this.batchNames.map(name=>[name,{
      static:makeBatch(64),lower:makeBatch(32),cabin:makeBatch(16),railCabin:makeBatch(16),dynamic:makeBatch(64),adjacent:makeBatch(16)
    }]));
    this.static=[[],[],[],[]];
    this.staticChunks=[[],[],[],[]];
    this.occluder=new OccluderCuller();
    this._planes=Array.from({length:6},()=>new Float32Array(4));
    const atlas=labelAtlas();
    this.atlas=atlas.getContext('2d').getImageData(0,0,atlas.width,atlas.height).data;
    // Preallocated flat scratch buffers for zero-allocation per-frame projection, clipping, and dynamic transforms.
    this._pCap=256;
    this._pvx=new Float32Array(256); this._pvy=new Float32Array(256); this._pvz=new Float32Array(256);
    this._pwx=new Float32Array(256); this._pwy=new Float32Array(256); this._pwz=new Float32Array(256);
    this._pu=new Float32Array(256);  this._pv=new Float32Array(256);
    this._psx=new Float32Array(256); this._psy=new Float32Array(256); this._pq=new Float32Array(256);
    // Clipping polygon scratch (max 6 verts after near-plane clip of a triangle).
    this._cx=new Float32Array(8);  this._cy=new Float32Array(8);  this._cz=new Float32Array(8);
    this._cwx=new Float32Array(8); this._cwy=new Float32Array(8); this._cwz=new Float32Array(8);
    this._cu=new Float32Array(8);  this._cv=new Float32Array(8);
    this._csx=new Float32Array(8); this._csy=new Float32Array(8); this._cq=new Float32Array(8);
    // Reusable dynamic instance scratch + buckets + overlays + 16x16 conservative tile min-Q.
    this._dynScratch={px:0,py:0,pz:0,v:new Float32Array(2048),faces:new Float32Array(2048),radius:0,indices:null,vLen:0,cr:0,cg:0,cb:0,kind:0,label:0,layer:0,stairDuplicate:false,effect:0,isTrans:false};
    this._buckets=Array.from({length:BUCKET_COUNT},()=>[]);
    this._bucketEyes=Array.from({length:BUCKET_COUNT},()=>[]);
    this._decals=[];
    this._decalEyes=[];
    this._overlays=[];
    this._tileW=0; this._tileH=0; this._tileMinQ=null; this._tileValid=false;
  }

  _ensureProj(n) {
    if (n<=this._pCap) return;
    let nc=this._pCap;
    while (nc<n) nc*=2;
    this._pCap=nc;
    this._pvx=new Float32Array(nc); this._pvy=new Float32Array(nc); this._pvz=new Float32Array(nc);
    this._pwx=new Float32Array(nc); this._pwy=new Float32Array(nc); this._pwz=new Float32Array(nc);
    this._pu=new Float32Array(nc);  this._pv=new Float32Array(nc);
    this._psx=new Float32Array(nc); this._psy=new Float32Array(nc); this._pq=new Float32Array(nc);
  }

  add(type,x,y,z,w,h,d,tint,kind=0,opts={}) {
    const pair=this.batches[type];
    if (!pair) return;
    const batch=opts.dynamic?(this.drawingAdjacent?pair.adjacent:pair.dynamic):pair[ZONE_KEYS[this.zone]];
    pushBatch(batch,x,y,z,w,h,d,tint,kind,opts);
  }
  label(...args) { Renderer.prototype.label.call(this,...args); }
  beam(...args) { Renderer.prototype.beam.call(this,...args); }
  prepareView() {}
  inFrustum() { return true; }
  clearDynamic() {
    const names=this.batchNames, batches=this.batches;
    for (let i=0;i<names.length;i++) {
      const pair=batches[names[i]];
      pair.dynamic.count=0;
      pair.adjacent.count=0;
    }
  }
  project(point) { return Renderer.prototype.project.call(this,point); }

  setQuality(level) {
    this.quality=level===true?'lite':level===false?'high':level;
    this.lite=this.quality==='lite' || this.quality==='ultralite';
    this.ultralite=this.quality==='ultralite';
    this.ultra=this.quality==='ultra';
  }

  setMood({bossActive = false, raining = false, dt = 1/60} = {}) {
    const t=clamp(dt*1.35,0,1);
    this.bossRage=mix(this.bossRage??0,bossActive?1:0,t);
    this.rainLevel=mix(this.rainLevel??0,raining?1:0,t);
  }

  hideStaticRegion() {}

  seal() {
    this.occluder.clear();
    for (const [name,batch] of Object.entries(this.batches)) {
      const mesh=this.mesh[name];
      const lists=[batch.static,batch.lower,batch.cabin,batch.railCabin];
      for (let zone=0;zone<4;zone++) {
        const b=lists[zone], data=b.data, len=b.count*STRIDE, out=this.static[zone];
        for (let i=0;i<len;i+=STRIDE) {
          if (zone===0 && name==='box') {
            const k=data[i+19];
            if (k!==8 && k!==6 && k!==3) this.occluder.addBoxFromPacked(data,i);
          }
          out.push(buildInstance(data,i,mesh));
        }
        b.count=0;
      }
    }
    // Group static instances into 24m spatial chunks for O(chunks) frustum + Hi-Z occlusion culling.
    for (let zone=0;zone<4;zone++) {
      const map=new Map(), items=this.static[zone];
      for (let i=0;i<items.length;i++) {
        const it=items[i];
        const v=it.v, vLen=it.vLen;
        let x0=Infinity, y0=Infinity, z0=Infinity, x1=-Infinity, y1=-Infinity, z1=-Infinity;
        for (let j=0;j<vLen;j+=8) {
          const vx=v[j], vy=v[j+1], vz=v[j+2];
          if (vx<x0) x0=vx; if (vy<y0) y0=vy; if (vz<z0) z0=vz;
          if (vx>x1) x1=vx; if (vy>y1) y1=vy; if (vz>z1) z1=vz;
        }
        it.minX=x0; it.minY=y0; it.minZ=z0; it.maxX=x1; it.maxY=y1; it.maxZ=z1;
        const cx=Math.floor(it.px/24), cz=Math.floor(it.pz/24), key=cz*1024+cx;
        let ch=map.get(key);
        if (!ch) {
          ch={min:[x0,y0,z0],max:[x1,y1,z1],items:[]};
          map.set(key,ch);
        } else {
          if (x0<ch.min[0]) ch.min[0]=x0; if (y0<ch.min[1]) ch.min[1]=y0; if (z0<ch.min[2]) ch.min[2]=z0;
          if (x1>ch.max[0]) ch.max[0]=x1; if (y1>ch.max[1]) ch.max[1]=y1; if (z1>ch.max[2]) ch.max[2]=z1;
        }
        ch.items.push(it);
      }
      this.staticChunks[zone]=Array.from(map.values());
    }
  }

  configureWorld(world,paint) {
    this.world=world;
    this.shadow=null;
    if (this.lite) return;
    const map=new Uint8Array(paint.layerSize);
    const pw=paint.w, ph=paint.h, bxS=paint.boundX, bzS=paint.boundZ;
    const invBX=.5*pw/bxS, invBZ=.5*ph/bzS, halfW=.5*pw, halfH=.5*ph;
    const stepX=2*bxS/pw, stepZ=2*bzS/ph, orgX=-bxS+stepX*.5, orgZ=-bzS+stepZ*.5;
    const invS0=1/SUN0, invS1=1/SUN1, invS2=1/SUN2;
    const solids=world.solids;
    for (let si=0;si<solids.length;si++) {
      const {min,max}=solids[si];
      if (zoneOf(min[0])!==0) continue;
      const from=min[1]*invS1, to=max[1]*invS1;
      const x0=clamp(Math.floor((min[0]-SUN0*from)*invBX+halfW),0,pw-1);
      const x1=clamp(Math.ceil((max[0]-SUN0*to)*invBX+halfW),0,pw-1);
      const z0=clamp(Math.floor((min[2]-SUN2*to)*invBZ+halfH),0,ph-1);
      const z1=clamp(Math.ceil((max[2]-SUN2*from)*invBZ+halfH),0,ph-1);
      for (let j=z0;j<=z1;j++) {
        const z=orgZ+j*stepZ, row=j*pw;
        const tzEnter=(min[2]-z)*invS2, tzExit=(max[2]-z)*invS2;
        const baseEnter=from>tzEnter?from:tzEnter;
        const baseExit=to<tzExit?to:tzExit;
        if (baseExit<baseEnter) continue;
        for (let i=x0;i<=x1;i++) {
          const x=orgX+i*stepX;
          const txEnter=(max[0]-x)*invS0, txExit=(min[0]-x)*invS0;
          const enter=baseEnter>txEnter?baseEnter:txEnter;
          const exit=baseExit<txExit?baseExit:txExit;
          if (exit>=enter) map[row+i]=1;
        }
      }
    }
    this.shadow=map;
  }

  draw(camera,paint,clock=0) {
    const canvas=this.canvas;
    // Lightweight modes keep the same 400 / 300 lines as the WebGL renderer.
    const short=Math.max(1,Math.min(canvas.clientWidth,canvas.clientHeight));
    const ratio=this.lite?Math.min(1,(this.ultralite?300:400)/short):Math.min(1,1024/canvas.clientWidth,576/canvas.clientHeight);
    this.viewZone=zoneOf(camera.eye[0]);
    this.interior=interiorBlend(camera);
    if (!this.lite && !this.shadow && this.world) this.configureWorld(this.world,paint);
    const W=Math.max(1,Math.round(canvas.clientWidth*ratio));
    const H=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if (!this.image || W!==canvas.width || H!==canvas.height) {
      canvas.width=W;
      canvas.height=H;
      this.image=this.ctx.createImageData(W,H);
      this.buffer=new Uint32Array(this.image.data.buffer);
      this.depth=new Float32Array(W*H);
      this._tileW=(W+15)>>4;
      this._tileH=(H+15)>>4;
      this._tileMinQ=new Float32Array(this._tileW*this._tileH);
    }
    this.W=W;
    this.H=H;
    this.halfW=W*.5;
    this.halfH=H*.5;
    this.aspect=W/H;
    this.focal=H*.5/TAN_HALF_FOV;
    this.eye=camera.eye;
    this.direction=unit(sub(camera.target,camera.eye));
    this.right=unit(cross(this.direction,[0,1,0]));
    this.up=cross(this.right,this.direction);
    this.paint=paint;
    this.clock=clock;
    this.vp=multiply(perspective(W/H),view(camera.eye,camera.target));
    this.depth.fill(0);
    this._tileValid=false;

    // Extract frustum planes and build conservative CPU Hi-Z occluder map for Zone 0.
    const vp=this.vp, planes=this._planes;
    for (let p=0;p<6;p++) {
      const row=p>>1, s=(p&1)?-1:1;
      const a=vp[3]+s*vp[row], b0=vp[7]+s*vp[4+row], c=vp[11]+s*vp[8+row], d=vp[15]+s*vp[12+row];
      const len=Math.sqrt(a*a+b0*b0+c*c), inv=len>0?1/len:1;
      const dst=planes[p];
      dst[0]=a*inv; dst[1]=b0*inv; dst[2]=c*inv; dst[3]=d*inv;
    }
    const useOcc=this.viewZone===0 && !camera.stair && this.occluder.occluders.length>0;
    if (useOcc) this.occluder.build(vp,camera.eye,planes);

    const rage=this.bossRage??0, rain=this.rainLevel??0;
    const d1=this.direction[1], invF=1/this.focal, interior=this.interior, buf=this.buffer;
    for (let i=0;i<H;i++) {
      let y=d1+(this.halfH-i)*invF;
      if (y<0) y=0; else if (y>.76) y=.76;
      const a=Math.sqrt(y);
      const dayR=mix(218-a*98,86-a*32,rain), dayG=mix(234-a*46,98-a*32,rain), dayB=mix(243-a*22,110-a*28,rain);
      const sr=mix(dayR,64-a*48,rage), sg=mix(dayG,14-a*10,rage), sb=mix(dayB,16-a*11,rage);
      buf.fill(pack(mix(sr,67,interior),mix(sg,82,interior),mix(sb,75,interior)),i*W,(i+1)*W);
    }

    const r0=this.right[0], r1=this.right[1], r2=this.right[2];
    const u0=this.up[0],    u1=this.up[1],    u2=this.up[2];
    const f0=this.direction[0], f1=this.direction[1], f2=this.direction[2];
    const aspect=this.aspect, focal=this.focal;
    const buckets=this._buckets, bucketEyes=this._bucketEyes;
    for (let b=0;b<BUCKET_COUNT;b++) {buckets[b].length=0; bucketEyes[b].length=0;}
    const decals=this._decals, decalEyes=this._decalEyes, overlays=this._overlays;
    decals.length=0; decalEyes.length=0; overlays.length=0;

    const mergeStairs=!!camera.stair && this.viewZone<2;
    const viewCount=mergeStairs?2:1;
    const occ=useOcc && this.occluder.active?this.occluder:null;

    // Pass 1: Chunk-level Frustum + Hi-Z Occlusion culling -> front-to-back Early-Z bucketing!
    for (let vi=0;vi<viewCount;vi++) {
      const zone=vi===0?this.viewZone:(1-this.viewZone);
      const eye=[camera.eye[0]+ZONES[zone].x-ZONES[this.viewZone].x,camera.eye[1],camera.eye[2]];
      const ex=eye[0], ey=eye[1], ez=eye[2];
      const chunks=this.staticChunks[zone];
      const useChunkOcc=occ && zone===0 && vi===0;
      for (let ci=0;ci<chunks.length;ci++) {
        const ch=chunks[ci];
        if (vi===0) {
          const mn=ch.min, mx=ch.max;
          let outside=false;
          for (let p=0;p<6;p++) {
            const pl=planes[p];
            if (pl[0]*(pl[0]>=0?mx[0]:mn[0])+pl[1]*(pl[1]>=0?mx[1]:mn[1])+pl[2]*(pl[2]>=0?mx[2]:mn[2])+pl[3]<0) {outside=true;break;}
          }
          if (outside) continue;
          if (useChunkOcc && !occ.isBoxVisible(mn,mx,0)) continue;
        }
        const statics=ch.items;
        for (let i=0;i<statics.length;i++) {
          const item=statics[i];
          if (mergeStairs && item.stairDuplicate) continue;
          const rx=item.px-ex, ry=item.py-ey, rz=item.pz-ez;
          const dist=rx*f0+ry*f1+rz*f2;
          const rad=item.radius;
          if (dist+rad<NEAR || dist-rad>1200) continue;
          const span=dist*TAN_HALF_FOV;
          const dx=rx*r0+ry*r1+rz*r2;
          if (dx>span*aspect+rad*1.49 || dx<-(span*aspect+rad*1.49)) continue;
          const dy=rx*u0+ry*u1+rz*u2;
          if (dy>span+rad*1.31 || dy<-(span+rad*1.31)) continue;
          if (dist>25 && rad*focal<dist*.58) continue;
          if (item.isTrans) {
            overlays.push({item,eye,distance:dist});
          } else if (item.kind===26) {
            decals.push(item); decalEyes.push(eye);
          } else {
            const bk=depthBucket(dist);
            buckets[bk].push(item);
            bucketEyes[bk].push(eye);
          }
        }
      }
    }

    // Rasterize opaque static geometry strictly front-to-back with 16x16 Tile Min-Q updates!
    for (let b=0;b<BUCKET_COUNT;b++) {
      const list=buckets[b], eyes=bucketEyes[b];
      for (let i=0;i<list.length;i++) {
        this.eye=eyes[i];
        this.renderInstanceCulled(list[i]);
      }
      if (b===2 || b===5 || b===8) this._refreshTileMinQ();
    }

    // Pass 2: Pre-cull dynamic instances BEFORE building vertices (reads packed Float32Array).
    const names=this.batchNames, batches=this.batches, scratch=this._dynScratch;
    for (let vi=0;vi<viewCount;vi++) {
      const zone=vi===0?this.viewZone:(1-this.viewZone);
      const key=vi===0?'dynamic':'adjacent';
      const eye=[camera.eye[0]+ZONES[zone].x-ZONES[this.viewZone].x,camera.eye[1],camera.eye[2]];
      const ex=eye[0], ey=eye[1], ez=eye[2];
      this.eye=eye;
      for (let ni=0;ni<names.length;ni++) {
        const name=names[ni];
        const batch=batches[name][key];
        const len=batch.count*STRIDE;
        if (!len) continue;
        const list=batch.data;
        let mesh=this.mesh[name];
        if (!this.lite && name==='mantle') mesh=this.bossMantle??=mantleMesh(false);
        if (!this.lite && name==='hazard') mesh=this.bossWarning??=hazardDisk(false);
        for (let i=0;i<len;i+=STRIDE) {
          if (mergeStairs && list[i+22]>0) continue;
          const rx=list[i+12]-ex, ry=list[i+13]-ey, rz=list[i+14]-ez;
          const dist=rx*f0+ry*f1+rz*f2;
          const a0=list[i], a1=list[i+1], a2=list[i+2];
          const b0=list[i+4], b1=list[i+5], b2=list[i+6];
          const c0=list[i+8], c1=list[i+9], c2=list[i+10];
          const rad=.5*Math.sqrt(a0*a0+a1*a1+a2*a2+b0*b0+b1*b1+b2*b2+c0*c0+c1*c1+c2*c2);
          if (dist+rad<NEAR || dist-rad>1200) continue;
          const span=dist*TAN_HALF_FOV;
          const dx=rx*r0+ry*r1+rz*r2;
          if (dx>span*aspect+rad*1.49 || dx<-(span*aspect+rad*1.49)) continue;
          const dy=rx*u0+ry*u1+rz*u2;
          if (dy>span+rad*1.31 || dy<-(span+rad*1.31)) continue;
          if (dist>25 && rad*focal<dist*.58) continue;
          const kind=list[i+19];
          if (transparent(kind)) {
            overlays.push({item:buildInstance(list,i,mesh),eye,distance:dist});
          } else {
            scratch.radius=rad;
            fillScratchInstance(scratch,list,i,mesh);
            this.renderInstanceCulled(scratch);
          }
        }
      }
    }

    // Pass 3: Static decals (after opaque surfaces so depth tolerance works identically).
    this._tileValid=false;
    for (let i=0;i<decals.length;i++) {
      this.eye=decalEyes[i];
      this.renderInstanceCulled(decals[i]);
    }

    // Pass 4: Back-to-front transparent overlays.
    if (overlays.length>1) overlays.sort((a,b)=>b.distance-a.distance);
    for (let i=0;i<overlays.length;i++) {
      const o=overlays[i];
      this.eye=o.eye;
      this.renderInstanceCulled(o.item);
    }

    this.eye=camera.eye;
    this.ctx.putImageData(this.image,0,0);
    if (rain>.04 && this.viewZone===0 && this.interior<.7) {
      this.ctx.save();
      this.ctx.strokeStyle=`rgba(195,216,232,${(rain*.44*(1-this.interior*.7)).toFixed(3)})`;
      this.ctx.lineWidth=1;
      this.ctx.beginPath();
      const lines=Math.round(75*rain);
      for (let i=0;i<lines;i++) {
        const rx=((Math.sin(i*12.9898)*43758.5453%1+1)%1)*W;
        const ry=(((((Math.sin(i*78.233)*43758.5453%1)+1)%1)+clock*(1.6+(i%5)*.2))%1)*H;
        this.ctx.moveTo(rx,ry);
        this.ctx.lineTo(rx-4,ry+18);
      }
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  renderInstanceCulled(item) {
    const ex=this.eye[0], ey=this.eye[1], ez=this.eye[2];
    const relX=item.px-ex, relY=item.py-ey, relZ=item.pz-ez;
    const v=item.v, vLen=item.vLen, nVerts=vLen>>3;
    this._ensureProj(nVerts);

    const pvx=this._pvx, pvy=this._pvy, pvz=this._pvz;
    const pwx=this._pwx, pwy=this._pwy, pwz=this._pwz;
    const pu=this._pu,   pv=this._pv;
    const psx=this._psx, psy=this._psy, pq=this._pq;

    const r0=this.right[0], r1=this.right[1], r2=this.right[2];
    const u0=this.up[0],    u1=this.up[1],    u2=this.up[2];
    const f0=this.direction[0], f1=this.direction[1], f2=this.direction[2];
    const halfW=this.halfW, halfH=this.halfH, focal=this.focal;

    for (let vi=0, j=0;j<vLen;vi++, j+=8) {
      const wx=v[j], wy=v[j+1], wz=v[j+2];
      const dx=wx-ex, dy=wy-ey, dz=wz-ez;
      const vx=r0*dx+r1*dy+r2*dz;
      const vy=u0*dx+u1*dy+u2*dz;
      const vz=f0*dx+f1*dy+f2*dz;
      pvx[vi]=vx; pvy[vi]=vy; pvz[vi]=vz;
      pwx[vi]=wx; pwy[vi]=wy; pwz[vi]=wz;
      pu[vi]=v[j+6]; pv[vi]=v[j+7];
      if (vz>=NEAR) {
        const q=1/vz;
        pq[vi]=q;
        psx[vi]=halfW+vx*q*focal;
        psy[vi]=halfH-vy*q*focal;
      }
    }

    const rain=this.viewZone===0?(this.rainLevel??0)*(1-this.interior*.85):0;
    const d3d=Math.sqrt(relX*relX+relY*relY+relZ*relZ);
    const clearFog=clamp((d3d-13)/140,0,.69);
    const rainFog=rain>.01?clamp(1-Math.exp(-Math.max(0,d3d-2.5)*rain*.075),0,.96):0;
    const fog=clearFog>rainFog?clearFog:rainFog;
    const invFog=1-fog;
    const fogR=mix(.73,.36,rain)*fog, fogG=mix(.84,.41,rain)*fog, fogB=mix(.89,.46,rain)*fog;

    const kind=item.kind, lite=this.lite, interior=this.interior;
    const hasSpec=!lite && (kind===4 || kind===6 || kind===8 || kind===9 || kind===11 || kind===17 || kind===20);
    let hx=0, hy=0, hz=0, specPow65=false, specScale=0;
    if (hasSpec) {
      const invD=d3d>1e-5?1/d3d:1e5;
      const vx=-relX*invD+SUN0, vy=-relY*invD+SUN1, vz=-relZ*invD+SUN2;
      const hl=Math.sqrt(vx*vx+vy*vy+vz*vz);
      const invH=hl>1e-5?1/hl:1e5;
      hx=vx*invH; hy=vy*invH; hz=vz*invH;
      specPow65=kind===4;
      specScale=.29*(1-rain*.8);
    }

    const cr=item.cr, cg=item.cg, cb=item.cb;
    const indices=item.indices, faces=item.faces, ilen=indices.length;
    const isFloorKind=kind===1 || kind===5 || kind===15 || kind===22;
    const layerFloorY=isFloorKind?inkY(item.layer)-.055:0;
    const sunMul=.43*(1-rain*.75);
    const emissive=kind===3 || kind===24 || kind===25;

    for (let i=0;i<ilen;i+=3) {
      const i0=indices[i], i1=indices[i+1], i2=indices[i+2];
      const nx=faces[i], ny=faces[i+1], nz=faces[i+2];
      if (kind===22 && ny<.5) continue;
      if (nx*(ex-pwx[i0])+ny*(ey-pwy[i0])+nz*(ez-pwz[i0])<=0) continue;

      const z0=pvz[i0], z1=pvz[i1], z2=pvz[i2];
      if (z0<NEAR && z1<NEAR && z2<NEAR) continue;

      const nyPos=ny>0?ny:0;
      let lambert;
      if (kind===7) lambert=1;
      else if (emissive) lambert=1.16;
      else {
        const ndl=nx*SUN0+ny*SUN1+nz*SUN2;
        const daylight=.64+nyPos*.16+(ndl>0?ndl*sunMul:0);
        lambert=interior===0?daylight:daylight+(.85+nyPos*.12-daylight)*interior;
      }
      let shine=0;
      if (hasSpec) {
        const ndh=nx*hx+ny*hy+nz*hz;
        if (ndh>0) shine=(specPow65?pow65(ndh):pow95(ndh))*specScale;
      }
      const lMul=lambert*invFog;
      const tr=(cr*lMul+shine+fogR)*255;
      const tg=(cg*lMul+shine*.96+fogG)*255;
      const tb=(cb*lMul+shine*.86+fogB)*255;

      const surface=isFloorKind && ny>.48 &&
        (kind===15 || pwy[i0]>layerFloorY || pwy[i1]>layerFloorY || pwy[i2]>layerFloorY);

      if (z0>=NEAR && z1>=NEAR && z2>=NEAR) {
        this.rasterTri(
          psx[i0],psy[i0],pq[i0],pwx[i0],pwy[i0],pwz[i0],pu[i0],pv[i0],
          psx[i1],psy[i1],pq[i1],pwx[i1],pwy[i1],pwz[i1],pu[i1],pv[i1],
          psx[i2],psy[i2],pq[i2],pwx[i2],pwy[i2],pwz[i2],pu[i2],pv[i2],
          tr,tg,tb,item,nx,ny,nz,surface
        );
      } else {
        const cnt=this.clipTri(i0,i1,i2);
        const csx=this._csx, csy=this._csy, cq=this._cq;
        const cwx=this._cwx, cwy=this._cwy, cwz=this._cwz, cu=this._cu, cv=this._cv;
        for (let j=1;j<cnt-1;j++) {
          this.rasterTri(
            csx[0],csy[0],cq[0],cwx[0],cwy[0],cwz[0],cu[0],cv[0],
            csx[j],csy[j],cq[j],cwx[j],cwy[j],cwz[j],cu[j],cv[j],
            csx[j+1],csy[j+1],cq[j+1],cwx[j+1],cwy[j+1],cwz[j+1],cu[j+1],cv[j+1],
            tr,tg,tb,item,nx,ny,nz,surface
          );
        }
      }
    }
  }

  clipTri(i0,i1,i2) {
    const pvx=this._pvx, pvy=this._pvy, pvz=this._pvz;
    const pwx=this._pwx, pwy=this._pwy, pwz=this._pwz, pu=this._pu, pv=this._pv;
    const cx=this._cx, cy=this._cy, cz=this._cz;
    const cwx=this._cwx, cwy=this._cwy, cwz=this._cwz, cu=this._cu, cv=this._cv;
    const csx=this._csx, csy=this._csy, cq=this._cq;
    const halfW=this.halfW, halfH=this.halfH, focal=this.focal;
    let out=0, last=i2;
    for (let k=0;k<3;k++) {
      const next=k===0?i0:k===1?i1:i2;
      const lz=pvz[last], nz=pvz[next];
      const a=lz>=NEAR, b=nz>=NEAR;
      if (a!==b) {
        const t=(NEAR-lz)/(nz-lz);
        const vx=pvx[last]+(pvx[next]-pvx[last])*t;
        const vy=pvy[last]+(pvy[next]-pvy[last])*t;
        const q=1/NEAR;
        cx[out]=vx; cy[out]=vy; cz[out]=NEAR;
        cwx[out]=pwx[last]+(pwx[next]-pwx[last])*t;
        cwy[out]=pwy[last]+(pwy[next]-pwy[last])*t;
        cwz[out]=pwz[last]+(pwz[next]-pwz[last])*t;
        cu[out]=pu[last]+(pu[next]-pu[last])*t;
        cv[out]=pv[last]+(pv[next]-pv[last])*t;
        cq[out]=q; csx[out]=halfW+vx*q*focal; csy[out]=halfH-vy*q*focal;
        out++;
      }
      if (b) {
        const q=1/nz;
        cx[out]=pvx[next]; cy[out]=pvy[next]; cz[out]=nz;
        cwx[out]=pwx[next]; cwy[out]=pwy[next]; cwz[out]=pwz[next];
        cu[out]=pu[next]; cv[out]=pv[next];
        cq[out]=q; csx[out]=halfW+pvx[next]*q*focal; csy[out]=halfH-pvy[next]*q*focal;
        out++;
      }
      last=next;
    }
    return out;
  }

  _refreshTileMinQ() {
    const W=this.W, H=this.H, depth=this.depth, tw=this._tileW, th=this._tileH, out=this._tileMinQ;
    for (let ty=0;ty<th;ty++) {
      const y0=ty<<4, y1=y0+16<H?y0+16:H, tRow=ty*tw;
      for (let tx=0;tx<tw;tx++) {
        const x0=tx<<4, x1=x0+16<W?x0+16:W;
        let mn=1e9;
        for (let y=y0;y<y1;y++) {
          const row=y*W;
          for (let x=x0;x<x1;x++) {
            const d=depth[row+x];
            if (d<mn) {mn=d; if (mn===0) break;}
          }
          if (mn===0) break;
        }
        out[tRow+tx]=mn;
      }
    }
    this._tileValid=true;
  }

  // Analytical scanline span-clipping triangle rasterizer with 16x16 Tile Min-Q early reject
  // and specialized branch-free inner loops.
  rasterTri(ax,ay,qa,wxa,wya,wza,ua,va, bx,by,qb,wxb,wyb,wzb,ub,vb, cx,cy,qc,wxc,wyc,wzc,uc,vc, tr,tg,tb,item,nx,ny,nz,surface) {
    const W=this.W, H=this.H;
    const minX=ax<bx?(ax<cx?ax:cx):(bx<cx?bx:cx);
    const maxX=ax>bx?(ax>cx?ax:cx):(bx>cx?bx:cx);
    const minY=ay<by?(ay<cy?ay:cy):(by<cy?by:cy);
    const maxY=ay>by?(ay>cy?ay:cy):(by>cy?by:cy);
    const x0=minX<=.5?0:Math.ceil(minX-.5);
    const x1=maxX>=W-.5?W-1:Math.floor(maxX-.5);
    const y0=minY<=.5?0:Math.ceil(minY-.5);
    const y1=maxY>=H-.5?H-1:Math.floor(maxY-.5);
    if (x1<x0 || y1<y0) return;

    // Conservative 16x16 Tile Min-Q early reject: if max(qa,qb,qc) <= tileMinQ on every
    // overlapped 16x16 block, zero pixels can ever pass q > depth[idx] (100% bit-identical).
    if (this._tileValid && item.kind!==26) {
      const maxQ=qa>qb?(qa>qc?qa:qc):(qb>qc?qb:qc);
      const tx0=x0>>4, tx1=x1>>4, ty0=y0>>4, ty1=y1>>4, tw=this._tileW, tmq=this._tileMinQ;
      let anyPass=false;
      for (let ty=ty0;ty<=ty1 && !anyPass;ty++) {
        const tRow=ty*tw;
        for (let tx=tx0;tx<=tx1;tx++) {
          if (maxQ>tmq[tRow+tx]) {anyPass=true;break;}
        }
      }
      if (!anyPass) return;
    }

    const area=(bx-ax)*(cy-ay)-(cx-ax)*(by-ay);
    if (area>-1e-5 && area<1e-5) return;

    const ia=1/area;
    const dbx=(cy-ay)*ia, dby=(ax-cx)*ia;
    const dcx=(ay-by)*ia, dcy=(bx-ax)*ia;
    const dax=-(dbx+dcx), day=-(dby+dcy);

    // Precompute analytical inverse edge slopes for O(1) exact [xL, xR] clipping per scanline!
    const iax=(dax>1e-9 || dax<-1e-9)?-1/dax:0;
    const ibx=(dbx>1e-9 || dbx<-1e-9)?-1/dbx:0;
    const icx=(dcx>1e-9 || dcx<-1e-9)?-1/dcx:0;

    // Barycentric values at (x=0.5, y=y0+0.5) relative to pixel index x (so val(x) = base + x*dx).
    const sy0=y0+.5-ay, sxOff=.5-ax;
    let B0=sxOff*dbx+sy0*dby, C0=sxOff*dcx+sy0*dcy, A0=1-B0-C0;

    // Linear depth q(x, y) = qa + B*(qb-qa) + C*(qc-qa)
    const qbA=qb-qa, qcA=qc-qa;
    const dqdx=dbx*qbA+dcx*qcA, dqdy=dby*qbA+dcy*qcA;
    let qRow=qa+B0*qbA+C0*qcA;

    const depth=this.depth, buf=this.buffer;
    const kind=item.kind, isTrans=item.isTrans;
    const base=pack(tr,tg,tb);
    const label=kind===7, hazard=kind===24;
    const windows=kind===11 && ny<.5 && ny>-.5;
    const masonry=kind===13 && ny<.6 && ny>-.6;
    const material=!this.lite && (kind===2 || kind===4 || kind===8 || kind===9 || kind===18 || kind===19 || kind===20 || kind===21);
    const textured=surface || label || windows || masonry || material || kind===27;
    const EPS=1e-5;

    // ---- FAST PATH 0: Flat Opaque (70%+ of all triangles — pure Z-compare + 32-bit store!) ----
    if (!textured && !hazard && !isTrans) {
      const isDecal=kind===26;
      for (let y=y0;y<=y1;y++, A0+=day, B0+=dby, C0+=dcy, qRow+=dqdy) {
        let xL=x0, xR=x1;
        if (iax<0) {const t=(A0+EPS)*iax; if (t>xL) xL=t;}
        else if (iax>0) {const t=(A0+EPS)*iax; if (t<xR) xR=t;}
        else if (A0<-EPS) continue;

        if (ibx<0) {const t=(B0+EPS)*ibx; if (t>xL) xL=t;}
        else if (ibx>0) {const t=(B0+EPS)*ibx; if (t<xR) xR=t;}
        else if (B0<-EPS) continue;

        if (icx<0) {const t=(C0+EPS)*icx; if (t>xL) xL=t;}
        else if (icx>0) {const t=(C0+EPS)*icx; if (t<xR) xR=t;}
        else if (C0<-EPS) continue;

        const sx0=xL<=x0?x0:Math.ceil(xL), sx1=xR>=x1?x1:Math.floor(xR);
        if (sx0>sx1) continue;
        let idx=y*W+sx0, q=qRow+sx0*dqdx;
        if (!isDecal) {
          for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx) {
            if (q>depth[idx]) {depth[idx]=q; buf[idx]=base;}
          }
        } else {
          for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx) {
            const d=depth[idx];
            if (q>d || d-q<q*.000012) {depth[idx]=q; buf[idx]=base;}
          }
        }
      }
      return;
    }

    // ---- FAST PATH 1: Flat Transparent (glass, curtains, ripples, shades) ----
    if (!textured && !hazard && isTrans) {
      const opacity=kind===17?.21:kind===16?.34*(1-item.label*.64):(1-item.label)*.37;
      const invOp=1-opacity, addR=tr*opacity, addG=tg*opacity, addB=tb*opacity;
      for (let y=y0;y<=y1;y++, A0+=day, B0+=dby, C0+=dcy, qRow+=dqdy) {
        let xL=x0, xR=x1;
        if (iax<0) {const t=(A0+EPS)*iax; if (t>xL) xL=t;}
        else if (iax>0) {const t=(A0+EPS)*iax; if (t<xR) xR=t;}
        else if (A0<-EPS) continue;
        if (ibx<0) {const t=(B0+EPS)*ibx; if (t>xL) xL=t;}
        else if (ibx>0) {const t=(B0+EPS)*ibx; if (t<xR) xR=t;}
        else if (B0<-EPS) continue;
        if (icx<0) {const t=(C0+EPS)*icx; if (t>xL) xL=t;}
        else if (icx>0) {const t=(C0+EPS)*icx; if (t<xR) xR=t;}
        else if (C0<-EPS) continue;
        const sx0=xL<=x0?x0:Math.ceil(xL), sx1=xR>=x1?x1:Math.floor(xR);
        if (sx0>sx1) continue;
        let idx=y*W+sx0, q=qRow+sx0*dqdx;
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx) {
          if (q<=depth[idx]) continue;
          const under=buf[idx];
          buf[idx]=pack((under&255)*invOp+addR,((under>>>8)&255)*invOp+addG,((under>>>16)&255)*invOp+addB);
        }
      }
      return;
    }

    // ---- FAST PATH 2: Ground/Road Paintable Surfaces (linear qx/qy/qz + Early-Z + wet-tile fast-skip!) ----
    if (surface) {
      const p=this.paint, pw=p.w, ph=p.h, pixels=p.pixels, ownerArr=p.owner;
      const layer=item.layer*p.layerSize;
      const wetWords=p.wetTileWords, wetLayerOff=wetWords?item.layer*p.wetTileStride:0, twpr=p.tileWordsPerRow;
      const inkMap=this.lite || this.interior>.5?null:this.shadow;
      const originX=inkOrigin(item.layer);
      const uScale=.5*pw/p.boundX, uOff=.5*pw-originX*uScale;
      const vScale=.5*ph/p.boundZ, vOff=.5*ph;
      const tolerance=kind===15 || item.layer===4?.207:FILM_HEIGHT_TOLERANCE;
      const isRoad=kind===5, noShadowLayer=item.layer!==0;
      const eyeX=this.eye[0], eyeY=this.eye[1], eyeZ=this.eye[2];
      const lite=this.lite, clk48=this.clock*4.8, clk32=this.clock*3.2;

      const xA=wxa*qa, xB=wxb*qb-xA, xC=wxc*qc-xA;
      const yA=wya*qa, yB=wyb*qb-yA, yC=wyc*qc-yA;
      const zA=wza*qa, zB=wzb*qb-zA, zC=wzc*qc-zA;
      const dxdx=dbx*xB+dcx*xC, dxdy=dby*xB+dcy*xC;
      const dydx=dbx*yB+dcx*yC, dydy=dby*yB+dcy*yC;
      const dzdx=dbx*zB+dcx*zC, dzdy=dby*zB+dcy*zC;
      let xRow=xA+B0*xB+C0*xC, yRow=yA+B0*yB+C0*yC, zRow=zA+B0*zB+C0*zC;

      for (let y=y0;y<=y1;y++, A0+=day, B0+=dby, C0+=dcy, qRow+=dqdy, xRow+=dxdy, yRow+=dydy, zRow+=dzdy) {
        let xL=x0, xR=x1;
        if (iax<0) {const t=(A0+EPS)*iax; if (t>xL) xL=t;}
        else if (iax>0) {const t=(A0+EPS)*iax; if (t<xR) xR=t;}
        else if (A0<-EPS) continue;
        if (ibx<0) {const t=(B0+EPS)*ibx; if (t>xL) xL=t;}
        else if (ibx>0) {const t=(B0+EPS)*ibx; if (t<xR) xR=t;}
        else if (B0<-EPS) continue;
        if (icx<0) {const t=(C0+EPS)*icx; if (t>xL) xL=t;}
        else if (icx>0) {const t=(C0+EPS)*icx; if (t<xR) xR=t;}
        else if (C0<-EPS) continue;
        const sx0=xL<=x0?x0:Math.ceil(xL), sx1=xR>=x1?x1:Math.floor(xR);
        if (sx0>sx1) continue;

        let idx=y*W+sx0, q=qRow+sx0*dqdx;
        let qx=xRow+sx0*dxdx, qy=yRow+sx0*dydx, qz=zRow+sx0*dzdx;
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qx+=dxdx, qy+=dydx, qz+=dzdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q;
          const wx=qx*invQ, wy=qy*invQ, wz=qz*invQ;
          const u=wx*uScale+uOff, v=wz*vScale+vOff;
          const within=u>=0 && u<pw && v>=0 && v<ph;
          const iu=within?(u|0):0, iv=within?(v|0):0;
          const cell=within?(iv*pw+iu):-1;
          let owner=0;
          if (within) {
            if (!wetWords || (wetWords[wetLayerOff+(iv>>4)*twpr+(iu>>9)]&(1<<((iu>>4)&31)))!==0 || ((iu&15)===0 || (iu&15)===15 || (iv&15)===0 || (iv&15)===15)) {
              owner=filmOwnerFast(pixels,ownerArr,pw,ph,layer,u-.5,v-.5,wy,tolerance);
            }
          }
          const gx=wx*19, gz=wz*19;
          const fx=gx>=0?(gx|0):((gx|0)===gx?(gx|0):(gx|0)-1);
          const fz=gz>=0?(gz|0):((gz|0)===gz?(gz|0):(gz|0)-1);
          const hash=((Math.imul(fx,4787)^Math.imul(fz,60757))&127)*(1/127);
          const shadowed=within && inkMap!==null && !noShadowLayer && inkMap[cell];
          const shade=(shadowed?.87:1)*(.96+hash*.066);
          if (owner===0) {
            // Fast unpainted surface path: skip sqrt, pow5, sin/cos wave!
            let sh=0;
            if (isRoad) {
              const s=Math.sin(wx*.81+wz*.36)-.23;
              if (s>0) sh=s*4.1;
            }
            depth[idx]=q;
            buf[idx]=pack(tr*shade+sh,tg*shade+sh,tb*shade+sh*1.35);
          } else {
            const vx=eyeX-wx, vy=eyeY-wy, vz=eyeZ-wz;
            const invV=1/Math.max(.1,Math.sqrt(vx*vx+vy*vy+vz*vz));
            const g1=1-(vy>0?vy*invV:0), g2=g1*g1, grazing=g2*g2*g1;
            const wave=lite?0:Math.sin(wx*9.2+wz*5.4-clk48)*Math.cos(wz*8.9+clk32);
            const shimmer=5+grazing*43+wave*2.1;
            const wet=within?pixels[((cell+layer)<<2)+2]*(1/255):0;
            const light=(.95+wet*.06)*shade;
            let inkR, inkG, inkB;
            if (owner===3) {inkR=26; inkG=18; inkB=34;}
            else if (owner===2) {inkR=AMBER0; inkG=AMBER1; inkB=AMBER2;}
            else {inkR=CYAN0; inkG=CYAN1; inkB=CYAN2;}
            depth[idx]=q;
            buf[idx]=pack(inkR*light+shimmer,inkG*light+shimmer,inkB*light+shimmer*1.35);
          }
        }
      }
      return;
    }

    // ---- PATH 3: Specialized UV / Procedural Materials (label, hazard, windows, masonry, material, city-ring) ----
    const xA=wxa*qa, xB=wxb*qb-xA, xC=wxc*qc-xA;
    const yA=wya*qa, yB=wyb*qb-yA, yC=wyc*qc-yA;
    const zA=wza*qa, zB=wzb*qb-zA, zC=wzc*qc-zA;
    const uA=ua*qa,  uB=ub*qb-uA,  uC=uc*qc-uA;
    const vA=va*qa,  vB=vb*qb-vA,  vC=vc*qc-vA;
    const dxdx=dbx*xB+dcx*xC, dxdy=dby*xB+dcy*xC;
    const dydx=dbx*yB+dcx*yC, dydy=dby*yB+dcy*yC;
    const dzdx=dbx*zB+dcx*zC, dzdy=dby*zB+dcy*zC;
    const dudx=dbx*uB+dcx*uC, dudy=dby*uB+dcy*uC;
    const dvdx=dbx*vB+dcx*vC, dvdy=dby*vB+dcy*vC;
    let xRow=xA+B0*xB+C0*xC, yRow=yA+B0*yB+C0*yC, zRow=zA+B0*zB+C0*zC;
    let uRow=uA+B0*uB+C0*uC, vRow=vA+B0*vB+C0*vC;

    const labelX=(item.label%4)*256, labelY=Math.floor(item.label/4)*96;
    const atlas=this.atlas;
    const useZ=nx>.5 || nx<-.5;
    const eyeX=this.eye[0], eyeY=this.eye[1], eyeZ=this.eye[2];
    const isGlassMat=material && kind===8, isMetalMat=material && kind===4;
    const isCityRing=kind===27;
    const edge=hazard?item.layer*Math.PI:0;

    for (let y=y0;y<=y1;y++, A0+=day, B0+=dby, C0+=dcy, qRow+=dqdy, xRow+=dxdy, yRow+=dydy, zRow+=dzdy, uRow+=dudy, vRow+=dvdy) {
      let xL=x0, xR=x1;
      if (iax<0) {const t=(A0+EPS)*iax; if (t>xL) xL=t;}
      else if (iax>0) {const t=(A0+EPS)*iax; if (t<xR) xR=t;}
      else if (A0<-EPS) continue;
      if (ibx<0) {const t=(B0+EPS)*ibx; if (t>xL) xL=t;}
      else if (ibx>0) {const t=(B0+EPS)*ibx; if (t<xR) xR=t;}
      else if (B0<-EPS) continue;
      if (icx<0) {const t=(C0+EPS)*icx; if (t>xL) xL=t;}
      else if (icx>0) {const t=(C0+EPS)*icx; if (t<xR) xR=t;}
      else if (C0<-EPS) continue;
      const sx0=xL<=x0?x0:Math.ceil(xL), sx1=xR>=x1?x1:Math.floor(xR);
      if (sx0>sx1) continue;

      let idx=y*W+sx0, q=qRow+sx0*dqdx;
      let qx=xRow+sx0*dxdx, qy=yRow+sx0*dydx, qz=zRow+sx0*dzdx;
      let qu=uRow+sx0*dudx, qv=vRow+sx0*dvdx;

      if (hazard) {
        const eff=item.effect, lbl=item.label;
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qu+=dudx, qv+=dvdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q, u=qu*invQ, r=qv*invQ;
          const angle=(u>.5?u-1:u)*Math.PI*2;
          if (edge>0 && (angle>edge || angle<-edge)) continue;
          const travel=edge>0?(angle+edge)/(edge*2):r;
          const ring=Math.abs(r-.96)<.032 || (edge>0 && Math.abs(angle)>edge-.057);
          const pulse=Math.max(0,1-Math.abs(travel-lbl)*15);
          const opacity=eff>=1?(.17+.53*pulse)*Math.max(0,2-eff):(ring?.82:.10+.29*pulse+(r>.86 && (u*48%1)>.68?.28:0));
          const under=buf[idx], invOp=1-opacity;
          buf[idx]=pack((under&255)*invOp+tr*opacity,((under>>>8)&255)*invOp+tg*opacity,((under>>>16)&255)*invOp+tb*opacity);
        }
      } else if (label) {
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qu+=dudx, qv+=dvdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q, u=qu*invQ, t=qv*invQ;
          const ayi=clamp(Math.floor((1-t)*96),0,95), axi=clamp(Math.floor(u*256),0,255);
          const opacity=atlas[((((labelY+ayi)<<10)+labelX+axi)<<2)+3]*(1/255);
          if (opacity<.012) continue;
          const under=buf[idx], invOp=1-opacity;
          buf[idx]=pack((under&255)*invOp+tr*opacity,((under>>>8)&255)*invOp+tg*opacity,((under>>>16)&255)*invOp+tb*opacity);
        }
      } else if (isCityRing) {
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qx+=dxdx, qz+=dzdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q, wx=qx*invQ, wz=qz*invQ;
          if (wx*wx+wz*wz>CITY_R2) continue;
          depth[idx]=q; buf[idx]=base;
        }
      } else if (masonry) {
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qx+=dxdx, qy+=dydx, qz+=dzdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q, wy=qy*invQ;
          const horiz=useZ?qz*invQ:qx*invQ;
          const row=Math.floor(wy*(1/.296)), stone=horiz*(1/.69)+(row&1)*.5;
          const fStone=Math.floor(stone), side=stone-fStone, level=wy*(1/.296)-row;
          const sMin=side<1-side?side:1-side, lMin=level<1-level?level:1-level;
          const joint=sMin*.69<.021 || lMin*.296<.018;
          const grain=((Math.imul(fStone,5139)^Math.imul(row,3091))&127)*(1/127);
          const tone=joint?.84:.93+grain*.13;
          depth[idx]=q; buf[idx]=pack(tr*tone,tg*tone,tb*tone);
        }
      } else if (material) {
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qx+=dxdx, qy+=dydx, qz+=dzdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q, wx=qx*invQ, wy=qy*invQ, wz=qz*invQ;
          depth[idx]=q;
          if (isGlassMat) {
            const dist=invQ>1?invQ:1;
            const refl=clamp((eyeY-wy)/dist*.5+.5,0,1);
            buf[idx]=pack(tr*.65+42*refl,tg*.69+62*refl,tb*.73+70*refl);
          } else if (isMetalMat) {
            const b=.96+.04*Math.sin(wy*190);
            buf[idx]=pack(tr*b,tg*b,tb*b);
          } else {
            const grain=((Math.imul(Math.floor(wx*38),4787)^Math.imul(Math.floor((wy+wz)*38),60757))&127)*(1/127);
            const b=.96+grain*.07;
            buf[idx]=pack(tr*b,tg*b,tb*b);
          }
        }
      } else {
        // Skyscraper procedural parallax windows (kind === 11)
        const blindCol=pack(tr*1.04,tg*1.02,tb*.95);
        for (let x=sx0;x<=sx1;x++, idx++, q+=dqdx, qx+=dxdx, qy+=dydx, qz+=dzdx) {
          if (q<=depth[idx]) continue;
          const invQ=1/q, wy=qy*invQ;
          const hCoord=useZ?qz*invQ:qx*invQ;
          const u=hCoord*(1/2.2), v=wy*(1/3.15);
          const fu=Math.floor(u), fv=Math.floor(v);
          const ux=u-fu, vy=v-fv;
          depth[idx]=q;
          if (ux>.13 && ux<.9 && vy>.21 && vy<.89) {
            if (vy>.69 && ((fu+fv)&3)===0) {
              buf[idx]=blindCol;
            } else {
              const dist=invQ>1?invQ:1;
              const drift=((useZ?eyeZ:eyeX)-hCoord)*.065/dist;
              const roomX=ux+drift;
              const tone=(roomX<.24 || roomX>.80)?.65:vy<.30?.59:(roomX>.31 && roomX<.43 && vy<.48)?.53:.87;
              buf[idx]=pack(tr*tone,tg*(tone+.08),tb*(tone+.12));
            }
          } else {
            buf[idx]=base;
          }
        }
      }
    }
  }
}
