import {TAU,clamp,forward} from './render.js';
import {isCabin,localX,sameLevel,zoneOf} from './layout.js';
import {STAIRS,STAIR_RUN,stairLane,stairPoint} from './stairs.js';
import {shotTravel} from './weapons.js';
import {subweaponById} from './subweapons.js';

export const HNV1_VERSION='HNV1';
export const HNV1_GAIN=40;

// Six distinct human player archetypes + four specialized non-crew archetypes.
// Every NPC in the game (crew, Cheater, ebot clones, Raiders, Snipers,
// Rogue Drones, Giant Squid Boss, God of Destruction Goat) runs on HNV1.
export const HNV1_ARCHETYPES={
  vanguard:{
    label:'先鋒',aggression:.78,caution:.44,precision:.91,strafeFreq:2.45,strafeChaos:.42,
    jumpTendency:.46,peekDiscipline:.68,teamwork:.74,flankDrive:.48,glanceRate:1.7,
    swimMobility:.82,reactionBase:.055,preferredScale:.88
  },
  duelist:{
    label:'決闘者',aggression:.86,caution:.38,precision:.95,strafeFreq:3.10,strafeChaos:.58,
    jumpTendency:.66,peekDiscipline:.76,teamwork:.58,flankDrive:.64,glanceRate:1.5,
    swimMobility:.90,reactionBase:.045,preferredScale:.82
  },
  tactician:{
    label:'戦術家',aggression:.58,caution:.72,precision:.93,strafeFreq:2.05,strafeChaos:.36,
    jumpTendency:.34,peekDiscipline:.92,teamwork:.92,flankDrive:.78,glanceRate:1.25,
    swimMobility:.78,reactionBase:.058,preferredScale:1.08
  },
  guardian:{
    label:'護衛',aggression:.52,caution:.76,precision:.92,strafeFreq:1.85,strafeChaos:.30,
    jumpTendency:.28,peekDiscipline:.88,teamwork:.96,flankDrive:.34,glanceRate:1.35,
    swimMobility:.72,reactionBase:.062,preferredScale:1.12
  },
  flanker:{
    label:'遊撃',aggression:.74,caution:.48,precision:.90,strafeFreq:2.95,strafeChaos:.64,
    jumpTendency:.60,peekDiscipline:.74,teamwork:.68,flankDrive:.95,glanceRate:1.4,
    swimMobility:.95,reactionBase:.050,preferredScale:.80
  },
  ace:{
    label:'エース',aggression:.90,caution:.56,precision:.98,strafeFreq:3.35,strafeChaos:.68,
    jumpTendency:.62,peekDiscipline:.94,teamwork:.86,flankDrive:.82,glanceRate:1.15,
    swimMobility:.96,reactionBase:.035,preferredScale:.92
  },
  hunter:{
    label:'襲撃猟兵',aggression:.88,caution:.32,precision:.91,strafeFreq:2.65,strafeChaos:.52,
    jumpTendency:.38,peekDiscipline:.55,teamwork:.64,flankDrive:.84,glanceRate:1.6,
    swimMobility:.20,reactionBase:.065,preferredScale:.85
  },
  marksman:{
    label:'精密狙撃手',aggression:.72,caution:.84,precision:.97,strafeFreq:1.1,strafeChaos:.20,
    jumpTendency:.0,peekDiscipline:.95,teamwork:.50,flankDrive:.20,glanceRate:1.0,
    swimMobility:.0,reactionBase:.045,preferredScale:1.25
  },
  swarm:{
    label:'自律群知能',aggression:.84,caution:.42,precision:.93,strafeFreq:3.20,strafeChaos:.65,
    jumpTendency:.0,peekDiscipline:.40,teamwork:.88,flankDrive:.90,glanceRate:1.2,
    swimMobility:.0,reactionBase:.050,preferredScale:.90
  },
  colossus:{
    label:'巨獣知性',aggression:.92,caution:.20,precision:.94,strafeFreq:1.4,strafeChaos:.25,
    jumpTendency:.0,peekDiscipline:.20,teamwork:.0,flankDrive:.50,glanceRate:2.0,
    swimMobility:.0,reactionBase:.070,preferredScale:1.0
  },
  deity:{
    label:'破壊神知性',aggression:1.0,caution:.15,precision:.99,strafeFreq:2.4,strafeChaos:.55,
    jumpTendency:.0,peekDiscipline:.30,teamwork:.0,flankDrive:.85,glanceRate:1.0,
    swimMobility:.0,reactionBase:.025,preferredScale:1.0
  }
};

const CREW_ARCHETYPES=['vanguard','duelist','flanker','tactician','guardian','ace'];
const GOLDEN=1.61803398875;
const dist2=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const angleDiff=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
const bearingTo=(a,p)=>Math.atan2(p[0]-a.x,a.z-p[2]);

function pickArchetype(actor) {
  if (actor.isGoat) return 'deity';
  if (actor.isBoss) return 'colossus';
  if (actor.isSniper) return 'marksman';
  if (actor.isRogueDrone) return 'swarm';
  if (actor.isRaider) return 'hunter';
  if (actor.isCheater) return 'ace';
  const w=actor.weapon;
  if (w?.charge || w?.id==='prism') return 'tactician';
  if (w?.id==='fan' || w?.id==='dual' || w?.blast) return 'flanker';
  if (w?.id==='lob' || w?.id==='coil') return 'guardian';
  if (w?.roller) return 'duelist';
  const idx=((actor.index??0)+(actor.team??0)*3)%CREW_ARCHETYPES.length;
  return CREW_ARCHETYPES[Math.abs(idx)];
}

function collectHighGround(battle) {
  const nav=battle.navs?.[0];
  if (!nav?.nodes?.length) return {high:[],mid:[]};
  const high=[], mid=[];
  for (let i=0;i<nav.nodes.length;i++) {
    const n=nav.nodes[i];
    if (n.y>=3.5) high.push(n);
    else if (n.y>=2.15) mid.push(n);
  }
  // Thin dense grids into well-distributed refuge anchors for O(1) lookup.
  const thin=(list,step)=>{
    const out=[];
    for (let i=0;i<list.length;i++) {
      const p=list[i];
      if (!out.some(q=>Math.hypot(q.x-p.x,q.z-p.z)<step)) out.push(p);
    }
    return out;
  };
  return {high:thin(high,4.2),mid:thin(mid,4.6)};
}

/**
 * HNV1 — Humanized Neural Vanguard v1
 * Unified cognitive, ballistic, survival, and squad-coordination foundation
 * engine powering every NPC actor in the arena.
 */
export class HNV1 {
  constructor(battle) {
    this.battle=battle;
    this.version=HNV1_VERSION;
    this.gain=HNV1_GAIN;
    this.minds=new WeakMap();
    this.refuges=battle.world
      ?(battle.world.hnv1Refuges ??= collectHighGround(battle))
      :{high:[],mid:[]};
    this.stairEntries=STAIRS.map(stair=>({stair,entry:stairPoint(stair,1),exit:stairPoint(stair,0)}));
  }

  /**
   * Returns (and lazily creates) an NPC's persistent HNV1 cognitive profile.
   */
  mind(actor) {
    let m=this.minds.get(actor);
    if (m) return m;
    const key=pickArchetype(actor);
    const base=HNV1_ARCHETYPES[key];
    const seed=(((actor.index??0)+1)*73856093 ^ ((actor.team??0)+3)*19349663)>>>0;
    const jitter=offset=>(((seed>>(offset*3))&15)/15-.5);
    const cheater=!!actor.isCheater;
    m={
      engine:HNV1_VERSION,
      archetype:key,
      label:cheater?'違法エース':base.label,
      traits:{
        aggression:clamp(base.aggression+(cheater?.14:jitter(0)*.14),.1,1),
        caution:clamp(base.caution+(cheater?-.15:jitter(1)*.14),.08,.96),
        precision:cheater?1:clamp(base.precision+jitter(2)*.05,.82,.995),
        strafeFreq:base.strafeFreq*(1+jitter(3)*.22),
        strafeChaos:clamp(base.strafeChaos+jitter(4)*.12,.15,.85),
        jumpTendency:clamp(base.jumpTendency+(cheater?.18:jitter(5)*.14),0,.95),
        peekDiscipline:clamp(base.peekDiscipline+jitter(6)*.10,.2,.98),
        teamwork:clamp(base.teamwork+jitter(7)*.10,0,.99),
        flankDrive:clamp(base.flankDrive+jitter(8)*.12,.1,.99),
        glanceRate:base.glanceRate*(1+jitter(9)*.22),
        swimMobility:clamp(base.swimMobility+(cheater?.12:jitter(10)*.10),0,.99),
        reactionBase:cheater?.018:Math.max(.028,base.reactionBase*(1+jitter(11)*.18)),
        preferredScale:base.preferredScale
      },
      // Dynamic human emotional / cognitive state
      adrenaline:.22,
      morale:.15,
      focus:0,
      phase:(seed%1000)/1000*TAU,
      strafeDir:(actor.index??0)%2?1:-1,
      feintAt:0,
      glanceAt:0,
      glanceYaw:actor.yaw??0,
      swimUntil:0,
      jumpAt:0,
      lastKills:actor.kills??0,
      lastHp:actor.hp??100,
      streak:0,
      // Second-order ballistic tracking memory
      trackId:null,
      prevVel:[0,0,0],
      accel:[0,0,0],
      smoothAim:null,
      lastTrackAt:-99,
      // Combat telemetry
      repositionedAt:-99,
      peelTarget:null,
      peelUntil:0
    };
    actor.hnv1=HNV1_VERSION;
    actor.archetype=key;
    this.minds.set(actor,m);
    return m;
  }

  /**
   * Advances an NPC's human cognitive state: adrenaline, morale, flow-state focus,
   * organic counter-strafe feint cadence, and natural situational glance angles.
   */
  tick(actor,dt,sight=null) {
    const b=this.battle, m=this.mind(actor), t=b.clock;
    const hp=actor.hp??100, maxHp=actor.maxHp??100;
    const hpRatio=clamp(hp/Math.max(1,maxHp),0,1);

    // Track kills -> human momentum / morale surge
    const kills=actor.kills??0;
    if (kills>m.lastKills) {
      const gained=kills-m.lastKills;
      m.streak+=gained;
      m.morale=clamp(m.morale+.32*gained,-1,1);
      m.adrenaline=clamp(m.adrenaline+.26*gained,0,1);
      m.lastKills=kills;
    }

    // Track incoming damage -> adrenaline spike & micro-caution
    if (hp<m.lastHp-1) {
      const lost=(m.lastHp-hp)/Math.max(1,maxHp);
      m.adrenaline=clamp(m.adrenaline+lost*1.35,0,1);
      m.morale=clamp(m.morale-lost*.55,-1,1);
      // Human reflex: immediately flip strafe direction when clipped by fire!
      if (t>=m.feintAt-.12) {
        m.strafeDir=-m.strafeDir;
        m.feintAt=t+.22+b.rng()*.34;
      }
    }
    m.lastHp=hp;

    // Global tension from disasters & bosses raises alertness
    const h=b.hazards;
    const worldCrisis=
      (h?.goat?.active?.35:0)+(h?.tsunami?.phase!=='idle'?.42:0)+
      (h?.underFlood?.active && zoneOf(actor.x)===1?.48:0)+
      (h?.trainBoss?.active?.25:0)+(b.boss?.active?.22:0);
    const targetAdrenaline=clamp((sight?.visible?.52:.14)+(1-hpRatio)*.55+worldCrisis,0,1);
    const decay=1-Math.exp(-dt*(targetAdrenaline>m.adrenaline?5.5:1.1));
    m.adrenaline+=((targetAdrenaline-m.adrenaline)*decay);

    // Flow-state focus locks in smoothly while tracking a live target
    const targetFocus=sight?.visible?clamp(.58+m.traits.precision*.42,0,1):0;
    m.focus+=(targetFocus-m.focus)*(1-Math.exp(-dt*(sight?.visible?7.2:2.4)));

    // Gentle return of morale toward neutral-positive baseline
    m.morale+=(.12-m.morale)*(1-Math.exp(-dt*.18));

    // Irrational-harmonic strafe rhythm + irregular human feint switches
    m.phase+=dt*(m.traits.strafeFreq*(1+m.adrenaline*.45));
    if (t>=m.feintAt) {
      const flipChance=.42+m.traits.strafeChaos*.48;
      if (b.rng()<flipChance) m.strafeDir=-m.strafeDir;
      m.feintAt=t+.26+b.rng()*(.58-m.traits.strafeChaos*.26);
    }

    // Update second-order target acceleration memory
    if (sight?.visible && sight.enemy) {
      const foe=sight.enemy;
      const vx=sight.velocity?.[0]??foe.vx??0;
      const vy=sight.velocity?.[1]??foe.vy??0;
      const vz=sight.velocity?.[2]??foe.vz??0;
      const elapsed=t-m.lastTrackAt;
      if (m.trackId===foe && elapsed>.02 && elapsed<.45) {
        const inv=1/elapsed;
        m.accel[0]=m.accel[0]*.55+clamp((vx-m.prevVel[0])*inv,-18,18)*.45;
        m.accel[1]=m.accel[1]*.55+clamp((vy-m.prevVel[1])*inv,-14,14)*.45;
        m.accel[2]=m.accel[2]*.55+clamp((vz-m.prevVel[2])*inv,-18,18)*.45;
      } else {
        m.accel[0]=m.accel[1]=m.accel[2]=0;
        m.smoothAim=null;
      }
      m.trackId=foe;
      m.prevVel[0]=vx;m.prevVel[1]=vy;m.prevVel[2]=vz;
      m.lastTrackAt=t;
    } else if (t-m.lastTrackAt>.65) {
      m.accel[0]=m.accel[1]=m.accel[2]=0;
      m.smoothAim=null;
    }

    return m;
  }

  /**
   * Humanized reaction window in seconds (sharp yet non-robotic; preserves
   * strict `react > clock` invariant for perception tests).
   */
  reactionDelay(actor) {
    const b=this.battle, m=this.mind(actor);
    const base=m.traits.reactionBase*(1-m.adrenaline*.32);
    return Math.max(.015,base+(b.rng?.()??.5)*base*.95);
  }

  /**
   * Unified target scoring across all NPCs (lower score = higher priority).
   * Considers weapon sweet-spot, finishable low-HP enemies, Cheater/Super threats,
   * ally-peeling (enemies threatening nearby wounded teammates), and world hazards.
   */
  scoreTarget(actor,enemy,previous=null) {
    const b=this.battle, m=this.mind(actor);
    const d=Math.hypot(enemy.x-actor.x,(enemy.y-actor.y)*.85,enemy.z-actor.z);
    let score=d;

    // Target stickiness (human commitment — avoids robotic target flicker)
    if (enemy===previous) score*=.76;

    // Weapon sweet-spot fit
    const w=actor.weapon;
    if (w) {
      const pref=this.preferredRange(actor);
      score+=Math.abs(d-pref)*.14;
      if (w.range && d>w.range*(actor.rangeFactor??1)*.96) score+=14;
    }

    // Finish low-HP targets first (classic human FPS instinct)
    const foeHp=enemy.hp??100, foeMax=enemy.maxHp??100;
    const foeRatio=clamp(foeHp/Math.max(1,foeMax),0,1);
    if (!enemy.isBoss && !enemy.isGoat) {
      score-=(1-foeRatio)*5.8;
      if (foeHp<=38) score-=3.4;
    }

    // High-threat priority: Cheater, active super, or player closing in
    if (enemy.isCheater) score-=4.2;
    if (enemy.giant || enemy.beaming || enemy.activeSpecial) score-=3.2;

    // Ally peel / rescue instinct (for team crew)
    if (actor.team>=0 && !actor.isBoss && !actor.isRaider && b.actors?.length) {
      for (let i=0;i<b.actors.length;i++) {
        const ally=b.actors[i];
        if (ally===actor || ally.team!==actor.team || ally.down>0) continue;
        if (ally.hp<68 && sameLevel(ally.x,enemy.x) && dist2(ally,enemy)<10.5) {
          score-=4.5*m.traits.teamwork;
          m.peelTarget=enemy;
          m.peelUntil=b.clock+2.4;
          break;
        }
      }
    }

    // World threat weighting for crew NPCs
    if (enemy.isRogueDrone) score-=2.6; // fast, fragile, dangerous if ignored
    if (enemy.isSniper) score-=1.8;     // clear high-ground snipers
    if (enemy.isHeli) score-=3.2;       // suppress missile helicopter
    if (enemy.isGoat) score+=d<17?-3.5:3.0; // focus fire Goat when in range
    if (enemy.isBoss && !enemy.isGoat) score+=(actor.index??0)%2===0?-1.5:3.5;

    // Marksman / Goat / Boss prefer exposed, active, or clustered targets
    if (actor.isSniper || actor.isGoat || actor.isBoss) {
      if (enemy.swimming) score+=2.5;
      // Bonus for clustered fighters (splash/multi-kill value)
      if ((actor.isGoat || actor.isBoss) && b.actors?.length) {
        let cluster=0;
        for (let i=0;i<b.actors.length;i++) {
          const other=b.actors[i];
          if (other!==enemy && other.down<=0 && sameLevel(other.x,enemy.x) && dist2(other,enemy)<7.5) cluster++;
        }
        score-=cluster*3.4;
      }
    }

    return score;
  }

  /**
   * Ballistic + second-order acceleration predictive aim.
   * Works uniformly for crew weapons, Cheater, Raiders, Snipers, Rogue Drones, and Goat.
   */
  predictAim(actor,sightOrTarget,weaponOverride=null) {
    const b=this.battle, m=this.mind(actor);
    const w=weaponOverride ?? actor.weapon;
    const isSight=!!sightOrTarget?.point;
    const basePoint=isSight
      ?sightOrTarget.point
      :[sightOrTarget.x,sightOrTarget.y+(sightOrTarget.isGoat?2.2:sightOrTarget.isHeli?1.1:sightOrTarget.isBoss?2.1:sightOrTarget.isRogueDrone?0:sightOrTarget.swimming?.36:1.06),sightOrTarget.z];
    const foe=isSight?sightOrTarget.enemy:sightOrTarget;
    const vx=isSight?(sightOrTarget.velocity?.[0]??foe?.vx??0):(foe?.vx??0);
    const vy=isSight?(sightOrTarget.velocity?.[1]??foe?.vy??0):(foe?.vy??0);
    const vz=isSight?(sightOrTarget.velocity?.[2]??foe?.vz??0):(foe?.vz??0);

    const dx=basePoint[0]-actor.x, dy=basePoint[1]-(actor.y+1.25), dz=basePoint[2]-actor.z;
    const horiz=Math.hypot(dx,dz);
    let travel=0;
    if (w) {
      const power=w.charge?clamp(.27+.73*(actor.charge||.85),.27,1):1;
      travel=w.speed
        ?(w.arc||w.gravity?shotTravel(w,horiz,actor.rangeFactor??1,power):Math.hypot(horiz,dy)/Math.max(10,w.speed))
        :horiz/60;
    }
    const staleness=isSight?Math.min(.10,Math.max(0,b.clock-(sightOrTarget.at??b.clock))):0;
    // Precision & flow-state focus control how accurately the NPC leads
    const leadQuality=actor.isCheater?1.0:clamp(.82+m.traits.precision*.14+m.focus*.04,0,1);
    const t=clamp((travel+staleness)*leadQuality,0,.58);

    // Second-order damped acceleration prediction (catches turning & strafing targets)
    const accGain=actor.isCheater?.42:.28*m.focus;
    const px=basePoint[0]+vx*t+m.accel[0]*t*t*accGain;
    const py=basePoint[1]+vy*t*.62+m.accel[1]*t*t*accGain*.35;
    const pz=basePoint[2]+vz*t+m.accel[2]*t*t*accGain;

    // Clamp predicted point to walkable floor / avoid aiming through walls
    let aimX=px, aimY=py, aimZ=pz;
    if (b.world && !foe?.isGoat && !foe?.isHeli && !foe?.isRogueDrone && !foe?.isSniper) {
      const fl=b.world.floor?.(aimX,aimZ);
      if (fl && aimY<fl.y+.24) aimY=fl.y+.35;
    }
    if (b.traceShot && horiz>2.5 && Math.hypot(aimX-basePoint[0],aimZ-basePoint[2])>.8) {
      const eye=[actor.x,actor.y+(actor.isSniper?1.35:1.28),actor.z];
      if (b.traceShot(eye,[aimX,aimY,aimZ],true)) {
        // Predicted lead went behind cover — blend back to visible edge
        aimX=basePoint[0]+(aimX-basePoint[0])*.35;
        aimY=basePoint[1]+(aimY-basePoint[1])*.35;
        aimZ=basePoint[2]+(aimZ-basePoint[2])*.35;
      }
    }

    // Human smooth tracking filter (prevents robotic snapping while staying razor sharp)
    if (m.smoothAim && !actor.isCheater && isSight) {
      const blend=clamp(.64+m.focus*.32,.64,.96);
      aimX=m.smoothAim[0]+(aimX-m.smoothAim[0])*blend;
      aimY=m.smoothAim[1]+(aimY-m.smoothAim[1])*blend;
      aimZ=m.smoothAim[2]+(aimZ-m.smoothAim[2])*blend;
    }
    m.smoothAim=[aimX,aimY,aimZ];
    return [aimX,aimY,aimZ];
  }

  /**
   * Computes optimal engagement distance tailored to weapon AND human archetype.
   */
  preferredRange(actor) {
    const w=actor.weapon, m=this.mind(actor);
    if (!w) return 9;
    if (actor.giant) return 2.2;
    const base=w.roller?2.7:w.charge?17.5:w.id==='autoeima' || w.id==='autoeima2s' || w.id==='autoeima2super'?10.5:
      w.id==='fan'?6.2:w.blast?5.6:w.id==='lob'?12.8:w.id==='rd2'?11.5:w.id==='prism'?14.5:9.6;
    const moraleShift=(m.morale>.35?-1.1:m.morale<-.25?1.5:0);
    return clamp(base*m.traits.preferredScale+moraleShift,2.2,Math.max(4,(w.range??18)*.86));
  }

  /**
   * Dynamic firing spread (human-grade precision boosted by HNV1 focus & crouch/brace).
   */
  aimSpread(actor,distance) {
    if (actor.isCheater) return 0;
    const m=this.mind(actor), w=actor.weapon;
    const base=(w?.charge?.0065:.0115);
    const skill=clamp(1.25-m.traits.precision*.85-m.focus*.28,.12,.68);
    const braceBonus=1-(actor.brace??0)*.32;
    return (.035+distance*base)*skill*braceBonus;
  }

  /**
   * Master Disaster & World-Boss Survival Layer.
   * Handles Tsunami high-ground evacuation, B1 flood escape, God of Destruction Goat
   * 8-arm dodge, Sniper laser juking, and Berserk Train rail avoidance.
   */
  survivalAction(actor,dt,sight=null) {
    const b=this.battle, h=b.hazards, level=zoneOf(actor.x);
    if (!h || level>=2) return false;
    const m=this.mind(actor);

    // 1) TSUNAMI EVACUATION: flee to high ground (station platform / overpass / containers)
    if (level===0 && h.tsunami && (h.tsunami.phase==='warn' || h.tsunami.phase==='wave') && actor.y<3.25) {
      const pool=this.refuges.high.length?this.refuges.high:this.refuges.mid;
      if (pool.length) {
        let best=null, bestScore=Infinity;
        const waveX=h.tsunami.x??-64;
        for (let i=0;i<pool.length;i++) {
          const p=pool[i], d=dist2(actor,p);
          // Prefer higher elevation and ahead/away from advancing wave crest
          const waveRisk=h.tsunami.phase==='wave' && Math.abs(p.x-waveX)<10?16:0;
          const sc=d-p.y*2.4+waveRisk;
          if (sc<bestScore) {bestScore=sc;best=p;}
        }
        if (best && dist2(actor,best)>1.0) {
          const f=b.world.floor(actor.x,actor.z);
          const ownInk=b.paint.get(actor.x,actor.z,f.layer)===actor.team+1;
          actor.intent='HNV1: 津波から高台へ緊急避難';
          if (b.navigate(actor,best,dt,6.1,ownInk,{emergency:true})) return true;
        }
      }
    }

    // 2) UNDERGROUND B1 FLOOD ESCAPE: sprint to nearest stairwell to surface!
    if (level===1 && h.underFlood?.active && (h.underFlood.phase==='rise' || h.underFlood.depth>.35)) {
      const stair=stairLane(actor.x,actor.z);
      if (stair) {
        actor.intent='HNV1: 地下浸水から地上へ脱出';
        b.tactics.descend(actor,stair.stair,0,dt);
        return true;
      }
      let best=null, bestD=Infinity;
      for (let i=0;i<this.stairEntries.length;i++) {
        const st=this.stairEntries[i], d=dist2(actor,st.entry);
        if (d<bestD) {bestD=d;best=st;}
      }
      if (best) {
        const f=b.world.floor(actor.x,actor.z);
        const ownInk=b.paint.get(actor.x,actor.z,f.layer)===actor.team+1;
        actor.intent='HNV1: 地下浸水から地上へ脱出';
        if (dist2(actor,best.entry)<1.5) {
          b.tactics.descend(actor,best.stair,0,dt);
          return true;
        }
        if (b.navigate(actor,best.entry,dt,6.0,ownInk,{emergency:true})) return true;
      }
    }

    // 3) GOD OF DESTRUCTION GOAT 16-TENTACLE TELEGRAPH AVOIDANCE
    if (level===0 && h.goat?.active && h.goat.cast && !h.goat.cast.done) {
      const cast=h.goat.cast;
      let cx=cast.x, cz=cast.z, safeR=(cast.radius??14)+2.2;
      if (cast.kind==='smash' && cast.points?.length) {
        let bestD=Infinity;
        for (let i=0;i<cast.points.length;i++) {
          const pt=cast.points[i], pd=Math.hypot(actor.x-pt[0],actor.z-pt[2]);
          if (pd<bestD) {bestD=pd; cx=pt[0]; cz=pt[2];}
        }
        safeR=4.8;
      }
      const dx=actor.x-cx, dz=actor.z-cz, d=Math.hypot(dx,dz);
      if (d<safeR && (cast.at-b.clock)<1.2) {
        const inv=1/Math.max(.1,d);
        const sideX=-dz*inv*m.strafeDir, sideZ=dx*inv*m.strafeDir;
        const escapeX=actor.x+(dx*inv*.82+sideX*.45)*5.5;
        const escapeZ=actor.z+(dz*inv*.82+sideZ*.45)*5.5;
        const target=b.navs[0].nearest({x:escapeX,z:escapeZ});
        if (target) {
          const f=b.world.floor(actor.x,actor.z);
          const ownInk=b.paint.get(actor.x,actor.z,f.layer)===actor.team+1;
          actor.intent='HNV1: 破壊神ゴートの16本触手を回避';
          const look=bearingTo(actor,[h.goat.x,h.goat.y+1.8,h.goat.z]);
          if (b.navigate(actor,target,dt,6.0,ownInk,{look,ready:.95,emergency:true})) {
            // Keep firing back at Goat while retreating!
            if (sight?.visible && sight.enemy===h.goat) b.tactics.combat.shoot(actor,b.tactics.state(actor),sight,dt);
            return true;
          }
        }
      }
    }

    // 4) APARTMENT SNIPER LASER EVASION: juke perpendicular when locked on!
    if (level===0 && h.snipers?.length) {
      for (let i=0;i<h.snipers.length;i++) {
        const sn=h.snipers[i];
        if (!sn.active || !sn.targetPos || sn.aim<.52) continue;
        if (Math.hypot(sn.targetPos[0]-actor.x,sn.targetPos[2]-actor.z)>1.35) continue;
        const sx=actor.x-sn.x, sz=actor.z-sn.z, sd=Math.max(.1,Math.hypot(sx,sz));
        const perpX=-sz/sd*m.strafeDir, perpZ=sx/sd*m.strafeDir;
        const juke={x:actor.x+perpX*2.8,z:actor.z+perpZ*2.8};
        if (b.motion.segment(actor,juke.x,juke.z)) {
          actor.intent='HNV1: 狙撃レーザーから回避';
          const canJump=!actor.airborne && b.clock>(m.jumpAt??0) && !stairLane(actor.x,actor.z,.2);
          if (canJump) m.jumpAt=b.clock+1.15;
          b.steer(actor,juke,dt,5.9,false,{look:bearingTo(actor,[sn.x,sn.y+1.2,sn.z]),ready:1,jump:canJump,emergency:true});
          return true;
        }
      }
    }

    // 5) RUNAWAY TRAIN BOSS RAIL CLEARANCE
    if (h.trainBoss?.active) {
      const rail=h.trainBoss.rail==='metro'?b.metro:b.transit;
      if (rail && rail.section===level) {
        const pose=rail.pose();
        const dx=actor.x-pose.ox, dz=actor.z-pose.oz;
        if (Math.abs(dz)<4.2 && Math.abs(dx)<19) {
          const escapeZ=actor.z+(dz>=0?4.5:-4.5);
          const safe=b.navs[level].nearest({x:actor.x,z:escapeZ});
          if (safe) {
            actor.intent='HNV1: 暴走列車の進路を回避';
            if (b.navigate(actor,safe,dt,6.0,false,{emergency:true})) return true;
          }
        }
      }
    }

    // 6) ONCOMING DRIVEN CAR EVASION: jump/sidestep out of the path of speeding cars!
    if (level===0 && b.vehicles?.cars?.length) {
      const cars=b.vehicles.cars;
      for (let i=0;i<cars.length;i++) {
        const car=cars[i];
        if (!car.alive || !car.driver || car.driver.team===actor.team || Math.abs(car.speed)<4.2) continue;
        const rx=actor.x-car.x, rz=actor.z-car.z, d=Math.hypot(rx,rz);
        if (d>15 || d<.5) continue;
        const fx=Math.sin(car.yaw)*Math.sign(car.speed), fz=-Math.cos(car.yaw)*Math.sign(car.speed);
        const ahead=rx*fx+rz*fz, lateral=rx*(-fz)+rz*fx;
        if (ahead>0 && ahead<14 && Math.abs(lateral)<car.d+1.45) {
          const side=lateral>=0?1:-1;
          const juke={x:actor.x-fz*side*3.6,z:actor.z+fx*side*3.6};
          if (b.motion.segment(actor,juke.x,juke.z)) {
            actor.intent='HNV1: 突進する車を回避';
            b.steer(actor,juke,dt,6.0,false,{look:bearingTo(actor,[car.x,car.y+1,car.z]),ready:1,jump:!actor.airborne,emergency:true});
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * 40x upgraded combat micro-positioning with:
   * - Crossfire angle optimization relative to allies (35°–95° pincer fire)
   * - High-ground elevation preference
   * - Asymmetric human counter-strafe rhythm & feint reversals
   * - Own-ink footing & escape route awareness
   */
  combatPosition(actor,s,foePoint) {
    const b=this.battle, m=this.mind(actor);
    const d=Math.max(.01,dist2(actor,foePoint));
    const ux=(foePoint.x-actor.x)/d, uz=(foePoint.z-actor.z)/d;
    const preferred=this.preferredRange(actor);
    const progress=clamp((d-preferred)*.38,-2.1,2.5);
    const foeEye=[foePoint.x,(foePoint.y??actor.y)+1.19,foePoint.z];
    const look=d<8?1.15:.88;

    // Asymmetric human strafe sweep driven by irrational-harmonic phase + feint direction
    const wave=Math.sin(m.phase)+.45*Math.sin(m.phase*GOLDEN);
    const sideMag=1.65+Math.abs(wave)*1.05;
    const primarySide=m.strafeDir*sideMag;
    const candidates=[
      [progress,primarySide],[progress,-primarySide*.85],
      [0,primarySide*1.18],[0,-primarySide*.95],
      [progress*1.15,0],[-1.65,primarySide*.55],
      [-1.85,-primarySide*.55],[1.35,primarySide*.75],
      [0,0]
    ];

    const level=zoneOf(actor.x);
    const teammates=b.motion.groups[level].filter(other=>other!==actor && other.team===actor.team);
    const myInk=actor.team+1;
    let bestScore=-Infinity, best={x:actor.x,z:actor.z};

    for (let i=0;i<candidates.length;i++) {
      const [advance,side]=candidates[i];
      const x=actor.x+ux*advance-uz*side, z=actor.z+uz*advance+ux*side;
      if (!b.motion.segment(actor,x,z)) continue;
      const floor=b.world.support(x,actor.y,z);
      const distFoe=Math.hypot(foePoint.x-x,foePoint.z-z);
      const ink=b.surfaceInk({x,z},floor);
      const cover=!!(b.traceShot(foeEye,[x,floor.y+.68,z],true)?.t<.98);
      const canShoot=!(b.traceShot([x,floor.y+look,z],foeEye,true)?.t<.98);

      // Ally spacing + Crossfire geometry bonus!
      let allyPenalty=0, crossfireBonus=0;
      const fx=foePoint.x-x, fz=foePoint.z-z, fLen=Math.max(.1,distFoe);
      for (let k=0;k<teammates.length;k++) {
        const ally=teammates[k];
        const ad=Math.hypot(ally.x-x,ally.z-z);
        if (ad<2.5) allyPenalty+=(1-ad/2.5)*1.75;
        // Crossfire reward: if ally is also engaging the same foe, reward 40°–95° angular spread
        const afd=Math.hypot(foePoint.x-ally.x,foePoint.z-ally.z);
        if (afd<24 && afd>1.5) {
          const cosAng=(fx*(foePoint.x-ally.x)+fz*(foePoint.z-ally.z))/(fLen*afd);
          if (cosAng>-.15 && cosAng<.78) crossfireBonus=Math.max(crossfireBonus,(1-Math.abs(cosAng-.32))*1.65);
        }
      }

      // High-ground advantage reward
      const heightAdvantage=clamp((floor.y-(foePoint.y??actor.y))*.95,-1.1,2.2);
      const wounded=(actor.hp??100)<(actor.maxHp??100)*.62;

      let quality=-Math.abs(distFoe-preferred)*.44
        -allyPenalty
        +crossfireBonus*m.traits.teamwork
        +heightAdvantage
        +(ink===myInk?1.65:ink?-1.65:0)
        +(cover?(wounded?2.85:.95):0)
        +(canShoot?1.55:-2.1)
        +(Math.sign(side)===m.strafeDir?.55:0)
        -Math.hypot(advance,side)*.11;

      if (quality>bestScore) {bestScore=quality;best={x,z};}
    }

    s.bias=Math.sign((best.z-actor.z)*ux-(best.x-actor.x)*uz);
    m.repositionedAt=b.clock;
    return best;
  }

  /**
   * Decides whether the NPC should perform a tactical jump-shot or ink-swim burst
   * during a firefight (authentic high-skill human player movement!).
   */
  combatPoseModifiers(actor,d) {
    const b=this.battle, m=this.mind(actor), t=b.clock;
    let jump=false, swim=false;

    // Tactical ink-swim burst: duck into own ink briefly when low tank or repositioning between shots
    const floor=b.world.support(actor.x,actor.y,actor.z);
    const onOwnInk=b.surfaceInk(actor,floor)===actor.team+1;
    if (onOwnInk && !actor.giant && !actor.weapon?.charge && !actor.weapon?.roller) {
      const lowTank=actor.tank<actor.tankMax*.34;
      const betweenShots=actor.fire>.06 && d>5.2 && (actor.hp<(actor.maxHp??100)*.72 || lowTank);
      if (t<m.swimUntil || (betweenShots && m.traits.swimMobility>.65 && b.rng()<.32)) {
        swim=true;
        if (t>=m.swimUntil) m.swimUntil=t+.18+b.rng()*.22;
      }
    }

    // Tactical jump-shot in close/mid duel (non-charger, non-swimming, off cooldown)
    if (!swim && !actor.airborne && !actor.giant && !actor.weapon?.charge &&
        d>2.8 && d<12.5 && !isCabin(actor.x) && !stairLane(actor.x,actor.z,.2) &&
        t>=(m.jumpAt??0) && t>=(actor.npcJumpAt??0)) {
      const chance=m.traits.jumpTendency*(.04+m.adrenaline*.065);
      if (b.rng()<chance && !b.bodyBlocked({...actor,y:actor.y+.67},actor.radius??.42,1.72)) {
        jump=true;
        m.jumpAt=t+1.05+b.rng()*.95;
        actor.npcJumpAt=m.jumpAt;
      }
    }

    return {jump,swim};
  }

  /**
   * Smart ability orchestration: Super activation, Subweapon deployment
   * (including flushing enemies behind cover!), and Recon/Attack Drone summoning.
   */
  orchestrateAbilities(actor,enemy,sight,s) {
    const b=this.battle, m=this.mind(actor), t=b.clock;
    const level=zoneOf(actor.x);
    const d=enemy?dist2(actor,enemy):Infinity;

    // 1) Super timing
    if (actor.superCharge>=100 && (enemy || b.hazards?.goat?.active)) {
      const target=enemy ?? (level===0 && b.hazards?.goat?.active?b.hazards.goat:null);
      if (target) {
        const td=dist2(actor,target);
        const id=actor.weapon.special;
        const intel=b.tactics.intelligence(actor,level);
        const group=intel.filter(c=>dist2(c,target)<7.5).length;
        const hpRatio=actor.hp/Math.max(1,actor.maxHp??100);
        const use=
          id==='shield'?hpRatio<.72 || m.adrenaline>.75:
          id==='health'?hpRatio<.66:
          id==='range'?td>11.5 || target.isGoat || target.isSniper:
          id==='slam'?td<6.2:
          id==='giant'?td<10.5 && hpRatio>.45:
          id==='beam'?td>4.5 && td<28:
          id==='vortex'?group>=2 || td<11 || target.isBoss || target.isGoat:
          id==='ebot'?td<22:
          td<19;
        if (use && b.abilities.activate(actor)) {
          if (actor.slam) return true;
        }
      }
    }

    // 2) Proactive subweapon usage (also flushes enemies who just ducked behind cover!)
    if (t>=(s.subScan??0) && b.subweapons.canUse(actor)) {
      s.subScan=t+.34;
      const sub=subweaponById(actor.subId);
      const minTank=actor.tankMax*(actor.isCheater?.25:.46);
      if (actor.tank>=minTank) {
        // Flush enemy behind cover using last-known position (`sight.foot`)
        const flushTarget=enemy ?? (!sight?.visible && sight?.foot && t-sight.at<2.4?sight.foot:null);
        if (flushTarget) {
          const fd=dist2(actor,flushTarget);
          const yaw=Math.atan2(flushTarget.x-actor.x,actor.z-flushTarget.z);
          if (sub.id==='curtain' && actor.hp<(actor.maxHp??100)*.76 && fd>=4 && fd<=15) {
            if (Math.cos(actor.yaw-yaw)>.68) b.subweapons.use(actor,yaw,-.08);
          } else if (sub.id==='throw' && fd>=5 && fd<=16) {
            // Aim slightly higher when lobbing over obstacles
            const lobPitch=clamp(-.04+(fd-8)*.022,-.14,.28);
            if (Math.cos(actor.yaw-yaw)>.76) b.subweapons.use(actor,yaw,lobPitch);
          } else if (sub.id==='see' && fd>=4.5 && fd<=17 && !(flushTarget.revealUntil>t)) {
            if (Math.cos(actor.yaw-yaw)>.72) b.subweapons.use(actor,yaw,-.05);
          } else if (enemy) {
            b.subweapons.consider(actor,enemy);
          }
        }
      }
    }

    // 3) Smart drone deployment during contested pushes or boss/Goat events
    if (!actor.drone && actor.tank>58 && t>=(actor.droneReady??0) && b.elapsed>10) {
      const crisis=b.hazards?.goat?.active || b.boss?.active || (enemy && d<22);
      if (crisis || (m.traits.teamwork>.72 && b.rng()<.04)) {
        b.abilities.summon(actor);
      }
    }

    return false;
  }

  /**
   * Humanized patrol / reconnaissance pose: instead of staring robotically straight
   * ahead, NPCs smoothly glance toward intersections, known contacts, sniper perches,
   * or hovering Goat when moving between sectors.
   */
  patrolPose(actor) {
    const b=this.battle, m=this.mind(actor), t=b.clock;
    if (t>=m.glanceAt) {
      m.glanceAt=t+m.traits.glanceRate*(.7+b.rng()*.7);
      // Glance toward highest-interest threat vector if any exists
      const h=b.hazards;
      if (zoneOf(actor.x)===0 && h?.goat?.active && dist2(actor,h.goat)<34) {
        m.glanceYaw=bearingTo(actor,[h.goat.x,h.goat.y+1.8,h.goat.z]);
      } else if (zoneOf(actor.x)===0 && h?.snipers?.some(s=>s.active) && b.rng()<.45) {
        const sn=h.snipers.find(s=>s.active);
        m.glanceYaw=bearingTo(actor,[sn.x,sn.y+1.2,sn.z]);
      } else {
        const intel=b.tactics.intelligence(actor,zoneOf(actor.x));
        if (intel.length) {
          const c=intel[0];
          m.glanceYaw=bearingTo(actor,[c.x,c.y+1,c.z]);
        } else {
          // Natural human corner-check glance (+/- 25°..55° from travel heading)
          m.glanceYaw=actor.yaw+(b.rng()<.5?-1:1)*(.38+b.rng()*.52);
        }
      }
    }
    const diff=Math.abs(angleDiff(actor.yaw,m.glanceYaw));
    if (diff>1.45) return {};
    return {look:m.glanceYaw,ready:.42+m.adrenaline*.35};
  }

  /**
   * HNV1 movement & engagement controller for Octopus Raiders (`dist/raiders.js`).
   * Gives Raiders human-like dodging, cross-strafing, and ballistic lead.
   */
  raiderEngage(raider,target,sight,dt) {
    const b=this.battle, m=this.tick(raider,dt,sight);
    const aim=this.predictAim(raider,sight);
    const d=dist2(raider,sight.foot);
    const yaw=bearingTo(raider,aim);
    const pitch=clamp(Math.atan2(aim[1]-raider.y-1.25,Math.max(1,d)),-.52,.46);

    // Dodge incoming shots just like a human fighter
    const shots=b.shots;
    let dodgeDir=0;
    for (let i=shots.length-1;i>=Math.max(0,shots.length-24);i--) {
      const sh=shots[i];
      if (sh.actor.team===raider.team || !sameLevel(sh.pos[0],raider.x)) continue;
      const rx=raider.x-sh.pos[0], rz=raider.z-sh.pos[2];
      if (rx*rx+rz*rz>144) continue;
      const dot=rx*sh.vel[0]+rz*sh.vel[2];
      if (dot>0) {dodgeDir=(rx*sh.vel[2]-rz*sh.vel[0])>=0?1:-1;break;}
    }

    const strafeAngle=dodgeDir?dodgeDir*1.45:m.strafeDir*(1.05+.32*Math.sin(m.phase));
    const speed=raider.giant?4.75:d>9.5?3.45:2.45;
    const moveYaw=dodgeDir?yaw+strafeAngle:(raider.giant || d>9.3?yaw+strafeAngle*.25:d<4.2?yaw+Math.PI+strafeAngle*.45:yaw+strafeAngle);
    return {aim,d,yaw,pitch,moveYaw,speed,spread:this.aimSpread(raider,d)};
  }

  /**
   * HNV1 target selection & ballistic lead for Apartment Snipers (`dist/hazards.js`).
   */
  pickSniperTarget(sniper,range,dt) {
    const b=this.battle, m=this.tick(sniper,dt);
    const eye=[sniper.x,sniper.y+1.35,sniper.z];
    let best=null, bestScore=Infinity, bestDist=range;
    for (let i=0;i<b.actors.length;i++) {
      const actor=b.actors[i];
      if (actor.down>0 || actor.shield>0 || actor.ride || actor.lift || zoneOf(actor.x)!==0) continue;
      const tp=[actor.x,actor.y+(actor.swimming?.36:1.05),actor.z];
      const dist=Math.hypot(tp[0]-eye[0],tp[1]-eye[1],tp[2]-eye[2]);
      if (dist>=range || dist<2) continue;
      if (b.traceShot(eye,tp,true) || b.subweapons.block(eye,tp,-1)) continue;
      const score=this.scoreTarget(sniper,actor,m.lastTarget);
      if (score<bestScore) {bestScore=score;bestDist=dist;best=actor;}
    }
    m.lastTarget=best;
    if (!best) return null;
    const predicted=this.predictAim(sniper,best,sniper.weapon);
    return {actor:best,pos:predicted,dist:bestDist};
  }

  /**
   * HNV1 swarm intelligence for Rogue Drones (`dist/hazards.js`).
   * Coordinates orbiting crossfire, sibling separation, and predictive aiming.
   */
  planRogueDrone(drone,siblings,weapon,dt) {
    const b=this.battle, m=this.tick(drone,dt);
    const from=[drone.x,drone.y-.18,drone.z];
    let chase=null, chaseScore=Infinity, fireActor=null, fireScore=Infinity;
    for (let i=0;i<b.actors.length;i++) {
      const actor=b.actors[i];
      if (actor.down>0 || actor.ride || actor.lift || !sameLevel(actor.x,drone.x)) continue;
      const tp=[actor.x,actor.y+(actor.swimming?.36:.92),actor.z];
      const dist=Math.hypot(tp[0]-from[0],tp[1]-from[1],tp[2]-from[2]);
      const sc=this.scoreTarget(drone,actor,m.lastTarget);
      if (sc<chaseScore) {chaseScore=sc;chase=actor;}
      if (actor.shield<=0 && dist<weapon.range && dist>.9 && sc<fireScore &&
          !b.traceShot(from,tp,true) && !b.subweapons.block(from,tp,-1)) {
        fireScore=sc;
        fireActor=actor;
      }
    }
    m.lastTarget=fireActor ?? chase;

    // Sibling separation + tactical orbit angle around target (prevents stacking)
    let sepX=0, sepZ=0;
    for (let i=0;i<siblings.length;i++) {
      const other=siblings[i];
      if (other===drone || !other.active || !sameLevel(other.x,drone.x)) continue;
      const rx=drone.x-other.x, rz=drone.z-other.z, rd=Math.hypot(rx,rz);
      if (rd>.05 && rd<4.5) {
        const push=(1-rd/4.5)*2.2;
        sepX+=rx/rd*push;
        sepZ+=rz/rd*push;
      }
    }

    let desiredYaw=drone.yaw;
    if (chase) {
      const dx=chase.x-drone.x, dz=chase.z-drone.z, dist=Math.hypot(dx,dz);
      const toYaw=Math.atan2(dx,-dz);
      // Orbit smoothly at 7.5m while strafing asynchronously
      const orbitOffset=dist<6.5?m.strafeDir*1.85:dist<11.5?m.strafeDir*.95:m.strafeDir*.28;
      const vx=Math.sin(toYaw+orbitOffset)*5.5+sepX;
      const vz=-Math.cos(toYaw+orbitOffset)*5.5+sepZ;
      desiredYaw=Math.atan2(vx,-vz);
    }

    const fireTarget=fireActor?this.predictAim(drone,fireActor,weapon):null;
    return {chase,fireTarget,desiredYaw,bob:Math.sin(m.phase*1.3)*.42};
  }

  /**
   * HNV1 target selector for Giant Squid Boss & God of Destruction Goat.
   * Hunts clustered fighters, active special users, and low-HP finishers within 50m.
   */
  pickApexTarget(apex,candidates,dt) {
    const m=this.tick(apex,dt);
    let best=null, bestScore=Infinity;
    for (let i=0;i<candidates.length;i++) {
      const c=candidates[i];
      let sc=this.scoreTarget(apex,c,m.lastTarget);
      if (apex.isGoat) {
        // Cluster bonus: prefer targets surrounded by teammates for multi-kill AoE
        let neighbors=0;
        for (let j=0;j<candidates.length;j++) {
          if (i===j) continue;
          const o=candidates[j];
          if ((o.x-c.x)**2+(o.z-c.z)**2<64) neighbors++;
        }
        sc-=neighbors*10.5;
        if (c.beaming || c.giant || c.superUntil>(this.battle?.clock??0)) sc-=11;
        if ((c.hp??100)<48) sc-=8;
        if (c.isPlayer) sc-=4.5;
      }
      if (sc<bestScore) {bestScore=sc;best=c;}
    }
    m.lastTarget=best;
    return best;
  }

  /**
   * Diagnostic summary of HNV1 state for tests & telemetry.
   */
  status(actor) {
    const m=this.mind(actor);
    return {
      engine:m.engine,
      version:this.version,
      gain:this.gain,
      archetype:m.archetype,
      label:m.label,
      adrenaline:m.adrenaline,
      morale:m.morale,
      focus:m.focus,
      streak:m.streak,
      precision:m.traits.precision
    };
  }
}
