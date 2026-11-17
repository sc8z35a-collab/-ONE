// The edge of the city: a ring of facade-only buildings standing on the
// boundary of the walkable street (layout.js ENCLOSURE). Each building is one
// thin slab whose street side carries a facade (an apartment front from the
// drawn sheet, or an office front with windows); there is nothing behind it.
// The boundary itself stops bodies and rays, so climbing a wall never leads out.
import {ENCLOSURE,LOOP_LENGTH,inCity,railPath} from './layout.js';
import {randomGenerator} from './world.js';

// Thickness of the wall of fronts.
export const FACADE_DEPTH=.5;
// The facade stands this far inside the boundary, so shots splat on it
// instead of stopping at the invisible edge just behind.
const FACADE_INSET=.1;
const OFFICE_TINTS=[0x9aadb3,0xb9c3c1,0xc8c3b3,0xa7b2b8,0xd2cbbb,0x8fa3ab,0xc1c9c4,0xb2a898];
const HOUSING_TINTS=[0xd2c2a7,0xb6ad99,0xc7c3b0,0xbcc5ae,0xd0cbbb,0xe2dbca,0xa76e59,0xadc0c1];

// The outline of the walkable area as wall runs: start, end and the inward
// normal (toward the street). Corners of the main ring and the lane's mouth
// split the south side in two.
export function enclosureRuns() {
  const [ring,lane]=ENCLOSURE;
  return [
    {a:[ring.x0,ring.z0],b:[ring.x1,ring.z0],n:[0,1]},
    {a:[ring.x1,ring.z0],b:[ring.x1,ring.z1],n:[-1,0]},
    {a:[ring.x1,ring.z1],b:[lane.x1,ring.z1],n:[0,-1]},
    {a:[lane.x1,ring.z1],b:[lane.x1,lane.z1],n:[-1,0],lane:true},
    {a:[lane.x1,lane.z1],b:[lane.x0,lane.z1],n:[0,-1],lane:true},
    {a:[lane.x0,lane.z1],b:[lane.x0,ring.z1],n:[1,0],lane:true},
    {a:[lane.x0,ring.z1],b:[ring.x0,ring.z1],n:[0,-1]},
    {a:[ring.x0,ring.z1],b:[ring.x0,ring.z0],n:[1,0]}
  ];
}

// Tunnel mouths where the elevated loop passes through the ring: its curves
// run beyond the wall, out of sight, and come back in.
export const PORTAL={width:6.4,height:10.2,depth:10};
export function loopCrossings() {
  const points=[];
  let before=null;
  for (let s=0;s<=LOOP_LENGTH;s+=.25) {
    const {x,z}=railPath(s), inside=inCity(x,z);
    if (before!==null && inside!==before) points.push([x,z]);
    before=inside;
  }
  return points;
}

// Splits every run into building fronts of varied width and height, leaving
// a tunnel mouth wherever the loop crosses the run.
export function enclosureFronts() {
  const R=randomGenerator(70417), fronts=[], crossings=loopCrossings();
  for (const run of enclosureRuns()) {
    const length=Math.hypot(run.b[0]-run.a[0],run.b[1]-run.a[1]);
    const dir=[(run.b[0]-run.a[0])/length,(run.b[1]-run.a[1])/length];
    const openings=crossings.map(([x,z])=>{
      const t=(x-run.a[0])*dir[0]+(z-run.a[1])*dir[1], off=Math.abs((x-run.a[0])*run.n[0]+(z-run.a[1])*run.n[1]);
      // Near a corner the opening slides to stay on its own run.
      return off<1.5 && t>0 && t<length?Math.min(Math.max(t-PORTAL.width/2,0),length-PORTAL.width):null;
    }).filter(t=>t!==null).sort((a,b)=>a-b);
    let at=0;
    while (at<length-.01) {
      // Up to the next opening the fronts never leave a sliver narrower than 5 m.
      const opening=openings.find(t=>t>=at-.01), gap=opening===undefined?Infinity:opening-at;
      let width=Math.min(9+R()*9,length-at), portal=false;
      if (gap<.01) {width=PORTAL.width;portal=true;}
      else if (gap<=18) width=gap;
      else if (Number.isFinite(gap)) width=Math.min(width,gap-5);
      else if (length-at-width<5) width=length-at;
      const mid=at+width/2;
      const housing=R()<.6;
      fronts.push({portal,
        x:run.a[0]+dir[0]*mid-run.n[0]*(FACADE_DEPTH/2-FACADE_INSET), z:run.a[1]+dir[1]*mid-run.n[1]*(FACADE_DEPTH/2-FACADE_INSET),
        width, height:run.lane?20+R()*8:16+R()*28, yaw:Math.atan2(run.n[0],run.n[1]), normal:run.n,
        housing, style:Math.floor(R()*7),
        tint:(housing?HOUSING_TINTS:OFFICE_TINTS)[Math.floor(R()*8)]
      });
      at+=width;
    }
  }
  return fronts;
}

export function buildEnclosure(world) {
  const r=world.r;
  for (const front of enclosureFronts()) {
    const opts={yaw:front.yaw,...(front.housing && {label:front.style})};
    if (!front.portal) {
      // Ends overlap by the wall's thickness so the corners close.
      r.add('box',front.x,front.height/2,front.z,front.width+FACADE_DEPTH,front.height,FACADE_DEPTH,front.tint,front.housing?10:11,opts);
      continue;
    }
    // A tunnel mouth: the front continues above the opening, and a short dark
    // tunnel hides the track beyond the wall.
    const {height:open,depth}=PORTAL, lintel=front.height-open;
    r.add('box',front.x,open+lintel/2,front.z,front.width+FACADE_DEPTH,lintel,FACADE_DEPTH,front.tint,front.housing?10:11,opts);
    const [nx,nz]=front.normal, along=[nz,-nx];
    const out=[front.x-nx*depth/2,front.z-nz*depth/2];
    for (const side of [-1,1]) {
      const sx=out[0]+along[0]*side*(front.width/2+.25), sz=out[1]+along[1]*side*(front.width/2+.25);
      r.add('box',sx,open/2,sz,.5,open,depth,0x33393b,2,{yaw:front.yaw,portal:true});
    }
    r.add('box',out[0],open+.25,out[1],front.width+1,.5,depth,0x2b3032,2,{yaw:front.yaw,portal:true});
    // A dark back wall: looking in, the tunnel fades to black instead of sky.
    r.add('box',front.x-nx*depth,open/2,front.z-nz*depth,front.width+1,open,.5,0x15191a,2,{yaw:front.yaw,portal:true});
  }
}
