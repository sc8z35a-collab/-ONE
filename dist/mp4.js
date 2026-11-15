// A small MP4 writer for the offline film renderer. It takes encoded video and
// audio samples in the order they are produced and assembles a file with the
// index (moov) in front of the media, so the result plays and seeks at once.
// Media bytes are folded into Blobs as they arrive: the browser may keep those
// on disk, so a long 4K file does not have to sit in script memory.

const text=new TextEncoder();
const FLUSH_BYTES=8*1024*1024;

const u8=(...values)=>Uint8Array.from(values);
const u16=value=>u8(value>>>8&255,value&255);
const u32=value=>u8(value>>>24&255,value>>>16&255,value>>>8&255,value&255);
const u64=value=>{
  const high=Math.floor(value/4294967296), low=value>>>0;
  return join([u32(high),u32(low)]);
};
const ascii=value=>text.encode(value);
const zeros=count=>new Uint8Array(count);
// Long index tables are written straight into one buffer.
function table(values,width=4) {
  const out=new Uint8Array(values.length*width), view=new DataView(out.buffer);
  for (let i=0;i<values.length;i++) {
    if (width===8) {
      view.setUint32(i*8,Math.floor(values[i]/4294967296));
      view.setUint32(i*8+4,values[i]>>>0);
    } else view.setUint32(i*4,values[i]);
  }
  return out;
}

function join(parts) {
  let size=0;
  for (const part of parts) size+=part.length;
  const out=new Uint8Array(size);
  let at=0;
  for (const part of parts) {
    out.set(part,at);
    at+=part.length;
  }
  return out;
}

function box(type,...parts) {
  const body=join(parts);
  return join([u32(body.length+8),ascii(type),body]);
}

const full=(type,version,flags,...parts)=>box(type,u8(version,flags>>>16&255,flags>>>8&255,flags&255),...parts);
const MATRIX=join([u32(0x10000),u32(0),u32(0),u32(0),u32(0x10000),u32(0),u32(0),u32(0),u32(0x40000000)]);

function descriptor(tag,...parts) {
  const body=join(parts);
  if (body.length>127) throw new Error('MP4 descriptor too long');
  return join([u8(tag,body.length),body]);
}

// Groups equal neighbouring durations for the time-to-sample table.
function runs(values) {
  const out=[];
  for (const value of values) {
    const last=out.at(-1);
    if (last && last[1]===value) last[0]++;
    else out.push([1,value]);
  }
  return out;
}

function videoEntry(track) {
  const {codec,width,height,description,color}=track;
  const colour=color?box('colr',ascii('nclx'),u16(color.primaries),u16(color.transfer),u16(color.matrix),u8(color.fullRange?0x80:0)):zeros(0);
  let config;
  if (codec==='avc1') config=box('avcC',description);
  else if (codec==='hvc1') config=box('hvcC',description);
  else if (codec==='vp09') {
    const {profile=0,level=41,bitDepth=8}=track.vp9??{};
    config=full('vpcC',1,0,u8(profile,level,bitDepth<<4|1<<1|0,color?.primaries??1,color?.transfer??1,color?.matrix??1),u16(0));
  } else throw new Error('Unsupported video codec '+codec);
  return box(codec,zeros(6),u16(1),zeros(16),u16(width),u16(height),u32(0x480000),u32(0x480000),zeros(4),u16(1),
    zeros(32),u16(0x18),u16(0xffff),config,colour);
}

function audioEntry(track) {
  const {codec,channels,sampleRate,description,bitrate}=track;
  const head=join([zeros(6),u16(1),zeros(8),u16(channels),u16(16),zeros(4),u32(sampleRate*65536)]);
  if (codec==='mp4a') {
    const esds=full('esds',0,0,descriptor(3,u16(0),u8(0),
      descriptor(4,u8(0x40,0x15),u8(0,0,0),u32(bitrate),u32(bitrate),descriptor(5,description)),
      descriptor(6,u8(2))));
    return box('mp4a',head,esds);
  }
  if (codec==='Opus') {
    const skip=track.preSkip??312;
    return box('Opus',head,box('dOps',u8(0,channels),u16(skip),u32(sampleRate),u16(0),u8(0)));
  }
  throw new Error('Unsupported audio codec '+codec);
}

// Encoders that reorder frames (B-frames) deliver them in decode order with
// their own presentation times. Those become composition offsets (ctts),
// raised so none is negative, and an edit list (elst) that starts the
// presentation at the first frame again.
function reordering(samples) {
  let dts=0, lowest=0, reordered=false;
  const offsets=new Array(samples.length);
  for (let i=0;i<samples.length;i++) {
    const sample=samples[i], offset=sample.pts===undefined?0:sample.pts-dts;
    offsets[i]=offset;
    if (offset) reordered=true;
    if (offset<lowest) lowest=offset;
    dts+=sample.duration;
  }
  return reordered?{shift:-lowest,offsets:offsets.map(offset=>offset-lowest)}:null;
}

function trackBox(track,id,movieScale,base) {
  const {samples,timescale}=track, video=track.kind==='video';
  const duration=samples.reduce((sum,sample)=>sum+sample.duration,0);
  const movieDuration=Math.round(duration/timescale*movieScale);
  const stts=runs(samples.map(sample=>sample.duration));
  const keys=samples.flatMap((sample,i)=>sample.key?[i+1]:[]);
  const order=video?reordering(samples):null;
  const ctts=order?runs(order.offsets):null;
  const stbl=box('stbl',
    full('stsd',0,0,u32(1),video?videoEntry(track):audioEntry(track)),
    full('stts',0,0,u32(stts.length),table(stts.flat())),
    ...(ctts?[full('ctts',0,0,u32(ctts.length),table(ctts.flat()))]:[]),
    ...(video && keys.length<samples.length?[full('stss',0,0,u32(keys.length),table(keys))]:[]),
    full('stsc',0,0,u32(1),u32(1),u32(1),u32(1)),
    full('stsz',0,0,u32(0),u32(samples.length),table(samples.map(sample=>sample.size))),
    full('co64',0,0,u32(samples.length),table(samples.map(sample=>base+sample.offset),8)));
  const media=video?full('vmhd',0,1,zeros(8)):full('smhd',0,0,zeros(4));
  const minf=box('minf',media,box('dinf',full('dref',0,0,u32(1),full('url ',0,1))),stbl);
  const mdia=box('mdia',
    full('mdhd',0,0,u32(0),u32(0),u32(timescale),u32(duration),u16(0x55c4),u16(0)),
    full('hdlr',0,0,u32(0),ascii(video?'vide':'soun'),zeros(12),ascii(video?'INK//SHIFT video':'INK//SHIFT audio'),u8(0)),
    minf);
  const tkhd=full('tkhd',0,3,u32(0),u32(0),u32(id),u32(0),u32(movieDuration),zeros(8),u16(0),u16(0),u16(video?0:0x100),u16(0),
    MATRIX,u32((track.width??0)*65536),u32((track.height??0)*65536));
  const edit=order?[box('edts',full('elst',0,0,u32(1),u32(movieDuration),u32(order.shift),u16(1),u16(0)))]:[];
  return {box:box('trak',tkhd,...edit,mdia),duration:movieDuration};
}

export class Mp4Writer {
  constructor() {
    this.tracks=[];
    this.blobs=[];
    this.pending=[];
    this.pendingBytes=0;
    this.bytes=0;
  }

  // kind 'video': {codec:'avc1'|'hvc1'|'vp09',width,height,timescale,description,color,vp9}
  // kind 'audio': {codec:'mp4a'|'Opus',channels,sampleRate,timescale,description,bitrate,preSkip}
  addTrack(kind,settings) {
    const track={kind,samples:[],...settings};
    this.tracks.push(track);
    return track;
  }

  // `pts` (presentation time, in the track's timescale) is only needed when
  // the encoder reorders frames.
  addSample(track,data,duration,key=true,pts=undefined) {
    track.samples.push({offset:this.bytes,size:data.length,duration,key,pts});
    this.pending.push(data);
    this.pendingBytes+=data.length;
    this.bytes+=data.length;
    if (this.pendingBytes>=FLUSH_BYTES) this.fold();
  }

  fold() {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending));
    this.pending=[];
    this.pendingBytes=0;
  }

  header(base) {
    const movieScale=1000, tracks=this.tracks.filter(track=>track.samples.length);
    const boxes=tracks.map((track,i)=>trackBox(track,i+1,movieScale,base));
    const duration=Math.max(0,...boxes.map(item=>item.duration));
    const mvhd=full('mvhd',0,0,u32(0),u32(0),u32(movieScale),u32(duration),u32(0x10000),u16(0x100),zeros(10),MATRIX,zeros(24),
      u32(tracks.length+1));
    return box('moov',mvhd,...boxes.map(item=>item.box));
  }

  // The finished file: ftyp, the index, then one mdat holding every sample.
  finish(type='video/mp4') {
    this.fold();
    const brands=this.tracks.some(track=>track.codec==='avc1')?['isom','iso2','avc1','mp41']:['isom','iso2','mp41'];
    const ftyp=box('ftyp',ascii('isom'),u32(0x200),...brands.map(ascii));
    const size=this.header(0).length;
    const base=ftyp.length+size+16;
    const moov=this.header(base);
    const mdat=join([u32(1),ascii('mdat'),u64(this.bytes+16)]);
    return new Blob([ftyp,moov,mdat,...this.blobs],{type});
  }
}
