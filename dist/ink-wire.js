import {localX} from './layout.js';

export const CLOUD_PROTOCOL=6;
export const SOCKET_PROTOCOL='inkshift.v6';
export const INK_SIZE={width:384,height:272};
const TILE=16, CELLS=TILE*TILE, HEADER=4, RECORD=6, MAGIC=73;
const MASK=32, RAW=CELLS*2, BUDGET=7200;

function readTile(paint,layer,tile) {
  const px=tile%paint.tilesWide*TILE, pz=Math.floor(tile/paint.tilesWide)*TILE;
  const values=new Uint16Array(CELLS), bits=new Uint8Array(MASK);
  let changed=0;
  for (let z=0;z<TILE;z++) for (let x=0;x<TILE;x++) {
    if (px+x>=paint.w || pz+z>=paint.h) continue;
    const index=layer*paint.layerSize+(pz+z)*paint.w+px+x, pixel=index*4, cell=z*TILE+x;
    const cyan=paint.pixels[pixel], sum=cyan+paint.pixels[pixel+1];
    const coverage=Math.round(sum/17);
    const ratio=coverage?Math.round(cyan/sum*31):0;
    const depth=Math.round(paint.pixels[pixel+2]*31/255);
    const value=values[cell]=(paint.owner[index]<<14)|(coverage<<10)|(ratio<<5)|depth;
    if (value===paint.netSent[index]) continue;
    bits[cell>>3]|=1<<(cell&7);
    changed++;
  }
  return {px,pz,values,bits,changed};
}

function encodeTile({values,bits,changed}) {
  const runs=new Uint8Array(CELLS*3), runView=new DataView(runs.buffer);
  let length=0;
  for (let i=0;i<CELLS;) {
    let n=1;
    while (n<256 && i+n<CELLS && values[i+n]===values[i]) n++;
    runs[length++]=n-1;
    runView.setUint16(length,values[i]);
    length+=2;
    i+=n;
  }
  if (length<RAW && length<MASK+changed*2) return {mode:1,data:runs.subarray(0,length)};
  if (MASK+changed*2>=RAW) {
    const data=new Uint8Array(RAW), view=new DataView(data.buffer);
    for (let i=0;i<CELLS;i++) view.setUint16(i*2,values[i]);
    return {mode:0,data};
  }
  const data=new Uint8Array(MASK+changed*2), view=new DataView(data.buffer);
  data.set(bits);
  let at=MASK;
  for (let i=0;i<CELLS;i++) {
    if (!(bits[i>>3] & (1<<(i&7)))) continue;
    view.setUint16(at,values[i]);
    at+=2;
  }
  return {mode:2,data};
}

function remember(paint,layer,{px,pz,values}) {
  for (let z=0;z<TILE && pz+z<paint.h;z++) {
    const start=layer*paint.layerSize+(pz+z)*paint.w+px;
    paint.netSent.set(values.subarray(z*TILE,z*TILE+Math.min(TILE,paint.w-px)),start);
  }
}

function* prioritized(pool,paint,focus,mask) {
  if (focus) {
    // Reserve some of every delta for older visible work before serving fresh nearby tiles.
    let oldest=4;
    for (const id of pool) {
      if (!(mask & (1<<Math.floor(id/paint.regionTiles)))) continue;
      yield id;
      if (--oldest===0) break;
    }
    const tx=Math.floor((localX(focus.x)/paint.boundX+1)*.5*paint.w/TILE);
    const tz=Math.floor((focus.z/paint.boundZ+1)*.5*paint.h/TILE);
    for (const id of pool) {
      const tile=id%paint.regionTiles;
      if (Math.abs(tile%paint.tilesWide-tx)<=2 && Math.abs(Math.floor(tile/paint.tilesWide)-tz)<=2) yield id;
    }
  }
  yield* pool;
}

export function paintPackets(paint,mask,full=false,focus=null) {
  const pool=full?paint.netTiles:paint.netDirty;
  if (full) for (let layer=0;layer<paint.layers;layer++) {
    if (mask & (1<<layer)) paint.netSent.fill(0,layer*paint.layerSize,(layer+1)*paint.layerSize);
  }
  const records=[], packets=[];
  let bytes=HEADER, remaining=full?Infinity:40;
  const flush=()=>{
    if (!records.length) return;
    const buf=new Uint8Array(bytes), view=new DataView(buf.buffer);
    buf[0]=MAGIC;
    buf[1]=CLOUD_PROTOCOL;
    view.setUint16(2,records.length);
    let at=HEADER;
    for (const {layer,tile,mode,data} of records) {
      buf[at]=layer;
      view.setUint16(at+1,tile);
      view.setUint16(at+3,data.length);
      buf[at+5]=mode;
      buf.set(data,at+RECORD);
      at+=RECORD+data.length;
    }
    packets.push(buf.buffer);
    records.length=0;
    bytes=HEADER;
  };
  for (const id of prioritized(pool,paint,full?null:focus,mask)) {
    const layer=Math.floor(id/paint.regionTiles);
    if (!(mask & (1<<layer))) continue;
    const tile=id%paint.regionTiles, raw=readTile(paint,layer,tile);
    if (!raw.changed) {
      paint.netDirty.delete(id);
      continue;
    }
    const encoded=encodeTile(raw), size=RECORD+encoded.data.length;
    if (!full && bytes+size>BUDGET) break;
    if (full && bytes+size>24500) flush();
    records.push({layer,tile,...encoded});
    bytes+=size;
    remember(paint,layer,raw);
    paint.netDirty.delete(id);
    if (--remaining===0) break;
  }
  flush();
  return packets;
}

export function resetVisualInk(paint,mask) {
  for (let layer=0;layer<paint.layers;layer++) {
    if (!(mask & (1<<layer))) continue;
    const from=layer*paint.layerSize,to=from+paint.layerSize;
    paint.owner.fill(0,from,to);
    paint.pixels.fill(0,from*4,to*4);
  }
  paint.dirtyMask|=mask;
}

function writeCell(paint,layer,px,pz,cell,value) {
  const x=px+cell%TILE,z=pz+Math.floor(cell/TILE);
  if (x>=paint.w || z>=paint.h) return;
  const index=layer*paint.layerSize+z*paint.w+x, p=index*4;
  const owner=value>>14, sum=((value>>10)&15)*17;
  const cyan=Math.round(sum*((value>>5)&31)/31);
  paint.owner[index]=owner;
  paint.pixels[p]=cyan;
  paint.pixels[p+1]=sum-cyan;
  paint.pixels[p+2]=Math.round((value&31)*255/31);
  paint.pixels[p+3]=value?paint.floorByte[index]:0;
}

export function applyInkPacket(paint,buffer) {
  const bytes=new Uint8Array(buffer), view=new DataView(buffer);
  if (bytes.length<HEADER || bytes[0]!==MAGIC || bytes[1]!==CLOUD_PROTOCOL) throw new Error('Invalid ink frame');
  const records=view.getUint16(2);
  let offset=HEADER;
  for (let r=0;r<records;r++) {
    if (offset+RECORD>bytes.length) throw new Error('Incomplete ink tile');
    const layer=bytes[offset], tile=view.getUint16(offset+1), length=view.getUint16(offset+3), mode=bytes[offset+5];
    offset+=RECORD;
    const end=offset+length, px=tile%paint.tilesWide*TILE,pz=Math.floor(tile/paint.tilesWide)*TILE;
    if (layer>=paint.layers || tile>=paint.tilesWide*paint.tilesHigh || end>bytes.length || length>RAW || mode>2) throw new Error('Invalid ink tile');
    if (mode===2) {
      if (length<MASK) throw new Error('Missing ink mask');
      const mask=bytes.subarray(offset,offset+MASK);
      offset+=MASK;
      for (let i=0;i<CELLS;i++) {
        if (!(mask[i>>3] & (1<<(i&7)))) continue;
        if (offset+2>end) throw new Error('Truncated ink change');
        writeCell(paint,layer,px,pz,i,view.getUint16(offset));
        offset+=2;
      }
    } else {
      let cell=0;
      while (offset<end) {
        const count=mode===0?1:bytes[offset++]+1;
        if (offset+2>end || cell+count>CELLS) throw new Error('Invalid ink run');
        const value=view.getUint16(offset);
        offset+=2;
        for (let i=0;i<count;i++,cell++) writeCell(paint,layer,px,pz,cell,value);
      }
      if (cell!==CELLS) throw new Error('Short ink tile');
    }
    if (offset!==end) throw new Error('Unexpected ink tile data');
    paint.dirtyMask|=1<<layer;
  }
  if (offset!==bytes.length) throw new Error('Unexpected ink data');
}
