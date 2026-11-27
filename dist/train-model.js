import {RAIL,loopWrap,railPath} from './layout.js';
import {STRIDE,cross,dot,packInstance,sub,unit} from './render.js';
import {TEAM_INK} from './world.js';
import {doorWindowId,drawTrainWindow,seatWindowId} from './train-glass.js';

const _TRAIN_SHAPE_IDS={box:1,ramp:2,bevel:3,soft:4};
const _TRAIN_SYMMETRIC=new Set(['box','bevel','cylinder','taper','cone','orb','soft','limb','mantle','ring']);

function recordTrainTemplate(fn) {
  const buckets=new Map(), labels=[];
  const rec={
    add(type,x,y,z,w,h,d,tint,kind=0,opts={}) {
      let arr=buckets.get(type);
      if (!arr) {arr=[];buckets.set(type,arr);}
      const o=arr.length;
      arr.length=o+STRIDE;
      packInstance(arr,o,x,y,z,w,h,d,tint,kind,opts,_TRAIN_SHAPE_IDS[type]??0,_TRAIN_SYMMETRIC.has(type));
    },
    beam(a,b,width,depth,tint,kind=0,opts={}) {
      const dx=b[0]-a[0], dy=b[1]-a[1], dz=b[2]-a[2];
      const len=Math.hypot(dx,dy,dz);
      if (len<1e-5) return;
      const uy=dy/len, ux=dx/len, uz=dz/len;
      const rx=Math.abs(uy)>.9?1:0, ry=0, rz=Math.abs(uy)>.9?0:1;
      const sx=ry*uz-rz*uy, sy=rz*ux-rx*uz, sz=rx*uy-ry*ux;
      const sl=Math.hypot(sx,sy,sz)||1;
      const bx0=sx/sl, bx1=sy/sl, bx2=sz/sl;
      const bz0=uy*bx2-uz*bx1, bz1=uz*bx0-ux*bx2, bz2=ux*bx1-uy*bx0;
      this.add(opts.shape??'box',(a[0]+b[0])*.5,(a[1]+b[1])*.5,(a[2]+b[2])*.5,width,len,depth,tint,kind,
        {dynamic:true,basis:[[bx0,bx1,bx2],[ux,uy,uz],[bz0,bz1,bz2]]});
    },
    label(text,x,y,z,w,h,tint,yaw=0,pitch=0,opts={}) {
      labels.push([text,x,y,z,w,h,tint,yaw,pitch,opts]);
    }
  };
  fn(rec);
  const out=[];
  for (const [type,arr] of buckets) {
    const src=new Float32Array(arr);
    const dst=new Float32Array(src.length);
    out.push([type,src,dst,null]);
  }
  return {buckets:out,labels};
}

const CAR_CENTERS=[-4.59,4.59], BOGIE_CENTERS=[-2.65,2.65], DOORS=[-1.95,1.95];
export const TRAIN_DOORS=CAR_CENTERS.flatMap(car=>DOORS.map(door=>car+door));
export const TRAIN_AXLES=CAR_CENTERS.flatMap(car=>BOGIE_CENTERS.flatMap(bogie=>[-.49,.49].map(wheel=>car+bogie+wheel)));
export const TRAIN_HULLS=CAR_CENTERS.map(c=>({
  min:[c-4.385,.91,-1.492],max:[c+4.385,3.369,1.492]
}));
TRAIN_HULLS.push({min:[-.249,.93,-.96],max:[.249,2.73,.96]});
for (const sign of [-1,1]) {
  TRAIN_HULLS.push({
    min:[sign<0?-9.28:8.975,.98,-1.22],
    max:[sign<0?-8.975:9.28,2.81,1.22]
  });
}
for (const hull of TRAIN_HULLS) {
  for (const edge of [hull.min,hull.max]) {
    edge[1]=1+(edge[1]-1)*1.44;
    edge[2]*=1.18;
  }
}

const SILVER=0xd1d9d5, EDGE=0x8c9996, STRIPE=0x477c75, RUST=0x9d7857;
const WINDOW=0x466663, RUBBER=0x414d4b, FRAME=0x596762, STEEL=0x84918d;
const ROOF=0xa9b4ad, GOLD=0xc6a773;

export function trainPose(t,line=RAIL) {
  // On the looped line the train follows the curve: t.x is the distance
  // along the track, and the heading turns the whole car.
  const path=line.loop?railPath(t.x):null, heading=path?.yaw??0, yaw=t.yaw+heading;
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cr=Math.cos(t.roll),sr=Math.sin(t.roll);
  const cp=Math.cos(t.routePitch??0),sp=Math.sin(t.routePitch??0);
  const baseY=line.y+t.lift;
  const baseX=path?line.center+path.x+Math.sin(heading)*t.lateral:line.center+t.x;
  const baseZ=path?path.z+Math.cos(heading)*t.lateral:line.z+t.lateral;
  function rotate(x,y,z) {
    const side=y*sr+z*cr;
    const height=y*cr-z*sr, along=x*cp-height*sp;
    return [along*cy+side*sy,x*sp+height*cp,-along*sy+side*cy];
  }
  function at(x,y,z) {
    const [dx,dy,dz]=rotate(x,y,z);
    return [baseX+dx,baseY+dy,baseZ+dz];
  }
  const basis=[rotate(1,0,0),rotate(0,1,0),rotate(0,0,1)];
  const origin=[baseX,baseY,baseZ];
  return {rotate,at,basis,origin,local(point) {
    const offset=sub(point,origin);
    return basis.map(axis=>dot(axis,offset));
  }};
}

export function drawTrain(r,t,clock,line=RAIL) {
  // Rigid straight-track packed template fast path: replaces ~250 per-frame add() calls with ~5 memcpy blasts!
  if (typeof r.addPacked==='function' && !t.berserk && !t.marks.length &&
      t.yaw===0 && t.roll===0 && (t.routePitch??0)===0 &&
      (!line.loop || Math.abs(loopWrap(t.x))<=line.edge)) {
    const path=line.loop?railPath(t.x):null;
    const heading=path?.yaw??0;
    if (heading===0) {
      const baseX=path?line.center+path.x:line.center+t.x;
      const baseY=line.y+t.lift;
      const baseZ=path?path.z+t.lateral:line.z+t.lateral;
      let winHash=0;
      if (t.windows) {for (const k in t.windows) winHash=winHash*31+(t.windows[k]|0);}
      const key=`${t.doorOpen}|${t.direction}|${t.phase==='recover'?1:0}|${line.cabinX}|${line.doorSide}|${line.gauge}|${line.integrity?1:0}|${winHash}`;
      let tpl=t._rigidTpl;
      if (!tpl || tpl.key!==key) {
        const fakeT={...t,x:0,lift:0,lateral:0,yaw:0,roll:0,routePitch:0,wetness:0,speed:0,marks:[]};
        const fakeLine={...line,center:0,y:0,z:0,loop:false};
        tpl={key,...recordTrainTemplate(rec=>drawTrainRaw(rec,fakeT,0,fakeLine)),dx:0,dy:0,dz:0,init:false};
        t._rigidTpl=tpl;
      }
      const buckets=tpl.buckets;
      if (!tpl.init) {
        for (let b=0;b<buckets.length;b++) {
          const [type,src,dst]=buckets[b], len=src.length;
          dst.set(src);
          for (let o=0;o<len;o+=STRIDE) {dst[o+12]+=baseX; dst[o+13]+=baseY; dst[o+14]+=baseZ;}
          r.addPacked(type,dst,baseX,baseY+2.4,baseZ,11.5);
        }
        tpl.dx=baseX; tpl.dy=baseY; tpl.dz=baseZ; tpl.init=true;
      } else {
        const ddx=baseX-tpl.dx, ddy=baseY-tpl.dy, ddz=baseZ-tpl.dz;
        const moved=ddx!==0 || ddy!==0 || ddz!==0;
        for (let b=0;b<buckets.length;b++) {
          const [type,,dst]=buckets[b];
          if (moved) {
            const sp=dst._split;
            if (sp) {
              for (const subArr of [sp.arch,sp.vfx,sp.full]) {
                if (!subArr) continue;
                for (let o=0;o<subArr.length;o+=STRIDE) {subArr[o+12]+=ddx; subArr[o+13]+=ddy; subArr[o+14]+=ddz;}
              }
            } else {
              for (let o=0;o<dst.length;o+=STRIDE) {dst[o+12]+=ddx; dst[o+13]+=ddy; dst[o+14]+=ddz;}
            }
          }
          r.addPacked(type,dst,baseX,baseY+2.4,baseZ,11.5);
        }
        tpl.dx=baseX; tpl.dy=baseY; tpl.dz=baseZ;
      }
      const labels=tpl.labels;
      for (let i=0;i<labels.length;i++) {
        const L=labels[i];
        r.label(L[0],L[1]+baseX,L[2]+baseY,L[3]+baseZ,L[4],L[5],L[6],L[7],L[8],L[9]);
      }
      if (t.wetness>.16 && t.speed>.7) {
        for (let i=0;i<7;i++) {
          const dx=((i*2.72+clock*t.speed)%16)-8, side=i%2?1:-1;
          const height=.14+Math.sin(clock*13+i)**2*.38;
          r.add('orb',baseX+dx,baseY+height,baseZ+side*(line.gauge+.26+height*.45),.07,.11,.14,t.inkColor,9,{dynamic:true});
        }
      }
      return;
    }
  }
  drawTrainRaw(r,t,clock,line);
}

const _TR_SIGNS=[-1,1], _TR_SEATS=[-3.45,0,3.45], _TR_POSTS=[-1.65,1.65];
const _TR_PANELS=[[-3.40,1.34],[0,2.55],[3.40,1.34]], _TR_SHIFTS=[-.49,.49];
const _TR_SPRINGS=[-.059,0,.059], _TR_COUPLERS=[-.153,0,.153];
const _TR_DYN_OPTS={dynamic:true};

function drawTrainRaw(r,t,clock,line=RAIL) {
  const path=line.loop?railPath(t.x):null, heading=path?.yaw??0, yaw=t.yaw+heading;
  const cy=Math.cos(yaw), sy=Math.sin(yaw), cr=Math.cos(t.roll), sr=Math.sin(t.roll);
  const cp=Math.cos(t.routePitch??0), sp=Math.sin(t.routePitch??0);
  const baseY=line.y+t.lift;
  const baseX=path?line.center+path.x+Math.sin(heading)*t.lateral:line.center+t.x;
  const baseZ=path?path.z+Math.cos(heading)*t.lateral:line.z+t.lateral;
  // Exact 3x3 basis columns (col0 = rotate(1,0,0), col1 = rotate(0,1,0), col2 = rotate(0,0,1))
  const m00=cp*cy, m01=sp, m02=-cp*sy;
  const m10=-cr*sp*cy+sr*sy, m11=cr*cp, m12=cr*sp*sy+sr*cy;
  const m20=sr*sp*cy+cr*sy, m21=-sr*cp, m22=-sr*sp*sy+cr*cy;
  const b0=[m00,m01,m02], b1=[m10,m11,m12], b2=[m20,m21,m22];
  const basis=[b0,b1,b2];
  const rotate=(x,y,z)=>[
    x*m00+y*m10+z*m20,
    x*m01+y*m11+z*m21,
    x*m02+y*m12+z*m22
  ];
  const rawAt=(x,y,z)=>[
    baseX+x*m00+y*m10+z*m20,
    baseY+x*m01+y*m11+z*m21,
    baseZ+x*m02+y*m12+z*m22
  ];
  const at=(x,y,z)=>{
    const yy=y>.82?1+(y-1)*1.44:y, zz=y>.82?z*1.18:z;
    return [
      baseX+x*m00+yy*m10+zz*m20,
      baseY+x*m01+yy*m11+zz*m21,
      baseZ+x*m02+yy*m12+zz*m22
    ];
  };
  const bodyAxes=axes=>{
    const out=[];
    for (let i=0;i<3;i++) {
      const ax=axes[i];
      const lx=ax[0]*m00+ax[1]*m01+ax[2]*m02;
      const ly=(ax[0]*m10+ax[1]*m11+ax[2]*m12)*1.44;
      const lz=(ax[0]*m20+ax[1]*m21+ax[2]*m22)*1.18;
      out.push([lx*m00+ly*m10+lz*m20,lx*m01+ly*m11+lz*m21,lx*m02+ly*m12+lz*m22]);
    }
    return out;
  };
  const berserk=!!t.berserk;
  const stripe=berserk?0xff3040:line.cabinX===RAIL.cabinX?STRIPE:0x865768;
  const axle=[b0,b2,[-m10,-m11,-m12]];
  const front=[[-m20,-m21,-m22],b1,b0];
  const rear=[b2,b1,[-m00,-m01,-m02]];
  const north=[[-m00,-m01,-m02],b1,[-m20,-m21,-m22]];
  const bodyBasis=bodyAxes(basis), bodyFront=bodyAxes(front), bodyRear=bodyAxes(rear), bodyNorth=bodyAxes(north);
  const optBasis={dynamic:true,basis}, optBodyBasis={dynamic:true,basis:bodyBasis};
  const optAxle={dynamic:true,basis:axle}, optNorth={dynamic:true,basis:bodyNorth};
  const optFront={dynamic:true,basis:bodyFront}, optRear={dynamic:true,basis:bodyRear};
  const optCache=new Map([[basis,optBasis],[axle,optAxle],[front,{dynamic:true,basis:front}],[rear,{dynamic:true,basis:rear}],[north,{dynamic:true,basis:north}]]);
  const bodyOptCache=new Map([[basis,optBodyBasis],[front,optFront],[rear,optRear],[north,optNorth]]);
  function piece(kind,x,y,z,w,h,d,tint,material=4,axes=basis) {
    let yy=y, zz=z, opt;
    if (y>.82) {
      yy=1+(y-1)*1.44; zz=z*1.18;
      opt=axes===basis?optBodyBasis:bodyOptCache.get(axes);
      if (!opt) {opt={dynamic:true,basis:bodyAxes(axes)}; bodyOptCache.set(axes,opt);}
    } else {
      opt=axes===basis?optBasis:axes===axle?optAxle:optCache.get(axes);
      if (!opt) {opt={dynamic:true,basis:axes}; optCache.set(axes,opt);}
    }
    r.add(kind,
      baseX+x*m00+yy*m10+zz*m20,
      baseY+x*m01+yy*m11+zz*m21,
      baseZ+x*m02+yy*m12+zz*m22,
      w,h,d,tint,material,opt);
  }
  const sideSign=(text,x,y,z,width,height,tint,axes=basis)=>{
    const yy=y>.82?1+(y-1)*1.44:y, zz=y>.82?z*1.18:z;
    const opt=axes===basis?optBodyBasis:bodyOptCache.get(axes) ?? {dynamic:true,basis:bodyAxes(axes)};
    r.label(text,
      baseX+x*m00+yy*m10+zz*m20,
      baseY+x*m01+yy*m11+zz*m21,
      baseZ+x*m02+yy*m12+zz*m22,
      width,height,tint,0,0,opt);
  };
  for (let ci=0;ci<2;ci++) {
    const car=_TR_SIGNS[ci];
    const c=CAR_CENTERS[ci], nose=c+car*4.41, inner=c-car*4.31;
    piece('bevel',c,.907,0,8.77,.28,2.66,berserk?0x2d1b20:FRAME);
    piece('box',c,1.025,0,8.78,.11,2.61,0x8d9a93);
    for (let si=0;si<3;si++) {
      const seat=_TR_SEATS[si];
      for (let sj=0;sj<2;sj++) {
        const side=_TR_SIGNS[sj];
        piece('bevel',c+seat,1.344,side*.873,1.35,.132,.525,0x789b91,2);
        piece('bevel',c+seat,1.56,side*1.118,1.36,.403,.195,0x819d92,2);
      }
    }
    for (let pi=0;pi<2;pi++) piece('cylinder',c+_TR_POSTS[pi],1.99,.34,.039,1.8,.039,STEEL);
    piece('bevel',c,3.132,0,8.83,.50,2.72,berserk?0x3a2026:ROOF);
    if (berserk) {
      const pulse=Math.sin(clock*18+car)>.0?0xff2838:0xff8826;
      piece('orb',c,3.45,0,.85,.42,.85,pulse,3);
      piece('box',c,3.28,0,8.6,.12,.38,0xff3040,3);
    }
    piece('box',c,2.881,0,8.78,.127,2.62,0xaab4aa);
    for (let sj=0;sj<2;sj++) piece('box',inner,1.97,_TR_SIGNS[sj]*1.05,.16,1.94,.43,0xaebcb3);
    piece('box',inner,2.87,0,.16,.15,1.68,0xaebcb3);
    piece('bevel',nose-car*.18,1.43,0,.59,.93,2.63,berserk?0x4b2a30:SILVER);
    piece('bevel',nose-car*.18,2.94,0,.59,.18,2.63,berserk?0x4b2a30:SILVER);
    for (let sj=0;sj<2;sj++) piece('bevel',nose-car*.18,2.34,_TR_SIGNS[sj]*1.18,.59,1.16,.27,berserk?0x4b2a30:SILVER);
    drawTrainWindow(r,t,'cab:'+car,at(nose+car*.157,2.37,0),2.10,.83,berserk?0x8a1e28:WINDOW,car===1?bodyFront:bodyRear);
    piece('box',nose+car*.203,2.44,0,.028,.64,.034,0x667774);
    piece('box',nose+car*.139,1.62,0,.09,.18,2.47,stripe,berserk?3:4);
    piece('bevel',nose+car*.116,1.09,0,.22,.22,2.56,EDGE);
    piece('box',nose+car*.223,.81,0,.24,.17,.42,RUBBER);
    sideSign(berserk?'RUNAWAY':line.integrity?'B1 LOOP':'07 LOCAL',nose+car*.220,2.83,0,1.18,.21,berserk?0xff4d5a:0xeff2de,car===1?front:rear);
    for (let sj=0;sj<2;sj++) {
      const side=_TR_SIGNS[sj], z=side*1.323;
      const sideBodyAxes=side>0?bodyBasis:bodyNorth;
      const light=berserk?0xff2434:t.direction===car && t.phase!=='recover'?0xf1e9c5:0xa06452;
      piece('bevel',nose+car*.209,1.71,side*.93,.10,.23,.34,RUBBER);
      piece('box',nose+car*.268,1.715,side*.93,.031,.142,.227,light,3);
      r.beam(at(nose+car*.213,2.02,side*.62),at(nose+car*.245,2.49,side*.30),.025,.028,RUBBER,4,_TR_DYN_OPTS);
      piece('box',c,2.914,z,8.74,.054,.067,EDGE);
      piece('box',c,1.108,z,8.71,.103,.052,EDGE);
      for (let pi=0;pi<3;pi++) {
        const dx=_TR_PANELS[pi][0], w=_TR_PANELS[pi][1];
        piece('bevel',c+dx,1.516,z,w,.80,.16,berserk?0x462930:SILVER);
        piece('box',c+dx,1.759,z+side*.087,w,.13,.017,stripe,berserk?3:2);
        piece('box',c+dx,1.655,z+side*.086,w,.041,.018,GOLD,2);
        piece('box',c+dx,2.841,z,w,.10,.145,SILVER);
        piece('box',c+dx,1.969,z,w,.10,.145,SILVER);
        for (let ei=0;ei<2;ei++) piece('box',c+dx+_TR_SIGNS[ei]*(w*.5-.06),2.403,z,.12,.83,.145,SILVER);
        drawTrainWindow(r,t,seatWindowId(side,c+dx),at(c+dx,2.403,z+side*.143),w-.20,.74,WINDOW,sideBodyAxes);
        if (w>2) piece('box',c+dx,2.402,z+side*.170,.057,.637,.029,EDGE);
      }
      const door=side===line.doorSide?t.doorOpen:0;
      for (let di=0;di<2;di++) {
        const doorX=c+DOORS[di];
        piece('box',doorX,2.790,z,.991,.234,.17,EDGE);
        piece('box',doorX,1.019,z+side*.08,1.13,.066,.39,STEEL);
        if (door>.05) piece('box',doorX,.979,z+side*(.20+door*.16),1.07,.061,.43+door*.23,0x94a19a);
        for (let li=0;li<2;li++) {
          const leaf=_TR_SIGNS[li];
          piece('box',doorX+leaf*.609,1.934,z-side*.043,.283,1.781,.158,SILVER);
          piece('box',doorX+leaf*.466,1.927,z-side*.014,.048,1.76,.144,RUBBER);
          const x=doorX+leaf*(.225+door*.377);
          piece('bevel',x,1.50,z+side*.012,.449,.91,.122,0xa4b9b0);
          piece('bevel',x,2.660,z+side*.012,.449,.14,.122,0xa4b9b0);
          for (let ei=0;ei<2;ei++) piece('box',x+_TR_SIGNS[ei]*.183,2.296,z+side*.012,.083,.70,.122,0xa4b9b0);
          drawTrainWindow(r,t,doorWindowId(side,doorX,leaf),at(x,2.298,z+side*.121),.277,.64,0x60837f,sideBodyAxes);
          piece('box',x,1.68,z+side*.081,.441,.123,.028,stripe,2);
        }
      }
      sideSign(line.integrity?'B1 METRO':'NORTH EXPRESS',c,1.397,z+side*.092,2.31,.223,0x435e58,side>0?basis:north);
    }
    for (let bi=0;bi<2;bi++) {
      const dx=BOGIE_CENTERS[bi];
      piece('bevel',c+dx,3.442,0,1.37,.273,1.50,0x7a8a82);
      piece('box',c+dx,3.578,0,1.21,.054,1.33,ROOF);
      for (let k=-2;k<=2;k++) piece('box',c+dx+k*.18,3.612,0,.065,.014,1.02,FRAME);
      piece('bevel',c+dx,.604,0,1.66,.369,2.08,FRAME);
      for (let si=0;si<2;si++) {
        const x=c+dx+_TR_SHIFTS[si];
        piece('cylinder',x,.374,0,.122,2.01,.122,STEEL,4,axle);
        for (let sj=0;sj<2;sj++) {
          const side=_TR_SIGNS[sj], z=side*line.gauge;
          piece('cylinder',x,.371,z,.748,.151,.748,0x484f4d,4,axle);
          piece('cylinder',x,.371,z-side*.075,.818,.048,.818,0x535d57,4,axle);
          piece('cylinder',x,.371,z+side*.092,.419,.051,.419,STEEL,4,axle);
          piece('cylinder',x,.609,z-side*.12,.197,.197,.197,0x697874);
          for (let spI=0;spI<3;spI++) piece('cylinder',x,.612+_TR_SPRINGS[spI],z-side*.12,.212,.023,.212,0x9ba59a);
        }
      }
    }
    piece('box',c,.665,0,2.31,.279,1.58,0x697970);
    piece('box',c+.94,3.404,-.80,.115,.44,.107,FRAME);
    piece('box',c-.89,.655,.767,.43,.22,.102,RUST);
  }
  piece('bevel',0,1.856,0,.47,1.73,1.86,RUBBER);
  for (let i=0;i<3;i++) piece('box',_TR_COUPLERS[i],1.84,0,.079,1.69,1.92,FRAME);
  piece('box',0,.857,0,.67,.177,.385,STEEL);

  for (const mark of t.marks) {
    const normal=rotate(...mark.normal);
    const ref=Math.abs(normal[1])>.85?[0,0,1]:[0,1,0];
    const x=unit(cross(ref,normal)), y=cross(normal,x);
    const center=rawAt(...mark.point), tint=TEAM_INK[mark.team] ?? 0xa179ae;
    if (mark.rim) {
      for (let i=0;i<mark.rim.length;i++) {
        const u=sub(rawAt(...mark.rim[i]),center), v=sub(rawAt(...mark.rim[(i+1)%mark.rim.length]),center);
        if (Math.hypot(...cross(u,v))>.000002) r.add('tri',...center,1,1,1,tint,26,{dynamic:true,basis:[u,v,normal]});
      }
    } else {
      r.add('splat',...center,mark.size,mark.size*.79,1,tint,26,{dynamic:true,basis:[x,y,normal]});
    }
  }

  if (t.wetness>.16 && t.speed>.7) {
    for (let i=0;i<7;i++) {
      const dx=((i*2.72+clock*t.speed)%16)-8, side=i%2?1:-1;
      const height=.14+Math.sin(clock*13+i)**2*.38;
      piece('orb',dx,height,side*(line.gauge+.26+height*.45),.07,.11,.14,t.inkColor,9);
    }
  }
}
