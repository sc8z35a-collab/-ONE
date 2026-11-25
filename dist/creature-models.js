const _tSide=[0,0,0], _tAxis=[0,0,0], _tFace=[0,0,0], _tBasis=[_tSide,_tAxis,_tFace];
const _tDyn={dynamic:true};
const _tDynBasis={dynamic:true,basis:_tBasis};

export function drawTentacle(r,points,width,tint,sucker,glow=0) {
  const n=points.length;
  if (n<2) return;
  const invN=1/(n-1), lite=!!r.lite, hi=!!r.fidelity;
  const shape=hi?'limb':'taper', pad=hi?.30:.12;
  for (let i=1;i<n;i++) {
    const from=points[i-1], to=points[i];
    const dx=to[0]-from[0], dy=to[1]-from[1], dz=to[2]-from[2];
    const span=Math.hypot(dx,dy,dz);
    if (span<1e-5) continue;
    const invS=1/span;
    const ax=dx*invS, ay=dy*invS, az=dz*invS;
    let sx, sy, sz;
    if (ay>.94 || ay<-.94) {
      // cross(axis, [1,0,0]) = [0, az, -ay]
      const inv=1/Math.max(1e-5,Math.hypot(az,ay));
      sx=0; sy=az*inv; sz=-ay*inv;
    } else {
      // cross(axis, [0,1,0]) = [-az, 0, ax]
      const inv=1/Math.max(1e-5,Math.hypot(az,ax));
      sx=-az*inv; sy=0; sz=ax*inv;
    }
    const fx=sy*az-sz*ay, fy=sz*ax-sx*az, fz=sx*ay-sy*ax;
    _tSide[0]=sx; _tSide[1]=sy; _tSide[2]=sz;
    _tAxis[0]=ax; _tAxis[1]=ay; _tAxis[2]=az;
    _tFace[0]=fx; _tFace[1]=fy; _tFace[2]=fz;
    const girth=width*(1-.76*i*invN);
    const mx=(from[0]+to[0])*.5, my=(from[1]+to[1])*.5, mz=(from[2]+to[2])*.5;
    r.add(shape,mx,my,mz,girth,span+girth*pad,girth*.90,tint,9,_tDynBasis);
    r.add('orb',from[0],from[1],from[2],girth*1.12,girth*.98,girth*1.02,tint,9,_tDyn);
    if (!lite || i%2===0) {
      const py=my-girth*.42, size=girth*.53;
      r.add('cylinder',mx,py,mz,size,.028,size,sucker,2,_tDyn);
      if (!lite) {
        r.add('cylinder',mx,py-.017,mz,size*.44,.008,size*.44,tint,2,_tDyn);
        if (glow) r.add('orb',mx+fx*girth*.42,my+fy*girth*.42,mz+fz*girth*.42,girth*.26,girth*.26,girth*.26,glow,3,_tDyn);
      }
    }
  }
}
