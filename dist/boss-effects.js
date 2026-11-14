import {TAU,add,clamp,forward,mix,scale,sub,unit} from './render.js';
import {drawTentacle} from './creature-models.js';

export const BOSS_ATTACK_TIMING={
  mortar:{active:0,linger:.94},
  sweep:{active:.38,linger:.66},
  slam:{active:.48,linger:.76}
};

const palette=[
  {edge:0xc482ff,fluid:0x9c43dc,core:0xffe9ff,shade:0x5f348e},
  {edge:0xf57de4,fluid:0xbd478d,core:0xffefd8,shade:0x76376b},
  {edge:0xffac61,fluid:0xd95758,core:0xfff1ca,shade:0x933955}
];

export function bossArc({from,to,lift},t) {
  return [mix(from[0],to[0],t),mix(from[1],to[1],t)+4*lift*t*(1-t),mix(from[2],to[2],t)];
}

export function bossCastMotion(cast,now) {
  if (!cast || now<cast.start || now>=cast.end) return {kind:null,wind:0,kick:0};
  const before=now<cast.at;
  const t=clamp((now-cast.start)/Math.max(.05,cast.at-cast.start),0,1);
  return {kind:cast.kind,wind:before?t*t:Math.max(0,.5-(now-cast.at)*2.6),kick:before?0:Math.exp(-(now-cast.at)*5.9)};
}

function telegraph(r,a,kind,t,color) {
  const {x,y,z,radius}=a, angle=kind==='sweep'?a.halfAngle:0, yaw=a.yaw??0;
  r.add('hazard',x,y+.021,z,radius*2,1,radius*2,color.edge,24,
    {dynamic:true,yaw:-yaw,label:t,layer:angle/Math.PI});
  if (kind==='sweep') {
    const spread=angle*2, n=r.lite?6:15;
    for (let i=0;i<=n;i++) {
      const direction=yaw-angle+spread*i/n;
      const [dx,,dz]=forward(direction), inner=radius*(i===0 || i===n?.77:.94);
      const start=[x+dx*inner,y+.068,z+dz*inner], end=[x+dx*radius,y+.068,z+dz*radius];
      r.beam(start,end,.048+.042*t,.036,color.core,3,{dynamic:true});
    }
    return;
  }
  const dots=r.lite?8:20;
  for (let i=0;i<dots;i++) {
    const dir=i/dots*TAU, width=i%5===0?.23:.094, inner=radius-width*(.92+t*.66);
    const dx=Math.cos(dir), dz=Math.sin(dir);
    r.beam([x+dx*inner,y+.065,z+dz*inner],[x+dx*(radius+.05),y+.065,z+dz*(radius+.05)],
      i%5===0?.069:.045,.035,i%5===0?color.core:color.edge,3,{dynamic:true});
  }
}

function mortarFlight(r,a,t,now,color) {
  const launch=a.arc?.launch??.16, flight=clamp((t-launch)/(1-launch),0,1);
  if (t<launch && a.arc) {
    const [x,y,z]=a.arc.from, s=.20+t*1.75;
    r.add('orb',x,y,z,s,s,s,color.edge,25,{dynamic:true,label:t});
    return;
  }
  const path=u=>a.arc?bossArc(a.arc,(a.arc.end??1)*u):
    [a.x,a.y+.10+(1-u)**1.14*5.2,a.z];
  const p=path(flight), previous=path(Math.max(0,flight-.035));
  const direction=unit(sub(p,previous)), size=.64+.46*Math.sin(flight*Math.PI);
  if (flight>.015) {
    r.beam(add(p,scale(direction,-size*.58)),add(p,scale(direction,size*.33)),size,size,color.fluid,25,{dynamic:true,shape:'orb'});
    r.beam(add(p,scale(direction,-size*.17)),add(p,scale(direction,size*.36)),size*.48,size*.48,color.core,3,{dynamic:true,shape:'orb'});
  } else r.add('orb',...p,size,size,size,color.edge,25,{dynamic:true});
  const n=r.lite?6:16;
  for (let i=1;i<=n;i++) {
    const u=flight-i*.011;
    if (u<=0) break;
    const point=path(u), wiggle=i*2.399+now*7.3, spread=.027*i;
    const q=add(point,[Math.cos(wiggle)*spread,Math.sin(wiggle)*spread*.65,Math.cos(wiggle*.71)*spread]);
    const s=size*(1-i/(n+1))*.49;
    r.add('orb',...q,s,s*.80,s,i%3===0?color.core:color.fluid,i%3===0?3:25,{dynamic:true});
  }
  for (let j=0;j<(r.lite?1:3);j++) {
    const q=add(p,scale(direction,-size*(.2+j*.34))), s=size*(1.36+j*.15);
    r.add('ring',...q,s,.064+j*.017,s,j===0?color.core:color.edge,3,
      {dynamic:true,yaw:now*(3.6+j),pitch:.51+j*.74});
  }
}

function sweepingArm(r,a,progress,color) {
  const {x,y,z,radius,yaw,halfAngle}=a;
  const direction=yaw-halfAngle+progress*halfAngle*2;
  const points=[];
  for (let i=0;i<=8;i++) {
    const t=i/8, [dx,,dz]=forward(direction-.16*t*t);
    const reach=.86+(radius-.86)*t;
    points.push([x+dx*reach,y+.22+1.20*(1-t)**2+Math.sin(Math.PI*t)*.46,z+dz*reach]);
  }
  drawTentacle(r,points,.91,color.fluid,color.core);
  for (let j=1;j<=3;j++) {
    const alpha=progress-j*.050;
    if (alpha<0) break;
    const [dx,,dz]=forward(yaw-halfAngle+alpha*halfAngle*2);
    r.beam([x+dx*radius*.32,y+.15,z+dz*radius*.32],[x+dx*radius*.98,y+.21,z+dz*radius*.98],
      .083+j*.022,.044,j===1?color.core:color.edge,3,{dynamic:true});
  }
}

function impact(r,a,kind,age,spec,color) {
  const {x,y,z,radius}=a, travel=spec.active?clamp(age/spec.active,0,1):1;
  const fade=clamp((age-spec.active)/spec.linger,0,1);
  const sector=kind==='sweep'?(a.halfAngle??0)/Math.PI:0;
  r.add('hazard',x,y+.023,z,radius*2,1,radius*2,color.fluid,24,
    {dynamic:true,yaw:-(a.yaw??0),label:travel,layer:sector,effect:1+fade});
  if (kind==='sweep' && travel<1) sweepingArm(r,a,travel,color);
  if (kind==='slam' || kind==='mortar') {
    const wave=kind==='slam'?.10+travel*.9:.22+.84*clamp(age/.34,0,1);
    r.add('ripple',x,y+.074,z,radius*2*wave,.04,radius*2*wave,color.core,12,{dynamic:true,label:fade*.87});
    if (!r.lite) r.add('ripple',x,y+.16*(1-fade)+.046,z,radius*2*wave*.86,.03,radius*2*wave*.86,
      color.edge,12,{dynamic:true,label:Math.min(1,.13+fade)});
    const jet=Math.max(0,1-age/.35);
    if (jet>0) {
      const height=(kind==='slam'?2.34:3.26)*jet;
      r.add('taper',x,y+height*.43,z,radius*.33*jet+.13,height,radius*.31*jet+.12,color.fluid,25,
        {dynamic:true,label:jet});
      r.add('orb',x,y+height*.67,z,.33+.51*jet,.41+height*.36,.32+.51*jet,color.core,3,{dynamic:true});
      if (!r.lite) for (let i=0;i<4;i++) {
        const a=i*TAU/4+age*3.8;
        r.beam([x,y+.10,z],[x+Math.cos(a)*radius*.48,y+height*.71,z+Math.sin(a)*radius*.48],
          .12*jet+.035,.13,color.edge,25,{dynamic:true,shape:'taper'});
      }
    }
  }
  const lifetime=kind==='sweep'?.57:.79, strength=clamp(1-age/lifetime,0,1);
  if (strength<=0) return;
  const n=r.lite?9:28, seed=x*.132+z*.318;
  for (let i=0;i<n;i++) {
    const angle=kind==='sweep'?sweepYaw(a,travel)-.21+i/n*.36:i*2.399+seed;
    const speed=1.25+(i%6)*.31, t=clamp(age*speed,0,1.26);
    const reach=kind==='sweep'?radius*(.35+.62*(i/n))*(.94+t*.22):radius*(.19+t*.78);
    const y0=y+.082+Math.max(0,age*(3.9+i%5*.56)-5.6*age*age), size=(.08+(i%5)*.043)*strength;
    const dx=Math.sin(angle),dz=-Math.cos(angle);
    const p=[x+dx*reach,y0,z+dz*reach];
    const tail=[p[0]-dx*.37*strength,p[1]-.12*strength,p[2]-dz*.37*strength];
    if (size>.025) r.beam(tail,p,size,size*.91,i%4===0?color.core:i%3===0?color.shade:color.fluid,i%4===0?3:25,{dynamic:true,shape:'taper'});
  }
}

const sweepYaw=(attack,t)=>(attack.yaw??0)+(attack.halfAngle??0)*(2*t-1);

export function drawBossAttack(r,a,now,phase) {
  const kind=a.kind??'mortar', spec=BOSS_ATTACK_TIMING[kind];
  if (!spec || now<a.start || now>a.at+spec.active+spec.linger) return;
  const color=palette[clamp((a.phase??phase??1)-1,0,2)];
  if (now>=a.at) {
    impact(r,a,kind,now-a.at,spec,color);
    return;
  }
  const t=clamp((now-a.start)/Math.max(.05,a.at-a.start),0,1);
  telegraph(r,a,kind,t,color);
  if (kind==='mortar') mortarFlight(r,a,t,now,color);
  if (kind==='slam') {
    const s=a.radius*(.93-t*.65), h=.14+t*.97;
    r.add('ring',a.x,a.y+h,a.z,s*2,.058,s*2,color.edge,3,{dynamic:true});
    r.add('ripple',a.x,a.y+.055,a.z,s*2,.03,s*2,color.core,12,{dynamic:true,label:.19});
  }
}
