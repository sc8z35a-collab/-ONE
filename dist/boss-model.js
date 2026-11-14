import {TAU,add,clamp,cross,mix,scale,sub,unit} from './render.js';
import {bossCastMotion} from './boss-effects.js';

export const BOSS_BODY_HEIGHT=6.3;
const CARAPACE=23, METAL=4, GLOW=3;
const COLORS=[
  {shell:0x6057a5,skin:0x473a77,plate:0x263047,edge:0x9a8bd9,light:0x63ffdf,hot:0xffc68d},
  {shell:0x8b4b91,skin:0x693b73,plate:0x472d52,edge:0xc17ac8,light:0x9efafa,hot:0xffa27c},
  {shell:0xad525b,skin:0x843c64,plate:0x573140,edge:0xffa278,light:0xffc95f,hot:0xffedb1}
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
  const slam=kind==='slam', sweep=kind==='sweep', mortar=kind==='mortar';
  const breath=1+Math.sin(time*3.2)*.022+wind*.078, detail=!collision && !r.lite;
  const lift=slam?.49*wind-.33*kick:mortar?.29*wind-.19*kick:.055*wind;
  const lean=slam?-.46*wind+.18*kick:mortar?-.38*wind+.37*kick:.24*wind;
  const twist=sweep?-.41*wind+.51*kick:0;
  const at=(x,y,z)=>{
    const part=clamp(y*.33,0,1), shiftedX=x+part*(twist+(boss.poseBank??0)*.72), shiftedZ=z+part*lean;
    return [boss.x+shiftedX*cy+shiftedZ*sy,boss.y+y+part*lift,boss.z-shiftedX*sy+shiftedZ*cy];
  };
  const part=(type,x,y,z,w,h,d,tint,kind=CARAPACE,pitch=0,turn=0)=>
    r.add(type,...at(x,y,z),w,h,d,tint,kind,{dynamic:true,yaw:yaw+turn+twist*.22,pitch:pitch+lean*.30});
  const bodyMesh=collision?'orb':'mantle';
  part(bodyMesh,0,3.60,-.46,3.35*breath,5.23,3.24,p.shell,CARAPACE,-.15);
  part('orb',0,1.74,-.06,2.86,2.53,2.89,p.skin);
  part('bevel',0,2.68,1.14,2.74,1.16,.95,p.plate,METAL,-.11);
  part('orb',0,2.98,.68,2.33,1.06,1.52,p.skin);
  for (const side of [-1,1]) {
    part(bodyMesh,side*1.37,3.76,-1.04,.98,2.94,1.74,p.skin,CARAPACE,.29,side*.25);
    part('bevel',side*1.03,2.19,.77,.74,.82,1.16,p.plate,METAL,-.35,side*.30);
    if (collision) continue;
    part('orb',side*.64,2.83,1.65,.83,.57,.23,p.edge,CARAPACE,-.10,side*.18);
    part('orb',side*.64,2.83,1.79,.64,.42,.22,0x181e39,METAL,-.10,side*.15);
    part('orb',side*.63,2.83,1.90,.46,.33,.112,p.hot,GLOW,0,side*.13);
    part('orb',side*.61,2.83,1.965,.118,.30,.041,0x252032,METAL);
    part('orb',side*.65,2.91,1.986,.091,.078,.029,0xfff6e7,GLOW);
    part('taper',side*1.63,4.07,-1.01,.16,2.10,.16,p.edge,METAL,.28,side*.2);
    for (let i=0;i<(detail?7:4);i++) {
      const t=i/(detail?6:3), y=3.37+t*1.72, x=side*(1.02-t*t*.43);
      const z=.75-t*.68, pulse=clamp(.54+.40*Math.sin(time*(6.2+wind*4.1)-i*.71)**2+wind*.24,0,1);
      part('bevel',x,y,z,.58-t*.24,.16,.25,p.plate,METAL,-.11,side*.3);
      part('orb',x,y,z+.15,.24*pulse,.061,.094,blendColor(p.edge,p.light,pulse),GLOW);
    }
    for (let i=0;i<(detail?5:3);i++) {
      part('bevel',side*(.87+i*.10),2.05+i*.10,1.37-i*.107,.20,.068,.24,p.edge,METAL,.19,side*.26);
    }
  }
  if (!collision) {
    part('bevel',0,2.22,1.43,.88,.29,.39,p.plate,METAL);
    part('orb',0,2.23,1.66,.48+wind*.24,.13+wind*.17,.15+wind*.25,p.light,GLOW);
    if (wind>.12 || kick>.20) {
      const glow=Math.max(wind,kick*.74), radius=.22+glow*.43;
      part('orb',0,2.36,1.79,radius,.36+radius*.41,radius*.76,blendColor(p.hot,p.light,wind*.42),25);
      if (detail) part('ring',0,2.33,1.84,radius*1.84,.084,radius*1.84,p.hot,GLOW,Math.PI*.45,time*.85);
    }
    part('ring',0,4.97,-.81,1.39,.32,1.45,p.edge,METAL,-.15);
    part('orb',0,5.34,-.69,.20,.54,.26,p.hot,GLOW,-.17);
  }

  const segments=collision?4:detail?7:4;
  for (let i=0;i<10;i++) {
    const long=i>=8, angle=long?Math.PI*.5+(i===8?-.34:.34):i*TAU/8+.18;
    const points=[];
    for (let j=0;j<=segments;j++) {
      const t=j/segments, wave=Math.sin(stride+i*1.51-t*4.7);
      const coil=wind*(long?.78:.36)*(i%2?1:-1)+twist*.45;
      const arc=angle+t*t*(.23*wave+(i%2?.17:-.17)+coil);
      const reach=.75+t*((long?3.62:2.69)*(1-wind*.16)+kick*.29);
      const curl=long?t**5*(.51+.35*Math.sin(stride+i)+wind*(slam?1.08:.64)):t**6*(.34+wind*.47);
      const step=Math.max(0,wave)*t*.25*clamp(speed,0,1);
      points.push(at(Math.cos(arc)*reach,.22+(1-t)**2*.88+curl+step,Math.sin(arc)*reach));
    }
    for (let j=1;j<=segments;j++) {
      const from=points[j-1], to=points[j], t=(j-.5)/segments, delta=sub(to,from);
      const axis=unit(delta), side=unit(cross(axis,[0,1,0])), face=cross(side,axis);
      const width=(long?.85:.69)*(1-.84*t), mid=scale(add(from,to),.5), length=Math.hypot(...delta);
      const skin=blendColor(p.skin,p.edge,t*.75);
      const basis=[side,axis,face];
      r.add('taper',...mid,width,length+width*.38,width*.92,skin,CARAPACE,{dynamic:true,basis});
      r.add('orb',...from,width*1.05,width*.93,width*1.03,skin,CARAPACE,{dynamic:true});
      if (collision || !detail && j%2!==0) continue;
      const edge=add(mid,scale(face,width*.39));
      r.add('bevel',...edge,width*.55,length*.70,width*.26,p.plate,METAL,{dynamic:true,basis});
      const strip=add(edge,scale(face,width*.15));
      r.add('orb',...strip,width*.13,length*.52,width*.15,p.light,GLOW,{dynamic:true,basis});
      if (!detail) continue;
      for (const sign of [-1,1]) {
        const cupNormal=unit(add(scale(side,sign*.82),scale(face,-.57)));
        const rim=add(mid,scale(cupNormal,width*.45));
        const cup=width*.47, crossAxis=unit(cross(axis,cupNormal));
        const cupBasis=[axis,cupNormal,crossAxis];
        r.add('ring',...rim,cup,cup*.32,cup,p.hot,CARAPACE,{dynamic:true,basis:cupBasis});
        r.add('orb',...rim,cup*.56,cup*.13,cup*.56,p.plate,METAL,{dynamic:true,basis:cupBasis});
      }
    }
  }
}
