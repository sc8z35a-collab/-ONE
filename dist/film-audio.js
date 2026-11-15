// Sound for the offline film: every cue from the match is synthesised into a
// 48 kHz stereo mix, placed by its direction and distance from the camera,
// over a quiet procedural beat. The mix is produced in step with the frames.

export const SAMPLE_RATE=48000;
const TAU=Math.PI*2;

// frequency sweep (Hz), length (s), level, noise share, noise colour (Hz)
const VOICES={
  shot:[260,114,.11,.42,.5,980],
  lob:[142,190,.19,.5,.45,520],
  roll:[180,120,.12,.3,.6,700],
  blast:[96,42,.38,.9,.75,420],
  bomb:[104,46,.42,.95,.7,360],
  sub:[320,210,.14,.35,.3,900],
  hit:[840,1126,.10,.5,.25,2400],
  damage:[127,74,.19,.55,.4,520],
  down:[730,978,.29,.6,.1,1800],
  splat:[210,70,.32,.6,.6,600],
  super:[620,830,.34,.6,.1,1500],
  drone:[440,590,.22,.4,.1,1500],
  'drone-shot':[520,300,.09,.3,.4,1400],
  mark:[988,1320,.18,.45,0,0],
  tick:[554,742,.13,.5,0,0],
  go:[830,1112,.36,.6,0,0],
  boss:[110,147,.75,.75,.3,300],
  bossDown:[493,660,.62,.6,.1,900],
  finish:[660,884,.6,.6,0,0]
};

// A minor, F, C, G: two bars each at 120 beats a minute.
const CHORDS=[[110,261.63,329.63,440],[87.31,261.63,349.23,440],[130.81,261.63,329.63,392],[98,246.94,293.66,392]];
const BEAT=.5;

export class FilmMixer {
  constructor() {
    this.voices=[];
    this.sample=0;
    this.seed=0x2f6e2b1;
  }

  noise() {
    this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;
    return this.seed/2147483648-1;
  }

  // Queues a cue at `time` seconds; `pan` runs from -1 (left) to 1 (right).
  cue(kind,time,gain=1,pan=0) {
    const spec=VOICES[kind];
    if (!spec || !(gain>.004)) return;
    if (this.voices.length>=56) {
      // Too many at once: the quietest gives way.
      let quiet=0;
      for (let i=1;i<this.voices.length;i++) if (this.voices[i].gain<this.voices[quiet].gain) quiet=i;
      if (this.voices[quiet].gain>=gain) return;
      this.voices.splice(quiet,1);
    }
    const angle=(Math.max(-1,Math.min(1,pan))+1)*Math.PI/4;
    this.voices.push({spec,start:Math.round(time*SAMPLE_RATE),gain,left:Math.cos(angle),right:Math.sin(angle),phase:0,low:0,band:0});
  }

  music(time,out) {
    const beat=time/BEAT, bar=Math.floor(beat/4), chord=CHORDS[Math.floor(bar/2)%CHORDS.length];
    const inBeat=beat-Math.floor(beat), t=inBeat*BEAT;
    // Kick on every beat, a soft hat on the off-beat.
    let mono=Math.sin(TAU*(52*t+58*(1-Math.exp(-t*26))/26))*Math.exp(-t*11)*.5;
    const off=(beat+.5)-Math.floor(beat+.5);
    if (off<.09) mono+=this.noise()*Math.exp(-off*BEAT*90)*.07;
    // Eighth-note bass on the chord root.
    const eighth=beat*2-Math.floor(beat*2), bt=eighth*BEAT*.5;
    const root=chord[0], bass=Math.sin(TAU*root*time)+.35*Math.sin(TAU*root*2*time);
    mono+=bass*Math.min(1,bt*200)*Math.exp(-bt*7)*.2;
    // A slow pad on the upper chord tones, spread across the field.
    const swell=.5-.5*Math.cos(TAU*(beat/8-Math.floor(beat/8)));
    const padL=Math.sin(TAU*chord[1]*time)+Math.sin(TAU*chord[3]*1.003*time);
    const padR=Math.sin(TAU*chord[2]*time)+Math.sin(TAU*chord[3]*.997*time);
    out[0]=mono+padL*.035*(.4+.6*swell);
    out[1]=mono+padR*.035*(.4+.6*swell);
  }

  // Renders the next `frames` samples into two Float32Arrays.
  render(frames,musicLevel=.55) {
    const left=new Float32Array(frames), right=new Float32Array(frames), bed=[0,0];
    const first=this.sample;
    for (let i=0;i<frames;i++) {
      this.music((first+i)/SAMPLE_RATE,bed);
      left[i]=bed[0]*musicLevel;
      right[i]=bed[1]*musicLevel;
    }
    for (let v=this.voices.length-1;v>=0;v--) {
      const voice=this.voices[v], [from,to,length,level,grit,colour]=voice.spec;
      const total=Math.round(length*SAMPLE_RATE), begin=Math.max(0,voice.start-first);
      const cut=colour?Math.min(.9,TAU*colour/SAMPLE_RATE):0;
      for (let i=begin;i<frames;i++) {
        const n=first+i-voice.start;
        if (n>=total) break;
        const p=n/total;
        // A fast attack and an exponential tail, with the pitch sliding along.
        const envelope=Math.min(1,n/(.004*SAMPLE_RATE))*Math.exp(-p*4.6);
        voice.phase+=TAU*(from*Math.pow(to/from,Math.min(1,p*1.37)))/SAMPLE_RATE;
        let value=Math.sin(voice.phase)*(1-grit);
        if (grit) {
          // A state-variable band-pass keeps the burst near its colour.
          const white=this.noise();
          voice.low+=cut*voice.band;
          voice.band+=cut*(white-voice.low-voice.band*.9);
          value+=voice.band*grit*1.6;
        }
        value*=envelope*level*voice.gain;
        left[i]+=value*voice.left;
        right[i]+=value*voice.right;
      }
      if (first+frames-voice.start>=total) this.voices.splice(v,1);
    }
    // A soft limiter keeps a crowded fight from clipping.
    for (let i=0;i<frames;i++) {
      left[i]=Math.tanh(left[i]*1.15)*.86;
      right[i]=Math.tanh(right[i]*1.15)*.86;
    }
    this.sample+=frames;
    return [left,right];
  }
}

// Level and pan of a sound heard from the camera.
export function placeSound(source,eye,rightVector,sameLevel=true) {
  if (!sameLevel) return {gain:0,pan:0};
  const dx=source[0]-eye[0], dy=source[1]-eye[1], dz=source[2]-eye[2];
  const range=Math.hypot(dx,dy,dz);
  if (range>75) return {gain:0,pan:0};
  const gain=1/(1+(range/8.5)**2);
  const pan=range>.4?(dx*rightVector[0]+dz*rightVector[2])/range:0;
  return {gain,pan:pan*.85};
}
