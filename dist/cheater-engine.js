import {TAU,clamp,forward} from './render.js';
import {UNDER_Y,isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {stairLane} from './stairs.js';
import {bossOrTentacle,gap,bearing,muzzleClear} from './npc-combat.js';

export const CX10_VERSION='CX10-APEX';

const angleDiff=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
const bearingTo=(a,p)=>Math.atan2(p[0]-a.x,a.z-p[2]);

/**
 * CX10Engine: Exclusive hyper-intelligent NPC engine for the Cheater NPC.
 * Combines a 360-degree parabolic 3D bullet-threat matrix with a 16-ray
 * collision-free escape solver, counter-fire-while-dodging, range-kiting
 * against weapon archetypes, off-angle flanking utility, and tactical macro play.
 */
export class CheaterEngine {
  constructor(battle) {
    this.battle=battle;
    this.states=new WeakMap();
  }

  state(actor) {
    let st=this.states.get(actor);
    if (!st) {
      st={
        version:CX10_VERSION,
        dodgeUntil:0,
        dodgeTarget:null,
        dodgeJump:false,
        dodgeSwim:false,
        bulletsDodged:0,
        diveUntil:0,
        posUntil:0,
        posGoal:null,
        strafeSign:(actor.index??0)%2?1:-1,
        nextZigAt:0,
        lastHp:actor.hp??100,
        roamGoal:null,
        roamUntil:0
      };
      actor.cx10=CX10_VERSION;
      this.states.set(actor,st);
    }
    return st;
  }

  /**
   * 360° 3D Projectile & Explosive Threat Solver:
   * Scans ALL incoming enemy projectiles and sub-weapons within 52m in O(N) time,
   * predicts parabolic intercept trajectories (gravity + relative velocity),
   * and evaluates a 16-angle × {sprint, jump, ink-swim} escape lattice to pick
   * the direction maximizing minimum bullet clearance across all active threats.
   */
  solveBulletEvasion(actor,st,sight) {
    const b=this.battle, level=zoneOf(actor.x), clock=b.clock;
    const myX=actor.x, myY=actor.y, myZ=actor.z, team=actor.team;
    const avx=actor.vx??0, avz=actor.vz??0;
    const floorY=b.world.support(myX,myY,myZ).y;
    const bullets=[];
    let imminent=false;
    let lowestThreatTime=Infinity;
    let groundSkimThreat=false;

    // 1. Collect all threatening enemy projectiles in zone
    const shots=b.shots;
    for (let i=shots.length-1;i>=0;i--) {
      const sh=shots[i];
      if (!sh.actor || sh.actor.team===team || zoneOf(sh.pos[0])!==level) continue;
      const dx=myX-sh.pos[0], dy=myY+.92-sh.pos[1], dz=myZ-sh.pos[2];
      const distSq=dx*dx+dz*dz;
      if (distSq>52*52 || distSq<.04) continue;
      const vx=sh.vel[0], vy=sh.vel[1], vz=sh.vel[2], g=sh.weapon?.gravity??8;
      const rvx=vx-avx*.35, rvz=vz-avz*.35;
      const vMagSq=rvx*rvx+rvz*rvz;
      if (vMagSq<2) continue;
      const tCpa=clamp((dx*rvx+dz*rvz)/vMagSq,0,.78);
      if (tCpa<.01 || tCpa>.72) continue;
      const predX=sh.pos[0]+vx*tCpa, predZ=sh.pos[2]+vz*tCpa;
      const predY=sh.pos[1]+vy*tCpa-.5*g*tCpa*tCpa;
      if (predY<floorY-.9 || predY>myY+2.9) continue;
      const missD=Math.hypot(myX-predX,myZ-predZ);
      const safeMargin=1.95+(sh.weapon?.size??.22)+(sh.homing?.28:0);
      if (missD<safeMargin) {
        imminent=true;
        if (tCpa<lowestThreatTime) lowestThreatTime=tCpa;
        if (predY<myY+.95) groundSkimThreat=true;
        bullets.push({px:sh.pos[0],py:sh.pos[1],pz:sh.pos[2],vx,vy,vz,g,rad:sh.weapon?.size??.25,t:tCpa});
      }
    }

    // 2. Check hostile enemy bombs/traps and sniper/player direct locks!
    for (const item of b.subweapons?.items??[]) {
      if (!item.owner || item.owner.team===team || zoneOf(item.p[0])!==level) continue;
      const dx=myX-item.p[0], dz=myZ-item.p[2], d=Math.hypot(dx,dz);
      if (d<5.2 && Math.abs(myY-item.p[1])<3.0) {
        imminent=true;
        bullets.push({px:item.p[0],py:item.p[1],pz:item.p[2],vx:0,vy:0,vz:0,g:0,rad:2.6,t:.25});
      }
    }
    // Predictive pre-dodge: notice an enemy looking squarely at Cheater inside 16m ready to shoot!
    for (const foe of b.actors) {
      if (foe.team===team || foe.down>0 || zoneOf(foe.x)!==level || foe.swimming) continue;
      const dx=myX-foe.x, dz=myZ-foe.z, d=Math.hypot(dx,dz);
      if (d>16 || d<1.2 || Math.abs(myY-foe.y)>2.6) continue;
      const aimCos=(dx*Math.sin(foe.yaw)+dz*(-Math.cos(foe.yaw)))/d;
      if (aimCos>.945 && !b.traceShot([foe.x,foe.y+1.2,foe.z],[myX,myY+1.0,myZ],true)) {
        imminent=true;
        bullets.push({px:foe.x,py:foe.y+1.1,pz:foe.z,vx:Math.sin(foe.yaw)*36,vy:0,vz:-Math.cos(foe.yaw)*36,g:0,rad:1.4,t:.22});
      }
    }

    if (!imminent || !bullets.length) return null;

    // 3. Evaluate 16 radial evasion candidates across 360° for maximum minimum bullet clearance
    let bestScore=-Infinity, bestDir=null;
    const stepLen=2.95, stepSpeed=8.6;
    const onOwnInk=b.surfaceInk(actor,{y:floorY,layer:b.world.floor(myX,myZ).layer})===team+1;

    for (let k=0;k<16;k++) {
      const ang=k*(TAU/16);
      const ex=Math.cos(ang), ez=Math.sin(ang);
      const cx=myX+ex*stepLen, cz=myZ+ez*stepLen;
      if (!b.motion.segment(actor,cx,cz)) continue;
      if (level===0 && b.dynamicStage?.active) {
        let intoPit=false;
        for (const h of b.dynamicStage.sinkholes) {
          if (h.radius>0.8 && Math.hypot(cx-h.x,cz-h.z)<h.radius+.5) {intoPit=true;break;}
        }
        if (intoPit) continue;
      }
      const nextFloor=b.world.support(cx,myY,cz);
      if (nextFloor.y<myY-3.8) continue;

      let minClearance=99;
      for (let m=0;m<bullets.length;m++) {
        const bl=bullets[m];
        const tTest=bl.t;
        const nvx=ex*stepSpeed*(actor.agility??1.85), nvz=ez*stepSpeed*(actor.agility??1.85);
        const axFuture=myX+nvx*tTest, azFuture=myZ+nvz*tTest;
        const bxFuture=bl.px+bl.vx*tTest, bzFuture=bl.pz+bl.vz*tTest;
        const clear=Math.hypot(axFuture-bxFuture,azFuture-bzFuture)-bl.rad;
        if (clear<minClearance) minClearance=clear;
      }

      // Bonus for staying on own ink, having cover/height, and flanking rather than retreating blindly into corners
      const wallMargin=Math.min(50-Math.abs(localX(cx)),32-Math.abs(cz));
      const inkAtDest=b.surfaceInk({x:cx,z:cz},nextFloor);
      const edgePenalty=wallMargin<3?-2.5:0;
      const sightKeep=sight?.foot?((cx-sight.foot.x)**2+(cz-sight.foot.z)**2<36*36?.6:-.6):0;
      const score=minClearance*3.2+(inkAtDest===team+1?.75:0)+(nextFloor.y>myY+.2?.55:0)+edgePenalty+sightKeep;
      if (score>bestScore) {
        bestScore=score;
        bestDir={x:cx,z:cz,minClearance};
      }
    }
    if (!bestDir) return null;

    const shouldJump=groundSkimThreat && lowestThreatTime<.28 && !actor.airborne && !isCabin(myX) &&
      !stairLane(myX,myZ,.2) && !b.bodyBlocked({...actor,y:myY+.67},actor.radius??.42,1.72);
    const shouldSwim=!shouldJump && onOwnInk && bullets.length<=2 && lowestThreatTime>.18 && (actor.hp<(actor.maxHp??100)*.75);
    if (st.dodgeUntil<=clock) st.bulletsDodged+=bullets.length;
    st.dodgeTarget={x:bestDir.x,z:bestDir.z};
    st.dodgeUntil=clock+.24;
    st.dodgeJump=shouldJump;
    st.dodgeSwim=shouldSwim;
    return st.dodgeTarget;
  }

  /**
   * 10x Smarter Predatory Target Prioritization:
   * Evaluates vulnerability, counter-special suppression, threat danger, and 9-pellet multi-hit grouping.
   */
  selectTarget(actor) {
    const b=this.battle, level=zoneOf(actor.x);
    const candidates=[...b.actors,...b.raiders.live()].filter(a=>a.team!==actor.team && a.down<=0 && !a.ride && !a.lift && sameLevel(a.x,actor.x));
    let best=null, bestScore=-Infinity;
    for (let i=0;i<candidates.length;i++) {
      const f=candidates[i], d=Math.hypot(f.x-actor.x,f.z-actor.z);
      if (d>46) continue;
      let sc=52-d*1.15;
      // Prioritise finishers (< 55 HP) & active ultimates
      sc+=(1-clamp(f.hp/(f.maxHp??100),0,1))*28;
      if (f.beaming || f.charge>.4 || f.giant) sc+=20;
      if (f.isPlayer) sc+=8;
      if (f.shield>0) sc-=12;
      // Check line-of-sight cleanly
      if (d<40 && !b.traceShot([actor.x,actor.y+1.25,actor.z],[f.x,f.y+1.15,f.z],true)) sc+=16;
      // 9-pellet cluster synergy
      let crowd=0;
      for (let j=0;j<candidates.length;j++) {
        if (i!==j && (candidates[j].x-f.x)**2+(candidates[j].z-f.z)**2<42) crowd++;
      }
      sc+=crowd*12;
      if (sc>bestScore) {bestScore=sc;best=f;}
    }
    return best;
  }

  /**
   * Tactical Flanking & Kite Utility Matrix:
   * Evaluates 18 candidate positions with crossfire angle, dynamic weapon counter-kiting
   * (outranging short weapons, zig-zag rushing Chargers), cover peeks when injured, and high ground.
   */
  pickCombatPosition(actor,foe,foePoint,s,st) {
    const b=this.battle, d=Math.max(.1,Math.hypot(foePoint.x-actor.x,foePoint.z-actor.z));
    const ux=(foePoint.x-actor.x)/d, uz=(foePoint.z-actor.z)/d;
    const foeW=foe?.weapon;
    const shortRangeFoe=foe?.giant || foeW?.roller || foeW?.id==='fan' || foeW?.blast;
    const longRangeFoe=foeW?.charge || foeW?.id==='prism' || foeW?.id==='lob';
    const preferred=shortRangeFoe?19.5:longRangeFoe?13.5:16.5;
    const injured=actor.hp<(actor.maxHp??100)*.48;

    const advanceBase=clamp((d-preferred)*.52,-3.2,3.4);
    const sideMag=2.8+Math.sin(b.clock*5.4)*.9;
    const sgn=st.strafeSign;
    const candidates=[
      [advanceBase,sgn*sideMag],[advanceBase,-sgn*sideMag],
      [0,sgn*sideMag*1.3],[0,-sgn*sideMag*1.3],
      [-2.4,sgn*2.4],[-2.4,-sgn*2.4],
      [advanceBase*1.2,sgn*1.2],[advanceBase*1.2,-sgn*1.2],
      [2.6,sgn*3.2],[2.6,-sgn*3.2]
    ];

    const foeEye=[foePoint.x,(foePoint.y??actor.y)+1.2,foePoint.z];
    const level=zoneOf(actor.x), myInk=actor.team+1;
    const allies=b.motion.groups[level].filter(o=>o!==actor && o.team===actor.team);

    let bestScore=-Infinity, best={x:actor.x,z:actor.z};
    for (let i=0;i<candidates.length;i++) {
      const [adv,side]=candidates[i];
      const cx=actor.x+ux*adv-uz*side, cz=actor.z+uz*adv+ux*side;
      if (!b.motion.segment(actor,cx,cz)) continue;
      const floor=b.world.support(cx,actor.y,cz);
      const dist=Math.hypot(foePoint.x-cx,foePoint.z-cz);
      const canShoot=!(b.traceShot([cx,floor.y+1.15,cz],foeEye,true)?.t<.98);
      const inCover=!!(b.traceShot(foeEye,[cx,floor.y+.72,cz],true)?.t<.98);
      const ink=b.surfaceInk({x:cx,z:cz},floor);
      // Off-angle flank reward: check if foe is facing away or toward this angle!
      let flankBonus=0;
      if (foe) {
        const fx=Math.sin(foe.yaw), fz=-Math.cos(foe.yaw);
        const tx=cx-foe.x, tz=cz-foe.z, tl=Math.max(.1,Math.hypot(tx,tz));
        const dotFront=(fx*tx+fz*tz)/tl;
        flankBonus=(1-Math.abs(dotFront-.05))*2.8; // Peak reward at 90° flank & behind!
      }
      let allySpread=0;
      for (const a of allies) if (Math.hypot(a.x-cx,a.z-cz)<2.4) allySpread-=1.5;

      const score=-Math.abs(dist-preferred)*.55
        +(floor.y-(foePoint.y??actor.y))*1.15
        +(canShoot?2.4:injured?3.2:-3.5)
        +(inCover?(injured?4.2:1.25):0)
        +(ink===myInk?2.1:ink?-1.8:0)
        +flankBonus
        +allySpread;
      if (score>bestScore) {bestScore=score; best={x:cx,z:cz};}
    }
    return best;
  }

  /**
   * Main per-tick AI brain for the Cheater NPC (`Tactics.crew` delegates here when `actor.isCheater`).
   */
  step(actor,enemy,s,dt,sight=null) {
    const b=this.battle, t=b.clock, level=zoneOf(actor.x);
    const st=this.state(actor), hnv=b.hnv1;

    // Detect newly sustained damage -> immediately invert strafe sign & surge speed/retreat!
    if ((actor.hp??100)<st.lastHp) {
      st.strafeSign=-st.strafeSign;
      st.posUntil=0;
    }
    st.lastHp=actor.hp??100;
    if (t>=st.nextZigAt) {
      st.strafeSign=-st.strafeSign;
      st.nextZigAt=t+.28+b.rng()*.26;
    }

    // 1. Area Hazard Survival (Tsunami, Goat 16 tentacles, Bombs, Sniper Laser, Train Boss)
    if (hnv?.survivalAction(actor,dt,sight)) return;
    const areaHazard=b.subweapons.danger(actor) ?? bossOrTentacle(b,actor);
    if (areaHazard) {
      const dx=actor.x-areaHazard.p[0], dz=actor.z-areaHazard.p[2], len=Math.max(.1,Math.hypot(dx,dz));
      const safe=b.navs[Math.min(1,level)]?.nearest({x:actor.x+dx/len*6.0,z:actor.z+dz/len*6.0});
      if (safe && b.navigate(actor,safe,dt,7.2,false,{emergency:true})) {
        actor.intent='CX10: 広域攻撃を超高速回避';
        if (sight?.visible) b.tactics.combat.shoot(actor,s,sight,dt);
        return;
      }
    }

    // 2. Real-Time 360° Bullet Evasion & Counter-Fire!
    const dodge=this.solveBulletEvasion(actor,st,sight) ?? (st.dodgeUntil>t?st.dodgeTarget:null);
    if (dodge) {
      const aimTarget=enemy ?? this.selectTarget(actor);
      const aimPos=aimTarget?(hnv?hnv.predictAim(actor,aimTarget,actor.weapon):[aimTarget.x,aimTarget.y+.95,aimTarget.z]):null;
      const readyPose=aimPos?{look:bearingTo(actor,aimPos),pitch:clamp(Math.atan2(aimPos[1]-actor.y-1.2,Math.max(.5,gap(actor,aimTarget))),-.58,.52),ready:1,jump:st.dodgeJump,emergency:true}:{jump:st.dodgeJump,emergency:true};
      actor.intent='CX10: 弾道予測360°回避＆カウンター射撃';
      b.steer(actor,dodge,dt,6.8,st.dodgeSwim,readyPose);
      st.dodgeJump=false;
      // Cheater counter-fires accurately WITH 9-pellet homing even while dodging bullets!
      if (sight?.visible && !st.dodgeSwim) b.tactics.combat.shoot(actor,s,sight,dt);
      return;
    }

    // 3. Proactive Special / Subweapon / Drone Mastery
    if (hnv?.orchestrateAbilities(actor,enemy,sight,s)) return;
    if (actor.hp<(actor.maxHp??100)*.34 && actor.superCharge>=100 && b.abilities.activate(actor)) return;

    // 4. Quick-Reload Micro-Dive & Emergency HP Reset when low on ink or HP
    const floor=b.world.support(actor.x,actor.y,actor.z);
    const onOwnInk=b.surfaceInk(actor,floor)===actor.team+1;
    if ((actor.tank<actor.weapon.cost*4 || actor.hp<(actor.maxHp??100)*.32) && onOwnInk && !enemy) {
      st.diveUntil=Math.max(st.diveUntil,t+.32);
    }
    if (t<st.diveUntil && onOwnInk && level<2) {
      actor.intent='CX10: 高速潜伏チャージ';
      b.steer(actor,{x:actor.x+st.strafeSign*2,z:actor.z},dt,5.8,true,{ready:.8});
      return;
    }

    // 5. High-Speed Apex Combat Engagement
    const focus=enemy ?? this.selectTarget(actor);
    if (focus) {
      const fPoint=sight?.visible && sight.enemy===focus?sight.foot:{x:focus.x,y:focus.y,z:focus.z};
      const d=gap(actor,fPoint);
      if (t>=st.posUntil || !st.posGoal) {
        st.posGoal=this.pickCombatPosition(actor,focus,fPoint,s,st);
        st.posUntil=t+.14; // Re-evaluates optimal combat angle ~7x/second
      }
      const aimPos=hnv?hnv.predictAim(actor,sight?.visible?sight:focus,actor.weapon):[fPoint.x,fPoint.y+.95,fPoint.z];
      const look=bearingTo(actor,aimPos);
      const pitch=clamp(Math.atan2(aimPos[1]-actor.y-1.2,Math.max(.5,d)),-.58,.52);
      const swimRush=d>18 && onOwnInk && !actor.giant;
      const hop=(!swimRush && !actor.airborne && d<15 && b.rng()<.04 && !isCabin(actor.x) && !stairLane(actor.x,actor.z,.2));
      actor.intent=d>16?'CX10: 側面挟撃高速アプローチ':'CX10: 波状回避＆9連超追尾制圧';
      b.steer(actor,st.posGoal,dt,6.2,swimRush,{look,pitch,ready:1,jump:hop,brace:0});
      if (!swimRush) {
        if (sight?.visible) b.tactics.combat.shoot(actor,s,sight,dt);
        else if (d<38 && !b.traceShot([actor.x,actor.y+1.25,actor.z],[fPoint.x,fPoint.y+1.1,fPoint.z],true)) {
          // Proactive suppressive lock without waiting for perception poll!
          if (actor.fire<=0 && actor.tank>=actor.weapon.cost && muzzleClear(b,actor,aimPos,1)) b.shoot(actor,aimPos,1);
        }
      }
      return;
    }

    // 6. Hyper-Efficient Macro Positioning: Grab unclaimed Giga Chip, hunt high-value ink zones, & ambush!
    if (level<2 && b.chip && !b.chip.owner && zoneOf(b.chip.x)===level && Math.hypot(b.chip.x-actor.x,b.chip.z-actor.z)<24) {
      actor.intent='CX10: ギガチップ最速回収';
      if (b.navigate(actor,b.chip,dt,6.2,onOwnInk,{ready:.9})) return;
    }

    if (t>=st.roamUntil || !st.roamGoal || distanceSq(actor,st.roamGoal)<9) {
      // Sample 8 distant surface sector points to claim max turf / contest high-value center
      const nav=b.navs[Math.min(1,level)];
      let bestNode=null, bestVal=-Infinity;
      const pool=nav?.nodes??[];
      for (let i=0;i<16 && pool.length;i++) {
        const idx=Math.floor(b.rng()*pool.length);
        const node=pool[idx];
        const dist=Math.hypot(node.x-actor.x,node.z-actor.z);
        if (dist<8 || dist>44) continue;
        const owner=b.paint.get(node.x,node.z,b.world.floor(node.x,node.z).layer);
        const centerBias=Math.max(0,28-Math.hypot(localX(node.x),node.z));
        const val=(owner===0?14:owner!==actor.team+1?20:-4)+centerBias*.5+node.y*1.2;
        if (val>bestVal) {bestVal=val; bestNode=node;}
      }
      st.roamGoal=bestNode;
      st.roamUntil=t+3.2;
    }
    if (st.roamGoal) {
      const look=hnv?hnv.patrolPose(actor).look:undefined;
      actor.intent='CX10: 高速遊撃＆盤面制圧';
      if (b.navigate(actor,st.roamGoal,dt,6.1,onOwnInk,{look,ready:.85})) {
        b.tactics.paintAhead(actor,sight);
        return;
      }
    }
    b.tactics.advance(actor,s,dt,sight);
  }
}

function distanceSq(a,b) {
  const dx=a.x-b.x, dz=a.z-b.z;
  return dx*dx+dz*dz;
}
