import {Battle} from '../dist/battle.js';
import {serverCamera} from '../dist/cloud-view.js';
import {Paint} from '../dist/ink.js';
import {CLOUD_PROTOCOL,INK_SIZE,paintPackets} from '../dist/ink-wire.js';
import {ZONES,zoneOf} from '../dist/layout.js';
import {TAU,clamp,forward} from '../dist/render.js';
import {STAIR_VIEW_MARGIN,stairLane} from '../dist/stairs.js';
import {World} from '../dist/world.js';
import {checkpointOf,restoreCheckpoint} from './checkpoint.js';
import {frameOf,packFrame} from './frame.js';

export {STORAGE_KEYS} from './checkpoint.js';
export const HZ=24;
// One state frame per simulation step. A frame is small (only what changed),
// so the link carries 24 of them a second; ink tiles keep their own slower pace.
const STEP=1/HZ, FRAME_MS=1000/HZ-6, INK_MS=80, CHECKPOINT_PERIOD=18;
const INPUT_LEASE_MS=450, IDLE_ROOM_MS=8000;
const LIVE_WORLD_INK=ZONES[0].inkMask | ZONES[1].inkMask;
const taps=['jump','press','super','drone','use','cycle','sub'];
let world, paintLayout;

function createField() {
  const paint=new Paint(INK_SIZE);
  if (!world) {
    world=new World({zone:0,add(){},label(){},beam(){},seal(){}});
    paint.setWorld(world);
    const {mask,surface,bed,floorByte,total,zoneTotal,stairCells,stairEdges,stairTiles,barrierX,barrierZ,barrierWorld}=paint;
    paintLayout={mask,surface,bed,floorByte,total,zoneTotal,stairCells,stairEdges,stairTiles,barrierX,barrierZ,barrierWorld};
  } else Object.assign(paint,paintLayout);
  paint.netDirty=new Set();
  paint.netTiles=new Set();
  paint.netSent=new Uint16Array(paint.layerSize*paint.layers);
  return paint;
}

function decode(text) {
  if (typeof text!=='string' || text.length>1024) return null;
  try {
    const a=JSON.parse(text);
    if (a.type!=='input' || !Number.isSafeInteger(a.seq) || a.seq<1) return null;
    if (![a.x,a.z,a.yaw,a.pitch].every(Number.isFinite)) return null;
    return {
      seq:a.seq,x:clamp(a.x,-1,1),z:clamp(a.z,-1,1),yaw:a.yaw%TAU,pitch:clamp(a.pitch,-.86,.70),
      paused:a.paused===true,fire:a.fire===true,swim:a.swim===true,overview:a.overview!==false,
      loadout:typeof a.loadout?.weapon==='string' && typeof a.loadout?.sub==='string'?a.loadout:null,
      eye:Array.isArray(a.eye) && a.eye.length===3 && a.eye.every(Number.isFinite)?a.eye:null,
      ...Object.fromEntries(taps.map(key=>[key,a[key]===true]))
    };
  } catch { return null; }
}

export class RoomEngine {
  constructor(options, stored=new Map()) {
    const paint=createField();
    this.sounds=[];
    this.battle=new Battle(world,paint,options.mode,{sound:key=>{
      if (this.sounds.length<10) this.sounds.push(key);
    }},options);
    restoreCheckpoint(this.battle,stored);
    this.savedAt=this.battle.elapsed;
    this.resetLink();
  }

  resetLink() {
    this.battle.clearPlayerInput();
    this.running=false;
    this.inputAt=-Infinity;
    this.stepAt=null;
    this.tick=0;
    this.intent=null;
    this.lock=null;
    this.lastFrame=-Infinity;
    this.lastInk=-Infinity;
    this.link={};
    this.remainder=0;
    this.lastSeq=0;
    this.appliedSeq=0;
    this.zone=-1;
    this.inkMask=0;
    this.overview=this.battle.mode==='watch';
    this.paused=false;
    this.violations=0;
    this.pending={};
  }

  hello() {
    return JSON.stringify({type:'hello',protocol:CLOUD_PROTOCOL,ink:INK_SIZE,tick:HZ});
  }

  frames(now, force=false,urgent=false) {
    const b=this.battle, focus=this.overview?null:b.cameraActor(), zone=focus?zoneOf(focus.x):0;
    const mergeStairs=zone<2 && !!focus && !!stairLane(focus.x,focus.z,STAIR_VIEW_MARGIN);
    const localMask=ZONES[zone].inkMask | (mergeStairs?ZONES[1-zone].inkMask:0);
    const mask=localMask | LIVE_WORLD_INK;
    const fullMask=force?mask:mask & ~this.inkMask;
    const moved=this.zone!==zone;
    if (!fullMask && !moved && !urgent && now-this.lastFrame<FRAME_MS) return [];
    this.lastFrame=now;
    this.zone=zone;
    this.inkMask=mask;
    const ink=[];
    if (fullMask) ink.push(...paintPackets(b.paint,fullMask,true,focus));
    if (force || urgent || moved || b.finished || now-this.lastInk>=INK_MS) {
      this.lastInk=now;
      const changes=mask & ~fullMask, nearby=changes & localMask, remote=changes & ~localMask;
      if (nearby) ink.push(...paintPackets(b.paint,nearby,false,focus));
      if (remote) ink.push(...paintPackets(b.paint,remote));
    }
    const frame=packFrame(b,frameOf(b,zone,fullMask,this.sounds.splice(0),mergeStairs),this.link,force);
    return [JSON.stringify({...frame,tick:this.tick,inputAck:this.appliedSeq,lock:this.lockView(),inkPackets:ink.length}),...ink];
  }

  suspend({pause=false}={}) {
    this.running=false;
    this.paused=pause;
    this.stepAt=null;
    this.remainder=0;
    this.pending={};
    this.intent=null;
    this.lock=null;
    this.battle.clearPlayerInput();
  }

  neutral(command) {
    return {x:0,z:0,yaw:command.yaw,pitch:command.pitch,swim:false,fire:false,overview:command.overview};
  }

  advance(now) {
    if (!this.running) return;
    const b=this.battle;
    if (now-this.inputAt>=INPUT_LEASE_MS && this.intent.seq) {
      this.intent=this.neutral(this.intent);
      b.clearPlayerInput();
      this.pending={};
    }
    this.remainder+=Math.max(0,Math.min((now-this.stepAt)/1000,STEP*4));
    this.stepAt=Math.max(this.stepAt,now);
    let count=0;
    while (!b.finished && this.remainder+1e-8>=STEP && count<4) {
      const input={...this.intent,...this.pending};
      this.pending={};
      if (b.mode==='watch' && !this.overview && input.cycle) b.cycle();
      b.update(STEP,input,()=>serverCamera(b,b.player,input));
      if (this.intent.seq) this.appliedSeq=this.intent.seq;
      this.remainder=Math.max(0,this.remainder-STEP);
      this.tick++;
      count++;
    }
    if (count) this.updateLock(this.intent);
  }

  updateLock(input) {
    const b=this.battle,a=b.player;
    if (!input.seq || !a || a.down>0 || a.swimming || a.ride || a.lift || b.countdown>0) {this.lock=null;return;}
    const {eye}=serverCamera(b,a,input), dir=forward(input.yaw,input.pitch);
    const hit=b.focusTarget(eye,dir,a.team,a.weapon.range*a.rangeFactor+4);
    if (hit) {
      const {actor,point}=hit,shift=hit.shift??0;
      this.lock={actor,shift,until:b.clock+.285,yaw:input.yaw,pitch:input.pitch,direct:true,
        offset:[point[0]+shift-actor.x,point[1]-actor.y,point[2]-actor.z]};
      return;
    }
    const prior=this.lock, target=prior?.actor;
    if (!target || b.clock>prior.until || target.down>0 || target.shield>0 || target.ride || target.lift ||
        (target.isBoss || target.isRaider) && !target.active || target.isRaider && !b.raiders.members.includes(target) ||
        zoneOf(target.x-prior.shift)!==zoneOf(eye[0])) {
      this.lock=null;
      return;
    }
    const at=[target.x-prior.shift+prior.offset[0],target.y+prior.offset[1],target.z+prior.offset[2]];
    if (b.traceShot(eye,at,true)?.t<.986 || b.subweapons.block(eye,at,a.team)?.t<.986) this.lock=null;
    else this.lock.direct=false;
  }

  lockView() {
    if (!this.lock) return null;
    const {actor,shift,yaw,pitch,direct,offset}=this.lock;
    const type=actor.isBoss?'boss':actor.isRaider?'raider':'crew';
    const index=actor.isRaider?actor.index:this.battle.actors.indexOf(actor);
    return {type,index,shift,yaw,pitch,direct,offset};
  }

  emit(now,urgent=false) {
    const b=this.battle;
    if (b.finished) {
      this.suspend({pause:true});
      return {frames:this.frames(now,true,true),checkpoint:true};
    }
    return {frames:this.frames(now,false,urgent),checkpoint:urgent || b.elapsed-this.savedAt>=CHECKPOINT_PERIOD};
  }

  pump(now) {
    if (!this.running) return {frames:[]};
    if (now-this.inputAt>=IDLE_ROOM_MS) {
      this.suspend();
      return {frames:[],checkpoint:true,idle:true};
    }
    this.advance(now);
    return this.emit(now);
  }

  poll(text,now) {
    const command=decode(text);
    if (!command || command.seq<=this.lastSeq) {
      this.violations++;
      return {frames:[]};
    }
    this.lastSeq=command.seq;
    this.violations=Math.max(0,this.violations-1);
    const b=this.battle;
    const equipped=!!(command.loadout && b.equipPlayer(command.loadout.weapon,command.loadout.sub));
    if (command.paused || b.finished) {
      const changed=!this.paused;
      this.appliedSeq=command.seq;
      if (changed || this.running) this.suspend({pause:true});
      const urgent=changed || equipped;
      return {frames:urgent || command.loadout?this.frames(now,false,urgent):[],checkpoint:urgent};
    }
    if (!this.running) {
      this.running=true;
      this.stepAt=now;
    } else if (now-this.inputAt>=INPUT_LEASE_MS) {
      this.advance(now);
    }
    this.inputAt=now;
    this.paused=false;
    this.overview=b.mode==='watch' && command.overview;
    const {seq,x,z,yaw,pitch,fire,swim,overview,eye}=command;
    this.intent={seq,x,z,yaw,pitch,fire,swim,overview,eye};
    for (const key of taps) this.pending[key]=this.pending[key] || command[key];
    this.advance(now);
    return this.emit(now,equipped);
  }

  checkpoint() {
    return checkpointOf(this.battle);
  }
}
