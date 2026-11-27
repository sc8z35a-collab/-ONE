import {castAABoxAny,castShapeInto,makeShape} from './collision.js';
import {DestructionPhysics} from './destruction.js';
import {sameLevel,UNDER_X,UNDER_Y,zoneOf} from './layout.js';
import {Renderer,STRIDE,add,clamp,packInstance,scale,sub,TAU} from './render.js';

const _stageHit={t:0,nx:0,ny:0,nz:0,shape:null};
const _SHAPE_IDS={box:1,ramp:2,bevel:3,soft:4};
const _SYMMETRIC=new Set(['box','bevel','cylinder','taper','cone','orb','soft','limb','mantle','ring']);

function recordPackedTemplate(fn) {
  const buckets=new Map();
  const rec={
    add(type,x,y,z,w,h,d,tint,kind=0,opts={}) {
      let arr=buckets.get(type);
      if (!arr) {arr=[];buckets.set(type,arr);}
      const o=arr.length;
      arr.length=o+STRIDE;
      packInstance(arr,o,x,y,z,w,h,d,tint,kind,opts,_SHAPE_IDS[type]??0,_SYMMETRIC.has(type));
    },
    beam(...args) {Renderer.prototype.beam.call(this,...args);}
  };
  fn(rec);
  const out=[];
  for (const [type,arr] of buckets) out.push([type,new Float32Array(arr)]);
  return out;
}

// Planked timber (rendered as wood grain, not masonry).
const WOOD=29;

const BLOCKS={
  wood:{hp:70,tint:0xae8158,accent:0xd2ac78},
  clay:{hp:108,tint:0xb17b5f,accent:0xd8b696},
  concrete:{hp:176,tint:0xaeb4aa,accent:0x828d88},
  glass:{hp:26,tint:0x82b7b6,accent:0xdaf6ee}
};
const INK=[0x10d8be,0xff6c33,0x141118];
const EPS=.0001;
const SHARDS=.74;

export function buildBreakableBlocks(world) {
  for (const [id,type,x,y,z,w,h,d] of [
    ['g-wood','wood',-24,0,17.3,1.14,1.01,1.08],
    ['g-clay','clay',7,0,-14.2,1.31,.90,.85],
    ['g-concrete','concrete',33,0,12.75,1.42,1.07,.91],
    ['b-wood','wood',UNDER_X-39,UNDER_Y,21.1,1.14,1.01,1.08],
    ['b-clay','clay',UNDER_X+14,UNDER_Y,27.1,1.31,.90,.85],
    ['b-concrete','concrete',UNDER_X+38,UNDER_Y,6,1.42,1.07,.91],
    ['obj-01','wood',-31.5,0,-12.5,1.25,1.08,1.15],
    ['obj-02','clay',-28.5,0,15.5,1.35,.92,.96],
    ['obj-03','concrete',-22.5,0,-21.2,1.55,1.12,.94],
    ['obj-04','glass',-18.2,0,12.5,1.60,1.65,.22],
    ['obj-05','wood',-10.2,0,-16.2,1.28,1.04,1.12],
    ['obj-06','concrete',-9.8,0,19.4,1.50,1.08,.92],
    ['obj-07','clay',-4.2,0,-22.2,1.34,.95,.90],
    ['obj-08','wood',5.2,0,-19.8,1.22,1.05,1.08],
    ['obj-09','concrete',10.6,0,19.2,1.48,1.10,.95],
    ['obj-10','glass',18.2,0,-19.6,1.65,1.62,.22],
    ['obj-11','clay',22.6,0,-12.4,1.32,.92,.88],
    ['obj-12','wood',28.4,0,-18.2,1.26,1.06,1.10],
    ['obj-13','concrete',31.8,0,13.6,1.46,1.08,.94],
    ['obj-14','clay',35.6,0,-11.2,1.34,.94,.90],
    ['obj-15','wood',-38.4,0,22.4,1.30,1.05,1.14],
    ['obj-16','concrete',38.6,0,22.2,1.52,1.10,.96],
    ['obj-17','wood',UNDER_X-24,UNDER_Y,-15.5,1.24,1.04,1.10],
    ['obj-18','clay',UNDER_X+24.5,UNDER_Y,19.5,1.32,.94,.88],
    ['obj-19','concrete',UNDER_X-10,UNDER_Y,16.5,1.48,1.08,.92],
    ['obj-20','glass',UNDER_X+10,UNDER_Y,-16.2,1.60,1.60,.22]
  ]) world.objects.push({id,type,x,y:y+h/2,z,w,h,d,yaw:0});
}

export function prepareStageObjects(definitions) {
  return definitions.map((o,i)=>{
    const {type,x,y,z,w,h,d,yaw}=o;
    const shape=makeShape(type==='glass'?'glass':'box',x,y,z,w,h,d,type==='glass'?17:2,{yaw});
    return {...o,style:BLOCKS[type],shape,zone:zoneOf(x),_idx:i,_rad:.5*Math.sqrt(w*w+h*h+d*d)+.15};
  });
}

const containsHome=(home,x,y,z)=>y<home.ceiling && y>=-.20 && x>home.x0 && x<home.x1 && z>home.z0 && z<home.z1;

export class StageObjects {
  constructor(world) {
    this.world=world;
    this.homes=world.homes;
    this.parts=world.stageParts;
    this.byId=new Map();
    this.byZone=[[],[],[],[]];
    this.zoneBounds=[null,null,null,null];
    this.broken=new Uint8Array(this.parts.length);
    this.brokenCount=0;
    for (let i=0;i<this.parts.length;i++) {
      const part=this.parts[i];
      if (part._idx===undefined) part._idx=i;
      if (part._rad===undefined) part._rad=.5*Math.sqrt(part.w*part.w+part.h*part.h+part.d*part.d)+.15;
      const z=part.zone ?? zoneOf(part.x);
      this.byId.set(part.id,part);
      this.byZone[z].push(part);
      const s=part.shape;
      let zb=this.zoneBounds[z];
      if (!zb) this.zoneBounds[z]={minX:s.minX,minY:s.minY,minZ:s.minZ,maxX:s.maxX,maxY:s.maxY,maxZ:s.maxZ};
      else {
        if (s.minX<zb.minX) zb.minX=s.minX; if (s.maxX>zb.maxX) zb.maxX=s.maxX;
        if (s.minY<zb.minY) zb.minY=s.minY; if (s.maxY>zb.maxY) zb.maxY=s.maxY;
        if (s.minZ<zb.minZ) zb.minZ=s.minZ; if (s.maxZ>zb.maxZ) zb.maxZ=s.maxZ;
      }
    }
    this.damage=new Map();
    this.destruction=new DestructionPhysics(world);
    if (world?.destructibles) {
      for (const d of world.destructibles) this.destruction.registerStructure(d);
    }
    this._lastViewZ=0;
  }

  snapshot() {
    return Array.from(this.damage,([id,{hp,at,team}])=>[id,hp,at,team]);
  }

  restore(rows=[]) {
    this.damage.clear();
    this.broken.fill(0);
    this.brokenCount=0;
    for (const [id,hp,at,team] of rows) {
      const part=this.byId.get(id);
      if (part && Number.isFinite(hp) && hp>=0) {
        this.damage.set(id,{hp,at,team});
        if (hp===0) {this.broken[part._idx]=1;this.brokenCount++;}
      }
    }
  }

  intact(o) {
    if (!this.brokenCount) return true;
    const idx=o._idx;
    if (idx!==undefined) return this.broken[idx]===0;
    return this.damage.get(o.id)?.hp!==0;
  }

  strike(o,amount,clock,team,hitPos=null,impulse=null) {
    if (!o || !this.intact(o) || !(amount>0)) return;
    const hp=Math.max(0,(this.damage.get(o.id)?.hp??o.style.hp)-amount);
    this.damage.set(o.id,{hp,at:clock,team});
    if (hp===0 && o._idx!==undefined && !this.broken[o._idx]) {
      this.broken[o._idx]=1;
      this.brokenCount++;
      if (this.destruction) {
        const s=this.destruction.registerStructure({
          id:'stage-'+o.id,kind:'object',material:o.type==='glass'?'glass':o.type==='wood'?'wood':o.type==='clay'?'clay':'concrete',
          x:o.x,y:o.y,z:o.z,w:o.w,h:o.h,d:o.d,yaw:o.yaw,tint:o.style.tint,matKind:o.type==='wood'?WOOD:2,hp:1
        });
        this.destruction.applyInkImpact(hitPos?.[0]??o.x,hitPos?.[1]??o.y,hitPos?.[2]??o.z,impulse?.[0]??0,impulse?.[1]??2,impulse?.[2]??0,999,team,o.w+1);
      }
    }
  }

  strikeAt(x,y,z,amount,team,radius=1.5,opts={}) {
    if (!this.destruction || !(amount>0)) return null;
    if (opts.inkRain) return this.destruction.strikeInkRain(x,z,amount,team);
    return this.destruction.applyInkImpact(x,y,z,opts.fx??0,opts.fy??0,opts.fz??0,amount,team,radius);
  }

  strikeTsunami(waveX,width,height,dir,peakPressure,dt) {
    return this.destruction?.strikeTsunami(waveX,width,height,dir,peakPressure,dt)??0;
  }

  update(dt,battle=null) {
    this.destruction?.update(dt,battle);
  }

  trace(start,end,clearance=0,limit=1) {
    const z=zoneOf(start[0]);
    const list=this.byZone[z];
    if (!list.length) return undefined;
    const sx=start[0], sy=start[1], sz=start[2];
    const ex=end[0], ey=end[1], ez=end[2];
    const c=clearance || 0, pad=c*1.733+1e-8;
    const rx0=(sx<ex?sx:ex)-pad, rx1=(sx>ex?sx:ex)+pad;
    const ry0=(sy<ey?sy:ey)-pad, ry1=(sy>ey?sy:ey)+pad;
    const rz0=(sz<ez?sz:ez)-pad, rz1=(sz>ez?sz:ez)+pad;
    const zb=this.zoneBounds[z];
    if (zb && (ry1<zb.minY || ry0>zb.maxY || rx1<zb.minX || rx0>zb.maxX || rz1<zb.minZ || rz0>zb.maxZ)) return undefined;
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    let bestT=limit ?? 1, bestObj=null, bnx=0, bny=0, bnz=0, bShape=null;
    const hasBroken=this.brokenCount>0, broken=this.broken;
    for (let i=0;i<list.length;i++) {
      const o=list[i];
      if (hasBroken && broken[o._idx]) continue;
      const s=o.shape;
      if (ry1<s.minY || ry0>s.maxY || rx1<s.minX || rx0>s.maxX || rz1<s.minZ || rz0>s.maxZ) continue;
      if (castShapeInto(s,sx,sy,sz,dx,dy,dz,bestT,c,_stageHit)) {
        bestT=_stageHit.t;
        bnx=_stageHit.nx; bny=_stageHit.ny; bnz=_stageHit.nz;
        bShape=_stageHit.shape;
        bestObj=o;
      }
    }
    if (!bestObj) return undefined;
    return {
      t:bestT,
      position:[sx+dx*bestT,sy+dy*bestT,sz+dz*bestT],
      normal:[bnx,bny,bnz],
      shape:bShape,
      stageObject:bestObj
    };
  }

  traceAny(sx,sy,sz,ex,ey,ez,limit=1) {
    const z=zoneOf(sx);
    const list=this.byZone[z];
    if (!list.length) return false;
    const rx0=sx<ex?sx:ex, rx1=sx>ex?sx:ex;
    const ry0=sy<ey?sy:ey, ry1=sy>ey?sy:ey;
    const rz0=sz<ez?sz:ez, rz1=sz>ez?sz:ez;
    const zb=this.zoneBounds[z];
    if (zb && (ry1<zb.minY || ry0>zb.maxY || rx1<zb.minX || rx0>zb.maxX || rz1<zb.minZ || rz0>zb.maxZ)) return false;
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    const invDx=(dx>1e-7 || dx<-1e-7)?1/dx:0;
    const invDy=(dy>1e-7 || dy<-1e-7)?1/dy:0;
    const invDz=(dz>1e-7 || dz<-1e-7)?1/dz:0;
    const hasBroken=this.brokenCount>0, broken=this.broken;
    for (let i=0;i<list.length;i++) {
      const o=list[i];
      if (hasBroken && broken[o._idx]) continue;
      const s=o.shape;
      if (ry1<s.minY || ry0>s.maxY || rx1<s.minX || rx0>s.maxX || rz1<s.minZ || rz0>s.maxZ) continue;
      if (s.isAA) {
        if (castAABoxAny(s,sx,sy,sz,invDx,invDy,invDz,limit)) return true;
      } else if (castShapeInto(s,sx,sy,sz,dx,dy,dz,limit,0,_stageHit)) {
        return true;
      }
    }
    return false;
  }

  blocked(x,y,z,radius,height) {
    const list=this.byZone[zoneOf(x)];
    const n=list.length;
    if (!n) return false;
    const r2=radius*radius, hasBroken=this.brokenCount>0, broken=this.broken;
    for (let i=0;i<n;i++) {
      const o=list[i];
      const s=o.shape;
      if (y>=s.maxY-.024 || y+height<=s.minY+.023) continue;
      if (hasBroken && broken[o._idx]) continue;
      const dx=x<s.minX?x-s.minX:x>s.maxX?x-s.maxX:0;
      const dz=z<s.minZ?z-s.minZ:z>s.maxZ?z-s.maxZ:0;
      if (dx*dx+dz*dz<r2) return true;
    }
    return false;
  }

  support(x,y,z,surface) {
    const list=this.byZone[zoneOf(x)];
    const n=list.length;
    if (!n) return surface;
    let top=surface.y;
    const maxY=y+.095, hasBroken=this.brokenCount>0, broken=this.broken;
    for (let i=0;i<n;i++) {
      const o=list[i];
      const s=o.shape;
      if (o.type==='glass' || s.maxY<=top+.12 || s.maxY>maxY ||
          x<=s.minX+.035 || x>=s.maxX-.035 || z<=s.minZ+.035 || z>=s.maxZ-.035) continue;
      if (hasBroken && broken[o._idx]) continue;
      top=s.maxY;
    }
    return top>surface.y?{...surface,y:top,raised:true}:surface;
  }

  canEnter(actor,x,y,z) {
    if (zoneOf(x)!==0 || !actor.apartmentVisits) return true;
    return !this.homes.some(home=>(actor.apartmentVisits & 1<<home.index) && containsHome(home,x,y,z) &&
      !containsHome(home,actor.x,actor.y,actor.z));
  }

  visit(actor,before) {
    if (zoneOf(actor.x)!==0) return;
    for (const home of this.homes) {
      if (containsHome(home,actor.x,actor.y,actor.z) && !containsHome(home,before.x,before.y,before.z)) {
        actor.apartmentVisits=(actor.apartmentVisits??0)|(1<<home.index);
      }
    }
  }

  damageArea(battle,actor,x,y,z,radius,amount) {
    const from=[x,y+.32,z], r2=radius*radius;
    const list=this.byZone[zoneOf(x)];
    for (let i=0;i<list.length;i++) {
      const o=list[i];
      if (!this.intact(o)) continue;
      const ox=o.x-x, oy=o.y-y, oz=o.z-z, d2=ox*ox+oy*oy+oz*oz;
      if (d2>r2) continue;
      const hit=battle.traceShot(from,[o.x,o.y,o.z],true);
      if (hit?.stageObject!==o) continue;
      this.strike(o,amount*(1-.47*Math.sqrt(d2)/radius),battle.clock,actor.team);
    }
    this.destruction?.applySplashDamage(x,y,z,radius,amount,actor.team,Math.max(10,amount*.35));
  }

  draw(renderer,viewX,clock,viewZ=this._lastViewZ) {
    this._lastViewZ=viewZ;
    const list=this.byZone[zoneOf(viewX)];
    const canPack=typeof renderer.addPacked==='function';
    const hasDamage=this.damage.size>0;
    for (let i=0;i<list.length;i++) {
      const o=list[i];
      const state=hasDamage?this.damage.get(o.id):undefined;
      if (state?.hp===0) {
        const age=clock-state.at;
        if (age>=0 && age<SHARDS) drawFragments(renderer,o,state,age);
      } else if (!state && canPack) {
        let tpl=o._packed;
        if (!tpl) tpl=o._packed=recordPackedTemplate(rec=>drawObject(rec,o,undefined));
        for (let k=0;k<tpl.length;k++) renderer.addPacked(tpl[k][0],tpl[k][1],o.x,o.y,o.z,o._rad);
      } else {
        drawObject(renderer,o,state);
      }
    }
    this.destruction?.draw(renderer,viewX,viewZ);
  }
}

function drawObject(r,o,state) {
  const {x,y,z,w,h,d,yaw,type,style}=o;
  const {tint,accent}=style, options={dynamic:true,yaw};
  if (type==='glass') {
    r.add('glass',x,y,z,w,h,1,tint,17,options);
    if (!state) return;
    for (const side of [-1,1]) {
      const base=[x-w*.13,y+h*.11,z+side*.007];
      for (let i=0;i<8;i++) {
        const a=i*TAU/8, length=.40+.07*(i%4);
        const edge=add(base,[Math.cos(a)*w*length*.77,Math.sin(a)*h*length*.72,0]);
        r.beam(base,edge,.012,.009,accent,8,{dynamic:true});
      }
    }
    return;
  }
  r.add('box',x,y,z,w,h,d,tint,type==='wood'?WOOD:2,options);
  if (type==='wood') {
    for (const side of [-1,1]) {
      for (const dy of [-.40,.40]) r.add('box',x,y+h*dy,z+side*(d*.5+.013),w+.03,.13,.042,accent,WOOD,options);
      for (const dx of [-.40,.40]) r.add('box',x+w*dx,y,z+side*(d*.5+.014),.13,h,.043,accent,WOOD,options);
      r.beam([x-w*.38,y-h*.34,z+side*(d*.5+.024)],[x+w*.38,y+h*.34,z+side*(d*.5+.024)],.108,.046,accent,WOOD,{dynamic:true});
    }
  } else if (type==='clay') {
    for (const side of [-1,1]) {
      for (let i=1;i<4;i++) r.add('box',x,y+h*(i/4-.5),z+side*(d*.5+.005),w,.034,.018,accent,2,options);
      for (let i=0;i<4;i++) for (const off of i%2?[-.22,.22]:[0]) {
        r.add('box',x+w*off,y+h*((i+.5)/4-.5),z+side*(d*.5+.006),.036,h*.25,.019,accent,2,options);
      }
    }
  } else {
    for (const side of [-1,1]) {
      r.add('box',x,y+h*.30,z+side*(d*.5+.013),w-.06,.16,.029,accent,2,options);
      for (const off of [-.30,.30]) r.add('box',x+w*off,y+h*.31,z+side*(d*.5+.019),.18,.107,.031,0xbfae73,4,options);
    }
  }
  if (state) {
    const shade=INK[state.team]??INK[2], ratio=1-state.hp/style.hp;
    r.add('splat',x+.07,y+.12,z+d*.5+.032,w*.96*ratio+.17,h*.89,1,shade,9,options);
    r.add('splat',x-.07,y+.12,z-d*.5-.032,w*.96*ratio+.17,h*.89,1,shade,9,{...options,yaw:Math.PI});
  }
}

function drawFragments(r,o,state,age) {
  const {type,x,y,z,w,h,d,style}=o, glass=type==='glass';
  const life=1-age/SHARDS, tint=INK[state.team]??INK[2];
  for (let i=0;i<(r.lite?8:16);i++) {
    const a=i*2.399+(o.x%3), burst=.9+i%5*.33, f=.19+(i%3)*.055;
    const px=x+Math.cos(a)*(w*.28+age*burst), pz=z+Math.sin(a)*(d*.23+age*burst);
    const py=Math.max(y-h*.5+.06,y+h*(i%7/8-.26)+age*(.8+i%4*.39)-age*age*3.65);
    const s=f*Math.max(EPS,life);
    r.add(glass?'bevel':'box',px,py,pz,s,glass?.025:s*.71,s*.83,
      glass?style.accent:i%4===0?tint:style.tint,glass?8:2,{dynamic:true,yaw:a+age*7.5,pitch:age*(i%5+3)});
  }
  if (age<.38) r.add('ripple',x,y,z,.72+age*3.6,.067,.72+age*3.6,tint,12,{dynamic:true,label:age/.38});
}
