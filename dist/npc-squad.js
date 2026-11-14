import {zoneOf} from './layout.js';
import {gap} from './npc-combat.js';
import {stairLane} from './stairs.js';

export class NpcSquads {
  constructor(tactics) {
    this.tactics=tactics;
    this.orders=new Map();
    this.next=0;
  }

  refresh() {
    const t=this.tactics,b=t.battle;
    if (b.clock<this.next) return;
    this.next=b.clock+.31;
    const old=this.orders;
    this.orders=new Map();
    for (let team=0;team<2;team++) {
      const pool=b.actors.filter(a=>a.team===team && !a.isPlayer && a.down<=0 && !a.ride && !a.lift && a.hp>60);
      for (let level=0;level<2;level++) {
        const usable=pool.filter(a=>zoneOf(a.x)===level && !stairLane(a.x,a.z) && !t.state(a).plan?.steps.some(step=>step.kind==='train'));
        if (usable.length<2) continue;
        const contacts=t.intelligence(usable[0],level).filter(c=>c.fresh>.74);
        const contact=contacts.sort((a,c)=>Math.min(...usable.map(x=>gap(x,a)))-Math.min(...usable.map(x=>gap(x,c))))[0];
        if (!contact) continue;
        const close=usable.filter(a=>gap(a,contact)<24.5 && gap(a,contact)>4.6);
        const anchor=close.filter(a=>{
          const heard=b.perception.memory.get(a);
          return heard?.visible && gap(heard.foot,contact)<4.2;
        }).sort((a,c)=>
          (a.weapon.charge?-5:0)+gap(a,contact)-(c.weapon.charge?-5:0)-gap(c,contact))[0];
        if (!anchor) continue;
        let chosen=null,best=-Infinity,goal=null;
        for (const a of close) {
          if (a===anchor || a.tank<a.weapon.cost*3 || a.inkPenalty>=3 || a.giant) continue;
          const d=gap(contact,anchor), ux=(anchor.x-contact.x)/d,uz=(anchor.z-contact.z)/d;
          for (const sign of [-1,1]) {
            const p={x:contact.x+ux*3-uz*sign*10.5,z:contact.z+uz*3+ux*sign*10.5};
            const prior=old.get(a);
            const next=b.navs[level].nearest(p);
            if (!next || gap(next,p)>3.2 || gap(a,next)>18.5 || gap(next,contact)<5.7) continue;
            const ownSide=b.world.floor(next.x,next.z);
            const ink=b.paint.get(next.x,next.z,ownSide.layer), y=contact.y??b.world.floor(contact.x,contact.z).y;
            const blocked=b.traceShot([next.x,ownSide.y+1.25,next.z],[contact.x,y+1.03,contact.z],true);
            if (blocked) continue;
            const quality=(prior?.kind==='flank' && gap(prior.goal,next)<4?4:0)+(a.weapon.charge?-2.5:0)+
              (a.index%4===2?1.5:0)+(ink===team+1?1.25:ink?-1.3:0)-gap(a,next)*.47;
            if (quality>best) {best=quality;chosen=a;goal=next;}
          }
        }
        if (!chosen) continue;
        this.orders.set(chosen,{kind:'flank',goal,contact});
        this.orders.set(anchor,{kind:'anchor'});
      }
    }
  }
}
