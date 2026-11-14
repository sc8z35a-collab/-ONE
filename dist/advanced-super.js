import {TAU,add,clamp,forward,scale,sub,unit} from './render.js';
import {ZONES,sameLevel,zoneOf} from './layout.js';
import {stairCrossing,stairEnd,stairNeighborShift,stairRay} from './stairs.js';
import {TEAM_INK} from './world.js';

const WAVE_TURN=[-.48,-.24,0,.24,.48];
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

export class AdvancedSupers {
  constructor(abilities) {
    this.abilities=abilities;
    this.battle=abilities.battle;
    this.effects=[];
  }

  launch(actor,id) {
    const b=this.battle;
    if (id==='wave') {
      const lanes=WAVE_TURN.map(angle=>{
        const [dx,,dz]=forward(actor.yaw+angle);
        return {x:actor.x,z:actor.z,y:actor.y,dx,dz,stopped:false};
      });
      this.effects.push({id,actor,x:actor.x,z:actor.z,age:0,paintAt:0,hit:new Set(),lanes});
    }
    if (id==='vortex') {
      const [dx,,dz]=forward(actor.yaw), start=[actor.x,actor.y+.91,actor.z];
      const hit=b.traceShot(start,add(start,[dx*9.5,0,dz*9.5]),true);
      const far=hit?Math.max(0,hit.t*9.5-.85):9.5;
      let [x,,z]=stairEnd(start,add(start,[dx*far,0,dz*far]));
      if (!b.world.stand(x,z,.14)) {
        x=actor.x;
        z=actor.z;
      }
      const y=b.world.floor(x,z).y;
      this.effects.push({id,actor,x,y,z,age:0,paintAt:0,burst:false});
    }
    if (id==='beam') {
      actor.beaming=true;
      actor.charge=0;
      this.effects.push({id,actor,x:actor.x,z:actor.z,age:0,next:0,damage:new Map(),a:null,b:null});
    }
  }

  wave(effect,dt) {
    const b=this.battle, {actor,lanes}=effect;
    effect.paintAt-=dt;
    const paintNow=effect.paintAt<=0;
    if (paintNow) effect.paintAt=.084;
    for (const l of lanes) {
      if (l.stopped) continue;
      const rawX=l.x+l.dx*12.4*dt, z=l.z+l.dz*12.4*dt;
      const x=stairCrossing(l.x,l.z,rawX,z,l.y), floor=b.world.floor(x,z), y=floor.y;
      const hit=b.traceShot([l.x,l.y+.42,l.z],[rawX,y+.42,z],true);
      if (hit?.t<.98 || !b.world.stand(x,z,.12)) {
        if (hit?.train) b.splat(hit,{actor,weapon:actor.weapon,power:.49,structureDamage:21});
        l.stopped=true;
        continue;
      }
      Object.assign(l,{x,y,z});
      if (paintNow) {
        this.abilities.paint(actor,x,z,1.29+effect.age*.19,.039);
        b.paint.kick(x,z,floor.layer,l.dx*8,l.dz*8);
      }
    }
    if (paintNow) {
      const levels=new Set(lanes.filter(l=>!l.stopped).map(l=>zoneOf(l.x)));
      const enemies=[...levels].flatMap(level=>this.abilities.enemies(actor,ZONES[level].x));
      for (const enemy of enemies) {
        if (effect.hit.has(enemy)) continue;
        const front=lanes.find(l=>!l.stopped && Math.abs(enemy.y-l.y)<2.2 && distance(enemy,l)<(enemy.isBoss?2.25:1.46));
        if (!front || b.traceShot([front.x,front.y+.31,front.z],[enemy.x,enemy.y+.72,enemy.z],true)?.t<.96) continue;
        if (b.damage(enemy,85,actor,[enemy.x,enemy.y+.83,enemy.z])) {
          effect.hit.add(enemy);
          if (!enemy.isBoss && enemy.down<=0) b.stepActor(enemy,front.dx*.82,front.dz*.82);
        }
      }
    }
    return effect.age<2.19 && lanes.some(l=>!l.stopped);
  }

  vortex(effect,dt) {
    const b=this.battle,{actor,x,y,z}=effect;
    if (effect.age>=2.1) {
      if (!effect.burst) {
        effect.burst=true;
        this.abilities.paint(actor,x,z,4.33,.082);
        this.abilities.area(actor,x,y,z,4.87,106);
        b.burst([x,y+.11,z],actor.team,29,4.33,.014);
      }
      return effect.age<2.58;
    }
    effect.paintAt-=dt;
    if (effect.paintAt<=0) {
      effect.paintAt=.13;
      for (let i=0;i<9;i++) {
        const angle=i*TAU/9+effect.age*.58, dx=Math.cos(angle), dz=Math.sin(angle);
        const px=x+dx*(3.75-effect.age*.79),pz=z+dz*(3.75-effect.age*.79);
        b.paint.kick(px,pz,b.world.floor(px,pz).layer,(-dx+dz*.52)*6.4,(-dz-dx*.52)*6.4);
      }
    }
    const range=5.6, start=[x,y+.55,z], shift=stairNeighborShift(x,z,range);
    const enemies=this.abilities.enemies(actor,x);
    if (shift) enemies.push(...this.abilities.enemies(actor,x+shift));
    for (const enemy of enemies) {
      const joined=!sameLevel(enemy.x,x), end=[enemy.x-(joined?shift:0),enemy.y+.61,enemy.z];
      const dx=x-end[0], dz=z-enemy.z, d=Math.hypot(dx,dz);
      if (enemy.isBoss || d>range || d<.64 || Math.abs(enemy.y-y)>1.95 || enemy.shield>0) continue;
      if (joined && !stairRay(start,end) || b.traceShot(start,end,true)?.t<.96) continue;
      const impulse=(1-d/6.35)*6.5*dt/d;
      b.stepActor(enemy,dx*impulse,dz*impulse);
    }
    return true;
  }

  beam(effect,dt) {
    const b=this.battle,{actor}=effect;
    if (actor.down>0 || actor.ride || actor.lift || !actor.beaming || effect.age>3.47) {
      actor.beaming=false;
      return false;
    }
    const launch=b.weaponLaunch(actor)[0], enemy=actor.enemy;
    const muzzle=b.subweapons.block(launch.origin,launch.tip,actor.team);
    const atMuzzle=muzzle && (!launch.hit || muzzle.t<launch.hit.t);
    const start=launch.hit || launch.crossesStair || atMuzzle?launch.origin:launch.tip;
    const target=actor.isPlayer?b.playerAim?.position:
      enemy && sameLevel(enemy.x,actor.x)?[enemy.x,enemy.y+(enemy.isBoss?2.6:1.12),enemy.z]:null;
    const heading=target?unit(sub(target,start)):forward(actor.yaw,actor.pitch);
    const end=add(start,scale(heading,48));
    const wall=launch.hit ?? b.traceShot(start,end,true), hit=launch.hit?null:b.findActor(start,end,actor.team);
    const screen=atMuzzle?muzzle:launch.hit?null:b.subweapons.block(start,end,actor.team);
    const curtain=screen && (atMuzzle || (!wall || screen.t<wall.t) && (!hit || screen.t<hit.t));
    const body=!curtain && hit && (!wall || hit.t<wall.t)?hit.actor:null;
    effect.a=start;
    const stop=curtain?(atMuzzle?launch.tip:end):body?end:null;
    effect.b=stop?add(start,scale(sub(stop,start),curtain?screen.t:hit.t)):
      wall?.shift?add(wall.position,[-wall.shift,0,0]):wall?.position ?? end;
    effect.x=actor.x;
    effect.next-=dt;
    if (effect.age>=.68 && effect.next<=0) {
      effect.next=.16;
      if (curtain) {
        screen.item.hp-=35;
        b.burst(screen.p,actor.team,4,1.7);
      } else if (body) {
        const damage=effect.damage.get(body) || 0;
        if (damage<75) {
          const point=hit.shift?add(effect.b,[hit.shift,0,0]):effect.b;
          const lost=b.damage(body,Math.min(35,(75-damage)*3),actor,point);
          effect.damage.set(body,damage+lost);
        }
      } else if (wall?.layer!==undefined) {
        const [x,y,z]=wall.position;
        actor.painted+=b.paint.stampGround(x,z,1.38,actor.team,wall.layer,effect.age,.032);
        b.paint.kick(x,z,wall.layer,heading[0]*6.5,heading[2]*6.5);
        b.burst([x,y+.03,z],actor.team,4,2.55);
      } else if (wall) {
        b.splat(wall,{actor,weapon:actor.weapon,power:.46,structureDamage:23});
        if (!wall.train) b.damageMetro(start[0],start[1],start[2],.1,15);
      }
    }
    return true;
  }

  update(dt) {
    for (let i=this.effects.length-1;i>=0;i--) {
      const effect=this.effects[i];
      effect.age+=dt;
      const active=effect.id==='wave'?this.wave(effect,dt):effect.id==='vortex'?this.vortex(effect,dt):this.beam(effect,dt);
      if (!active) this.effects.splice(i,1);
    }
  }

  draw(r,viewX) {
    for (const e of this.effects) {
      if (e.id!=='wave' && !sameLevel(e.x,viewX)) continue;
      const tint=TEAM_INK[e.actor.team];
      if (e.id==='wave') {
        let previous=null;
        for (const l of e.lanes) {
          if (l.stopped || !sameLevel(l.x,viewX)) { previous=null; continue; }
          const pulse=.79+.18*Math.sin(e.age*16+l.z*.11);
          r.add('orb',l.x,l.y+.29,l.z,1.25,.51*pulse,.92,tint,9,{dynamic:true});
          r.add('ripple',l.x,l.y+.021,l.z,2.45,.027,2.51,0xd6eee6,12,{dynamic:true,label:.26});
          if (previous && distance(l,previous)<4.5) {
            r.beam([l.x,l.y+.37,l.z],[previous.x,previous.y+.37,previous.z],.19,.135,tint,9,{dynamic:true});
          }
          previous=l;
        }
      }
      if (e.id==='vortex') {
        const t=e.burst?clamp((e.age-2.1)/.48,0,1):e.age/2.1;
        const radius=e.burst?2.1+t*3.3:5.2-t*1.45;
        r.add('ripple',e.x,e.y+.023,e.z,radius*2,.026,radius*2,tint,12,{dynamic:true,label:e.burst?t:.10});
        r.add('ripple',e.x,e.y+.051,e.z,radius*1.43,.026,radius*1.43,0xd5eae4,12,{dynamic:true,label:e.burst?t:.20});
        if (!e.burst) {
          r.add('orb',e.x,e.y+.69,e.z,.73+t*.64,.93+t*.70,.73+t*.64,tint,9,{dynamic:true});
          for (let i=0;i<7;i++) {
            const a=i*TAU/7+e.age*5.2, rr=(1.03+Math.sin(e.age*5+i)*.25)*(1-t*.48);
            r.add('orb',e.x+Math.cos(a)*rr,e.y+.48+i*.10,e.z+Math.sin(a)*rr,.13,.15,.14,0xd0eee5,3,{dynamic:true});
          }
        }
      }
      if (e.id==='beam' && e.a && e.b) {
        const warm=e.age<.68;
        if (Math.hypot(...sub(e.b,e.a))<.05) continue;
        r.beam(e.a,e.b,warm?.029:.107,warm?.030:.11,tint,3,{dynamic:true});
        if (!warm) r.beam(add(e.a,[0,.022,0]),add(e.b,[0,.022,0]),.039,.048,0xf4f1cf,3,{dynamic:true});
        const power=warm?.11+e.age*.27:.26+Math.sin(e.age*24)*.041;
        r.add('orb',...e.a,power,power,power,0xecedd4,3,{dynamic:true});
        if (!warm) r.add('orb',...e.b,.33,.35,.33,tint,9,{dynamic:true});
      }
    }
  }
}
