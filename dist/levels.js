import {LOOP_LENGTH,METRO,RAIL,RAIL_LOOP,TRACK_LAYER,UNDER_BOUNDS,UNDER_X,UNDER_Y,inCity,railEnd,railPath,stationAt} from './layout.js';

import {cutStairOpenings} from './stairs.js';
import {floorWeathering,wallWeathering} from './weathering.js';

const INK_CREAM=0xe7dfc5;
const FRAME=0x516967;

export function buildRail(world) {
  const r=world.r, {x,z,y:railY,platformY:y,platformZ,edge,halfWidth,gauge}=RAIL;
  const lo=platformZ-2.35, hi=platformZ+2.35;
  world.deck(-51,-32,lo,hi,y,0xa2b2a3);
  world.deck(32,51,lo,hi,y,0xa2b2a3);
  world.ramp(-32,-15,lo+.18,hi-.18,y,0,'x',0xc0c3b0);
  world.ramp(15,32,lo+.18,hi-.18,0,y,'x',0xc0c3b0);

  const width=RAIL_LOOP.half*2;
  r.add('box',0,railY-.45,z,width,.56,halfWidth*2,0x64736e,4);
  r.add('box',0,railY-.138,z,width+.04,.107,halfWidth*2-.06,0x83877a,1,{layer:TRACK_LAYER});
  world.obstacle(0,railY-.23,z,width,.46,halfWidth*2,true,TRACK_LAYER);
  for (const rz of [z-gauge,z+gauge]) {
    r.add('box',0,railY-.092,rz,width,.046,.18,0x65665c,4);
    r.add('box',0,railY-.054,rz,width,.063,.065,0x5d6057,4);
    r.add('box',0,railY-.023,rz,width,.042,.108,0x9caaa5,1,{layer:TRACK_LAYER});
  }
  for (let bx=-edge+.65;bx<edge;bx+=.78) {
    r.add('box',bx,railY-.124,z,.23,.105,2.61,0x8b897a,1,{layer:TRACK_LAYER});
    for (const rz of [z-gauge,z+gauge]) {
      r.add('box',bx,railY-.072,rz-.092,.143,.057,.053,0x60655b,4);
      r.add('box',bx,railY-.072,rz+.092,.143,.057,.053,0x60655b,4);
    }
  }
  for (let bx=-45;bx<=46;bx+=10) {
    world.solid(bx,2.25,z,1.01,4.5,.98,0x89958b,2);
    for (const dz of [-1,1]) r.beam([bx,railY-2.0,z],[bx,railY-.71,z+dz*1.55],.19,.23,0x7b8d85,4);
    r.add('box',bx,railY-.77,z,1.81,.26,3.38,0x687973,4);
  }
  buildRailLoop(world);
  for (const side of [-1,1]) {
    const bx=side*x;
    r.add('box',bx,y+2.62,platformZ,17.85,.20,4.60,0xb3c7be,8);
    for (const dx of [-7.8,7.8]) {
      world.solid(bx+dx,y+1.22,platformZ+1.77,.20,2.44,.20,FRAME,4);
      r.add('box',bx+dx,y+2.51,platformZ,.19,.23,4.6,FRAME,4);
    }
    world.rail([bx-8.95,y,platformZ+2.24],[bx+8.95,y,platformZ+2.24],FRAME,10);
    r.add('box',bx,y+.022,platformZ-1.89,17.85,.042,.18,0xd9b757,0);
    r.add('box',bx,y+2.22,platformZ+1.51,7.55,.42,.13,0x3d7169,2);
    r.label(stationAt(0,side).sign,bx,y+2.22,platformZ+1.582,7.3,.39,INK_CREAM);
    r.label(stationAt(0,side).sign,bx,y+2.22,platformZ+1.438,7.3,.39,INK_CREAM,Math.PI);
    for (const door of [-6.54,-2.64,2.64,6.54]) {
      r.add('box',bx+door,y+.027,platformZ-1.80,1.08,.022,.28,0xe7e1bd,0);
      r.add('box',bx+door,y+.040,platformZ-1.81,.065,.018,.38,0x3b7467,0);
    }
    for (const dx of [-3.7,3.7]) r.add('box',bx+dx,y+2.48,platformZ,.85,.042,.18,0xf1e8c9,3);
  }
}

// The rest of the loop beyond the station straight: deck, rails and sleepers
// in short straight pieces along the south side, on piers every ten metres.
// The curves lie beyond the ring of fronts, where nothing is built: the train
// leaves through tunnel mouths in the wall (enclosure.js) and comes back.
const LOOP_STEP=2.4;
export function buildRailLoop(world) {
  const r=world.r, {y:railY,halfWidth,gauge}=RAIL, start=RAIL_LOOP.half, end=LOOP_LENGTH-RAIL_LOOP.half;
  const pieces=Math.ceil((end-start)/LOOP_STEP), step=(end-start)/pieces;
  for (let i=0;i<pieces;i++) {
    const s=start+(i+.5)*step, {x,z,yaw}=railPath(s), along=[Math.cos(yaw),0,-Math.sin(yaw)], side=[Math.sin(yaw),0,Math.cos(yaw)];
    if (!inCity(x,z)) continue;
    const piece=(dx,dz)=>[x+along[0]*dx+side[0]*dz,z+along[2]*dx+side[2]*dz];
    r.add('box',x,railY-.45,z,step+.08,.56,halfWidth*2,0x64736e,4,{yaw});
    r.add('box',x,railY-.138,z,step+.1,.107,halfWidth*2-.06,0x83877a,1,{yaw});
    // A box around the rotated piece, so feet find the deck on the curves.
    const spanX=Math.abs(along[0])*step+Math.abs(side[0])*halfWidth*2, spanZ=Math.abs(along[2])*step+Math.abs(side[2])*halfWidth*2;
    world.obstacle(x,railY-.23,z,spanX,.46,spanZ,false);
    for (const dz of [-gauge,gauge]) {
      const [rx,rz]=piece(0,dz);
      r.add('box',rx,railY-.092,rz,step+.08,.046,.18,0x65665c,4,{yaw});
      r.add('box',rx,railY-.023,rz,step+.08,.042,.108,0x9caaa5,1,{yaw});
    }
    for (const dx of [-step*.25,step*.25]) {
      const [sx,sz]=piece(dx,0);
      r.add('box',sx,railY-.124,sz,.23,.105,2.61,0x8b897a,1,{yaw});
    }
    if (i%4===0) {
      world.solid(x,2.25,z,1.01,4.5,.98,0x89958b,2);
      r.add('box',x,railY-.77,z,1.81,.26,3.38,0x687973,4,{yaw});
    }
  }
}

export function buildRailConnection(world,line) {
  const r=world.r;
  for (const sign of [-1,1]) {
    const edge=line.center+sign*line.edge;
    const entrance=line.center+sign*(line.edge+.4), end=line.center+sign*railEnd(line);
    const length=Math.abs(end-entrance), middle=(entrance+end)*.5;
    const bedY=line.layer===TRACK_LAYER?line.y-.085:line.y;
    r.add('box',(edge+end)*.5,bedY-.18,line.z,Math.abs(end-edge),.36,4.52,0x788379,2);
    for (const side of [-1,1]) {
      r.add('box',middle,line.y+2.53,line.z+side*2.20,length,5.4,.25,0x909b90,13);
      r.add('box',entrance,line.y+2.54,line.z+side*2.22,.76,5.38,.46,0x687a74,4);
    }
    r.add('box',middle,line.y+5.18,line.z,length,.35,4.62,0x7e8b80,2);
    for (let offset=0;offset<length;offset+=3.1) {
      const x=entrance+sign*offset;
      r.add('box',x,line.y-.11,line.z,.24,.12,2.72,0x666f62,4);
      r.add('box',x,line.y+4.96,line.z,.24,.18,4.35,0x61746b,4);
      for (const side of [-1,1]) r.add('box',x,line.y+3.35,line.z+side*2.04,.52,.16,.045,0xf0e9cc,3);
    }
  }
}

export function buildUnderground(world) {
  const r=world.r;
  const [w,d]=UNDER_BOUNDS;
  const y=UNDER_Y, x=UNDER_X;
  r.add('box',x,y-.34,0,w*2+2,.68,d*2+2,0xa5a596,1,{layer:2});
  r.add('box',x,y-.055,0,w*2+.5,.112,13.4,0x7d8884,5,{layer:2});
  cutStairOpenings(r,x,-.72,0,w*2+2,.72,d*2+2,0x7a827b,2,x);
  for (const side of [-1,1]) {
    const wallX=x+side*(w+.35);
    const open0=METRO.z-2.58,open1=METRO.z+2.58,front=-d-1,back=d+1;
    world.solid(wallX,y+3.55,(front+open0)/2,.68,7.14,open0-front,0x85978c,2);
    world.solid(wallX,y+3.55,(open1+back)/2,.68,7.14,back-open1,0x85978c,2);
    world.solid(wallX,y+6.15,METRO.z,.68,1.94,5.16,0x85978c,2);
    world.solid(x,y+3.55,side*(d+.36),w*2+2,7.14,.7,0x90958a,13);
    for (const z of [side*19.2,side*25.4]) {
      r.add('box',x,y+6.87,z,w*2, .28,.25,0x7f8f89,4);
      r.beam([x-w,y+6.15,z],[x+w,y+6.15,z],.22,.23,0xa98762,4);
    }
    for (let px=-44;px<=44;px+=11) {
      const z=side*18;
      world.solid(x+px,y+3.45,z,.81,6.9,.81,0x829086,2);
      r.add('bevel',x+px,y+.20,z,1.21,.40,1.17,0xa2a899,2);
      r.add('box',x+px,y+1.49,z-side*.417,.7,.38,.023,0xbd9c5d,2);
      cutStairOpenings(r,x+px,y+6.83,z,.92,.25,24,0x7c8d83,4,x);
    }
  }
  wallWeathering(r,46,x-44,y+.43,-17.595,0,.72,1.0,0x829086);
  floorWeathering(r,47,x-25,y+.004,9,5.6,2.2,0xa5a596,2);
  floorWeathering(r,48,x+17,y+.004,16.9,5.3,2.5,0xa5a596,2);
  floorWeathering(r,49,x+32,y+.003,2.5,5.6,2.1,0x7d8884,2);
  floorWeathering(r,50,x+4,y+.004,16.8,5.3,2.7,0xa5a596,2);
  for (const z of [-39,-28,-10.5,0,10.5,28,39]) for (let px=-57.2;px<=58;px+=8.8) {
    r.add('box',x+px,y+6.52,z,2.47,.19,.42,0x697c72,4);
    r.add('box',x+px,y+6.396,z,2.21,.067,.23,0xffefd2,3);
    r.add('box',x+px,y+.015,z,1.77,.025,.058,0xb4a984,0);
  }
  world.deck(x-9,x+9,-7,7,1.52,0xb4b6a3);
  world.ramp(x-15,x-9,-3.5,3.5,0,1.52,'x',0xabb4a6);
  world.ramp(x+9,x+15,-3.5,3.5,1.52,0,'x',0xabb4a6);
  for (const side of [-1,1]) {
    world.rail([x-9,y+1.52,side*6.95],[x+9,y+1.52,side*6.95],FRAME,10);
    r.add('box',x,y+1.05,side*7.017,10.8,.43,.053,0x476e68,2);
    r.label('B1 EXCHANGE',x,y+1.06,side*7.051,8.8,.40,INK_CREAM,side===1?0:Math.PI);
  }
  for (const [dx,z,width,depth,tint] of [
    [-32,-17,6.2,3.3,0x62857e],[-21,-22,5.7,3.2,0x9c8468],[-6,-22,8.0,3.2,0x839891],
    [15,-15,7.3,4.2,0x71857a],[28,-23,5.2,3.1,0x9b8267],[36,-8,5.2,3.2,0xa3977a],
    [-35,8,5.2,2.7,0x9d8b72],[-26,18,7.3,3.3,0x678b83],[-10,20,5.9,4.1,0xa88c6a],
    [7,23,8.9,3.1,0x78988c],[19,15,5.4,4.2,0x92917b],[33,17,7.7,2.8,0x6e8c87]
  ]) {
    world.solid(x+dx,y+1.39,z,width,2.78,depth,tint,2);
    for (const s of [-1,1]) {
      for (let j=-width/2+.2;j<width/2-.14;j+=.36) r.add('box',x+dx+j,y+1.37,z+s*(depth/2+.027),.099,2.52,.077,tint,4);
      r.add('box',x+dx,y+2.69,z+s*(depth/2+.05),width+.05,.13,.14,tint,4);
      r.label('STORAGE',x+dx,y+1.56,z+s*(depth/2+.075),width*.64,.46,INK_CREAM,s>0?0:Math.PI);
    }
  }
  for (const [dx,z] of [[-32,5.6],[-17,-5.1],[-1,12.1],[12,-10.2],[27,5.4],[36,-16]]) {
    world.barrier(x+dx,z,3.15,.76,0xc0b698,y);
  }
  for (const [dx,z] of [[-32,-5],[32,4],[-2,-13],[0,15]]) {
    r.add('box',x+dx,y+5.4,z,5.58,.44,.17,0x456862,2);
    r.label('B1 EXCHANGE',x+dx,y+5.4,z+.095,5.3,.38,INK_CREAM);
    r.label('B1 EXCHANGE',x+dx,y+5.4,z-.095,5.3,.38,INK_CREAM,Math.PI);
  }
  // The new wings remain connected to the central hall and the station ramps.
  for (const side of [-1,1]) {
    const wx=x+side*56;
    world.deck(wx-4.2,wx+4.2,-38,-22,1.08,0xbac2ac);
    world.ramp(wx-3.8,wx+3.8,-22,-14,1.08,0,'z',0xb0b7a6);
    world.ramp(wx-3.8,wx+3.8,-45,-38,0,1.08,'z',0xb0b7a6);
    for (const z of [-38,-25,-3,18,31]) {
      world.solid(x+side*61.5,y+3.45,z,.72,6.9,.72,0x85978c,2);
      r.add('box',x+side*61.5,y+6.81,z,3.3,.25,.89,0x6f8479,4);
    }
    world.barrier(wx,5,4.6,.72,0xb4b59e,y);
    world.barrier(wx,26,4.6,.72,0xb4b59e,y);
    for (const dx of [-39,-13,13,39]) {
      const z=side<0?-42.9:30.6;
      world.solid(x+dx,y+1.19,z,6.7,2.38,2.5,side<0?0x829c8b:0x9c8c73,2);
      r.add('box',x+dx,y+2.51,z,7.15,.23,2.9,0xc6cbb6,2);
      r.add('box',x+dx,y+1.48,z-side*1.28,5.7,.76,.06,0x536d63,8);
      r.label(side<0?'MARKET':'METRO',x+dx,y+2.12,z-side*1.31,4.8,.32,INK_CREAM,side<0?0:Math.PI);
    }
  }
  for (const [dx,z] of [[-45,-33],[-25,-34],[0,-33],[25,-34],[45,-33],[-48,17],[48,15]]) {
    world.barrier(x+dx,z,3.35,.74,0xbcb8a0,y);
    r.add('box',x+dx,y+.018,z+1.15,3.9,.025,.09,0xcbbb87,0);
  }
  for (const z of [-31,26]) {
    r.add('box',x,y+5.32,z,9.2,.55,.18,0x456b62,2);
    r.label(z<0?'MARKET':'METRO',x,y+5.32,z+.103,7.9,.42,INK_CREAM);
    r.label(z<0?'MARKET':'METRO',x,y+5.32,z-.103,7.9,.42,INK_CREAM,Math.PI);
  }
}
