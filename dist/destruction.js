import {zoneOf} from './layout.js';
import {GRAVITY} from './fluid-engine.js';

export const DESTRUCT_MATERIALS={
  glass:{name:'glass',density:2500,restitution:0.14,friction:0.42,softening:0.45,shards:10,toughness:1},
  wood:{name:'wood',density:680,restitution:0.24,friction:0.62,softening:1.35,shards:8,toughness:1},
  clay:{name:'clay',density:1850,restitution:0.12,friction:0.74,softening:1.2,shards:12,toughness:1},
  brick:{name:'brick',density:1950,restitution:0.15,friction:0.78,softening:1.1,shards:14,toughness:1.4},
  concrete:{name:'concrete',density:2400,restitution:0.16,friction:0.80,softening:0.9,shards:16,toughness:1.8},
  metal:{name:'metal',density:7800,restitution:0.28,friction:0.52,softening:0.5,shards:8,toughness:2.1}
};

const clamp=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
const TEAM_TINTS=[0x1fdfff,0xff7a2e,0x141118];

export class DestructionPhysics {
  constructor(world) {
    this.world=world;
    this.structures=[];
    this.byId=new Map();
    this.chunks=[];
    this.rubble=[];
    this.pendingHide=[];
    this.destroyedCount=0;
    this.collapsedBuildings=0;
    this.collapsedObjects=0;
    this.clock=0;
    this._rngState=0x5f3759df;
  }

  _rand() {
    let x=this._rngState|0;
    x^=x<<13; x^=x>>>17; x^=x<<5;
    this._rngState=x;
    return (x>>>0)/4294967296;
  }

  registerStructure(def) {
    if (!def || this.byId.has(def.id)) return this.byId.get(def?.id);
    const mat=DESTRUCT_MATERIALS[def.material||'concrete']||DESTRUCT_MATERIALS.concrete;
    const w=Math.max(0.2,def.w||2), h=Math.max(0.2,def.h||2), d=Math.max(0.2,def.d||2);
    const volume=w*h*d;
    const mass=volume*mat.density;
    // Calibrated structural fracture resistance so real ink barrages/bombs/tsunami topple props & buildings realistically
    // while single stray test shots do not accidentally erase walls.
    const defaultHp=def.kind==='building'
      ?clamp(420+Math.cbrt(volume)*95*mat.toughness,480,3200)
      :def.kind==='shop'
      ?clamp(340+Math.cbrt(volume)*72*mat.toughness,360,1400)
      :clamp(140+Math.cbrt(volume)*45*mat.toughness,120,750);
    const hp=def.hp??defaultHp;
    const struct={
      id:def.id,
      kind:def.kind||'object', // 'building' | 'shop' | 'object'
      material:def.material||'concrete',
      mat,
      zone:zoneOf(def.x),
      x:def.x, y:def.y, z:def.z,
      w, h, d,
      yaw:def.yaw||0,
      tint:def.tint??0xc8c4b4,
      matKind:def.matKind??2,
      minY:def.minY??Math.max(0.12,def.y-h*.5-0.05),
      maxY:def.maxY??(def.y+h*.5+1.2),
      hp, maxHp:hp,
      mass,
      saturation:0,
      state:'intact', // 'intact' | 'cracked' | 'collapsing' | 'destroyed'
      tiltAngle:0,
      tiltVel:0,
      tiltAxisX:1,
      tiltAxisZ:0,
      sink:0,
      sinkVel:0,
      stainTeam:-1,
      stainRatio:0,
      lastHitAt:-1,
      obstacles:def.obstacles||[],
      solids:def.solids||[],
      parts:def.parts||[{dx:0,dy:0,dz:0,w,h,d,tint:def.tint??0xc8c4b4,kind:def.matKind??2}],
      staticHidden:false
    };
    this.structures.push(struct);
    this.byId.set(struct.id,struct);
    return struct;
  }

  reset() {
    for (const s of this.structures) {
      s.hp=s.maxHp;
      s.saturation=0;
      s.state='intact';
      s.tiltAngle=0;
      s.tiltVel=0;
      s.tiltAxisX=1;
      s.tiltAxisZ=0;
      s.sink=0;
      s.sinkVel=0;
      s.stainTeam=-1;
      s.stainRatio=0;
      s.lastHitAt=-1;
      s.staticHidden=false;
      for (const ob of s.obstacles) ob.disabled=false;
      for (const so of s.solids) so.disabled=false;
    }
    this.chunks.length=0;
    this.rubble.length=0;
    this.pendingHide.length=0;
    this.destroyedCount=0;
    this.collapsedBuildings=0;
    this.collapsedObjects=0;
    this.clock=0;
  }

  // Test if world ray segment [from -> to] hits any intact/collapsing destructible structure.
  rayHit(from,to) {
    const dx=to[0]-from[0], dy=to[1]-from[1], dz=to[2]-from[2];
    const len=Math.hypot(dx,dy,dz);
    if (len<1e-6) return null;
    let bestT=1.0001, best=null;
    const minX=Math.min(from[0],to[0]), maxX=Math.max(from[0],to[0]);
    const minY=Math.min(from[1],to[1]), maxY=Math.max(from[1],to[1]);
    const minZ=Math.min(from[2],to[2]), maxZ=Math.max(from[2],to[2]);
    for (const s of this.structures) {
      if (s.state==='destroyed' || s.state==='collapsing') continue;
      const hw=s.w*.5, hh=s.h*.5, hd=s.d*.5;
      const sx0=s.x-hw, sx1=s.x+hw, sy0=s.y-hh, sy1=s.y+hh, sz0=s.z-hd, sz1=s.z+hd;
      if (maxX<sx0 || minX>sx1 || maxY<sy0 || minY>sy1 || maxZ<sz0 || minZ>sz1) continue;
      let tmin=0, tmax=1, nx=0, ny=0, nz=0;
      const slab=(o,d,lo,hi,ax,ay,az)=>{
        if (Math.abs(d)<1e-8) return o>=lo && o<=hi;
        let t0=(lo-o)/d, t1=(hi-o)/d, sgn=-1;
        if (t0>t1) {const tmp=t0; t0=t1; t1=tmp; sgn=1;}
        if (t0>tmin) {tmin=t0; nx=ax*sgn; ny=ay*sgn; nz=az*sgn;}
        if (t1<tmax) tmax=t1;
        return tmin<=tmax;
      };
      if (!slab(from[0],dx,sx0,sx1,1,0,0)) continue;
      if (!slab(from[1],dy,sy0,sy1,0,1,0)) continue;
      if (!slab(from[2],dz,sz0,sz1,0,0,1)) continue;
      if (tmin>=0 && tmin<bestT) {
        bestT=tmin;
        best={
          structure:s,
          t:tmin,
          point:[from[0]+dx*tmin,from[1]+dy*tmin,from[2]+dz*tmin],
          normal:[nx,ny,nz]
        };
      }
    }
    return best;
  }

  _spawnDebrisBurst(s,hitX,hitY,hitZ,fx,fy,fz,team,count,scaleMul=1) {
    const teamTint=TEAM_TINTS[team===2||team===-1?2:team===1?1:0];
    const maxTotalChunks=180;
    const n=Math.min(count,Math.max(2,maxTotalChunks-this.chunks.length));
    for (let i=0;i<n;i++) {
      const rx=(this._rand()-.5)*s.w*.75;
      const ry=(this._rand()-.3)*s.h*.55;
      const rz=(this._rand()-.5)*s.d*.75;
      const px=s.x+rx, py=Math.max(0.35,s.y+ry), pz=s.z+rz;
      const dirX=px-(hitX??s.x)+(fx*.02);
      const dirZ=pz-(hitZ??s.z)+(fz*.02);
      const dLen=Math.hypot(dirX,dirZ)||1;
      const spd=(3.2+this._rand()*6.8)*scaleMul;
      const size=(s.kind==='building'?clamp(0.45+this._rand()*0.95,0.4,1.5):clamp(0.22+this._rand()*0.38,0.18,0.68));
      const stained=this._rand()<0.42;
      this.chunks.push({
        x:px, y:py, z:pz,
        vx:(dirX/dLen)*spd+(this._rand()-.5)*2.2,
        vy:2.4+this._rand()*5.8*scaleMul+(fy*.01),
        vz:(dirZ/dLen)*spd+(this._rand()-.5)*2.2,
        yaw:this._rand()*Math.PI*2,
        pitch:this._rand()*Math.PI,
        vyaw:(this._rand()-.5)*9.5,
        vpitch:(this._rand()-.5)*9.5,
        w:size*(0.7+this._rand()*0.8),
        h:size*(0.5+this._rand()*0.7),
        d:size*(0.7+this._rand()*0.8),
        tint:stained?teamTint:s.tint,
        kind:stained?2:s.matKind,
        restitution:s.mat.restitution,
        friction:s.mat.friction,
        age:0,
        life:7.5+this._rand()*4.0,
        team:team===2||team===-1?2:team===1?1:0,
        splatted:false,
        bounces:0
      });
    }
  }

  _beginCollapse(s,hitX,hitY,hitZ,fx,fy,fz,team) {
    if (s.state==='collapsing' || s.state==='destroyed') return;
    s.state='collapsing';
    s.hp=0;
    s.tiltAngle=0.04;
    // Torque r x F determines physical overturning axis perpendicular to push direction.
    const tx=(hitX??s.x)-s.x, tz=(hitZ??s.z)-s.z;
    const pushX=Math.abs(fx)>0.1?fx:-tx;
    const pushZ=Math.abs(fz)>0.1?fz:-tz;
    const pLen=Math.hypot(pushX,pushZ);
    if (pLen>0.01) {
      s.tiltAxisX=pushX/pLen;
      s.tiltAxisZ=pushZ/pLen;
    } else {
      const a=this._rand()*Math.PI*2;
      s.tiltAxisX=Math.cos(a);
      s.tiltAxisZ=Math.sin(a);
    }
    // Initial angular velocity omega = L / I from impact impulse at elevation height.
    const lever=clamp((hitY??s.y)-(s.y-s.h*.5),s.h*.25,s.h);
    const inertia=Math.max(1,(s.mass/3)*(s.h*s.h+0.25*Math.min(s.w,s.d)**2));
    const impactTorque=lever*Math.max(1800,Math.hypot(fx,fz)*180);
    s.tiltVel=clamp(0.42+impactTorque/inertia,0.38,1.95);
    s.sinkVel=s.kind==='building'?0.35:0.15;

    if (!s.staticHidden) {
      s.staticHidden=true;
      this.pendingHide.push(s);
    }
    this._spawnDebrisBurst(s,hitX,hitY,hitZ,fx,fy,fz,team,s.mat.shards,s.kind==='building'?1.25:0.95);
  }

  _finishCollapse(s,battle) {
    if (s.state==='destroyed') return;
    s.state='destroyed';
    this.destroyedCount++;
    if (s.kind==='building' || s.kind==='shop') this.collapsedBuildings++;
    else this.collapsedObjects++;

    // Remove disabled solid/obstacle collision boxes from geometry solver so players/shots/fluid pass through!
    for (const ob of s.obstacles) {
      ob.disabled=true;
      this.world?.disableSolid?.(ob);
    }
    for (const so of s.solids) {
      so.disabled=true;
      this.world?.disableSolid?.(so);
    }
    const rotSpan=Math.hypot(s.w,s.d)*.52+0.35;
    this.world?.disableRegion?.(s.zone,s.x-rotSpan,s.x+rotSpan,s.minY,s.maxY+1.5,s.z-rotSpan,s.z+rotSpan);

    // Final ground slam shatters the collapsing body into rubble slabs + scattered debris chunks + ink splatter!
    const groundY=s.y-s.h*.5;
    const spread=Math.max(s.w,s.d)*.55;
    this._spawnDebrisBurst(
      s,s.x+s.tiltAxisX*s.h*.45,groundY+0.6,s.z+s.tiltAxisZ*s.h*.45,
      s.tiltAxisX*12,4,s.tiltAxisZ*12,s.stainTeam>=0?s.stainTeam:0,
      Math.min(18,s.mat.shards+4),1.3
    );

    if (this.rubble.length<80) {
      const slabs=s.kind==='building'?3:1;
      for (let i=0;i<slabs;i++) {
        const d=(i+0.4)*s.h*.24;
        this.rubble.push({
          zone:s.zone,
          x:s.x+s.tiltAxisX*d+(this._rand()-.5)*1.4,
          y:groundY+0.22,
          z:s.z+s.tiltAxisZ*d+(this._rand()-.5)*1.4,
          w:clamp(s.w*(0.45+this._rand()*0.3),0.8,8),
          h:clamp(0.32+this._rand()*0.48,0.28,0.95),
          d:clamp(s.d*(0.45+this._rand()*0.3),0.8,8),
          yaw:s.yaw+(this._rand()-.5)*0.6,
          tint:s.tint,
          kind:s.matKind,
          stainTeam:s.stainTeam
        });
      }
    }

    // Stamp structural ink spill onto painted surface around footprint and excite shallow-water shockwave.
    if (battle?.paint && s.stainTeam>=0) {
      const lay=s.zone===1?2:0;
      battle.paint.stamp(
        s.x+s.tiltAxisX*spread*.35,s.z+s.tiltAxisZ*spread*.35,
        clamp(spread*0.65,1.8,6.5),s.stainTeam,lay,this.clock,0.068
      );
      battle.fluid?.splatFluidImpulse(
        s.x,s.z,s.tiltAxisX*8,s.tiltAxisZ*8,spread*1.4,s.stainTeam
      );
    }
    battle?.callbacks?.sound?.('break');
  }

  // Direct projectile / impact stress at world coordinate.
  applyInkImpact(x,y,z,fx,fy,fz,damage,team=0,radius=1.2) {
    if (!(damage>0)) return null;
    let target=null, bestDist=Infinity;
    for (const s of this.structures) {
      if (s.state==='destroyed' || s.state==='collapsing') continue;
      const dx=Math.max(0,Math.abs(x-s.x)-s.w*.5);
      const dy=Math.max(0,Math.abs(y-s.y)-s.h*.5);
      const dz=Math.max(0,Math.abs(z-s.z)-s.d*.5);
      const d=Math.hypot(dx,dy,dz);
      if (d<=radius+0.45 && d<bestDist) {
        bestDist=d;
        target=s;
      }
    }
    if (!target) return null;
    const effDamage=damage*target.mat.softening;
    target.hp=Math.max(0,target.hp-effDamage);
    target.saturation=clamp(target.saturation+effDamage/target.maxHp,0,1.5);
    target.stainTeam=team===2||team===-1?2:team===1?1:0;
    target.stainRatio=clamp(target.stainRatio+effDamage/(target.maxHp*0.75),0,1);
    target.lastHitAt=this.clock;
    if (target.hp>0 && target.hp<target.maxHp*0.58 && target.state==='intact') {
      target.state='cracked';
      // Minor structural micro-tilt on upper hits
      const hRatio=clamp((y-(target.y-target.h*.5))/Math.max(0.5,target.h),0,1);
      target.tiltAngle=Math.max(target.tiltAngle,0.015*hRatio);
    }
    if (target.hp<=0) {
      this._beginCollapse(target,x,y,z,fx,fy,fz,team);
    }
    return target;
  }

  // Overpressure wave damage from explosions / boss mortar / grenade / slam.
  applySplashDamage(x,y,z,radius,damage,team=0,impulse=14) {
    if (!(damage>0) || !(radius>0)) return 0;
    let hits=0;
    const r2=radius*radius;
    for (const s of this.structures) {
      if (s.state==='destroyed' || s.state==='collapsing') continue;
      const dx=Math.max(0,Math.abs(x-s.x)-s.w*.5);
      const dy=Math.max(0,Math.abs(y-s.y)-s.h*.5);
      const dz=Math.max(0,Math.abs(z-s.z)-s.d*.5);
      const d2=dx*dx+dy*dy+dz*dz;
      if (d2>r2) continue;
      const d=Math.sqrt(d2);
      const falloff=clamp(1-d/radius,0.12,1);
      const pX=s.x-x, pZ=s.z-z, pLen=Math.hypot(pX,pZ)||1;
      const dmg=damage*falloff*s.mat.softening;
      s.hp=Math.max(0,s.hp-dmg);
      s.saturation=clamp(s.saturation+dmg/s.maxHp,0,1.5);
      s.stainTeam=team===2||team===-1?2:team===1?1:0;
      s.stainRatio=clamp(s.stainRatio+dmg/(s.maxHp*0.65),0,1);
      s.lastHitAt=this.clock;
      if (s.hp>0 && s.hp<s.maxHp*0.60) s.state='cracked';
      if (s.hp<=0) {
        this._beginCollapse(s,x,y,z,(pX/pLen)*impulse*falloff,impulse*0.4,(pZ/pLen)*impulse*falloff,team);
      }
      hits++;
    }
    return hits;
  }

  // Boss dark-ink rain saturation stress + base puddle destabilization.
  strikeInkRain(rx,rz,damage,team=2) {
    return this.applyInkImpact(rx,2.2,rz,0,-4,0,damage,team,2.6);
  }

  // Hydrodynamic bore wave impact against structures in tsunami path.
  strikeTsunami(waveX,width,height,dir,peakPressure,dt) {
    if (!(peakPressure>0)) return 0;
    const half=width*.62;
    let hit=0;
    for (const s of this.structures) {
      if (s.state==='destroyed' || s.state==='collapsing' || s.zone!==0) continue;
      if (s.x+s.w*.5<waveX-half || s.x-s.w*.5>waveX+half) continue;
      const bottomY=s.y-s.h*.5;
      if (bottomY>height) continue;
      const submerged=Math.min(s.h,height-bottomY);
      const area=s.d*submerged;
      // Scale hydrodynamic stress proportionally to exposed wetted area & stagnation pressure
      const hydroDamage=clamp((peakPressure*area*0.00018)*dt*s.mat.softening,0,220*dt);
      if (hydroDamage<=0.01) continue;
      s.hp=Math.max(0,s.hp-hydroDamage);
      s.saturation=clamp(s.saturation+hydroDamage/s.maxHp,0,1.5);
      if (s.hp>0 && s.hp<s.maxHp*0.62) s.state='cracked';
      if (s.hp<=0) {
        this._beginCollapse(s,s.x-dir*s.w*.5,bottomY+submerged*.5,s.z,dir*24,2,0,0);
      }
      hit++;
    }
    return hit;
  }

  update(dt,battle=null) {
    if (dt<=0) return;
    this.clock+=dt;
    // Step rigid-body toppling structures
    for (const s of this.structures) {
      if (s.state!=='collapsing') continue;
      const effH=Math.max(1.0,s.h);
      const inertia=Math.max(1,(s.mass/3)*(effH*effH+0.25*Math.min(s.w,s.d)**2));
      const gravTorque=s.mass*GRAVITY*(effH*0.5)*Math.sin(Math.min(Math.PI*.48,s.tiltAngle));
      const angAccel=gravTorque/inertia;
      s.tiltVel=clamp(s.tiltVel+angAccel*dt,0.25,4.2);
      s.tiltAngle+=s.tiltVel*dt;
      s.sink+=s.sinkVel*dt;
      s.sinkVel=Math.min(6.5,s.sinkVel+GRAVITY*0.25*dt);
      if (s.tiltAngle>=1.28 || s.sink>=s.h*0.72) {
        this._finishCollapse(s,battle);
      }
    }

    // Step fractured rigid-body debris chunks
    for (let i=this.chunks.length-1;i>=0;i--) {
      const c=this.chunks[i];
      c.age+=dt;
      if (c.age>=c.life) {
        this.chunks.splice(i,1);
        continue;
      }
      c.vy-=GRAVITY*dt;
      // Linear air drag
      const drag=1/(1+0.12*dt);
      c.vx*=drag; c.vz*=drag;
      c.x+=c.vx*dt;
      c.y+=c.vy*dt;
      c.z+=c.vz*dt;
      c.yaw+=c.vyaw*dt;
      c.pitch+=c.vpitch*dt;

      const fl=this.world?.floor?.(c.x,c.z,c.y+0.5)?.y??(zoneOf(c.x)===1?-8:0);
      const minY=fl+c.h*.5;
      if (c.y<=minY) {
        c.y=minY;
        if (Math.abs(c.vy)>0.9) {
          c.vy=-c.vy*c.restitution;
          c.vx*=c.friction;
          c.vz*=c.friction;
          c.vyaw*=0.72;
          c.vpitch*=0.72;
          c.bounces++;
          if (!c.splatted && c.bounces===1 && battle?.paint) {
            c.splatted=true;
            const lay=zoneOf(c.x)===1?2:0;
            battle.paint.stamp(c.x,c.z,0.55+c.w*0.5,c.team,lay,c.yaw,0.025);
          }
        } else {
          c.vy=0;
          c.vx*=Math.max(0,1-dt*5.5);
          c.vz*=Math.max(0,1-dt*5.5);
          c.vyaw*=Math.max(0,1-dt*6);
          c.vpitch*=Math.max(0,1-dt*6);
        }
      }
    }
  }

  flushRendererHides(r) {
    if (!r?.hideStaticRegion || !this.pendingHide.length) return;
    while (this.pendingHide.length) {
      const s=this.pendingHide.pop();
      const pad=0.35;
      const rotSpan=Math.hypot(s.w,s.d)*.52+pad;
      r.hideStaticRegion(
        s.zone,
        s.x-rotSpan,s.x+rotSpan,
        s.minY,s.maxY+1.5,
        s.z-rotSpan,s.z+rotSpan
      );
    }
  }

  draw(r,eyeX=0,eyeZ=0) {
    this.flushRendererHides(r);
    // Draw cracking overlays, toppling/collapsing monoliths, rubble piles, and dynamic debris chunks.
    for (const s of this.structures) {
      if (zoneOf(eyeX)!==s.zone) continue;
      const dist2=(s.x-eyeX)**2+(s.z-eyeZ)**2;
      if (dist2>190*190) continue;

      if (s.state==='cracked') {
        const dmgRatio=1-s.hp/s.maxHp;
        const crackTint=s.stainTeam===2?0x151118:s.stainTeam===1?0xe07022:0x22d6ff;
        const seamH=s.h*clamp(dmgRatio*0.85,0.2,0.88);
        r.add('box',s.x,s.y-s.h*.1,s.z,s.w+0.06,0.09,s.d+0.06,crackTint,2,{dynamic:true,yaw:s.yaw+s.tiltAngle*.2});
        r.add('box',s.x,s.y-s.h*.5+seamH*.5,s.z,0.10+dmgRatio*.16,seamH,s.d+0.08,0x2c2927,2,{dynamic:true,yaw:s.yaw+.4});
      } else if (s.state==='collapsing') {
        // Rigid-body pivoting & sinking building/object monolith!
        const pitchSign=s.tiltAxisZ*Math.cos(s.yaw)-s.tiltAxisX*Math.sin(s.yaw);
        const angle=s.tiltAngle;
        const pivotY=s.y-s.h*.5-s.sink;
        const liftY=Math.cos(angle)*(s.h*.5);
        const shiftH=Math.sin(angle)*(s.h*.5);
        const wx=s.x+s.tiltAxisX*shiftH;
        const wy=pivotY+liftY;
        const wz=s.z+s.tiltAxisZ*shiftH;
        const stainMix=s.stainTeam===2?0x1a1520:s.stainTeam===1?0xc9743c:0x4b9aa8;
        const drawTint=s.stainRatio>0.45?stainMix:s.tint;
        const yaw=Math.atan2(s.tiltAxisX,s.tiltAxisZ);
        r.add('box',wx,wy,wz,s.w,s.h,s.d,drawTint,s.matKind,{dynamic:true,yaw,pitch:angle*(Math.abs(pitchSign)>=0?1:-1)});
      }
    }

    for (const rb of this.rubble) {
      if (zoneOf(eyeX)!==rb.zone && zoneOf(rb.x)!==zoneOf(eyeX)) continue;
      r.add('bevel',rb.x,rb.y,rb.z,rb.w,rb.h,rb.d,rb.tint,rb.kind,{dynamic:true,yaw:rb.yaw});
    }

    for (const c of this.chunks) {
      if (zoneOf(c.x)!==zoneOf(eyeX)) continue;
      const fade=c.age>c.life-1?clamp(c.life-c.age,0.1,1):1;
      r.add('box',c.x,c.y,c.z,c.w*fade,c.h*fade,c.d*fade,c.tint,c.kind,{dynamic:true,yaw:c.yaw,pitch:c.pitch});
    }
  }
}
