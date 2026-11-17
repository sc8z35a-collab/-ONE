export const BOUNDS=[53.5,35];
// The city ends at a ring of facade-only buildings drawn tight round the
// street (just behind both shop rows, a few metres past each end): one thin
// wall of building fronts with nothing at all beyond it. A narrow walled lane
// leads south out of the ring and carries the elevated road's approach.
export const ENCLOSURE=[{x0:-60,x1:60,z0:-41,z1:44.6},{x0:5.6,x1:16.2,z0:43,z1:97}];
// Far enough to reach past every corner of the ring.
export const CITY_RADIUS=140;
export const inCity=(x,z,margin=0)=>ENCLOSURE.some(b=>x>=b.x0+margin && x<=b.x1-margin && z>=b.z0+margin && z<=b.z1-margin);
// Fraction of from→to where the path leaves the city (null if it stays in).
export function cityExit(from,to,margin=0) {
  const inside=t=>inCity(from[0]+(to[0]-from[0])*t,from[2]+(to[2]-from[2])*t,margin);
  if (!inside(0)) return inside(1)?null:0;
  if (inside(1) && inside(.5)) return null;
  let lo=0, hi=inside(.5)?1:.5;
  for (let i=0;i<24;i++) {
    const mid=(lo+hi)/2;
    if (inside(mid)) lo=mid;
    else hi=mid;
  }
  return lo;
}
export const SCENE_VERSION=19;
export const SCENE_FILE=`scene-07-v${SCENE_VERSION}.json`;
export const UNDER_BOUNDS=[64,46];
export const CABIN_BOUNDS=[9.24,1.47];
export const UNDER_X=1280;
export const UNDER_Y=-8;
export const CABIN_X=2560;
export const RAIL_CABIN_X=3840;
export const CABIN_Y=-4;
export const TRACK_LAYER=4;
export const CABIN_LAYER=5;
export const RAIL_CABIN_LAYER=6;
export const PAINT_LAYERS=7;
export const INK_REGIONS=5;
export const BASE_TANK=150;
export const GIGA_TANK=BASE_TANK*2;
export const ZONES=[
  {x:0,y:0,bounds:BOUNDS,layer:0,name:'地上',inkMask:19},
  {x:UNDER_X,y:UNDER_Y,bounds:UNDER_BOUNDS,layer:2,name:'地下 B1',inkMask:12},
  {x:CABIN_X,y:CABIN_Y,bounds:CABIN_BOUNDS,layer:CABIN_LAYER,name:'地下鉄車内',inkMask:32},
  {x:RAIL_CABIN_X,y:CABIN_Y,bounds:CABIN_BOUNDS,layer:RAIL_CABIN_LAYER,name:'高架列車車内',inkMask:64}
];
// The elevated line is a closed loop: the north straight through both
// stations (x = -half … half at RAIL.z), a half circle at each end, and a
// return straight along the south side of the street (z = south).
export const RAIL_LOOP={half:55,south:42};
export const RAIL={
  name:'高架線',cabinX:RAIL_CABIN_X,cabinLayer:RAIL_CABIN_LAYER,center:0,x:41,z:-28.65,platformZ:-24.45,platformY:6.23,y:5.25,
  edge:54.5,halfWidth:1.81,gauge:.93,dwell:7.5,doorSide:1,layer:TRACK_LAYER,loop:RAIL_LOOP
};
const LOOP_RADIUS=(RAIL_LOOP.south-RAIL.z)/2, LOOP_MIDDLE=(RAIL_LOOP.south+RAIL.z)/2;
// Length of one lap, and the distance along the track (s) of a point: s = x
// on the north straight, growing eastward, round the east end, west along
// the south side and back round the west end.
export const LOOP_LENGTH=RAIL_LOOP.half*4+2*Math.PI*LOOP_RADIUS;
export const loopWrap=s=>((s+RAIL_LOOP.half)%LOOP_LENGTH+LOOP_LENGTH)%LOOP_LENGTH-RAIL_LOOP.half;
// Distance from a to b travelling forward round the loop.
export const loopAhead=(a,b)=>((b-a)%LOOP_LENGTH+LOOP_LENGTH)%LOOP_LENGTH;
// Track centre and heading at s. The heading is a yaw in the train's own
// convention: travel direction (cos yaw, 0, -sin yaw).
export function railPath(s) {
  const {half,south}=RAIL_LOOP, R=LOOP_RADIUS, arc=Math.PI*R;
  let d=loopWrap(s)+half;
  if (d<=2*half) return {x:d-half,z:RAIL.z,yaw:0};
  d-=2*half;
  if (d<=arc) {
    const t=d/R;
    return {x:half+R*Math.sin(t),z:LOOP_MIDDLE-R*Math.cos(t),yaw:-t};
  }
  d-=arc;
  if (d<=2*half) return {x:half-d,z:south,yaw:Math.PI};
  const t=(d-2*half)/R;
  return {x:-half-R*Math.sin(t),z:LOOP_MIDDLE+R*Math.cos(t),yaw:Math.PI-t};
}
export const METRO={
  name:'B1 地下鉄',cabinX:CABIN_X,cabinLayer:CABIN_LAYER,center:UNDER_X,x:46,z:41.73,platformZ:37.55,platformY:UNDER_Y+1.09,y:UNDER_Y+.105,
  edge:64,halfWidth:1.81,gauge:.93,dwell:12,doorSide:-1,layer:2,integrity:720
};
export const STATIONS=[
  {id:'G-W',number:1,name:'地上西駅',short:'地上西',sign:'01 GROUND WEST',level:0,side:-1},
  {id:'G-E',number:2,name:'地上東駅',short:'地上東',sign:'02 GROUND EAST',level:0,side:1},
  {id:'B-E',number:3,name:'地下東駅',short:'地下東',sign:'03 B1 EAST',level:1,side:1},
  {id:'B-W',number:4,name:'地下西駅',short:'地下西',sign:'04 B1 WEST',level:1,side:-1}
].map(stop=>{const line=stop.level?METRO:RAIL;return {...stop,x:line.center+stop.side*line.x,y:line.platformY,z:line.platformZ};});
export const stationAt=(level,side)=>STATIONS.find(stop=>stop.level===level && stop.side===side);
export const railEnd=line=>Math.max(line.x+33,line.edge+21);
export const zoneOf=x=>x>(RAIL_CABIN_X+CABIN_X)/2?3:x>(CABIN_X+UNDER_X)/2?2:x>UNDER_X/2?1:0;
export function interiorBlend(camera) {
  const zone=zoneOf(camera.eye[0]);
  if (camera.stair && zone<2) {
    const t=Math.max(0,Math.min(1,(.26-camera.eye[1])/3.05));
    return t*t*(3-2*t);
  }
  return zone===0?0:1;
}
export const isUnder=x=>zoneOf(x)===1;
export const isCabin=x=>zoneOf(x)>=2;
export const giantScale=x=>isCabin(x)?1.22:1.38;
export const giantHeight=x=>2.05*giantScale(x);
export const localX=x=>x-ZONES[zoneOf(x)].x;
export const floorBounds=x=>ZONES[zoneOf(x)].bounds;
export const sameLevel=(a,b)=>zoneOf(a)===zoneOf(b);
export const isLowerInk=layer=>layer===2 || layer===3;
export const inkOrigin=layer=>layer===RAIL_CABIN_LAYER?RAIL_CABIN_X:layer===CABIN_LAYER?CABIN_X:isLowerInk(layer)?UNDER_X:0;
export const inkY=layer=>layer>=CABIN_LAYER?CABIN_Y:isLowerInk(layer)?UNDER_Y:0;
export const inkRegion=layer=>layer===RAIL_CABIN_LAYER?4:layer===CABIN_LAYER?3:layer===TRACK_LAYER?2:isLowerInk(layer)?1:0;
