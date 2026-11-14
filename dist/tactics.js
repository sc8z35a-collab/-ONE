import {METRO,RAIL,UNDER_X,isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {clamp,forward} from './render.js';
import {STAIRS,STAIR_RUN,STAIR_SEAM,stairLane,stairPoint} from './stairs.js';
import {TRAIN_DOORS} from './train-model.js';
import {NpcCombat,bearing,bossOrTentacle,muzzleClear} from './npc-combat.js';
import {NpcCover} from './npc-cover.js';
import {NpcSquads} from './npc-squad.js';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const stairs=STAIRS.flatMap(stair=>[0,1].map(level=>({kind:'stairs',id:stair.id+level,level,stair,...stairPoint(stair,level)})));
const stops=[RAIL,METRO].flatMap((line,level)=>[-1,1].map(side=>({
  kind:'station',id:'station'+level+side,level,side,x:line.center+side*line.x,z:line.platformZ
})));
const portals=[...stairs,...stops];
const sectors=[
  [[-40,3],[-37,-19],[-32,19],[-24,-2],[-19,8],[-17,-21],[-8,15],[-6,-11],[0,0],[1,-21],
   [5,16],[12,-13],[17,0],[21,12],[24,-19],[34,5],[39,-19],[39,18]],
  [[-42,-7],[-37,3],[-33,22],[-30,-22],[-22,10],[-16,-15],[-7,4],[0,-14],[0,11],[10,-15],
   [14,7],[21,20],[24,-11],[30,5],[37,-21],[41,-3],[37,22],
   [-57,-33],[-53,5],[-53,25],[-38,-36],[-19,-36],[0,-37],[19,-36],[38,-36],[56,-33],[54,7],[54,25],[-24,33],[24,33]]
];
const valid=a=>a && a.down<=0 && !a.ride && !a.lift && (!(a.isBoss||a.isRaider) || a.active);
const height=a=>a.isBoss?2.64:a.giant?1.49:a.swimming?.37:1.07;
const tempo=5.10;

export function trainArrival(rail,side,ready) {
  return rail.arrival(rail.section,side,rail.section,-side,ready);
}

function segmentDistance(point,a,b) {
  const dx=b.x-a.x,dz=b.z-a.z,length=dx*dx+dz*dz;
  const t=length?clamp(((point.x-a.x)*dx+(point.z-a.z)*dz)/length,0,1):0;
  return Math.hypot(point.x-a.x-t*dx,point.z-a.z-t*dz);
}

function role(actor) {
  if (actor.index%4===2 || actor.weapon.id==='fan' || actor.weapon.id==='dual') return 'flank';
  if (actor.weapon.charge || actor.weapon.id==='prism') return 'anchor';
  if (['lob','blast','coil'].includes(actor.weapon.id)) return 'support';
  return 'lead';
}

export class Tactics {
  constructor(battle) {
    this.battle=battle;
    this.contacts=[new Map(),new Map()];
    this.states=new WeakMap();
    this.combat=new NpcCombat(battle);
    this.cover=new NpcCover(battle,this.combat);
    this.squads=new NpcSquads(this);
    this.walking=battle.world.portalWalking ??= new Map();
    this.sectors=battle.world.tacticalSectors ??= sectors.map((list,level)=>[
      ...list.map(([x,z])=>({x:x+(level===1?UNDER_X:0),z})),...stops.filter(s=>s.level===level)
    ].map(p=>battle.navs[level].nearest(p)).filter(Boolean));
  }

  state(actor) {
    let s=this.states.get(actor);
    if (!s) {s={plan:null,replan:0,fightAt:0,recovering:false};this.states.set(actor,s);}
    return s;
  }

  observe(bot,foe,point=foe) {
    if (!point || !foe) return;
    this.contacts[bot.team]?.set(foe,{x:point.x,y:point.y,z:point.z,until:this.battle.clock+7.5});
  }

  intelligence(actor,level) {
    const table=this.contacts[actor.team];
    if (!table) return [];
    const now=this.battle.clock, result=[];
    for (const [key,entry] of table) {
      if (entry.until<now || !valid(key)) table.delete(key);
      else if (zoneOf(entry.x)===level) result.push({...entry,fresh:(entry.until-now)/7.5});
    }
    return result;
  }

  pathLength(a,c) {
    const nav=this.battle.navs[a.level], d=distance(a,c);
    if (!a.id || !c.id) return d*(d<29 && nav.clear(a,c,.53)?1:1.14)+Math.min(5.8,Math.abs(
      this.battle.world.floor(a.x,a.z).y-this.battle.world.floor(c.x,c.z).y)*1.06);
    const key=[a.id,c.id].sort().join('/');
    if (this.walking.has(key)) return this.walking.get(key);
    const path=nav.route(a,nav.nearest(c));
    let value=Infinity;
    if (path.length) {
      let previous=a;
      value=0;
      for (const p of [...path,c]) {
        value+=distance(previous,p);
        previous=p;
      }
    }
    this.walking.set(key,value);
    return value;
  }

  trip(actor,goal,{trains=true,avoid=false}={}) {
    const b=this.battle, level=zoneOf(actor.x), targetLevel=zoneOf(goal.x);
    if (level>=2 || targetLevel>=2) return null;
    const a={x:actor.x,z:actor.z,level}, target={x:goal.x,z:goal.z,level:targetLevel};
    const nodes=[a,target,...portals], n=nodes.length;
    const costs=new Float64Array(n).fill(Infinity), elapsed=new Float64Array(n), visited=new Uint8Array(n), paths=new Array(n);
    const knowledge=[this.intelligence(actor,0),this.intelligence(actor,1)];
    const riskOf=(from,to)=>knowledge[from.level].reduce((total,k)=>{
      const near=segmentDistance(k,from,to);
      return total+Math.max(0,1-near/15)*k.fresh;
    },0);
    costs[0]=0;
    const speed=avoid?4.78:tempo;
    for (let k=0;k<n;k++) {
      let at=-1,best=Infinity;
      for (let i=0;i<n;i++) if (!visited[i] && costs[i]<best) {at=i;best=costs[i];}
      if (at<0 || at===1) break;
      visited[at]=1;
      const from=nodes[at];
      for (let j=1;j<n;j++) {
        if (j===at || visited[j]) continue;
        const to=nodes[j];
        let walk=Infinity, penalty=0, step;
        if (from.level===to.level) {
          walk=this.pathLength(from,to)/speed;
          const risk=riskOf(from,to);
          penalty=Math.min(19,risk*(avoid?6.1:3.1))*Math.min(1,walk/3);
          step={kind:'walk',to};
        }
        if (from.kind==='stairs' && to.kind==='stairs' && from.stair===to.stair) {
          walk=STAIR_RUN/(speed*.81)+.45;
          penalty=riskOf(to,to)*(avoid?2.5:1.15);
          step={kind:'stairs',stair:to.stair,to};
        }
        if (trains && from.kind==='station' && to.kind==='station') {
          for (const rail of [b.transit,b.metro]) {
            const ready=Math.max(b.elapsed,rail.time)+elapsed[at], arrive=rail.arrival(from.level,from.side,to.level,to.side,ready);
            const ride=arrive-ready, danger=rail.train.wetness*8+rail.train.risk*8+(1-rail.integrity/720)*5;
            const exposure=riskOf(from,from)*Math.min(3,ride*.21)+riskOf(to,to)*1.7+danger;
            if (ride+exposure<walk+penalty) {
              walk=ride;penalty=exposure;
              step={kind:'train',rail:rail.homeLevel,level:from.level,from:from.side,to};
            }
          }
        }
        const cost=costs[at]+walk+penalty;
        if (cost>=costs[j]) continue;
        costs[j]=cost;
        elapsed[j]=elapsed[at]+walk;
        paths[j]={prev:at,step};
      }
    }
    if (!Number.isFinite(costs[1])) return null;
    const steps=[];
    for (let at=1;at>0;at=paths[at].prev) steps.unshift(paths[at].step);
    return {goal,steps,cost:costs[1]};
  }

  descend(actor,stair,level,dt) {
    const b=this.battle,current=zoneOf(actor.x), entry=stairPoint(stair,current);
    const here=stairLane(actor.x,actor.z,.19);
    if (here?.stair!==stair && distance(actor,entry)>1.35) return b.navigate(actor,entry,dt,4.98);
    const next=current===level?entry:stairPoint(stair,current,STAIR_SEAM+(level===1?.56:-.56));
    return b.steer(actor,next,dt,4.64,actor.team>=0 && (actor.hp<65 || actor.tank<48));
  }

  enterCabinExit(actor,rail,side,dt) {
    const t=rail.train, {cabinX,doorSide}=rail.line;
    if (!t.stop || t.stop!==side || t.doorOpen<.36) return false;
    const door=TRAIN_DOORS.reduce((a,c)=>Math.abs(cabinX+a-actor.x)<Math.abs(cabinX+c-actor.x)?a:c);
    const target={x:cabinX+door,z:doorSide*.88};
    if (distance(actor,target)<.90 && rail.use(actor)) return true;
    return this.battle.navigate(actor,target,dt,4.32);
  }

  leaveAtStop(actor,rail,dt) {
    const {stop}=rail.train, {section}=rail;
    if (!stop) return false;
    const destination=actor.cabinToSide
      ?stop===actor.cabinToSide && section===actor.cabinToLevel
      :stop!==actor.cabinFrom || section!==actor.cabinFromLevel;
    return destination && this.enterCabinExit(actor,rail,stop,dt);
  }

  follow(actor,s,dt,swim=false) {
    const b=this.battle, plan=s.plan;
    if (!plan?.steps.length) return false;
    for (let i=0;i<4 && plan.steps.length;i++) {
      const step=plan.steps[0], level=zoneOf(actor.x);
      if (step.kind==='walk') {
        if (level!==step.to.level) {s.plan=null;return false;}
        if (distance(actor,step.to)<.84) {plan.steps.shift();continue;}
        if (!b.navigate(actor,step.to,dt,actor.isRaider?3.42:5.28,swim)) {s.plan=null;return false;}
        return true;
      }
      if (step.kind==='stairs') {
        actor.intent=step.to.level===1?'階段で地下へ':'階段で地上へ';
        if (level===step.to.level && distance(actor,step.to)<.92) {plan.steps.shift();continue;}
        return this.descend(actor,step.stair,step.to.level,dt);
      }
      const rail=(step.rail??step.level)===0?b.transit:b.metro, t=rail.train;
      if (rail.failed() || t.phase==='return') {s.plan=null;s.replan=b.clock;return false;}
      if (step.boarded) {
        if (isCabin(actor.x)) {
          actor.intent='車内で移動中';
          return rail.section===step.to.level && this.enterCabinExit(actor,rail,step.to.side,dt);
        }
        if (level===step.to.level && distance(actor,step.to)<8.8) {plan.steps.shift();continue;}
        s.plan=null;
        s.replan=b.clock;
        return false;
      }
      actor.intent=step.level===0?'高架列車で横断':'地下鉄で裏へ回る';
      if (rail.section===step.level && t.stop===step.from && rail.use(actor)) {
        step.boarded=true;
        actor.cabinToSide=step.to.side;
        actor.cabinToLevel=step.to.level;
        actor.trainTrips=(actor.trainTrips ?? 0)+1;
        return true;
      }
      const eta=rail.arrival(step.level,step.from,step.to.level,step.to.side,Math.max(b.elapsed,rail.time));
      if (!Number.isFinite(eta) || eta-b.elapsed>120) {s.plan=null;s.replan=b.clock;return false;}
      const line=step.level===0?RAIL:METRO;
      const door={x:line.center+step.from*line.x,z:line.platformZ-line.doorSide*.49};
      if (distance(actor,door)>.22) b.navigate(actor,door,dt,3.8,swim);
      else b.motion.drive(actor,0,0,dt,{swim});
      return true;
    }
    return false;
  }

  railFlank(actor) {
    const b=this.battle, current=zoneOf(actor.x), home=actor.team===0?-1:1;
    if (role(actor)!=='flank' || actor.hp<70 || actor.tank<actor.weapon.cost*2.5 || localX(actor.x)*home<5) return null;
    let best=null, advantage=0;
    for (const level of [current,1-current]) {
      const line=level===0?RAIL:METRO;
      const from=stops.find(stop=>stop.level===level && stop.side===home);
      const to=stops.find(stop=>stop.level===level && stop.side!==home);
      const goal=b.navs[level].nearest({x:to.x+home*6.0,z:to.z+line.doorSide*9.5});
      if (!goal || Math.hypot(localX(actor.x)-localX(from.x),actor.z-from.z)>38) continue;
      const occupied=b.actors.some(a=>a!==actor && a.team===actor.team && a.down<=0 &&
        this.states.get(a)?.plan?.steps.some(step=>step.kind==='train' && step.level===level && step.from===home));
      if (occupied) continue;
      const approach=this.trip(actor,from,{trains:false,avoid:true});
      if (!approach || approach.cost>17) continue;
      const now=b.elapsed;
      for (const rail of [b.transit,b.metro]) {
        const board=rail.boardingTime(level,home,now+approach.cost);
        const eta=rail.arrival(level,home,level,-home,now+approach.cost);
        if (!Number.isFinite(eta) || eta-now>43 || board-now-approach.cost>9.3) continue;
        const traffic=this.intelligence(actor,level);
        const landingRisk=traffic.reduce((total,foe)=>total+Math.max(0,1-distance(to,foe)/14)*foe.fresh,0);
        const cost=eta-now+distance(to,goal)/tempo+landingRisk*6+rail.train.wetness*9;
        const foot=this.trip(actor,goal,{trains:false,avoid:true});
        const concealment=level===1?14:10;
        const benefit=(foot?.cost??cost)+concealment-cost;
        if (benefit<=advantage) continue;
        advantage=benefit;
        best={goal,cost,steps:[...approach.steps,{kind:'train',rail:rail.homeLevel,level,from:home,to},{kind:'walk',to:{...goal,level}}]};
      }
    }
    return best;
  }

  choose(actor,s) {
    const rail=this.railFlank(actor);
    if (rail) return rail;
    const b=this.battle, level=zoneOf(actor.x), kind=role(actor), home=actor.team===0?-1:1;
    const front=kind==='anchor'?5:kind==='flank'?22:kind==='support'?10:13;
    const signs=(actor.index+(kind==='flank'?Math.floor(actor.index/4):0))%2===0?-1:1;
    const lane=signs*(kind==='flank'?15:kind==='anchor'?7:11);
    const contacts=[this.intelligence(actor,0),this.intelligence(actor,1)];
    const ranks=[];
    for (const [zone,points] of this.sectors.entries()) {
      const own=b.actors.filter(a=>a.team===actor.team && a!==actor && valid(a));
      for (const p of points) {
        const x=localX(p.x), f=b.world.floor(p.x,p.z), d=distance({x:localX(actor.x),z:actor.z},{x,z:p.z});
        if (d<4.3 && zone===level) continue;
        let fresh=0;
        for (const [dx,dz] of [[0,0],[1.8,0],[-1.8,0],[0,1.8],[0,-1.8]]) {
          const at=b.world.floor(p.x+dx,p.z+dz);
          const ink=b.paint.get(p.x+dx,p.z+dz,at.layer);
          if (ink!==actor.team+1) fresh+=ink?.85:1.15;
        }
        const demand=contacts[zone].reduce((n,c)=>n+Math.max(0,1-distance(c,p)/15)*c.fresh,0);
        const allies=own.filter(a=>sameLevel(a.x,p.x) && distance(a,p)<8.5).length;
        const claimed=own.some(a=>{const goal=this.states.get(a)?.plan?.goal;return goal && sameLevel(goal.x,p.x) && distance(goal,p)<4.2;});
        const flank=kind==='flank'?(zone===1?5.15:0):zone===0?1.4:0;
        const cover=kind==='anchor'?Math.max(0,f.y+(zone===1?8:0))*.7:0;
        let score=fresh*1.08+flank+cover+Math.min(1,allies)*.6-Math.max(0,allies-1)*1.9-(claimed?4.1:0);
        score-=Math.abs(x+home*front)*.080+Math.abs(p.z-lane)*.095+d*.032;
        score+=kind==='support'?demand*.62:kind==='flank'?-demand*1.42:demand*.15;
        if (x*home>15 && demand>.4) score+=demand*(kind==='anchor'?3.9:2.6);
        if (s.previous && distance(p,s.previous)<4) score-=2.5;
        ranks.push({p,score});
      }
    }
    ranks.sort((a,c)=>c.score-a.score);
    let best=null,value=-Infinity;
    for (const {p,score} of ranks.slice(0,4)) {
      const plan=this.trip(actor,p);
      if (!plan) continue;
      const v=score-plan.cost*.20;
      if (v>value) {value=v;best=plan;}
    }
    if (best) s.previous=best.goal;
    return best;
  }

  recover(actor,enemy,s,dt) {
    const b=this.battle, nav=b.navs[zoneOf(actor.x)];
    const f=b.world.floor(actor.x,actor.z), ink=b.paint.get(actor.x,actor.z,f.layer);
    if (b.clock>=s.refillAt || !s.refill) {
      s.refillAt=b.clock+.78;
      let chosen=null,best=-Infinity;
      for (const [dx,dz] of [[0,0],[-4,0],[4,0],[0,-4],[0,4],[-6,-5],[-6,5],[6,-5],[6,5],[-10,0],[10,0],[0,-8],[0,8]]) {
        const p=nav.nearest({x:actor.x+dx,z:actor.z+dz});
        if (!p || distance(actor,p)>13.4) continue;
        const ground=b.world.floor(p.x,p.z);
        const owner=b.paint.get(p.x,p.z,ground.layer);
        const screened=enemy && b.traceShot([enemy.x,enemy.y+height(enemy),enemy.z],[p.x,ground.y+.62,p.z])?.t<.95;
        if (enemy && !screened && distance(p,enemy)<7.3) continue;
        const score=(owner===actor.team+1?7.4:owner?-5:0)+(screened?7:0)-distance(actor,p)*.48+
          (enemy?clamp((distance(p,enemy)-distance(actor,enemy))*.48,-4,4):0);
        if (score>best) {best=score;chosen=p;}
      }
      s.refill=chosen;
    }
    actor.intent=ink===actor.team+1?'自インクで立て直す':'遮蔽物へ退避';
    if (s.refill && distance(actor,s.refill)>.72 && b.navigate(actor,s.refill,dt,5.32,ink===actor.team+1)) return true;
    if (enemy && !b.traceShot([enemy.x,enemy.y+height(enemy),enemy.z],[actor.x,actor.y+.55,actor.z],true)) return false;
    b.motion.drive(actor,0,0,dt,{swim:true});
    return true;
  }

  paintAhead(actor,goal) {
    const b=this.battle;
    if (actor.weapon.roller && b.roll(actor,true)) return;
    if (actor.fire>0 || actor.swimming || actor.tank<actor.weapon.cost || actor.weapon.charge && actor.tank<actor.tankMax*.42) return;
    const [fx,,fz]=forward(actor.yaw);
    const muzzle=b.muzzle(actor);
    for (const [reach,side] of [[6.4,0],[4.6,2.2],[4.6,-2.2],[2.6,0]]) {
      const target=goal && sameLevel(goal.x,actor.x) && distance(actor,goal)<8 && side===0?goal:
        {x:actor.x+fx*reach-fz*side,z:actor.z+fz*reach+fx*side};
      if (!b.world.stand(target.x,target.z,.21)) continue;
      const f=b.world.floor(target.x,target.z);
      if (b.paint.get(target.x,target.z,f.layer)===actor.team+1) continue;
      const p=[target.x,f.y+.015,target.z];
      if (b.traceShot(muzzle,p)?.t<.94 || !muzzleClear(b,actor,p,actor.weapon.charge?.63:1)) continue;
      b.shoot(actor,p,actor.weapon.charge?.63:1);
      return;
    }
  }

  crew(actor,enemy,dt,sight=null) {
    const b=this.battle,s=this.state(actor), level=zoneOf(actor.x), d=enemy?distance(actor,enemy):Infinity;
    const hazard=b.subweapons.danger(actor) ?? bossOrTentacle(b,actor);
    if (hazard) {
      s.cover=null;
      actor.charge=0;
      const stair=stairLane(actor.x,actor.z);
      if (stair) {
        const direction=Math.sign((actor.x-hazard.p[0])*stair.stair.dir) || (level===0?-1:1);
        const escape=stairPoint(stair.stair,level,clamp(stair.t+direction*4.7,0,STAIR_RUN));
        actor.intent='爆発範囲から退避';
        b.steer(actor,escape,dt,5.8);
        return;
      }
      const back=forward(actor.yaw+Math.PI);
      const dx=actor.x-hazard.p[0] || back[0]*.2, dz=actor.z-hazard.p[2] || back[2]*.2;
      const length=Math.max(.1,Math.hypot(dx,dz));
      const escape=b.navs[level].nearest({x:actor.x+dx/length*4.7,z:actor.z+dz/length*4.7});
      actor.intent='爆発範囲から退避';
      if (escape && b.navigate(actor,escape,dt,5.8)) return;
    }
    if (actor.hp<51 || actor.tank<actor.weapon.cost*1.9) s.recovering=true;
    if (actor.hp>79 && actor.tank>actor.tankMax*.55) s.recovering=false;
    if (enemy && actor.superCharge>=100) {
      const id=actor.weapon.special, group=this.intelligence(actor,level).filter(c=>distance(c,enemy)<6.5).length;
      const use=id==='shield'?actor.hp<68:id==='health'?actor.hp<61:id==='range'?d>13:
        id==='slam'?d<5.2:id==='giant'?d<8.4:id==='beam'?d>5:id==='vortex'?group>=2 || d<9.5:d<17;
      if (use && b.abilities.activate(actor) && actor.slam) return;
    }
    if (s.recovering && level<2 && !stairLane(actor.x,actor.z) && this.recover(actor,enemy,s,dt)) {s.cover=null;return;}
    if (level>=2) {
      if (this.follow(actor,s,dt)) return;
      if (enemy && this.combat.engage(actor,enemy,s,dt,sight)) return;
      const rail=b.cabinTrain(actor.x);
      if (this.leaveAtStop(actor,rail,dt)) return;
      actor.intent='車内を確保';
      const target={x:rail.line.cabinX+(actor.index%2===0?-1:1)*5.6,z:.08};
      if (distance(actor,target)>.7) b.navigate(actor,target,dt,3.75);
      else b.motion.drive(actor,0,0,dt,{swim:actor.tank<actor.tankMax*.5});
      this.paintAhead(actor,null);
      return;
    }
    const order=this.squads.orders.get(actor), committed=s.plan?.steps.some(step=>step.kind==='train');
    const stair=stairLane(actor.x,actor.z);
    if (!stair && !committed && order?.kind==='flank' && d>5.7 && distance(actor,order.goal)>.94) {
      const point=sight?.point??[order.contact.x,(order.contact.y??actor.y)+1.1,order.contact.z];
      if (b.navigate(actor,order.goal,dt,5.28,false,{look:bearing(actor,point),ready:.83})) {
        actor.intent='味方の射線に合わせて側面へ';
        if (enemy) this.combat.shoot(actor,s,sight,dt);
        return;
      }
    }
    if (!stair && (!committed || d<6.2) && (enemy || s.cover)) {
      if (this.cover.run(actor,s,sight,dt)) return;
      if (enemy && this.combat.engage(actor,enemy,s,dt,sight)) return;
    }
    if (!enemy && !stair && !committed && !order && (sight?.heard || sight?.foot && b.clock-sight.at<2.9)) {
      const contact=sight.foot && b.clock-sight.at<2.9?sight.foot:sight.heard;
      const look=bearing(actor,[contact.x,actor.y+1,contact.z]);
      if (s.inspect!==contact) {
        s.inspect=contact;
        s.inspectAt=b.clock+.66;
      }
      if (b.clock<s.inspectAt || distance(actor,contact)<1.9) {
        actor.intent=contact===sight.heard?'発砲音の方向を確認':'最後に目撃した地点を警戒';
        b.motion.drive(actor,0,0,dt,{look,ready:.85,brace:.21});
        return;
      }
      if (b.navigate(actor,contact,dt,3.95,false,{look,ready:.85,brace:.21})) return;
    }
    const currentStair=stairLane(actor.x,actor.z);
    if (currentStair && !s.plan?.steps.length) {
      this.descend(actor,currentStair.stair,level,dt);
      return;
    }
    actor.charge=0;
    if ((!s.plan?.steps.length && b.clock>=s.replan) ||
        (b.clock>=s.replan && s.plan?.steps[0]?.kind==='walk' && !currentStair && s.plan.steps.length===1)) {
      s.plan=this.choose(actor,s);
      s.replan=b.clock+4.4+b.rng()*2.9;
    }
    if (!enemy && actor.weapon.special!=='range' && actor.tank>65 &&
        this.contacts[actor.team].size===0 && actor.index%4===2 && b.elapsed>16) b.abilities.summon(actor);
    actor.intent=role(actor)==='flank'?'別ルートから裏取り':role(actor)==='anchor'?'射線の通る場所を確保':'味方と塗りを広げる';
    const ink=b.paint.get(actor.x,actor.z,b.world.floor(actor.x,actor.z).layer);
    const swim=ink===actor.team+1 && (actor.tank<actor.tankMax*.77 || s.plan?.cost>9);
    if (this.follow(actor,s,dt,swim)) {
      if (!actor.ride && !enemy && s.plan?.steps[0]?.kind==='walk') this.paintAhead(actor,s.plan?.steps[0]?.to);
      return;
    }
    if (enemy && this.combat.engage(actor,enemy,s,dt,sight)) return;
    b.motion.drive(actor,0,0,dt,{swim});
    this.paintAhead(actor,s.plan?.goal);
  }

  raider(actor,dt) {
    const b=this.battle, s=this.state(actor), level=zoneOf(actor.x);
    if (level>=2) {
      const rail=b.cabinTrain(actor.x);
      if (this.follow(actor,s,dt)) return true;
      return this.leaveAtStop(actor,rail,dt);
    }
    if (this.follow(actor,s,dt)) return true;
    const stair=stairLane(actor.x,actor.z);
    if (stair) return this.descend(actor,stair.stair,level,dt);
    if (b.clock<s.replan) return false;
    s.replan=b.clock+8.2+actor.index;
    const seen=actor.lastSeen;
    if (!seen || seen.until<b.clock) return false;
    const access=stairLane(seen.x,seen.z,.7);
    if (access && sameLevel(actor.x,seen.x) && distance(actor,seen)<12) {
      const side=1-level;
      s.plan=this.trip(actor,stairPoint(access.stair,side),{trains:false});
    } else {
      const rail=[b.transit,b.metro].find(train=>train.section===level && !train.connection), from=localX(actor.x)<0?-1:1;
      if (!rail) return false;
      if (rail.time-rail.boardedAt>4.4 || distance(actor,{x:rail.line.center+from*rail.line.x,z:rail.line.platformZ})>11) return false;
      const goal={x:rail.line.center-from*rail.line.x,z:rail.line.platformZ};
      const plan=this.trip(actor,goal);
      if (plan?.steps.some(step=>step.kind==='train')) s.plan=plan;
    }
    return this.follow(actor,s,dt);
  }
}
