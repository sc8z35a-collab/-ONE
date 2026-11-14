import {add,cross,scale,sub,unit} from './render.js';

export const WINDOW_CRACK=42;
export const WINDOW_BREAK=108;
export const seatWindowId=(side,x)=>'seat:'+side+':'+Math.round(x*10);
export const doorWindowId=(side,x,leaf)=>'door:'+side+':'+Math.round(x*100)+':'+leaf;

const CRACKS=[
  [[-.39,.28],[-.25,.11],[-.12,.035],[-.04,-.03],[.04,.07],[.22,.19],[.37,.44]],
  [[-.04,-.03],[-.12,-.23],[-.29,-.44]],
  [[-.04,-.03],[.12,-.10],[.25,-.065],[.47,-.24]],
  [[.04,.07],[.032,.24],[-.08,.44]],
  [[-.25,.11],[-.38,.01],[-.49,.045]],
  [[.12,-.10],[.17,-.26],[.14,-.47]],
  [[.22,.19],[.34,.13],[.46,.16]]
];

export function drawTrainWindow(r,t,id,center,width,height,tint,basis) {
  const stress=t.windows?.[id]??0, opts={dynamic:true,basis};
  const [u,v,n]=basis;
  const at=(x,y,z=.009)=>add(center,add(scale(u,x*width),add(scale(v,y*height),scale(n,z))));
  if (stress<WINDOW_BREAK) {
    r.add('glass',...center,width,height,1,tint,17,{...opts,windowId:id});
  }
  if (stress<WINDOW_CRACK) return;
  const side=id.length%2?1:-1;
  if (stress>=WINDOW_BREAK) {
    for (const [x,y,w,h] of [[-.49,.33,.19,.15],[.30,.49,.14,.17],[.48,-.42,.15,.24],[-.41,-.49,.25,.13]]) {
      const a=at(x,y),b=at(x-Math.sign(x)*w,y),c=at(x,y-Math.sign(y)*h);
      const edge=b.map((value,i)=>value-a[i]), tip=c.map((value,i)=>value-a[i]);
      r.add('tri',...a,1,1,1,0xa4cac0,8,{dynamic:true,basis:[edge,tip,n]});
      r.add('tri',...a,1,1,1,0x7ea8a5,8,{dynamic:true,basis:[tip,edge,scale(n,-1)]});
    }
    return;
  }
  const visible=stress<72?4:CRACKS.length;
  for (const line of CRACKS.slice(0,visible)) {
    for (let i=1;i<line.length;i++) {
      const [x,y]=line[i-1], [nx,ny]=line[i];
      // Flat visual details leave the glass pane as the only collision surface.
      const a=at(x*side,y,.006),b=at(nx*side,ny,.006);
      const axis=unit(sub(b,a)), across=unit(cross(n,axis));
      const midpoint=scale(add(a,b),.5);
      r.add('quad',...midpoint,Math.hypot(...sub(b,a))+.013,.012,1,0xe2f5e9,3,{dynamic:true,basis:[axis,across,n]});
    }
  }
}
