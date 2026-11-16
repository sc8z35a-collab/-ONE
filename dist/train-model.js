import {RAIL,railPath} from './layout.js';
import {cross,dot,sub,unit} from './render.js';
import {TEAM_INK} from './world.js';
import {doorWindowId,drawTrainWindow,seatWindowId} from './train-glass.js';

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
  return {rotate,at,basis,local(point) {
    const offset=sub(point,origin);
    return basis.map(axis=>dot(axis,offset));
  }};
}

export function drawTrain(r,t,clock,line=RAIL) {
  const {rotate,at:rawAt,basis}=trainPose(t,line);
  const at=(x,y,z)=>y>.82?rawAt(x,1+(y-1)*1.44,z*1.18):rawAt(x,y,z);
  // Most pieces share a handful of axis sets, so each stretched set is built once per frame.
  const stretched=new Map();
  const bodyAxes=axes=>{
    let result=stretched.get(axes);
    if (!result) {
      result=axes.map(axis=>{
        const local=basis.map(vector=>dot(vector,axis));
        return rotate(local[0],local[1]*1.44,local[2]*1.18);
      });
      stretched.set(axes,result);
    }
    return result;
  };
  const stripe=line.cabinX===RAIL.cabinX?STRIPE:0x865768;
  const axle=[basis[0],basis[2],rotate(0,-1,0)];
  const front=[rotate(0,0,-1),basis[1],basis[0]];
  const rear=[basis[2],basis[1],rotate(-1,0,0)];
  const north=[rotate(-1,0,0),basis[1],rotate(0,0,-1)];
  function piece(kind,x,y,z,w,h,d,tint,material=4,axes=basis) {
    r.add(kind,...at(x,y,z),w,h,d,tint,material,{dynamic:true,basis:y>.82?bodyAxes(axes):axes});
  }
  const sideSign=(text,x,y,z,width,height,tint,axes=basis)=>
    r.label(text,...at(x,y,z),width,height,tint,0,0,{dynamic:true,basis:bodyAxes(axes)});
  for (const car of [-1,1]) {
    const c=CAR_CENTERS[car>0?1:0], nose=c+car*4.41, inner=c-car*4.31;
    piece('bevel',c,.907,0,8.77,.28,2.66,FRAME);
    piece('box',c,1.025,0,8.78,.11,2.61,0x8d9a93);
    for (const seat of [-3.45,0,3.45]) for (const side of [-1,1]) {
      piece('bevel',c+seat,1.344,side*.873,1.35,.132,.525,0x789b91,2);
      piece('bevel',c+seat,1.56,side*1.118,1.36,.403,.195,0x819d92,2);
    }
    for (const post of [-1.65,1.65]) piece('cylinder',c+post,1.99,.34,.039,1.8,.039,STEEL);
    piece('bevel',c,3.132,0,8.83,.50,2.72,ROOF);
    piece('box',c,2.881,0,8.78,.127,2.62,0xaab4aa);
    for (const side of [-1,1]) piece('box',inner,1.97,side*1.05,.16,1.94,.43,0xaebcb3);
    piece('box',inner,2.87,0,.16,.15,1.68,0xaebcb3);
    piece('bevel',nose-car*.18,1.43,0,.59,.93,2.63,SILVER);
    piece('bevel',nose-car*.18,2.94,0,.59,.18,2.63,SILVER);
    for (const side of [-1,1]) piece('bevel',nose-car*.18,2.34,side*1.18,.59,1.16,.27,SILVER);
    drawTrainWindow(r,t,'cab:'+car,at(nose+car*.157,2.37,0),2.10,.83,WINDOW,bodyAxes(car===1?front:rear));
    piece('box',nose+car*.203,2.44,0,.028,.64,.034,0x667774);
    piece('box',nose+car*.139,1.62,0,.09,.18,2.47,stripe);
    piece('bevel',nose+car*.116,1.09,0,.22,.22,2.56,EDGE);
    piece('box',nose+car*.223,.81,0,.24,.17,.42,RUBBER);
    sideSign(line.integrity?'B1 LOOP':'07 LOCAL',nose+car*.220,2.83,0,1.18,.21,0xeff2de,car===1?front:rear);
    for (const side of [-1,1]) {
      const z=side*1.323;
      const light=t.direction===car && t.phase!=='recover'?0xf1e9c5:0xa06452;
      piece('bevel',nose+car*.209,1.71,side*.93,.10,.23,.34,RUBBER);
      piece('box',nose+car*.268,1.715,side*.93,.031,.142,.227,light,3);
      r.beam(at(nose+car*.213,2.02,side*.62),at(nose+car*.245,2.49,side*.30),.025,.028,RUBBER,4,{dynamic:true});
      piece('box',c,2.914,z,8.74,.054,.067,EDGE);
      piece('box',c,1.108,z,8.71,.103,.052,EDGE);
      for (const [dx,w] of [[-3.40,1.34],[0,2.55],[3.40,1.34]]) {
        piece('bevel',c+dx,1.516,z,w,.80,.16,SILVER);
        piece('box',c+dx,1.759,z+side*.087,w,.13,.017,stripe,2);
        piece('box',c+dx,1.655,z+side*.086,w,.041,.018,GOLD,2);
        piece('box',c+dx,2.841,z,w,.10,.145,SILVER);
        piece('box',c+dx,1.969,z,w,.10,.145,SILVER);
        for (const edge of [-1,1]) piece('box',c+dx+edge*(w*.5-.06),2.403,z,.12,.83,.145,SILVER);
        drawTrainWindow(r,t,seatWindowId(side,c+dx),at(c+dx,2.403,z+side*.143),w-.20,.74,WINDOW,
          bodyAxes(side>0?basis:north));
        if (w>2) piece('box',c+dx,2.402,z+side*.170,.057,.637,.029,EDGE);
      }
      const door=side===line.doorSide?t.doorOpen:0;
      for (const dx of DOORS) {
        const doorX=c+dx;
        piece('box',doorX,2.790,z,.991,.234,.17,EDGE);
        piece('box',doorX,1.019,z+side*.08,1.13,.066,.39,STEEL);
        if (door>.05) piece('box',doorX,.979,z+side*(.20+door*.16),1.07,.061,.43+door*.23,0x94a19a);
        for (const leaf of [-1,1]) {
          piece('box',doorX+leaf*.609,1.934,z-side*.043,.283,1.781,.158,SILVER);
          piece('box',doorX+leaf*.466,1.927,z-side*.014,.048,1.76,.144,RUBBER);
          const x=doorX+leaf*(.225+door*.377);
          piece('bevel',x,1.50,z+side*.012,.449,.91,.122,0xa4b9b0);
          piece('bevel',x,2.660,z+side*.012,.449,.14,.122,0xa4b9b0);
          for (const edge of [-1,1]) piece('box',x+edge*.183,2.296,z+side*.012,.083,.70,.122,0xa4b9b0);
          drawTrainWindow(r,t,doorWindowId(side,doorX,leaf),at(x,2.298,z+side*.121),.277,.64,0x60837f,
            bodyAxes(side>0?basis:north));
          piece('box',x,1.68,z+side*.081,.441,.123,.028,stripe,2);
        }
      }
      sideSign(line.integrity?'B1 METRO':'NORTH EXPRESS',c,1.397,z+side*.092,2.31,.223,0x435e58,side>0?basis:north);
    }
    for (const dx of BOGIE_CENTERS) {
      piece('bevel',c+dx,3.442,0,1.37,.273,1.50,0x7a8a82);
      piece('box',c+dx,3.578,0,1.21,.054,1.33,ROOF);
      for (let k=-2;k<=2;k++) piece('box',c+dx+k*.18,3.612,0,.065,.014,1.02,FRAME);
      piece('bevel',c+dx,.604,0,1.66,.369,2.08,FRAME);
      for (const shift of [-.49,.49]) {
        const x=c+dx+shift;
        piece('cylinder',x,.374,0,.122,2.01,.122,STEEL,4,axle);
        for (const side of [-1,1]) {
          const z=side*line.gauge;
          piece('cylinder',x,.371,z,.748,.151,.748,0x484f4d,4,axle);
          piece('cylinder',x,.371,z-side*.075,.818,.048,.818,0x535d57,4,axle);
          piece('cylinder',x,.371,z+side*.092,.419,.051,.419,STEEL,4,axle);
          piece('cylinder',x,.609,z-side*.12,.197,.197,.197,0x697874);
          for (const spring of [-.059,0,.059]) piece('cylinder',x,.612+spring,z-side*.12,.212,.023,.212,0x9ba59a);
        }
      }
    }
    piece('box',c,.665,0,2.31,.279,1.58,0x697970);
    piece('box',c+.94,3.404,-.80,.115,.44,.107,FRAME);
    piece('box',c-.89,.655,.767,.43,.22,.102,RUST);
  }
  piece('bevel',0,1.856,0,.47,1.73,1.86,RUBBER);
  for (const x of [-.153,0,.153]) piece('box',x,1.84,0,.079,1.69,1.92,FRAME);
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
