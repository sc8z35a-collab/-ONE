import {castShape,makeShape} from './collision.js';
import {sameLevel,UNDER_X,UNDER_Y,zoneOf} from './layout.js';
import {add,clamp,scale,sub,TAU} from './render.js';

const BLOCKS={
  wood:{hp:70,tint:0xae8158,accent:0xd2ac78},
  clay:{hp:108,tint:0xb17b5f,accent:0xd8b696},
  concrete:{hp:176,tint:0xaeb4aa,accent:0x828d88},
  glass:{hp:26,tint:0x82b7b6,accent:0xdaf6ee}
};
const INK=[0x10d8be,0xff6c33,0xa16bb4];
const EPS=.0001;
const SHARDS=.74;

export function buildBreakableBlocks(world) {
  for (const [id,type,x,y,z,w,h,d] of [
    ['g-wood','wood',-24,0,17.3,1.14,1.01,1.08],
    ['g-clay','clay',7,0,-14.2,1.31,.90,.85],
    ['g-concrete','concrete',33,0,12.75,1.42,1.07,.91],
    ['b-wood','wood',UNDER_X-39,UNDER_Y,21.1,1.14,1.01,1.08],
    ['b-clay','clay',UNDER_X+14,UNDER_Y,27.1,1.31,.90,.85],
    ['b-concrete','concrete',UNDER_X+38,UNDER_Y,6,1.42,1.07,.91]
  ]) world.objects.push({id,type,x,y:y+h/2,z,w,h,d,yaw:0});
}

export function prepareStageObjects(definitions) {
  return definitions.map(o=>{
    const {type,x,y,z,w,h,d,yaw}=o;
    const shape=makeShape(type==='glass'?'glass':'box',x,y,z,w,h,d,type==='glass'?17:2,{yaw});
    return {...o,style:BLOCKS[type],shape};
  });
}

const containsHome=(home,x,y,z)=>y<home.ceiling && y>=-.20 && x>home.x0 && x<home.x1 && z>home.z0 && z<home.z1;

export class StageObjects {
  constructor(world) {
    this.homes=world.homes;
    this.parts=world.stageParts;
    this.byId=new Map(this.parts.map(part=>[part.id,part]));
    this.damage=new Map();
  }

  snapshot() {
    return Array.from(this.damage,([id,{hp,at,team}])=>[id,hp,at,team]);
  }

  restore(rows=[]) {
    this.damage.clear();
    for (const [id,hp,at,team] of rows) {
      if (this.byId.has(id) && Number.isFinite(hp) && hp>=0) this.damage.set(id,{hp,at,team});
    }
  }

  intact(o) {return this.damage.get(o.id)?.hp!==0;}

  strike(o,amount,clock,team) {
    if (!o || !this.intact(o) || !(amount>0)) return;
    const hp=Math.max(0,(this.damage.get(o.id)?.hp??o.style.hp)-amount);
    this.damage.set(o.id,{hp,at:clock,team});
  }

  trace(start,end,clearance,limit) {
    let nearest;
    const delta=sub(end,start);
    for (const o of this.parts) {
      if (!sameLevel(o.x,start[0]) || !this.intact(o)) continue;
      const hit=castShape(o.shape,start,delta,nearest?.t??limit,clearance);
      if (hit) nearest={...hit,stageObject:o};
    }
    return nearest;
  }

  blocked(x,y,z,radius,height) {
    for (const o of this.parts) {
      const {min,max}=o.shape;
      if (y>=max[1]-.024 || y+height<=min[1]+.023 || !this.intact(o)) continue;
      if (Math.hypot(x-clamp(x,min[0],max[0]),z-clamp(z,min[2],max[2]))<radius) return true;
    }
    return false;
  }

  support(x,y,z,surface) {
    let top=surface.y;
    for (const o of this.parts) {
      const {min,max}=o.shape;
      if (o.type==='glass' || max[1]<=top+.12 || max[1]>y+.095 ||
          x<=min[0]+.035 || x>=max[0]-.035 || z<=min[2]+.035 || z>=max[2]-.035 || !this.intact(o)) continue;
      top=max[1];
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
    const from=[x,y+.32,z];
    for (const o of this.parts) {
      if (!sameLevel(o.x,x) || !this.intact(o)) continue;
      const distance=Math.hypot(o.x-x,o.y-y,o.z-z);
      if (distance>radius) continue;
      const hit=battle.traceShot(from,[o.x,o.y,o.z],true);
      if (hit?.stageObject!==o) continue;
      this.strike(o,amount*(1-.47*distance/radius),battle.clock,actor.team);
    }
  }

  draw(renderer,viewX,clock) {
    for (const o of this.parts) {
      if (!sameLevel(o.x,viewX)) continue;
      const state=this.damage.get(o.id);
      if (state?.hp===0) {
        const age=clock-state.at;
        if (age>=0 && age<SHARDS) drawFragments(renderer,o,state,age);
      } else drawObject(renderer,o,state);
    }
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
  r.add('box',x,y,z,w,h,d,tint,type==='wood'?13:2,options);
  if (type==='wood') {
    for (const side of [-1,1]) {
      for (const dy of [-.40,.40]) r.add('box',x,y+h*dy,z+side*(d*.5+.013),w+.03,.13,.042,accent,13,options);
      for (const dx of [-.40,.40]) r.add('box',x+w*dx,y,z+side*(d*.5+.014),.13,h,.043,accent,13,options);
      r.beam([x-w*.38,y-h*.34,z+side*(d*.5+.024)],[x+w*.38,y+h*.34,z+side*(d*.5+.024)],.108,.046,accent,13,{dynamic:true});
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
