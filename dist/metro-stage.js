import {CABIN_BOUNDS,CABIN_Y,METRO,UNDER_Y,railEnd,stationAt} from './layout.js';
import {buildRailConnection} from './levels.js';
import {TRAIN_DOORS} from './train-model.js';
import {doorWindowId,drawTrainWindow,seatWindowId} from './train-glass.js';

const IVORY=0xd5d8c6, TRIM=0x687b79, MINT=0x789b91, WINE=0x7a5464, YELLOW=0xe5bd72;
const [HALF_LENGTH,HALF_WIDTH]=CABIN_BOUNDS;

export function buildMetro(world) {
  const r=world.r, {center,x,z,y,platformY,platformZ,gauge,halfWidth,edge,layer}=METRO;
  const length=edge*2, platformHeight=platformY-UNDER_Y;
  for (const side of [-1,1]) {
    const station=center+side*x;
    world.deck(center+(side<0?-edge:x-9.4),center+(side<0?-x+9.4:edge),platformZ-2.19,platformZ+2.28,platformHeight,0xbcb8a6);
    const rampStart=center+(side<0?-x+9.4:x-16.5), rampEnd=center+(side<0?-x+16.5:x-9.4);
    world.ramp(rampStart,rampEnd,platformZ-2.04,platformZ+1.73,side<0?platformHeight:0,side<0?0:platformHeight,'x',0xaaa99b);
    r.add('box',station,platformY+.019,platformZ+1.96,17.85,.038,.25,YELLOW,0);
    for (let i=-16;i<=16;i++) {
      r.add('box',station+i*.52,platformY+.04,platformZ+1.94,.21,.021,.058,0xf6dca0,4);
    }
    r.add('box',station,platformY+2.86,platformZ,17.8,.17,3.53,TRIM,4);
    for (const dx of [-7.3,7.3]) world.solid(station+dx,platformY+1.39,platformZ-1.68,.24,2.78,.29,TRIM,4);
    for (const dx of [-5.45,-1.8,1.8,5.45]) r.add('box',station+dx,platformY+2.74,platformZ,2.55,.07,.19,0xf4e5c8,3);
    r.add('box',station,platformY+2.21,platformZ-1.71,5.15,.57,.17,WINE,2);
    r.label(stationAt(1,side).sign,station,platformY+2.21,platformZ-1.606,4.9,.48,IVORY);
    r.label(stationAt(1,side).sign,station,platformY+2.21,platformZ-1.807,4.9,.48,IVORY,Math.PI);
    for (const door of [-6.54,-2.64,2.64,6.54]) {
      r.add('box',station+door,platformY+.027,platformZ+1.79,1.08,.022,.28,0xf0dfb6,0);
      r.add('box',station+door,platformY+.040,platformZ+1.80,.065,.018,.38,WINE,0);
    }
    r.add('bevel',station+3.9,platformY+.38,platformZ-1.59,2.15,.26,.56,MINT,2);
    for (const dx of [3.06,4.72]) r.add('box',station+dx,platformY+.16,platformZ-1.59,.18,.32,.47,TRIM,4);
  }
  world.slabs.push({x0:center-edge,x1:center+edge,z0:z-halfWidth,z1:z+halfWidth,from:y,to:y,axis:'x',layer});
  r.add('box',center,y-.055,z,length,.11,halfWidth*2,0x8b8b7c,1,{layer});
  world.obstacle(center,y-.04,z,length,.08,halfWidth*2,true,layer);
  for (const dz of [-gauge,gauge]) {
    r.add('box',center,y-.025,z+dz,railEnd(METRO)*2,.053,.15,0x89958f,1,{layer});
    r.add('box',center,y-.065,z+dz,length,.045,.22,0x595e57,4);
  }
  for (let dx=-edge+.62;dx<edge;dx+=.83) r.add('box',center+dx,y-.071,z,.25,.061,2.63,0x686e62,1,{layer});
  for (let dx=-edge+4;dx<=edge-4;dx+=11) {
    r.add('box',center+dx,UNDER_Y+2.8,z+3.14,.42,5.60,.23,TRIM,4);
    r.add('box',center+dx,UNDER_Y+3.34,z+3.01,.15,.52,.098,0xf3e3ba,3);
  }
  r.add('box',center,UNDER_Y+2.31,z+3.19,length,.12,.061,WINE,2);
  buildRailConnection(world,METRO);
}

export function buildCabin(world,line) {
  const r=world.r, x=line.cabinX, y=CABIN_Y, layer=line.cabinLayer;
  const stripe=line.integrity?WINE:0x527d75;
  const part=(kind,px,py,pz,w,h,d,tint,material=4)=>r.add(kind,x+px,y+py,pz,w,h,d,tint,material);
  r.add('box',x,y-.122,0,HALF_LENGTH*2+.28,.24,HALF_WIDTH*2+.16,0x9c9d8c,1,{layer});
  r.add('box',x,y+.006,0,HALF_LENGTH*2,.009,HALF_WIDTH*2,0xb4b5a6,1,{layer});
  part('box',0,2.82,0,HALF_LENGTH*2+.3,.24,HALF_WIDTH*2+.31,IVORY,2);
  world.obstacle(x,y+2.82,0,HALF_LENGTH*2+.28,.24,HALF_WIDTH*2+.23);
  for (const side of [-1,1]) {
    world.solid(x+side*HALF_LENGTH,y+1.35,0,.18,2.7,HALF_WIDTH*2,IVORY,2);
    part('bevel',side*(HALF_LENGTH-.12),1.45,0,.21,1.96,1.24,TRIM,4);
    part('box',side*(HALF_LENGTH-.24),1.45,0,.034,1.53,.95,MINT,2);
    part('box',side*(HALF_LENGTH-.21),2.49,0,.096,.23,1.26,IVORY,4);
    r.label(side>0?'CAR 02':'CAR 01',x+side*(HALF_LENGTH-.263),y+2.49,0,1.15,.19,WINE,-side*Math.PI/2);
    world.obstacle(x,y+1.35,side*(HALF_WIDTH+.05),HALF_LENGTH*2+.16,2.7,.24);
    part('box',0,.48,side*HALF_WIDTH,HALF_LENGTH*2,.94,.165,IVORY,2);
    part('box',0,2.495,side*HALF_WIDTH,HALF_LENGTH*2,.405,.17,IVORY,2);
    part('box',0,.923,side*(HALF_WIDTH-.087),HALF_LENGTH*2,.081,.062,stripe,2);
    r.beam([x-HALF_LENGTH+.28,y+2.24,side*1.01],[x+HALF_LENGTH-.28,y+2.24,side*1.01],.047,.047,TRIM,4);
    for (const px of [-8.52,-7.37,-5.71,-3.50,-1.72,0,1.72,3.50,5.71,7.37,8.52]) {
      part('box',px,1.61,side*HALF_WIDTH,.155,1.35,.207,IVORY,2);
      part('box',px,2.14,side*(HALF_WIDTH-.095),.38,.12,.11,TRIM);
    }
    for (const px of [-6.54,-2.64,2.64,6.54])
      r.label('EXIT',x+px,y+2.45,side*(HALF_WIDTH-.196),.76,.16,stripe,side<0?0:Math.PI);
    for (const px of [-8.04,-4.60,-.89,.89,4.60,8.04]) {
      part('bevel',px,.47,side*(HALF_WIDTH-.44),1.35,.19,.62,MINT,18);
      part('bevel',px,.78,side*(HALF_WIDTH-.15),1.36,.58,.23,0x819d92,18);
      for (const dx of [-.63,.63]) part('box',px+dx,.60,side*(HALF_WIDTH-.41),.055,.32,.53,TRIM);
      for (const seam of [-.42,0,.42]) part('box',px+seam,.575,side*(HALF_WIDTH-.37),.023,.017,.48,0xa4bcb0,2);
      world.obstacle(x+px,y+.52,side*(HALF_WIDTH-.31),1.33,1.04,.66);
    }
    for (const px of [-7.9,-5.2,-1.4,1.4,5.2,7.9]) {
      part('box',px,2.67,side*.68,1.72,.055,.21,0xffedd0,3);
      part('box',px,2.595,side*1.14,.87,.045,.43,TRIM);
      for (const dx of [-.33,.33]) part('box',px+dx,2.37,side*1.14,.036,.31,.045,TRIM);
    }
  }
  for (const px of [-3.55,3.55]) for (const side of [-1,1]) {
    part('cylinder',px,1.33,side*(HALF_WIDTH-.44),.065,2.67,.065,TRIM);
    world.obstacle(x+px,y+1.33,side*(HALF_WIDTH-.44),.075,2.67,.075);
  }
  for (const dx of [-.16,0,.16]) r.add('box',x+dx,y+.013,0,.067,.006,HALF_WIDTH*2-.08,TRIM,22,{layer});
  for (const side of [-1,1]) for (const px of [-8,-4.6,-.9,.9,4.6,8]) {
    for (const step of [-.32,.32]) {
      const sx=x+px+step, z=side*.79;
      r.beam([sx,y+2.23,z],[sx,y+1.93,z],.025,.025,0x6d7f79,4);
      r.add('ring',sx,y+1.86,z,.16,.11,.16,0xe9e4cf,20,
        {basis:[[1,0,0],[0,0,side],[0,-side,0]]});
    }
  }
}

const cabinGlassBasis=side=>[[-side,0,0],[0,1,0],[0,0,-side]];

export function drawCabinWindows(r,rail) {
  for (const side of [-1,1]) for (const [center,outer,width] of [
    [-8.04,-7.99,1.24],[-4.60,-4.59,2.06],[-.89,-1.19,1.24],[.89,1.19,1.24],[4.60,4.59,2.06],[8.04,7.99,1.24]
  ]) {
    drawTrainWindow(r,rail.train,seatWindowId(side,outer),[rail.line.cabinX+center,CABIN_Y+1.64,side*HALF_WIDTH],
      width,1.22,0xaec4b7,cabinGlassBasis(side));
  }
}

export function drawCabinDoors(r,rail) {
  const t=rail.train, {cabinX,doorSide}=rail.line;
  for (const side of [-1,1]) for (const px of TRAIN_DOORS) for (const leaf of [-1,1]) {
    const open=side===doorSide?t.doorOpen:0;
    const wx=cabinX+px+leaf*(.28+open*.58), z=side*(HALF_WIDTH-.086);
    r.add('bevel',wx,CABIN_Y+.58,z,.557,1.13,.153,MINT,2,{dynamic:true});
    r.add('bevel',wx,CABIN_Y+2.21,z,.557,.52,.153,MINT,2,{dynamic:true});
    r.add('box',wx-leaf*.21,CABIN_Y+1.55,z,.135,1.46,.16,TRIM,4,{dynamic:true});
    r.add('box',wx+leaf*.22,CABIN_Y+1.56,z,.088,1.38,.16,MINT,2,{dynamic:true});
    r.add('box',cabinX+px+leaf*(.011+open*.58),CABIN_Y+1.34,z,.025,2.55,.17,0x3e514d,4,{dynamic:true});
    drawTrainWindow(r,t,doorWindowId(side,px,leaf),[wx,CABIN_Y+1.68,z],.32,.68,0xc7e2dc,cabinGlassBasis(side));
  }
}

export function drawCabinScenery(r,rail) {
  const t=rail.train, {x,cabinX,doorSide}=rail.line;
  const underground=rail.metro || !!rail.connection, outside=underground?0x949d8d:0xaac1c0;
  const stationTint=rail.metro?WINE:0x527d75;
  const spacing=2.56, travel=rail.sceneryX(spacing);
  const offset=((travel%spacing)+spacing)%spacing;
  drawCabinDoors(r,rail);
  drawCabinWindows(r,rail);
  for (const side of [-1,1]) {
    const z=side*3.18;
    r.add('box',cabinX,CABIN_Y+1.45,z,25,3.82,.32,outside,underground?13:11,{dynamic:true});
    for (let i=-4;i<=5;i++) {
      const wx=cabinX+i*spacing-offset;
      r.add('box',wx,CABIN_Y+1.55,z-side*.21,.28,3.05,.18,0x526b68,4,{dynamic:true});
      if (underground) r.add('box',wx+.49,CABIN_Y+1.88,z-side*.21,.43,.13,.058,0xf3ddae,3,{dynamic:true});
      else r.add('box',wx+.61,CABIN_Y+1.73,z-side*.232,1.05,.71,.048,0x78979e,8,{dynamic:true});
    }
    if (side!==doorSide) continue;
    for (const station of [-1,1]) {
      const dx=station*x-t.x;
      if (Math.abs(dx)>19) continue;
      r.add('box',cabinX+dx,CABIN_Y+.72,z-side*.39,14.95,1.30,.22,0x9ea596,2,{dynamic:true});
      r.add('box',cabinX+dx,CABIN_Y+1.74,z-side*.52,4.5,.45,.12,stationTint,2,{dynamic:true});
      r.label(stationAt(rail.section,station).sign,cabinX+dx,CABIN_Y+1.74,z-side*.598,4.35,.38,IVORY,
        side<0?0:Math.PI,0,{dynamic:true});
    }
  }
}
