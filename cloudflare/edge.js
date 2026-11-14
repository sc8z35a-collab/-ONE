import {CLOUD_PROTOCOL,SOCKET_PROTOCOL} from '../dist/ink-wire.js';
import {WEAPONS} from '../dist/weapons.js';
import {SUBWEAPONS,subweaponById} from '../dist/subweapons.js';

const BASE='/api/inkshift', encoder=new TextEncoder(), decoder=new TextDecoder();
const DAY=86_400_000, TICKET_LIFETIME=DAY*3;
const TICKET_SCOPE='inkshift-room:v1';
const ROOM_ID=/^[a-f0-9]{64}$/;
const TOKEN=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const accessReady=value=>typeof value==='string' && value.length>=24 && value.length<=160;
const utf=text=>encoder.encode(text);
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
const un64=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));

function json(body,status=200) {
  return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

function matchingOrigin(request,url) {
  return request.headers.get('Origin')===url.origin;
}

async function accessMatch(expected,submitted) {
  if (typeof submitted!=='string' || submitted.length>160) return false;
  const [a,b]=await Promise.all([expected,submitted].map(x=>crypto.subtle.digest('SHA-256',utf(x))));
  const av=new Uint8Array(a),bv=new Uint8Array(b);
  let difference=0;
  for (let i=0;i<av.length;i++) difference|=av[i]^bv[i];
  return difference===0;
}

async function keyFor(secret) {
  return crypto.subtle.importKey('raw',utf(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}

async function sign(secret,claims) {
  const body=b64(utf(JSON.stringify(claims)));
  const proof=new Uint8Array(await crypto.subtle.sign('HMAC',await keyFor(secret),utf(TICKET_SCOPE+':'+body)));
  return body+'.'+b64(proof);
}

async function verify(secret,token,room) {
  if (!token || token.length>500 || !TOKEN.test(token)) return null;
  try {
    const [body,proof]=token.split('.');
    const key=await keyFor(secret), mac=un64(proof);
    if (!await crypto.subtle.verify('HMAC',key,mac,utf(TICKET_SCOPE+':'+body)) &&
        !await crypto.subtle.verify('HMAC',key,mac,utf('inkshift.v4:'+body))) return null;
    const claims=JSON.parse(decoder.decode(un64(body)));
    return claims.room===room && claims.expires>Date.now()?claims:null;
  } catch { return null; }
}

async function smallJSON(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return null;
  const reader=request.body?.getReader();
  if (!reader) return null;
  const data=new Uint8Array(1024);
  let size=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      if (size+value.length>data.length) {
        await reader.cancel();
        return null;
      }
      data.set(value,size);
      size+=value.length;
    }
    return JSON.parse(decoder.decode(data.subarray(0,size)));
  } catch { return null; }
}

export function optionsFor(body) {
  if (!body || !['play','watch','timeless'].includes(body.mode) || !WEAPONS.some(w=>w.id===body.weapon)) return null;
  if (body.sub!==undefined && !SUBWEAPONS.some(sub=>sub.id===body.sub)) return null;
  return {mode:body.mode,weapon:body.weapon,sub:subweaponById(body.sub).id,teamSize:body.mode==='timeless' || body.teamSize===4?4:8};
}

export async function handleEdge(request,env) {
  const url=new URL(request.url), path=url.pathname;
  if (path===BASE+'/health' && request.method==='GET') {
    return json({cloud:true,ready:accessReady(env.GAME_ACCESS_CODE),protocol:CLOUD_PROTOCOL});
  }
  if (!path.startsWith(BASE+'/')) return env.ASSETS.fetch(request);
  if (!accessReady(env.GAME_ACCESS_CODE)) return json({error:'SETUP_REQUIRED'},503);
  if (!matchingOrigin(request,url)) return json({error:'ORIGIN'},403);

  if (path===BASE+'/rooms' && request.method==='POST') {
    const body=await smallJSON(request);
    if (!body || !await accessMatch(env.GAME_ACCESS_CODE,body.access)) return json({error:'ACCESS'},401);
    const options=optionsFor(body);
    if (!options) return json({error:'OPTIONS'},400);
    const room=env.ROOMS.newUniqueId().toString(), expires=Date.now()+TICKET_LIFETIME;
    return json({room,expires,ticket:await sign(env.GAME_ACCESS_CODE,{room,expires,...options})},201);
  }
  const room=path.startsWith(BASE+'/socket/')?path.slice((BASE+'/socket/').length):null;
  if (room && ROOM_ID.test(room) && request.method==='GET') {
    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return json({error:'WEBSOCKET'},426);
    const protocols=request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(p=>p.trim()) ?? [];
    if (protocols[0]!==SOCKET_PROTOCOL || protocols.length!==2) return json({error:'PROTOCOL'},400);
    const claims=await verify(env.GAME_ACCESS_CODE,protocols[1],room);
    if (!claims) return json({error:'TICKET'},401);
    const id=env.ROOMS.idFromString(room);
    const stub=env.ROOMS.get(id,{locationHint:'apac'});
    const header=new Headers({'Upgrade':'websocket','X-Inkshift-Verified':JSON.stringify(claims)});
    return stub.fetch(new Request('https://room.internal/join',{headers:header}));
  }
  return json({error:'NOT_FOUND'},404);
}
