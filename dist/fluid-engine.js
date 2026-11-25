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
    for (let iz=0;iz<this.nz;iz++) {
      const wz=-this.halfZ+(iz+.5)*DX;
      for (let ix=0;ix<this.nx;ix++) {
        const lx=-this.halfX+(ix+.5)*DX;
        const wx=this.originX+lx;
        const idx=iz*this.nx+ix;
        let bed=0;
        let openSky=this.zoneIndex===0?1:0;
        if (world?.floor) {
          const fl=world.floor(wx,wz,baseFloor+3);
          if (fl && Number.isFinite(fl.y)) bed=fl.y-baseFloor;
        }
        // Subtle street crown (center road slightly lower toward curb/drains) so sheet runoff feeds drains.
        if (this.zoneIndex===0) {
          const roadSlope=Math.abs(wz)<11?.04*(1-Math.abs(wz)/11):0;
          bed-=roadSlope;
          const st=stairAt(wx,wz,1.2);
          if (st) {
            bed=Math.min(bed,-0.32-st.t*0.14);
            openSky=.75;
          }
          if (world?.ceiling) {
            const ceil=world.ceiling(wx,wz,baseFloor+2.5);
            if (ceil && Number.isFinite(ceil.y)) openSky=0.05;
          }
          if (world?.homes) {
            for (const h of world.homes) {
              if (wx>=h.x0 && wx<=h.x1 && wz>=h.z0 && wz<=h.z1) {openSky=0; break;}
            }
          }
        } else {
          // B1 central exchange trench sits slightly below concourse slabs, collecting percolating black ink.
          if (Math.abs(wz)<7.5 && Math.abs(lx)<48) bed-=0.08;
        }
        this.bed[idx]=clamp(bed,-3.2,8.5);
        this.shelter[idx]=openSky;
      }
    }
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
    const r2=Math.max(radius*radius,DX*DX*.5);
    let weightSum=0;
    for (let iz=minZ;iz<=maxZ;iz++) {
      const cz=-this.halfZ+(iz+.5)*DX-wz;
      for (let ix=minX;ix<=maxX;ix++) {
        const cx=-this.halfX+(ix+.5)*DX-lx;
        const d2=cx*cx+cz*cz;
        if (d2<=r2) weightSum+=1-d2/(r2*1.05);
      }
    }
    if (weightSum<=0) return;
    const cellArea=DX*DX;
    for (let iz=minZ;iz<=maxZ;iz++) {
      const cz=-this.halfZ+(iz+.5)*DX-wz;
      for (let ix=minX;ix<=maxX;ix++) {
        const cx=-this.halfX+(ix+.5)*DX-lx;
        const d2=cx*cx+cz*cz;
        if (d2>r2) continue;
        const w=(1-d2/(r2*1.05))/weightSum;
        const idx=iz*this.nx+ix;
        if (waterVol>0) this.hWater[idx]=Math.min(4.5,this.hWater[idx]+(waterVol*w)/cellArea);
        if (bossVol>0) this.hBoss[idx]=Math.min(4.5,this.hBoss[idx]+(bossVol*w)/cellArea);
        if (impX || impZ) {
          this.fx[idx]+=impX*w;
          this.fz[idx]+=impZ*w;
        }
      }
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

  // One conservative finite-volume Rusanov shallow-water step over active wet cells.
  step(dt) {
    if (dt<=0) return;
    const {nx,nz,hWater,hBoss,ux,uz,nhWater,nhBoss,nux,nuz,bed,fx,fz}=this;
    const cellArea=DX*DX;
    // Skip work cleanly when domain is essentially dry.
    let anyActive=false;
    for (let i=0;i<this.count;i++) {
      if (hWater[i]+hBoss[i]>1e-4 || Math.abs(fx[i])>1e-4 || Math.abs(fz[i])>1e-4) {
        anyActive=true;
        break;
      }
    }
    if (!anyActive) {
      this.totalWaterVolume=0;
      this.totalBossVolume=0;
      this.maxDepth=0;
      this.maxSpeed=0;
      this.meanBossDepth=0;
      this.meanWaterDepth=0;
      return;
    }

    const alpha=clamp(dt*INV_DX,0,0.06);
    let sumW=0, sumB=0, maxD=0, maxU=0;
    const nuVisc=0.14;

    for (let iz=0;iz<nz;iz++) {
      const iS=iz>0?(iz-1)*nx:iz*nx;
      const iN=iz<nz-1?(iz+1)*nx:iz*nx;
      const row=iz*nx;
      for (let ix=0;ix<nx;ix++) {
        const i=row+ix;
        const hw=hWater[i], hb=hBoss[i], h=hw+hb;
        const iW=ix>0?i-1:i;
        const iE=ix<nx-1?i+1:i;
        const hwW=hWater[iW], hbW=hBoss[iW], hW=hwW+hbW;
        const hwE=hWater[iE], hbE=hBoss[iE], hE=hwE+hbE;
        const hwS=hWater[iS+ix], hbS=hBoss[iS+ix], hS=hwS+hbS;
        const hwN=hWater[iN+ix], hbN=hBoss[iN+ix], hN=hwN+hbN;

        if (h<H_MIN && hW<H_MIN && hE<H_MIN && hS<H_MIN && hN<H_MIN && Math.abs(fx[i])+Math.abs(fz[i])<1e-4) {
          nhWater[i]=0; nhBoss[i]=0; nux[i]=0; nuz[i]=0;
          continue;
        }

        const eta=bed[i]+h, etaW=bed[iW]+hW, etaE=bed[iE]+hE, etaS=bed[iS+ix]+hS, etaN=bed[iN+ix]+hN;

        // Head gradients drive velocity (hydrostatic + bed slope = -g * grad(eta)).
        const gradX=(etaE-etaW)*0.5*INV_DX;
        const gradZ=(etaN-etaS)*0.5*INV_DX;

        // Effective viscosity / Bingham yield resistance scales when boss thick ink dominates water.
        const bossShare=h>H_MIN?hb/h:0;
        const manning=FLUID_MEDIA.water.manning*(1-bossShare)+FLUID_MEDIA.boss.manning*bossShare;
        const speed=Math.hypot(ux[i],uz[i]);

        // Laplacian smoothing approximates turbulent + molecular eddy viscosity.
        const lapUx=(ux[iW]+ux[iE]+ux[iS+ix]+ux[iN+ix]-4*ux[i]);
        const lapUz=(uz[iW]+uz[iE]+uz[iS+ix]+uz[iN+ix]-4*uz[i]);

        let vx=ux[i]-dt*GRAVITY*gradX+dt*nuVisc*lapUx+fx[i];
        let vz=uz[i]-dt*GRAVITY*gradZ+dt*nuVisc*lapUz+fz[i];

        // Nonlinear Manning bed drag + Bingham yield threshold for viscous boss ink.
        const effH=Math.max(0.015,h);
        const drag=GRAVITY*manning*manning*speed/Math.pow(effH,1.3333);
        const yieldDamp=bossShare*0.55*dt;
        const damp=1/(1+dt*drag+yieldDamp);
        vx=clamp(vx*damp,-24,24);
        vz=clamp(vz*damp,-24,24);
        if (h<0.002) {vx*=0.65; vz*=0.65;}
        if (Math.abs(vx)<1e-4) vx=0;
        if (Math.abs(vz)<1e-4) vz=0;

        // Face-centered shallow-water fluxes with upwind/Rusanov stability (guarantees h >= 0).
        const uW=(ux[iW]+vx)*.5, uE=(vx+ux[iE])*.5;
        const vS=(uz[iS+ix]+vz)*.5, vN=(vz+uz[iN+ix])*.5;

        const waveDiff=0.14*(1-0.45*bossShare);
        const fluxW=(uW>=0?hW:h)*uW-waveDiff*(eta-etaW);
        const fluxE=(uE>=0?h:hE)*uE-waveDiff*(etaE-eta);
        const fluxS=(vS>=0?hS:h)*vS-waveDiff*(eta-etaS);
        const fluxN=(vN>=0?h:hN)*vN-waveDiff*(etaN-eta);

        // Species transport follows total flux direction from upwind donor cell.
        const shareW=(uW>=0?(hW>H_MIN?hbW/hW:0):(h>H_MIN?hb/h:0));
        const shareE=(uE>=0?(h>H_MIN?hb/h:0):(hE>H_MIN?hbE/hE:0));
        const shareS=(vS>=0?(hS>H_MIN?hbS/hS:0):(h>H_MIN?hb/h:0));
        const shareN=(vN>=0?(h>H_MIN?hb/h:0):(hN>H_MIN?hbN/hN:0));

        const divTot=alpha*((fluxE-fluxW)+(fluxN-fluxS));
        const divBoss=alpha*((fluxE*shareE-fluxW*shareW)+(fluxN*shareN-fluxS*shareS));
        const divWater=divTot-divBoss;

        // Gentle infiltration/evaporation when film thins out.
        const evap=this.zoneIndex===0?0.00045:0.00018;
        let nextW=Math.max(0,hw-divWater-dt*evap);
        let nextB=Math.max(0,hb-divBoss-dt*evap*0.45);
        // Renormalize extreme negative step if total exceeded available cell depth.
        const nextTot=nextW+nextB;
        if (nextTot>4.8) {
          const s=4.8/nextTot;
          nextW*=s; nextB*=s;
        }
        nhWater[i]=nextW;
        nhBoss[i]=nextB;
        nux[i]=vx;
        nuz[i]=vz;
        fx[i]=0;
        fz[i]=0;

        sumW+=nextW;
        sumB+=nextB;
        if (nextTot>maxD) maxD=nextTot;
        const spd=Math.hypot(vx,vz);
        if (spd>maxU) maxU=spd;
      }
    }

    this.hWater.set(nhWater);
    this.hBoss.set(nhBoss);
    this.ux.set(nux);
    this.uz.set(nuz);
    this.totalWaterVolume=sumW*cellArea;
    this.totalBossVolume=sumB*cellArea;
    this.maxDepth=maxD;
    this.maxSpeed=maxU;
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
    // Stratified rainfall addition onto open-sky surface cells + aerodynamic wind shear.
    const windX=1.35, windZ=0.45;
    for (let i=0;i<g.count;i++) {
      const exp=g.shelter[i];
      if (exp<=0.02) continue;
      const dh=rate*exp*dt;
      g.hWater[i]=Math.min(3.5,g.hWater[i]+dh);
      // Rain impact imparts slight tangential shear toward slope/wind.
      g.fx[i]+=windX*0.18*exp*dt;
      g.fz[i]+=windZ*0.18*exp*dt;
    }
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
    // Continuous black precipitation intensity scales slightly with boss phase (phase 1..3).
    const phaseBoost=1+0.22*Math.max(0,(boss.phase??1)-1);
    const bossRainDepthRate=0.0165*phaseBoost;
    this.bossRainRate=bossRainDepthRate;

    for (let i=0;i<g.count;i++) {
      const exp=g.shelter[i];
      if (exp<=0.02) continue;
      const addH=bossRainDepthRate*exp*dt;
      g.hBoss[i]=Math.min(4.2,g.hBoss[i]+addH);
    }

    // Direct raindrop impact splatters onto paint surface (both Zone 0 open ground & elevated decks)
    // and accumulates kinetic boss droplets across roofs, streets, and destructible objects.
    this._bossAccum+=dt*phaseBoost;
    if (paint && this._bossAccum>=0.045) {
      const drops=Math.min(18,Math.max(4,Math.floor(this._bossAccum/0.022)));
      this._bossAccum=0;
      const bw=BOUNDS[0]-1.5, bd=BOUNDS[1]-1.5;
      for (let k=0;k<drops;k++) {
        // Golden-ratio quasi-random coverage across surface arena + deterministic rng jitter.
        this._rainCursor=(this._rainCursor+0.61803398875)%1;
        const u1=this._rainCursor;
        const u2=((this._rainCursor*7.131+k*0.381966)%1);
        const rx=(u1*2-1)*bw;
        const rz=(u2*2-1)*bd;
        const idx=g.indexAtWorld(rx,rz);
        if (idx>=0 && g.shelter[idx]<0.12) continue;
        const layer=Math.abs(rz)<11.5 && Math.abs(rx)<24?0:Math.abs(rx)<51 && (Math.abs(rz)<33)?0:1;
        // Paint black ink (team = 2 -> owner = 3).
        paint.stamp(rx,rz,1.25+0.45*phaseBoost,2,0,this.clock*2+k,.042*phaseBoost);
        if (Math.abs(rx)>12 && Math.abs(rx)<48 && Math.abs(rz)<18 && k%3===0) {
          paint.stamp(rx,rz,1.05,2,1,this.clock+k,.034);
        }
        // Ink bombardment weight also stresses exposed destructible objects/buildings on the surface.
        battle.stage?.strikeAt?.(rx,battle.world?.floor(rx,rz)?.y??0,rz,6.5*phaseBoost,2,0.55,{inkRain:true});
      }
    }
  }

  // Step 3: Percolation & stairwell gravity flow transferring Surface boss ink + floodwater into B1.
  stepPercolation(battle,dt) {
    const paint=battle?.paint;
    const surf=this.surface;
    const under=this.underground;
    const cellArea=DX*DX;
    let totalBossFlux=0, totalWaterFlux=0;

    for (const drain of STORM_DRAINS) {
      const sIdx=surf.indexAtWorld(drain.sx,drain.sz);
      const uIdx=under.indexAtWorld(drain.ux,drain.uz);
      if (sIdx<0 || uIdx<0) continue;

      // Sample neighborhood around intake so runoff in a 2.5m catchment reaches the grate/stairwell.
      const sx0=drain.sx, sz0=drain.sz;
      const headH=surf.hBoss[sIdx]+surf.hWater[sIdx];
      if (headH<=0.002) continue;

      // Torricelli orifice/weir discharge: Q = Cd * A * sqrt(2 * g * h_head)
      const qMax=drain.cd*drain.area*Math.sqrt(2*GRAVITY*Math.max(0.01,headH));
      const availableVol=headH*cellArea;
      const volOut=Math.min(availableVol*0.65,qMax*dt);
      if (volOut<=1e-6) continue;

      const bossFrac=surf.hBoss[sIdx]/headH;
      const dBossVol=volOut*bossFrac;
      const dWaterVol=volOut*(1-bossFrac);

      // Conserve mass: remove from surface cell and inject radially into B1 with stair-chute momentum!
      const dhOut=volOut/cellArea;
      surf.hBoss[sIdx]=Math.max(0,surf.hBoss[sIdx]-dhOut*bossFrac);
      surf.hWater[sIdx]=Math.max(0,surf.hWater[sIdx]-dhOut*(1-bossFrac));

      const chuteDir=drain.kind==='stair'?(drain.sx<0?1:-1)*2.4:0;
      under.addFluidAt(drain.ux,drain.uz,drain.radius+1.2,dWaterVol,dBossVol,chuteDir*dt*4,0);
      totalBossFlux+=dBossVol;
      totalWaterFlux+=dWaterVol;
    }

    this.lastPercolationRate=(totalBossFlux+totalWaterFlux)/Math.max(dt,1e-4);
    this.cumulativePercolatedBoss+=totalBossFlux;
    this.cumulativePercolatedWater+=totalWaterFlux;

    // Update rising standing B1 black ink depth & transfer settled boss fluid onto B1 Paint cells.
    const targetBossDepth=clamp(under.totalBossVolume/(UNDER_BOUNDS[0]*UNDER_BOUNDS[1]*0.42),0,2.25);
    if (battle?.boss?.active) {
      this.underBossDepth=this.underBossDepth+(targetBossDepth-this.underBossDepth)*Math.min(1,dt*2.4);
    } else {
      // Drains slowly via storm pumps once boss is defeated.
      this.underBossDepth=Math.max(0,this.underBossDepth-dt*0.032);
    }
    this.underWaterDepth=clamp(under.totalWaterVolume/(UNDER_BOUNDS[0]*UNDER_BOUNDS[1]*0.45),0,2.7);

    // Paint B1 cells wherever percolating boss black ink spreads across the B1 floor!
    if (paint && under.totalBossVolume>0.02) {
      this._paintAccum+=dt;
      if (this._paintAccum>=0.08) {
        this._paintAccum=0;
        const nx=under.nx, nz=under.nz;
        let stamped=0;
        for (let iz=1;iz<nz-1 && stamped<28;iz++) {
          const z=-under.halfZ+(iz+.5)*DX;
          for (let ix=1;ix<nx-1;ix++) {
            const idx=iz*nx+ix;
            const depth=under.hBoss[idx];
            if (depth>0.0038) {
              // Stride jitter so paint fills cleanly & quickly along the flowing front.
              if (((ix+iz+Math.floor(this.clock*12))&1)===0 || depth>0.025) {
                const lx=-under.halfX+(ix+.5)*DX;
                const wx=UNDER_X+lx;
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
    // Coalesced heavy projectiles experience modest aerodynamic drag; wide/fine spray droplets experience stronger drag.
    const r=weapon?.radius??1.0;
    const pellets=weapon?.pellets??1;
    const densityScale=pellets>1?2.2:weapon?.id==='lob'?0.035:clamp(1.1/Math.max(0.4,r),0.04,0.14);
    const rainMul=this.weatherRainRate>0?1.35:this.bossRainRate>0?1.2:1.0;
    return clamp(0.032*densityScale*rainMul,0.001,0.38);
  }

  stepProjectileFluid(shot,gravity,dt,rng=Math.random) {
    const vel=shot.vel;
    const speed=Math.hypot(vel[0],vel[1],vel[2]);
    const rM=clamp((shot.weapon?.radius??1.0)*0.09,0.035,0.22);
    const media=shot.team===-1||shot.team===2?FLUID_MEDIA.boss:FLUID_MEDIA.ink;
    const Re=Math.max(1,(AIR_DENSITY*speed*(2*rM))/1.8e-5);
    const weber=(media.density*speed*speed*(2*rM))/media.surfaceTension;
    this.meanWeberNumber=this.meanWeberNumber*0.92+weber*0.08;

    const gamma=shot.dragGamma??(shot.dragGamma=this.projectileDragGamma(shot.weapon));
    const decay=Math.exp(-gamma*dt);
    const kPos=gamma>1e-5?(1-decay)/gamma:dt;
    const termY=gamma>1e-5?gravity/gamma:0;

    // Exact linear-drag ODE advance matching inverse-drag launch compensation in ballistic aiming.
    const nvx=vel[0]*decay;
    const nvz=vel[2]*decay;
    const nvy=gamma>1e-5?(vel[1]+termY)*decay-termY:vel[1]-gravity*dt;

    const nx=shot.pos[0]+vel[0]*kPos;
    const nz=shot.pos[2]+vel[2]*kPos;
    const ny=gamma>1e-5
      ?shot.pos[1]+(vel[1]+termY)*kPos-termY*dt
      :shot.pos[1]+vel[1]*dt-0.5*gravity*dt*dt;

    shot.pos[0]=nx; shot.pos[1]=ny; shot.pos[2]=nz;
    vel[0]=nvx; vel[1]=nvy; vel[2]=nvz;

    // Bag-breakup / Kelvin-Helmholtz droplet shedding when Weber number exceeds critical threshold.
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
    return {breakup:!!breakupDrop,drop:breakupDrop,weber,reynolds:Re,gamma};
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
          }
        }
        if (prof.pressure>peakForce) peakForce=prof.pressure;
      }

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
      for (let i=0;i<ug.count;i++) {
        ug.hWater[i]=Math.max(ug.hWater[i],target*0.72);
      }
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
