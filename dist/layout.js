export const BOUNDS=[53.5,35];
export const CITY_RADIUS=500;
export const inCity=(x,z,margin=0)=>Math.hypot(x,z)<=CITY_RADIUS-margin;
export function cityExit(from,to,margin=0) {
  const radius=CITY_RADIUS-margin;
  const x=from[0],z=from[2],dx=to[0]-x,dz=to[2]-z;
  const c=x*x+z*z-radius*radius;
  if (c>0) return x*dx+z*dz<0 && inCity(to[0],to[2],margin)?null:0;
  if (inCity(to[0],to[2],margin)) return null;
  const a=dx*dx+dz*dz, b=x*dx+z*dz;
  return Math.max(0,Math.min(1,(-b+Math.sqrt(Math.max(0,b*b-a*c)))/a));
}
export const SCENE_VERSION=16;
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
export const RAIL={
  name:'高架線',cabinX:RAIL_CABIN_X,cabinLayer:RAIL_CABIN_LAYER,center:0,x:41,z:-28.65,platformZ:-24.45,platformY:6.23,y:5.25,
  edge:54.5,halfWidth:1.81,gauge:.93,dwell:7.5,doorSide:1,layer:TRACK_LAYER
};
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
