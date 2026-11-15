import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomEngine} from './room-engine.js';
import {frameOf} from './frame.js';
import {Paint} from '../dist/ink.js';
import {INK_SIZE} from '../dist/ink-wire.js';
import {RemoteMatch} from '../dist/remote-match.js';
import {Mp4Writer} from '../dist/mp4.js';
import {FilmMixer,SAMPLE_RATE,placeSound} from '../dist/film-audio.js';
import {crewView} from '../dist/cloud-view.js';

const options={mode:'play',weapon:'jet',teamSize:8};
const still={x:0,z:0,yaw:Math.PI/2,pitch:-.14};
const header=packets=>JSON.parse(packets.find(packet=>typeof packet==='string'));
function client(world) {
  const paint=new Paint({...INK_SIZE,visualOnly:true});
  paint.setWorld(world);
  return Object.assign(Object.create(RemoteMatch.prototype),{world,paint,motions:[],intent:still,paused:false,awaitingFrame:false});
}

test('delta frames rebuild exactly the state a full frame carries, at a fraction of its size',()=>{
  const engine=new RoomEngine(options), b=engine.battle, mirror=client(b.world);
  b.countdown=0;
  let now=1000;
  const first=header(engine.frames(now,true));
  assert(first.full && first.actors.length===16);
  mirror.apply(first,true);
  const sizes=[];
  for (let i=0;i<48;i++) {
    for (let k=0;k<2;k++) b.update(1/48,still,()=>crewView(b,b.player));
    const packets=engine.frames(now+=1000/24);
    if (!packets.length) continue;
    const text=packets.find(packet=>typeof packet==='string'), frame=JSON.parse(text);
    assert(!frame.full && frame.actorDiffs && !frame.actors);
    sizes.push(text.length);
    mirror.apply(frame);
  }
  assert(sizes.length>=40,'frames '+sizes.length);
  const truth=JSON.parse(JSON.stringify(frameOf(b,0,0,[])));
  assert.deepEqual(mirror.rows,truth.actors);
  assert.deepEqual(mirror.scene.decals.map(mark=>mark.id),truth.decals.map(mark=>mark[10]));
  const full=JSON.stringify(header(engine.frames(now+=50,true))).length, typical=sizes.sort((a,c)=>a-c)[sizes.length>>1];
  assert(typical<full*.45,'delta '+typical+' / full '+full);
});

test('the client moves its own crew member at once and only nudges it toward the server',()=>{
  const engine=new RoomEngine({...options,mode:'play',teamSize:4}), b=engine.battle, mirror=client(b.world);
  b.countdown=0;
  Object.assign(b.player,{x:-44,y:0,z:3,yaw:Math.PI/2});
  mirror.apply(header(engine.frames(1000,true)),true);
  const p=mirror.scene.player, x=p.x;
  mirror.intent={...still,z:1};
  mirror.advance(2000);
  mirror.advance(2100);
  mirror.advance(2200);
  assert(p.x-x>.6,'moved '+(p.x-x));
  assert.equal(b.player.x,-44,'the server has not moved yet');
  // A server far from the prediction (a respawn, a hit away) snaps the view.
  mirror.sentAt=new Map([[0,2100]]);
  Object.assign(b.player,{x:-30,z:3});
  mirror.apply(header(engine.frames(1500,true)));
  assert.equal(mirror.shadow.x,b.player.x);
  // A small difference is blended in over the next frames, never jumped.
  const shadow=mirror.shadow;
  mirror.history=[{t:2100,x:shadow.x-.5,y:shadow.y,z:shadow.z}];
  Object.assign(b.player,{x:shadow.x});
  const before=shadow.x;
  mirror.apply(header(engine.frames(1600,true)));
  assert.equal(shadow.x,before);
  assert(mirror.fix[0]>.1 && mirror.fix[0]<.5);
});

test('the movie file indexes every sample, and reordered frames get composition offsets',async()=>{
  const build=async reorder=>{
    const writer=new Mp4Writer();
    const video=writer.addTrack('video',{codec:'avc1',width:64,height:36,timescale:6000,description:Uint8Array.of(1,100,0,42,255,225)});
    const audio=writer.addTrack('audio',{codec:'Opus',channels:2,sampleRate:SAMPLE_RATE,timescale:SAMPLE_RATE,bitrate:320000});
    const order=reorder?[0,2,1,4,3]:[0,1,2,3,4];
    order.forEach((frame,i)=>writer.addSample(video,Uint8Array.of(10+i,frame,frame,frame),100,i===0,frame*100));
    for (let i=0;i<3;i++) writer.addSample(audio,Uint8Array.of(200+i,7,7),960,true);
    return new Uint8Array(await writer.finish().arrayBuffer());
  };
  const boxes=(bytes,from=0,to=bytes.length,out=[])=>{
    const view=new DataView(bytes.buffer,bytes.byteOffset);
    for (let at=from;at<to;) {
      let size=view.getUint32(at), head=8;
      const type=String.fromCharCode(...bytes.subarray(at+4,at+8));
      if (size===1) {size=Number(view.getBigUint64(at+8));head=16;}
      out.push({type,at,size,body:at+head});
      if (['moov','trak','mdia','minf','stbl','edts'].includes(type)) boxes(bytes,at+head,at+size,out);
      if (type==='stsd') boxes(bytes,at+head+8,at+size,out);
      at+=size;
    }
    return out;
  };
  for (const reorder of [false,true]) {
    const bytes=await build(reorder), list=boxes(bytes), view=new DataView(bytes.buffer);
    assert.deepEqual(list.filter(box=>['ftyp','moov','mdat'].includes(box.type)).map(box=>box.type),['ftyp','moov','mdat']);
    const offsets=list.filter(box=>box.type==='co64').map(box=>{
      const count=view.getUint32(box.body+4);
      return Array.from({length:count},(_,i)=>Number(view.getBigUint64(box.body+8+i*8)));
    });
    assert.deepEqual(offsets.map(list=>list.map(at=>bytes[at])),[[10,11,12,13,14],[200,201,202]]);
    assert.equal(list.some(box=>box.type==='ctts'),reorder);
    assert.equal(list.some(box=>box.type==='elst'),reorder);
    assert(list.some(box=>box.type==='avc1') && list.some(box=>box.type==='Opus'));
  }
});

test('the film soundtrack mixes positioned cues over music without clipping',()=>{
  const mixer=new FilmMixer();
  for (let i=0;i<80;i++) mixer.cue(['shot','blast','hit','down','bomb'][i%5],i*.01,1,i%2?.8:-.8);
  let peak=0, energy=0;
  for (let i=0;i<20;i++) {
    const [left,right]=mixer.render(2400);
    for (let k=0;k<left.length;k++) {
      assert(Number.isFinite(left[k]) && Number.isFinite(right[k]));
      peak=Math.max(peak,Math.abs(left[k]),Math.abs(right[k]));
      energy+=left[k]**2;
    }
  }
  assert(peak<.9 && energy>1);
  assert.equal(mixer.voices.length,0);
  const near=placeSound([2,1,0],[0,1,0],[1,0,0]), far=placeSound([60,1,0],[0,1,0],[1,0,0]);
  assert(near.gain>far.gain && near.pan>0);
  assert.equal(placeSound([1,1,0],[0,1,0],[1,0,0],false).gain,0);
});
