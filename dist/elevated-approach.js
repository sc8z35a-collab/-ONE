// The ramp up to the elevated road. It runs south out of the ring of fronts
// through its own walled lane (layout.js ENCLOSURE).
const CREAM=0xe9debd;
const RAMP={x0:7.15,x1:14.65,z0:44.02,z1:95.5,high:12.83};
export const ELEVATED_APPROACH=Object.freeze(RAMP);

export function buildElevatedApproach(world) {
  const r=world.r,{x0,x1,z0,z1,high}=ELEVATED_APPROACH;
  const x=(x0+x1)/2,z=(z0+z1)/2,run=z1-z0,w=x1-x0;
  const angle=Math.atan2(high,run);
  world.elevated.push(ELEVATED_APPROACH);
  const yAt=at=>high*(z1-at)/run;
  r.add('box',x,high/2-.24,z,w,.46,Math.hypot(run,high),0x909b96,5,{pitch:angle});
  for (const side of [-1,1]) {
    const edge=x+side*(w*.5-.13);
    r.add('box',edge,high/2+.42,z,.26,.91,Math.hypot(run,high),0xb1b7ab,13,{pitch:angle});
    r.add('box',edge,high/2+.91,z,.19,.095,Math.hypot(run,high),0x658179,4,{pitch:angle});
    for (let at=z0+.9;at<z1-1;at+=2.4) {
      const h=yAt(at);
      world.obstacle(edge,h+.34,at,.26,.69,2.42,false);
    }
  }
  for (const at of [49,59,69,79,88]) {
    const y=yAt(at)-.47;
    world.solid(x,y/2,at,1.04,y,1.06,0xa8afa1,13);
    r.add('box',x,y-.10,at,w-.21,.32,1.15,0x7a8a82,4);
  }
  for (let at=47;at<94;at+=3.7) r.add('box',x,yAt(at)+.007,at,.115,.015,1.61,CREAM,22,{pitch:angle});
  r.add('box',x-4.78,1.50,96.2,.13,3,.13,0x7c8a7c,4);
  r.add('box',x-4.78,2.46,96.2,2.30,.51,.14,0x527d75,2);
  r.label('ROUTE 07',x-4.78,2.46,96.28,1.98,.34,CREAM);
}
