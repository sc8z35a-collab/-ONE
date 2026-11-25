import {castShapeInto,makeShape} from './collision.js';
import {STORM_DRAINS} from './fluid-engine.js';
import {BOUNDS,RAIL,UNDER_BOUNDS,UNDER_X,UNDER_Y,ZONES,zoneOf} from './layout.js';
import {drawTrain} from './train-model.js';

const TAU=Math.PI*2;
const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
const mix=(a,b,t)=>a+(b-a)*t;
const smooth=t=>{const c=clamp(t,0,1);return c*c*(3-2*c);};

export const DYNAMIC_STAGE_FIRST=24;

// Dynamic Stage Control System (massive expansion of transit kinematics to entire arena architecture):
// - Hydraulic ground elevation plates (terrainWaves)
// - Descending highway bridge span + ramps (highwayDrop)
// - Deforming spline rail extending into arena + Express Train intrusion (railIntrusion)
// - Bidirectional surface <-> B1 sinkhole shafts + updraft launch vents (sinkholes)
// - Moving & skew-rotating towers/shops warping city geometry (shiftingBuildings)
// - Telegraphing sprouting hydraulic cover walls (risingWalls)
// - Rotating central tectonic turntable bridge (turntable)
export class DynamicStage {
  constructor(world,paint=null) {
    this.world=world;
    this.paint=paint;
    if (world) world.dynamicStage=this;
    this.clock=0;
    this.elapsed=0;
    this.active=false;
    this.alert='';
    this.alertUntil=0;
    this.manualOverride=false;
    this._rayHit={t:0,nx:0,ny:0,nz:0,shape:null};
    this._hiddenStatic=new Set();

    // 1. Moving Ground Elevation Plates (surface plaza/road hydraulic slabs)
    this.plates=[
      {id:'plate-west',x0:-31.5,x1:-19.5,z0:-6.2,z1:6.2,y:0,prevY:0,targetY:0,phase:0,freq:0.42,amp:2.35,bias:0.55,tint:0xb6bcb0,active:false},
      {id:'plate-east',x0:19.5,x1:31.5,z0:-6.2,z1:6.2,y:0,prevY:0,targetY:0,phase:2.1,freq:0.42,amp:2.35,bias:0.55,tint:0xb6bcb0,active:false},
      {id:'plate-north',x0:-9.5,x1:3.5,z0:-24.5,z1:-14.5,y:0,prevY:0,targetY:0,phase:1.05,freq:0.35,amp:1.95,bias:0.25,tint:0xa9b4a8,active:false},
      {id:'plate-south',x0:-9.5,x1:3.5,z0:14.5,z1:24.5,y:0,prevY:0,targetY:0,phase:3.4,freq:0.35,amp:1.95,bias:0.25,tint:0xa9b4a8,active:false}
    ];

    // 2. Descending Highway Deck (lowers central highway span y=12.24 -> y=2.65 with approach aprons)
    this.highway={
      active:false,
      progress:0, // 0 = high (12.24m), 1 = lowered walkable arena bridge (2.65m)
      target:0,
      x:10.9,w:8.4,z0:-26,z1:26,
      yHigh:12.24,yLow:2.65,y:12.24,prevY:12.24,
      rampLen:8.5
    };

    // 3. Deforming Extending Track & Express Train Intrusion across Ground Plaza
    this.railIntrusion={
      active:false,
      trackProgress:0, // 0..1 track deforms & extends into arena
      trackTarget:0,
      trainActive:false,
      s:0, // 0..1 parametric position along intrusion spline
      dir:1,
      speed:13.5,
      wait:0,
      pose:null,
      segments:this._buildRailSpline()
    };

    // 4. Bidirectional Surface <-> Underground B1 Chasm Holes
    this.sinkholes=[
      {id:'hole-west',x:-26,z:14,ux:UNDER_X-26,uz:14,radius:0,maxRadius:3.1,target:0,active:false},
      {id:'hole-east',x:26,z:-14,ux:UNDER_X+26,uz:-14,radius:0,maxRadius:3.1,target:0,active:false}
    ];

    // 5. Shifting & Warping Buildings (detach selected towers/shops and skew them into irregular arena shapes)
    this.shiftingBuildings=[
      {id:'shift-nw',baseId:'tower--41_-45',x:-39,y:8,z:-34,w:9,h:16,d:8.5,dx:0,dz:0,yaw:0,targetDx:6.5,targetDz:12.5,targetYaw:0.36,tint:0xc8bfa8,kind:11,p:0,targetP:0,shape:null,detached:false},
      {id:'shift-se',baseId:'tower-39_45',x:39,y:8,z:34,w:9,h:16,d:8.5,dx:0,dz:0,yaw:0,targetDx:-7.2,targetDz:-12.8,targetYaw:-0.38,tint:0x9eb2b0,kind:11,p:0,targetP:0,shape:null,detached:false},
      {id:'shift-sw',baseId:'street-shop-20',x:-21,y:5.5,z:33.5,w:7.4,h:11,d:6.2,dx:0,dz:0,yaw:0,targetDx:4.8,targetDz:-9.2,targetYaw:0.28,tint:0xb6a994,kind:2,p:0,targetP:0,shape:null,detached:false},
      {id:'shift-ne',baseId:'street-shop-5',x:23,y:5.5,z:-33.5,w:7.4,h:11,d:6.2,dx:0,dz:0,yaw:0,targetDx:-5.2,targetDz:8.8,targetYaw:-0.30,tint:0xa0b0ac,kind:13,p:0,targetP:0,shape:null,detached:false}
    ];

    // 6. Sprouting Hydraulic Cover Walls (walls erupting & retracting across arena floor)
    this.risingWalls=[
      {id:'rwall-wc',x:-17.5,z:0,w:1.1,maxH:3.2,d:8.6,h:0,prevH:0,targetH:0,yaw:0.08,tint:0xc8c3b2,matKind:2,shape:null,telegraph:0},
      {id:'rwall-ec',x:17.5,z:0,w:1.1,maxH:3.2,d:8.6,h:0,prevH:0,targetH:0,yaw:-0.08,tint:0xc8c3b2,matKind:2,shape:null,telegraph:0},
      {id:'rwall-n',x:-4.5,z:-11.5,w:9.2,maxH:3.4,d:1.05,h:0,prevH:0,targetH:0,yaw:-0.14,tint:0x8da19b,matKind:13,shape:null,telegraph:0},
      {id:'rwall-s',x:4.5,z:11.5,w:9.2,maxH:3.4,d:1.05,h:0,prevH:0,targetH:0,yaw:0.14,tint:0x8da19b,matKind:13,shape:null,telegraph:0},
      {id:'rwall-m1',x:0,z:-19.5,w:7.4,maxH:2.8,d:0.95,h:0,prevH:0,targetH:0,yaw:0.24,tint:0xb99a74,matKind:2,shape:null,telegraph:0},
      {id:'rwall-m2',x:0,z:19.5,w:7.4,maxH:2.8,d:0.95,h:0,prevH:0,targetH:0,yaw:-0.24,tint:0xb99a74,matKind:2,shape:null,telegraph:0}
    ];

    // 7. Central Tectonic Turntable Ring (y=2.44 central deck rotates & lifts cover barriers)
    this.turntable={active:false,angle:0,omega:0.35,radius:4.55,y:2.44};

    this._lastDrainSync=false;
    this._schedulePhase=-1;
  }

  _buildRailSpline() {
    // Deforming S-curve rail path descending smoothly from elevated north track (z=-24.85, y=4.65)
    // right through ground plaza [-32..32, z=-4..+4, y=0.35] and curving back up on East end.
    const pts=[
      [-48,4.65,-24.85],
      [-40,4.25,-22.5],
      [-31,2.55,-14.0],
      [-21,0.42,-4.2],
      [-9,0.22,-0.6],
      [0,0.22,0.0],
      [11,0.22,1.2],
      [22,0.55,-3.6],
      [33,2.75,-14.2],
      [42,4.35,-22.6],
      [49,4.65,-24.85]
    ];
    const samples=[], count=28;
    for (let i=0;i<=count;i++) {
      const u=i/count*(pts.length-1);
      const k=Math.min(pts.length-2,Math.floor(u));
      const f=u-k;
      const p0=pts[Math.max(0,k-1)], p1=pts[k], p2=pts[k+1], p3=pts[Math.min(pts.length-1,k+2)];
      // Catmull-Rom smooth rail curvature
      const f2=f*f, f3=f2*f;
      const cr=(a,b,c,d)=>0.5*((2*b)+(-a+c)*f+(2*a-5*b+4*c-d)*f2+(-a+3*b-3*c+d)*f3);
      samples.push({
        x:cr(p0[0],p1[0],p2[0],p3[0]),
        y:cr(p0[1],p1[1],p2[1],p3[1]),
        z:cr(p0[2],p1[2],p2[2],p3[2]),
        yaw:0,pitch:0
      });
    }
    for (let i=0;i<samples.length;i++) {
      const a=samples[Math.max(0,i-1)], b=samples[Math.min(samples.length-1,i+1)];
      const dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z;
      samples[i].yaw=Math.atan2(dx,dz);
      samples[i].pitch=Math.atan2(dy,Math.max(0.01,Math.hypot(dx,dz)));
    }
    return samples;
  }

  sampleRailSpline(s) {
    const segs=this.railIntrusion.segments;
    const u=clamp(s,0,1)*(segs.length-1);
    const i=Math.min(segs.length-2,Math.floor(u));
    const f=u-i;
    const a=segs[i], b=segs[i+1];
    return {
      x:mix(a.x,b.x,f),
      y:mix(a.y,b.y,f),
      z:mix(a.z,b.z,f),
      yaw:mix(a.yaw,b.yaw,f),
      pitch:mix(a.pitch,b.pitch,f)
    };
  }

  reset() {
    this.clock=0;
    this.elapsed=0;
    this.active=false;
    this.alert='';
    this.alertUntil=0;
    this.manualOverride=false;
    this._schedulePhase=-1;
    this._hiddenStatic.clear();
    for (const p of this.plates) {p.y=p.prevY=p.targetY=0;p.active=false;}
    Object.assign(this.highway,{active:false,progress:0,target:0,y:12.24,prevY:12.24});
    Object.assign(this.railIntrusion,{active:false,trackProgress:0,trackTarget:0,trainActive:false,s:0,dir:1,wait:0,pose:null});
    for (const h of this.sinkholes) {h.radius=0;h.target=0;h.active=false;}
    for (const b of this.shiftingBuildings) {b.dx=b.dz=b.yaw=b.p=b.targetP=0;b.shape=null;b.detached=false;}
    for (const w of this.risingWalls) {w.h=w.prevH=w.targetH=w.telegraph=0;w.shape=null;}
    Object.assign(this.turntable,{active:false,angle:0});
    this._syncSinkholeDrains();
  }

  snapshot() {
    if (!this.active && !this.manualOverride) return {active:false};
    const q=n=>Math.round(n*1000)/1000;
    return {
      active:this.active,
      manualOverride:this.manualOverride,
      clock:q(this.clock),
      elapsed:q(this.elapsed),
      alert:this.alert,
      alertUntil:q(this.alertUntil),
      schedulePhase:this._schedulePhase,
      plates:this.plates.map(p=>[q(p.y),p.active?1:0]),
      highway:[this.highway.active?1:0,q(this.highway.progress),q(this.highway.target),q(this.highway.y)],
      rail:[this.railIntrusion.active?1:0,q(this.railIntrusion.trackProgress),q(this.railIntrusion.trackTarget),
        this.railIntrusion.trainActive?1:0,q(this.railIntrusion.s),this.railIntrusion.dir,q(this.railIntrusion.wait)],
      sinkholes:this.sinkholes.map(h=>[q(h.radius),q(h.target),h.active?1:0]),
      buildings:this.shiftingBuildings.map(b=>[q(b.dx),q(b.dz),q(b.yaw),q(b.p),q(b.targetP),b.detached?1:0]),
      walls:this.risingWalls.map(w=>[q(w.h),q(w.targetH),q(w.telegraph)]),
      turntable:[this.turntable.active?1:0,q(this.turntable.angle)]
    };
  }

  restore(snap) {
    if (!snap) return;
    if (!snap.active && !snap.manualOverride && snap.clock===undefined) {
      if (this.active || this.manualOverride) this.reset();
      return;
    }
    this.active=!!snap.active;
    this.manualOverride=!!snap.manualOverride;
    this.clock=snap.clock??0;
    this.elapsed=snap.elapsed??0;
    this.alert=snap.alert??'';
    this.alertUntil=snap.alertUntil??0;
    this._schedulePhase=snap.schedulePhase??-1;
    snap.plates?.forEach((sp,i)=>{
      const p=this.plates[i];
      if (!p) return;
      if (Array.isArray(sp)) {p.y=p.prevY=sp[0]; p.active=!!sp[1];}
      else {p.y=p.prevY=sp.y; p.active=!!sp.active;}
    });
    if (snap.highway) {
      if (Array.isArray(snap.highway)) Object.assign(this.highway,{active:!!snap.highway[0],progress:snap.highway[1],target:snap.highway[2],y:snap.highway[3],prevY:snap.highway[3]});
      else Object.assign(this.highway,{...snap.highway,prevY:snap.highway.y});
    }
    if (snap.rail) {
      if (Array.isArray(snap.rail)) Object.assign(this.railIntrusion,{active:!!snap.rail[0],trackProgress:snap.rail[1],trackTarget:snap.rail[2],trainActive:!!snap.rail[3],s:snap.rail[4],dir:snap.rail[5],wait:snap.rail[6]});
      else Object.assign(this.railIntrusion,{active:!!snap.rail.active,trackProgress:snap.rail.tp??0,trackTarget:snap.rail.tt??0,trainActive:!!snap.rail.ta,s:snap.rail.s??0,dir:snap.rail.dir??1,wait:snap.rail.wait??0});
      this.railIntrusion.pose=this.railIntrusion.trainActive?this.sampleRailSpline(this.railIntrusion.s):null;
    }
    snap.sinkholes?.forEach((sh,i)=>{
      const h=this.sinkholes[i];
      if (!h) return;
      if (Array.isArray(sh)) Object.assign(h,{radius:sh[0],target:sh[1],active:!!sh[2]});
      else Object.assign(h,sh);
    });
    this._syncSinkholeDrains();
    snap.buildings?.forEach((sb,i)=>{
      const b=this.shiftingBuildings[i];
      if (!b) return;
      const detached=Array.isArray(sb)?!!sb[5]:!!sb.detached;
      if (Array.isArray(sb)) Object.assign(b,{dx:sb[0],dz:sb[1],yaw:sb[2],p:sb[3],targetP:sb[4]});
      else Object.assign(b,{dx:sb.dx??0,dz:sb.dz??0,yaw:sb.yaw??0,p:sb.p??0,targetP:sb.targetP??0});
      if (detached) {
        if (!b.detached) this._detachBuilding(b);
        if (smooth(b.p)>0.01) b.shape=makeShape('box',b.x+b.dx,b.y,b.z+b.dz,b.w,b.h,b.d,b.kind,{yaw:b.yaw});
      }
    });
    snap.walls?.forEach((sw,i)=>{
      const w=this.risingWalls[i];
      if (!w) return;
      if (Array.isArray(sw)) Object.assign(w,{h:sw[0],prevH:sw[0],targetH:sw[1],telegraph:sw[2]});
      else Object.assign(w,{h:sw.h??0,prevH:sw.h??0,targetH:sw.targetH??0,telegraph:sw.telegraph??0});
    });
    if (snap.turntable) {
      if (Array.isArray(snap.turntable)) Object.assign(this.turntable,{active:!!snap.turntable[0],angle:snap.turntable[1]});
      else Object.assign(this.turntable,snap.turntable);
    }
  }

  _detachBuilding(b,renderer=null) {
    if (b.detached) return;
    b.detached=true;
    this._ensureStaticHidden(renderer,this.world,'shift-bld-'+b.id,0,b.x-b.w*.65,b.x+b.w*.65,0.1,b.h+4,b.z-b.d*.65,b.z+b.d*.65);
  }

  // Trigger specific dynamic stage deformation (usable both dynamically & in direct tests).
  trigger(kind,enable=true,battle=null) {
    this.manualOverride=true;
    this.active=true;
    switch (kind) {
      case 'terrain':
      case 'plates':
        for (const p of this.plates) p.active=enable;
        if (enable) this._say('⛰ 地盤隆起・地形変動開始！',battle);
        break;
      case 'highway':
      case 'highwayDrop':
        this.highway.active=true;
        this.highway.target=enable?1:0;
        if (enable) this._say('🛣 高速道路アプローチがステージへ降下！',battle);
        break;
      case 'rail':
      case 'railIntrusion':
        this.railIntrusion.active=true;
        this.railIntrusion.trackTarget=enable?1:0;
        if (enable) {
          this.railIntrusion.trainActive=true;
          this.railIntrusion.s=0.05;
          this.railIntrusion.dir=1;
          this._say('🚆 軌道変形！臨時列車がステージ中央へ侵入！',battle);
        }
        break;
      case 'sinkholes':
      case 'holes':
        for (const h of this.sinkholes) {h.active=enable;h.target=enable?1:0;}
        this._syncSinkholeDrains();
        if (enable) this._say('🕳 地上↔地下B1 連絡縦穴が出現！',battle);
        break;
      case 'buildings':
      case 'shiftingBuildings':
        for (const b of this.shiftingBuildings) b.targetP=enable?1:0;
        if (enable) this._say('🏙 都市ビル移動！ステージ形状が歪曲！',battle);
        break;
      case 'walls':
      case 'risingWalls':
        for (const w of this.risingWalls) {
          if (enable) {w.telegraph=0.6;w.targetH=w.maxH;}
          else w.targetH=0;
        }
        if (enable) this._say('🧱 戦術隔壁が地面から隆起！',battle);
        break;
      case 'turntable':
        this.turntable.active=enable;
        if (enable) this._say('⚙ 中央ターンテーブル起動！',battle);
        break;
      case 'all':
        for (const k of ['terrain','highway','rail','sinkholes','buildings','walls','turntable']) this.trigger(k,enable,null);
        if (enable) this._say('⚡ ステージ全域 動的変形モード発動！',battle);
        break;
    }
  }

  _say(msg,battle=null) {
    this.alert=msg;
    this.alertUntil=this.clock+4.6;
    if (battle?.events) {
      battle.events.unshift({label:msg,team:-1,until:battle.clock+4.6});
      battle.events.length=Math.min(battle.events.length,4);
    }
  }

  _syncSinkholeDrains() {
    // Keep STORM_DRAINS synchronized so FluidEngine drains surface water & boss black ink down open sinkholes too!
    for (const h of this.sinkholes) {
      const id='dyn-'+h.id;
      const existing=STORM_DRAINS.findIndex(d=>d.id===id);
      if (h.radius>0.8) {
        if (existing<0) {
          STORM_DRAINS.push({
            kind:'sinkhole',id,sx:h.x,sz:h.z,ux:h.ux,uz:h.uz,
            radius:h.radius,area:Math.PI*h.radius*h.radius*0.45,cd:0.75
          });
        } else {
          STORM_DRAINS[existing].radius=h.radius;
          STORM_DRAINS[existing].area=Math.PI*h.radius*h.radius*0.45;
        }
      } else if (existing>=0) {
        STORM_DRAINS.splice(existing,1);
      }
    }
  }

  _updateSchedule(elapsed,battle) {
    if (this.manualOverride || elapsed<DYNAMIC_STAGE_FIRST) return;
    const cycle=elapsed-DYNAMIC_STAGE_FIRST;
    const phase=Math.floor(cycle/28);
    if (phase===this._schedulePhase) return;
    this._schedulePhase=phase;
    this.active=true;
    const slot=phase%6;
    // Rotate combinations organically through the match so the stage continuously evolves.
    for (const p of this.plates) p.active=(slot===0 || slot===2 || slot===4 || slot===5);
    if (slot===0) {
      for (const w of this.risingWalls) {w.telegraph=1.1;w.targetH=w.maxH;}
      this._say('🧱 地面が波打ち・隔壁が隆起！',battle);
    } else if (slot===1) {
      this.highway.active=true;this.highway.target=1;
      for (const h of this.sinkholes) {h.active=true;h.target=1;}
      this._say('🛣 高速道路降下 & 地下連絡穴 開放！',battle);
    } else if (slot===2) {
      this.railIntrusion.active=true;this.railIntrusion.trackTarget=1;
      this.railIntrusion.trainActive=true;this.railIntrusion.s=0.04;this.railIntrusion.dir=1;
      this.turntable.active=true;
      this._say('🚆 線路変形！臨時列車がステージへ侵入！',battle);
    } else if (slot===3) {
      for (const b of this.shiftingBuildings) b.targetP=1;
      for (const w of this.risingWalls) {w.telegraph=1.0;w.targetH=w.maxH;}
      this._say('🏙 ビル群が移動・ステージ形状が歪曲！',battle);
    } else if (slot===4) {
      this.highway.target=0;
      for (const h of this.sinkholes) {h.active=true;h.target=1;}
      for (const b of this.shiftingBuildings) b.targetP=0.65;
      this._say('🕳 縦穴連結 & 地盤変動フェーズ！',battle);
    } else {
      this.highway.target=1;
      this.railIntrusion.trackTarget=1;this.railIntrusion.trainActive=true;
      for (const b of this.shiftingBuildings) b.targetP=1;
      for (const h of this.sinkholes) {h.active=true;h.target=1;}
      for (const w of this.risingWalls) {w.telegraph=0.8;w.targetH=w.maxH*0.85;}
      this._say('⚡ フル動的ステージ・大規模変形！',battle);
    }
  }

  _ensureStaticHidden(renderer,world,id,zone,x0,x1,y0,y1,z0,z1) {
    if (this._hiddenStatic.has(id)) return;
    this._hiddenStatic.add(id);
    renderer?.hideStaticRegion?.(zone,x0,x1,y0,y1,z0,z1);
    world?.disableRegion?.(zone,x0,x1,y0,y1,z0,z1);
    if (world?.solids) {
      for (const s of world.solids) {
        if (!s || zoneOf(s.min[0])!==zone) continue;
        const cx=(s.min[0]+s.max[0])*.5, cy=(s.min[1]+s.max[1])*.5, cz=(s.min[2]+s.max[2])*.5;
        if (cx>=x0 && cx<=x1 && cy>=y0 && cy<=y1 && cz>=z0 && cz<=z1) {
          world.disableSolid(s);
        }
      }
    }
  }

  step(dt,battle=null) {
    if (dt<=0) return;
    this.clock+=dt;
    if (battle) this.elapsed=battle.elapsed;
    this._updateSchedule(this.elapsed,battle);

    if (!this.active && !this.manualOverride) return;

    const renderer=battle?.world?.r;

    // 1. Update hydraulic terrain elevation plates
    for (const p of this.plates) {
      p.prevY=p.y;
      p.targetY=p.active?(Math.sin(this.clock*p.freq*Math.PI+p.phase)*p.amp+p.bias):0;
      p.y=mix(p.y,p.targetY,1-Math.exp(-dt*3.2));
      if (Math.abs(p.y)<0.005 && !p.active) p.y=0;
      if (Math.abs(p.y)>0.04) {
        this._ensureStaticHidden(renderer,this.world,'plate-gnd-'+p.id,0,p.x0+0.4,p.x1-0.4,-0.3,0.1,p.z0+0.4,p.z1-0.4);
      }
    }

    // 2. Update descending highway deck
    const hw=this.highway;
    hw.prevY=hw.y;
    if (hw.active || hw.progress>0) {
      const rate=0.38*dt;
      if (hw.progress<hw.target) hw.progress=Math.min(hw.target,hw.progress+rate);
      else if (hw.progress>hw.target) hw.progress=Math.max(hw.target,hw.progress-rate);
      hw.y=mix(hw.yHigh,hw.yLow,smooth(hw.progress));
      if (hw.progress>0.01) {
        this._ensureStaticHidden(renderer,this.world,'highway-center',0,hw.x-hw.w*.6,hw.x+hw.w*.6,10.8,13.8,-2.5,2.5);
      }
    }

    // 3. Update extending spline rail & intrusion express train
    const ri=this.railIntrusion;
    if (ri.active || ri.trackProgress>0) {
      const stepT=0.45*dt;
      if (ri.trackProgress<ri.trackTarget) ri.trackProgress=Math.min(ri.trackTarget,ri.trackProgress+stepT);
      else if (ri.trackProgress>ri.trackTarget) ri.trackProgress=Math.max(ri.trackTarget,ri.trackProgress-stepT);

      if (ri.trainActive && ri.trackProgress>=0.85) {
        if (ri.wait>0) {
          ri.wait=Math.max(0,ri.wait-dt);
        } else {
          // Track spline length ~112m, travel smoothly back and forth
          const splineLen=112;
          ri.s+=ri.dir*(ri.speed/splineLen)*dt;
          if (ri.s>=1) {ri.s=1;ri.dir=-1;ri.wait=2.5;}
          else if (ri.s<=0) {ri.s=0;ri.dir=1;ri.wait=2.5;}
        }
        ri.pose=this.sampleRailSpline(ri.s);
      } else {
        ri.pose=null;
      }
    }

    // 4. Update bidirectional floor sinkholes + open-drain fluid percolation link
    let drainsDirty=false;
    for (const h of this.sinkholes) {
      const goal=h.target*h.maxRadius;
      const before=h.radius;
      h.radius=mix(h.radius,goal,1-Math.exp(-dt*2.8));
      if (Math.abs(h.radius)<0.02 && goal===0) h.radius=0;
      if (Math.abs(before-h.radius)>0.08) drainsDirty=true;
      if (h.radius>0.2) {
        this._ensureStaticHidden(renderer,this.world,'hole-gnd-'+h.id,0,h.x-h.maxRadius,h.x+h.maxRadius,-0.35,0.12,h.z-h.maxRadius,h.z+h.maxRadius);
        this._ensureStaticHidden(renderer,this.world,'hole-ceil-'+h.id,1,h.ux-h.maxRadius,h.ux+h.maxRadius,-1.2,0.5,h.uz-h.maxRadius,h.uz+h.maxRadius);
      }
    }
    if (drainsDirty) this._syncSinkholeDrains();

    // 5. Update shifting / twisting buildings warping city shape
    for (const b of this.shiftingBuildings) {
      const rate=0.32*dt;
      if (b.p<b.targetP) b.p=Math.min(b.targetP,b.p+rate);
      else if (b.p>b.targetP) b.p=Math.max(b.targetP,b.p-rate);
      const e=smooth(b.p);
      b.dx=b.targetDx*e;
      b.dz=b.targetDz*e;
      b.yaw=b.targetYaw*e;
      if (e>0.01 && !b.detached) {
        b.detached=true;
        this._ensureStaticHidden(renderer,this.world,'shift-bld-'+b.id,0,b.x-b.w*.65,b.x+b.w*.65,0.1,b.h+4,b.z-b.d*.65,b.z+b.d*.65);
        // Disable matching static destructible record so shifted building owns its moved bounds cleanly.
        const ds=battle?.stage?.destruction?.byId?.get(b.baseId);
        if (ds && !ds.staticHidden) {ds.staticHidden=true;}
      }
      if (e>0.01) {
        b.shape=makeShape('box',b.x+b.dx,b.y,b.z+b.dz,b.w,b.h,b.d,b.kind,{yaw:b.yaw});
      } else {
        b.shape=null;
      }
    }

    // 6. Update sprouting hydraulic cover walls
    for (const w of this.risingWalls) {
      w.prevH=w.h;
      if (w.telegraph>0) {
        w.telegraph=Math.max(0,w.telegraph-dt);
      } else {
        const rate=2.8*dt;
        if (w.h<w.targetH) w.h=Math.min(w.targetH,w.h+rate);
        else if (w.h>w.targetH) w.h=Math.max(w.targetH,w.h-rate);
      }
      if (w.h>0.08) {
        w.shape=makeShape('box',w.x,w.h*.5,w.z,w.w,w.h,w.d,w.matKind,{yaw:w.yaw});
      } else {
        w.shape=null;
      }
    }

    // 7. Update rotating central turntable
    if (this.turntable.active) {
      this.turntable.angle=(this.turntable.angle+this.turntable.omega*dt)%TAU;
    }

    // Couple moving platforms, trains, sinkhole shafts, and shifting obstacles cleanly onto live actors!
    if (battle?.actors) this.applyActorInteractions(battle,dt);
  }

  applyActorInteractions(battle,dt) {
    const actors=battle.actors;
    for (const a of actors) {
      if (a.down>0 || a.car || a.ride || a.lift) continue;
      const zone=zoneOf(a.x);

      // Carry standing actors vertically with moving terrain plates & lowered highway & rising walls without clipping!
      if (zone===0) {
        for (const p of this.plates) {
          if (a.x>=p.x0 && a.x<=p.x1 && a.z>=p.z0 && a.z<=p.z1) {
            const dh=p.y-p.prevY;
            if (Math.abs(a.y-p.prevY)<0.42 || a.y<p.y) {
              a.y=Math.max(a.y+Math.max(0,dh),p.y);
              if (dh>0) a.vy=Math.max(a.vy,0);
            }
          }
        }
        const hw=this.highway;
        if (hw.progress>0.02 && a.x>=hw.x-hw.w*.5 && a.x<=hw.x+hw.w*.5 && a.z>=hw.z0 && a.z<=hw.z1) {
          const dh=hw.y-hw.prevY;
          if (Math.abs(a.y-hw.prevY)<0.65 && a.y>=hw.prevY-0.5) {
            a.y=hw.y;
          }
        }
        for (const w of this.risingWalls) {
          if (w.h>0.1 && Math.abs(a.x-w.x)<Math.max(w.w,w.d)*.65+0.4 && Math.abs(a.z-w.z)<Math.max(w.w,w.d)*.65+0.4) {
            // Check exact local coords of rotated wall
            const dx=a.x-w.x, dz=a.z-w.z;
            const c=Math.cos(w.yaw), s=Math.sin(w.yaw);
            const lx=dx*c-dz*s, lz=dx*s+dz*c;
            if (Math.abs(lx)<w.w*.5+0.35 && Math.abs(lz)<w.d*.5+0.35 && a.y<=w.h+0.15) {
              if (a.y>=w.prevH-0.45 || w.h<0.9) a.y=w.h;
              else {
                // Push horizontally outside tall rising wall
                const ox=(w.w*.5+0.42)-Math.abs(lx), oz=(w.d*.5+0.42)-Math.abs(lz);
                if (ox<oz) {
                  const nx=lx>=0?ox:-ox;
                  a.x+=nx*c; a.z-=nx*s;
                } else {
                  const nz=lz>=0?oz:-oz;
                  a.x+=nz*s; a.z+=nz*c;
                }
              }
            }
          }
        }
        // Push actors out of shifting rotating buildings cleanly (zero crush-trapping)
        for (const b of this.shiftingBuildings) {
          if (!b.shape || a.y>b.h) continue;
          const bx=b.x+b.dx, bz=b.z+b.dz;
          const dx=a.x-bx, dz=a.z-bz;
          const c=Math.cos(b.yaw), s=Math.sin(b.yaw);
          const lx=dx*c-dz*s, lz=dx*s+dz*c;
          const hw2=b.w*.5+0.45, hd2=b.d*.5+0.45;
          if (Math.abs(lx)<hw2 && Math.abs(lz)<hd2) {
            const ox=hw2-Math.abs(lx), oz=hd2-Math.abs(lz);
            if (ox<oz) {const sx=lx>=0?ox:-ox; a.x+=sx*c; a.z-=sx*s;}
            else {const sz=lz>=0?oz:-oz; a.x+=sz*s; a.z+=sz*c;}
          }
        }
        // Bidirectional Sinkhole Drop: Surface -> Underground B1!
        for (const h of this.sinkholes) {
          if (h.radius<1.2) continue;
          const dist=Math.hypot(a.x-h.x,a.z-h.z);
          if (dist<h.radius*0.80 && a.y<-2.0) {
            a.x=UNDER_X+a.x;
            a.y=UNDER_Y+6.1;
            a.vy=Math.min(a.vy,-2.5);
            a.grounded=false;
          }
        }
        // Intrusion Express Train impact & roof-surfing
        const pose=this.railIntrusion.pose;
        if (pose) {
          const dx=a.x-pose.x, dz=a.z-pose.z;
          const c=Math.cos(pose.yaw), s=Math.sin(pose.yaw);
          const along=dx*s+dz*c, across=dx*c-dz*s;
          if (Math.abs(along)<8.2 && Math.abs(across)<1.55) {
            const roofY=pose.y+3.35;
            if (a.y>=pose.y+2.5 && a.y<=roofY+0.5) {
              a.y=roofY;
              a.grounded=true;
            } else if (a.y<pose.y+2.5 && a.y+1.6>pose.y) {
              // Knock aside + train damage
              const outSign=across>=0?1:-1;
              a.x+=outSign*c*1.85;
              a.z-=outSign*s*1.85;
              a.vx+=outSign*c*11+s*this.railIntrusion.dir*6;
              a.vz+=-outSign*s*11+c*this.railIntrusion.dir*6;
              a.vy=Math.max(a.vy,4.8);
              battle.damage(a,26*Math.min(1,dt*12),null,[a.x,a.y+1,a.z],'car');
            }
          }
        }
        // Central Turntable gentle tangential spin carry
        if (this.turntable.active && Math.abs(a.y-this.turntable.y)<0.28) {
          const d=Math.hypot(a.x,a.z);
          if (d<this.turntable.radius && d>0.1) {
            const ang=this.turntable.omega*dt;
            const nx=a.x*Math.cos(ang)-a.z*Math.sin(ang);
            const nz=a.x*Math.sin(ang)+a.z*Math.cos(ang);
            if (!this.world.blocked(nx,a.y,nz,.38,1.7)) {a.x=nx;a.z=nz;}
          }
        }
      } else if (zone===1) {
        // Bidirectional Sinkhole Updraft Vent: Underground B1 -> Surface!
        for (const h of this.sinkholes) {
          if (h.radius<1.2) continue;
          const dist=Math.hypot(a.x-h.ux,a.z-h.uz);
          if (dist<h.radius*0.82) {
            if (a.y<UNDER_Y+5.8) {
              a.vy=Math.max(a.vy??0,14.8);
              a.grounded=false;
              a.y+=a.vy*dt;
            }
            if (a.y>=UNDER_Y+5.8) {
              a.x=a.x-UNDER_X;
              a.y=0.45;
              a.vy=5.2;
              a.grounded=false;
            }
          }
        }
      }
    }
  }

  // Floor height override integrated cleanly into World.floor(x, z).
  floorOverlay(x,z,baseSurface) {
    if (!this.active && !this.manualOverride) return baseSurface;
    const zone=zoneOf(x);
    let y=baseSurface.y, layer=baseSurface.layer, modified=false;

    if (zone===0) {
      for (const h of this.sinkholes) {
        if (h.radius<1.1) continue;
        if (Math.hypot(x-h.x,z-h.z)<h.radius*0.80) {
          return {y:-4.5,layer:0,sinkhole:h};
        }
      }
      for (const p of this.plates) {
        if (Math.abs(p.y)<0.01) continue;
        if (x>=p.x0 && x<=p.x1 && z>=p.z0 && z<=p.z1) {
          y=p.y;
          modified=true;
        }
      }
      // Lowered highway + ramps
      const hw=this.highway;
      if (hw.progress>0.02 && x>=hw.x-hw.w*.5 && x<=hw.x+hw.w*.5) {
        if (z>=hw.z0 && z<=hw.z1) {
          if (hw.y<6.5 || baseSurface.y>0.5) {y=Math.max(y,hw.y); layer=1; modified=true;}
        } else if (z>=hw.z0-hw.rampLen && z<hw.z0 && hw.y<5.5) {
          const t=(z-(hw.z0-hw.rampLen))/hw.rampLen;
          y=Math.max(y,t*hw.y); layer=1; modified=true;
        } else if (z>hw.z1 && z<=hw.z1+hw.rampLen && hw.y<5.5) {
          const t=1-(z-hw.z1)/hw.rampLen;
          y=Math.max(y,t*hw.y); layer=1; modified=true;
        }
      }
      // Spline rail intrusion deck
      const ri=this.railIntrusion;
      if (ri.trackProgress>0.1) {
        const count=Math.floor(ri.trackProgress*(ri.segments.length-1));
        for (let i=0;i<=count;i++) {
          const seg=ri.segments[i];
          if (Math.abs(x-seg.x)<2.4 && Math.abs(z-seg.z)<2.4) {
            if (seg.y>y && seg.y<4.5) {y=seg.y; layer=1; modified=true;}
          }
        }
      }
    }
    return modified?{y,layer}:baseSurface;
  }

  // Dynamic support check for elevated roofs of rising walls, shifting buildings, highway, plates.
  supportOverlay(x,y,z,surface) {
    if (!this.active && !this.manualOverride) return surface;
    const zIdx=zoneOf(x);
    if (zIdx!==0) return surface;
    let top=surface.y, layer=surface.layer;
    const hw=this.highway;
    if (hw.progress>0.02 && x>=hw.x-hw.w*.5+.1 && x<=hw.x+hw.w*.5-.1) {
      if (z>=hw.z0 && z<=hw.z1 && hw.y<=y+0.55 && hw.y>top) {
        top=hw.y; layer=1;
      } else if (((z>=-44.9 && z<hw.z0) || (z>hw.z1 && z<=44.1)) && hw.yHigh<=y+0.6 && hw.yHigh>top) {
        top=hw.yHigh; layer=1;
      }
    }
    for (const w of this.risingWalls) {
      if (w.h<=0.1 || w.h>y+0.35 || w.h<=top) continue;
      const dx=x-w.x, dz=z-w.z;
      const c=Math.cos(w.yaw), s=Math.sin(w.yaw);
      const lx=dx*c-dz*s, lz=dx*s+dz*c;
      if (Math.abs(lx)<w.w*.5 && Math.abs(lz)<w.d*.5) {top=w.h; layer=1;}
    }
    return top>surface.y?{y:top,layer,raised:true}:surface;
  }

  blocked(x,y,z,radius,height) {
    if (!this.active && !this.manualOverride) return false;
    if (zoneOf(x)!==0) return false;
    const r2=radius*radius;
    // Check raised floor plate vertical skirt blocking (so actors can't walk into side of elevated slab)
    for (const p of this.plates) {
      if (p.y<=0.35 || y>=p.y-0.25) continue;
      const dx=x<p.x0?x-p.x0:x>p.x1?x-p.x1:0;
      const dz=z<p.z0?z-p.z0:z>p.z1?z-p.z1:0;
      if (dx*dx+dz*dz<r2) return true;
    }
    // Check rising walls
    for (const w of this.risingWalls) {
      if (w.h<=0.32 || y>=w.h-0.25) continue;
      const dx=x-w.x, dz=z-w.z;
      const c=Math.cos(w.yaw), s=Math.sin(w.yaw);
      const lx=dx*c-dz*s, lz=dx*s+dz*c;
      const bx=Math.max(0,Math.abs(lx)-w.w*.5), bz=Math.max(0,Math.abs(lz)-w.d*.5);
      if (bx*bx+bz*bz<r2) return true;
    }
    // Check shifting buildings
    for (const b of this.shiftingBuildings) {
      if (!b.shape || y>=b.h-0.2) continue;
      const dx=x-(b.x+b.dx), dz=z-(b.z+b.dz);
      const c=Math.cos(b.yaw), s=Math.sin(b.yaw);
      const lx=dx*c-dz*s, lz=dx*s+dz*c;
      const bx=Math.max(0,Math.abs(lx)-b.w*.5), bz=Math.max(0,Math.abs(lz)-b.d*.5);
      if (bx*bx+bz*bz<r2) return true;
    }
    return false;
  }

  trace(start,end,clearance=0,limit=1) {
    if (!this.active && !this.manualOverride) return null;
    if (zoneOf(start[0])!==0) return null;
    const sx=start[0], sy=start[1], sz=start[2];
    const ex=end[0], ey=end[1], ez=end[2];
    const dx=ex-sx, dy=ey-sy, dz=ez-sz;
    let bestT=limit??1, bestShape=null, bnx=0, bny=0, bnz=0;

    const test=sh=>{
      if (!sh) return;
      if (castShapeInto(sh,sx,sy,sz,dx,dy,dz,bestT,clearance,this._rayHit)) {
        bestT=this._rayHit.t;
        bnx=this._rayHit.nx; bny=this._rayHit.ny; bnz=this._rayHit.nz;
        bestShape=sh;
      }
    };
    for (const w of this.risingWalls) if (w.shape) test(w.shape);
    for (const b of this.shiftingBuildings) if (b.shape) test(b.shape);
    const hw=this.highway;
    if (hw.progress>0.02) {
      test(makeShape('box',hw.x,hw.y-.43,(hw.z0+hw.z1)*.5,hw.w,.86,hw.z1-hw.z0,1,{}));
      test(makeShape('box',hw.x,hw.yHigh-.43,-35.4,hw.w,.86,18.8,1,{}));
      test(makeShape('box',hw.x,hw.yHigh-.43,35.05,hw.w,.86,18.1,1,{}));
    }
    for (const p of this.plates) {
      if (Math.abs(p.y)>0.04) {
        test(makeShape('box',(p.x0+p.x1)*.5,p.y*.5-0.1,(p.z0+p.z1)*.5,p.x1-p.x0,Math.abs(p.y)+0.2,p.z1-p.z0,1,{}));
      }
    }
    if (!bestShape) return null;
    return {
      t:bestT,
      position:[sx+dx*bestT,sy+dy*bestT,sz+dz*bestT],
      normal:[bnx,bny,bnz],
      shape:bestShape
    };
  }

  draw(r,viewX,viewZ) {
    if (!this.active && !this.manualOverride) return;
    const zone=zoneOf(viewX), dyn={dynamic:true};

    if (zone===0) {
      // 1. Moving ground hydraulic plates + support rams
      for (const p of this.plates) {
        if (Math.abs(p.y)<0.02 && !p.active) continue;
        const cx=(p.x0+p.x1)*.5, cz=(p.z0+p.z1)*.5, w=p.x1-p.x0, d=p.z1-p.z0;
        const slabH=Math.max(0.55,Math.abs(p.y)+0.4);
        r.add('box',cx,p.y-slabH*.5,cz,w,slabH,d,p.tint,1,{dynamic:true,layer:0});
        r.add('box',cx,p.y+0.02,cz,w-0.2,0.05,d-0.2,0x899a92,4,dyn);
        r.add('box',cx,p.y+0.03,p.z0+0.15,w,0.06,0.22,0xd9a841,3,dyn);
        r.add('box',cx,p.y+0.03,p.z1-0.15,w,0.06,0.22,0xd9a841,3,dyn);
        if (p.y>0.2) {
          r.add('cylinder',cx-w*.3,p.y*.5,cz-d*.3,0.55,p.y,0.55,0x616d6a,4,dyn);
          r.add('cylinder',cx+w*.3,p.y*.5,cz+d*.3,0.55,p.y,0.55,0x616d6a,4,dyn);
        }
      }

      // 2. Descending highway bridge span + fixed N/S viaducts + deployment ramps
      const hw=this.highway;
      if (hw.progress>0.01) {
        // Fixed N & S viaduct shoulders remain aloft seamlessly linked to Elevated Approach
        for (const [fcz,fLen] of [[-35.4,18.8],[35.05,18.1]]) {
          r.add('box',hw.x,hw.yHigh-0.43,fcz,hw.w,0.86,fLen,0xa0a5a0,1,dyn);
          for (const side of [-1,1]) r.add('box',hw.x+side*hw.w*.5,hw.yHigh+0.68,fcz,0.52,0.74,fLen,0xc7c5b8,1,dyn);
        }
        const cz=(hw.z0+hw.z1)*.5, len=hw.z1-hw.z0;
        r.add('box',hw.x,hw.y-0.43,cz,hw.w,0.86,len,0x9aa29c,1,dyn);
        for (const side of [-1,1]) {
          r.add('box',hw.x+side*hw.w*.5,hw.y+0.36,cz,0.48,0.72,len,0xc8c6b9,1,dyn);
        }
        for (const pz of [-18,0,18]) {
          r.add('box',hw.x,hw.y*.5-0.2,pz,1.5,Math.max(0.5,hw.y-0.4),1.5,0x7c8680,4,dyn);
        }
        if (hw.y<6.5) {
          const rAngle=Math.atan2(hw.y,hw.rampLen);
          const rHyp=Math.hypot(hw.rampLen,hw.y);
          r.add('box',hw.x,hw.y*.5,hw.z0-hw.rampLen*.5,hw.w-0.4,0.36,rHyp,0xaab1aa,5,{dynamic:true,pitch:-rAngle});
          r.add('box',hw.x,hw.y*.5,hw.z1+hw.rampLen*.5,hw.w-0.4,0.36,rHyp,0xaab1aa,5,{dynamic:true,pitch:rAngle});
        }
      }

      // 3. Deforming Extending Spline Track + Express Intrusion Train
      const ri=this.railIntrusion;
      if (ri.trackProgress>0.02) {
        const count=Math.max(1,Math.floor(ri.trackProgress*(ri.segments.length-1)));
        for (let i=0;i<count;i++) {
          const a=ri.segments[i], b=ri.segments[i+1];
          const mx=(a.x+b.x)*.5, my=(a.y+b.y)*.5, mz=(a.z+b.z)*.5;
          const len=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);
          r.add('box',mx,my-0.15,mz,2.9,0.30,len+0.2,0x747c78,4,{dynamic:true,yaw:a.yaw,pitch:-a.pitch});
          r.add('box',mx,my-0.02,mz,0.25,0.08,len+0.2,0xc5b874,2,{dynamic:true,yaw:a.yaw,pitch:-a.pitch});
          if (i%2===0) {
            r.add('box',mx,my+0.02,mz,2.6,0.07,0.22,0x5a5042,4,{dynamic:true,yaw:a.yaw});
          }
        }
        if (ri.pose) {
          // Draw detailed 2-car articulated Express Intrusion Train following spline tangent & pitch
          for (const carIdx of [-1,0]) {
            const pCar=carIdx===0?ri.pose:this.sampleRailSpline(clamp(ri.s-ri.dir*0.145,0,1));
            const poseYaw=pCar.yaw-Math.PI*.5;
            r.add('box',pCar.x,pCar.y+1.65,pCar.z,13.6,2.85,2.75,0x33474d,2,{dynamic:true,yaw:poseYaw,pitch:-pCar.pitch});
            r.add('box',pCar.x,pCar.y+2.95,pCar.z,13.0,0.38,2.45,0xd7dfd8,4,{dynamic:true,yaw:poseYaw,pitch:-pCar.pitch});
            r.add('box',pCar.x,pCar.y+1.82,pCar.z,13.66,0.34,2.82,0xff4936,3,{dynamic:true,yaw:poseYaw,pitch:-pCar.pitch});
            r.add('box',pCar.x,pCar.y+2.05,pCar.z,10.8,0.82,2.84,0x86c8d8,8,{dynamic:true,yaw:poseYaw,pitch:-pCar.pitch});
            r.add('box',pCar.x,pCar.y+0.38,pCar.z,12.2,0.52,2.1,0x252d31,4,{dynamic:true,yaw:poseYaw,pitch:-pCar.pitch});
          }
          r.add('box',ri.pose.x+Math.sin(ri.pose.yaw)*6.85*ri.dir,ri.pose.y+1.25,ri.pose.z+Math.cos(ri.pose.yaw)*6.85*ri.dir,0.55,0.48,1.9,0xfff3a8,3,{dynamic:true,yaw:ri.pose.yaw-Math.PI*.5});
        }
      }

      // 4. Open Floor Sinkhole Chasms
      for (const h of this.sinkholes) {
        if (h.radius<0.15) continue;
        r.add('cylinder',h.x,-3.8,h.z,h.radius*2.0,7.6,h.radius*2.0,0x090b0f,2,dyn);
        r.add('ring',h.x,0.06,h.z,h.radius*2.18,0.14,h.radius*2.18,0xf2b544,3,dyn);
        r.add('ring',h.x,-0.45,h.z,h.radius*1.92,0.18,h.radius*1.92,0x495358,4,dyn);
      }

      // 5. Shifting Buildings Warping Arena Footprint
      for (const b of this.shiftingBuildings) {
        if (!b.shape) continue;
        const bx=b.x+b.dx, bz=b.z+b.dz;
        r.add('box',bx,b.y,bz,b.w,b.h,b.d,b.tint,b.kind,{dynamic:true,yaw:b.yaw});
        r.add('box',bx,b.y+b.h*.5+0.15,bz,b.w+0.3,0.3,b.d+0.3,0x73817d,4,{dynamic:true,yaw:b.yaw});
        r.add('box',bx,0.18,bz,b.w+0.9,0.22,b.d+0.9,0xd48e3b,3,{dynamic:true,yaw:b.yaw});
      }

      // 6. Rising Hydraulic Cover Walls + Telegraph Laser Seams
      for (const w of this.risingWalls) {
        if (w.telegraph>0 && w.h<0.1) {
          r.add('box',w.x,0.04,w.z,w.w+0.3,0.06,w.d+0.3,0xffaa33,3,{dynamic:true,yaw:w.yaw});
        } else if (w.h>0.05) {
          r.add('box',w.x,w.h*.5,w.z,w.w,w.h,w.d,w.tint,w.matKind,{dynamic:true,yaw:w.yaw});
          r.add('box',w.x,w.h+0.03,w.z,w.w+0.08,0.08,w.d+0.08,0x477e74,2,{dynamic:true,yaw:w.yaw});
        }
      }

      // 7. Central Rotating Turntable Deck Ring
      if (this.turntable.active) {
        r.add('ring',0,this.turntable.y+0.04,0,this.turntable.radius*1.88,0.10,this.turntable.radius*1.88,0x46d8c0,3,{dynamic:true,yaw:this.turntable.angle});
        r.add('box',0,this.turntable.y+0.05,0,this.turntable.radius*1.5,0.06,0.34,0xf5d66b,3,{dynamic:true,yaw:this.turntable.angle});
      }
    } else if (zone===1) {
      // Underground B1: Render Open Ceiling Skylights + Updraft Launch Vents!
      for (const h of this.sinkholes) {
        if (h.radius<0.15) continue;
        r.add('cylinder',h.ux,UNDER_Y+7.1,h.uz,h.radius*2.0,1.2,h.radius*2.0,0x101820,3,dyn);
        r.add('ring',h.ux,UNDER_Y+0.08,h.uz,h.radius*1.8,0.14,h.radius*1.8,0x42e8cf,3,dyn);
        const pulse=(this.clock*1.9)%1;
        r.add('ring',h.ux,UNDER_Y+0.4+pulse*5.5,h.uz,h.radius*1.2*(1-pulse*.3),0.12,h.radius*1.2*(1-pulse*.3),0x7cfef0,3,dyn);
      }
    }
  }
}
