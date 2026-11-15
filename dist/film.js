// Offline film renderer: plays one full seven-minute NPC match on this device
// and writes it to an MP4, frame by frame, from the camera of the crew member
// who turned out to be the most active. The match is simulated twice from the
// same seed: once to find that crew member, once to draw every frame.
import {Battle} from './battle.js';
import {crewView} from './cloud-view.js';
import {FilmMixer,SAMPLE_RATE,placeSound} from './film-audio.js';
import {inkResult} from './ink-hud.js';
import {Paint} from './ink.js';
import {sameLevel,zoneOf} from './layout.js';
import {Mp4Writer} from './mp4.js';
import {matchResults,mostActive} from './progress.js';
import {clamp,cross,sub,unit} from './render.js';
import {SUPERS} from './weapons.js';

export const FILM_SIZES={
  fhd:{label:'FHD 1920×1080',width:1920,height:1080},
  uhd:{label:'4K 3840×2160',width:3840,height:2160}
};
export const FILM_RATES=[60,120];
const VIDEO_BITRATE={fhd:{60:16e6,120:24e6},uhd:{60:56e6,120:80e6}};
const AUDIO_BITRATES=[320000,256000,192000];
const NEUTRAL={x:0,z:0,yaw:0,pitch:0};
const OUTRO_SECONDS=3, COUNTDOWN_SECONDS=3;
// Length of the finished film in seconds, for estimates before it is made.
export const FILM_SECONDS=COUNTDOWN_SECONDS+420+OUTRO_SECONDS;
export const filmBytes=(support,seconds=FILM_SECONDS)=>
  (support.video.config.bitrate+(support.audio?.config.bitrate??0))*seconds/8;
const TEAM_COLOURS=['#19d9c0','#ff7a3d'];
const idle=()=>new Promise(resolve=>{
  const channel=new MessageChannel();
  channel.port1.onmessage=()=>resolve();
  channel.port2.postMessage(0);
});

function videoCandidates(size,fps) {
  const {width,height}=FILM_SIZES[size], key=size+fps;
  const base={width,height,bitrate:VIDEO_BITRATE[size][fps],framerate:fps,latencyMode:'quality',bitrateMode:'variable'};
  const avc={fhd60:'2A',fhd120:'33',uhd60:'34',uhd120:'3D'}[key];
  const hevc={fhd60:123,fhd120:150,uhd60:153,uhd120:156}[key];
  const vp9={fhd60:41,fhd120:50,uhd60:51,uhd120:52}[key];
  return [
    {box:'avc1',label:'H.264 High',config:{...base,codec:'avc1.6400'+avc,avc:{format:'avc'}}},
    {box:'hvc1',label:'HEVC Main',config:{...base,codec:'hvc1.1.6.L'+hevc+'.B0',hevc:{format:'hevc'}}},
    {box:'vp09',label:'VP9',vp9:{profile:0,level:vp9,bitDepth:8},config:{...base,codec:'vp09.00.'+vp9+'.08'}}
  ];
}

function audioCandidates() {
  const base={sampleRate:SAMPLE_RATE,numberOfChannels:2};
  return [
    ...AUDIO_BITRATES.map(bitrate=>({box:'mp4a',label:'AAC-LC',frame:1024,config:{...base,codec:'mp4a.40.2',bitrate}})),
    ...AUDIO_BITRATES.map(bitrate=>({box:'Opus',label:'Opus',frame:960,config:{...base,codec:'opus',bitrate}}))
  ];
}

async function firstSupported(Encoder,candidates) {
  for (const candidate of candidates) {
    try {
      const result=await Encoder.isConfigSupported(candidate.config);
      if (result?.supported) return {...candidate,config:result.config ?? candidate.config};
    } catch { /* This device cannot encode it. */ }
  }
  return null;
}

// What this device can write for the requested picture, or why it cannot.
export async function filmSupport(renderer,size,fps) {
  const {width,height}=FILM_SIZES[size];
  if (!renderer?.gl) return {reason:'この端末のソフトウェア描画では動画を書き出せません（WebGL 2 が必要です）。'};
  if (typeof VideoEncoder==='undefined' || typeof VideoFrame==='undefined') {
    return {reason:'このブラウザは動画エンコード（WebCodecs）に対応していません。最新の Chrome / Edge / Safari で開いてください。'};
  }
  if ((renderer.renderLimit||0)<width) return {reason:'この端末のGPUは '+width+'×'+height+' の描画に対応していません。'};
  const video=await firstSupported(VideoEncoder,videoCandidates(size,fps));
  if (!video) return {reason:FILM_SIZES[size].label+' / '+fps+'fps を書き出せるエンコーダーがこの端末にありません。解像度かフレームレートを下げてください。'};
  const audio=typeof AudioEncoder==='undefined'?null:await firstSupported(AudioEncoder,audioCandidates());
  return {video,audio};
}

const format=seconds=>Math.floor(seconds/60)+':'+String(Math.floor(seconds%60)).padStart(2,'0');

export class Film {
  // `duration`, `countdown` and `outro` shorten the film for a quick check;
  // the menu always makes the full seven-minute match.
  constructor({canvas,renderer,world,size='fhd',fps=60,seed=Math.floor(Math.random()*0x7fffffff),support,onProgress,
    duration=null,countdown=null,outro=OUTRO_SECONDS}) {
    Object.assign(this,{canvas,renderer,world,size,fps,seed,support,onProgress,duration,countdown,outro});
    this.canceled=false;
  }

  cancel() {
    this.canceled=true;
  }

  check() {
    if (this.canceled) throw Object.assign(new Error('書き出しを中止しました。'),{canceled:true});
  }

  match(callbacks={}) {
    const paint=new Paint();
    paint.setWorld(this.world);
    const battle=new Battle(this.world,paint,'watch',callbacks,{teamSize:8,seed:this.seed});
    if (this.duration) battle.duration=battle.left=this.duration;
    if (this.countdown!==null) battle.countdown=this.countdown;
    return {paint,battle};
  }

  // First run: the whole match without drawing, to learn who was most active.
  async analyze() {
    const {battle,paint}=this.match(), dt=1/this.fps, total=battle.duration+battle.countdown;
    let steps=0, shown=performance.now();
    while (!battle.finished) {
      battle.update(dt,NEUTRAL,null);
      if (++steps%6===0 && performance.now()-shown>40) {
        this.onProgress?.({phase:'analyze',done:battle.clock,total});
        await idle();
        this.check();
        shown=performance.now();
      }
    }
    const rows=matchResults(battle,paint), star=mostActive(rows);
    return {star:star.name,rows};
  }

  view(battle,star,dt) {
    const zone=zoneOf(star.x), state=this.viewState ??= {};
    if (state.zone!==zone || !(Math.hypot(star.x-state.x,star.z-state.z)<2.6)) {
      Object.assign(state,{zone,x:star.x,z:star.z,height:star.y,reach:1});
      if (state.yaw===undefined || !(star.down>0)) {
        state.yaw=star.yaw;
        state.pitch=clamp(star.pitch-.075,-.49,.24);
      }
    }
    const follow=1-Math.exp(-dt*11);
    state.x+=(star.x-state.x)*follow;
    state.z+=(star.z-state.z)*follow;
    state.height+=(star.y-state.height)*(1-Math.exp(-dt*14));
    if (star.down>0) {
      // While the star waits to respawn the camera drifts around the spot.
      state.yaw+=dt*.24;
      state.pitch+=(-.26-state.pitch)*(1-Math.exp(-dt*2));
    } else {
      const change=Math.atan2(Math.sin(star.yaw-state.yaw),Math.cos(star.yaw-state.yaw));
      state.yaw+=change*(1-Math.exp(-dt*4.1));
      state.pitch+=(clamp(star.pitch-.075,-.49,.24)-state.pitch)*(1-Math.exp(-dt*5));
    }
    const pose=crewView(battle,star,{yaw:state.yaw,pitch:state.pitch,height:clamp(state.height,star.y-.42,star.y+.42),
      reach:state.reach+(1-state.reach)*(1-Math.exp(-dt*5.5)),watch:true,x:state.x,z:state.z});
    state.reach=pose.reach ?? 1;
    return pose;
  }

  // Score, clock, the star's card and the splat feed, drawn over each frame.
  overlay(ctx,battle,paint,star,finale) {
    const {width:w,height:h}=ctx.canvas, s=h/1080;
    const scores=[paint.percent(0),paint.percent(1)];
    ctx.save();
    ctx.textBaseline='middle';
    ctx.lineJoin='round';
    const plate=(x,y,pw,ph,colour='rgba(8,20,26,.72)')=>{
      ctx.fillStyle=colour;
      ctx.beginPath();
      ctx.moveTo(x+10*s,y);ctx.lineTo(x+pw,y);ctx.lineTo(x+pw-10*s,y+ph);ctx.lineTo(x,y+ph);
      ctx.closePath();
      ctx.fill();
    };
    const label=(text,x,y,size,colour='#f2f7ee',align='left',weight=800)=>{
      ctx.font=weight+' '+Math.round(size*s)+'px "Helvetica Neue",Arial,"Noto Sans JP",sans-serif';
      ctx.textAlign=align;
      ctx.fillStyle=colour;
      ctx.fillText(text,x,y);
    };
    // Scoreboard.
    const cx=w/2, top=28*s;
    plate(cx-330*s,top,660*s,74*s);
    label('CYAN',cx-300*s,top+24*s,18,TEAM_COLOURS[0]);
    label(scores[0].toFixed(1)+'%',cx-300*s,top+52*s,30,TEAM_COLOURS[0]);
    label('AMBER',cx+300*s,top+24*s,18,TEAM_COLOURS[1],'right');
    label(scores[1].toFixed(1)+'%',cx+300*s,top+52*s,30,TEAM_COLOURS[1],'right');
    label(battle.countdown>0?String(Math.ceil(battle.countdown)):format(Math.ceil(battle.left)),cx,top+38*s,40,'#ffffff','center',900);
    const bar=660*s, total=Math.max(.001,scores[0]+scores[1]);
    ctx.fillStyle=TEAM_COLOURS[0];
    ctx.fillRect(cx-330*s,top+78*s,bar*scores[0]/total,6*s);
    ctx.fillStyle=TEAM_COLOURS[1];
    ctx.fillRect(cx-330*s+bar*scores[0]/total,top+78*s,bar*scores[1]/total,6*s);
    // The star's card.
    const active=star.superUntil>battle.clock?SUPERS[star.activeSpecial]?.name:null;
    plate(40*s,h-150*s,560*s,110*s);
    label('MVP CAM',64*s,h-124*s,16,'#ffd58a');
    label(star.name,64*s,h-90*s,40,TEAM_COLOURS[star.team],'left',900);
    label(star.weapon.name,200*s,h-98*s,22);
    label('撃破 '+star.kills+'   ダウン '+star.downs+(active?'   ★ '+active:''),200*s,h-66*s,20,'#cfe0da',undefined,700);
    ctx.fillStyle='#2a3b40';
    ctx.fillRect(64*s,h-52*s,500*s,6*s);
    ctx.fillStyle=star.down>0?'#7b8a8c':'#9ff0c2';
    ctx.fillRect(64*s,h-52*s,500*s*clamp(star.down>0?0:star.hp/star.maxHp,0,1),6*s);
    if (star.down>0 && !finale) label('復帰まで '+Math.ceil(star.down)+' 秒',cx,h*.42,46,'#ffffff','center',900);
    // Splat feed.
    battle.events.forEach((event,i)=>{
      const y=130*s+i*38*s;
      plate(w-470*s,y,430*s,32*s,event.team===1?'rgba(110,44,18,.78)':event.team===0?'rgba(10,84,76,.78)':'rgba(70,40,90,.78)');
      label(event.label,w-455*s,y+17*s,18,'#f6f7ee',undefined,700);
    });
    if (battle.boss.active) {
      plate(cx-260*s,128*s,520*s,34*s,'rgba(60,28,82,.8)');
      label('オオモノイカ',cx-238*s,145*s,17,'#f3d4ff');
      ctx.fillStyle='#d091e8';
      ctx.fillRect(cx-110*s,140*s,340*s*clamp(battle.boss.hp/battle.boss.maxHp,0,1),10*s);
    }
    if (battle.countdown<=0 && battle.clock<4.2) label('GO!',cx,h*.36,120,'#19d9c0','center',900);
    if (finale) {
      const {title}=inkResult(paint);
      plate(cx-420*s,h*.34,840*s,210*s,'rgba(8,20,26,.86)');
      label(title,cx,h*.34+70*s,72,'#ffffff','center',900);
      label('MVP  '+star.name+'  ·  '+star.weapon.name+'  ·  撃破 '+star.kills,cx,h*.34+150*s,30,'#ffd58a','center');
    }
    label('INK//SHIFT  第07高架街区',w-40*s,h-40*s,18,'rgba(240,247,238,.6)','right',700);
    ctx.restore();
  }

  async run() {
    const {renderer,world,canvas,size,fps}=this, {width,height}=FILM_SIZES[size];
    const support=this.support ?? await filmSupport(renderer,size,fps);
    if (support.reason) throw new Error(support.reason);
    const {video,audio}=support;
    this.onProgress?.({phase:'analyze',done:0,total:1});
    const {star:starName}=await this.analyze();
    this.check();

    const saved={quality:renderer.quality,fixedSize:renderer.fixedSize,adaptive:renderer.adaptive,scale:renderer.scale};
    const writer=new Mp4Writer(), mixer=new FilmMixer();
    let videoEncoder, audioEncoder, failure=null, lock=null;
    const fail=error=>{failure??=error;};
    try {
      lock=await navigator.wakeLock?.request?.('screen').catch(()=>null);
      renderer.setQuality('high');
      renderer.fixedSize=[width,height];
      renderer.adaptive=false;
      renderer.scale=1;
      renderer.setSamples?.(size==='uhd'?2:4);
      const stage=document.createElement('canvas');
      stage.width=width;
      stage.height=height;
      const ctx=stage.getContext('2d',{alpha:false});

      const videoTrack=writer.addTrack('video',{codec:video.box,width,height,timescale:fps*100,vp9:video.vp9});
      videoEncoder=new VideoEncoder({error:fail,output:(chunk,meta)=>{
        const config=meta?.decoderConfig;
        if (config?.description) videoTrack.description=new Uint8Array(config.description.buffer ?? config.description,
          config.description.byteOffset ?? 0,config.description.byteLength);
        if (config?.colorSpace && !videoTrack.color) {
          const space=config.colorSpace, code={bt709:1,bt470bg:5,smpte170m:6,'iec61966-2-1':13,rgb:0};
          videoTrack.color={primaries:code[space.primaries]??1,transfer:code[space.transfer]??1,matrix:code[space.matrix]??1,
            fullRange:!!space.fullRange};
        }
        const data=new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        writer.addSample(videoTrack,data,100,chunk.type==='key',Math.round(chunk.timestamp*fps/1e4));
      }});
      videoEncoder.configure(video.config);
      let audioTrack=null, audioAt=0;
      if (audio) {
        audioTrack=writer.addTrack('audio',{codec:audio.box,channels:2,sampleRate:SAMPLE_RATE,timescale:SAMPLE_RATE,
          bitrate:audio.config.bitrate,description:Uint8Array.of(0x11,0x90)});
        audioEncoder=new AudioEncoder({error:fail,output:(chunk,meta)=>{
          const description=meta?.decoderConfig?.description;
          if (description) {
            const bytes=new Uint8Array(description.buffer ?? description,description.byteOffset ?? 0,description.byteLength);
            if (audio.box==='Opus') audioTrack.preSkip=bytes.length>=12?bytes[10]|bytes[11]<<8:312;
            else audioTrack.description=bytes.slice();
          }
          const data=new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          writer.addSample(audioTrack,data,chunk.duration?Math.round(chunk.duration*SAMPLE_RATE/1e6):audio.frame,true);
        }});
        audioEncoder.configure(audio.config);
      }

      // Second run: the same match again, this time drawn and heard.
      let pose=null, right=[1,0,0], star=null, battle=null;
      const heard=(kind,subject,source)=>{
        if (!pose || !subject) return;
        const at=battle.clock, own=subject===star;
        const place=()=>own?{gain:1,pan:0}:placeSound([subject.x,(subject.y??0)+1,subject.z],pose.eye,right,sameLevel(subject.x,pose.eye[0]));
        if (kind==='hit') {
          if (source===star) mixer.cue('hit',at,.9,0);
          if (own) mixer.cue('damage',at,1,0);
          else {
            const {gain,pan}=place();
            mixer.cue('hit',at,gain*.3,pan);
          }
          return;
        }
        if (kind==='down') {
          if (source===star) mixer.cue('down',at,1,0);
          const {gain,pan}=place();
          mixer.cue('splat',at,own?1:gain*.75,pan);
          return;
        }
        const {gain,pan}=place();
        mixer.cue(kind==='shot' && subject.weapon?.id==='lob'?'lob':kind,at,gain*(own?.8:.6),pan);
      };
      const match=this.match({cue:heard,sound:kind=>mixer.cue(kind,battle?.clock??0,.75,0)});
      battle=match.battle;
      const {paint}=match;
      star=battle.actors.find(actor=>actor.name===starName) ?? battle.actors[0];
      renderer.configureWorld?.(world,paint);
      const outro=Math.round(this.outro*fps);
      const dt=1/fps, matchFrames=Math.round((battle.duration+battle.countdown)*fps), total=matchFrames+outro;
      const began=performance.now();
      let frame=0, shown=0;
      const present=async finale=>{
        pose=this.view(battle,star,dt);
        right=unit(cross(sub(pose.target,pose.eye),[0,1,0]));
        renderer.clearDynamic();
        renderer.viewPoint=pose.eye;
        battle.draw(renderer,pose.eye[0],pose.eye[2],pose.nearCrew?star:null,pose.eye[1],pose.stair);
        renderer.draw(pose,paint,battle.clock);
        ctx.drawImage(canvas,0,0,width,height);
        this.overlay(ctx,battle,paint,star,finale);
        const picture=new VideoFrame(stage,{timestamp:Math.round(frame*1e6/fps),duration:Math.round(1e6/fps)});
        videoEncoder.encode(picture,{keyFrame:frame%(fps*2)===0});
        picture.close();
        if (audioEncoder) {
          const due=Math.round((frame+1)*SAMPLE_RATE/fps);
          while (audioAt<due) {
            const count=Math.min(4096,due-audioAt), [left,rightChannel]=mixer.render(count);
            const data=new Float32Array(count*2);
            data.set(left,0);
            data.set(rightChannel,count);
            const samples=new AudioData({format:'f32-planar',sampleRate:SAMPLE_RATE,numberOfFrames:count,numberOfChannels:2,
              timestamp:Math.round(audioAt*1e6/SAMPLE_RATE),data});
            audioEncoder.encode(samples);
            samples.close();
            audioAt+=count;
          }
        }
        frame++;
        if (failure) throw failure;
        // Keep the encoder's queue short, and the page responsive.
        while (videoEncoder.encodeQueueSize>3) {
          await new Promise(resolve=>videoEncoder.addEventListener('dequeue',resolve,{once:true}));
          if (failure) throw failure;
        }
        const now=performance.now();
        if (now-shown>120) {
          shown=now;
          const rate=frame/Math.max(.001,(now-began)/1000);
          this.onProgress?.({phase:'render',done:frame,total,rate,remaining:(total-frame)/Math.max(.01,rate),star:star.name,
            weapon:star.weapon.name,clock:battle.clock,bytes:writer.bytes});
          await idle();
          this.check();
        }
      };
      while (!battle.finished) {
        battle.update(dt,NEUTRAL,null);
        await present(false);
      }
      for (let i=0;i<outro;i++) await present(true);
      this.onProgress?.({phase:'finish',done:frame,total:frame});
      await videoEncoder.flush();
      if (audioEncoder) await audioEncoder.flush();
      if (failure) throw failure;
      const blob=writer.finish();
      return {blob,name:'inkshift-npc-battle-'+(size==='uhd'?'4k':'fhd')+'-'+fps+'fps.mp4',frames:frame,seconds:frame/fps,
        star:star.name,weapon:star.weapon.name,kills:star.kills,video:video.label,audio:audio?audio.label+' '+Math.round(audio.config.bitrate/1000)+'kbps':null,
        bitrate:video.config.bitrate,elapsed:(performance.now()-began)/1000};
    } finally {
      for (const encoder of [videoEncoder,audioEncoder]) {
        try { if (encoder && encoder.state!=='closed') encoder.close(); } catch { /* Already closed. */ }
      }
      renderer.fixedSize=saved.fixedSize;
      renderer.adaptive=saved.adaptive;
      renderer.scale=saved.scale;
      renderer.setSamples?.(4);
      renderer.setQuality(saved.quality);
      lock?.release?.().catch(()=>{});
    }
  }
}
