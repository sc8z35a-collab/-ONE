// The edge of the city: a ring of facade-only buildings standing on the
// boundary of the walkable street (layout.js ENCLOSURE). Each building is one
// thin slab whose street side carries a facade (an apartment front from the
// drawn sheet, or an office front with windows); there is nothing behind it.
// The boundary itself stops bodies and rays, so climbing a wall never leads out.
import {ENCLOSURE} from './layout.js';
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

// Splits every run into building fronts of varied width and height.
export function enclosureFronts() {
  const R=randomGenerator(70417), fronts=[];
  for (const run of enclosureRuns()) {
    const length=Math.hypot(run.b[0]-run.a[0],run.b[1]-run.a[1]);
    const dir=[(run.b[0]-run.a[0])/length,(run.b[1]-run.a[1])/length];
    let at=0;
    while (at<length-.01) {
      let width=Math.min(9+R()*9,length-at);
      if (length-at-width<5) width=length-at;
      const mid=at+width/2;
      const housing=R()<.6;
      fronts.push({
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
    // Ends overlap by the wall's thickness so the corners close.
    r.add('box',front.x,front.height/2,front.z,front.width+FACADE_DEPTH,front.height,FACADE_DEPTH,front.tint,
      front.housing?10:11,{yaw:front.yaw,...(front.housing && {label:front.style})});
  }
}
