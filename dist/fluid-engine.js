import {BOUNDS,PAINT_LAYERS,UNDER_BOUNDS,UNDER_X,UNDER_Y,ZONES,localX,zoneOf} from './layout.js';
import {STAIRS,STAIR_RUN,STAIR_SEAM,stairAt} from './stairs.js';

// Physical constants (SI-grounded, scaled only where arena gameplay needs real-time feedback).
export const GRAVITY=9.81;
export const AIR_DENSITY=1.225;
export const FLUID_MEDIA={
  water:{name:'water',density:1000,viscosity:0.001,yieldStress:0,surfaceTension:0.0728,manning:0.015},
  ink:{name:'ink',density:1140,viscosity:0.042,yieldStress:0.28,surfaceTension:0.048,manning:0.028},
  boss:{name:'boss',density:1280,viscosity:0.058,yieldStress:0.22,surfaceTension:0.041,manning:0.032}
};

// Surface drain & stairwell intake geometry connecting Zone 0 -> Zone 1 (B1).
export const STORM_DRAINS=[
  ...STAIRS.map(s=>({
    kind:'stair',id:s.id,
    sx:s.x+s.dir*(STAIR_RUN*.35), sz:s.z,
    ux:UNDER_X+s.x+s.dir*(STAIR_RUN*.82), uz:s.z,
    radius:2.8,area:4.2,cd:0.68
  })),
  {kind:'grate',id:'west-n',sx:-29.8,sz:-7.31,ux:UNDER_X-29.8,uz:-7.31,radius:2.2,area:1.8,cd:0.62},
  {kind:'grate',id:'west-s',sx:-29.8,sz:7.31,ux:UNDER_X-29.8,uz:7.31,radius:2.2,area:1.8,cd:0.62},
  {kind:'grate',id:'east-n',sx:27.9,sz:-7.31,ux:UNDER_X+27.9,uz:-7.31,radius:2.2,area:1.8,cd:0.62},
  {kind:'grate',id:'east-s',sx:27.9,sz:7.31,ux:UNDER_X+27.9,uz:7.31,radius:2.2,area:1.8,cd:0.62},
  {kind:'grate',id:'mid-n',sx:0,sz:-7.8,ux:UNDER_X,uz:-7.8,radius:2.2,area:1.9,cd:0.64},
  {kind:'grate',id:'mid-s',sx:0,sz:7.8,ux:UNDER_X,uz:7.8,radius:2.2,area:1.9,cd:0.64}
];

const DX=2.0, INV_DX=1/DX;
const SURF_HALF_X=92, SURF_HALF_Z=76;
const UNDER_HALF_X=UNDER_BOUNDS[0], UNDER_HALF_Z=UNDER_BOUNDS[1];
const H_MIN=1e-5;
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;

// Precomputed 2048-entry LUT for 1 / Math.pow(effH, 1.3333) over [0.015, 4.8]
// (replaces expensive Math.pow per wet cell with <1e-5 relative error).
const POW43_MIN=0.015, POW43_MAX=4.8, POW43_N=2048;
const POW43_SCALE=(POW43_N-1)/(POW43_MAX-POW43_MIN);
const INV_POW43_LUT=new Float32Array(POW43_N);
for (let i=0;i<POW43_N;i++) {
  const h=POW43_MIN+(i/(POW43_N-1))*(POW43_MAX-POW43_MIN);
  INV_POW43_LUT[i]=1/Math.pow(h,1.3333);
}
function invPow43(h) {
  if (h<=POW43_MIN) return INV_POW43_LUT[0];
  if (h>=POW43_MAX) return INV_POW43_LUT[POW43_N-1];
  const f=(h-POW43_MIN)*POW43_SCALE;
  const idx=f|0;
  const v0=INV_POW43_LUT[idx];
  return v0+(INV_POW43_LUT[idx+1]-v0)*(f-idx);
}

const _projFluidOut={breakup:false,drop:null,weber:0,reynolds:0,gamma:0};

function rainTerminalVelocity(diameterM,media) {
  const Cd=0.52;
  const num=4*GRAVITY*diameterM*Math.max(100,media.density-AIR_DENSITY);
  const den=3*AIR_DENSITY*Cd;
  return Math.sqrt(num/den);
}

class ShallowGrid {
  constructor(originX,halfX,halfZ,zoneIndex,world) {
    this.originX=originX;
    this.halfX=halfX;
    this.halfZ=halfZ;
    this.zoneIndex=zoneIndex;
    this.nx=Math.round((halfX*2)/DX);
    this.nz=Math.round((halfZ*2)/DX);
    this.count=this.nx*this.nz;
    this.hWater=new Float32Array(this.count);
    this.hBoss=new Float32Array(this.count);
    this.ux=new Float32Array(this.count);
    this.uz=new Float32Array(this.count);
    this.nhWater=new Float32Array(this.count);
    this.nhBoss=new Float32Array(this.count);
    this.nux=new Float32Array(this.count);
    this.nuz=new Float32Array(this.count);
    this.bed=new Float32Array(this.count);
    this.shelter=new Float32Array(this.count);
    this.fx=new Float32Array(this.count);
    this.fz=new Float32Array(this.count);
    // 3-buffer active-row frontier for O(active) shallow-water stepping + zero-copy ping-pong swaps.
    this.rowActive=new Uint8Array(this.nz);
    this.nextRowActive=new Uint8Array(this.nz);
    this.backRowDirty=new Uint8Array(this.nz);
    this.hasActivity=false;
    this.openSkyIdx=null;
    this.openSkyExp=null;
    this.openSkyRowMask=new Uint8Array(this.nz);
    this.totalWaterVolume=0;
    this.totalBossVolume=0;
    this.maxDepth=0;
    this.maxSpeed=0;
    this.meanBossDepth=0;
    this.meanWaterDepth=0;
    this.initTopography(world);
  }

  initTopography(world) {
    const baseFloor=this.zoneIndex===1?UNDER_Y:0;
    const homes=this.zoneIndex===0?world?.homes:null;
    const hasFloor=!!world?.floor;
    const hasCeiling=!!world?.ceiling;
    const openIdx=[], openExp=[];
    for (let iz=0;iz<this.nz;iz++) {
      const wz=-this.halfZ+(iz+.5)*DX;
      for (let ix=0;ix<this.nx;ix++) {
        const lx=-this.halfX+(ix+.5)*DX;
        const wx=this.originX+lx;
        const idx=iz*this.nx+ix;
        let bed=0;
        let openSky=this.zoneIndex===0?1:0;
        if (hasFloor) {
          const fl=world.floor(wx,wz,baseFloor+3);
          if (fl && Number.isFinite(fl.y)) bed=fl.y-baseFloor;
        }
        // Subtle street crown (center road slightly lower toward curb/drains) so sheet runoff feeds drains.
        if (this.zoneIndex===0) {
          const awz=wz<0?-wz:wz;
          const roadSlope=awz<11?.04*(1-awz/11):0;
          bed-=roadSlope;
          const st=stairAt(wx,wz,1.2);
          if (st) {
            bed=Math.min(bed,-0.32-st.t*0.14);
            openSky=.75;
          }
          if (hasCeiling) {
            const ceil=world.ceiling(wx,wz,baseFloor+2.5);
            if (ceil && Number.isFinite(ceil.y)) openSky=0.05;
          }
          if (homes) {
            for (let hi=0;hi<homes.length;hi++) {
              const h=homes[hi];
              if (wx>=h.x0 && wx<=h.x1 && wz>=h.z0 && wz<=h.z1) {openSky=0; break;}
            }
          }
        } else {
          // B1 central exchange trench sits slightly below concourse slabs, collecting percolating black ink.
          if (Math.abs(wz)<7.5 && Math.abs(lx)<48) bed-=0.08;
        }
        this.bed[idx]=clamp(bed,-3.2,8.5);
        this.shelter[idx]=openSky;
        if (openSky>0.02) {
          openIdx.push(idx);
          openExp.push(openSky);
          this.openSkyRowMask[iz]=1;
        }
      }
    }
    this.openSkyIdx=Int32Array.from(openIdx);
    this.openSkyExp=Float32Array.from(openExp);
  }

  markRow(iz) {
    this.rowActive[iz]=1;
    this.hasActivity=true;
  }

  markAllOpenSkyActive() {
    const mask=this.openSkyRowMask, ra=this.rowActive;
    for (let iz=0;iz<this.nz;iz++) if (mask[iz]) ra[iz]=1;
    if (this.openSkyIdx.length) this.hasActivity=true;
  }

  markAllActive() {
    this.rowActive.fill(1);
    this.hasActivity=true;
  }

  reset() {
    this.hWater.fill(0);
    this.hBoss.fill(0);
    this.ux.fill(0);
    this.uz.fill(0);
    this.nhWater.fill(0);
    this.nhBoss.fill(0);
    this.nux.fill(0);
    this.nuz.fill(0);
    this.fx.fill(0);
    this.fz.fill(0);
    this.rowActive.fill(0);
    this.nextRowActive.fill(0);
    this.backRowDirty.fill(0);
    this.hasActivity=false;
    this.totalWaterVolume=0;
    this.totalBossVolume=0;
    this.maxDepth=0;
    this.maxSpeed=0;
    this.meanBossDepth=0;
    this.meanWaterDepth=0;
  }

  indexAtWorld(wx,wz) {
    const lx=wx-this.originX;
    const ix=Math.floor((lx+this.halfX)*INV_DX);
    const iz=Math.floor((wz+this.halfZ)*INV_DX);
    if (ix<0 || ix>=this.nx || iz<0 || iz>=this.nz) return -1;
    return iz*this.nx+ix;
  }

  addFluidAt(wx,wz,radius,waterVol,bossVol,impX=0,impZ=0) {
    const lx=wx-this.originX;
    const minX=clamp(Math.floor((lx-radius+this.halfX)*INV_DX),0,this.nx-1);
    const maxX=clamp(Math.floor((lx+radius+this.halfX)*INV_DX),0,this.nx-1);
    const minZ=clamp(Math.floor((wz-radius+this.halfZ)*INV_DX),0,this.nz-1);
    const maxZ=clamp(Math.floor((wz+radius+this.halfZ)*INV_DX),0,this.nz-1);
    const r2=Math.max(radius*radius,DX*DX*.5), invR2=1/(r2*1.05);
    let weightSum=0;
    for (let iz=minZ;iz<=maxZ;iz++) {
      const cz=-this.halfZ+(iz+.5)*DX-wz, cz2=cz*cz;
      for (let ix=minX;ix<=maxX;ix++) {
        const cx=-this.halfX+(ix+.5)*DX-lx;
        const d2=cx*cx+cz2;
        if (d2<=r2) weightSum+=1-d2*invR2;
      }
    }
    if (weightSum<=0) return;
    const invWeightSum=1/weightSum;
    const cellArea=DX*DX, invCellArea=1/cellArea;
    const wScale=waterVol*invCellArea*invWeightSum, bScale=bossVol*invCellArea*invWeightSum;
    const ixScale=impX*invWeightSum, izScale=impZ*invWeightSum;
    const hasImp=impX!==0 || impZ!==0;
    const hWater=this.hWater, hBoss=this.hBoss, fx=this.fx, fz=this.fz, nx=this.nx;
    for (let iz=minZ;iz<=maxZ;iz++) {
      const cz=-this.halfZ+(iz+.5)*DX-wz, cz2=cz*cz, row=iz*nx;
      let touched=false;
      for (let ix=minX;ix<=maxX;ix++) {
        const cx=-this.halfX+(ix+.5)*DX-lx;
        const d2=cx*cx+cz2;
        if (d2>r2) continue;
        const w=1-d2*invR2;
        const idx=row+ix;
        if (waterVol>0) {
          const nv=hWater[idx]+wScale*w;
          hWater[idx]=nv>4.5?4.5:nv;
        }
        if (bossVol>0) {
          const nv=hBoss[idx]+bScale*w;
          hBoss[idx]=nv>4.5?4.5:nv;
        }
        if (hasImp) {
          fx[idx]+=ixScale*w;
          fz[idx]+=izScale*w;
        }
        touched=true;
      }
      if (touched) {this.rowActive[iz]=1;this.hasActivity=true;}
    }
  }

  sampleAt(wx,wz) {
    const idx=this.indexAtWorld(wx,wz);
    if (idx<0) return {water:0,boss:0,depth:0,ux:0,uz:0,bed:0,shelter:this.zoneIndex===0?1:0};
    const hw=this.hWater[idx], hb=this.hBoss[idx];
    return {
      water:hw,boss:hb,depth:hw+hb,
      ux:this.ux[idx],uz:this.uz[idx],
      bed:this.bed[idx],shelter:this.shelter[idx]
    };
  }

  // One conservative finite-volume Rusanov shallow-water step over active wet rows
  // with zero-copy ping-pong buffers and LUT Manning bed drag.
  step(dt) {
    if (dt<=0) return;
    if (!this.hasActivity) {
      this.totalWaterVolume=0;
      this.totalBossVolume=0;
      this.maxDepth=0;
      this.maxSpeed=0;
      this.meanBossDepth=0;
      this.meanWaterDepth=0;
      return;
    }
    const nx=this.nx, nz=this.nz;
    const hWater=this.hWater, hBoss=this.hBoss, ux=this.ux, uz=this.uz;
    const nhWater=this.nhWater, nhBoss=this.nhBoss, nux=this.nux, nuz=this.nuz;
    const bed=this.bed, fx=this.fx, fz=this.fz;
    const rowActive=this.rowActive, nextRowActive=this.nextRowActive, backRowDirty=this.backRowDirty;
    const cellArea=DX*DX;
    const alpha=dt*INV_DX>0.06?0.06:dt*INV_DX;
    const halfInvDx=0.5*INV_DX;
    const dtG=dt*GRAVITY, dtVisc=dt*0.14;
    const waterManning=FLUID_MEDIA.water.manning;
    const diffManning=FLUID_MEDIA.boss.manning-waterManning;
    const dtEvap=dt*(this.zoneIndex===0?0.00045:0.00018);
    const dtEvapBoss=dtEvap*0.45;
    const dtYield=0.55*dt;
    let sumW=0, sumB=0, maxD=0, maxU2=0, nextAny=false;

    for (let iz=0;iz<nz;iz++) {
      const row=iz*nx;
      const run=rowActive[iz] || (iz>0 && rowActive[iz-1]) || (iz<nz-1 && rowActive[iz+1]);
      if (!run) {
        if (backRowDirty[iz]) {
          const end=row+nx;
          nhWater.fill(0,row,end);
          nhBoss.fill(0,row,end);
          nux.fill(0,row,end);
          nuz.fill(0,row,end);
        }
        nextRowActive[iz]=0;
        continue;
      }
      const iS=iz>0?row-nx:row;
      const iN=iz<nz-1?row+nx:row;
      let rowWet=0;
      let hw=hWater[row], hb=hBoss[row], h=hw+hb, bedC=bed[row], uxC=ux[row], uzC=uz[row];
      let hwW=hw, hbW=hb, hW=h, bedW=bedC, uxW=uxC, uzW=uzC;
      for (let ix=0;ix<nx;ix++) {
        const i=row+ix;
        const iE=ix<nx-1?i+1:i;
        const hwE=hWater[iE], hbE=hBoss[iE], hE=hwE+hbE;
        const bedE=bed[iE], uxE=ux[iE], uzE=uz[iE];
        const iSi=iS+ix, iNi=iN+ix;
        const hwS=hWater[iSi], hbS=hBoss[iSi], hS=hwS+hbS;
        const hwN=hWater[iNi], hbN=hBoss[iNi], hN=hwN+hbN;
        const fxi=fx[i], fzi=fz[i];

        if (h<H_MIN && hW<H_MIN && hE<H_MIN && hS<H_MIN && hN<H_MIN && (fxi<0?-fxi:fxi)+(fzi<0?-fzi:fzi)<1e-4) {
          nhWater[i]=0; nhBoss[i]=0; nux[i]=0; nuz[i]=0;
          hwW=hw; hbW=hb; hW=h; bedW=bedC; uxW=uxC; uzW=uzC;
          hw=hwE; hb=hbE; h=hE; bedC=bedE; uxC=uxE; uzC=uzE;
          continue;
        }

        const eta=bedC+h, etaW=bedW+hW, etaE=bedE+hE, etaS=bed[iSi]+hS, etaN=bed[iNi]+hN;
        const gradX=(etaE-etaW)*halfInvDx;
        const gradZ=(etaN-etaS)*halfInvDx;

        const noBoss=(hb+hbW+hbE+hbS+hbN)===0;
        const bossShare=noBoss?0:(h>H_MIN?hb/h:0);
        const manning=noBoss?waterManning:waterManning+diffManning*bossShare;
        const uxi=uxC, uzi=uzC;

        const uxS=ux[iSi], uxN=ux[iNi];
        const uzS=uz[iSi], uzN=uz[iNi];
        const lapUx=uxW+uxE+uxS+uxN-4*uxi;
        const lapUz=uzW+uzE+uzS+uzN-4*uzi;

        let vx=uxi-dtG*gradX+dtVisc*lapUx+fxi;
        let vz=uzi-dtG*gradZ+dtVisc*lapUz+fzi;

        const u2=uxi*uxi+uzi*uzi;
        const drag=u2>0?GRAVITY*manning*manning*Math.sqrt(u2)*invPow43(h>0.015?h:0.015):0;
        const damp=1/(1+dt*drag+bossShare*dtYield);
        vx*=damp; vz*=damp;
        if (vx<-24) vx=-24; else if (vx>24) vx=24;
        if (vz<-24) vz=-24; else if (vz>24) vz=24;
        if (h<0.002) {vx*=0.65; vz*=0.65;}
        if (vx>-1e-4 && vx<1e-4) vx=0;
        if (vz>-1e-4 && vz<1e-4) vz=0;

        const uW=(uxW+vx)*.5, uE=(vx+uxE)*.5;
        const vS=(uzS+vz)*.5, vN=(vz+uzN)*.5;

        const waveDiff=noBoss?0.14:0.14*(1-0.45*bossShare);
        const fluxW=(uW>=0?hW:h)*uW-waveDiff*(eta-etaW);
        const fluxE=(uE>=0?h:hE)*uE-waveDiff*(etaE-eta);
        const fluxS=(vS>=0?hS:h)*vS-waveDiff*(eta-etaS);
        const fluxN=(vN>=0?h:hN)*vN-waveDiff*(etaN-eta);

        const divTot=alpha*((fluxE-fluxW)+(fluxN-fluxS));
        let nextW, nextB;
        if (noBoss) {
          nextW=hw-divTot-dtEvap;
          if (nextW<0) nextW=0;
          nextB=0;
        } else {
          const shareW=uW>=0?(hW>H_MIN?hbW/hW:0):bossShare;
          const shareE=uE>=0?bossShare:(hE>H_MIN?hbE/hE:0);
          const shareS=vS>=0?(hS>H_MIN?hbS/hS:0):bossShare;
          const shareN=vN>=0?bossShare:(hN>H_MIN?hbN/hN:0);
          const divBoss=alpha*((fluxE*shareE-fluxW*shareW)+(fluxN*shareN-fluxS*shareS));
          nextW=hw-(divTot-divBoss)-dtEvap;
          if (nextW<0) nextW=0;
          nextB=hb-divBoss-dtEvapBoss;
          if (nextB<0) nextB=0;
        }
        let nextTot=nextW+nextB;
        if (nextTot>4.8) {
          const s=4.8/nextTot;
          nextW*=s; nextB*=s; nextTot=4.8;
        }
        nhWater[i]=nextW;
        nhBoss[i]=nextB;
        nux[i]=vx;
        nuz[i]=vz;
        fx[i]=0;
        fz[i]=0;

        if (nextTot>H_MIN) rowWet=1;
        sumW+=nextW;
        sumB+=nextB;
        if (nextTot>maxD) maxD=nextTot;
        const spd2=vx*vx+vz*vz;
        if (spd2>maxU2) maxU2=spd2;

        hwW=hw; hbW=hb; hW=h; bedW=bedC; uxW=uxC; uzW=uzC;
        hw=hwE; hb=hbE; h=hE; bedC=bedE; uxC=uxE; uzC=uzE;
      }
      nextRowActive[iz]=rowWet;
      if (rowWet) nextAny=true;
    }

    // Zero-copy ping-pong reference swap (eliminates 4x Float32Array.set copies).
    this.hWater=nhWater; this.nhWater=hWater;
    this.hBoss=nhBoss; this.nhBoss=hBoss;
    this.ux=nux; this.nux=ux;
    this.uz=nuz; this.nuz=uz;
    this.backRowDirty=rowActive;
    this.rowActive=nextRowActive;
    this.nextRowActive=backRowDirty;
    this.hasActivity=nextAny;
    this.totalWaterVolume=sumW*cellArea;
    this.totalBossVolume=sumB*cellArea;
    this.maxDepth=maxD;
    this.maxSpeed=maxU2>0?Math.sqrt(maxU2):0;
    this.meanWaterDepth=sumW/this.count;
    this.meanBossDepth=sumB/this.count;
  }
}

export class FluidEngine {
  constructor(world,paint) {
    this.world=world;
    this.paint=paint;
    this.surface=new ShallowGrid(0,SURF_HALF_X,SURF_HALF_Z,0,world);
    this.underground=new ShallowGrid(UNDER_X,UNDER_HALF_X,UNDER_HALF_Z,1,world);
    // Precompute exact storm-drain surface/underground indices and B1 radial injection kernels.
    this._drains=[];
    const cellArea=DX*DX;
    for (let i=0;i<STORM_DRAINS.length;i++) {
      const drain=STORM_DRAINS[i];
      const sIdx=this.surface.indexAtWorld(drain.sx,drain.sz);
      const uIdx=this.underground.indexAtWorld(drain.ux,drain.uz);
      if (sIdx<0 || uIdx<0) continue;
      const g=this.underground, radius=drain.radius+1.2;
      const lx=drain.ux-g.originX;
      const minX=clamp(Math.floor((lx-radius+g.halfX)*INV_DX),0,g.nx-1);
      const maxX=clamp(Math.floor((lx+radius+g.halfX)*INV_DX),0,g.nx-1);
      const minZ=clamp(Math.floor((drain.uz-radius+g.halfZ)*INV_DX),0,g.nz-1);
      const maxZ=clamp(Math.floor((drain.uz+radius+g.halfZ)*INV_DX),0,g.nz-1);
      const r2=Math.max(radius*radius,DX*DX*.5), invR2=1/(r2*1.05);
      const cells=[], weights=[], rows=new Set();
      let wSum=0;
      for (let iz=minZ;iz<=maxZ;iz++) {
        const cz=-g.halfZ+(iz+.5)*DX-drain.uz;
        for (let ix=minX;ix<=maxX;ix++) {
          const cx=-g.halfX+(ix+.5)*DX-lx;
          const d2=cx*cx+cz*cz;
          if (d2<=r2) {
            const w=1-d2*invR2;
            cells.push(iz*g.nx+ix);
            weights.push(w);
            rows.add(iz);
            wSum+=w;
          }
        }
      }
      const invSum=wSum>0?1/wSum:0;
      this._drains.push({
        sIdx, uIdx, cdArea:drain.cd*drain.area,
        chuteDir:drain.kind==='stair'?(drain.sx<0?1:-1)*2.4:0,
        cells:Int32Array.from(cells),
        normW:Float32Array.from(weights,w=>w*invSum),
        areaW:Float32Array.from(weights,w=>(w*invSum)/cellArea),
        rows:Int32Array.from(rows)
      });
    }
    this.clock=0;
    this.bossRainRate=0;
    this.weatherRainRate=0;
    this.rainTerminalWater=rainTerminalVelocity(0.0024,FLUID_MEDIA.water);
    this.rainTerminalBoss=rainTerminalVelocity(0.0042,FLUID_MEDIA.boss);
    this.lastPercolationRate=0;
    this.cumulativePercolatedBoss=0;
    this.cumulativePercolatedWater=0;
    this.underBossDepth=0;
    this.underWaterDepth=0;
    this.meanWeberNumber=0;
    this.lastTsunamiPeakForce=0;
    this._paintAccum=0;
    this._rainCursor=0.17;
    this._bossAccum=0;
  }

  reset() {
    this.surface.reset();
    this.underground.reset();
    this.clock=0;
    this.bossRainRate=0;
    this.weatherRainRate=0;
    this.lastPercolationRate=0;
    this.cumulativePercolatedBoss=0;
    this.cumulativePercolatedWater=0;
    this.underBossDepth=0;
    this.underWaterDepth=0;
    this.meanWeberNumber=0;
    this.lastTsunamiPeakForce=0;
    this._paintAccum=0;
    this._bossAccum=0;
  }

  // Sample shallow-water depth + velocity at any world coordinate across Surface (Zone 0) or B1 (Zone 1).
  sampleAt(wx,wz) {
    const z=zoneOf(wx);
    if (z===0) return this.surface.sampleAt(wx,wz);
    if (z===1) return this.underground.sampleAt(wx,wz);
    return {water:0,boss:0,depth:0,ux:0,uz:0,bed:0,shelter:0};
  }

  // Step 1: Weather rain fluid physics (terminal fall, surface runoff sheet, ink dilution & wash).
  stepRain(hazards,paint,dt) {
    if (!hazards?.rain?.active) {
      this.weatherRainRate=0;
      return 0;
    }
    const g=this.surface;
    const rate=0.0115; // m/s scaled real-time rainfall intensity for dynamic puddles
    this.weatherRainRate=rate;
    const cellArea=DX*DX;
    // Stratified rainfall addition onto precomputed open-sky surface cells + aerodynamic wind shear.
    const rateDt=rate*dt, fxDt=1.35*0.18*dt, fzDt=0.45*0.18*dt;
    const idxs=g.openSkyIdx, exps=g.openSkyExp, hWater=g.hWater, fx=g.fx, fz=g.fz;
    for (let k=0,n=idxs.length;k<n;k++) {
      const i=idxs[k], exp=exps[k];
      const nv=hWater[i]+rateDt*exp;
      hWater[i]=nv>3.5?3.5:nv;
      fx[i]+=fxDt*exp;
      fz[i]+=fzDt*exp;
    }
    g.markAllOpenSkyActive();
    // Dynamic rain wash driven by sheet depth + terminal impact kinetic stress (leaves Zone 1 dry).
    if (paint) {
      const kineticScale=clamp(0.45+g.meanWaterDepth*4.5+g.maxSpeed*0.03,0.45,1.85);
      const washAmt=Math.min(.14,dt*.026*kineticScale);
      paint.wash(3,washAmt,-SURF_HALF_X,SURF_HALF_X,-SURF_HALF_Z,SURF_HALF_Z);
    }
    return this.rainTerminalWater*rate*cellArea;
  }

  // Step 2: Boss black-ink rain from the crimson-black sky while boss is alive,
  // painting surface ground/objects AND filling the shallow-water domain to drain underground.
  stepBossInkRain(battle,dt) {
    const boss=battle?.boss;
    const paint=battle?.paint;
    if (!boss?.active || battle?.timeless) {
      this.bossRainRate=0;
      return;
    }
    const g=this.surface;
    const phaseBoost=1+0.22*Math.max(0,(boss.phase??1)-1);
    const bossRainDepthRate=0.0165*phaseBoost;
    this.bossRainRate=bossRainDepthRate;

    const addDt=bossRainDepthRate*dt;
    const idxs=g.openSkyIdx, exps=g.openSkyExp, hBoss=g.hBoss;
    for (let k=0,n=idxs.length;k<n;k++) {
      const i=idxs[k];
      const nv=hBoss[i]+addDt*exps[k];
      hBoss[i]=nv>4.2?4.2:nv;
    }
    g.markAllOpenSkyActive();

    this._bossAccum+=dt*phaseBoost;
    if (paint && this._bossAccum>=0.045) {
      const drops=Math.min(18,Math.max(4,Math.floor(this._bossAccum/0.022)));
      this._bossAccum=0;
      const bw=BOUNDS[0]-1.5, bd=BOUNDS[1]-1.5;
      const stage=battle.stage, world=battle.world;
      const strikeInkRain=stage?.destruction?.strikeInkRain;
      for (let k=0;k<drops;k++) {
        this._rainCursor=(this._rainCursor+0.61803398875)%1;
        const u1=this._rainCursor;
        const u2=((this._rainCursor*7.131+k*0.381966)%1);
        const rx=(u1*2-1)*bw;
        const rz=(u2*2-1)*bd;
        const idx=g.indexAtWorld(rx,rz);
        if (idx>=0 && g.shelter[idx]<0.12) continue;
        paint.stamp(rx,rz,1.25+0.45*phaseBoost,2,0,this.clock*2+k,.042*phaseBoost);
        const arx=rx<0?-rx:rx, arz=rz<0?-rz:rz;
        if (arx>12 && arx<48 && arz<18 && k%3===0) {
          paint.stamp(rx,rz,1.05,2,1,this.clock+k,.034);
        }
        if (strikeInkRain) stage.destruction.strikeInkRain(rx,rz,6.5*phaseBoost,2);
        else stage?.strikeAt?.(rx,world?.floorY?world.floorY(rx,rz):world?.floor(rx,rz)?.y??0,rz,6.5*phaseBoost,2,0.55,{inkRain:true});
      }
    }
  }

  // Step 3: Percolation & stairwell gravity flow transferring Surface boss ink + floodwater into B1.
  stepPercolation(battle,dt) {
    const paint=battle?.paint;
    const surf=this.surface;
    const under=this.underground;
    const cellArea=DX*DX, invCellArea=1/cellArea;
    let totalBossFlux=0, totalWaterFlux=0;
    const sWater=surf.hWater, sBoss=surf.hBoss;
    const uWater=under.hWater, uBoss=under.hBoss, uFx=under.fx;
    const drains=this._drains;

    for (let d=0;d<drains.length;d++) {
      const dr=drains[d];
      const sIdx=dr.sIdx;
      const sb=sBoss[sIdx], sw=sWater[sIdx], headH=sb+sw;
      if (headH<=0.002) continue;

      const qMax=dr.cdArea*Math.sqrt(2*GRAVITY*(headH>0.01?headH:0.01));
      const availableVol=headH*cellArea;
      const volOut=Math.min(availableVol*0.65,qMax*dt);
      if (volOut<=1e-6) continue;

      const bossFrac=sb/headH;
      const dBossVol=volOut*bossFrac;
      const dWaterVol=volOut-dBossVol;

      const dhOut=volOut*invCellArea;
      sBoss[sIdx]=Math.max(0,sb-dhOut*bossFrac);
      sWater[sIdx]=Math.max(0,sw-dhOut*(1-bossFrac));

      const cells=dr.cells, areaW=dr.areaW, normW=dr.normW;
      const impX=dr.chuteDir*dt*4;
      for (let k=0,n=cells.length;k<n;k++) {
        const ci=cells[k], aw=areaW[k];
        if (dWaterVol>0) {const nv=uWater[ci]+dWaterVol*aw; uWater[ci]=nv>4.5?4.5:nv;}
        if (dBossVol>0) {const nv=uBoss[ci]+dBossVol*aw; uBoss[ci]=nv>4.5?4.5:nv;}
        if (impX) uFx[ci]+=impX*normW[k];
      }
      const rows=dr.rows;
      for (let r=0;r<rows.length;r++) under.rowActive[rows[r]]=1;
      under.hasActivity=true;
      totalBossFlux+=dBossVol;
      totalWaterFlux+=dWaterVol;
    }

    this.lastPercolationRate=(totalBossFlux+totalWaterFlux)/Math.max(dt,1e-4);
    this.cumulativePercolatedBoss+=totalBossFlux;
    this.cumulativePercolatedWater+=totalWaterFlux;

    const targetBossDepth=clamp(under.totalBossVolume/(UNDER_BOUNDS[0]*UNDER_BOUNDS[1]*0.42),0,2.25);
    if (battle?.boss?.active) {
      this.underBossDepth=this.underBossDepth+(targetBossDepth-this.underBossDepth)*Math.min(1,dt*2.4);
    } else {
      this.underBossDepth=Math.max(0,this.underBossDepth-dt*0.032);
    }
    this.underWaterDepth=clamp(under.totalWaterVolume/(UNDER_BOUNDS[0]*UNDER_BOUNDS[1]*0.45),0,2.7);

    // Paint B1 cells along active wet rows only.
    if (paint && under.totalBossVolume>0.02) {
      this._paintAccum+=dt;
      if (this._paintAccum>=0.08) {
        this._paintAccum=0;
        const nx=under.nx, nz=under.nz, ra=under.rowActive;
        const phaseTick=Math.floor(this.clock*12);
        let stamped=0;
        for (let iz=1;iz<nz-1 && stamped<28;iz++) {
          if (!ra[iz]) continue;
          const z=-under.halfZ+(iz+.5)*DX, row=iz*nx;
          for (let ix=1;ix<nx-1;ix++) {
            const depth=uBoss[row+ix];
            if (depth>0.0038) {
              if (((ix+iz+phaseTick)&1)===0 || depth>0.025) {
                const wx=UNDER_X-under.halfX+(ix+.5)*DX;
                paint.stamp(wx,z,1.45,2,2,this.clock*2.5,Math.min(.08,0.032+depth*1.8));
                stamped++;
                if (stamped>=28) break;
              }
            }
          }
        }
      }
    }
  }

  // Step 4: Unified Projectile / Shot Fluid Physics (aerodynamic drag, Weber droplet breakup, impact impulse).
  projectileDragGamma(weapon) {
    const r=weapon?.radius??1.0;
    const pellets=weapon?.pellets??1;
    const densityScale=pellets>1?2.2:weapon?.id==='lob'?0.035:clamp(1.1/Math.max(0.4,r),0.04,0.14);
    const rainMul=this.weatherRainRate>0?1.35:this.bossRainRate>0?1.2:1.0;
    return clamp(0.032*densityScale*rainMul,0.001,0.38);
  }

  stepProjectileFluid(shot,gravity,dt,rng=Math.random) {
    const vel=shot.vel, vx=vel[0], vy=vel[1], vz=vel[2];
    const speed2=vx*vx+vy*vy+vz*vz, speed=Math.sqrt(speed2);
    const rM=clamp((shot.weapon?.radius??1.0)*0.09,0.035,0.22);
    const media=shot.team===-1||shot.team===2?FLUID_MEDIA.boss:FLUID_MEDIA.ink;
    const Re=Math.max(1,(AIR_DENSITY*speed*(2*rM))/1.8e-5);
    const weber=(media.density*speed2*(2*rM))/media.surfaceTension;
    this.meanWeberNumber=this.meanWeberNumber*0.92+weber*0.08;

    const gamma=shot.dragGamma??(shot.dragGamma=this.projectileDragGamma(shot.weapon));
    const decay=Math.exp(-gamma*dt);
    const kPos=gamma>1e-5?(1-decay)/gamma:dt;
    const termY=gamma>1e-5?gravity/gamma:0;

    const nvx=vx*decay;
    const nvz=vz*decay;
    const nvy=gamma>1e-5?(vy+termY)*decay-termY:vy-gravity*dt;

    const pos=shot.pos;
    const nx=pos[0]+vx*kPos;
    const nz=pos[2]+vz*kPos;
    const ny=gamma>1e-5
      ?pos[1]+(vy+termY)*kPos-termY*dt
      :pos[1]+vy*dt-0.5*gravity*dt*dt;

    pos[0]=nx; pos[1]=ny; pos[2]=nz;
    vel[0]=nvx; vel[1]=nvy; vel[2]=nvz;

    let breakupDrop=null;
    if (weber>38000 && !shot.noBreakup && rng()<dt*8.0) {
      breakupDrop={
        breakup:true,
        weber,
        x:nx,y:ny,z:nz,
        vx:nvx*0.30+(rng()-.5)*2.2,
        vy:nvy*0.20-0.6,
        vz:nvz*0.30+(rng()-.5)*2.2
      };
    }
    _projFluidOut.breakup=!!breakupDrop;
    _projFluidOut.drop=breakupDrop;
    _projFluidOut.weber=weber;
    _projFluidOut.reynolds=Re;
    _projFluidOut.gamma=gamma;
    return _projFluidOut;
  }

  // Inject splash momentum from ink projectile impact into the ShallowGrid.
  splatFluidImpulse(wx,wz,vx,vz,volume,team) {
    const z=zoneOf(wx);
    const grid=z===0?this.surface:z===1?this.underground:null;
    if (!grid) return;
    const bossVol=team===2||team===-1?volume*0.025:0;
    const waterVol=team===2||team===-1?0:volume*0.008;
    grid.addFluidAt(wx,wz,2.4,waterVol,bossVol,clamp(vx*0.06,-6,6),clamp(vz*0.06,-6,6));
  }

  // Step 5: Unified Tsunami & Underground Flood shallow-water bore physics.
  tsunamiProfile(tsunami,wx) {
    if (!tsunami?.active && tsunami?.phase!=='wave') return {depth:0,ux:0,celerity:0,pressure:0};
    const width=tsunami.width||9.5;
    const height=tsunami.height||3.6;
    const dx=wx-tsunami.x;
    const half=width*0.58;
    if (Math.abs(dx)>half) return {depth:0,ux:0,celerity:0,pressure:0};
    const u=dx/half;
    const shape=u>0?Math.pow(Math.max(0,1-u),0.65):Math.pow(Math.max(0,1+u),1.35);
    const depth=height*shape;
    const celerity=Math.sqrt(GRAVITY*(height+0.6));
    const speed=Math.max(tsunami.speed||12.5,celerity)*(depth/(height+0.4));
    const ux=(tsunami.dir||1)*speed;
    const pressure=0.5*FLUID_MEDIA.water.density*ux*ux;
    return {depth,ux,celerity,pressure};
  }

  stepTsunamiFluid(hazards,battle,dt) {
    const t=hazards?.tsunami;
    const u=hazards?.underFlood;
    const paint=battle?.paint;
    const g=this.surface;
    let peakForce=0;
    const isWave=t && (t.active || t.phase==='wave');

    if (isWave) {
      const wSpan=t.width||9.5;
      const half=wSpan*0.58;
      const lx0=t.x-half, lx1=t.x+half;
      const minIx=clamp(Math.floor((lx0+g.halfX)*INV_DX),0,g.nx-1);
      const maxIx=clamp(Math.floor((lx1+g.halfX)*INV_DX),0,g.nx-1);
      let anyTouched=false;
      for (let ix=minIx;ix<=maxIx;ix++) {
        const wx=-g.halfX+(ix+.5)*DX;
        const prof=this.tsunamiProfile(t,wx);
        if (prof.depth<=0.02) continue;
        for (let iz=0;iz<g.nz;iz++) {
          const i=iz*g.nx+ix;
          if (g.bed[i]<prof.depth-0.1) {
            const subH=Math.max(0,prof.depth-g.bed[i]);
            g.hWater[i]=Math.max(g.hWater[i],Math.min(4.2,subH*0.55));
            g.fx[i]+=(prof.ux-g.ux[i])*Math.min(1,dt*8)*0.6;
            g.rowActive[iz]=1;
            anyTouched=true;
          }
        }
        if (prof.pressure>peakForce) peakForce=prof.pressure;
      }
      if (anyTouched) g.hasActivity=true;

      if (paint) {
        const sweep=(t.speed||12.5)*dt;
        paint.wash(3,1,t.x-sweep-wSpan*.55,t.x+wSpan*.5,-Infinity,Infinity);
      }

      if (battle?.actors) {
        for (const a of battle.actors) {
          if (a.down>0 || zoneOf(a.x)!==0) continue;
          const prof=this.tsunamiProfile(t,a.x);
          if (prof.depth>0.25 && a.y<prof.depth-0.35) {
            const subFraction=clamp((prof.depth-Math.max(0,a.y))/1.6,0,1);
            const relVx=prof.ux-a.vx;
            const accel=8.2*subFraction;
            a.vx+=relVx*Math.min(1,accel*dt);
            a.vy=Math.max(a.vy,subFraction*2.6);
            a.grounded=false;
          }
        }
      }
      if (battle?.vehicles?.cars) {
        for (const car of battle.vehicles.cars) {
          if (zoneOf(car.x)!==0) continue;
          const prof=this.tsunamiProfile(t,car.x);
          if (prof.depth>0.65 && car.y<prof.depth-0.4) {
            const impulse=prof.ux*dt*2.4;
            car.x+=impulse;
            car.vx=(car.vx??0)+prof.ux*dt*1.5;
          }
        }
      }
      if (battle?.stage?.strikeTsunami) {
        battle.stage.strikeTsunami(t.x,wSpan,t.height||3.6,t.dir||1,peakForce,dt);
      }
    }

    if (u?.active && battle?.timeless!==true) {
      const ug=this.underground;
      const target=u.depth||0;
      const fillH=target*0.72;
      const uWater=ug.hWater;
      for (let i=0;i<ug.count;i++) {
        if (fillH>uWater[i]) uWater[i]=fillH;
      }
      if (fillH>H_MIN) ug.markAllActive();
      if (paint && target>0.4) {
        paint.wash(4,Math.min(1,dt*(0.28+0.15*target)));
      }
    }
    this.lastTsunamiPeakForce=peakForce;
    return peakForce;
  }

  // Step boss black rain + underground percolation + shallow-water solver (used from battle.update alongside hazards.update).
  stepBossAndGrid(battle,dt) {
    if (!battle || dt<=0) return;
    this.clock+=dt;
    this.stepBossInkRain(battle,dt);
    this.stepPercolation(battle,dt);
    const steps=dt>0.035?2:1;
    const hdt=dt/steps;
    for (let s=0;s<steps;s++) {
      this.surface.step(hdt);
      this.underground.step(hdt);
    }
  }

  // Standalone full unified fluid step (advances all 4 fluid systems + grids).
  step(battle,dt) {
    if (!battle || dt<=0) return;
    this.stepRain(battle.hazards,battle.paint,dt);
    this.stepTsunamiFluid(battle.hazards,battle,dt);
    this.stepBossAndGrid(battle,dt);
  }

  getMetrics() {
    return {
      surfaceWaterVolume:this.surface.totalWaterVolume,
      surfaceBossVolume:this.surface.totalBossVolume,
      underWaterVolume:this.underground.totalWaterVolume,
      underBossVolume:this.underground.totalBossVolume,
      underBossDepth:this.underBossDepth,
      underWaterDepth:this.underWaterDepth,
      percolationRate:this.lastPercolationRate,
      cumulativePercolatedBoss:this.cumulativePercolatedBoss,
      meanWeberNumber:this.meanWeberNumber,
      tsunamiPeakPressure:this.lastTsunamiPeakForce
    };
  }
}
