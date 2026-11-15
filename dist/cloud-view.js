import {add,clamp,forward,mix,scale} from './render.js';
import {CABIN_BOUNDS,isCabin,localX,zoneOf} from './layout.js';
import {STAIR_RUN,STAIR_VIEW_MARGIN,stairLane} from './stairs.js';

export const REST_PITCH=-.18;
const CAMERA_CLEARANCE=.21;

function ease(value) {
  const t=clamp(value,0,1);
  return t*t*(3-2*t);
}

export function crewView(battle,actor,{yaw=actor.yaw,pitch=actor.pitch,height=actor.y,reach=1,watch=false,x=actor.x,z=actor.z}={}) {
  const stair=stairLane(x,z,STAIR_VIEW_MARGIN);
  const cabin=isCabin(x);
  let enclosed=0;
  if (stair) {
    const progress=stair.level===0?stair.t:STAIR_RUN-stair.t;
    const across=Math.abs(z-stair.stair.z);
    enclosed=ease((progress+1.30)/1.62)*(1-ease((across-1.24)/1.51));
  }
  const direction=forward(yaw), side=[-direction[2],0,direction[0]];
  const pivot=[x,height+1.27,z];
  const low=[x,height+.39,z];
  const ceiling=battle.traceShot(low,pivot,true,false);
  if (ceiling?.normal[1]<-.35) pivot[1]=Math.max(low[1],ceiling.position[1]-CAMERA_CLEARANCE-.04);
  const back=mix(watch?4.49:3.74,2.18,enclosed);
  const offset=mix(watch?.76:.65,.42,enclosed);
  const up=mix(watch?1.42:1.08,.57,enclosed);
  const boom=add(scale(direction,-back),add(scale(side,offset),[0,up,0]));
  const length=Math.hypot(...boom);
  const hit=battle.traceShot(pivot,add(pivot,boom),true,false,CAMERA_CLEARANCE);
  const allowed=hit?clamp(hit.t-.09/length,0,1):1;
  let amount=Math.min(allowed,reach);
  if (cabin) {
    const [halfX,halfZ]=CABIN_BOUNDS;
    if (Math.abs(boom[0])>1e-6) amount=Math.min(amount,(halfX-.13-Math.sign(boom[0])*localX(x))/Math.abs(boom[0]));
    if (Math.abs(boom[2])>1e-6) amount=Math.min(amount,(halfZ-.13-Math.sign(boom[2])*z)/Math.abs(boom[2]));
    amount=Math.max(0,amount);
  }
  const eye=add(pivot,scale(boom,amount));
  return {eye,target:add(eye,scale(forward(yaw,pitch),17)),stair:!!stair,reach:amount,nearCrew:amount*length<.76};
}

export function aerialView(aspect) {
  const distance=Math.min(245,Math.max(94,116/aspect+10));
  return {eye:[0,distance*.9682,distance*.25],target:[0,1,0],overview:true};
}

// How far the player's own camera may sit from the server's and still be used
// for aiming. The device shows the player a step ahead of the server; taking
// its eye keeps a shot on the spot the reticle covered.
const EYE_TRUST=1.9;

export function serverCamera(battle,actor,input) {
  const pose=crewView(battle,actor,{yaw:input?.yaw,pitch:input?.pitch});
  const eye=input?.eye;
  if (!eye || zoneOf(eye[0])!==zoneOf(pose.eye[0]) ||
      Math.hypot(eye[0]-pose.eye[0],eye[1]-pose.eye[1],eye[2]-pose.eye[2])>EYE_TRUST ||
      battle.traceShot(pose.eye,eye,true)) return pose;
  return {...pose,eye,target:add(eye,scale(forward(input.yaw,input.pitch),17))};
}

export const AVATAR_FIELDS=['team','index','name','isPlayer','weapon','drone','ride','lift','x','y','z','yaw','pitch','vx','vy','vz',
  'steps','tank','tankMax','hp','maxHp','down','shield','recoil','damageAge','guard','giant','swimming','charge','superCharge',
  'superUntil','droneReady','rangeFactor','kills','downs','painted','cabinVisits','active','attack','inkSwimming','climbing','inkPenalty','intent','climbNormal','airborne','landing','rolling','subId','subReady','doorReady','muzzleBlocked',
  'slam','beaming','lastDamageAt','activeSpecial','bodyYaw','poseBank','feet','brace','peek','readyPose','flare',
  'dealt','supers','subs','revealUntil','revealTeam','downBy','clone','apartmentVisits'];
