import {DurableObject} from 'cloudflare:workers';
import {SOCKET_PROTOCOL} from '../dist/ink-wire.js';
import {handleEdge,optionsFor} from './edge.js';
import {HZ,RoomEngine,STORAGE_KEYS} from './room-engine.js';

const ROOM_RETENTION=72*60*60*1000;
const OPEN=1;

export class InkshiftRoom extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.engine=null;
    this.loading=null;
    this.savePending=null;
    this.saveAfter=0;
    this.socket=null;
    this.timer=null;
  }

  ensure(options) {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this.loading) {
      this.loading=this.ctx.storage.get(STORAGE_KEYS).then(data=>{
        this.engine=new RoomEngine(options,data);
        return this.engine;
      }).finally(()=>{this.loading=null;});
    }
    return this.loading;
  }

  async fetch(request) {
    let claims;
    try { claims=JSON.parse(request.headers.get('X-Inkshift-Verified') ?? 'null'); }
    catch { return new Response('Invalid ticket',{status:401}); }
    const options=optionsFor(claims);
    if (!options || claims.room!==this.ctx.id.toString() || claims.expires<=Date.now()) return new Response('Invalid ticket',{status:401});
    const room=await this.ensure(options);
    const [client,server]=Object.values(new WebSocketPair());
    this.cancelTick();
    this.socket=server;
    for (const active of this.ctx.getWebSockets('owner')) active.close(4001,'Replaced by reconnect');
    this.ctx.acceptWebSocket(server,['owner']);
    server.serializeAttachment(options);
    room.resetLink();
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now()+ROOM_RETENTION));
    server.send(room.hello());
    for (const packet of room.frames(Date.now(),true)) server.send(packet);
    return new Response(null,{status:101,webSocket:client,headers:{'Sec-WebSocket-Protocol':SOCKET_PROTOCOL}});
  }

  cancelTick() {
    if (this.timer!==null) clearTimeout(this.timer);
    this.timer=null;
  }

  send(socket,room,{frames,checkpoint,idle}) {
    try {
      for (const packet of frames) socket.send(packet);
      if (idle) socket.close(4002,'Room inactive');
    } finally {
      if (checkpoint) this.ctx.waitUntil(this.save(room,idle || room.battle.finished));
    }
  }

  schedule(socket,room) {
    if (!room.running || this.socket!==socket || socket.readyState!==OPEN) return;
    if (this.timer!==null) return;
    this.timer=setTimeout(()=>{
      this.timer=null;
      if (this.socket!==socket || socket.readyState!==OPEN || !room.running) return;
      try {
        this.send(socket,room,room.pump(Date.now()));
        this.schedule(socket,room);
      } catch (error) {
        room.suspend();
        this.ctx.waitUntil(this.save(room,true));
        if (socket.readyState===OPEN) socket.close(1011,'Room interrupted');
        console.error('INKSHIFT simulation interrupted',error.message);
      }
    },1000/HZ);
  }

  async webSocketMessage(socket,message) {
    if (socket.readyState!==OPEN || this.socket && this.socket!==socket) return;
    this.socket=socket;
    const options=socket.deserializeAttachment();
    if (!optionsFor(options)) {socket.close(1008,'Invalid room');return;}
    const room=await this.ensure(options);
    if (socket.readyState!==OPEN || this.socket!==socket) return;
    const update=room.poll(message,Date.now());
    if (room.violations>38) {socket.close(1008,'Invalid input stream');return;}
    this.send(socket,room,update);
    if (room.running) this.schedule(socket,room);
    else this.cancelTick();
  }

  save(room,force=false) {
    if (this.savePending) return force?this.savePending.then(()=>this.save(room,true)):this.savePending;
    if (!force && Date.now()<this.saveAfter) return Promise.resolve();
    const values=room.checkpoint(), at=room.battle.elapsed;
    this.saveAfter=Date.now()+4000;
    this.savePending=this.ctx.storage.put(values).then(()=>{
      room.savedAt=at;
    }).catch(error=>{
      console.error('INKSHIFT checkpoint failed',error.message);
    }).finally(()=>{this.savePending=null;});
    return this.savePending;
  }

  async detach(socket) {
    if (this.socket && this.socket!==socket) return;
    this.socket=null;
    this.cancelTick();
    if (this.engine && !this.ctx.getWebSockets('owner').some(s=>s!==socket && s.readyState===OPEN)) {
      this.engine.suspend();
      await this.save(this.engine,true);
    }
  }

  async webSocketClose(socket,code,reason) {
    socket.close(code<1000 || [1004,1005,1006,1015].includes(code)?1000:code,reason);
    await this.detach(socket);
  }

  async webSocketError(socket) {
    socket.close(1011,'Connection interrupted');
    await this.detach(socket);
  }

  async alarm() {
    if (this.savePending) await this.savePending;
    if (this.ctx.getWebSockets('owner').some(s=>s.readyState===OPEN)) {
      await this.ctx.storage.setAlarm(Date.now()+ROOM_RETENTION);
      return;
    }
    this.engine=null;
    await this.ctx.storage.deleteAll();
  }
}

export default {async fetch(request,env) {
  const path=new URL(request.url).pathname;
  if (request.method!=='GET' || !['/','/index.html'].includes(path)) return handleEdge(request,env);
  const asset=await env.ASSETS.fetch(request);
  if (!asset.ok || !asset.headers.get('Content-Type')?.includes('text/html')) return asset;
  const html=new HTMLRewriter().on('meta[name="inkshift-compute"]',{
    element(meta) {meta.setAttribute('content','cloud-required');}
  }).transform(asset);
  const headers=new Headers(html.headers);
  headers.set('Cache-Control','no-store');
  headers.delete('ETag');
  headers.delete('Content-Length');
  return new Response(html.body,{status:html.status,headers});
}};
