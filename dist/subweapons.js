import {add,clamp,dot,forward,scale,sub} from './render.js';
import {sameLevel} from './layout.js';
import {stairCrossing,stairEnd,stairNeighborShift,stairRay} from './stairs.js';
import {TEAM_INK} from './world.js';
import {INK_COST_FACTOR,PAINT_RADIUS_FACTOR} from './weapons.js';

export const SUBWEAPONS=[
  {id:'throw',name:'投げボム',role:'曲射',detail:'放物線を描き、壁や床で跳ねてから爆発。遮蔽物の裏を攻める。',cost:29,cooldown:4.8,life:1.27,radius:3.1,damage:111},
  {id:'timed',name:'時限ボム',role:'広域',detail:'足元の少し先に設置。3秒後に広い範囲を塗り、敵にダメージを与える。',cost:41,cooldown:7.2,life:3,radius:4.4,damage:147},
  {id:'slider',name:'スライドボム',role:'通路制圧',detail:'地面を滑り、敵や壁に触れるか時間切れで爆発する。',cost:26,cooldown:4.3,life:1.18,radius:2.55,damage:97},
  {id:'trap',name:'トラップ',role:'待ち伏せ',detail:'設置から0.8秒で作動し、近づいた敵を感知して爆発。1人1個。',cost:33,cooldown:7,life:22,radius:2.85,damage:105},
  {id:'curtain',name:'インクカーテン',role:'防御',detail:'最大5秒、敵のインク弾を受け止める。味方の弾は通り、被弾で壊れる。',cost:36,cooldown:8.2,life:5,hp:108},
  {id:'see',name:'See Elite',role:'索敵',detail:'投げた場所の半径3m以内に入った敵を20秒間マーキング。壁越しでも位置がわかる。',cost:24,cooldown:9,life:14,radius:3,damage:0,mark:20}
].map(weapon=>({...weapon,cost:weapon.cost*INK_COST_FACTOR}));
// A lobbed sub flies in an arc and bounces; the sensor stays where it comes to rest.
const lobbed=id=>id==='throw' || id==='see';
export const subweaponById=id=>SUBWEAPONS.find(sub=>sub.id===id) ?? SUBWEAPONS[0];

const rangeTo=(p,a)=>Math.hypot(a.x-p[0],a.z-p[2]);
const centerOf=a=>[a.x,a.y+(a.swimming?.36:.8),a.z];
const opts={dynamic:true};

export class Subweapons {
  constructor(battle) {
    this.battle=battle;
    this.items=[];
    this.sequence=0;
  }

  canUse(a) {
    const spec=subweaponById(a.subId);
    return a.down<=0 && !a.swimming && !a.ride && !a.lift && !a.giant && !a.beaming && !a.slam && !a.cloneOf &&
      (!a.airborne || lobbed(spec.id)) && (a.subReady??0)<=this.battle.clock && a.tank>=spec.cost;
  }

  use(a,yaw=a.yaw,pitch=a.pitch) {
    if (!this.canUse(a)) return false;
    const b=this.battle, spec=subweaponById(a.subId), direction=forward(yaw);
    const {id,life,cost,cooldown}=spec;
    const from=[a.x,a.y+(lobbed(id)?1.22:.44),a.z];
    const ahead=add(from,scale(direction,id==='curtain'?2.15:id==='timed'?1.25:.73));
    const wall=b.traceShot(from,ahead,true);
    const p=wall?add(wall.position,scale(wall.normal,.19)):stairEnd(from,ahead);
    const item={id,p,yaw,owner:a,until:b.clock+life};
    if (lobbed(id)) {
      item.v=[direction[0]*13.2,clamp(5.15+pitch*8.5,1.6,10.5),direction[2]*13.2];
    } else {
      const floor=b.world.support(p[0],a.y+.30,p[2]);
      if (Math.abs(floor.y-a.y)>.52 || b.world.blocked(p[0],floor.y+.04,p[2],.15,.32)) return false;
      p[1]=floor.y+.17;
      if (id==='slider') item.v=scale(direction,11.8);
      if (id==='trap') item.armAt=b.clock+.8;
      if (id==='curtain') {
        const right=forward(yaw+Math.PI/2), midpoint=add(p,[0,.71,0]);
        item.halfWidth=1.68;
        for (const sign of [-1,1]) {
          const edge=b.traceShot(midpoint,add(midpoint,scale(right,sign*1.68)),true,false);
          if (edge) item.halfWidth=Math.min(item.halfWidth,edge.t*1.68-.08);
        }
        const roof=b.traceShot(p,add(p,[0,2.15,0]),true,false);
        item.height=roof?roof.t*2.15-.05:2.15;
        if (item.halfWidth<.49 || item.height<.84) return false;
        item.hp=spec.hp;
      }
    }
    if (id==='trap' || id==='curtain') this.items=this.items.filter(other=>other.owner!==a || other.id!==id);
    item.serial=++this.sequence;
    this.items.push(item);
    a.tank-=cost;
    a.subReady=b.clock+cooldown;
    a.heat=Math.max(a.heat,.60);
    a.subs=(a.subs??0)+1;
    if (a.isPlayer) b.callbacks.sound?.('lob');
    b.callbacks.cue?.('sub',a);
    return true;
  }

  consider(a,enemy) {
    if (!this.canUse(a) || a.tank<a.tankMax*.57) return;
    const distance=rangeTo([a.x,a.y,a.z],enemy);
    const yaw=Math.atan2(enemy.x-a.x,a.z-enemy.z);
    const id=a.subId;
    const usable=id==='throw'?distance>=6 && distance<=14:id==='see'?distance>=5 && distance<=15 && !(enemy.revealUntil>this.battle.clock):
      id==='slider'?distance>=3.2 && distance<=11:
      id==='timed'?distance>=2.1 && distance<=5.2:id==='trap'?distance>=2 && distance<=4:
      distance>=4.5 && distance<=13 && a.hp<=76;
    if (usable && Math.cos(a.yaw-yaw)>.78) this.use(a,yaw,-.12);
  }

  danger(a) {
    const b=this.battle, from=centerOf(a);
    for (const item of this.items) {
      if (item.owner.team===a.team || item.id==='curtain' || item.id==='see' || item.id==='trap' && !item.triggered ||
          item.until-b.clock>=.94 || Math.abs(item.p[1]-a.y)>=2.5) continue;
      const radius=subweaponById(item.id).radius+.40, joined=!sameLevel(item.p[0],a.x);
      const shift=joined?stairNeighborShift(a.x,a.z,radius):0;
      const p=joined?[item.p[0]-shift,item.p[1],item.p[2]]:item.p;
      if (rangeTo(p,a)>=radius || joined && (!shift || !stairRay(from,p)) || b.traceShot(from,p,true)?.t<.96) continue;
      return joined?{...item,p}:item;
    }
    return null;
  }

  enemyNear(item,radius) {
    const b=this.battle, {owner,p}=item;
    const shift=stairNeighborShift(p[0],p[2],radius), enemies=b.abilities.enemies(owner,p[0]);
    if (shift) enemies.push(...b.abilities.enemies(owner,p[0]+shift));
    return enemies.some(a=>{
      if (a.shield>0 || Math.abs(a.y-p[1])>=1.15) return false;
      const end=centerOf(a), joined=!sameLevel(a.x,p[0]);
      if (joined) end[0]-=shift;
      return Math.hypot(end[0]-p[0],end[2]-p[2])<radius &&
        (!joined || stairRay(p,end)) && !b.traceShot(p,end,true);
    });
  }

  update(dt) {
    const b=this.battle;
    for (let i=this.items.length-1;i>=0;i--) {
      const item=this.items[i], {id,owner}=item;
      if (id==='curtain') {
        if (b.clock>=item.until || item.hp<=0) this.items.splice(i,1);
        continue;
      }
      if (id==='see' && b.clock>=(item.scanAt??0)) {
        item.scanAt=b.clock+.12;
        this.mark(item);
      }
      if (id==='trap' && b.clock>=item.armAt && b.clock<item.until && !item.triggered && this.enemyNear(item,1.35)) {
        item.triggered=true;
        item.until=b.clock+.23;
      }
      const travel=Math.min(dt,Math.max(0,item.until-(b.clock-dt)));
      if (travel>0 && item.v) {
        const next=add(item.p,scale(item.v,travel));
        if (lobbed(id)) {
          next[1]-=7.5*travel*travel;
          item.v[1]-=15*travel;
          const hit=b.traceShot(item.p,next,true);
          item.p=hit?add(hit.position,scale(hit.normal,.09)):stairEnd(item.p,next);
          if (hit) item.v=hit.normal[1]>.55 && Math.abs(item.v[1])<2.6?null:
            scale(sub(item.v,scale(hit.normal,1.53*dot(item.v,hit.normal))),.74);
        } else {
          const x=stairCrossing(item.p[0],item.p[2],next[0],next[2],item.p[1]);
          const floor=b.world.support(x,item.p[1]+.22,next[2]);
          const height=floor.y+.17;
          if (Math.abs(height-item.p[1])>.46 || b.traceShot(item.p,next,true) ||
              b.world.blocked(x,floor.y+.025,next[2],.16,.29)) {
            item.until=b.clock;
          } else {
            next[0]=x;
            next[1]=height;
            item.p=next;
            if (b.clock>=(item.trailAt??0)) {
              const radius=.54*PAINT_RADIUS_FACTOR;
              if (floor.raised) b.abilities.paintSurface(owner,b.downwardSurface(next[0],floor.y,next[2]),radius,.037);
              else owner.painted+=b.paint.stampGround(next[0],next[2],radius,owner.team,floor.layer,0,.037);
              item.trailAt=b.clock+.055;
            }
            if (this.enemyNear(item,.84)) item.until=b.clock;
          }
        }
      }
      if (b.clock<item.until) continue;
      this.items.splice(i,1);
      if (id==='see') {
        b.burst(item.p,owner.team,5,1.4);
        continue;
      }
      if (id==='trap' && !item.triggered) continue;
      const [x,y,z]=item.p, spec=subweaponById(id);
      const floor=b.traceShot([x,y+.025,z],[x,y-3.6,z],true,false);
      if (floor) b.splat(floor,{actor:owner,weapon:{radius:spec.radius*.83*PAINT_RADIUS_FACTOR,damage:spec.damage,depth:.069,pellets:1}});
      b.abilities.area(owner,x,y,z,spec.radius,spec.damage,undefined,true);
      b.abilities.rings.push({x,y:(floor?.position[1]??y)+.035,z,r:spec.radius,team:owner.team,until:b.clock+.53});
      b.burst(item.p,owner.team,13,3.35);
      if (owner.isPlayer) b.callbacks.sound?.('bomb');
      b.callbacks.cue?.('bomb',{x,y,z,team:owner.team});
    }
  }

  // See Elite: every opponent inside the sensor radius is marked for the owner's team.
  mark(item) {
    const b=this.battle, {owner,p}=item, spec=subweaponById('see');
    const shift=stairNeighborShift(p[0],p[2],spec.radius), enemies=b.abilities.enemies(owner,p[0]);
    if (shift) enemies.push(...b.abilities.enemies(owner,p[0]+shift));
    for (const a of enemies) {
      if (a.isBoss) continue;
      const x=a.x-(sameLevel(a.x,p[0])?0:shift);
      if (Math.hypot(x-p[0],a.z-p[2])>spec.radius || Math.abs(a.y-p[1])>2.6) continue;
      const fresh=!(a.revealUntil>b.clock);
      a.revealUntil=b.clock+spec.mark;
      a.revealTeam=owner.team;
      if (fresh) {
        item.pinged=b.clock;
        b.abilities.rings.push({x:a.x,y:a.y+.05,z:a.z,r:1.5,team:owner.team,until:b.clock+.55});
        if (owner.isPlayer) b.callbacks.sound?.('mark');
        b.callbacks.cue?.('mark',a);
      }
    }
  }

  block(from,to,team,joined=true) {
    const seam=joined && stairRay(from,to);
    if (seam) {
      const near=seam.t>0 && this.block(from,seam.point,team,false);
      if (near) return {...near,t:near.t*seam.t};
      const offset=[seam.shift,0,0];
      const far=seam.t<1 && this.block(add(seam.point,offset),add(to,offset),team,false);
      return far?{...far,t:seam.t+far.t*(1-seam.t)}:null;
    }
    let best=null;
    const span=sub(to,from);
    for (const item of this.items) {
      if (item.id!=='curtain' || item.owner.team===team || item.hp<=0 || item.until<=this.battle.clock ||
          !sameLevel(item.p[0],from[0])) continue;
      const normal=forward(item.yaw), length=dot(span,normal);
      if (Math.abs(length)<1e-6) continue;
      const t=dot(sub(item.p,from),normal)/length;
      if (t<0 || t>1 || best && t>=best.t) continue;
      const p=add(from,scale(span,t)), height=p[1]-item.p[1];
      if (height<-.14 || height>item.height || Math.abs(dot(sub(p,item.p),forward(item.yaw+Math.PI/2)))>item.halfWidth) continue;
      best={t,p,item};
    }
    return best;
  }

  draw(r,viewX) {
    const {clock}=this.battle;
    for (const i of this.items) {
      const [x,y,z]=i.p;
      if (!sameLevel(x,viewX) || i.until<=clock) continue;
      const spec=subweaponById(i.id), tint=TEAM_INK[i.owner.team];
      if (i.id==='curtain') {
        const right=forward(i.yaw+Math.PI/2), height=i.height+.14, base=y-.14;
        const wear=1-clamp(Math.min(i.hp/spec.hp,(i.until-clock)*1.6),.13,1);
        r.add('curtain',x,base+height*.5,z,i.halfWidth*2,height,1,tint,16,
          {dynamic:true,yaw:-i.yaw,label:wear});
        for (const side of [-1,1]) {
          const post=add([x,base+height*.5,z],scale(right,side*i.halfWidth));
          r.add('cylinder',...post,.09,height,.09,0x283d43,4,opts);
          r.add('orb',post[0],base+height,post[2],.18,.16,.18,tint,3,opts);
        }
        continue;
      }
      if (i.id==='see') {
        const pulse=(clock*1.15)%1, hot=clock-(i.pinged??-9)<.5;
        r.add('cylinder',x,y,z,.30,.10,.30,0x283d43,4,opts);
        r.add('cylinder',x,y+.07,z,.20,.06,.20,tint,3,opts);
        r.add('cylinder',x,y+.24,z,.035,.30,.035,0x9fb0a0,4,opts);
        r.add('orb',x,y+.42,z,hot?.19:.12,hot?.19:.12,hot?.19:.12,hot?0xfff2c2:tint,3,opts);
        if (!i.v) {
          r.add('ripple',x,y-.05,z,spec.radius*2,.03,spec.radius*2,tint,12,{dynamic:true,label:.52});
          r.add('ripple',x,y-.04,z,spec.radius*2*pulse,.03,spec.radius*2*pulse,0xfff2c2,12,{dynamic:true,label:.25+pulse*.7});
        }
        continue;
      }
      const trap=i.id==='trap', timed=i.id==='timed', size=timed?.49:trap?.37:.38;
      if (i.id==='slider') {
        const direction=forward(i.yaw), right=forward(i.yaw+Math.PI/2);
        const basis=[right,[0,1,0],direction];
        r.add('bevel',x,y,z,.38,.23,.65,0x35494b,4,{dynamic:true,basis});
        r.add('bevel',x,y+.12,z,.29,.095,.47,tint,9,{dynamic:true,basis});
        for(const side of [-1,1]) {
          const foot=add([x,y-.075,z],scale(right,side*.23));
          r.add('box',...foot,.07,.08,.61,0x9fb0a0,4,{dynamic:true,basis});
        }
        const nose=add([x,y+.02,z],scale(direction,.33));
        r.add('orb',...nose,.10,.075,.065,0xf0dfb5,3,opts);
        continue;
      }
      r.add(trap || timed?'cylinder':'orb',x,y,z,size,trap?.14:size*.86,size,0x283d43,4,opts);
      r.add('cylinder',x,y+(trap?.075:.16),z,size*.77,.09,size*.77,tint,3,opts);
      const fuse=i.until-clock;
      r.add('orb',x,y+(trap?.13:.23),z,.09,.09,.09,trap && !i.triggered?tint:0xffe8a0,3,opts);
      if(timed) {
        r.add('bevel',x,y+.24,z,.27,.075,.19,0xd2d4bf,4,opts);
        r.add('box',x,y+.283,z,.21,.014,.13,0x273f41,4,opts);
        for(let bar=0;bar<3;bar++)
          r.add('box',x-.065+bar*.065,y+.293,z,.032,.008,.074,tint,3,opts);
      } else if(trap) {
        for(let pin=0;pin<3;pin++) {
          const direction=forward(pin*Math.PI*2/3), edge=add([x,y+.03,z],scale(direction,.20));
          r.add('bevel',...edge,.09,.12,.14,0x789188,4,{dynamic:true,yaw:pin*Math.PI*2/3});
        }
      } else {
        r.add('bevel',x,y+.22,z,.10,.07,.18,0xb7b99e,4,opts);
        r.add('ripple',x,y+.29,z,.14,.025,.14,0xb7b99e,4,
          {dynamic:true,basis:[[1,0,0],[0,0,1],[0,-1,0]]});
      }
      if (timed || i.triggered) {
        const warning=.19+.21*(.5+.5*Math.sin(clock*(fuse<1?18:8)));
        r.add('ripple',x,y-.136,z,spec.radius*2,.03,spec.radius*2,tint,12,{dynamic:true,label:warning});
      }
    }
  }
}
