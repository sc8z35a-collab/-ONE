import {clamp} from './render.js';
import {zoneOf} from './layout.js';
import {stairLane} from './stairs.js';
import {bearing,gap} from './npc-combat.js';

const COVER_OFFSETS=[[0,0],[-.8,0],[-1.7,-.8],[-1.7,.8],[0,1.4],[0,-1.4],[.9,1.8],[.9,-1.8],[-2.4,0]];
const PEEK_OFFSETS=[.86,1.43];
const _coverProbe={x:0,y:0,z:0,car:null,apartmentVisits:0};

export class NpcCover {
  constructor(battle,combat) {
    this.battle=battle;
    this.combat=combat;
  }

  find(a,foe) {
    const b=this.battle, d=gap(a,foe);
    if (a.giant || a.weapon.roller || a.airborne || d<4.4 || d>27 || stairLane(a.x,a.z)) return null;
    const ux=(foe.x-a.x)/d, uz=(foe.z-a.z)/d;
    const fx=foe.x, fy=foe.y+1.19, fz=foe.z;
    const ax=a.x, ay=a.y, az=a.z, myInk=a.team+1;
    let best=null, score=-Infinity;
    for (let i=0;i<COVER_OFFSETS.length;i++) {
      const ahead=COVER_OFFSETS[i][0], side=COVER_OFFSETS[i][1];
      const x=ax+ux*ahead-uz*side, z=az+uz*ahead+ux*side;
      const floor=b.world.support(x,ay,z);
      // Cheap-first: test enemy LOS occlusion before running 7-step motion.segment!
      if (!b.lineBlocked(fx,fy,fz,x,floor.y+.93,z,.96)) continue;
      // Score upper-bound pruning before segment walk.
      const hd=Math.sqrt((x-ax)*(x-ax)+(z-az)*(z-az));
      _coverProbe.x=x; _coverProbe.y=floor.y; _coverProbe.z=z;
      const ink=b.surfaceInk(_coverProbe,floor);
      const baseVal=3-hd*.40+(ink===myInk?1.5:ink?-1.3:0);
      if (baseVal-.86*.53<=score) continue;
      if (!b.motion.segment(a,x,z,.44,1.70)) continue;
      _coverProbe.car=a.car??null; _coverProbe.apartmentVisits=a.apartmentVisits??0;
      let hide=null;
      for (let di=0;di<2;di++) {
        const dir=di===0?-1:1;
        for (let oi=0;oi<2;oi++) {
          const offset=PEEK_OFFSETS[oi];
          const value=baseVal-offset*.53;
          if (value<=score) break;
          const px=x-uz*dir*offset, pz=z+ux*dir*offset;
          const ground=b.world.support(px,floor.y,pz);
          if (b.lineBlocked(px,ground.y+1.22,pz,fx,fy,fz,.96)) continue;
          if (!b.motion.segment(_coverProbe,px,pz,.44,1.70)) continue;
          if (!hide) hide={x,y:floor.y,z};
          score=value;
          best={hide,peek:{x:px,y:ground.y,z:pz},dir};
          break;
        }
      }
    }
    return best;
  }

  run(a,s,sight,dt) {
    const b=this.battle, t=b.clock;
    let c=s.cover;
    if (c && (c.level!==zoneOf(a.x) || t>c.until || sight?.visible && gap(c.contact,sight.foot)>4.8)) {
      c=s.cover=null;
      s.coverScan=t+1;
    }
    if (!c && sight?.visible && t>=(s.coverScan??0)) {
      s.coverScan=t+.89+b.rng()*.6;
      const site=this.find(a,sight.foot);
      if (site) c=s.cover={...site,contact:{...sight.foot},level:zoneOf(a.x),phase:'approach',until:t+6.35,due:t+1.58};
    }
    if (!c) return false;
    if (a.airborne || a.giant || stairLane(a.x,a.z)) {s.cover=null;return false;}
    if (!sight?.visible && t>(sight?.at??-Infinity)+1.25 && c.phase!=='back') {c.phase='back';c.due=t+1;}
    const target=sight?.point??[c.contact.x,c.contact.y+1.15,c.contact.z], aim=bearing(a,target);
    const common={look:aim,pitch:clamp(Math.atan2(target[1]-a.y-1.23,Math.max(.1,Math.hypot(target[0]-a.x,target[2]-a.z))),-.58,.53),ready:.89};
    if (c.phase==='approach' || c.phase==='back') {
      a.intent=c.phase==='back'?'射撃後に遮蔽へ戻る':'遮蔽物の裏へ移動';
      b.steer(a,c.hide,dt,4.65,false,{...common,brace:.79});
      if (gap(a,c.hide)<.21) {
        if (t>(sight?.at??-Infinity)+1.20) {s.cover=null;s.coverScan=t+.9;}
        else {c.phase='hold';c.due=t+.14+b.rng()*.34;}
      } else if (t>c.due) s.cover=null;
      return true;
    }
    if (c.phase==='hold') {
      a.intent='遮蔽物で射撃の間合いを測る';
      b.steer(a,c.hide,dt,1.8,false,{...common,brace:.92});
      if (t>=c.due && a.tank>=a.weapon.cost*1.05) {c.phase='peek';c.due=t+.94;}
      return true;
    }
    a.intent=c.phase==='peek'?'遮蔽から身を出す':'身を出して短く射撃';
    b.steer(a,c.peek,dt,3.45,false,{...common,brace:.22,peek:c.dir*.82});
    if (c.phase==='peek' && gap(a,c.peek)<.25) {
      c.phase='fire';
      c.due=t+(a.weapon.charge?1.13:.62);
    }
    if (c.phase==='fire' && this.combat.shoot(a,s,sight,dt)) {
      c.fired=(c.fired??0)+1;
      if (c.fired>=2 || a.weapon.charge) c.due=t;
    }
    if (t>=c.due || a.damageAge<.11) {c.phase='back';c.due=t+1.06;c.fired=0;}
    return true;
  }
}
