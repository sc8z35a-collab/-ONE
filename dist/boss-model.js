import {TAU,add,clamp,cross,mix,scale,sub,unit} from './render.js';
import {bossCastMotion} from './boss-effects.js';

export const BOSS_BODY_HEIGHT=6.3;
const SKIN=23, METAL=4, GLOW=3;
// Tentacles: five, reaching TENTACLE_REACH metres when they lash out.
export const BOSS_TENTACLES=5;
// A deliberately plain body (mantle, head, two eyes, five tentacles): the
// squid-skin and sucker textures carry the detail, so it stays light.
const COLORS=[
  {skin:0x5d4f9c,belly:0x8d79c4,eye:0xf2ece0,glow:0x63ffdf,hot:0xffc68d},
  {skin:0x874a8e,belly:0xb779b8,eye:0xf6ebe0,glow:0x9efafa,hot:0xffa27c},
  {skin:0xa84d58,belly:0xd88282,eye:0xfff0e0,glow:0xffc95f,hot:0xffedb1}
];

function blendColor(a,b,t) {
  const channel=shift=>Math.round(mix(a>>shift&255,b>>shift&255,t))<<shift;
  return channel(16)|channel(8)|channel(0);
}

export function drawBossModel(r,boss,time,collision=false) {
  const p=COLORS[clamp((boss.phase??1)-1,0,2)];
  const yaw=Math.PI-boss.yaw, cy=Math.cos(yaw), sy=Math.sin(yaw);
  const speed=Math.hypot(boss.vx??0,boss.vz??0), stride=(boss.steps??time)*2.72+time*.58;
  const {kind,wind,kick}=bossCastMotion(boss.cast,time);
  const slam=kind==='slam', sweep=kind==='sweep', mortar=kind==='mortar', lash=kind==='lash';
  const breath=1+Math.sin(time*3.2)*.022+wind*.078;
  const lift=slam?.49*wind-.33*kick:mortar?.29*wind-.19*kick:.055*wind;
  const lean=slam?-.46*wind+.18*kick:mortar || lash?-.38*wind+.37*kick:.24*wind;
  const twist=sweep?-.41*wind+.51*kick:0;
  const at=(x,y,z)=>{
    const part=clamp(y*.33,0,1), shiftedX=x+part*(twist+(boss.poseBank??0)*.72), shiftedZ=z+part*lean;
    return [boss.x+shiftedX*cy+shiftedZ*sy,boss.y+y+part*lift,boss.z-shiftedX*sy+shiftedZ*cy];
  };
  const part=(type,x,y,z,w,h,d,tint,kind=SKIN,pitch=0,turn=0)=>
    r.add(type,...at(x,y,z),w,h,d,tint,kind,{dynamic:true,yaw:yaw+turn+twist*.22,pitch:pitch+lean*.30});
  part(collision?'orb':'mantle',0,3.60,-.46,3.35*breath,5.23,3.24,p.skin,SKIN,-.15);
  part('orb',0,1.74,-.06,2.86,2.53,2.89,p.belly);
  for (const side of [-1,1]) {
    part('orb',side*.92,2.62,1.02,.92,.92,.66,p.eye,SKIN,0,side*.2);
    if (!collision) part('orb',side*.96,2.62,1.31,.44,.56,.16,0x17141f,METAL,0,side*.2);
  }
  if (!collision && (wind>.12 || kick>.20)) {
    const glow=Math.max(wind,kick*.74), radius=.24+glow*.46;
    part('orb',0,2.0,1.36,radius,.34+radius*.4,radius*.7,blendColor(p.hot,p.glow,wind*.42),25);
  }
  // The five tentacles rest in a ring and wave as it walks; a lash throws
  // each one out to its own strike point.
  const segments=collision?3:5, strikes=lash?boss.cast?.points??[]:[];
  // A lash flies out in the last .15 s before it lands, holds, then recoils.
  const since=lash?time-boss.cast.at:-1;
  const throwOut=since<-.15?0:since<0?(since+.15)/.15:clamp(1-(since-.28)/.32,0,1);
  for (let i=0;i<BOSS_TENTACLES;i++) {
    const angle=i*TAU/BOSS_TENTACLES+.31, points=[];
    const strike=strikes[i], reachOut=strike?throwOut:0;
    const base=at(Math.cos(angle)*.8,.9,Math.sin(angle)*.8);
    for (let j=0;j<=segments;j++) {
      const t=j/segments, wave=Math.sin(stride+i*1.51-t*4.7);
      const coil=wind*.4*(i%2?1:-1)+twist*.45;
      const arc=angle+t*t*(.23*wave+(i%2?.17:-.17)+coil);
      const reach=.8+t*(3.9*(1-wind*.16)+kick*.3);
      const step=Math.max(0,wave)*t*.25*clamp(speed,0,1);
      let point=at(Math.cos(arc)*reach,.22+(1-t)**2*.9+t**5*(.4+wind*.6)+step,Math.sin(arc)*reach);
      if (strike) {
        const tip=[strike[0],(boss.y??0)+.25,strike[1]];
        const flung=[mix(base[0],tip[0],t),mix(base[1],tip[1],t)+Math.sin(Math.PI*t)*2.2*(1-reachOut*.5),mix(base[2],tip[2],t)];
        point=point.map((v,k)=>mix(v,flung[k],reachOut));
      }
      points.push(point);
    }
    for (let j=1;j<=segments;j++) {
      const from=points[j-1], to=points[j], t=(j-.5)/segments, delta=sub(to,from);
      const length=Math.hypot(...delta);
      if (length<1e-4) continue;
      const axis=scale(delta,1/length), side=unit(cross(axis,Math.abs(axis[1])>.98?[1,0,0]:[0,1,0])), face=cross(side,axis);
      const width=.92*(1-.8*t), mid=scale(add(from,to),.5);
      r.add('taper',...mid,width,length+width*.38,width*.92,blendColor(p.skin,p.belly,t*.6),SKIN,{dynamic:true,basis:[side,axis,face]});
      r.add('orb',...from,width*1.05,width*.93,width*1.03,p.skin,SKIN,{dynamic:true});
    }
  }
}
