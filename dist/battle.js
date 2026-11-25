import {TAU,add,clamp,cross,dot,forward,mix,scale,splatRadius,sub,unit} from './render.js';
import {SPAWN_X,TEAM,TEAM_INK,randomGenerator} from './world.js';
import {BASE_TANK,GIGA_TANK,METRO,RAIL,CITY_RADIUS,UNDER_Y,ZONES,cityExit,floorBounds,giantScale,isCabin,isUnder,localX,sameLevel,zoneOf} from './layout.js';
import {Transit} from './transit.js';
import {Abilities,drawSquid} from './abilities.js';
import {Boss} from './boss.js';
import {drawBossModel} from './boss-model.js';
import {RAIDER_INK,Raiders,drawRaider} from './raiders.js';
import {Hazards} from './hazards.js';
import {drawCabinDoors,drawCabinScenery,drawCabinWindows} from './metro-stage.js';
import {Tactics} from './tactics.js';
import {NpcMotion,resetGait,limbJoint} from './npc-motion.js';
import {NpcPerception} from './npc-perception.js';
import {HNV1} from './hnv1.js';
import {CheaterEngine} from './cheater-engine.js';
import {stairCrossing,stairEnd,stairFloorY,stairLane,stairNeighborShift,stairRay} from './stairs.js';
import {actorInRay,collectShapes,traceShapes} from './collision.js';
import {AUTO_AIM_LOCK,CHEATER_WEAPON,EBOT,INK_EPSILON,OM_HOMING,PAINT_RADIUS_FACTOR,SUPERS,WEAPONS,shotTravel,weaponById} from './weapons.js';
import {SUBWEAPONS,Subweapons,subweaponById} from './subweapons.js';
import {StageObjects} from './stage-objects.js';
import {Vehicles} from './vehicles.js';
import {surfacePaintRadius} from './ink.js';
import {DynamicStage} from './dynamic-stage.js';
import {FluidEngine,wallRunoff} from './ink-fluid.js';

export const DURATION=420;
export const DAMAGE_SCALE=1/3;
// Seconds out of play after a splat; the boss keeps its victims out longer.
export const RESPAWN_SECONDS=12;
export const BOSS_RESPAWN_SECONDS=15;
export const EXP_PER_KILL=30;
// Input-driven crews (the player, and every human player in a server match)
// run this fast; NPCs keep their own route pace.
export const PLAYER_PACE={forward:7.4,back:6.4};
const MAX_TEAM_INDEX=16;
export const chargeGain=actor=>1-(actor.inkPenalty??0)*.064;
function decalBasis(n,phase) {
  const ref=Math.abs(n[1])>.9?[0,0,1]:[0,1,0];
  const base=unit(cross(ref,n)), side=cross(n,base);
  const x=add(scale(base,Math.cos(phase)),scale(side,Math.sin(phase)));
  return [x,cross(n,x),n];
}
const WHITE = 0xeae9d8, BOOT = 0x323f44, GRAPHITE = 0x425155, TRIM = 0x82908b;
const DECAL_RIM=Array.from({length:12},(_,i)=>splatRadius(i*TAU/12));
// Decals never move once placed, so their clipped triangle fan is built once
// (kept outside the decal so checkpoints stay small).
const decalShapes=new WeakMap();
function decalShape(geometry,decal) {
  let shape=decalShapes.get(decal);
  if (shape) return shape;
  const axes=decalBasis(decal.normal,decal.phase);
  const rim=geometry.coat(decal,axes,DECAL_RIM);
  shape={axes,origin:decal.p.slice()};
  if (rim) {
    shape.fan=[];
    for (let j=0;j<rim.length;j++) {
      const u=sub(add(rim[j],scale(decal.normal,.023)),decal.p);
      const v=sub(add(rim[(j+1)%rim.length],scale(decal.normal,.023)),decal.p);
      if (Math.hypot(...cross(u,v))>=.000002) shape.fan.push([u,v,decal.normal]);
    }
  }
  decalShapes.set(decal,shape);
  return shape;
}
export const INK_HIT_DURATION=.8;
const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);

const _impPlane=[[0,0,0],[0,0,0],[0,0,0]];
const _impTriBasis=[[0,0,0],[0,0,0],[0,0,0]];
const _impDyn={dynamic:true};
const _impTriOpts={dynamic:true,basis:_impTriBasis};
const _impRipOpts=[
  {dynamic:true,basis:_impPlane,label:0},
  {dynamic:true,basis:_impPlane,label:0},
  {dynamic:true,basis:_impPlane,label:0},
  {dynamic:true,basis:_impPlane,label:0},
  {dynamic:true,basis:_impPlane,label:0}
];

function drawInkImpact(renderer,{p,team,at,normal:surface,kind=0},eye,time) {
  const age=clamp((time-at)/INK_HIT_DURATION,0,1);
  const px=p[0], py=p[1], pz=p[2];
  const tx=eye[0]-px, ty=eye[1]-py, tz=eye[2]-pz;
  const range=Math.hypot(tx,ty,tz);
  if (age>=1 || range<1.05) return;
  const body=!surface;
  if (renderer.inFrustum && !renderer.inFrustum(px,py,pz,body?5.2:2.4)) return;
  const invR=1/range;
  const nx=surface?surface[0]:tx*invR, ny=surface?surface[1]:ty*invR, nz=surface?surface[2]:tz*invR;
  // Inline orthonormal decalBasis(normal, 0) without allocating
  let rx, ry, rz;
  if (ny>.92 || ny<-.92) {
    const inv=1/Math.max(1e-5,Math.hypot(nz,ny));
    rx=0; ry=nz*inv; rz=-ny*inv;
  } else {
    const inv=1/Math.max(1e-5,Math.hypot(nz,nx));
    rx=-nz*inv; ry=0; rz=nx*inv;
  }
  const ux=ny*rz-nz*ry, uy=nz*rx-nx*rz, uz=nx*ry-ny*rx;

  // A body hit reads unmistakably from across the street: layered shockwaves,
  // incandescent flash bloom, spinning starburst crosses, and radial liquid spikes.
  const other=kind===3, finish=kind===2;
  const boost=body?(finish?3.85:other?1.55:2.90):1.18;
  const size=(surface?.74:1)*clamp(range/7.6,.78,body?(other?1.85:3.18):1.64)*boost;
  const fade=1-age, ease=1-fade*fade, radius=(.38+.84*ease)*size;
  const cx=px+nx*.10, cy=py+ny*.10, cz=pz+nz*.10;
  const sx=cx+nx*.016, sy=cy+ny*.016, sz=cz+nz*.016;
  const tint=TEAM_INK[team] ?? RAIDER_INK;
  const accent=finish?0xffd066:0xfff7dc;
  const lite=!!renderer.lite || !!renderer.ultralite;
  const useScratch=!!renderer.seal;

  _impPlane[0][0]=rx; _impPlane[0][1]=ry; _impPlane[0][2]=rz;
  _impPlane[1][0]=nx; _impPlane[1][1]=ny; _impPlane[1][2]=nz;
  _impPlane[2][0]=-ux; _impPlane[2][1]=-uy; _impPlane[2][2]=-uz;
  const addRipple=(slot,x,y,z,rad,col,lbl)=>{
    if (useScratch) {
      const o=_impRipOpts[slot];
      o.label=lbl;
      renderer.add('ripple',x,y,z,rad,.03,rad,col,12,o);
    } else {
      renderer.add('ripple',x,y,z,rad,.03,rad,col,12,{dynamic:true,basis:[[rx,ry,rz],[nx,ny,nz],[-ux,-uy,-uz]],label:lbl});
    }
  };
  const addTri=(bx,by,bz,a0x,a0y,a0z,a1x,a1y,a1z,col)=>{
    if (useScratch) {
      _impTriBasis[0][0]=a0x; _impTriBasis[0][1]=a0y; _impTriBasis[0][2]=a0z;
      _impTriBasis[1][0]=a1x; _impTriBasis[1][1]=a1y; _impTriBasis[1][2]=a1z;
      _impTriBasis[2][0]=nx; _impTriBasis[2][1]=ny; _impTriBasis[2][2]=nz;
      renderer.add('tri',bx,by,bz,1,1,1,col,3,_impTriOpts);
    } else {
      renderer.add('tri',bx,by,bz,1,1,1,col,3,{dynamic:true,basis:[[a0x,a0y,a0z],[a1x,a1y,a1z],[nx,ny,nz]]});
    }
  };

  // Primary expanding liquid shockwave + hot inner pressure ring
  addRipple(0,cx,cy,cz,radius*2.05,tint,age);
  addRipple(1,sx,sy,sz,radius*1.44,accent,Math.min(1,age*1.38));

  if (body) {
    // Delayed outer concussion wave & KO supernova ring
    const late=clamp(age*1.55-.10,0,1);
    addRipple(2,sx,sy,sz,radius*2.98*late,finish?0xffe885:tint,Math.min(1,.14+late*.86));
    if (finish && !lite) {
      const nova=clamp(age*1.35-.16,0,1);
      addRipple(3,cx,cy,cz,radius*3.95*nova,0xff5240,Math.min(1,.12+nova*.88));
    }
    // Wide high-contrast body-silhouette halo so hits pop even behind cover
    const halo=(1.02+1.42*ease)*(other?.78:finish?1.26:1)*clamp(range/11,1,2.6);
    addRipple(4,cx,cy,cz,halo*2,finish?0xfff2c2:0xffffff,Math.min(1,.28+age*.82));

    // Incandescent flash core + glossy liquid shock-sphere + kinetic KO ring
    if (age<.40) {
      const tCore=1-age/.40, core=(.58+.36*fade)*size*tCore;
      renderer.add('orb',sx,sy,sz,core,core,core,0xffffff,3,_impDyn);
      renderer.add('orb',sx,sy,sz,core*1.88,core*1.88,core*1.88,tint,9,_impDyn);
      if (finish) {
        renderer.add('orb',sx,sy,sz,core*2.5,core*2.5,core*2.5,0xffdf7a,3,_impDyn);
        if (!lite) renderer.add('ring',sx,sy,sz,radius*2.3,core*.34,radius*2.3,0xfff2c2,3,_impRipOpts[0]);
      }
    }

    // Crisp spinning dual starburst flare (primary + diagonal X-flare on KO/direct hits!)
    const spin=age*(finish?2.6:1.25);
    const cs=Math.cos(spin), sn=Math.sin(spin);
    const rAx=rx*cs+ux*sn, rAy=ry*cs+uy*sn, rAz=rz*cs+uz*sn;
    const uAx=-rx*sn+ux*cs, uAy=-ry*sn+uy*cs, uAz=-rz*sn+uz*cs;
    const reach=(.66+1.46*ease)*size*(finish?1.28:1), width=.128*size*fade;
    // Arm 1 (+rA / -rA)
    addTri(cx-rAx*reach,cy-rAy*reach,cz-rAz*reach,rAx*reach*2,rAy*reach*2,rAz*reach*2,uAx*width,uAy*width,uAz*width,accent);
    addTri(cx+rAx*reach,cy+rAy*reach,cz+rAz*reach,-rAx*reach*2,-rAy*reach*2,-rAz*reach*2,-uAx*width,-uAy*width,-uAz*width,accent);
    // Arm 2 (+uA / -uA)
    addTri(cx-uAx*reach,cy-uAy*reach,cz-uAz*reach,uAx*reach*2,uAy*reach*2,uAz*reach*2,rAx*width,rAy*width,rAz*width,accent);
    addTri(cx+uAx*reach,cy+uAy*reach,cz+uAz*reach,-uAx*reach*2,-uAy*reach*2,-uAz*reach*2,-rAx*width,-rAy*width,-rAz*width,accent);
    if (!lite) {
      const dReach=reach*(finish?.90:.66), dWidth=width*.80;
      const d1x=(rAx+uAx)*Math.SQRT1_2, d1y=(rAy+uAy)*Math.SQRT1_2, d1z=(rAz+uAz)*Math.SQRT1_2;
      const d2x=(uAx-rAx)*Math.SQRT1_2, d2y=(uAy-rAy)*Math.SQRT1_2, d2z=(uAz-rAz)*Math.SQRT1_2;
      const dCol=finish?0xff6e4a:tint;
      addTri(cx-d1x*dReach,cy-d1y*dReach,cz-d1z*dReach,d1x*dReach*2,d1y*dReach*2,d1z*dReach*2,d2x*dWidth,d2y*dWidth,d2z*dWidth,dCol);
      addTri(cx+d1x*dReach,cy+d1y*dReach,cz+d1z*dReach,-d1x*dReach*2,-d1y*dReach*2,-d1z*dReach*2,-d2x*dWidth,-d2y*dWidth,-d2z*dWidth,dCol);
      addTri(cx-d2x*dReach,cy-d2y*dReach,cz-d2z*dReach,d2x*dReach*2,d2y*dReach*2,d2z*dReach*2,d1x*dWidth,d1y*dWidth,d1z*dWidth,dCol);
      addTri(cx+d2x*dReach,cy+d2y*dReach,cz+d2z*dReach,-d2x*dReach*2,-d2y*dReach*2,-d2z*dReach*2,-d1x*dWidth,-d1y*dWidth,-d1z*dWidth,dCol);
    }
  } else if (age<.44) {
    // Crisp surface-splat flash & bouncing crown droplets
    const spark=(.32+.25*fade)*size*(1-age/.44);
    renderer.add('orb',sx,sy,sz,spark,spark,spark,0xfff6d8,3,_impDyn);
    const liftH=(.18+.48*ease)*size;
    renderer.add('orb',cx+nx*liftH,cy+ny*liftH,cz+nz*liftH,spark*.82,spark*1.28,spark*.82,tint,9,_impDyn);
  }

  // Radial directional liquid lance-spikes + arcing kinetic ink beads (strictly 8 spikes on lite body hits)
  const spikes=lite?(body?8:5):body?(finish?16:10):6;
  const invSpikes=TAU/spikes;
  for (let i=0;i<spikes;i++) {
    const angle=(i+.5)*invSpikes+age*(body?.38:.16);
    const ca=Math.cos(angle), sa=Math.sin(angle);
    const dx=rx*ca+ux*sa, dy=ry*ca+uy*sa, dz=rz*ca+uz*sa;
    // cross(direction, normal) * (.14 * size * fade)
    const sw=.14*size*fade;
    const sdx=(dy*nz-dz*ny)*sw, sdy=(dz*nx-dx*nz)*sw, sdz=(dx*ny-dy*nx)*sw;
    const lenMul=body?(i%2?1.68:1.20):1.10;
    const tipL=(.20+.44*fade)*size*lenMul;
    const tpx=dx*tipL+sdx*.5, tpy=dy*tipL+sdy*.5, tpz=dz*tipL+sdz*.5;
    const rOff=radius*(i%2?1.05:.86);
    const bsx=cx+dx*rOff-sdx*.5, bsy=cy+dy*rOff-sdy*.5, bsz=cz+dz*rOff-sdz*.5;
    addTri(bsx,bsy,bsz,sdx,sdy,sdz,tpx,tpy,tpz,i%2?tint:accent);
    if (!lite || body) {
      const lift=(.24+.40*ease)*fade;
      const out=.26*size*ease;
      const bs=(.108+(i%2?.048:0))*fade*size;
      renderer.add('orb',bsx+dx*out+nx*lift,bsy+dy*out+ny*lift,bsz+dz*out+nz*lift,bs,bs*1.6,bs,i%3===0?accent:tint,i%3===0?3:9,_impDyn);
      if (!lite && body && i%2===0) {
        // Trailing micro-ember spark farther along the radial vector
        const out2=.58*size*ease, bs2=bs*.62;
        renderer.add('orb',bsx+dx*out2+nx*lift*.6,bsy+dy*out2+ny*lift*.6,bsz+dz*out2+nz*lift*.6,bs2,bs2,bs2,finish?0xffe885:accent,3,_impDyn);
      }
    }
  }
}

function shotFraction(from,to) {
  const cap=(start,end,min,max)=>end>max?(max-start)/(end-start):end<min?(min-start)/(end-start):1;
  if (zoneOf(from[0])===0) {
    return cityExit(from,to)??1;
  }
  const [boundX,boundZ]=floorBounds(from[0]), x=localX(from[0]);
  return clamp(Math.min(cap(x,x+to[0]-from[0],-boundX-13,boundX+13),cap(from[2],to[2],-boundZ-13,boundZ+13)),0,1);
}

class Navigation {
  constructor(world,zone) {
    this.world=world;
    this.nodes=[];
    const {bounds,x}=zone, spacing=this.spacing=isCabin(zone.x)?.72:1.7;
    const margin=isCabin(zone.x)?.60:1;
    this.x0=x-bounds[0]+margin;
    this.z0=-bounds[1]+margin;
    this.columns=Math.floor((bounds[0]*2-2*margin)/spacing)+1;
    this.rows=Math.floor(-2*this.z0/spacing)+1;
    const grid=this.grid=new Array(this.columns*this.rows);
    for (let z=0;z<this.rows;z++) for (let x=0;x<this.columns;x++) {
      const px=this.x0+x*spacing, pz=this.z0+z*spacing;
      const sy=stairFloorY(px,pz);
      if (sy===sy || !world.stand(px,pz,.58)) continue;
      const f=world.floor(px,pz);
      const node={x:px,z:pz,y:f.y,layer:f.layer,i:this.nodes.length,links:[],dists:[]};
      this.nodes.push(node);
      grid[z*this.columns+x]=node;
    }
    const cols=this.columns, rows=this.rows;
    const dirs=[[1,0],[-1,1],[0,1],[1,1]];
    for (let index=0;index<grid.length;index++) {
      const node=grid[index];
      if (!node) continue;
      const column=index%cols, row=(index/cols)|0;
      for (let d=0;d<4;d++) {
        const nx=column+dirs[d][0], nz=row+dirs[d][1];
        if (nx<0 || nx>=cols || nz<0 || nz>=rows) continue;
        const next=grid[nz*cols+nx];
        if (next && this.clear(node,next)) {
          const dist=Math.hypot(next.x-node.x,next.z-node.z);
          node.links.push(next); node.dists.push(dist);
          next.links.push(node); next.dists.push(dist);
        }
      }
    }
    const n=this.nodes.length;
    this._g=new Float32Array(n);
    this._f=new Float32Array(n);
    this._parent=new Int32Array(n);
    this._stamp=new Uint32Array(n);
    this._heap=new Int32Array(n);
    this._heapPos=new Int32Array(n);
    this._wVal=new Float32Array(n);
    this._wStamp=new Uint32Array(n);
    this._wGen=0;
    this._gen=0;
  }

  clear(a,b,radius=.61,height=1.68) {
    const ax=a.x, az=a.z, dx=b.x-ax, dz=b.z-az;
    const count=Math.ceil(Math.hypot(dx,dz)/.28);
    if (!count) return true;
    const world=this.world;
    let floor=world.floorY(ax,az);
    const sa=stairFloorY(ax,az), sb=stairFloorY(b.x,b.z);
    const allowStairs=(sa===sa) || (sb===sb);
    const inv=1/count, sx=dx*inv, sz=dz*inv;
    let x=ax, z=az;
    for (let step=1;step<=count;step++) {
      x+=sx; z+=sz;
      if (!allowStairs) {
        const sy=stairFloorY(x,z);
        if (sy===sy) return false;
      }
      const y=world.floorY(x,z);
      const dy=y-floor;
      if (dy>.39 || dy<-.39 || world.blocked(x,y+.025,z,radius,height)) return false;
      floor=y;
    }
    return true;
  }

  nearest(point,radius=.43,height=1.68) {
    let best=null, bestDistance=Infinity;
    const px=point.x, pz=point.z, cols=this.columns, rows=this.rows;
    const col=Math.round((px-this.x0)/this.spacing), row=Math.round((pz-this.z0)/this.spacing);
    const grid=this.grid;
    for (let ring=0;ring<=3;ring++) {
      if (ring===0) {
        if (col>=0 && col<cols && row>=0 && row<rows) {
          const node=grid[row*cols+col];
          if (node) {
            const dx=node.x-px, dz=node.z-pz, d=dx*dx+dz*dz;
            if (d<bestDistance && this.clear(point,node,radius,height)) {best=node;bestDistance=d;}
          }
        }
        continue;
      }
      const z0=row-ring, z1=row+ring, x0=col-ring, x1=col+ring, stepX=ring*2;
      for (let z=z0;z<=z1;z++) {
        if (z<0 || z>=rows) continue;
        const rowOff=z*cols, step=(z===z0 || z===z1)?1:stepX;
        for (let x=x0;x<=x1;x+=step) {
          if (x<0 || x>=cols) continue;
          const node=grid[rowOff+x];
          if (!node) continue;
          const dx=node.x-px, dz=node.z-pz, d=dx*dx+dz*dz;
          if (d<bestDistance && this.clear(point,node,radius,height)) {best=node;bestDistance=d;}
        }
      }
    }
    return best;
  }

  route(from,goal,radius=.61,height=1.68,weight=null,openAt=null) {
    const start=this.nearest(from,Math.min(radius,.43),height), end=goal;
    if (!start || !end) return [];
    if (!weight && !openAt && this.clear(from,end,radius,height)) return [end];
    const nodes=this.nodes, g=this._g, f=this._f, parent=this._parent;
    const stamp=this._stamp, heap=this._heap, heapPos=this._heapPos;
    let gen=++this._gen;
    if (gen===0) {stamp.fill(0);gen=this._gen=1;}
    const endX=end.x, endZ=end.z, si=start.i, ei=end.i;
    stamp[si]=gen;
    g[si]=0;
    f[si]=Math.hypot(start.x-endX,start.z-endZ);
    parent[si]=-1;
    heap[0]=si;
    heapPos[si]=0;
    let heapSize=1;
    const checkClear=radius>.61 || height>1.68;
    const siftUp=pos=>{
      const nodeIdx=heap[pos], fv=f[nodeIdx];
      while (pos>0) {
        const up=(pos-1)>>1, upNode=heap[up];
        if (fv>=f[upNode]) break;
        heap[pos]=upNode; heapPos[upNode]=pos;
        pos=up;
      }
      heap[pos]=nodeIdx; heapPos[nodeIdx]=pos;
    };
    while (heapSize>0) {
      const hi=heap[0];
      heapPos[hi]=-1;
      const last=heap[--heapSize];
      if (heapSize>0) {
        const fv=f[last];
        let pos=0;
        while (true) {
          const l=(pos<<1)+1;
          if (l>=heapSize) break;
          const r=l+1;
          let best=l, bf=f[heap[l]];
          if (r<heapSize) {const rf=f[heap[r]];if (rf<bf) {best=r;bf=rf;}}
          if (fv<=bf) break;
          const bn=heap[best];
          heap[pos]=bn; heapPos[bn]=pos;
          pos=best;
        }
        heap[pos]=last; heapPos[last]=pos;
      }
      if (hi===ei) {
        const route=[];
        for (let k=ei;k!==si && k>=0;k=parent[k]) route.push(nodes[k]);
        route.push(start);
        route.reverse();
        while (route.length>1 && !weight && !openAt && this.clear(from,route[1],radius,height)) route.shift();
        return route;
      }
      const here=nodes[hi], links=here.links, dists=here.dists, gHere=g[hi];
      for (let i=0;i<links.length;i++) {
        const next=links[i];
        if (openAt && !openAt(next)) continue;
        if (checkClear && !this.clear(here,next,radius,height)) continue;
        const ni=next.i;
        if (stamp[ni]!==gen) {
          stamp[ni]=gen;
          g[ni]=Infinity;
          parent[ni]=-1;
          heapPos[ni]=-1;
        }
        const cost=gHere+dists[i]*(weight?weight(next):1);
        if (cost>=g[ni]) continue;
        g[ni]=cost;
        f[ni]=cost+Math.hypot(next.x-endX,next.z-endZ);
        parent[ni]=hi;
        const pos=heapPos[ni];
        if (pos<0) {
          heap[heapSize]=ni;
          heapPos[ni]=heapSize;
          siftUp(heapSize++);
        } else siftUp(pos);
      }
    }
    return [];
  }
}

function actorAt(team,index,isPlayer,weapon) {
  const tankMax=BASE_TANK*(weapon?.tankScale ?? 1);
  const actor={
    team,index,isPlayer,weapon,name:isPlayer?'YOU':(team===0?'C-':'A-')+String(index+1).padStart(2,'0'), kills:0, downs:0, painted:0,
    dealt:0,supers:0,subs:0,revealUntil:0,revealTeam:-1,downBy:null,
    hp:100,maxHp:100,tank:tankMax,tankMax,down:0,superCharge:0,countedPaint:0,drone:null,droneReady:0,liftsUsed:0, shield:0, fire:0, heat:0, damageAge:99, lastDamageAt:-99, recoil:0, swimFX:0,
    subId:index===6?'see':SUBWEAPONS[(team*3+index)%5].id,subReady:0,rolling:false,rollHold:0,
    swimming:false, inkSwimming:false, climbing:false, inkExposure:0, inkPenalty:0, x:0,y:0,z:0,yaw:0,pitch:0,vx:0,vy:0,vz:0,steps:0,
    route:[],goal:null,think:.12*index,roam:0,stuck:0,side:index%2?1:-1
  };
  respawn(actor);
  return actor;
}

function respawn(a) {
  a.x=(a.team===0?-1:1)*(SPAWN_X+(a.index>=4?2.65:0));
  a.y=0;
  a.z=[-2.7,-.88,.94,2.76][a.index%4];
  a.yaw=a.team===0?Math.PI/2:-Math.PI/2;
  a.pitch=-.14;
  a.hp=a.maxHp=a.baseHp??100;
  a.superUntil=0;
  a.activeSpecial=null;
  a.guard=0;
  a.rangeFactor=1;
  a.giant=a.beaming=false;
  a.slam=a.ride=a.lift=a.car=null;
  a.radius=a.height=undefined;
  a.travelGoal=null;
  a.doorReady=0;
  a.cabinToSide=a.cabinToLevel=null;
  a.tank=a.tankMax;
  a.shield=1.5;
  a.down=0;
  a.downBy=null;
  a.revealUntil=0;
  a.vx=a.vy=a.vz=0;
  a.rolling=false;
  a.rollHold=0;
  a.rollUsed=false;
  a.fire=.1;
  a.heat=0;
  a.swimming=a.inkSwimming=a.climbing=false;
  a.climbNormal=null;
  a.airborne=false;
  a.landing=0;
  a.inkExposure=a.inkPenalty=0;
  a.route=[];
  a.goal=null;
  a.think=.13+.17*a.index;
  a.roam=0;
  a.stuck=0;
  a.damageAge=99;
  a.charge=0;
  a.driveX=a.driveZ=0;
  a.jumpBuffer=a.coyote=a.shotBuffer=0;
  a.scan=0;
  a.enemy=a.lastSeen=null;
  resetGait(a);
}

export class Battle {
  constructor(world,paint,mode,callbacks = {},options = {}) {
    this.world=world;
    this.paint=paint;
    this.stage=new StageObjects(world);
    this.fluid=(this.paint && !this.paint.visualOnly)?new FluidEngine(world,this.paint):null;
    this.dynamicStage=new DynamicStage(world,this.paint);
    this.vehicles=new Vehicles(this);
    this.mode=mode;
    this.callbacks=callbacks;
    this.timeless=mode==='timeless';
    this.unlimited=this.timeless || !!options.unlimitedTime;
    this.teamSize=this.timeless || options.teamSize===4?4:8;
    // A seeded match (the offline film) replays exactly from its seed.
    this.seed=Number.isInteger(options.seed)?options.seed:null;
    this.rng=randomGenerator(this.seed ?? (mode==='watch'?77349:947213));
    this.navs=world.navigations ??= ZONES.map(zone=>new Navigation(world,zone));
    [this.nav,this.lowerNav]=this.navs;
    this.transit=new Transit(world,paint);
    this.metro=new Transit(world,paint,METRO);
    this.transit.peer=this.metro;
    this.metro.peer=this.transit;
    this.abilities=new Abilities(this);
    this.subweapons=new Subweapons(this);
    this.boss=new Boss(this);
    this.raiders=new Raiders(this);
    this.hazards=new Hazards(this);
    this.clock=0;
    this.duration=DURATION;
    this.left=this.unlimited?Infinity:this.duration;
    this.elapsed=0;
    this.countdown=3;
    this.actors=[];
    this.shots=[];
    this.shotSequence=0;
    this.drops=[];
    this.inkImpacts=[];
    this.decals=[];
    this.decalSequence=0;
    this.crewShapes=new WeakMap();
    this.events=[];
    this.watching=0;
    this.finished=false;
    this.player=null;
    this.paint.reset();
    this.fluid?.reset();
    this.stage?.destruction?.reset();
    this.dynamicStage?.reset();
    for (let t=0;t<2;t++) for (let i=0;i<this.teamSize;i++) {
      const player=mode!=='watch' && t===0 && i===1;
      const slot=this.timeless?[[0,1,6,9],[7,9,8,2]][t][i]:[0,t===0?1:7,9,2,3,5,t===0?6:10,t===0?11:8][i];
      const weapon=player?weaponById(options.weapon):WEAPONS[slot];
      const actor=actorAt(t,i,player,weapon);
      if (player) actor.subId=subweaponById(options.sub).id;
      this.actors.push(actor);
      if (actor.isPlayer) this.player=actor;
      this.paint.stamp(actor.x,actor.z,2.15,t,0,i*.4,.044);
    }
    // A seeded match (the offline renderer) places the chip reproducibly.
    const random=this.seed===null?Math.random:randomGenerator(this.seed);
    const pool=(random()<.32?this.lowerNav:this.nav).nodes.filter(n=>Math.abs(localX(n.x))<40 && this.world.stand(n.x,n.z,.55));
    const chip=pool[Math.floor(random()*pool.length)];
    this.chip={x:chip.x,y:this.world.floor(chip.x,chip.z).y,z:chip.z,owner:null,yaw:random()*TAU};
    // Cheater NPC appears once every two matches (50% probability), carrying the
    // illegally modified オート英馬 II Super with half ink cost and extreme agility/HP.
    const spawnCheater=options.cheater!==undefined?!!options.cheater:random()<.5;
    if (spawnCheater && this.actors.length) {
      const cheater=this.actors[this.actors.length-1];
      Object.assign(cheater,{
        isCheater:true,name:'チーター',weapon:CHEATER_WEAPON,
        baseHp:220,maxHp:220,hp:220,tankMax:240,tank:240,
        agility:2.05,jumpFactor:1.42,regenFactor:2.4
      });
      this.hazards.alert='⚠ チーター出現！違法改造武器「オート英馬 II Super」＋CX10AI装備';
      this.hazards.alertUntil=8.5;
      this.events.unshift({label:'⚠ チーター出現（CX10・オート英馬 II Super）',team:-1,until:8.5});
    }
    this.hnv1=new HNV1(this);
    this.cheaterAI=new CheaterEngine(this);
    for (const actor of this.actors) {
      if (!actor.isPlayer) this.hnv1.mind(actor);
      if (actor.isCheater) this.cheaterAI.state(actor);
    }
    this.hnv1.mind(this.boss);
    this.hnv1.mind(this.hazards.goat);
    this.motion=new NpcMotion(this);
    this.perception=new NpcPerception(this);
    this.tactics=new Tactics(this);
  }

  // ebot: weaker copies of the caster that fight as ordinary crew until they
  // are splatted or their time runs out. They never respawn.
  addClone(owner,saved=null) {
    const used=new Set(this.actors.filter(a=>a.team===owner.team).map(a=>a.index));
    let index=this.teamSize;
    while (used.has(index)) index++;
    if (index>=MAX_TEAM_INDEX) return null;
    const clone=actorAt(owner.team,index,false,owner.weapon);
    const order=this.actors.filter(a=>a.cloneOf===owner).length+1;
    Object.assign(clone,{name:owner.name+'·e'+order,cloneOf:owner,clone:true,cloneUntil:this.clock+SUPERS.ebot.seconds,
      hp:EBOT.hp,maxHp:EBOT.hp,baseHp:EBOT.hp,damageFactor:EBOT.damage,paintFactor:EBOT.paint,subId:owner.subId,
      tank:owner.tankMax,tankMax:owner.tankMax,shield:.7,think:0});
    if (saved) Object.assign(clone,saved);
    this.hnv1.mind(clone);
    this.actors.push(clone);
    return clone;
  }

  summonClones(owner) {
    const [fx,,fz]=forward(owner.yaw), spots=[[1.25,-.2],[-1.25,-.2],[0,-1.5],[1.9,.9],[-1.9,.9],[0,1.6]];
    let made=0;
    for (const [side,ahead] of spots) {
      if (made>=EBOT.count) break;
      const x=stairCrossing(owner.x,owner.z,owner.x-fz*side+fx*ahead,owner.z+fx*side+fz*ahead,owner.y), z=owner.z+fx*side+fz*ahead;
      if (!sameLevel(x,owner.x)) continue;
      const floor=this.world.support(x,owner.y+.3,z);
      const probe={x,y:floor.y,z};
      if (Math.abs(floor.y-owner.y)>.6 || this.bodyBlocked(probe,.4,1.72) || !this.stage.canEnter(owner,x,floor.y,z) ||
          this.traceShot([owner.x,owner.y+.9,owner.z],[x,floor.y+.9,z],true)) continue;
      const clone=this.addClone(owner);
      if (!clone) break;
      Object.assign(clone,{x,y:floor.y,z,yaw:owner.yaw,bodyYaw:owner.yaw,pitch:owner.pitch,apartmentVisits:owner.apartmentVisits});
      this.burst([x,floor.y+.9,z],owner.team,14,3);
      this.abilities.rings.push({x,y:floor.y+.04,z,r:1.6,team:owner.team,until:this.clock+.55});
      made++;
    }
    // A cramped caster still gets its copies; they step out of the same spot.
    while (made<EBOT.count) {
      const clone=this.addClone(owner);
      if (!clone) break;
      Object.assign(clone,{x:owner.x,y:owner.y,z:owner.z,yaw:owner.yaw,bodyYaw:owner.yaw,pitch:owner.pitch,apartmentVisits:owner.apartmentVisits});
      made++;
    }
    return made;
  }

  retireClones() {
    for (let i=this.actors.length-1;i>=0;i--) {
      const clone=this.actors[i], owner=clone.cloneOf;
      if (!owner || clone.down<=0 && this.clock<clone.cloneUntil) continue;
      // The caster keeps the copy's turf on its record, without earning a super from it.
      owner.painted+=clone.painted;
      owner.countedPaint+=clone.painted;
      if (clone.down<=0) this.burst([clone.x,clone.y+.9,clone.z],clone.team,12,2.6);
      if (clone.drone) clone.drone.until=this.clock;
      this.tactics.states.delete(clone);
      this.perception.memory.delete(clone);
      for (const table of this.tactics.contacts) table.delete(clone);
      this.actors.splice(i,1);
      if (this.mode==='watch') {
        if (i<this.watching) this.watching--;
        else if (i===this.watching) {
          this.watching=Math.min(this.watching,this.actors.length-1);
          if (this.actors[this.watching].down>0) this.cycle();
        }
      }
    }
  }

  equipPlayer(weaponId,subId) {
    const actor=this.player, weapon=weaponById(weaponId), sub=subweaponById(subId);
    if (this.finished || !actor || weapon.id!==weaponId || sub.id!==subId ||
        actor.weapon===weapon && actor.subId===subId) return false;
    if (actor.weapon!==weapon) {
      if (actor.superUntil>this.clock && !actor.activeSpecial) actor.activeSpecial=actor.weapon.special;
      this.clearPlayerInput();
      const prevMax=actor.tankMax || BASE_TANK;
      const giga=this.chip?.owner===actor || !!actor.hasGiga || prevMax>=GIGA_TANK*(actor.weapon?.tankScale ?? 1)-1e-3;
      actor.weapon=weapon;
      const nextMax=(giga?GIGA_TANK:BASE_TANK)*(weapon.tankScale ?? 1);
      actor.tankMax=nextMax;
      actor.tank=Math.min(nextMax,actor.tank*(nextMax/prevMax));
      actor.recoil=0;
      actor.muzzleBlocked=false;
    }
    actor.subId=sub.id;
    return true;
  }

  clearPlayerInput() {
    const actor=this.player;
    if (actor) {
      actor.charge=actor.shotBuffer=actor.jumpBuffer=actor.rollHold=0;
      actor.driveX=actor.driveZ=0;
      actor.rolling=false;
      actor.rollUsed=false;
    }
  }

  pickupChip(actor) {
    const c=this.chip;
    if (c.owner || actor.ride || actor.lift || actor.down>0 || Math.abs(actor.y-c.y)>.77 || distance(actor,c)>.66) return false;
    c.owner=actor;
    actor.hasGiga=true;
    const scale=actor.weapon?.tankScale ?? 1;
    const nextMax=GIGA_TANK*scale;
    actor.tankMax=nextMax;
    actor.tank=Math.min(nextMax,actor.tank+BASE_TANK*scale);
    if (actor.isPlayer) this.callbacks.sound?.('drone');
    return true;
  }

  cabinTrain(x) {
    return zoneOf(x)===2?this.metro:this.transit;
  }

  transportService(actor) {
    const choices=[this.metro,this.transit].map(rail=>({rail,option:rail.option(actor)})).filter(choice=>choice.option);
    return choices.find(choice=>choice.option.kind!=='busy') ?? choices[0] ?? null;
  }

  transportOption(actor) {
    if (actor?.car) return this.vehicles?.option(actor) ?? null;
    const carOpt=this.vehicles?.option(actor) ?? null;
    const railOpt=this.transportService(actor)?.option ?? null;
    if (carOpt && (!railOpt || railOpt.kind==='busy')) return carOpt;
    return railOpt ?? carOpt;
  }

  useTransport(actor) {
    if (actor?.car) return this.vehicles?.use(actor) ?? false;
    const carOpt=this.vehicles?.option(actor) ?? null;
    const svc=this.transportService(actor);
    if (carOpt && (!svc || svc.option?.kind==='busy')) return this.vehicles.use(actor);
    return svc?.rail.use(actor) || (this.vehicles?.use(actor) ?? false);
  }

  carryTransit(actor,dt) {
    if (!actor.isPlayer && actor.ride && actor.rideFrom!==this.transit.train.stop) this.transit.use(actor);
    return this.transit.carry(actor,dt) || this.metro.carry(actor,dt);
  }

  cameraActor() {
    return this.player || this.actors[this.watching];
  }

  cycle() {
    const start=this.watching;
    for (let i=1;i<=this.actors.length;i++) {
      const next=(start+i)%this.actors.length;
      if (this.actors[next].down<=0) {
        this.watching=next;
        return;
      }
    }
  }

  bodyHit(start,end,actor,padding=0) {
    if (!actorInRay(actor,start,end,padding)) return null;
    let pose=this.crewShapes.get(actor);
    const form=actor.giant?3:actor.climbing?2:actor.swimming?1:0;
    if (!pose || pose.clock!==this.clock || pose.x!==actor.x || pose.y!==actor.y || pose.z!==actor.z || pose.yaw!==actor.yaw || pose.pitch!==actor.pitch ||
        pose.bodyYaw!==actor.bodyYaw || pose.brace!==actor.brace || pose.peek!==actor.peek || pose.form!==form) {
      pose={clock:this.clock,x:actor.x,y:actor.y,z:actor.z,yaw:actor.yaw,pitch:actor.pitch,bodyYaw:actor.bodyYaw,brace:actor.brace,peek:actor.peek,form,shapes:collectShapes(r=>{
        if (actor.isBoss) drawBossModel(r,actor,this.clock,true);
        else if (actor.isRaider) drawRaider(r,actor,this.clock,false);
        else drawCrew(r,actor,this.clock,false);
      })};
      this.crewShapes.set(actor,pose);
    }
    return traceShapes(pose.shapes,start,end,padding)?.t ?? null;
  }

  findActor(start,end,team,joined=true,padding=0) {
    const seam=joined && stairRay(start,end);
    if (seam) {
      const early=seam.t>0 && this.findActor(start,seam.point,team,false,padding);
      if (early) return {...early,t:early.t*seam.t};
      const offset=[seam.shift,0,0], late=seam.t<1 && this.findActor(add(seam.point,offset),add(end,offset),team,false,padding);
      return late?{...late,t:seam.t+(1-seam.t)*late.t,shift:seam.shift}:null;
    }
    let closest=null;
    for (const actor of this.actors) {
      if (actor.team===team || actor.down>0 || actor.shield>0 || actor.lift || actor.ride || actor.car || !sameLevel(actor.x,start[0])) continue;
      const t=this.bodyHit(start,end,actor,padding);
      if (t!==null && (!closest || t<closest.t)) closest={actor,t};
    }
    if (team>=0) for (const raider of this.raiders.members) {
      if (!raider.active || raider.shield>0 || raider.ride || raider.lift || !sameLevel(raider.x,start[0])) continue;
      const t=this.bodyHit(start,end,raider,padding);
      if (t!==null && (!closest || t<closest.t)) closest={actor:raider,t};
    }
    if (team>=0 && this.hazards) for (const target of this.hazards.targets(start[0])) {
      const dx=end[0]-start[0], dy=end[1]-start[1], dz=end[2]-start[2], len2=dx*dx+dy*dy+dz*dz;
      const cy=target.y+(target.isGoat?1.5:target.isHeli?1.05:target.isSniper?.95:0);
      const t=len2>1e-8?clamp(((target.x-start[0])*dx+(cy-start[1])*dy+(target.z-start[2])*dz)/len2,0,1):0;
      const px=start[0]+dx*t-target.x, py=start[1]+dy*t-cy, pz=start[2]+dz*t-target.z;
      const r=(target.radius??.55)+padding+(target.isGoat?.35:target.isHeli?.85:.18);
      const ry=target.isGoat?2.05+padding:target.isHeli?1.45+padding:target.isSniper?.95+padding:.52+padding;
      if (px*px+pz*pz<=r*r && Math.abs(py)<=ry && (!closest || t<closest.t)) closest={actor:target,t};
    }
    if (this.boss.active && sameLevel(this.boss.x,start[0])) {
      const t=this.bodyHit(start,end,this.boss,padding);
      if (t!==null && (!closest || t<closest.t)) closest={actor:this.boss,t};
    }
    return closest;
  }

  traceShot(start,end,precise=false,joined=true,clearance=0,ignoreCar=null) {
    const seam=precise && joined && stairRay(start,end);
    if (seam) {
      const early=seam.t>0 && this.traceShot(start,seam.point,true,false,clearance,ignoreCar);
      if (early) return {...early,t:early.t*seam.t};
      const offset=[seam.shift,0,0], late=seam.t<1 && this.traceShot(add(seam.point,offset),add(end,offset),true,false,clearance,ignoreCar);
      return late?{...late,t:seam.t+(1-seam.t)*late.t,shift:seam.shift}:null;
    }
    let best=precise?this.world.traceExact(start,end,clearance):this.world.trace(start,end);
    const object=this.stage.trace(start,end,clearance,best?.t);
    if (object && (!best || object.t<best.t)) best=object;
    const dyn=this.dynamicStage?.trace(start,end,clearance,best?.t);
    if (dyn && (!best || dyn.t<best.t)) best=dyn;
    const car=this.vehicles?.trace(start,end,clearance,best?.t,ignoreCar);
    if (car && (!best || car.t<best.t)) best=car;
    const tb=this.hazards?.traceTrainBoss?.(start,end,clearance,best?.t);
    if (tb && (!best || tb.t<best.t)) best=tb;
    const zone=zoneOf(start[0]);
    if (zone>=2) {
      if (sameLevel(start[0],end[0])) {
        const rail=this.cabinTrain(start[0]);
        if (!rail.cabinGlassAt || rail.cabinGlassAt!==rail.train || rail.cabinDoorAt!==rail.train.doorOpen || rail.cabinDoorSide!==rail.line.doorSide) {
          rail.cabinDoorShapes=collectShapes(r=>{
            drawCabinDoors(r,rail);
            drawCabinWindows(r,rail);
          });
          rail.cabinGlassAt=rail.train;
          rail.cabinDoorAt=rail.train.doorOpen;
          rail.cabinDoorSide=rail.line.doorSide;
        }
        const door=traceShapes(rail.cabinDoorShapes,start,end,clearance);
        if (door && (!best || door.t<best.t)) best=door.shape.windowId?{...door,cabinWindow:rail}:door;
      }
      return best;
    }
    const train0=this.transit.trace(start,end,precise,clearance);
    if (train0 && (!best || train0.t<best.t)) best=train0;
    const train1=this.metro.trace(start,end,precise,clearance);
    if (train1 && (!best || train1.t<best.t)) best=train1;
    return best;
  }

  aim(eye,dir,range=38) {
    const end=add(eye,scale(dir,range));
    let probe=end;
    if (zoneOf(eye[0])===0) {
      const horizon=add(eye,scale(dir,CITY_RADIUS*2+1));
      probe=add(eye,scale(sub(horizon,eye),shotFraction(eye,horizon)));
    }
    const wall=this.traceShot(eye,probe,true);
    return {position:wall && !wall.boundary?add(eye,scale(sub(probe,eye),wall.t)):end};
  }

  focusTarget(eye,dir,team,range) {
    const end=add(eye,scale(dir,range)), hit=this.findActor(eye,end,team);
    if (!hit) return null;
    const point=add(eye,scale(dir,hit.t*range));
    const wall=this.traceShot(eye,point,true);
    const curtain=this.subweapons.block(eye,point,team);
    return wall?.t<.999 || curtain?.t<.999?null:{...hit,point};
  }

  enemyFor(bot) {
    return this.perception.select(bot).enemy;
  }

  steer(actor,target,dt,speed=5.18,swim=false,pose={}) {
    const dx=target.x-actor.x,dz=target.z-actor.z,d=Math.hypot(dx,dz);
    const stride=Math.min(speed,Math.sqrt(Math.max(0,d-.045)*42));
    const vx=d>.045?dx/d*stride:0,vz=d>.045?dz/d*stride:0;
    if (actor.isPlayer) {
      this.drive(actor,vx,vz,dt,swim,!!pose.jump);
      return true;
    }
    this.motion.drive(actor,vx,vz,dt,{...pose,swim,emergency:pose.emergency || actor.intent==='爆発範囲から退避'});
    return true;
  }

  navigate(actor,target,dt,speed=5.18,swim=false,pose={}) {
    const zone=zoneOf(actor.x),nav=this.navs[zone],old=actor.travelGoal;
    const radius=actor.radius??.47, height=actor.height??1.68;
    const changed=!old || zoneOf(old.x)!==zone || distance(old,target)>.77;
    const stalled=(actor.stuck??0)>.24;
    let next=target;
    if (changed || this.clock>=(actor.travelAt??0) || stalled && !actor.travelObstacles) {
      actor.travelGoal={x:target.x,z:target.z};
      actor.travelAt=this.clock+(stalled?.62:1.21);
      actor.travelObstacles=stalled;
      const clear=nav.clear(actor,target,radius,height);
      const contacts=actor.team>=0?this.tactics.intelligence(actor,zone).filter(c=>c.fresh>.52):[];
      const startInk=this.paint.get(actor.x,actor.z,this.world.floor(actor.x,actor.z).layer);
      const endInk=this.paint.get(target.x,target.z,this.world.floor(target.x,target.z).layer);
      const mx=(actor.x+target.x)*.5, mz=(actor.z+target.z)*.5;
      const middleInk=this.paint.get(mx,mz,this.world.floor(mx,mz).layer);
      const enemyInk=2-actor.team;
      const hostile=actor.team>=0 && (startInk===enemyInk || endInk===enemyInk || middleInk===enemyInk);
      const useWeight=!clear && actor.team>=0 || hostile && distance(actor,target)>5;
      let weight=null;
      if (useWeight) {
        const wVal=nav._wVal, wStamp=nav._wStamp, cLen=contacts.length;
        let wGen=++nav._wGen;
        if (wGen===0) {wStamp.fill(0);wGen=nav._wGen=1;}
        const riskScale=actor.hp<65?.91:.33, paint=this.paint;
        weight=node=>{
          const ni=node.i;
          if (wStamp[ni]===wGen) return wVal[ni];
          const ink=paint.get(node.x,node.z,node.layer);
          let risk=0;
          for (let ci=0;ci<cLen;ci++) {
            const c=contacts[ci], d=Math.hypot(node.x-c.x,node.z-c.z);
            if (d<7.7) risk+=(1-d/7.7)*c.fresh;
          }
          const rScaled=risk*riskScale;
          const value=1+(ink===enemyInk?.48:0)+(rScaled<1.05?rScaled:1.05);
          wStamp[ni]=wGen;
          wVal[ni]=value;
          return value;
        };
      }
      let openAt=null;
      if (stalled) {
        const blocked=new Map(), probe={x:0,y:0,z:0,radius,height};
        openAt=node=>{
          if (distance(actor,node)>8) return true;
          const cached=blocked.get(node.i);
          if (cached!==undefined) return !cached;
          probe.x=node.x; probe.y=node.y+.028; probe.z=node.z;
          const occupied=this.stage.blocked(probe.x,probe.y,probe.z,radius,height) ||
            !this.stage.canEnter(actor,probe.x,probe.y,probe.z) || this.transit.blocksActor(probe) || this.metro.blocksActor(probe);
          blocked.set(node.i,occupied);
          return !occupied;
        };
      }
      actor.travelPath=clear && !weight && !openAt?null:nav.route(actor,nav.nearest(target,radius,height),radius,height,weight,openAt);
    }
    const path=actor.travelPath;
    if (path) {
      if (!path.length) return false;
      if (path.length>1 && distance(actor,path[0])<.67) path.shift();
      if (path.length>2 && !stalled && nav.clear(actor,path[1],radius,height) && distance(actor,path[1])<3.4) path.shift();
      next=path[0];
      if (path.length===1 && distance(actor,next)<.9 && nav.clear(actor,target,radius,height)) next=target;
    }
    const before={x:actor.x,z:actor.z};
    const locked=pose.jump || stalled && this.clock>(actor.npcJumpAt??0) && distance(actor,next)<2.45 && this.motion.canHop(actor,next.x,next.z);
    if (locked) actor.npcJumpAt=this.clock+1.6;
    this.steer(actor,next,dt,speed,swim,{...pose,jump:locked});
    actor.stuck=distance(actor,next)>.8 && distance(actor,before)<dt*.30?(actor.stuck??0)+dt:Math.max(0,(actor.stuck??0)-dt*1.5);
    return true;
  }

  npc(actor,dt) {
    const sight=this.perception.scan(actor,dt);
    this.hnv1.tick(actor,dt,sight);
    actor.enemy=sight.visible?sight.enemy:null;
    if (sight.visible && sight.at===this.clock) this.tactics.observe(actor,sight.enemy,sight.foot);
    this.tactics.crew(actor,actor.enemy,dt,sight);
  }

  surfaceInk(actor,surface) {
    if (!surface.raised && this.paint.hasSurface(actor.x,actor.z,surface.layer)) {
      return this.paint.get(actor.x,actor.z,surface.layer);
    }
    return this.wallOwner([actor.x,surface.y,actor.z],[0,1,0]);
  }

  inkPressure(actor,dt) {
    const floor=this.world.support(actor.x,actor.y,actor.z);
    const surf=this.surfaceInk(actor,floor);
    const bossUnder=zoneOf(actor.x)===1 && (this.fluid?.underBossDepth??0)>0.22 && actor.y<UNDER_Y+(this.fluid?.underBossDepth??0)+0.1;
    const hostile=!actor.ride && !actor.lift && ((actor.y<=floor.y+.08 && (surf===2-actor.team || surf===3)) || bossUnder);
    actor.inkExposure=hostile?Math.min(4.01,(actor.inkExposure??0)+dt):0;
    actor.inkPenalty=hostile?1+Math.floor(actor.inkExposure+1e-7):0;
  }

  drive(actor,vx,vz,dt,swim,jump) {
    const rate=actor.isCheater?62:(Math.abs(vx)+Math.abs(vz)>.12?24:30);
    const strength=1-Math.exp(-dt*rate);
    actor.driveX=mix(actor.driveX??0,vx,strength);
    actor.driveZ=mix(actor.driveZ??0,vz,strength);
    this.move(actor,actor.driveX,actor.driveZ,dt,swim,jump);
  }

  wallOwner(point,normal,shape=-1,grip=0) {
    const px=point[0], py=point[1], pz=point[2];
    const nx=normal[0], ny=normal[1], nz=normal[2];
    const minDot=grip?.95:.99, maxPlane=grip?.16:.095;
    const zone=zoneOf(px), decals=this.decals;
    for (let i=decals.length-1;i>=0;i--) {
      const mark=decals[i];
      if (!grip && shape>=0 && mark.shape>=0 && mark.shape!==shape) continue;
      const mn=mark.normal;
      if (mn[0]*nx+mn[1]*ny+mn[2]*nz<minDot) continue;
      const mp=mark.p;
      if (zoneOf(mp[0])!==zone) continue;
      const dx=px-mp[0], dy=py-mp[1], dz=pz-mp[2];
      const maxR=mark.radius*1.83+grip;
      if (dx*dx+dy*dy+dz*dz>maxR*maxR) continue;
      const plane=mn[0]*dx+mn[1]*dy+mn[2]*dz;
      if (plane>maxPlane || plane<-maxPlane) continue;
      const axes=mark._axes ?? (mark._axes=decalBasis(mn,mark.phase));
      const a0=axes[0], a1=axes[1];
      const invU=1/(mark.radius*1.66);
      const u=(dx*a0[0]+dy*a0[1]+dz*a0[2])*invU;
      const v=(dx*a1[0]+dy*a1[1]+dz*a1[2])/(mark.radius*1.35);
      if (Math.hypot(u,v)<=splatRadius(Math.atan2(v,u))+grip*invU) return mark.team+1;
    }
    return 0;
  }

  wallGrip(actor,direction,previous) {
    for (const height of [.42,.19,.68]) {
      const start=[actor.x,actor.y+height,actor.z], end=add(start,scale(direction,1.06));
      const hit=this.world.traceExact(start,end);
      if (!hit || Math.abs(hit.normal[1])>.30 || previous && dot(previous,hit.normal)<.57) continue;
      if (this.wallOwner(hit.position,hit.normal,hit.shape?.id,.12)===actor.team+1) return hit;
    }
    return null;
  }

  climb(actor,vx,vz,dt,wantsSwim,jump) {
    const old=actor.climbNormal;
    actor.climbNormal=null;
    actor.climbing=false;
    const pace=Math.hypot(vx,vz);
    if (!wantsSwim || actor.team<0 || actor.giant || actor.vy>3 || !old && pace<.56) return false;
    const direction=pace>.56?[vx/pace,0,vz/pace]:scale(old,-1);
    if (old && dot(direction,old)>.25) return false;
    const grip=this.wallGrip(actor,old?scale(old,-1):direction,old);
    if (!grip && old && pace>.56 && dot(direction,old)<-.24) {
      const x=actor.x-old[0]*.69,z=actor.z-old[2]*.69;
      const ledge=this.world.support(x,actor.y+.42,z);
      if (ledge.y>=actor.y-.12 && ledge.y<=actor.y+.42 && !this.world.blocked(x,ledge.y+.025,z,.36,.62) &&
          !this.stage.blocked(x,ledge.y+.025,z,.36,.62) && this.stage.canEnter(actor,x,ledge.y,z)) {
        const y=Math.max(actor.y,ledge.y)+.42;
        if (!this.world.traceExact([actor.x,y,actor.z],[x,y,z])) {
          const before={x:actor.x,y:actor.y,z:actor.z};
          actor.x=x;actor.z=z;actor.y=ledge.y;actor.vy=0;
          if (!actor.predicted) this.stage.visit(actor,before);
          actor.vx=actor.vz=0;
          actor.swimming=true;
          actor.inkSwimming=this.surfaceInk(actor,ledge)===actor.team+1;
          return true;
        }
      }
    }
    if (!grip) return false;
    const normal=unit([grip.normal[0],0,grip.normal[2]]);
    const before=[actor.x,actor.y,actor.z];
    actor.climbNormal=normal;
    actor.climbing=actor.swimming=actor.inkSwimming=true;
    actor.airborne=false;
    actor.landing=actor.vy=0;
    const into=-dot(direction,normal);
    const inset=clamp(-dot(sub(grip.position,before),normal)-.36,0,dt*5.8);
    const side=pace>.56?scale(add(direction,scale(normal,into)),dt*2.45):[0,0,0];
    this.stepActor(actor,side[0]-normal[0]*inset,side[2]-normal[2]*inset);
    const next=actor.y+(pace>.56?Math.max(.35,into)*4.85*dt:0);
    if (!this.world.blocked(actor.x,next+.018,actor.z,.33,.61) && !this.stage.blocked(actor.x,next+.018,actor.z,.33,.61)) actor.y=next;
    if (jump) {
      actor.climbing=actor.swimming=actor.inkSwimming=false;
      actor.airborne=true;
      actor.climbNormal=null;
      actor.vy=5.32;
      this.stepActor(actor,normal[0]*.36,normal[2]*.36);
    }
    actor.vx=(actor.x-before[0])/Math.max(.001,dt);
    actor.vz=(actor.z-before[2])/Math.max(.001,dt);
    actor.steps+=Math.max(0,actor.y-before[1])*4.25;
    return true;
  }

  stepActor(actor,dx,dz,boarding=false) {
    const bx=actor.x, by=actor.y, bz=actor.z;
    const motion=this.motion, stage=this.stage, vehicles=this.vehicles, isP=actor.isPlayer;
    this.world.step(actor,dx,dz,(x,y,z,radius,height)=>
      !stage.blocked(x,y,z,radius,height) && !vehicles?.blocked(x,y,z,radius,height,actor.car) && !this.hazards?.blocksTrainBoss?.(x,y,z,radius,height) && stage.canEnter(actor,x,y,z) &&
      (isP || motion.roomFor(actor,x,y,z,radius,height)));
    if (boarding && isP && !actor.predicted) {
      const before={x:bx,y:by,z:bz};
      if (this.transit.walkThrough(actor,before) || this.metro.walkThrough(actor,before)) return true;
    }
    const rOver=isP?undefined:(actor.radius??(actor.swimming?.33:.4))+.039;
    if (this.transit.blocksActor(actor,rOver) || this.metro.blocksActor(actor,rOver)) {
      actor.x=bx;actor.z=bz;actor.y=by;
    } else if (!actor.predicted && zoneOf(actor.x)===0) {
      this.stage.visit(actor,{x:bx,y:by,z:bz});
    }
    return false;
  }

  bodyBlocked(actor,radius,height) {
    return this.world.blocked(actor.x,actor.y+.018,actor.z,radius,height) ||
      this.stage.blocked(actor.x,actor.y+.018,actor.z,radius,height) ||
      !!this.vehicles?.blocked(actor.x,actor.y+.018,actor.z,radius,height,actor.car) ||
      !!this.hazards?.blocksTrainBoss?.(actor.x,actor.y+.018,actor.z,radius,height) ||
      this.transit.blocksActor(actor,radius,height) ||
      this.metro.blocksActor(actor,radius,height);
  }

  trainContact(actor,fromY,toY) {
    const zone=zoneOf(actor.x);
    if (zone>=2) return null;
    const hiY=fromY>toY?fromY:toY, loY=fromY<toY?fromY:toY;
    const ly0=this.transit.line.y, ly1=this.metro.line.y;
    const check0=zone===this.transit.section && hiY>=ly0-.05 && loY<=ly0+5.3;
    const check1=zone===this.metro.section && hiY>=ly1-.05 && loY<=ly1+5.3;
    if (!check0 && !check1) return null;
    const start=[actor.x,fromY,actor.z], end=[actor.x,toY,actor.z];
    const first=check0?this.transit.trace(start,end):null;
    const second=check1?this.metro.trace(start,end):null;
    return first && (!second || first.t<second.t)?first:second;
  }

  actorSupport(actor) {
    let floor=this.stage.support(actor.x,actor.y,actor.z,this.world.support(actor.x,actor.y,actor.z));
    if (this.vehicles) floor=this.vehicles.support(actor.x,actor.y,actor.z,floor);
    const roof=this.trainContact(actor,actor.y+.10,actor.y-.10);
    return roof?.normal[1]>.54 && roof.position[1]>floor.y?{...floor,y:roof.position[1],raised:true}:floor;
  }

  downwardSurface(x,y,z) {
    const ground=this.world.floor(x,z);
    const hit=this.traceShot([x,Math.max(y,ground.y)+.14,z],[x,ground.y-.15,z],true,false);
    if (!(hit?.t>1e-6 && hit.normal[1]>.54)) return null;
    if (hit.layer===ground.layer && Math.abs(hit.position[1]-ground.y)<.045) {
      return {...hit,position:[x,ground.y,z]};
    }
    return hit;
  }

  move(actor,vx,vz,dt,wantsSwim,jump) {
    if (this.climb(actor,vx,vz,dt,wantsSwim,jump)) return;
    const wasAirborne=actor.airborne;
    const surface=this.actorSupport(actor);
    const grounded=actor.y<=surface.y+.065 && actor.vy<=0;
    const owner=this.surfaceInk(actor,surface);
    actor.coyote=grounded?.092:Math.max(0,actor.coyote-dt);
    actor.jumpBuffer=jump?.14:Math.max(0,actor.jumpBuffer-dt);
    const needsClearance=!actor.giant && grounded && actor.swimming && this.bodyBlocked(actor,.4,1.72);
    actor.swimming=!actor.giant && grounded && (needsClearance || wantsSwim && (owner===0 || owner===actor.team+1));
    const hostile=grounded && owner && owner!==actor.team+1;
    const resistance=hostile?.88-.037*Math.max(0,(actor.inkPenalty??1)-1):1;
    const flooded=this.hazards?.underFlood?.active && zoneOf(actor.x)===1 && actor.y<UNDER_Y+this.hazards.underFlood.depth-.1;
    const speed=(actor.giant && !actor.isRaider?1.67:actor.swimming?(owner===actor.team+1?1.98:1.06):1)*resistance*
      (actor.giant?1:actor.weapon?.weight??1)*(actor.agility??1)*(flooded?.72:1);
    const x=localX(actor.x),z=actor.z,zone=zoneOf(actor.x);
    if (actor.jumpBuffer>0 && actor.coyote>0 && !needsClearance) {
      actor.vy=(actor.swimming?6.45:6.05)*(actor.jumpFactor??1);
      actor.swimming=false;
      actor.jumpBuffer=actor.coyote=0;
    }
    if (this.stepActor(actor,vx*speed*dt,vz*speed*dt,true)) return;
    const floor=this.actorSupport(actor);
    let ground=floor.y;
    if (grounded && actor.vy<=0 && surface.stair && surface.stair===floor.stair) {
      actor.y=ground;
      actor.vy=0;
    } else if (actor.y>ground+.02 || actor.vy>0) {
      actor.vy-=17.9*dt;
      let next=actor.y+actor.vy*dt;
      if (actor.vy>0) {
        const height=actor.height??1.70;
        const ceiling=this.trainContact(actor,actor.y+height-.015,next+height+.018);
        const radius=actor.radius??.39;
        if (ceiling?.normal[1]<-.54 || this.world.blocked(actor.x,next+.018,actor.z,radius,height) ||
            this.stage.blocked(actor.x,next+.018,actor.z,radius,height)) {
          next=actor.y;
          actor.vy=0;
        }
      } else {
        const bottom=Math.max(next,ground);
        if (bottom<actor.y+.06) {
          const roof=this.trainContact(actor,actor.y+.06,bottom);
          if (roof?.normal[1]>.54) ground=Math.max(ground,roof.position[1]);
        }
      }
      actor.y=Math.max(next,ground);
      if (next<=ground) actor.vy=0;
    } else {
      actor.y=ground;
      actor.vy=0;
    }
    actor.airborne=actor.y>ground+.12 || actor.vy>.15;
    actor.landing=wasAirborne && !actor.airborne?1:Math.max(0,(actor.landing??0)-dt*7.2);
    if (zone!==zoneOf(actor.x)) {
      actor.stairsUsed=(actor.stairsUsed??0)+1;
      actor.enemy=null;
      actor.route=[];
      actor.travelGoal=null;
    }
    actor.inkSwimming=actor.swimming && this.surfaceInk(actor,floor)===actor.team+1;
    actor.vx=(localX(actor.x)-x)/Math.max(.001,dt);
    actor.vz=(actor.z-z)/Math.max(.001,dt);
    actor.steps+=Math.hypot(actor.vx,actor.vz)*dt*1.93;
    if (actor.inkSwimming && !floor.raised && !actor.predicted) {
      actor.swimFX-=dt;
      if (actor.swimFX<=0 && Math.hypot(actor.vx,actor.vz)>.65) {
        actor.swimFX=.095;
        this.paint.kick(actor.x,actor.z,floor.layer,actor.vx,actor.vz);
      }
    }
  }

  // The movement half of the controls. The Cloudflare client runs the same
  // step ahead of the server to show the player's own motion without delay.
  walk(a,input,dt) {
    const [sx,,sz]=forward(input.yaw), nx=-sz, nz=sx;
    const m=Math.max(1,Math.hypot(input.x,input.z));
    const pace=(input.z<0?PLAYER_PACE.back:PLAYER_PACE.forward)*(a.beaming?.63:a.weapon.roller && input.fire && a.rollHold>.19?.78:1);
    this.drive(a,(nx*input.x+sx*input.z)*pace/m,(nz*input.x+sz*input.z)*pace/m,dt,
      input.swim && !input.fire && !input.press && !input.sub,input.jump);
  }

  control(a,input,dt,camera) {
    const startedInCabin=isCabin(a.x);
    const pendingShot=a.charge>0 || a.shotBuffer>0 || a.rollHold>0;
    a.yaw=input.yaw;
    a.pitch=input.pitch;
    this.walk(a,input,dt);
    if (startedInCabin!==isCabin(a.x)) return;
    if (input.fire || input.press || pendingShot || a.beaming) {
      const view=typeof camera==='function'?camera():camera;
      const dir=unit(sub(view.target,view.eye));
      this.playerAim=this.aim(view.eye,dir,Math.hypot(...floorBounds(view.eye[0]))*2+12);
    }
    if (input.sub) this.subweapons.use(a,input.yaw,input.pitch);
    // SW OUT II: CO mode trades fire rate for twice the tracking.
    if (input.co && a.weapon.coMode) a.coMode=!a.coMode;
    const weapon=a.weapon;
    if (a.giant || a.beaming) return;
    if (weapon.roller) {
      if (input.fire && !a.swimming) {
        if (a.airborne) {
          a.rollUsed=this.shoot(a,this.playerAim.position) || a.rollUsed;
          a.rollHold=0;
          a.rolling=false;
        } else {
          a.rollHold+=dt;
          if (a.rollHold>=.20 && this.roll(a)) a.rollUsed=true;
        }
      } else {
        if (input.press || a.rollHold>0 && !a.rollUsed) this.shoot(a,this.playerAim.position);
        a.rollHold=0;
        a.rollUsed=false;
        a.rolling=false;
      }
      return;
    }
    if (weapon.charge) {
      if ((input.fire || input.press) && !a.swimming && a.tank+INK_EPSILON>=weapon.cost && a.fire<=0) {
        a.charge=Math.min(1,a.charge+dt/weapon.charge);
      } else if (a.charge>0 && !input.fire) {
        if (!a.swimming) this.shoot(a,this.playerAim.position,.27+.73*a.charge);
        a.charge=0;
      } else if (a.swimming) {
        a.charge=0;
      }
    } else {
      a.shotBuffer=input.press?.16:Math.max(0,a.shotBuffer-dt);
      if ((input.fire || a.shotBuffer>0) && this.shoot(a,this.playerAim.position)) a.shotBuffer=0;
    }
  }

  muzzle(a) {
    const launch=this.weaponLaunch(a)[0];
    return launch.hit || launch.crossesStair?launch.origin:launch.tip;
  }

  weaponLaunch(actor) {
    const origin=[actor.x,actor.y+(actor.weapon.roller?1.48:1.30)-(actor.brace??0)*.36,actor.z];
    const pose=crewPose(actor,this.clock);
    let tips;
    if (actor.weapon.roller) {
      const {y,z}=rollerPosition(actor);
      tips=[pose.loc(0,y,z+.318)];
    } else if (actor.isRaider) {
      tips=[pose.loc(-.39,1.26,.79)];
    } else {
      const gun=gunPose(actor,pose);
      tips=actor.weapon.id==='dual'?[-1,1].map(side=>gun.at(-.415+side*.13,1.30,1.034)):
        [gun.at(-.415,1.30,.746+gun.barrel*.85)];
    }
    return tips.map(tip=>{
      const hit=this.traceShot(origin,tip,true);
      const position=hit?hit.position:stairEnd(origin,tip);
      return {origin,tip,hit,position,crossesStair:!sameLevel(tip[0],position[0])};
    });
  }

  roll(a,onlyNew=false) {
    if (!a.weapon.roller || a.down>0 || a.swimming || a.airborne || a.giant || a.beaming || a.slam || a.ride || a.lift ||
        Math.hypot(a.vx,a.vz)<.55) return false;
    const [dx,,dz]=forward(a.yaw), frontX=a.x+dx*.84, z=a.z+dz*.84;
    const x=stairCrossing(a.x,a.z,frontX,z,a.y);
    const floor=this.world.support(x,a.y+.18,z);
    if (Math.abs(floor.y-a.y)>.33 || this.traceShot([a.x,a.y+.35,a.z],[frontX,a.y+.35,z],true)) return false;
    if (onlyNew && !floor.raised && this.paint.get(x,z,floor.layer)===a.team+1) return false;
    if (a.tank+INK_EPSILON<a.weapon.cost) return false;
    a.rolling=true;
    if (a.fire>0) return true;
    for (const lane of [-1,0,1]) {
      const offset=lane*.58*PAINT_RADIUS_FACTOR;
      const rawX=frontX-dz*offset, pz=z+dx*offset;
      const px=stairCrossing(a.x,a.z,rawX,pz,a.y);
      const hit=this.traceShot([px,a.y+.48,pz],[px,a.y-.25,pz],true,false);
      if (!hit || hit.normal[1]<.54 || this.traceShot([a.x,a.y+.38,a.z],[rawX,a.y+.38,pz],true)) continue;
      if (this.paint.hasSurface(px,pz,hit.layer)) a.painted+=this.paint.stampGround(px,pz,.65*PAINT_RADIUS_FACTOR*(a.paintFactor??1),a.team,hit.layer,0,.046);
      else this.splat(hit,{actor:a,weapon:a.weapon,paint:a.paintFactor},.46);
    }
    this.abilities.area(a,x,a.y+.25,z,1.05,76*(a.damageFactor??1),undefined,true);
    a.tank=Math.max(0,a.tank-a.weapon.cost);
    a.fire=.18;
    a.heat=.51;
    if (a.isPlayer) this.callbacks.sound?.('shot');
    this.callbacks.cue?.('roll',a);
    return true;
  }

  // TD: one wide blast that fans ink across the floor ahead and hits every
  // opponent inside the cone, pushing the survivors back.
  blast(actor,target,launches) {
    const weapon=actor.weapon, {reach,half}=weapon.blast, launch=launches[0];
    const start=launch.hit || launch.crossesStair?launch.origin:launch.tip;
    const aim=unit(sub(target,start)), yaw=Math.atan2(aim[0],-aim[2]), flat=Math.hypot(aim[0],aim[2]);
    const range=reach*(actor.rangeFactor??1), team=actor.team;
    const damage=weapon.damage*(actor.damageFactor??1), paint=actor.paintFactor??1;
    for (const u of [-1,-.5,0,.5,1]) {
      const [dx,,dz]=forward(yaw+u*half), direction=unit([dx*Math.max(.35,flat),aim[1],dz*Math.max(.35,flat)]);
      const end=add(start,scale(direction,range)), wall=this.traceShot(start,end,true);
      const length=range*(wall?.t??1);
      for (const part of [.28,.6,.92]) {
        const along=length*part;
        if (along<.9) continue;
        const point=stairEnd(start,add(start,scale(direction,along)));
        const ground=this.downwardSurface(point[0],point[1],point[2]);
        if (ground && point[1]-ground.position[1]<3.4) this.abilities.paintSurface(actor,ground,weapon.radius*paint*(.78+part*.5),weapon.depth);
      }
      if (wall && !wall.boundary) this.splat(wall,{actor,weapon,power:.7,paint,structureDamage:damage*.5});
    }
    const shift=stairNeighborShift(start[0],start[2],range), targets=this.abilities.enemies(actor,start[0]);
    if (shift) targets.push(...this.abilities.enemies(actor,start[0]+shift));
    const screened=new Set();
    for (const enemy of targets) {
      const other=!sameLevel(enemy.x,start[0]);
      const point=[enemy.x,enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.86),enemy.z];
      const local=[point[0]-(other?shift:0),point[1],point[2]], delta=sub(local,start), gap=Math.hypot(...delta);
      if (gap>range+(enemy.isBoss?1.3:0) || gap>.9 && dot(delta,aim)/gap<Math.cos(half+.14)) continue;
      if (other && !stairRay(start,local) || this.traceShot(start,local,true)?.t<.96) continue;
      const curtain=this.subweapons.block(start,local,team);
      if (curtain) {
        if (!screened.has(curtain.item)) curtain.item.hp-=damage*.55;
        screened.add(curtain.item);
        continue;
      }
      const lost=this.inkHit(enemy,damage*(1-.45*Math.min(1,gap/range)),actor,point);
      if (lost && !enemy.isBoss && enemy.down<=0) {
        const flatGap=Math.max(.3,Math.hypot(delta[0],delta[2]));
        this.stepActor(enemy,delta[0]/flatGap*.95,delta[2]/flatGap*.95);
      }
    }
    const [fx,,fz]=forward(yaw), middle=[start[0]+fx*range*.55,start[1],start[2]+fz*range*.55];
    this.stage.damageArea(this,actor,middle[0],middle[1]-.6,middle[2],range*.55,damage*.6);
    this.damageMetro(middle[0],middle[1],middle[2],range*.5,damage*.4);
    const floor=this.world.support(actor.x,actor.y,actor.z).y;
    this.abilities.rings.push({x:start[0],y:Math.max(floor,actor.y)+.05,z:start[2],r:range,team,until:this.clock+.46,span:.46,yaw,half});
    for (let i=0;i<30;i++) {
      const [dx,,dz]=forward(yaw+(this.rng()-.5)*2*half), speed=5+this.rng()*12, life=.26+this.rng()*.34;
      this.drops.push({p:start.slice(),v:[dx*speed,aim[1]*speed+1.2+this.rng()*3.2,dz*speed],life,max:life,team,size:.07+this.rng()*.16,wet:0});
    }
    if (this.drops.length>630) this.drops.splice(0,this.drops.length-630);
    actor.tank=Math.max(0,actor.tank-weapon.cost);
    actor.fire=actor.isPlayer?weapon.delay:weapon.delay+this.rng()*.12;
    actor.heat=.6;
    actor.recoil=1;
    actor.muzzleBlocked=!!launch.hit;
    this.perception.fire(actor);
    if (actor.isPlayer) this.callbacks.sound?.('blast');
    this.callbacks.cue?.('blast',actor);
    return true;
  }

  shoot(actor,target,power=1) {
    const weapon=actor.weapon;
    if (actor.fire>0 || actor.tank+INK_EPSILON<weapon.cost || actor.swimming || actor.down>0 || actor.giant || actor.beaming || actor.ride || actor.lift || actor.slam) return false;
    const launches=this.weaponLaunch(actor);
    if (weapon.blast) return this.blast(actor,target,launches);
    const start=launches.length===2?scale(add(launches[0].tip,launches[1].tip),.5):launches[0].tip;
    const delta=sub(target,start);
    const horizontal=Math.hypot(delta[0],delta[2]);
    const travel=shotTravel(weapon,horizontal,actor.rangeFactor,power);
    const gamma=this.fluid?this.fluid.projectileDragGamma(weapon):0;
    const ex=gamma*travel;
    const kInv=gamma>1e-5?gamma/Math.max(1e-6,1-Math.exp(-ex)):1/travel;
    const vy0=gamma>1e-5?(delta[1]+(weapon.gravity/gamma)*travel)*kInv-(weapon.gravity/gamma):(delta[1]+.5*weapon.gravity*travel*travel)/travel;
    const central=[delta[0]*kInv,vy0,delta[2]*kInv];
    const lateral=unit(cross(central,[0,1,0]));
    const force=Math.hypot(...central);
    // SW OUT pistols: a shot at a locked-on enemy follows it. The guidance
    // costs extra ink on SW OUT; without enough ink the shot flies plain.
    const co=!!(weapon.coMode && actor.coMode);
    let locked=weapon.autoAim?this.lockedEnemy(actor,start,target,weapon.autoAim.reach):null;
    if (locked && actor.tank+INK_EPSILON<weapon.cost*weapon.autoAim.ink) locked=null;
    // OM Bomb: every round tracks. OM BOMB II fires each round twice at half power.
    const special=actor.superUntil>this.clock?actor.activeSpecial:null;
    const tracking=special==='om' || special==='om2', twin=special==='om2';
    const strength=(actor.damageFactor??1)*(twin?.5:1), paint=actor.paintFactor??1;
    for (let copy=0;copy<(twin?2:1);copy++) for (let i=0;i<weapon.pellets;i++) {
      const fan=weapon.pellets>1?(i/(weapon.pellets-1)-.5):this.rng()-.5;
      const v=add(central,scale(lateral,force*weapon.spread*fan));
      v[1]+=(this.rng()-.5)*force*weapon.spread*.25;
      if (twin) {
        const offset=force*.021*(copy?1:-1);
        v[0]+=lateral[0]*offset;
        v[1]+=force*.012*(copy?1:-1);
        v[2]+=lateral[2]*offset;
      }
      const bend=weapon.swirl?scale(lateral,(this.rng()>.5?1:-1)*weapon.swirl):null;
      const launch=launches[i%launches.length], shot={pos:launch.position.slice(),vel:v,actor,weapon,power,age:0,bend};
      if (tracking) shot.homing={...OM_HOMING};
      if (weapon.homing) shot.homing={...weapon.homing};
      if (locked) {
        const {turn,cone,reach}=weapon.autoAim;
        shot.homing={turn:turn*(co?weapon.coMode.turn:1),cone,reach,target:locked};
      }
      if (strength!==1) shot.dmg=strength;
      if (paint!==1) shot.paint=paint;
      if (!this.impactShot(shot,launch.origin,launch.tip,launch.hit)) {
        shot.id=++this.shotSequence;
        this.shots.push(shot);
      }
    }
    actor.tank=Math.max(0,actor.tank-weapon.cost*(locked?weapon.autoAim.ink:1));
    actor.autoAimAt=locked?this.clock:actor.autoAimAt;
    const delay=weapon.delay*(co?weapon.coMode.delay:1);
    actor.fire=actor.isPlayer?delay:actor.isCheater?delay*.9:Math.max(.18,delay)+(weapon.charge?.30:.0)+this.rng()*.085;
    actor.heat=.51;
    actor.recoil=1;
    actor.muzzleBlocked=launches.every(launch=>!!launch.hit);
    this.perception.fire(actor);
    if (actor.isPlayer) this.callbacks.sound?.(weapon.id==='lob'?'lob':'shot');
    this.callbacks.cue?.('shot',actor);
    return true;
  }

  burst(point,team,count,power,wet=0) {
    for (let i=0;i<count;i++) {
      const angle=this.rng()*TAU, v=(.26+this.rng()*.74)*power;
      const life=.29+this.rng()*.48;
      this.drops.push({p:point.slice(),v:[Math.cos(angle)*v,(.38+this.rng())*power,Math.sin(angle)*v],
        life,max:life,team,size:.042+this.rng()*.136,wet});
    }
    if (this.drops.length>630) this.drops.splice(0,this.drops.length-630);
  }

  coat(hit,team,radius,phase,volume=0) {
    this.decals.push({p:add(hit.position,scale(hit.normal,.023)),normal:hit.normal,team,phase,radius,
      shape:hit.shape?.id??-1,id:++this.decalSequence,volume});
    if (this.decals.length>310) this.decals.shift();
  }

  splat(hit,shot,scaleSize=1) {
    if (hit.boundary) return;
    const p=hit.position, team=shot.actor.team, weapon=shot.weapon ?? shot.actor.weapon;
    const size=weapon.radius*(.88+this.rng()*.23)*scaleSize*1.26*(shot.power??1)*(shot.paint??1);
    const force=(weapon.damage??0)*(shot.power??1)*(shot.dmg??1);
    const phase=this.rng()*TAU;
    if (shot.vel && (shot.actor.isPlayer || this.mode==='watch') && !this.inkImpacts.some(mark=>
      mark.normal && mark.at===this.clock && mark.team===team && Math.hypot(...sub(mark.p,p))<.70)) {
      this.addInkImpact({p,team,normal:hit.normal});
    }
    if (hit.cabinWindow) {
      const amount=shot.structureDamage ?? force;
      hit.cabinWindow.hitWindow(hit.shape.windowId,amount);
      hit.cabinWindow.damage(amount*.095);
    } else if (hit.trainBoss) {
      const amount=force;
      this.hazards?.hurtTrainBoss?.(this.hazards.trainBossRail(),amount,shot.actor);
    } else if (hit.train) {
      const amount=force;
      if (hit.train.train.berserk && this.hazards) this.hazards.hurtTrainBoss(hit.train,amount,shot.actor);
      hit.train.splatter(hit,team,size,shot.structureDamage??amount*.095,shot.structureDamage??amount);
    } else if (hit.vehicle) {
      const damage=shot.structureDamage ?? force;
      this.vehicles?.damageCar(hit.vehicle,damage,shot.actor,p);
    } else if (hit.stageObject) {
      const damage=shot.structureDamage ?? force;
      this.stage.strike(hit.stageObject,damage,this.clock,team);
    } else if (team<0) {
      this.burst(add(p,scale(hit.normal,.027)),team,5,1.6);
      return;
    } else {
      const field=this.paint.hasSurface(p[0],p[2],hit.layer);
      if (field) {
        shot.actor.painted+=this.paint.stampGround(p[0],p[2],size,team,hit.layer,phase,weapon.depth);
        if (shot.vel) this.paint.kick(p[0],p[2],hit.layer,shot.vel[0]*.38,shot.vel[2]*.38);
      } else if (hit.shape) {
        const radius=size*surfacePaintRadius(hit.normal);
        const volume=Math.abs(hit.normal[1])<.54?radius**2*(weapon.depth??.035)*.018:0;
        this.coat(hit,team,radius,phase,volume);
      }
      if (team>=0) {
        this.stage?.strikeAt?.(p[0],p[1],p[2],shot.structureDamage??force,team,Math.max(1.1,size),{
          fx:shot.vel?.[0]??0,fy:shot.vel?.[1]??0,fz:shot.vel?.[2]??0
        });
      }
    }
    this.fluid?.splatFluidImpulse(p[0],p[2],shot.vel?.[0]??0,shot.vel?.[2]??0,Math.max(.5,size),team);
    this.burst(add(p,scale(hit.normal,.027)),team,weapon.pellets>1?3:Math.round(6+size*2.4),1.95+size*.74,hit.layer===undefined?0:.009+size*.007);
  }

  damageMetro(x,y,z,radius,amount,source=null) {
    if (isCabin(x)) return this.cabinTrain(x).damage(amount*.31);
    let lost=0;
    const tb=this.hazards?.trainBoss;
    if (tb?.active && tb.stageMode && sameLevel(x,tb.x)) {
      const dist=Math.hypot(x-tb.x,z-tb.z);
      if (dist<=radius+8.5 && Math.abs(y-tb.y)<4.8) {
        lost+=this.hazards.hurtTrainBoss(this.hazards.trainBossRail(),amount*.72,source);
      }
    }
    for (const rail of [this.transit,this.metro]) {
      if (!rail.visibleIn(zoneOf(x))) continue;
      const {line,train}=rail, center=line.center+train.x;
      const nearX=clamp(x,center-9.05,center+9.05), nearZ=clamp(z,line.z+train.lateral-1.6,line.z+train.lateral+1.6);
      if (Math.hypot(x-nearX,z-nearZ)>radius || Math.abs(y-line.y)>4.4) continue;
      const hit=this.traceShot([x,y+.48,z],[nearX,line.y+2.1,nearZ],true);
      if (!hit || hit.train===rail) {
        if (rail.train.berserk && this.hazards) lost+=this.hazards.hurtTrainBoss(rail,amount*.62,source);
        else lost+=rail.damage(amount*.62);
      }
    }
    return lost;
  }

  damage(actor,baseDamage,source,point,cause=null) {
    const reduced=cause==='drown'?baseDamage:baseDamage*DAMAGE_SCALE*(source && !source.isPlayer ? .91 : 1);
    // A copy fights on its caster's record.
    const credit=source?.cloneOf ?? source;
    if (actor.isGoat || actor.isBoss || actor.isRaider || actor.isSniper || actor.isRogueDrone || actor.isHeli) {
      const lost=actor.isGoat?this.hazards.hurtGoat(reduced,credit):actor.isHeli?this.hazards.hurtHeli(reduced,credit):
        actor.isBoss?this.boss.hurt(reduced):actor.isRaider?this.raiders.hurt(actor,reduced,credit):
        actor.isSniper?this.hazards.hurtSniper(actor,reduced,credit):this.hazards.hurtDrone(actor,reduced,credit);
      if (lost && source && source.team>=0) {
        source.superCharge=Math.min(100,source.superCharge+lost*.25*chargeGain(source));
        credit.dealt=(credit.dealt??0)+lost;
        this.burst(point,source.team,5,2.14);
        if (source.isPlayer) this.callbacks.sound?.('hit');
        this.callbacks.cue?.(actor.isBoss?'hit':actor.active?'hit':'down',actor,source);
      }
      return lost;
    }
    if (actor.down>0 || (actor.shield>0 && cause!=='drown' && cause!=='carBomb') || actor.lift || actor.ride) return 0;
    const lost=Math.min(actor.hp,cause==='drown'?reduced:this.abilities.reduce(actor,reduced));
    if (!(lost>0)) return 0;
    actor.hp-=lost;
    actor.damageAge=0;
    actor.lastDamageAt=this.clock;
    if (source && source.team>=0) source.superCharge=Math.min(100,source.superCharge+lost*.36*chargeGain(source));
    if (credit && credit.team>=0) credit.dealt=(credit.dealt??0)+lost;
    if (source?.isPlayer) this.callbacks.sound?.('hit');
    if (actor.isPlayer) this.callbacks.sound?.('damage');
    this.burst(point,source?.team ?? -1,6,2.41);
    if (actor.hp>0) {
      this.callbacks.cue?.('hit',actor,source);
      return lost;
    }
    if (actor.car) this.vehicles?.exit(actor,true);
    const drown=cause==='drown', trainBoss=cause==='trainBoss', goat=cause==='goat' || !!source?.isGoat;
    const heli=cause==='heli' || !!source?.isHeli;
    const carRam=cause==='car', carBomb=cause==='carBomb';
    const boss=cause==='boss' || (!source && !drown && !trainBoss && !goat && !heli && !carRam && !carBomb);
    actor.down=actor.cloneOf?Infinity:(boss || trainBoss || goat || heli)?BOSS_RESPAWN_SECONDS:RESPAWN_SECONDS;
    actor.downBy=drown?'drown':goat?'goat':heli?'heli':trainBoss?'trainBoss':carBomb?'carBomb':carRam?'car':boss?'boss':source?.isRaider?'raid':(source?.isSniper || source?.isRogueDrone)?'hazard':'crew';
    actor.swimming=actor.inkSwimming=actor.climbing=false;
    actor.downs++;
    this.abilities.clearSuper(actor);
    if (actor.cloneOf) actor.maxHp=actor.baseHp??actor.maxHp;
    if (source && source.team>=0) {
      // Splatting a copy is not an elimination: it earns no kill and no EXP.
      if (!actor.cloneOf && actor!==source) credit.kills++;
      const {x,y,z}=actor, floor=this.world.floor(x,z);
      const hit=this.traceShot([x,Math.max(y,floor.y)+.12,z],[x,floor.y-.13,z],true,false);
      if (hit) this.splat(hit,{actor:source,weapon:WEAPONS[0]},1.43);
    }
    this.burst([actor.x,actor.y+1.05,actor.z],source?.team ?? -1,actor.cloneOf?12:26,actor.cloneOf?3.1:4.4);
    this.abilities.rings.push({x:actor.x,y:actor.y+.06,z:actor.z,r:2.6,team:Math.max(0,source?.team??actor.team),until:this.clock+.55});
    const killer=drown?'水没・溺死':goat?'破壊神ゴート':heli?(this.hazards?.heli?.name ?? '暴走ミサイルヘリ'):trainBoss?(this.hazards?.trainBoss?.name ?? '暴走列車'):
      carBomb?(source?source.name+' [車爆破]':'車の爆発'):carRam?(source?source.name+' [車]':'車'):(source?.name ?? this.boss.name);
    this.events.unshift({label:killer+'  ▸  '+actor.name,team:source?.team ?? -1,until:this.clock+3.4});
    this.events.length=Math.min(this.events.length,4);
    if (source?.isPlayer) this.callbacks.sound?.('down');
    this.callbacks.cue?.('down',actor,source);
    return lost;
  }

  // Every body hit leaves a flash: the player's own hits (kind 1, 2 for a
  // splat) large and from any range, everyone else's (kind 3) smaller.
  inkHit(target,damage,source,point) {
    const lost=this.damage(target,damage,source,point);
    const team=source.team;
    if (lost>0) {
      const mine=source.isPlayer || source.cloneOf?.isPlayer || this.mode==='watch';
      const finished=target.isGoat || target.isHeli || target.isBoss || target.isRaider || target.isSniper || target.isRogueDrone?!target.active:target.down>0;
      const kind=mine?finished?2:1:3;
      const prior=this.inkImpacts.find(hit=>hit.at===this.clock && hit.target===target && hit.team===team);
      if (prior) prior.kind=prior.kind===3 || kind===3?Math.min(prior.kind,kind):Math.max(prior.kind??1,kind);
      else this.addInkImpact({p:point,team,target,kind});
      if (finished) {
        this.burst(point,team,18,5.6,.016);
        this.abilities.rings.push({x:point[0],y:(target.y??point[1])+.08,z:point[2],r:3.4,team:Math.max(0,team),until:this.clock+.52});
      } else if (mine) {
        this.burst(point,team,5,3.2,.010);
      }
    }
    return lost;
  }

  addInkImpact(impact) {
    this.inkImpacts.push({...impact,at:this.clock});
    if (this.inkImpacts.length>48) this.inkImpacts.shift();
  }

  impactShot(shot,from,to,wall=this.traceShot(from,to,true)) {
    const tolerance=clamp(shot.weapon.size*.36,.055,.115);
    const actor=this.findActor(from,to,shot.actor.team,true,tolerance);
    const curtain=this.subweapons.block(from,to,shot.actor.team);
    if (curtain && (!wall || curtain.t<wall.t) && (!actor || curtain.t<actor.t)) {
      curtain.item.hp-=shot.weapon.damage*shot.power*(shot.dmg??1);
      this.burst(curtain.p,shot.actor.team,4,1.7);
    } else if (actor && (!wall || actor.t<wall.t)) {
      const point=add(from,scale(sub(to,from),actor.t));
      point[0]+=actor.shift??0;
      this.inkHit(actor.actor,shot.weapon.damage*shot.power*(shot.dmg??1),shot.actor,point);
    } else if (wall) this.splat(wall,shot);
    else return false;
    return true;
  }

  // The enemy a shot is locked on to: the one standing on the line from the
  // muzzle to the aim point, within its own body width, inside reach.
  lockedEnemy(actor,start,target,reach) {
    const aim=sub(target,start), length=Math.hypot(...aim);
    if (length<.01) return null;
    let best=null, bestAngle=Infinity;
    for (const enemy of this.abilities.enemies(actor,start[0])) {
      if (enemy.down>0 || enemy.shield>0) continue;
      const chest=[enemy.x-start[0],enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.9)-start[1],enemy.z-start[2]];
      const gap=Math.hypot(...chest);
      if (gap>reach || gap<.3) continue;
      const angle=Math.acos(clamp(dot(chest,aim)/(gap*length),-1,1));
      const width=(enemy.isBoss?4.8:enemy.giant?2.2:AUTO_AIM_LOCK.body)/gap+AUTO_AIM_LOCK.slack;
      if (angle<width && angle<bestAngle) {best=enemy;bestAngle=angle;}
    }
    return best;
  }

  // Turns a tracking round toward the best opponent inside its seeker cone,
  // or toward the enemy it was locked on to.
  guideShot(shot,dt) {
    const {turn,cone,reach,target}=shot.homing, [vx,vy,vz]=shot.vel, speed=Math.hypot(vx,vy,vz);
    if (speed<1) return;
    const [px,py,pz]=shot.pos, limit=Math.cos(cone);
    let best=-Infinity, wx=0, wy=0, wz=0;
    for (const enemy of target?[target]:this.abilities.enemies(shot.actor,px)) {
      if (target && (enemy.down>0 || !sameLevel(enemy.x,px))) break;
      if (enemy.shield>0) continue;
      const dx=enemy.x-px, dy=enemy.y+(enemy.isBoss?2.2:enemy.swimming?.36:.9)-py, dz=enemy.z-pz, gap=Math.hypot(dx,dy,dz);
      if (gap>reach || gap<.25) continue;
      const facing=(dx*vx+dy*vy+dz*vz)/(gap*speed), value=facing-gap/reach*.1;
      if (facing<limit || value<=best) continue;
      best=value;
      wx=dx/gap;wy=dy/gap;wz=dz/gap;
    }
    if (best===-Infinity) return;
    const ux=vx/speed, uy=vy/speed, uz=vz/speed;
    const angle=Math.acos(clamp(ux*wx+uy*wy+uz*wz,-1,1));
    if (angle<1e-4) return;
    const t=Math.min(1,turn*dt/angle), sine=Math.sin(angle);
    const keep=Math.sin((1-t)*angle)/sine, steer=Math.sin(t*angle)/sine;
    shot.vel=[(ux*keep+wx*steer)*speed,(uy*keep+wy*steer)*speed,(uz*keep+wz*steer)*speed];
  }

  drainWalls(dt) {
    for (const mark of this.decals) {
      const volume=wallRunoff(mark,dt);
      if (!volume) continue;
      const n=mark.normal, down=unit([n[0]*n[1],n[1]*n[1]-1,n[2]*n[1]]);
      const rim=this.world.geometry.coat(mark,decalBasis(n,mark.phase),DECAL_RIM);
      let foot=mark.p;
      if (rim?.length) {
        foot=rim.reduce((lowest,p)=>p[1]<lowest[1]?p:lowest,rim[0]);
        foot=add(foot,scale(n,.034));
      }
      if (this.drops.length>=630) {
        mark.volume+=volume;
        continue;
      }
      this.drops.push({p:foot.slice(),v:add(scale(down,.9),scale(n,.27)),team:mark.team,volume,
        life:7.2,max:7.2,size:Math.max(.058,Math.cbrt(volume)*1.75)});
    }
  }

  landDrop(drop,hit) {
    if (hit.boundary || drop.v[1]>=0) return;
    const [x,,z]=hit.position;
    if (drop.volume) {
      if (this.paint.depositDrop(x,z,hit.layer,drop.team,drop.volume,drop.v[0],drop.v[2])) return;
      if (hit.shape?.id>=0) this.coat(hit,drop.team,Math.max(.12,drop.size*2.8),0,drop.volume);
    } else if (hit.layer!==undefined) {
      this.paint.stampGround(x,z,drop.size*2.4,drop.team,hit.layer,0,drop.wet);
    }
  }

  updateShots(dt) {
    this.drainWalls(dt);
    while (this.inkImpacts.length && this.clock-this.inkImpacts[0].at>=INK_HIT_DURATION) this.inkImpacts.shift();
    const toBuf=this._shotTo ?? (this._shotTo=[0,0,0]);
    const endBuf=this._shotEnd ?? (this._shotEnd=[0,0,0]);
    const halfDt2=.5*dt*dt, gDrop=9.81*dt;
    for (let i=this.shots.length-1;i>=0;i--) {
      const shot=this.shots[i];
      if (shot.life!==undefined && shot.age>=shot.life) {
        this.burst(shot.pos,shot.actor.team,3,1.2);
        this.shots.splice(i,1);
        continue;
      }
      if (shot.homing) this.guideShot(shot,dt);
      const pos=shot.pos, vel=shot.vel;
      if (shot.bend) {
        const turn=Math.sin(shot.age*7.1)*dt;
        vel[0]+=shot.bend[0]*turn;
        vel[2]+=shot.bend[2]*turn;
      }
      const g=shot.weapon.gravity;
      const sx0=pos[0], sy0=pos[1], sz0=pos[2];
      let fRes=null;
      if (this.fluid) {
        fRes=this.fluid.stepProjectileFluid(shot,g,dt,this.rng);
        toBuf[0]=pos[0]; toBuf[1]=pos[1]; toBuf[2]=pos[2];
        pos[0]=sx0; pos[1]=sy0; pos[2]=sz0;
      } else {
        toBuf[0]=sx0+vel[0]*dt;
        toBuf[1]=sy0+vel[1]*dt-g*halfDt2;
        toBuf[2]=sz0+vel[2]*dt;
      }
      const fraction=shotFraction(pos,toBuf);
      let end=toBuf;
      if (fraction<1) {
        endBuf[0]=pos[0]+(toBuf[0]-pos[0])*fraction;
        endBuf[1]=pos[1]+(toBuf[1]-pos[1])*fraction;
        endBuf[2]=pos[2]+(toBuf[2]-pos[2])*fraction;
        end=endBuf;
      }
      if (fraction>0 && this.impactShot(shot,pos,end) || fraction<1 || toBuf[1]<ZONES[zoneOf(pos[0])].y-18) {
        this.shots.splice(i,1);
        continue;
      }
      if (!this.fluid) vel[1]-=g*dt;
      if (fRes?.breakup && this.drops.length<48 && (shot.weapon?.size??.2)>=.24) {
        const dp=fRes.drop;
        this.drops.push({
          p:[dp.x,dp.y,dp.z],v:[dp.vx,dp.vy,dp.vz],team:shot.actor.team,
          size:clamp((shot.weapon.size??.2)*.55,.06,.16),life:.45,max:.45,wet:true,volume:.006
        });
      }
      const seam=stairRay(pos,toBuf);
      pos[0]=seam?toBuf[0]+seam.shift:toBuf[0];
      pos[1]=toBuf[1];
      pos[2]=toBuf[2];
      shot.age+=dt;
    }
    const world=this.world;
    for (let i=this.drops.length-1;i>=0;i--) {
      const drop=this.drops[i];
      const from=drop.p, v=drop.v, fy=from[1];
      toBuf[0]=from[0]+v[0]*dt;
      toBuf[1]=fy+v[1]*dt;
      toBuf[2]=from[2]+v[2]*dt;
      const wet=(drop.wet || drop.volume) && drop.team>=0;
      const hit=wet && this.traceShot(from,toBuf,true);
      if (hit) {
        this.landDrop(drop,hit);
        this.drops.splice(i,1);
        continue;
      }
      const seam=stairRay(from,toBuf);
      const dx=seam?toBuf[0]+seam.shift:toBuf[0], dy=toBuf[1], dz=toBuf[2];
      from[0]=dx; from[1]=dy; from[2]=dz;
      v[1]-=gDrop;
      drop.life-=dt;
      const zone=zoneOf(dx), line=zone===0?RAIL:zone===1?METRO:null;
      const landsOnRail=line && fy>=line.y && dy<=line.y && Math.abs(dx-line.center)<line.edge && Math.abs(dz-line.z)<line.halfWidth;
      if (landsOnRail) {
        if (wet) this.landDrop(drop,{position:from,layer:line.layer});
        this.drops.splice(i,1);
      } else if (dy<=world.floorY(dx,dz)) {
        if (wet) this.landDrop(drop,{position:from,layer:world.floor(dx,dz).layer});
        this.drops.splice(i,1);
      } else if (drop.life<=0) this.drops.splice(i,1);
    }
  }

  update(dt,input,camera) {
    if (this.finished || dt<=0) return;
    if (this.countdown>0) {
      const waiting=Math.min(dt,this.countdown);
      this.clock+=waiting;
      const previous=Math.ceil(this.countdown);
      this.countdown-=waiting;
      this.paint.advance(waiting);
      if (Math.ceil(this.countdown)<previous) this.callbacks.sound?.(this.countdown>0?'tick':'go');
      if (this.player) {
        this.player.yaw=input.yaw;
        this.player.pitch=input.pitch;
      }
      dt-=waiting;
      if (dt<=0) return;
    }
    if (!this.unlimited) dt=Math.min(dt,this.left);
    if (dt<=0) {
      this.finishMatch();
      return;
    }
    this.clock+=dt;
    if (this.unlimited) this.elapsed+=dt;
    else {
      this.left=Math.max(0,this.left-dt);
      this.elapsed=this.duration-this.left;
    }
    this.transit.update(this.elapsed);
    this.metro.update(this.elapsed);
    this.motion.begin();
    this.tactics.squads.refresh();
    for (const actor of this.actors) {
      if (actor.down>0) {
        actor.down-=dt;
        if (actor.down<=0) {
          respawn(actor);
          this.tactics.states.delete(actor);
          this.perception.memory.delete(actor);
          if (actor.isPlayer) this.callbacks.spawn?.(actor);
        }
        continue;
      }
      actor.fire-=dt;
      actor.rolling=false;
      actor.heat-=dt;
      actor.shield=Math.max(0,actor.shield-dt);
      actor.recoil=Math.max(0,actor.recoil-dt*8.3);
      actor.damageAge+=dt;
      if (!actor.car) this.inkPressure(actor,dt);
      this.abilities.credit(actor);
      let crossed=false;
      if (actor.isPlayer) {
        actor.yaw=input.yaw;
        actor.pitch=input.pitch;
        if (input.use) crossed=this.useTransport(actor);
        if (!actor.car) {
          if (input.super) this.abilities.activate(actor);
          if (input.drone) this.abilities.summon(actor);
        }
      }
      if (actor.revealUntil>this.clock && actor.revealTeam>=0) {
        // A marked crew member is common knowledge for the team that tagged it.
        this.tactics.contacts[actor.revealTeam]?.set(actor,{x:actor.x,y:actor.y,z:actor.z,until:this.clock+7.5});
      }
      const carried=this.carryTransit(actor,dt);
      const occupied=this.abilities.updateActor(actor,dt);
      if (!carried && !occupied && !crossed) {
        if (actor.car) {
          if (actor.isPlayer) this.vehicles.drive(actor,input,dt);
        } else if (actor.isPlayer) this.control(actor,input,dt,camera);
        else this.npc(actor,dt);
      }
      const factor=(1-(actor.inkPenalty??0)*.072)*(actor.regenFactor??1);
      const refill=actor.swimming?(actor.inkSwimming?48:18):actor.heat<=0?(actor.isPlayer?13:17):0;
      actor.tank=Math.min(actor.tankMax,actor.tank+refill*dt*factor);
      this.pickupChip(actor);
      if (actor.damageAge>(actor.isCheater?.9:1.9)) {
        const recovery=actor.swimming?(actor.inkSwimming?28:20):19;
        actor.hp=Math.min(actor.maxHp,actor.hp+recovery*dt*factor);
      }
    }
    this.vehicles?.update(dt);
    this.updateShots(dt);
    this.subweapons.update(dt);
    this.abilities.update(dt);
    this.retireClones();
    if (!this.timeless) this.boss.update(dt);
    this.raiders.update(dt);
    this.hazards.update(dt);
    if (!this.timeless) this.dynamicStage?.step(dt,this);
    else if (this.dynamicStage?.active) this.dynamicStage.step(dt,this);
    this.fluid?.stepBossAndGrid(this,dt);
    this.stage?.update?.(dt,this);
    for (const raider of this.raiders.members) if (raider.active) this.pickupChip(raider);
    if (this.mode==='watch' && this.cameraActor().down>0) this.cycle();
    this.paint.advance(dt);
    this.events=this.events.filter(event=>event.until>this.clock);
    if (!this.unlimited && this.left<=0) this.finishMatch();
  }

  finishMatch() {
    this.finished=true;
    this.callbacks.sound?.('finish');
    this.callbacks.finish?.();
  }

  draw(renderer,viewX=this.cameraActor().x,viewZ=this.cameraActor().z,hideCrew=null,viewY=2.5,stair=false) {
    this.drawLevel(renderer,viewX,viewZ,hideCrew,viewY);
    const zone=zoneOf(viewX);
    if (!stair || zone>=2) return;
    renderer.drawingAdjacent=true;
    this.drawLevel(renderer,viewX-ZONES[zone].x+ZONES[1-zone].x,viewZ,hideCrew,viewY);
    renderer.drawingAdjacent=false;
  }

  drawLevel(renderer,viewX,viewZ,hideCrew,viewY) {
    const zone=zoneOf(viewX);
    const visualClock=this.clock+(this.impactAgeOffset??0);
    this.stage.draw(renderer,viewX,visualClock,viewZ);
    this.dynamicStage?.draw(renderer,viewX,viewZ);
    this.vehicles?.draw(renderer,viewX,viewZ,visualClock);
    if (zone<2) for (const rail of [this.transit,this.metro]) {
      const hiddenByStage=this.hazards?.trainBoss?.active && this.hazards.trainBoss.stageMode && this.hazards.trainBossRail()===rail;
      if (rail.visibleIn(zone) && !hiddenByStage) rail.draw(renderer);
    }
    if (zone>=2) drawCabinScenery(renderer,this.cabinTrain(viewX));
    const chip=this.chip;
    if (!chip.owner && sameLevel(chip.x,viewX)) {
      const opts={dynamic:true,yaw:chip.yaw};
      renderer.add('bevel',chip.x,chip.y+.026,chip.z,.33,.052,.20,0x5e6858,4,opts);
      renderer.add('box',chip.x,chip.y+.058,chip.z,.195,.013,.132,0x333b36,4,opts);
      for (const side of [-1,1]) renderer.add('box',chip.x+Math.cos(chip.yaw)*side*.122,chip.y+.057,
        chip.z-Math.sin(chip.yaw)*side*.122,.063,.011,.153,0xa29670,4,opts);
    }
    // The lightweight modes draw nothing beyond their fogged draw distance.
    const reach=renderer.reach??Infinity, reach2=reach===Infinity?Infinity:reach*reach;
    const actors=this.actors, actorLim=reach===Infinity?Infinity:(reach+6)*(reach+6);
    for (let i=0;i<actors.length;i++) {
      const actor=actors[i];
      if (actor===hideCrew || actor.down>0 || actor.ride || actor.car || actor.inCar || !sameLevel(actor.x,viewX)) continue;
      if (actorLim!==Infinity) {const dx=actor.x-viewX, dz=actor.z-viewZ; if (dx*dx+dz*dz>=actorLim) continue;}
      drawCrew(renderer,actor,visualClock);
    }
    this.abilities.draw(renderer,viewX);
    this.subweapons.draw(renderer,viewX);
    this.boss.draw(renderer,viewX);
    this.raiders.draw(renderer,viewX);
    this.hazards?.draw(renderer,viewX,viewZ);
    const shots=this.shots, liteShot=!!renderer.lite || !!renderer.ultralite;
    const hasFrustum=typeof renderer.inFrustum==='function';
    for (let i=0;i<shots.length;i++) {
      const shot=shots[i], sp=shot.pos;
      if (!sameLevel(sp[0],viewX)) continue;
      if (reach2!==Infinity) {const dx=sp[0]-viewX, dz=sp[2]-viewZ; if (dx*dx+dz*dz>=reach2) continue;}
      const w=shot.weapon, wid=w.id, size=w.size;
      if (hasFrustum && !renderer.inFrustum(sp[0],sp[1],sp[2],size*4+2.2)) continue;
      const sv=shot.vel, speed=Math.hypot(sv[0],sv[1],sv[2]), invS=1/Math.max(.00001,speed);
      const yx=sv[0]*invS, yy=sv[1]*invS, yz=sv[2]*invS;
      const hLen=Math.hypot(yz,yx);
      let xx, xz;
      if (hLen>.0001) {const xInv=1/hLen; xx=-yz*xInv; xz=yx*xInv;}
      else {xx=1; xz=0;}
      const zx=-xz*yy, zy=xz*yx-xx*yz, zz=xx*yy;
      _sbX[0]=xx; _sbX[1]=0; _sbX[2]=xz;
      _sbY[0]=yx; _sbY[1]=yy; _sbY[2]=yz;
      _sbZ[0]=zx; _sbZ[1]=zy; _sbZ[2]=zz;
      _dynBasis.basis=_shotBasis;
      const px=sp[0]-yx*.10, py=sp[1]-yy*.10, pz=sp[2]-yz*.10;
      const isCheaterShot=wid==='autoeima2s';
      const isGoatShot=wid==='goat_orb';
      const isTrainShot=wid==='train_boss';
      const ink=isCheaterShot?0xff267a:isGoatShot?0xff3355:isTrainShot?0xff3848:(TEAM_INK[shot.actor.team] ?? RAIDER_INK);
      const coreTint=isCheaterShot?0xffb8e0:isGoatShot?0xffd966:isTrainShot?0xffe090:0xf6fffc;
      const isLob=wid==='lob', isHeavy=isLob || wid==='blast' || wid==='rd2' || isGoatShot;
      const isLance=wid==='charge' || wid==='prism' || wid==='sniper';
      const isHoming=!!shot.homing || wid==='autoeima' || isCheaterShot || wid==='swout' || wid==='swout2';
      const isSwirl=wid==='coil' || wid==='surge';
      const spin=visualClock*15+(shot.id??i)*1.37;
      const wob=1+.095*Math.sin(spin*1.35);

      // Primary sculpted liquid-energy projectile body with dynamic surface wobble
      const stretch=(isLob?1.52:isLance?4.6:isHeavy?2.05:3.05)*(2-wob);
      const bw=size*(isLance?.86:1.06)*wob;
      renderer.add(isLance?'taper':'orb',px,py,pz,bw,size*stretch,bw,ink,9,_dynBasis);

      // Luminous plasma core inside nose for crisp readability against any background
      const nose=size*(isLance?.98:.38);
      renderer.add('orb',px+yx*nose,py+yy*nose,pz+yz*nose,size*.48,size*(isLance?1.58:1.02),size*.48,coreTint,3,_dynBasis);

      if (!liteShot) {
        // Streamlined liquid wake tail + trailing slipstream droplet
        const tail=clamp(speed*(isLance?.034:.025),.28,isLance?1.75:1.22)*(isLob?.62:1);
        const ht=-tail*.52;
        renderer.add('limb',px+yx*ht,py+yy*ht,pz+yz*ht,size*.76,tail,size*.76,ink,9,_dynBasis);
        const dropBack=-tail*1.10;
        renderer.add('orb',px+yx*dropBack,py+yy*dropBack,pz+yz*dropBack,size*.38,size*.92,size*.38,ink,9,_dynBasis);

        // Weapon-class signature animated 3D energy flair!
        if (isHoming) {
          // Counter-rotating dual seeker lock-on rings + twin helical trailing plasma wisps
          const ringR=size*(isCheaterShot?2.55:isGoatShot?2.30:2.05);
          renderer.add('ring',px-yx*.04,py-yy*.04,pz-yz*.04,ringR,size*.24,ringR,coreTint,3,_dynBasis);
          renderer.add('ring',px-yx*.24,py-yy*.24,pz-yz*.24,ringR*.76,size*.18,ringR*.76,ink,3,_dynBasis);
          const ca=Math.cos(spin), sa=Math.sin(spin), orbR=size*1.12;
          const ox=(xx*ca+zx*sa)*orbR, oy=zy*sa*orbR, oz=(xz*ca+zz*sa)*orbR;
          renderer.add('orb',px-yx*.32+ox,py-yy*.32+oy,pz-yz*.32+oz,size*.30,size*.58,size*.30,coreTint,3,_dynBasis);
          renderer.add('orb',px-yx*.32-ox,py-yy*.32-oy,pz-yz*.32-oz,size*.28,size*.54,size*.28,ink,3,_dynBasis);
        } else if (isLance) {
          // Precision / Charger / Prism: Mach shock-cone + 3 expanding shock-rings along wake!
          renderer.add('cone',px+yx*size*.28,py+yy*size*.28,pz+yz*size*.28,size*1.55,size*1.85,size*1.55,coreTint,3,_dynBasis);
          for (let k=0;k<3;k++) {
            const off=-tail*(.28+k*.34), rr=size*(1.65+k*.52);
            renderer.add('ring',px+yx*off,py+yy*off,pz+yz*off,rr,size*.17,rr,k===0?coreTint:ink,3,_dynBasis);
          }
        } else if (isHeavy) {
          // Lob / Blaster / RD II QUATRO+: pressurized glowing equatorial ring + 3 orbiting ink satellites!
          const rr=size*1.68*(.95+.08*Math.sin(spin));
          renderer.add('ring',px,py,pz,rr,size*.26,rr,coreTint,3,_dynBasis);
          const orbR=size*1.02;
          for (let k=0;k<3;k++) {
            const ang=spin*.9+k*TAU/3, ca=Math.cos(ang), sa=Math.sin(ang);
            const ox=(xx*ca+zx*sa)*orbR, oy=zy*sa*orbR, oz=(xz*ca+zz*sa)*orbR;
            const sOrb=size*(k===0?.34:.26);
            renderer.add('orb',px+ox,py+oy,pz+oz,sOrb,sOrb,sOrb,k===0?coreTint:ink,k===0?3:9,_dyn);
          }
        } else if (isSwirl) {
          // Spiral / Wave: paired DNA double-helix energy wisps corkscrewing along the wake!
          const orbR=size*1.18;
          for (let k=0;k<2;k++) {
            const ang=spin*1.35+k*Math.PI, ca=Math.cos(ang), sa=Math.sin(ang);
            const ox=(xx*ca+zx*sa)*orbR, oy=zy*sa*orbR, oz=(xz*ca+zz*sa)*orbR;
            renderer.add('orb',px-yx*.24+ox,py-yy*.24+oy,pz-yz*.24+oz,size*.32,size*.76,size*.32,k===0?coreTint:ink,3,_dynBasis);
          }
        }
      }
    }
    // Velocity-aligned sculpted teardrop ink droplets (zero allocations + frustum culled!)
    const dropStep=renderer.ultralite?3:renderer.lite?2:1, dropLim=reach===Infinity?Infinity:(reach*.7)*(reach*.7);
    const drops=this.drops;
    for (let i=0;i<drops.length;i+=dropStep) {
      const d=drops[i], dp=d.p;
      if (!sameLevel(dp[0],viewX)) continue;
      if (dropLim!==Infinity) {const dx=dp[0]-viewX, dz=dp[2]-viewZ; if (dx*dx+dz*dz>=dropLim) continue;}
      if (hasFrustum && !renderer.inFrustum(dp[0],dp[1],dp[2],.45)) continue;
      const size=d.size*(.46+.54*d.life/d.max);
      const dv=d.v, spd=Math.hypot(dv[0],dv[1],dv[2]);
      const dTint=TEAM_INK[d.team] ?? 0xb573c7;
      if (spd>.6 && !liteShot) {
        const invS=1/spd, yx=dv[0]*invS, yy=dv[1]*invS, yz=dv[2]*invS;
        const hLen=Math.hypot(yz,yx);
        let xx, xz;
        if (hLen>.001) {const invH=1/hLen; xx=-yz*invH; xz=yx*invH;}
        else {xx=1; xz=0;}
        _sbX[0]=xx; _sbX[1]=0; _sbX[2]=xz;
        _sbY[0]=yx; _sbY[1]=yy; _sbY[2]=yz;
        _sbZ[0]=-xz*yy; _sbZ[1]=xz*yx-xx*yz; _sbZ[2]=xx*yy;
        _dynBasis.basis=_shotBasis;
        const stretch=clamp(1.3+spd*.16,1.3,2.95);
        renderer.add('orb',dp[0],dp[1],dp[2],size*.88,size*stretch,size*.88,dTint,9,_dynBasis);
      } else {
        renderer.add('orb',dp[0],dp[1],dp[2],size,size*1.42,size,dTint,9,_dyn);
      }
    }
    const impacts=this.inkImpacts;
    if (impacts.length) {
      _eyeScratch[0]=viewX; _eyeScratch[1]=viewY; _eyeScratch[2]=viewZ;
      for (let i=0;i<impacts.length;i++) {
        const hit=impacts[i];
        if (sameLevel(hit.p[0],viewX)) drawInkImpact(renderer,hit,_eyeScratch,visualClock);
      }
    }
    const markReach=Math.min(140,reach*.8), markReach2=markReach*markReach, decals=this.decals;
    for (let i=0;i<decals.length;i++) {
      const decal=decals[i], dp=decal.p;
      if (!sameLevel(dp[0],viewX)) continue;
      const dx=dp[0]-viewX, dz=dp[2]-viewZ;
      if (dx*dx+dz*dz>markReach2) continue;
      if (hasFrustum && !renderer.inFrustum(dp[0],dp[1],dp[2],decal.radius*1.8)) continue;
      const tint=TEAM_INK[decal.team];
      const shape=decalShape(this.world.geometry,decal), org=shape.origin;
      if (shape.fan) {
        const fan=shape.fan;
        for (let j=0;j<fan.length;j++) {_dynBasis.basis=fan[j];renderer.add('tri',org[0],org[1],org[2],1,1,1,tint,26,_dynBasis);}
      } else {_dynBasis.basis=shape.axes;renderer.add('splat',org[0],org[1],org[2],decal.radius*1.66,decal.radius*1.35,1,tint,26,_dynBasis);}
    }
  }
}

const _dyn={dynamic:true};
const _dynYaw={dynamic:true,yaw:0};
const _dynYP={dynamic:true,yaw:0,pitch:0};
const _dynLabel={dynamic:true,label:0};
const _dynBasis={dynamic:true,basis:null};
const _dynBeam={dynamic:true,shape:'limb'};
const _sbX=[0,0,0], _sbY=[0,0,0], _sbZ=[0,0,0], _shotBasis=[_sbX,_sbY,_sbZ];
const _eyeScratch=[0,0,0];
const _rolUp=[0,1,0], _rolAxis=[0,0,0], _rolFace=[0,0,0], _rolAxes=[_rolUp,_rolAxis,_rolFace];
const _rolRad=[0,0,0], _rolCross=[0,0,0], _rolSeamAxes=[_rolAxis,_rolRad,_rolCross];
const _ptA=[0,0,0], _ptB=[0,0,0], _ptC=[0,0,0], _ptD=[0,0,0];

function crewPose(a,time,yaw=Math.PI-a.yaw) {
  const vx=a.vx??0,vz=a.vz??0,vy=a.vy??0,phase=a.steps??0;
  const speed=Math.hypot(vx,vz),pace=clamp(speed/5.9,0,1);
  const cy=Math.cos(yaw),sy=Math.sin(yaw);
  const loc=(x,y,z)=>[a.x+x*cy+z*sy,a.y+y,a.z-x*sy+z*cy];
  const invSpd=1/(speed>1?speed:1);
  const fore=(vx*sy+vz*cy)*invSpd,lateral=(vx*cy-vz*sy)*invSpd;
  const airborne=a.airborne ?? Math.abs(vy)>.48,rising=airborne && vy>0;
  const crouch=a.landing??0,swing=Math.sin(phase),transfer=Math.cos(phase);
  const brace=a.brace??0, peek=a.peek??0, ready=a.readyPose??0, hit=a.flare??0;
  const rise=airborne?(rising?.048:-.018):Math.abs(swing)*pace*.053+Math.sin(time*4.6+a.index)*.016*(1-pace)-crouch*.19-brace*.36;
  const sway=pace*lateral*.15+(a.poseBank??0)*.21+peek*.24,lean=pace*fore*.17+crouch*.14+brace*.082+ready*.028-hit*.083;
  return {cy,sy,loc,phase,pace,fore,lateral,airborne,rising,crouch,swing,transfer,rise,sway,lean};
}

function rollerPosition(a) {
  const recoil=a.recoil??0;
  return {y:a.rolling?.31:1.48-recoil*.55,z:a.rolling?.86:.76+recoil*.18};
}

function gunPose(a,pose,weapon=a.weapon??WEAPONS[0]) {
  const pitch=-(a.pitch??0)*.47-pose.lean*.48;
  const c=Math.cos(pitch),s=Math.sin(pitch),recoil=(a.recoil??0)*.105;
  const at=(x,y,z)=>{
    const dy=y-1.25,dz=z-.437-recoil;
    return pose.loc(x+pose.sway*.87,1.25+pose.rise*.87+dy*c-dz*s,.437+pose.lean*.87+dy*s+dz*c);
  };
  const barrel=weapon.id==='charge'?.56:weapon.id==='lob' || weapon.id==='autoeima' || weapon.id==='autoeima2s'?.34:weapon.id==='rd2'?.44:weapon.id==='td'?.30:.315;
  return {at,pitch,barrel,c,s,recoil,pose};
}

export function drawCrew(r,a,time,showEffects=true) {
  const cheater=!!a.isCheater;
  const tint=cheater?0x27152e:TEAM[a.team], bright=cheater?0xff267a:TEAM_INK[a.team];
  // Render-only detail: hit detection collects the plain shapes, so the
  // silhouette and every pose stay identical to what shots are tested against.
  const view=r.viewPoint;
  const range=view?Math.hypot(a.x-view[0],a.y-view[1],a.z-view[2]):0;
  const hi=!!r.fidelity && range<(r.lite?13:26);
  const soft=hi?'soft':'bevel', limbShape=hi?'limb':'taper';
  const grip=a.climbing && a.climbNormal;
  const yaw=Math.PI-(grip?Math.atan2(-grip[0],grip[2]):a.isPlayer || a.swimming || a.weapon?.roller?a.yaw:a.bodyYaw??a.yaw);
  if (a.giant) {
    drawSquid(r,a,time,tint,0xffebbd,giantScale(a.x));
    return;
  }
  if (r.fidelity && showEffects && range<60 && !a.climbing && !(a.airborne ?? Math.abs(a.vy??0)>.48)) {
    _dynLabel.label=.62;
    r.add('shade',a.x,a.y+.016,a.z,a.swimming?1.05:1.25,1,a.swimming?1.35:1.25,0,28,_dynLabel);
  }
  if (showEffects && cheater && !a.swimming) {
    const pulse=.18*Math.sin(time*14), spin=time*6.2;
    _dynLabel.label=.22;
    r.add('ripple',a.x,a.y+2.20+pulse*.2,a.z,.80,.03,.80,0xff267a,12,_dynLabel);
    _dynLabel.label=.35;
    r.add('ripple',a.x,a.y+.06,a.z,1.58+pulse,.03,1.58+pulse,0xff267a,12,_dynLabel);
    if (!r.lite) {
      // Counter-rotating overclocked crimson-gold glitch halos & orbiting plasma sparks
      _dynYP.yaw=spin; _dynYP.pitch=.28;
      r.add('ring',a.x,a.y+2.18,a.z,.62,.032,.62,0xffd066,3,_dynYP);
      _dynYP.yaw=-spin*1.35; _dynYP.pitch=-.25;
      r.add('ring',a.x,a.y+2.18,a.z,.76,.026,.76,0xff267a,3,_dynYP);
      for (let k=0;k<3;k++) {
        const ang=spin*1.4+k*TAU/3, syOff=1.05+Math.sin(time*7+k*2.1)*.45;
        r.add('orb',a.x+Math.cos(ang)*.64,a.y+syOff,a.z+Math.sin(ang)*.64,.085,.085,.085,k===0?0xffd066:0xff267a,3,_dyn);
      }
    }
  }
  if (showEffects && a.guard>0) {
    const pulse=.15*Math.sin(time*8);
    _dynLabel.label=.08;
    r.add('ripple',a.x,a.y+.06,a.z,2.14+pulse,.03,2.14+pulse,0xd3fff2,12,_dynLabel);
    _dynLabel.label=.24;
    r.add('ripple',a.x,a.y+1.03,a.z,2.02,.03,2.02,0x86ded0,12,_dynLabel);
    for (let i=0;i<4;i++) {
      const angle=i*TAU/4;
      r.add('curtain',a.x+Math.sin(angle)*.69,a.y+.99,a.z-Math.cos(angle)*.69,1.31,1.84,1,bright,16,
        {dynamic:true,yaw:-angle,label:1-a.guard/95});
    }
  }
  const pose=crewPose(a,time,yaw);
  const {cy,sy,loc,phase,pace,fore,lateral,airborne,rising,crouch,swing,transfer,rise,sway,lean}=pose;
  const ax=a.x, ay=a.y, az=a.z;
  if (a.swimming) {
    const pull=time*(a.climbing?12:a.inkSwimming?15.5:8.5)+phase*.86+a.index*.8;
    const stretch=1+pace*(a.inkSwimming?.32:.10)+Math.sin(pull)*.045*(pace+.25);
    const tilt=a.climbing?-Math.PI/2:Math.cos(pull)*pace*.12;
    const cp=Math.cos(tilt),sp=Math.sin(tilt);
    const centerY=a.climbing?.54:.11, centerZ=a.climbing?.17:0;
    const lite=!!r.lite || !!r.ultralite;
    _dynYP.yaw=yaw;
    const squid=(type,x,y,z,w,h,d,color,material,pitch=0)=>{
      const ly=centerY+(y-.11)*cp-z*sp, lz=centerZ+(y-.11)*sp+z*cp;
      _dynYP.pitch=pitch+tilt;
      r.add(type,ax+x*cy+lz*sy,ay+ly,az-x*sy+lz*cy,w,h,d,color,material,_dynYP);
    };
    const mantlePulse=1+Math.sin(pull*2)*.05;
    squid('orb',0,.104,-.067,.69*mantlePulse,.182,.96*stretch,bright,9);
    squid(soft,0,.142,-.116,.64,.175,.70*stretch,tint,9,-.10);
    squid('orb',0,.193,.15,.43,.287,.48,tint,9,-.25);
    squid(soft,0,.227,.321,.317,.126,.151,0x293f49,8,-.09);
    squid(soft,0,.268,.165,.106,.032,.284,bright,3);
    for (const sign of [-1,1]) {
      squid(soft,sign*.084,.241,.376,.080,.054,.036,0xdbf2d3,3);
      if (hi) squid('orb',sign*.084,.247,.394,.034,.03,.016,0x0b1214,8);
      // Flapping lateral mantle fins & sweeping side arms!
      const finFlap=Math.sin(pull+sign*.6)*(.16+pace*.24);
      squid('orb',sign*(.26+finFlap*.12),.14+finFlap*.04,.02,.24,.065,.42*stretch,bright,9,finFlap*.35);
      const stroke=Math.sin(pull+sign*.92), effort=a.climbing?.12:.05+pace*.075;
      squid('orb',sign*(.19+stroke*effort),.068+stroke*.024,-.48-stroke*.06,.192,.082,.52*stretch,bright,9,stroke*.20);
    }
    // 4 articulated 2-segment undulating tentacles with phase-delayed traveling waves!
    for (let i=0;i<4;i++) {
      const tail=(i-1.5)*.108, w1=Math.sin(pull+i*.82), w2=Math.sin(pull+i*.82-1.15);
      const segLen=.32+stretch*.12;
      squid(hi?'limb':'taper',tail+w1*.035,.079+w1*.018,-.55-stretch*.10,.095,segLen,.085,tint,9,Math.PI/2+w1*.22);
      if (!lite && r.seal) {
        squid('taper',tail+w2*.065,.075+w2*.026,-.55-stretch*.10-segLen*.72,.058,segLen*.68,.055,bright,9,Math.PI/2+w2*.30);
      }
    }
    if (hi) for (const sign of [-1,1]) squid('limb',sign*.21,.15,.05,.06,.34,.05,bright,9,Math.PI/2.3);
    // Speed-wake ink ripples & trailing bubble beads when ink-swimming fast!
    if (showEffects && !lite && r.seal && a.inkSwimming && pace>.25 && !a.climbing) {
      const wakePhase=(time*4.5+(a.index??0)*.37)%1;
      _dynLabel.label=wakePhase;
      r.add('ripple',ax-sy*.42,ay+.045,az-cy*.42,.95+wakePhase*1.05,.025,.95+wakePhase*1.05,bright,12,_dynLabel);
      for (let b=0;b<2;b++) {
        const bp=(time*5+b*.5)%1, back=.55+bp*.85, sideOff=(b===0?1:-1)*(.16+bp*.22);
        const bs=(1-bp)*.105;
        r.add('orb',ax+sideOff*cy-back*sy,ay+.08+Math.sin(bp*Math.PI)*.14,az-sideOff*sy-back*cy,bs,bs,bs,b===0?0xf6fffc:bright,b===0?3:9,_dyn);
      }
    }
    return;
  }
  // Crew materials: 30 ripstop suit, 31 canvas webbing, 21 rubber, 20 armour
  // (kept apart from the scene's 18, train seat fabric, for the textures).
  const material=(mat,c)=>mat===2?(c===BOOT?21:c===GRAPHITE?31:30):mat===4 && (c===tint || c===bright)?20:mat;
  const part=(type,x,y,z,w,h,d,c,mat=2,pitch=0)=>{
    let upper=(y-.66)*1.06;
    if (upper<0) upper=0; else if (upper>1) upper=1;
    const lx=x+sway*upper, ly=y+rise*upper, lz=z+lean*upper;
    _dynYP.yaw=yaw;
    _dynYP.pitch=pitch-lean*upper*.48;
    r.add(type,ax+lx*cy+lz*sy,ay+ly,az-lx*sy+lz*cy,w,h,d,c,material(mat,c),_dynYP);
  };
  const weapon=a.weapon ?? WEAPONS[0];
  const aimYaw=Math.PI-a.yaw;
  const gun=weapon.roller?null:gunPose(a,aimYaw===yaw?pose:crewPose(a,time,aimYaw));
  const torso=(x,y,z)=>{
    let upper=(y-.66)*1.06;
    if (upper<0) upper=0; else if (upper>1) upper=1;
    const lx=x+sway*upper, ly=y+rise*upper, lz=z+lean*upper;
    return [ax+lx*cy+lz*sy,ay+ly,az-lx*sy+lz*cy];
  };
  // A fresh hit flashes the whole suit; an ebot copy wears a paler shell.
  const struck=a.damageAge<.15, copy=!!(a.clone || a.cloneOf);
  const hit=struck?0xffd0b0:copy?0xeef6f0:0xd5ddd0;
  const armor=struck?0xff8f70:copy?0x6d8792:0x263943;
  if (showEffects && copy) {
    const spin=time*2.4+(a.index??0);
    _dynYaw.yaw=spin;
    r.add('ring',ax,ay+2.32+Math.sin(spin)*.03,az,.5,.05,.5,bright,3,_dynYaw);
  }
  if (showEffects && (a.activeSpecial==='om' || a.activeSpecial==='om2') && a.superUntil>time) {
    // OM Bomb: seeker lights orbit the crew member while its rounds track.
    const count=a.activeSpecial==='om2'?4:2;
    for (let i=0;i<count;i++) {
      const angle=time*5.2+i*TAU/count, lift=1.15+.35*Math.sin(time*3.1+i*1.7);
      r.add('orb',ax+Math.cos(angle)*.72,ay+lift,az+Math.sin(angle)*.72,.13,.13,.13,i%2?0xfff4ce:bright,3,_dyn);
    }
    _dynLabel.label=.35;
    r.add('ripple',ax,ay+.05,az,1.7+.2*Math.sin(time*9),.03,1.7+.2*Math.sin(time*9),0xfff4ce,12,_dynLabel);
  }
  // On screen the crew is a plain figure (helmet, suit, tank, limbs, gun) that
  // the suit textures dress; hit detection keeps the detailed shapes below.
  if (r.seal) {
    drawPlainCrew(r,a,time,{pose,part,soft,limbShape,weapon,gun,torso,armor,hit,tint,bright,yaw,aimYaw,showEffects});
    return;
  }
  const accent=[0xe0c88f,0xb5d7cb,0x9eb8d0,0xe2a47d][(a.index??0)%4];
  const visor=a.team===0?0x4c8c99:0x825650;
  part(soft,0,.99,-.025,.66,.62,.44,armor,2,.13);
  part(soft,0,1.13,.063,.61,.34,.43,tint,20);
  part(soft,0,1.18,.272,.36,.16,.062,hit,30);
  part(soft,0,.80,.186,.54,.14,.17,GRAPHITE,21);
  part('bevel',0,.824,.284,.169,.080,.045,accent,4);
  part(soft,0,1.402,.014,.38,.19,.34,GRAPHITE,21);
  part('orb',0,1.716,-.012,.665,.565,.618,armor,20,.10);
  part('orb',0,1.891,-.025,.601,.207,.546,tint,20,.15);
  part(soft,0,1.814,-.162,.476,.112,.308,tint,20,.075);
  part('bevel',0,1.719,.267,.609,.252,.206,0x182a34,4,.055);
  part('bevel',0,1.714,.349,.529,.179,.101,visor,8,.068);
  part('bevel',0,1.812,.310,.51,.040,.147,accent,20);
  part(soft,0,1.506,.267,.426,.158,.214,0x314851,21,-.07);
  part('box',0,1.522,.372,.259,.050,.026,0x1c2931,4);
  if (hi) {
    part('box',0,1.664,.392,.44,.009,.012,bright,3,.068);
    part('box',0,1.715,.395,.47,.12,.004,0x0e1a20,8,.068);
    part('ring',0,1.80,-.02,.63,.05,.58,0x1a262c,4);
    part('box',0,1.18,.30,.018,.15,.012,TRIM,4);
    for (const dy of [.86,.91]) part('box',0,dy,.268,.50,.012,.02,0x1b2529,21);
  }
  for (const sign of [-1,1]) {
    part(soft,sign*.256,1.647,.267,.164,.236,.206,GRAPHITE,20);
    part('cylinder',sign*.320,1.685,.009,.228,.098,.228,tint,20);
    part(soft,sign*.326,1.68,.039,.102,.164,.229,armor,4);
    part('box',sign*.330,1.712,.157,.071,.064,.039,bright,3);
    const curl=Math.sin(time*4+a.index+sign)*.1;
    part(limbShape,sign*.225,1.442,-.180,.144,.318,.143,bright,9,.24+curl);
    part('orb',sign*.218,1.301,-.218,.105,.141,.132,tint,9);
    for (const dz of [-.06,.02,.10]) part('box',sign*.161,1.546,.344+dz*.35,.044,.031,.013,TRIM,4);
    part(soft,sign*.225,1.074,.246,.119,.270,.085,armor,21);
    part('box',sign*.23,1.154,.293,.055,.084,.019,accent,3);
    if (hi) {
      part('cylinder',sign*.378,1.685,.009,.11,.012,.11,0x9aa7a4,4);
      part(soft,sign*.21,.82,.20,.13,.12,.07,GRAPHITE,21);
      part('box',sign*.12,1.10,.285,.03,.30,.012,0x1d282c,21,.05);
    }
  }
  part(soft,0,1.989,-.086,.121,.042,.323,accent,20);
  const capacity=a.tankMax ?? BASE_TANK, expanded=capacity>BASE_TANK;
  const tankHeight=expanded?1.11:.79, fill=tankHeight*.70*clamp(a.tank/capacity,0,1);
  part(soft,0,1.13,-.294,.53,.57,.218,armor,21);
  part('bevel',0,1.125,-.458,.463,tankHeight,.31,hi?0x3a474b:0x778d90,4);
  if (!hi) part('bevel',0,1.125,-.557,.362,tankHeight*.82,.176,visor,8);
  for (const sign of [-1,1]) {
    part(soft,0,1.125+sign*(tankHeight*.50-.05),-.463,.479,.12,.285,armor,20);
    part('bevel',sign*.198,1.125,-.551,.073,tankHeight*.74,.134,accent,4);
    part('box',0,1.125+sign*tankHeight*.33,-.648,.305,.034,.025,TRIM,4);
  }
  part('bevel',0,1.125,-.657,.086,tankHeight*.75,.029,GRAPHITE,4);
  if (fill>.003) part('box',0,1.125+(fill-tankHeight*.70)*.5,-.678,.045,fill,.020,bright,3);
  if (hi) {
    // A clear canister: dark liner, sloshing ink column, glass front.
    const inner=tankHeight*.74, level=clamp(a.tank/capacity,0,1), slosh=Math.sin(time*5.3+a.index)*.05*(pace+.2);
    part('box',0,1.125,-.535,.33,inner+.02,.05,0x10181b,21);
    if (level>.01) part('box',0,1.125-inner*.5+inner*level*.5,-.585,.31,inner*level,.09,bright,9,slosh*.2);
    part('glass',0,1.125,-.636,.35,inner+.03,1,0xd8f0ea,17);
    part('box',0,1.125+tankHeight*.38,-.47,.08,.05,.08,0x9aa7a4,4);
  }
  for (const sign of [-1,1]) {
    const step=swing*sign*pace;
    const forwardStep=airborne?sign*(rising?.20:.12):fore*step*.39;
    const sideStep=airborne?sign*.055:lateral*step*.31;
    const lift=airborne?(rising?.27:.12)+sign*.045:Math.max(0,transfer*sign)*pace*.17;
    const planted=a.feet && !airborne && !a.isPlayer;
    const base=sign<0?0:4;
    const hip=[sign*.175+sway*.24,.753+rise*(planted?.61:.43),lean*.25];
    const foot=[sign*.185+sideStep,.112+lift,.10+forwardStep];
    const ankle=[foot[0],foot[1]+.112,foot[2]-.065];
    const knee=[mix(hip[0],ankle[0],.53),mix(hip[1],ankle[1],.49),
      mix(hip[2],ankle[2],.45)+(rising?.19:.065)+crouch*.18];
    if (planted) {
      const bootYaw=Math.PI-a.feet[base+3],fx=Math.sin(bootYaw),fz=Math.cos(bootYaw);
      const x=a.feet[base],y=a.feet[base+1]+.060,z=a.feet[base+2];
      const ankle=[x-fx*.064,y+.111,z-fz*.064];
      const knee=limbJoint(loc(...hip),ankle,.383,.370,[fx,.09,fz]);
      r.beam(loc(...hip),knee,.25,.26,GRAPHITE,31,{dynamic:true,shape:limbShape});
      r.beam(knee,ankle,.21,.23,hit,30,{dynamic:true,shape:limbShape});
      const part=(type,x,y,z,w,h,d,color,mat)=>r.add(type,x,y,z,w,h,d,color,mat,{dynamic:true,yaw:bootYaw});
      part(soft,...knee,.242,.236,.260,GRAPHITE,21);
      part(soft,knee[0]+fx*.127,knee[1],knee[2]+fz*.127,.148,.121,.047,tint,20);
      part(soft,x,y,z,.299,.19,.475,BOOT,21);
      part('bevel',x,y-.063,z,.304,.063,.473,0x202e37,21);
      part(soft,x+fx*.166,y+.007,z+fz*.166,.274,.105,.139,tint,20);
      part('box',x+fx*.13,y+.075,z+fz*.13,.151,.042,.094,accent,20);
      if (hi) {
        part('box',x,y-.038,z,.31,.018,.478,0xb9bdb3,21);
        part(soft,x-fx*.16,y+.05,z-fz*.16,.24,.13,.12,0x1c272b,21);
      }
    } else {
      r.beam(loc(...hip),loc(...knee),.25,.26,GRAPHITE,31,{dynamic:true,shape:limbShape});
      r.beam(loc(...knee),loc(...ankle),.21,.23,hit,30,{dynamic:true,shape:limbShape});
      part(soft,...knee,.242,.236,.260,GRAPHITE,21);
      part(soft,knee[0],knee[1],knee[2]+.127,.148,.121,.047,tint,20);
      const bootPitch=airborne?(rising?-.32:.16):transfer*sign*pace*.14;
      part(soft,...foot,.299,.19,.475,BOOT,21,bootPitch);
      part('bevel',foot[0],foot[1]-.062,foot[2],.304,.063,.473,0x202e37,21,bootPitch);
      part(soft,foot[0],foot[1]+.005,foot[2]+.166,.274,.105,.139,tint,20,bootPitch);
      part('box',foot[0],foot[1]+.075,foot[2]+.13,.151,.042,.094,accent,20,bootPitch);
      if (hi) {
        part('box',foot[0],foot[1]-.037,foot[2],.31,.018,.478,0xb9bdb3,21,bootPitch);
        part(soft,foot[0],foot[1]+.05,foot[2]-.16,.24,.13,.12,0x1c272b,21,bootPitch);
      }
    }
    const armSwing=sign>0?-step*.14:0;
    const armLift=airborne?.07:armSwing*.28-crouch*.035;
    part(soft,sign*.331,1.241,.023,.294,.267,.322,tint,20);
    part(soft,sign*.400,1.237,.032,.158,.193,.252,armor,21);
    part('box',sign*.385,1.263,.158,.12,.041,.025,accent,4);
    const hand=weapon.roller?loc(sign*.25,1.13,.40):gun.at(...(sign<0?[-.416,1.22,.44]:[-.285,1.18,.66]));
    const shoulder=torso(sign*.331,1.241,.023);
    const elbow=planted || a.brace>0?limbJoint(shoulder,hand,.371,.415,[sign*cy,-.58,-sign*sy]):
      loc(sign*.386,1.06+armLift,.22+armSwing);
    r.beam(shoulder,elbow,.19,.21,tint,30,{dynamic:true,shape:limbShape});
    r.beam(elbow,hand,.165,.18,hit,30,{dynamic:true,shape:limbShape});
    r.add('orb',...elbow,.192,.185,.194,tint,30,{dynamic:true,yaw});
    if (hi) {
      const wrist=add(hand,scale(unit(sub(elbow,hand)),.07));
      r.add('cylinder',...wrist,.15,.05,.15,0x1c272b,21,{dynamic:true,basis:limbBasis(sub(hand,elbow))});
      r.add('soft',...hand,.19,.16,.21,BOOT,21,{dynamic:true,yaw});
      r.add('soft',...add(hand,[sign*cy*.07,.025,-sign*sy*.07]),.07,.06,.11,BOOT,21,{dynamic:true,yaw});
    } else r.add('orb',...hand,.20,.19,.22,BOOT,21,{dynamic:true,yaw});
  }
  if (weapon.roller) {
    const {y:headY,z:headZ}=rollerPosition(a);
    const axis=[cy,0,-sy], up=[0,1,0], axes=[up,axis,cross(up,axis)];
    const position=loc(0,headY,headZ);
    r.add('cylinder',...position,.62,1.76,.62,bright,9,{dynamic:true,basis:axes});
    const spin=a.rolling?a.steps*.83:0, facing=[sy,0,cy];
    for (let i=0;i<3;i++) {
      const angle=spin+i*TAU/3, radial=add(scale(up,Math.cos(angle)),scale(facing,Math.sin(angle)));
      const seam=add(position,scale(radial,.313));
      r.add('box',...seam,1.63,.013,.035,tint,9,{dynamic:true,basis:[axis,radial,cross(axis,radial)]});
    }
    for (const sign of [-1,1]) {
      r.add('cylinder',...loc(sign*.88,headY,headZ),.64,.086,.64,GRAPHITE,4,{dynamic:true,basis:axes});
      r.beam(loc(sign*.88,headY,headZ),loc(sign*.88,headY+.33,headZ-.16),.055,.055,TRIM,4,{dynamic:true});
    }
    r.beam(loc(-.88,headY+.33,headZ-.16),loc(.88,headY+.33,headZ-.16),.065,.065,TRIM,4,{dynamic:true});
    r.beam(loc(0,headY+.33,headZ-.16),loc(0,1.13,.40),.075,.075,GRAPHITE,4,{dynamic:true});
    part('box',0,1.13,.40,.57,.12,.14,BOOT,4);
    return;
  }
  const long=weapon.id==='charge', wide=weapon.id==='fan' || weapon.id==='autoeima' || weapon.id==='autoeima2s', heavy=weapon.id==='lob', dual=weapon.id==='dual';
  const quad=weapon.id==='rd2', cannon=weapon.id==='td';
  const barrel=gun.barrel;
  const width=cannon?.37:quad?.34:heavy?.33:wide?.30:.235;
  const gunPart=(type,x,y,z,w,h,d,color,mat=4,pitch=0)=>r.add(type,...gun.at(x,y,z),w,h,d,color,material(mat,color),
    {dynamic:true,yaw:aimYaw,pitch:pitch+gun.pitch});
  gunPart('bevel',-.415,1.30,.474,dual?.35:width,heavy || quad || cannon?.29:.222,.565,GRAPHITE);
  gunPart('box',-.415,1.341,.49,dual?.37:width+.02,.137,.408,tint);
  if (quad) {
    // RD II QUATRO+: four barrels in a square around a fifth, under a heavy shroud.
    for (const [bx,by] of [[-.085,.075],[.085,.075],[-.085,-.075],[.085,-.075],[0,0]]) {
      gunPart('cylinder',-.415+bx,1.30+by,.69+barrel*.30,.085,barrel,.085,TRIM,4,Math.PI/2);
      gunPart('cylinder',-.415+bx,1.30+by,.70+barrel*.82,.058,.03,.058,bright,9,Math.PI/2);
    }
    gunPart('bevel',-.415,1.30,.66+barrel*.55,.30,.27,.13,BOOT);
    gunPart('bevel',-.415,1.30,.60,.33,.30,.11,GRAPHITE);
    gunPart('box',-.415,1.47,.50,.07,.07,.36,tint);
    gunPart('orb',-.415,1.12,.52,.20,.17,.30,tint,9);
  } else if (cannon) {
    // TD: a short, wide shock cannon with a flared mouth.
    gunPart('cylinder',-.415,1.30,.69+barrel*.30,.30,barrel,.30,TRIM,4,Math.PI/2);
    gunPart('cone',-.415,1.30,.62+barrel*.95,.50,.26,.50,BOOT,4,-Math.PI/2);
    gunPart('cylinder',-.415,1.30,.70+barrel*.86,.33,.04,.33,bright,9,Math.PI/2);
    for (const side of [-1,1]) gunPart('box',-.415+side*.20,1.30,.56,.05,.20,.34,tint);
    gunPart('orb',-.415,1.49,.47,.22,.17,.28,tint,9);
  } else if (!dual) {
    gunPart('cylinder',-.415,1.30,.69+barrel*.30,heavy?.245:.138,barrel,heavy?.245:.138,TRIM,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.67+barrel*.85,heavy?.32:wide?.25:.211,.093,heavy?.32:wide?.25:.211,BOOT,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.721+barrel*.85,heavy?.245:.125,.035,heavy?.245:.125,bright,9,Math.PI/2);
  }
  if (wide) for (const side of [-1,1]) gunPart('cylinder',-.415+side*.14,1.296,.78,.088,.26,.088,TRIM,4,Math.PI/2);
  if (long) gunPart('box',-.415,1.448,.524,.105,.096,.28,BOOT);
  if (heavy) gunPart('orb',-.414,1.51,.44,.263,.24,.31,tint,9);
  gunPart('box',-.415,1.205,.359,.125,.207,.17,BOOT,4,-.20);
  for (const sign of [-1,1]) {
    const edge=(dual?.35:width)*.5;
    gunPart('box',-.415+sign*(edge+.011),1.345,.437,.022,.045,.237,TRIM);
    gunPart('orb',-.415+sign*(edge+.025),1.275,.48,.027,.027,.028,0xcbbf9e);
  }
  if (hi) {
    gunPart('box',-.415,1.418,.47,.05,.03,.30,0x1c272b,4);
    gunPart('box',-.415,1.418,.36,.075,.06,.07,0x111a1e,8);
    gunPart('box',-.415+(dual?.36:width)*.5+.004,1.30,.50,.004,.05,.20,bright,3);
  }
  if (long) {
    gunPart('cylinder',-.415,1.49,.52,.109,.32,.109,GRAPHITE,4,Math.PI/2);
    gunPart('cylinder',-.415,1.49,.688,.081,.025,.081,0xacc7bd,8,Math.PI/2);
    for (let i=0;i<4;i++) gunPart('box',-.415,1.38,.74+i*.078,.13,.025,.022,BOOT);
  }
  if (dual) for (const sign of [-1,1]) {
    gunPart('cylinder',-.415+sign*.13,1.30,.80,.095,.34,.095,TRIM,4,Math.PI/2);
    gunPart('cylinder',-.415+sign*.13,1.30,.99,.14,.047,.14,GRAPHITE,4,Math.PI/2);
    gunPart('cylinder',-.415+sign*.13,1.30,1.015,.080,.019,.080,bright,9,Math.PI/2);
  }
  if (weapon.id==='coil') for (let i=0;i<5;i++)
    gunPart('cylinder',-.415,1.30,.60+i*.073,.26-i*.018,.032,.26-i*.018,TRIM,4,Math.PI/2);
  if (weapon.id==='surge') for (const sign of [-1,0,1])
    gunPart('cylinder',-.415+sign*.10,1.45,.41,.08,.26,.08,bright,9);
  if (weapon.id==='prism') {
    gunPart('bevel',-.415,1.39,.48,.20,.17,.33,0xbad7ca,8);
    for (const sign of [-1,1]) gunPart('box',-.415+sign*.124,1.36,.52,.045,.19,.38,TRIM);
  }
  if (weapon.id==='autoeima' || weapon.id==='autoeima2s') {
    gunPart('cylinder',-.415,1.46,.54,.17,.055,.17,GRAPHITE,4);
    gunPart('orb',-.415,1.495,.54,.11,.085,.11,weapon.id==='autoeima2s'?0xff267a:bright,3);
  }
  if (showEffects && (a.recoil>.65 && !a.muzzleBlocked || a.charge>.12)) {
    const flash=a.charge>.12?.071+.095*a.charge:cannon?.46:quad?.27:.14;
    for (const side of dual?[-1,1]:[0]) gunPart('orb',-.415+side*.13,1.30,dual?1.063:.785+barrel*.85,flash,flash,flash*1.7,bright,3);
  }
}

// Upgraded hyper-craft on-screen crew & mechanically animated 16-weapon renderer (hitboxes untouched).
function drawPlainCrew(r,a,time,{pose,part,soft,limbShape,weapon,gun,torso,armor,hit,tint,bright,yaw,aimYaw,showEffects}) {
  const {cy,sy,loc,pace,fore,lateral,airborne,rising,crouch,swing,transfer,rise,sway,lean}=pose;
  const ax=a.x, ay=a.y, az=a.z;
  const lite=!!r.lite || !!r.ultralite;
  const cheater=!!a.isCheater;
  const idx=a.index??0;
  const accent=cheater?0xff267a:[0xe0c88f,0xb5d7cb,0x9eb8d0,0xe2a47d][idx%4];
  const visor=cheater?0xff267a:a.team===0?0x4c9aa8:0x965f52;

  // Expressive procedural motion drivers: breathing, stride counter-twist, hit flinch, head aim-tracking!
  const breath=1+Math.sin(time*3.4+idx)*.024*(1-pace*.55);
  const flinch=a.damageAge<.22?Math.sin((1-a.damageAge/.22)*Math.PI):0;
  const torsoTwist=-swing*pace*.13-flinch*.12;
  const tYaw=yaw+torsoTwist, tcy=Math.cos(tYaw), tsy=Math.sin(tYaw);
  const headDiff=Math.atan2(Math.sin(aimYaw-yaw),Math.cos(aimYaw-yaw));
  const headYaw=yaw+clamp(headDiff,-.68,.68)+torsoTwist*.35;
  const headPitch=clamp(-(a.pitch??0)*.48-lean*.25-flinch*.22,-.46,.42);
  const hcy=Math.cos(headYaw), hsy=Math.sin(headYaw);
  const flinchLean=lean-flinch*.14;
  const upperPart=(type,x,y,z,w,h,d,c,mat=2,pitch=0)=>{
    let upper=(y-.66)*1.06;
    if (upper<0) upper=0; else if (upper>1) upper=1;
    const lx=x+sway*upper, ly=y+rise*upper, lz=z+flinchLean*upper;
    _dynYP.yaw=tYaw;
    _dynYP.pitch=pitch-flinchLean*upper*.48;
    r.add(type,ax+lx*tcy+lz*tsy,ay+ly,az-lx*tsy+lz*tcy,w,h,d,c,mat,_dynYP);
  };
  const headCx=ax+sway*cy+flinchLean*sy, headCy=ay+1.72+rise, headCz=az-sway*sy+flinchLean*cy;
  const chp=Math.cos(headPitch), shp=Math.sin(headPitch);
  const headPart=(type,x,y,z,w,h,d,c,mat=20,pitch=0)=>{
    const dy=y-1.72;
    const ry=dy*chp-z*shp, rz=dy*shp+z*chp;
    _dynYP.yaw=headYaw;
    _dynYP.pitch=pitch+headPitch;
    r.add(type,headCx+x*hcy+rz*hsy,headCy+ry,headCz-x*hsy+rz*hcy,w,h,d,c,mat,_dynYP);
  };

  // ---- 1. Sculpted Armored Torso, Breathing Chestplate, Collar Yoke, Utility Belt & Swaying Hip Tassets ----
  upperPart(soft,0,1.07,0,.64*breath,.72,.44*breath,tint,20,.10);
  upperPart(soft,0,1.15,.22,.41*breath,.23,.085,hit,30,.10);
  upperPart(soft,0,.80,.02,.58,.17,.42,GRAPHITE,21);
  upperPart('bevel',0,.81,.245,.175,.088,.058,accent,4);
  upperPart(soft,0,1.43,.02,.37,.18,.33,GRAPHITE,21);
  if (!lite) {
    // Glowing chest core strip, collarbone armor yoke, twin chest micro-canisters & swaying hip tassets
    upperPart('box',0,1.16,.275,.032,.19,.022,bright,3,.10);
    upperPart('bevel',0,1.34,.14,.50,.085,.34,armor,20,.14);
    for (const sign of [-1,1]) {
      upperPart('box',sign*.18,1.12,.235,.062,.24,.042,armor,21,.10);
      upperPart('cylinder',sign*.22,1.04,.24,.068,.16,.068,bright,9,.12);
      // Articulated hip armor plates swinging dynamically with leg strides!
      const tassetPitch=.08+Math.max(0,swing*sign*pace)*.36+(airborne?.22:0);
      part('bevel',sign*.30,.72,.04,.075,.25,.28,tint,20,tassetPitch);
    }
  }

  // ---- 2. Independently Aim-Tracked Tactical Helmet & Dual 3-Segment Flowing Squid-Hair Plumes! ----
  headPart('orb',0,1.72,-.01,.66,.60,.62,cheater?0x221528:armor,20,.10);
  headPart('orb',0,1.89,-.03,.58,.20,.53,tint,20,.15);
  headPart('bevel',0,1.718,.265,.58,.23,.18,0x17262e,4,.06);
  headPart(soft,0,1.715,.31,.52,.175,.11,visor,cheater?3:8,.068);
  headPart('bevel',0,1.815,.295,.51,.042,.14,accent,20);
  headPart(soft,0,1.985,-.08,.11,.045,.32,accent,20);
  if (!lite) {
    // Chin guard, glowing visor HUD scan-bar, crest vent & glowing ear comms
    headPart('bevel',0,1.53,.24,.38,.12,.18,0x273942,21,-.08);
    headPart('box',0,1.668,.372,.44,.015,.016,bright,3,.068);
    for (const sign of [-1,1]) {
      headPart('cylinder',sign*.33,1.69,.01,.20,.09,.20,tint,20);
      headPart('box',sign*.34,1.71,.14,.06,.055,.035,bright,3);
    }
    // Dual 3-segment flowing animated squid-tentacle hair plumes whipping with velocity & jumps!
    const dragZ=pace*fore*.18+(airborne?.10:0), dragX=-pace*lateral*.15-(a.poseBank??0)*.14;
    const bounceY=airborne?(rising?-.10:.14):Math.abs(swing)*pace*.05+crouch*.08;
    for (const sign of [-1,1]) {
      const wave1=Math.sin(time*(5.4+pace*5.5)+idx+sign*1.1)*(.05+pace*.07);
      const wave2=Math.sin(time*(5.4+pace*5.5)+idx+sign*1.1-1.05)*(.08+pace*.11);
      headPart(limbShape,sign*.22+dragX*.4,1.56+bounceY*.3,-.26-dragZ*.35,.135,.26,.135,bright,9,.26+dragZ*.7+wave1);
      headPart(limbShape,sign*.25+dragX*.85+wave1*.22,1.35+bounceY*.7,-.35-dragZ*.75,.105,.24,.105,tint,9,.36+dragZ*1.1+wave2);
      headPart('orb',sign*.26+dragX*1.15+wave2*.32,1.19+bounceY,-.41-dragZ*1.05,.095,.12,.095,bright,9);
    }
  }

  // ---- 3. Living Glass Ink Tank (Sloshing Ink, Rising Bubbles, Level LEDs & Flexible Feed Hose!) ----
  const capacity=a.tankMax ?? BASE_TANK, tankHeight=capacity>=GIGA_TANK?1.11:capacity>BASE_TANK?.89:.79;
  const tankLevel=clamp((a.tank??capacity)/capacity,0,1);
  const fill=tankHeight*.72*tankLevel;
  upperPart('bevel',0,1.13,-.39,.46,tankHeight,.29,0x3a4a4e,4);
  for (const sign of [-1,1]) {
    upperPart(soft,0,1.13+sign*(tankHeight*.50-.045),-.40,.49,.11,.31,armor,20);
    if (!lite) upperPart('bevel',sign*.20,1.13,-.48,.065,tankHeight*.76,.11,accent,4);
  }
  const tankBot=1.13-tankHeight*.36;
  if (fill>.003) {
    const slosh=Math.sin(time*5.8+idx)*.045*(pace+.22);
    upperPart('box',0,tankBot+fill*.5,-.505,.32,fill,.09,bright,9,slosh*.22);
    upperPart('box',0,tankBot+fill*.5,-.556,.055,fill,.025,bright,3);
    if (!lite && fill>.12) {
      // 2 rising luminous air bubbles floating upward through the ink column!
      for (let b=0;b<2;b++) {
        const bp=(time*(.75+b*.35)+idx*.4+b*.5)%1;
        const by=tankBot+bp*(fill-.05)+.025, bx=Math.sin(time*4+b*3.1)*.08;
        upperPart('orb',bx,by,-.522,.042,.042,.042,0xf6fffc,3);
      }
    }
  }
  if (!lite) {
    upperPart('glass',0,1.13,-.542,.36,tankHeight*.76,1,0xd8f2ec,17);
    // Top pressure relief valve cap (pulses gently when full!) + 4 spine LED ticks
    const fullGlow=tankLevel>.95?3:4;
    upperPart('cylinder',0,1.13+tankHeight*.52,-.40,.14,.075,.14,tankLevel>.95?bright:accent,fullGlow);
    for (let t=0;t<4;t++) {
      const lit=tankLevel>(t+.15)/4;
      upperPart('box',-.245,tankBot+(t+.5)*(tankHeight*.72/4),-.47,.022,.038,.038,lit?bright:0x1b2428,lit?3:4);
    }
    // Flexible curved 2-segment ink feed hose connecting right tank port to weapon receiver!
    if (!weapon.roller && gun) {
      const hoseBaseY=1.13-tankHeight*.24+rise*.65;
      _ptA[0]=ax+(sway*.65-.18)*tcy+(-.40+flinchLean*.65)*tsy;
      _ptA[1]=ay+hoseBaseY;
      _ptA[2]=az-(sway*.65-.18)*tsy+(-.40+flinchLean*.65)*tcy;
      const wPort=gun.at(-.415,1.24,.30);
      const sag=.12+Math.sin(time*5.2+idx)*.022*(pace+.3);
      _ptB[0]=(_ptA[0]+wPort[0])*.5-tcy*.12;
      _ptB[1]=Math.min(_ptA[1],wPort[1])-sag;
      _ptB[2]=(_ptA[2]+wPort[2])*.5+tsy*.12;
      _dynBeam.shape='cylinder';
      r.beam(_ptA,_ptB,.046,.046,bright,9,_dynBeam);
      r.beam(_ptB,wPort,.042,.042,bright,9,_dynBeam);
    }
  }

  // ---- 4. Articulated Legs (Knee/Shin Armor + Treaded Boots) & Arms (Pauldrons, Elbow Pads & Wrist HUD) ----
  _dynBeam.shape=limbShape;
  const planted=!!(a.feet && !airborne && !a.isPlayer);
  for (let sIdx=0;sIdx<2;sIdx++) {
    const sign=sIdx===0?-1:1;
    const step=swing*sign*pace;
    const forwardStep=airborne?sign*(rising?.24:.13):fore*step*.41;
    const sideStep=airborne?sign*.065:lateral*step*.32;
    const lift=airborne?(rising?.31:.14)+sign*.05:Math.max(0,transfer*sign)*pace*.185;
    const base=sIdx===0?0:4;
    const hip=loc(sign*.175+sway*.24,.753+rise*(planted?.61:.43),lean*.25);
    let ankle, fxFoot, fyFoot, fzFoot, bootYaw=yaw, bootPitch=0;
    if (planted) {
      bootYaw=Math.PI-a.feet[base+3];
      const fx=Math.sin(bootYaw), fz=Math.cos(bootYaw);
      fxFoot=a.feet[base]; fyFoot=a.feet[base+1]+.06; fzFoot=a.feet[base+2];
      ankle=[fxFoot-fx*.064,fyFoot+.111,fzFoot-fz*.064];
    } else {
      const lx=sign*.185+sideStep, ly=.112+lift, lz=.10+forwardStep;
      fxFoot=ax+lx*cy+lz*sy; fyFoot=ay+ly; fzFoot=az-lx*sy+lz*cy;
      const lzA=lz-.065;
      ankle=[ax+lx*cy+lzA*sy,ay+ly+.112,az-lx*sy+lzA*cy];
      bootPitch=airborne?(rising?-.36:.18):transfer*sign*pace*.16;
    }
    const bfx=Math.sin(bootYaw), bfz=Math.cos(bootYaw);
    const knee=limbJoint(hip,ankle,.383,.370,[bfx,.09,bfz]);
    r.beam(hip,knee,.26,.27,GRAPHITE,31,_dynBeam);
    r.beam(knee,ankle,.22,.23,hit,30,_dynBeam);
    _dynYP.yaw=bootYaw; _dynYP.pitch=bootPitch;
    r.add(soft,fxFoot,fyFoot,fzFoot,.30,.19,.47,BOOT,21,_dynYP);
    if (!lite) {
      // Sculpted knee pad, shin guard plate, colored boot toe cap, sole tread & heel spur
      r.add(soft,knee[0]+bfx*.115,knee[1],knee[2]+bfz*.115,.155,.135,.065,tint,20,_dynYP);
      const shinX=(knee[0]+ankle[0])*.5+bfx*.095, shinY=(knee[1]+ankle[1])*.5, shinZ=(knee[2]+ankle[2])*.5+bfz*.095;
      r.add('bevel',shinX,shinY,shinZ,.13,.22,.05,armor,20,_dynYP);
      r.add(soft,fxFoot+bfx*.16,fyFoot+.01,fzFoot+bfz*.16,.27,.10,.14,tint,20,_dynYP);
      r.add('box',fxFoot-bfx*.16,fyFoot+.02,fzFoot-bfz*.16,.22,.09,.08,accent,4,_dynYP);
      r.add('box',fxFoot,fyFoot-.065,fzFoot,.31,.05,.48,0x1d272c,21,_dynYP);
    }
    const armSwing=sign>0?-step*.14:0, armLift=airborne?.09:armSwing*.28-crouch*.045;
    const sxLocal=sign*.331+sway*.62, syLocal=1.241+rise*.62, szLocal=.023+flinchLean*.62;
    const shoulder=[ax+sxLocal*tcy+szLocal*tsy,ay+syLocal,az-sxLocal*tsy+szLocal*tcy];
    upperPart(soft,sign*.345,1.245,.02,.29,.265,.32,tint,20);
    if (!lite) {
      upperPart('bevel',sign*.415,1.24,.03,.13,.19,.24,armor,20);
      upperPart('box',sign*.395,1.268,.145,.12,.045,.032,accent,4);
    }
    const hand=weapon.roller?loc(sign*.25,1.13,.40):sign<0?gun.at(-.416,1.22,.44):gun.at(-.285,1.18,.66);
    const elbow=planted || a.brace>0?limbJoint(shoulder,hand,.371,.415,[sign*tcy,-.58,-sign*tsy]):
      loc(sign*.386,1.06+armLift,.22+armSwing);
    r.beam(shoulder,elbow,.19,.21,tint,30,_dynBeam);
    r.beam(elbow,hand,.165,.18,hit,30,_dynBeam);
    _dynYaw.yaw=tYaw;
    if (!lite) {
      // Elbow armor cap + glowing forearm gauntlet wrist HUD band!
      r.add('orb',elbow[0],elbow[1],elbow[2],.195,.185,.195,armor,20,_dynYaw);
      const wx=hand[0]+(elbow[0]-hand[0])*.24, wy=hand[1]+(elbow[1]-hand[1])*.24, wz=hand[2]+(elbow[2]-hand[2])*.24;
      r.add('orb',wx,wy,wz,.165,.165,.165,sign<0?bright:accent,sign<0?3:4,_dynYaw);
    }
    r.add('orb',hand[0],hand[1],hand[2],.20,.19,.22,BOOT,21,_dynYaw);
  }

  // ---- 5. Mechanically Animated High-Craft Bespoke Weapon (All 16 Weapons!) ----
  drawWeaponModel(r,a,time,{pose,loc,part,weapon,gun,tint,bright,armor,accent,aimYaw,showEffects,lite});
}

function drawWeaponModel(r,a,time,{pose,loc,part,weapon,gun,tint,bright,armor,accent,aimYaw,showEffects,lite}) {
  const {cy,sy,pace}=pose;
  const ax=a.x, ay=a.y, az=a.z;
  const capacity=a.tankMax ?? BASE_TANK;
  const inkRatio=clamp((a.tank??capacity)/capacity,0,1);
  const recoil=a.recoil??0, heat=a.heat??0, charge=a.charge??0;

  if (weapon.roller) {
    // High-Craft Street Roller: dynamic wind-up/slam arc, 6 spiral paint bands, dripping ink beads, hydraulic fork & pressure dial!
    const {y:headY,z:headZ}=rollerPosition(a);
    _rolAxis[0]=cy; _rolAxis[1]=0; _rolAxis[2]=-sy;
    _rolFace[0]=sy; _rolFace[1]=0; _rolFace[2]=cy;
    _dynBasis.basis=_rolAxes;
    const px=ax+headZ*sy, py=ay+headY, pz=az+headZ*cy;
    r.add('cylinder',px,py,pz,.65,1.80,.65,bright,9,_dynBasis);
    const spin=a.rolling?a.steps*.92:time*.6+recoil*3.2;
    const bands=lite?2:6, invB=TAU/bands;
    for (let i=0;i<bands;i++) {
      const ang=spin+i*invB, ca=Math.cos(ang), sa=Math.sin(ang);
      _rolRad[0]=sy*sa; _rolRad[1]=ca; _rolRad[2]=cy*sa;
      // cross(axis=[cy,0,-sy], radial) = [sy*ca, -sa, cy*ca]
      _rolCross[0]=sy*ca; _rolCross[1]=-sa; _rolCross[2]=cy*ca;
      _dynBasis.basis=_rolSeamAxes;
      r.add('box',px+_rolRad[0]*.326,py+_rolRad[1]*.326,pz+_rolRad[2]*.326,1.70,.018,.045,i%2?tint:0xf6fffc,i%2?9:3,_dynBasis);
    }
    _dynBasis.basis=_rolAxes;
    _dynBeam.shape='cylinder';
    for (const sign of [-1,1]) {
      const lx=sign*.91;
      const ex=ax+lx*cy+headZ*sy, ez=az-lx*sy+headZ*cy;
      r.add('cylinder',ex,py,ez,.67,.098,.67,GRAPHITE,4,_dynBasis);
      r.add('cylinder',ax+sign*.96*cy+headZ*sy,py,az-sign*.96*sy+headZ*cy,.33,.055,.33,accent,4,_dynBasis);
      _ptA[0]=ex; _ptA[1]=py; _ptA[2]=ez;
      _ptB[0]=ax+lx*cy+(headZ-.16)*sy; _ptB[1]=py+.35; _ptB[2]=az-lx*sy+(headZ-.16)*cy;
      r.beam(_ptA,_ptB,.062,.062,TRIM,4,_dynBeam);
      if (!lite) {
        // Hydraulic shock sleeve on each fork arm
        _ptC[0]=(_ptA[0]+_ptB[0])*.5; _ptC[1]=(_ptA[1]+_ptB[1])*.5; _ptC[2]=(_ptA[2]+_ptB[2])*.5;
        r.add('orb',_ptC[0],_ptC[1],_ptC[2],.10,.10,.10,bright,3,_dyn);
      }
    }
    _ptA[0]=ax-.91*cy+(headZ-.16)*sy; _ptA[1]=py+.35; _ptA[2]=az+.91*sy+(headZ-.16)*cy;
    _ptB[0]=ax+.91*cy+(headZ-.16)*sy; _ptB[1]=py+.35; _ptB[2]=az-.91*sy+(headZ-.16)*cy;
    r.beam(_ptA,_ptB,.074,.074,TRIM,4,_dynBeam);
    _ptC[0]=ax+(headZ-.16)*sy; _ptC[1]=py+.35; _ptC[2]=az+(headZ-.16)*cy;
    _ptD[0]=ax+.40*sy; _ptD[1]=ay+1.13; _ptD[2]=az+.40*cy;
    r.beam(_ptC,_ptD,.082,.082,GRAPHITE,4,_dynBeam);
    if (!lite) {
      // Sculpted splash cowl, glowing pressure dial, and dripping paint beads while rolling!
      _dynYaw.yaw=Math.PI-a.yaw;
      r.add('bevel',_ptC[0],_ptC[1]+.03,_ptC[2],1.76,.058,.18,tint,20,_dynYaw);
      part('cylinder',0,1.13,.40,.15,.15,.15,bright,3);
      if (a.rolling && showEffects) {
        for (let k=0;k<3;k++) {
          const dropPhase=(time*6+k*.33)%1, ox=(k-1)*.58;
          const bx=ax+ox*cy+(headZ-.36-dropPhase*.28)*sy, bz=az-ox*sy+(headZ-.36-dropPhase*.28)*cy;
          const bSize=(1-dropPhase)*.095;
          r.add('orb',bx,py+.14+Math.sin(dropPhase*Math.PI)*.22,bz,bSize,bSize*1.4,bSize,bright,9,_dyn);
        }
      }
    }
    part('box',0,1.13,.40,.58,.12,.14,BOOT,21);
    return;
  }

  const wid=weapon.id, barrel=gun.barrel;
  const gp=gun.pose, gcy=gp.cy, gsy=gp.sy;
  // Living weapon feel: figure-8 idle breath sway + crisp recoil muzzle climb + charge shiver!
  const breathX=Math.sin(time*2.6+(a.index??0))*.008*(1-pace*.5);
  const breathY=Math.sin(time*5.2+(a.index??0))*.006*(1-pace*.5);
  const shiver=charge>.5?(charge-.5)*Math.sin(time*68)*.012:0;
  const climb=recoil*.13;
  const gPitch=gun.pitch+climb;
  const gc=Math.cos(gPitch), gs=Math.sin(gPitch), grec=gun.recoil;
  const gsway=gp.sway*.87+breathX+shiver, grise=1.25+gp.rise*.87+breathY, glean=.437+gp.lean*.87;
  _dynYP.yaw=aimYaw;
  const gunPart=(type,x,y,z,w,h,d,color,mat=4,pitch=0)=>{
    const dy=y-1.25, dz=z-.437-grec;
    const lx=x+gsway, ly=grise+dy*gc-dz*gs, lz=glean+dy*gs+dz*gc;
    _dynYP.pitch=pitch+gPitch;
    r.add(type,ax+lx*gcy+lz*gsy,ay+ly,az-lx*gsy+lz*gcy,w,h,d,color,mat,_dynYP);
  };

  const isPistol=wid==='swout' || wid==='swout2';
  const isCheaterGun=wid==='autoeima2s';
  const isAutoEima=wid==='autoeima' || isCheaterGun;
  const isQuad=wid==='rd2', isCannon=wid==='td', isDual=wid==='dual';
  const isLong=wid==='charge', isHeavy=wid==='lob', isBlast=wid==='blast';
  const isWide=wid==='fan' || isAutoEima;
  const chrome=0xcfd6d2, darkMetal=0x212c32;
  const shellTint=isCheaterGun?0x22102c:tint;
  const glowTint=isCheaterGun?0xff267a:wid==='swout2' && a.coMode?0xffe066:bright;
  const width=isPistol?.18:isCannon?.38:isQuad?.35:isHeavy?.33:isDual?.35:isWide?.31:.235;
  const height=isPistol?.16:isHeavy || isQuad || isCannon?.29:.222;
  const bodyLen=isPistol?.40:.57;
  const slideBack=recoil*.095;

  // ---- Shared Tactical Base: Receiver, Shroud, Grip, Top Rail, Reflex Holo-Sight & Live Ink Gauge ----
  gunPart('bevel',-.415,1.30,.47,width,height,bodyLen,isCheaterGun?0x1b1024:GRAPHITE,4);
  gunPart('bevel',-.415,1.345,.48-slideBack*.5,width+.024,height*.58,bodyLen*.74,shellTint,20);
  gunPart('box',-.415,1.20,.355,.115,.20,.155,BOOT,21,-.22);
  if (!isLong && !isHeavy && !isAutoEima) {
    gunPart('box',-.415,1.30+height*.5+.024,.47,.06,.028,bodyLen*.58,darkMetal,4);
    if (!lite) {
      gunPart('bevel',-.415,1.30+height*.5+.062,.39,.078,.062,.085,darkMetal,4);
      gunPart('box',-.415,1.30+height*.5+.062,.395,.052,.042,.015,glowTint,3);
      // Holographic floating aim dot inside sight window
      gunPart('orb',-.415,1.30+height*.5+.062,.405,.018,.018,.018,0xffffff,3);
    }
  }
  if (!lite && inkRatio>.02) {
    const gx=-.415-width*.5-.016;
    gunPart('box',gx,1.30,.48,.024,.062,.28,darkMetal,4);
    gunPart('box',gx-.006,1.30,.48-(1-inkRatio)*.12,.014,.042,.24*inkRatio,glowTint,3);
  }

  // ---- Mechanically Animated Weapon-Specific 3D Silhouettes (All 16 Weapons!) ----
  if (isAutoEima) {
    // オート英馬 (7-barrel) & チーター違法改造 オート英馬 II Super (9-barrel):
    // Heat-accelerated rotary barrel cluster + sweeping target-lock radar dish + swirling ink drum!
    const ringCount=isCheaterGun?9:7, ringR=isCheaterGun?.105:.095, spinRate=(isCheaterGun?9.5:3.0)+heat*(isCheaterGun?14:9.5);
    const spinBase=time*spinRate;
    for (let k=0;k<ringCount;k++) {
      const ang=k===0?0:(k-1)*TAU/(ringCount-1)+spinBase;
      const bx=k===0?0:Math.cos(ang)*ringR, by=k===0?0:Math.sin(ang)*ringR;
      const kick=k===0?0:recoil*.045*(k%2?1:.4);
      gunPart('cylinder',-.415+bx,1.30+by,.69+barrel*.32-kick,.058,barrel,.058,k===0?glowTint:chrome,k===0?3:4,Math.PI/2);
      if (!lite) gunPart('cylinder',-.415+bx,1.30+by,.70+barrel*.84-kick,.044,.025,.044,glowTint,9,Math.PI/2);
    }
    gunPart('cylinder',-.415,1.30,.68+barrel*.62,.275,.075,.275,darkMetal,4,Math.PI/2);
    gunPart('ring',-.415,1.30,.70+barrel*.82,.30+recoil*.035,.032,.30+recoil*.035,glowTint,3,Math.PI/2);
    // Swirling under-barrel ink drum
    gunPart('cylinder',-.415,1.14,.55,.22,.22,.22,glowTint,9,Math.PI/2);
    gunPart('cylinder',-.415,1.14,.55,.235,.06,.235,darkMetal,4,Math.PI/2);
    // Actively sweeping target-tracking radar dish + pulsing lock orb!
    const dishSweep=Math.sin(time*(isCheaterGun?11:4.8));
    gunPart('cylinder',-.415,1.455,.53,.19,.042,.19,darkMetal,4);
    gunPart('box',-.415,1.488,.53,.22,.028,.048,chrome,4,dishSweep*.24);
    gunPart('orb',-.415,1.522,.53,.115+heat*.03,.098+heat*.02,.115+heat*.03,glowTint,3);
    if (!lite) gunPart('ring',-.415,1.528,.53,.21+.03*dishSweep,.02,.21+.03*dishSweep,isCheaterGun?0xffd066:glowTint,3);
    if (isCheaterGun && !lite) {
      // 3 counter-rotating overclocked crimson-gold breach energy coils + pulsing aura!
      for (let i=0;i<3;i++) {
        const pulseR=.33+.025*Math.sin(time*16+i*2.1);
        gunPart('ring',-.415,1.30,.56+i*.125,pulseR,.028,pulseR,i%2?0xffd066:0xff267a,3,Math.PI/2);
      }
      gunPart('ring',-.415,1.545,.53,.28,.026,.28,0xff267a,3);
    }
  } else if (isQuad) {
    // RD II QUATRO+: 5 heavy barrels with staggered recoil, spinning breech overdrive ring & glowing vents!
    const bPos=[[-.09,.08],[.09,.08],[-.09,-.08],[.09,-.08],[0,0]];
    for (let k=0;k<5;k++) {
      const [bx,by]=bPos[k];
      const stag=k===4?recoil*.06:recoil*.05*(Math.sin(time*38+k*1.6)*.5+.5);
      gunPart('cylinder',-.415+bx,1.30+by,.69+barrel*.32-stag,.088,barrel,.088,k===4?glowTint:chrome,k===4?3:4,Math.PI/2);
      gunPart('cylinder',-.415+bx,1.30+by,.70+barrel*.86-stag,.062,.034,.062,glowTint,9,Math.PI/2);
    }
    gunPart('bevel',-.415,1.30,.66+barrel*.56,.32,.29,.12,darkMetal,4);
    gunPart('bevel',-.415,1.30,.60,.35,.32,.11,GRAPHITE,4);
    gunPart('box',-.415,1.48,.50,.085,.075,.38,tint,20);
    gunPart('orb',-.415,1.11,.54,.24,.20,.34,bright,9);
    if (!lite) {
      const rr=.36+recoil*.04;
      gunPart('ring',-.415,1.30,.69+barrel*.78,rr,.032,rr,glowTint,3,Math.PI/2);
      // Glowing side cooling vents intensifying with heat!
      for (const s of [-1,1]) gunPart('box',-.415+s*.185,1.31,.58,.018,.12,.22,heat>.12?0xffd066:glowTint,3);
    }
  } else if (isCannon) {
    // TD Shock Cannon: wide acoustic blast horn + 4 flaring pneumatic shock-petals + levitating throat orb!
    gunPart('cylinder',-.415,1.30,.68+barrel*.28,.31,barrel,.31,chrome,4,Math.PI/2);
    gunPart('cone',-.415,1.30,.62+barrel*.96,.54+recoil*.08,.29,.54+recoil*.08,darkMetal,4,-Math.PI/2);
    gunPart('ring',-.415,1.30,.69+barrel*.92,.44+recoil*.10,.048,.44+recoil*.10,glowTint,3,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.70+barrel*.84,.34,.05,.34,bright,9,Math.PI/2);
    // Floating pulsing acoustic orb inside cannon throat
    const coreS=.15+.04*Math.sin(time*10)+recoil*.10;
    gunPart('orb',-.415,1.30,.72+barrel*.88,coreS,coreS,coreS,0xfff6d8,3);
    if (!lite) {
      // 4 expanding petal baffles that kick outward on shot!
      const flare=.23+recoil*.075;
      for (let k=0;k<4;k++) {
        const ang=k*Math.PI/2+Math.PI/4;
        gunPart('bevel',-.415+Math.cos(ang)*flare,1.30+Math.sin(ang)*flare,.72+barrel*.82,.09,.09,.18,tint,20);
      }
    }
    for (const side of [-1,1]) {
      gunPart('bevel',-.415+side*.22,1.30,.56,.06,.22,.36,tint,20);
      if (!lite) gunPart('box',-.415+side*.255,1.30,.58,.02,.08,.26,glowTint,3);
    }
    gunPart('orb',-.415,1.50,.47,.24,.18,.30,bright,9);
  } else if (isPistol) {
    // SW OUT & SW OUT II: reciprocating blowback slide exposing glowing chamber + deployable CO-mode wing fins!
    const isTwo=wid==='swout2';
    const bLen=isTwo?.36:.26;
    gunPart('bevel',-.415,1.335,.49-slideBack*1.25,.185,.105,.44,isTwo?chrome:tint,isTwo?4:20);
    if (slideBack>.015 && !lite) {
      // Exposed glowing plasma chamber visible when blowback slide snaps back!
      gunPart('box',-.415,1.345,.52,.11,.055,.12,glowTint,3);
    }
    for (const by of [-.035,.038]) {
      gunPart('cylinder',-.415,1.305+by,.66+bLen*.3,.058,bLen,.058,darkMetal,4,Math.PI/2);
      gunPart('cylinder',-.415,1.305+by,.67+bLen*.8,.040,.025,.040,glowTint,3,Math.PI/2);
    }
    gunPart('bevel',-.415,1.215,.57,.09,.07,.20,darkMetal,4);
    gunPart('orb',-.415,1.215,.685,.045,.045,.045,glowTint,3);
    if (isTwo) {
      gunPart('bevel',-.415,1.305,.68+bLen*.55,.16,.14,.16,darkMetal,4);
      // Deployable stabilizer fins that physically unfold wider & glow gold in CO mode!
      const wingSpread=a.coMode?.145:.105, wingH=a.coMode?.095:.065;
      for (const side of [-1,1]) gunPart('box',-.415+side*wingSpread,1.33,.66,.026,wingH,.24,glowTint,3);
      if (a.coMode && showEffects) {
        const pulse=.24+.03*Math.sin(time*14);
        gunPart('ring',-.415,1.305,.68+bLen*.85,pulse,.026,pulse,0xffe066,3,Math.PI/2);
      }
    }
  } else if (isDual) {
    // Dual Shooter: alternating staggered reciprocating twin barrels + twin sloshing pods!
    for (const sign of [-1,1]) {
      const altKick=recoil*(sign<0?.085:.045)*(Math.sin(time*44+sign)*.4+.6);
      gunPart('cylinder',-.415+sign*.13,1.30,.79-altKick,.098,.36,.098,chrome,4,Math.PI/2);
      gunPart('cylinder',-.415+sign*.13,1.30,.99-altKick,.148,.055,.148,darkMetal,4,Math.PI/2);
      gunPart('cylinder',-.415+sign*.13,1.30,1.02-altKick,.085,.025,.085,bright,9,Math.PI/2);
      if (!lite) {
        const podBob=Math.sin(time*6+sign)*.012;
        gunPart('orb',-.415+sign*.15,1.42+podBob,.47,.085,.085,.22,bright,9);
      }
    }
    gunPart('box',-.415,1.30,.85,.26,.045,.07,darkMetal,4);
  } else if (isLong) {
    // Charger Rail Sniper: 4 physically expanding magnetic rail clamps + spinning muzzle focusing ring + optic glint!
    gunPart('cylinder',-.415,1.30,.69+barrel*.32,.125,barrel,.125,chrome,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.67+barrel*.88,.21,.10,.21,darkMetal,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.73+barrel*.88,.12,.04,.12,bright,9,Math.PI/2);
    gunPart('box',-.415,1.44,.52,.09,.07,.24,darkMetal,4);
    gunPart('cylinder',-.415,1.50,.53,.112,.36,.112,GRAPHITE,4,Math.PI/2);
    gunPart('cylinder',-.415,1.50,.715,.088,.025,.088,0x9ee6df,8,Math.PI/2);
    // 4 magnetic accelerator coils physically opening outward & lighting sequentially with charge!
    for (let i=0;i<4;i++) {
      const lit=charge>(i+.2)/4, expand=lit?charge*.028:0;
      gunPart('box',-.415,1.375+expand,.73+i*.092,.145+expand*1.6,.032,.028,lit?0xfff4cf:darkMetal,lit?3:4);
    }
    if (!lite && charge>.15) {
      const fRing=.20+charge*.12;
      gunPart('ring',-.415,1.30,.73+barrel*.86,fRing,.024,fRing,charge>.9?0xfff4cf:bright,3,Math.PI/2);
    }
  } else if (isHeavy) {
    // Lob Cannon: heavy wide-bore mortar with dual compressing pneumatic recoil pistons & bobbing pressurized ink hopper!
    gunPart('cylinder',-.415,1.30,.69+barrel*.30-recoil*.05,.26,barrel,.26,chrome,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.67+barrel*.85-recoil*.05,.34,.11,.34,darkMetal,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.73+barrel*.85-recoil*.05,.25,.04,.25,bright,9,Math.PI/2);
    if (!lite) {
      // Twin pneumatic recoil damper cylinders flanking the barrel
      for (const s of [-1,1]) gunPart('cylinder',-.415+s*.175,1.27,.64+barrel*.25-recoil*.08,.055,.26,.055,accent,4,Math.PI/2);
    }
    const hopBob=Math.sin(time*5.2)*.014*(pace+.25)+recoil*.03;
    gunPart('orb',-.415,1.53+hopBob,.45,.28,.25,.33,bright,9);
    gunPart('ring',-.415,1.42,.45,.24,.045,.24,darkMetal,4);
  } else {
    // Jet / Fan / Blast / Surge / Coil / Prism: precision machined barrels + animated signature mechanisms!
    gunPart('cylinder',-.415,1.30,.69+barrel*.30,isBlast?.21:.14,barrel,isBlast?.21:.14,chrome,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.67+barrel*.85,isWide?.26:isBlast?.29:.21,.095,isWide?.26:isBlast?.29:.21,darkMetal,4,Math.PI/2);
    gunPart('cylinder',-.415,1.30,.725+barrel*.85,isBlast?.21:.125,.038,isBlast?.21:.125,bright,9,Math.PI/2);
    if (wid==='fan') {
      // Triple spread nozzles + animated racking pump-action forend!
      for (const side of [-1,1]) {
        gunPart('cylinder',-.415+side*.145,1.296,.79,.092,.28,.092,chrome,4,Math.PI/2);
        gunPart('cylinder',-.415+side*.145,1.296,.93,.065,.025,.065,bright,9,Math.PI/2);
      }
      const pumpSlide=Math.sin(recoil*Math.PI)*.11;
      gunPart('box',-.415,1.20,.63-pumpSlide,.16,.11,.24,BOOT,21);
    } else if (isBlast) {
      // Flaring blast bell + twin heat-glowing radiator fins!
      const flare=recoil*.05;
      gunPart('cone',-.415,1.30,.74+barrel*.86,.34+flare,.18,.34+flare,darkMetal,4,-Math.PI/2);
      gunPart('ring',-.415,1.30,.72+barrel*.82,.30+flare*1.4,.035,.30+flare*1.4,bright,3,Math.PI/2);
      for (const side of [-1,1]) {
        gunPart('bevel',-.415+side*(.18+flare*.4),1.30,.58,.045,.17,.30,tint,20);
        if (!lite && heat>.08) gunPart('box',-.415+side*.205,1.30,.60,.016,.09,.22,0xffd066,3);
      }
    } else if (wid==='coil') {
      // 5 inductive Tesla rings pulsing & rippling outward along a traveling charge wave!
      const waveIdx=(time*(9+heat*8))%5;
      for (let i=0;i<5;i++) {
        const d=Math.abs(waveIdx-i), pulse=d<.85?1-d/.85:0;
        const rr=(.27-i*.020)+pulse*.035;
        gunPart('ring',-.415,1.30,.59+i*.076,rr,.034,rr,pulse>.35?bright:chrome,pulse>.35?3:4,Math.PI/2);
      }
    } else if (wid==='surge') {
      // 3-vial harmonic wave chamber oscillating in a traveling sine wave + glowing emitter bar!
      for (let k=-1;k<=1;k++) {
        const osc=Math.sin(time*11+k*1.35)*.024*(1+heat*1.5);
        gunPart('cylinder',-.415+k*.105,1.46+osc,.42,.084,.27,.084,bright,9);
        gunPart('cylinder',-.415+k*.105,1.59+osc,.42,.092,.03,.092,darkMetal,4);
      }
      gunPart('bevel',-.415,1.30,.72+barrel*.85,.36,.12,.10,darkMetal,4);
      if (!lite) gunPart('box',-.415,1.30,.77+barrel*.85,.30,.035,.02,bright,3);
    } else if (wid==='prism') {
      // Rotating multi-faceted crystal prism chamber splitting refracted light gleams!
      const pSpin=time*(4.5+heat*11);
      gunPart('bevel',-.415,1.40,.50,.21,.18,.36,0xbdf2e8,8,Math.sin(pSpin)*.22);
      if (!lite) gunPart('orb',-.415,1.40,.50,.11,.11,.22,Math.sin(pSpin*2)>0?0xffffff:bright,3);
      for (const sign of [-1,1]) gunPart('box',-.415+sign*.13,1.36,.55,.046,.19,.42,chrome,4);
      gunPart('ring',-.415,1.30,.71+barrel*.82,.22+recoil*.04,.028,.22+recoil*.04,bright,3,Math.PI/2);
    } else {
      // Jet Shooter: twin pressurized ink tubes with animated traveling energy pulses + collar!
      for (const side of [-1,1]) {
        gunPart('cylinder',-.415+side*.12,1.35,.52,.048,.34,.048,bright,9,Math.PI/2);
        if (!lite) {
          const pulseZ=.38+((time*2.6+(side>0?.5:0))%1)*.28;
          gunPart('orb',-.415+side*.12,1.35,pulseZ,.064,.064,.064,0xf6fffc,3);
        }
      }
      gunPart('ring',-.415,1.30,.66+barrel*.52,.20,.035,.20,accent,4,Math.PI/2);
    }
  }

  // ---- Multi-Layered Starburst Muzzle Flash, Expanding Shock-Ring & Thermal Vapor Sparks ----
  const mz=isDual?1.06:isPistol?.69+(wid==='swout2'?.36:.26)*.88:.77+barrel*.86;
  if (showEffects && (recoil>.54 && !a.muzzleBlocked || charge>.10)) {
    const charging=charge>.10;
    const flash=charging?.088+.135*charge:isCannon?.54:isQuad?.34:isAutoEima?.26:.19;
    const ringExp=charging?2.1:2.2+(1-recoil)*1.6;
    for (const side of isDual?[-1,1]:[0]) {
      const mx=-.415+side*.13;
      gunPart('orb',mx,1.30,mz,flash*.74,flash*.74,flash*1.65,0xffffff,3);
      gunPart('orb',mx,1.30,mz+.04,flash*1.28,flash*1.28,flash*2.2,glowTint,3);
      if (!lite) {
        gunPart('ring',mx,1.30,mz+.03,flash*ringExp,flash*.22,flash*ringExp,charging?0xfff4cf:glowTint,3,Math.PI/2);
      }
    }
  } else if (showEffects && !lite && heat>.24 && !a.muzzleBlocked) {
    // Rising thermal ink-vapor shimmer bead curling above a hot barrel!
    const vp=(time*4.2+(a.index??0))%1;
    const vs=(1-vp)*.055*clamp(heat,0,1);
    gunPart('orb',-.415+Math.sin(time*9)*.025,1.35+vp*.18,mz-.04,vs,vs*1.4,vs,glowTint,3);
  }
}

function limbBasis(axis) {
  const y=unit(axis), ref=Math.abs(y[2])>.93?[1,0,0]:[0,0,1];
  const x=unit(cross(y,ref));
  return [x,y,cross(x,y)];
}
