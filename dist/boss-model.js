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

const _bSide=[0,0,0], _bAxis=[0,0,0], _bFace=[0,0,0], _bBasis=[_bSide,_bAxis,_bFace];
const _bDyn={dynamic:true};
const _bDynYP={dynamic:true,yaw:0,pitch:0};
const _bDynBasis={dynamic:true,basis:_bBasis};
const _bPts=[[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]];

export function drawBossModel(r,boss,time,collision=false) {
  const p=COLORS[clamp((boss.phase??1)-1,0,2)];
  const yaw=Math.PI-boss.yaw, cy=Math.cos(yaw), sy=Math.sin(yaw);
  const bx=boss.x, by=boss.y, bz=boss.z;
  const speed=Math.hypot(boss.vx??0,boss.vz??0), stride=(boss.steps??time)*2.72+time*.58;
  const {kind,wind,kick}=bossCastMotion(boss.cast,time);
  const slam=kind==='slam', sweep=kind==='sweep', mortar=kind==='mortar', lash=kind==='lash';
  const breath=1+Math.sin(time*3.2)*.026+wind*.085;
  const lift=slam?.49*wind-.33*kick:mortar?.29*wind-.19*kick:.055*wind;
  const lean=slam?-.46*wind+.18*kick:mortar || lash?-.38*wind+.37*kick:.24*wind;
  const twist=sweep?-.41*wind+.51*kick:0;
  const bank=(boss.poseBank??0)*.72;
  const lite=!!r.lite || !!r.ultra;
  const useScratch=!!r.seal && !collision;
  const part=(type,x,y,z,w,h,d,tint,k=SKIN,pitch=0,turn=0)=>{
    const f=clamp(y*.33,0,1), sx=x+f*(twist+bank), sz=z+f*lean;
    const wx=bx+sx*cy+sz*sy, wy=by+y+f*lift, wz=bz-sx*sy+sz*cy;
    if (useScratch) {
      _bDynYP.yaw=yaw+turn+twist*.22; _bDynYP.pitch=pitch+lean*.30;
      r.add(type,wx,wy,wz,w,h,d,tint,k,_bDynYP);
    } else {
      r.add(type,wx,wy,wz,w,h,d,tint,k,{dynamic:true,yaw:yaw+turn+twist*.22,pitch:pitch+lean*.30});
    }
  };
  part(collision?'orb':'mantle',0,3.60,-.46,3.35*breath,5.23,3.24,p.skin,SKIN,-.15);
  part('orb',0,1.74,-.06,2.86,2.53,2.89,p.belly);
  const eyeScale=1+wind*.14+kick*.18;
  for (const side of [-1,1]) {
    part('orb',side*.92,2.62,1.02,.92,.92,.66,p.eye,SKIN,0,side*.2);
    if (!collision) {
      // Expressive reactive pupil + on-screen glowing iris, brow ridge & rippling lateral mantle fins!
      part('orb',side*.96,2.62,1.31,.44*eyeScale,.56*eyeScale,.16,0x17141f,METAL,0,side*.2);
      if (useScratch) {
        if (!lite) {
          part('orb',side*.97,2.67,1.38,.14,.16,.06,wind>.1?p.hot:p.glow,GLOW,0,side*.2);
          part('bevel',side*.90,3.04,.98,.96,.18,.62,p.skin,SKIN,-.22,side*.24);
        }
        const finWave=Math.sin(time*4.8+side*1.2)*(0.18+clamp(speed*.06,0,.22)+wind*.15);
        part('bevel',side*(1.68+finWave*.24),4.55,-.72,.92,2.15,.22,p.belly,SKIN,-.24+finWave,side*(.35+finWave*.4));
        if (!lite) part('orb',side*(2.02+finWave*.30),4.65,-.74,.24,1.35,.16,p.glow,GLOW,-.24+finWave,side*.35);
      }
    }
  }
  if (useScratch && !lite) {
    // Pulsing bioluminescent chromatophore stripes + floating phase crown!
    const pulse=.5+.5*Math.sin(time*6.2+(boss.phase??1));
    const stripeTint=blendColor(p.glow,p.hot,wind*.65+pulse*.25);
    for (let s=0;s<3;s++) {
      const syOff=3.25+s*.92, sw=2.65-s*.48;
      part('ring',0,syOff,-.46-s*.14,sw,.10,sw*.96,stripeTint,GLOW,-.15);
    }
    if ((boss.phase??1)>=2) {
      const ringSpin=time*(boss.phase===3?2.8:1.6);
      for (let c=0;c<4;c++) {
        const ang=ringSpin+c*TAU/4;
        part('orb',Math.cos(ang)*1.85,6.25+Math.sin(time*5+c)*.14,-.55+Math.sin(ang)*1.6,.24,.24,.24,c%2?p.hot:p.glow,GLOW);
      }
    }
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
  const speedClamp=clamp(speed,0,1);
  for (let i=0;i<BOSS_TENTACLES;i++) {
    const angle=i*TAU/BOSS_TENTACLES+.31;
    const strike=strikes[i], reachOut=strike?throwOut:0;
    const bLx=Math.cos(angle)*.8, bLz=Math.sin(angle)*.8;
    const bf=clamp(.9*.33,0,1), bsx=bLx+bf*(twist+bank), bsz=bLz+bf*lean;
    const baseX=bx+bsx*cy+bsz*sy, baseY=by+.9+bf*lift, baseZ=bz-bsx*sy+bsz*cy;
    for (let j=0;j<=segments;j++) {
      const t=j/segments, wave=Math.sin(stride+i*1.51-t*4.7);
      const coil=wind*.4*(i%2?1:-1)+twist*.45;
      const arc=angle+t*t*(.23*wave+(i%2?.17:-.17)+coil);
      const reach=.8+t*(3.9*(1-wind*.16)+kick*.3);
      const step=Math.max(0,wave)*t*.25*speedClamp;
      const pyLocal=.22+(1-t)*(1-t)*.9+t*t*t*t*t*(.4+wind*.6)+step;
      const f=clamp(pyLocal*.33,0,1);
      const lsx=Math.cos(arc)*reach+f*(twist+bank), lsz=Math.sin(arc)*reach+f*lean;
      let px=bx+lsx*cy+lsz*sy, py=by+pyLocal+f*lift, pz=bz-lsx*sy+lsz*cy;
      if (strike) {
        const tx=strike[0], ty=(by??0)+.25, tz=strike[1];
        const fx=mix(baseX,tx,t), fy=mix(baseY,ty,t)+Math.sin(Math.PI*t)*2.2*(1-reachOut*.5), fz=mix(baseZ,tz,t);
        px=mix(px,fx,reachOut); py=mix(py,fy,reachOut); pz=mix(pz,fz,reachOut);
      }
      const pt=_bPts[j];
      pt[0]=px; pt[1]=py; pt[2]=pz;
    }
    for (let j=1;j<=segments;j++) {
      const from=_bPts[j-1], to=_bPts[j], t=(j-.5)/segments;
      const dx=to[0]-from[0], dy=to[1]-from[1], dz=to[2]-from[2];
      const length=Math.hypot(dx,dy,dz);
      if (length<1e-4) continue;
      const invL=1/length, ax=dx*invL, ay=dy*invL, az=dz*invL;
      let sx, sy2, sz;
      if (ay>.98 || ay<-.98) {
        const inv=1/Math.max(1e-5,Math.hypot(az,ay));
        sx=0; sy2=az*inv; sz=-ay*inv;
      } else {
        const inv=1/Math.max(1e-5,Math.hypot(az,ax));
        sx=-az*inv; sy2=0; sz=ax*inv;
      }
      const fx=sy2*az-sz*ay, fy=sz*ax-sx*az, fz=sx*ay-sy2*ax;
      const width=.92*(1-.8*t);
      const mx=(from[0]+to[0])*.5, my=(from[1]+to[1])*.5, mz=(from[2]+to[2])*.5;
      const segTint=blendColor(p.skin,p.belly,t*.6);
      if (useScratch) {
        _bSide[0]=sx; _bSide[1]=sy2; _bSide[2]=sz;
        _bAxis[0]=ax; _bAxis[1]=ay; _bAxis[2]=az;
        _bFace[0]=fx; _bFace[1]=fy; _bFace[2]=fz;
        r.add('taper',mx,my,mz,width,length+width*.38,width*.92,segTint,SKIN,_bDynBasis);
        r.add('orb',from[0],from[1],from[2],width*1.05,width*.93,width*1.03,p.skin,SKIN,_bDyn);
        if (!lite && j>=2) {
          r.add('orb',mx+fx*width*.46,my+fy*width*.46,mz+fz*width*.46,width*.28,width*.28,width*.28,j===segments?p.hot:p.glow,GLOW,_bDyn);
        }
      } else {
        r.add('taper',mx,my,mz,width,length+width*.38,width*.92,segTint,SKIN,{dynamic:true,basis:[[sx,sy2,sz],[ax,ay,az],[fx,fy,fz]]});
        r.add('orb',from[0],from[1],from[2],width*1.05,width*.93,width*1.03,p.skin,SKIN,{dynamic:true});
      }
    }
  }
}
