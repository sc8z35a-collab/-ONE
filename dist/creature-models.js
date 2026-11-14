import {add,cross,scale,sub,unit} from './render.js';

export function drawTentacle(r,points,width,tint,sucker) {
  for (let i=1;i<points.length;i++) {
    const from=points[i-1],to=points[i],axis=unit(sub(to,from));
    const ref=Math.abs(axis[1])>.94?[1,0,0]:[0,1,0];
    const side=unit(cross(axis,ref)),face=cross(side,axis);
    const girth=width*(1-.76*i/(points.length-1));
    const middle=scale(add(from,to),.5), span=Math.hypot(...sub(to,from));
    r.add('taper',...middle,girth,span+girth*.12,girth*.90,tint,9,
      {dynamic:true,basis:[side,axis,face]});
    r.add('orb',...from,girth*1.12,girth*.98,girth*1.02,tint,9,{dynamic:true});
    if (!r.lite || i%2===0) {
      const p=add(middle,[0,-girth*.42,0]), size=girth*.53;
      r.add('cylinder',...p,size,.028,size,sucker,2,{dynamic:true});
      if (!r.lite) r.add('cylinder',p[0],p[1]-.017,p[2],size*.44,.008,size*.44,tint,2,{dynamic:true});
    }
  }
}
