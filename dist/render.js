import {FILM_HEIGHT_ORIGIN,FILM_HEIGHT_STEP,FILM_HEIGHT_TOLERANCE} from './ink-fluid.js';
import {CABIN_X,CABIN_Y,CITY_RADIUS,RAIL_CABIN_X,UNDER_X,UNDER_Y,ZONES,interiorBlend,zoneOf} from './layout.js';

export const TAU = Math.PI * 2;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const mix = (a, b, t) => a + (b - a) * t;
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (v) => scale(v, 1 / Math.max(0.00001, Math.hypot(...v)));
export const forward = (yaw, pitch = 0) => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
export const color = (hex) => [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

export const SUN = unit([-0.41, 0.80, 0.43]);
const UP = [0, 1, 0];
export const STRIDE = 24;
const FOV = 58 * Math.PI / 180;
const LABELS = [
  '07', 'OVERPASS', 'SERVICE BAY', 'DELIVERY', '24H MARKET', 'PARKING',
  'CITY WORKS', 'ROAD CLOSED', 'CAUTION', 'ROUTE 07', 'KIOSK', 'GARAGE',
  'WAREHOUSE', 'LOADING', 'NORTH LINE', 'COFFEE', 'METRO', 'REPAIR', 'EAST',
  'WEST', 'BUS STOP', 'SLOW', 'FREIGHT', 'NO STEP', 'P-02', 'A-17',
  'UNDERPASS', 'WORKSHOP', 'DECK 02', 'SHIFT', '07 / CENTRAL', 'MARKET',
  'B1 LIFT', 'EXIT / 01', 'WEST PLATFORM', 'EAST PLATFORM', 'B1 EXCHANGE', 'STORAGE', 'NORTH EXPRESS', '07 LOCAL', 'B1 METRO', 'B1 LOOP', 'WEST GATE', 'EAST GATE', 'CAR 01', 'CAR 02', 'EXIT', 'LINE B1', 'B1 STAIRS', 'STREET EXIT',
  '01 GROUND WEST','02 GROUND EAST','03 B1 EAST','04 B1 WEST',
  'STATION KIOSK','FRESH MARKET','CORNER MART','BAKERY','TERRACE CAFE',
  'PHARMACY','PRODUCE','FLORIST','CYCLE WORKS','LAUNDRY',
  'WEST RESIDENCE','EAST RESIDENCE','COURTYARD 03'
];
const ATLAS_COLUMNS=4, ATLAS_ROWS=Math.ceil(LABELS.length/ATLAS_COLUMNS);
const TRANSPARENT_MESHES=['quad','ripple','curtain','glass','hazard'];
const ZONE_BATCHES=['static','lower','cabin','railCabin'];

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

export function view(eye, target) {
  const back = unit(sub(eye, target));
  const right = unit(cross(UP, back));
  const up = cross(back, right);
  return new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1
  ]);
}

export function perspective(aspect) {
  const s = 1 / Math.tan(FOV / 2);
  const near = 0.12, far = 1200;
  return new Float32Array([s / aspect, 0, 0, 0, 0, s, 0, 0, 0, 0, (near + far) / (near - far), -1, 0, 0, 2 * near * far / (near - far), 0]);
}

function ortho(x, y, near, far) {
  return new Float32Array([1 / x, 0, 0, 0, 0, 1 / y, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
}

function makeMesh() {
  const vertices = [], indices = [];
  return {
    vertices, indices,
    vertex(p, n, uv = [0, 0]) {
      const index = vertices.length / 8;
      vertices.push(...p, ...n, ...uv);
      return index;
    },
    face(points, normal) {
      const n = normal || unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
      const start = vertices.length / 8;
      const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
      points.forEach((p, i) => this.vertex(p, n, uv[i]));
      for (let i = 1; i < points.length - 1; i++) indices.push(start, start + i, start + i + 1);
    }
  };
}

function block(ramp = false) {
  const mesh = makeMesh();
  const a = [-.5,-.5,-.5], b = [.5,-.5,-.5], c = [.5,-.5,.5], d = [-.5,-.5,.5];
  const e = [-.5,ramp ? -.5 : .5,-.5], f = [.5,.5,-.5], g = [.5,.5,.5], h = [-.5,ramp ? -.5 : .5,.5];
  mesh.face([a,b,c,d], [0,-1,0]);
  mesh.face([h,g,f,e], ramp ? unit([-1,1,0]) : [0,1,0]);
  mesh.face([d,c,g,h], [0,0,1]);
  mesh.face([b,a,e,f], [0,0,-1]);
  if (!ramp) mesh.face([a,d,h,e], [-1,0,0]);
  mesh.face([c,b,f,g], [1,0,0]);
  return mesh;
}

function beveledBlock(lowDetail) {
  const mesh=makeMesh();
  const steps=lowDetail?[-.5,-.416,.416,.5]:[-.5,-.465,-.416,.416,.465,.5];
  for (let axis=0;axis<3;axis++) for (const sign of [-1,1]) {
    const base=mesh.vertices.length/8;
    for (const u of steps) for (const v of steps) {
      const p=[0,0,0];
      p[axis]=sign*.5;
      p[(axis+1)%3]=u;
      p[(axis+2)%3]=v;
      const core=p.map(n=>clamp(n,-.413,.413));
      const n=unit(sub(p,core));
      mesh.vertex(add(core,scale(n,.087)),n,[u+.5,v+.5]);
    }
    for (let i=0;i<steps.length-1;i++) for (let j=0;j<steps.length-1;j++) {
      const k=base+i*steps.length+j;
      mesh.indices.push(k,k+1,k+steps.length,k+1,k+steps.length+1,k+steps.length);
    }
  }
  return mesh;
}

function rippleMesh() {
  const mesh=makeMesh();
  for (let i=0;i<=30;i++) {
    const a=i/30*TAU, x=Math.cos(a), z=Math.sin(a);
    for (const [radius,t] of [[.392,0],[.455,.51],[.50,1]]) {
      mesh.vertex([x*radius,0,z*radius],[0,1,0],[i/30,t]);
    }
    if (!i) continue;
    const b=i*3;
    mesh.indices.push(b-3,b-2,b,b,b-2,b+1,b-2,b-1,b+1,b+1,b-1,b+2);
  }
  return mesh;
}

export function hazardDisk(lowDetail) {
  const mesh=makeMesh(), slices=lowDetail?24:72;
  for (let i=0;i<slices;i++) {
    const u=i/slices,v=(i+1)/slices, a=u*TAU,b=v*TAU, n=[0,1,0];
    const origin=mesh.vertex([0,0,0],n,[(u+v)*.5,0]);
    const end=mesh.vertex([Math.sin(b)*.5,0,-Math.cos(b)*.5],n,[v,1]);
    const start=mesh.vertex([Math.sin(a)*.5,0,-Math.cos(a)*.5],n,[u,1]);
    mesh.indices.push(origin,end,start);
  }
  return mesh;
}

function ringMesh(lowDetail) {
  const mesh=makeMesh(), around=lowDetail?12:36, tube=lowDetail?5:10;
  for (let i=0;i<=around;i++) for (let j=0;j<=tube;j++) {
    const a=i/around*TAU, b=j/tube*TAU, ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b);
    mesh.vertex([ca*(.39+.11*cb),.11*sb,sa*(.39+.11*cb)],[ca*cb,sb,sa*cb],[i/around,j/tube]);
    if (i && j) {
      const k=i*(tube+1)+j;
      mesh.indices.push(k,k-1,k-tube-1,k-1,k-tube-2,k-tube-1);
    }
  }
  return mesh;
}

export function mantleMesh(lowDetail) {
  const mesh=makeMesh(), sides=lowDetail?16:56, rows=lowDetail?10:30;
  const point=(t,angle)=>{
    const shape=Math.pow(Math.max(0,Math.sin(Math.PI*t)),.56);
    const radius=.49*shape*(1.16-.38*t)*(1+.055*Math.cos(angle*6)*shape);
    return [Math.cos(angle)*radius,t-.5,Math.sin(angle)*radius-.084*t*t];
  };
  for (let i=0;i<=rows;i++) for (let j=0;j<=sides;j++) {
    const t=i/rows, angle=j/sides*TAU, p=point(t,angle);
    const vertical=sub(point(Math.min(1,t+.002),angle),point(Math.max(0,t-.002),angle));
    const around=sub(point(t,angle+.003),point(t,angle-.003));
    const normal=i===0?[0,-1,0]:i===rows?[0,1,0]:unit(cross(vertical,around));
    mesh.vertex(p,normal,[j/sides,t]);
    if (i>0 && j>0) {
      const k=i*(sides+1)+j;
      mesh.indices.push(k-sides-2,k-1,k-sides-1,k-1,k,k-sides-1);
    }
  }
  return mesh;
}

function radial(sphere, sides, rows = 1, taper = 1) {
  const mesh = makeMesh();
  for (let i = 0; i <= rows; i++) {
    const latitude = Math.PI * (i / rows - .5);
    const radius = sphere ? Math.cos(latitude) * .5 : mix(.5, .5 * taper, i / rows);
    const y = sphere ? Math.sin(latitude) * .5 : i / rows - .5;
    for (let j = 0; j <= sides; j++) {
      const angle = TAU * j / sides;
      const x = Math.cos(angle), z = Math.sin(angle);
      mesh.vertex([x * radius, y, z * radius], sphere ? [x * Math.cos(latitude), Math.sin(latitude), z * Math.cos(latitude)] : unit([x, .5 * (1 - taper), z]), [j / sides, i / rows]);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < sides; j++) {
    const k = i * (sides + 1) + j;
    mesh.indices.push(k, k + 1, k + sides + 1, k + 1, k + sides + 2, k + sides + 1);
  }
  if (!sphere) {
    for (const edge of [0, 1]) {
      const y = edge - .5, r = edge ? .5 * taper : .5;
      const center = mesh.vertex([0,y,0], [0,edge ? 1 : -1,0]);
      for (let j = 0; j <= sides; j++) {
        const angle = TAU * j / sides;
        mesh.vertex([Math.cos(angle) * r,y,Math.sin(angle) * r], [0,edge ? 1 : -1,0]);
        if (j) mesh.indices.push(center, center + j, center + j + 1);
      }
    }
  }
  return mesh;
}

export const splatRadius=angle=>.36+.095*Math.sin(angle*5+.3)+.055*Math.cos(angle*9)+.035*Math.sin(angle*13);

function panel(splat = false) {
  const mesh = makeMesh();
  if (!splat) mesh.face([[-.5,-.5,0],[.5,-.5,0],[.5,.5,0],[-.5,.5,0]], [0,0,1]);
  else {
    mesh.vertex([0,0,0], [0,0,1]);
    for (let j = 0; j <= 29; j++) {
      const angle = TAU * j / 29;
      const r = splatRadius(angle);
      mesh.vertex([r * Math.cos(angle),r * Math.sin(angle),0], [0,0,1]);
      if (j) mesh.indices.push(0,j,j + 1);
    }
  }
  return mesh;
}

function triangleDecal() {
  const mesh=makeMesh();
  mesh.face([[0,0,0],[1,0,0],[0,1,0]],[0,0,1]);
  return mesh;
}

function windowPane() {
  const mesh=panel();
  mesh.face([[.5,-.5,0],[-.5,-.5,0],[-.5,.5,0],[.5,.5,0]],[0,0,-1]);
  return mesh;
}

export function instanceBasis(opts) {
  if (opts.basis) return opts.basis;
  const yaw=opts.yaw || 0,pitch=opts.pitch || 0;
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cx=Math.cos(pitch),sx=Math.sin(pitch);
  return [[cy,0,-sy],[sy*sx,cx,cy*sx],[sy*cx,-sx,cy*cx]];
}

export function meshes(lowDetail = false) {
  return {
    box:block(),ramp:block(true),bevel:beveledBlock(lowDetail),cylinder:radial(false,lowDetail?9:24),
    taper:radial(false,lowDetail?8:18,1,.67),cone:radial(false,lowDetail?9:24,1,.025),orb:radial(true,lowDetail?7:24,lowDetail?4:16),mantle:mantleMesh(lowDetail),quad:panel(),splat:panel(true),tri:triangleDecal(),ripple:rippleMesh(),hazard:hazardDisk(lowDetail),ring:ringMesh(lowDetail),curtain:windowPane(),glass:windowPane()
  };
}

const sceneVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
layout(location=8) in vec4 aTint;
layout(location=9) in vec4 aExtra;
uniform mat4 uVP;
uniform mat4 uLight;
uniform float uClock;
uniform float uDrawOffset;
uniform bool uMergeStairs;
out vec3 vPos;
out vec3 vNormal;
out vec3 vLight;
out vec2 vUV;
flat out vec4 vTint;
flat out vec4 vExtra;
void main() {
  vec4 p = mat4(a0,a1,a2,a3)*vec4(aPos,1.);
  vPos = p.xyz;
  p.x += uDrawOffset;
  vNormal = normalize(transpose(inverse(mat3(a0.xyz,a1.xyz,a2.xyz)))*aNormal);
  vLight = (uLight*p).xyz*.5+.5;
  vUV = aUV;
  vTint = aTint;
  vExtra = aExtra;
  gl_Position = uMergeStairs && aExtra.z>.5 ? vec4(2.,2.,2.,1.) : uVP*p;
}`;

const sceneFragment = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec3 vPos;
in vec3 vNormal;
in vec3 vLight;
in vec2 vUV;
flat in vec4 vTint;
flat in vec4 vExtra;
uniform vec3 uEye;
uniform vec3 uSun;
uniform sampler2D uShadow;
uniform sampler2DArray uInk;
uniform sampler2D uAtlas;
uniform vec2 uAtlasGrid;
uniform sampler2D uReflection;
uniform vec2 uViewport;
uniform bool uMirrorPass;
uniform bool uEffects;
uniform bool uLite;
uniform float uInterior;
uniform float uZoneX;
uniform float uUnderX;
uniform float uUnderY;
uniform float uCabinX;
uniform float uRailCabinX;
uniform float uCabinY;
uniform vec2 uTexel;
uniform vec2 uInkTexel;
uniform float uClock;
uniform vec2 uInkBounds;
out vec4 frag;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx)*.1031);
  q += dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 s = f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),s.x),mix(hash(i+vec2(0,1)),hash(i+1.),s.x),s.y);
}

vec3 linearColor(vec3 c) { return pow(max(c,vec3(0.)),vec3(2.2)); }
vec3 displayColor(vec3 c) {
  c=max(c,vec3(0.))*.91;
  float luminance=dot(c,vec3(.2126,.7152,.0722));
  float mapped=(luminance*(2.51*luminance+.03))/(luminance*(2.43*luminance+.59)+.14);
  vec3 channel=(c*(2.51*c+.03))/(c*(2.43*c+.59)+.14);
  c=mix(channel,c*mapped/max(.0001,luminance),.58);
  return pow(clamp(c,0.,1.),vec3(1./2.2));
}

vec3 environment(vec3 ray,float roughness) {
  float elevation=clamp(ray.y*.5+.5,0.,1.);
  vec3 sky=mix(vec3(.64,.76,.81),vec3(.23,.49,.73),pow(elevation,1.35));
  sky=mix(vec3(.23,.25,.22),sky,smoothstep(-.27,.17,ray.y));
  if (!uLite) {
    vec2 p=ray.xz/max(.16,ray.y+.32)*2.3+vec2(uClock*.0045,0.);
    float cloud=smoothstep(.48,.72,noise(p)*.70+noise(p*2.1)*.30);
    sky=mix(sky,vec3(.85,.88,.86),cloud*smoothstep(.02,.25,ray.y)*(.70-roughness*.34));
    float skyline=hash(vec2(floor(atan(ray.x,ray.z)*27.),17.))*.095;
    sky=mix(sky,vec3(.34,.43,.44),(1.-smoothstep(0.,.014,abs(ray.y-.023)-skyline))*.36);
  }
  return sky;
}

// Trace into a virtual room behind each window; the side walls move with the eye.
vec3 windowRoom(vec2 uv,vec3 normal,vec3 eyeDir,float seed) {
  vec3 tangent=abs(normal.x)>.6?vec3(0,0,1):vec3(1,0,0);
  vec3 origin=vec3(clamp(uv,0.,1.)-.5,0.);
  vec3 ray=vec3(-dot(eyeDir,tangent)/2.2,-eyeDir.y/2.3,max(dot(normal,eyeDir),.08)/3.6);
  vec2 safe=(step(vec2(0.),ray.xy)*2.-1.)*max(abs(ray.xy),vec2(.00001));
  vec2 side=(sign(safe)*.5-origin.xy)/safe;
  float back=1./ray.z, t=min(back,min(side.x,side.y));
  vec3 hit=origin+ray*t;
  vec3 room=mix(vec3(.53,.61,.58),vec3(.74,.66,.50),seed);
  float floorHit=step(side.y,min(back,side.x))*step(ray.y,0.);
  float ceiling=step(side.y,min(back,side.x))*step(0.,ray.y);
  float backHit=step(back,min(side.x,side.y));
  room*=mix(.61,1.,backHit);
  room=mix(room,vec3(.28,.30,.25),floorHit);
  room=mix(room,vec3(.84,.83,.74),ceiling);
  float shelf=(1.-smoothstep(.012,.026,abs(hit.y+.12)))*step(-.40,hit.x)*step(hit.x,.37);
  float cabinet=step(-.40,hit.x)*step(hit.x,-.11)*step(-.48,hit.y)*step(hit.y,-.16);
  float curtain=step(.39,abs(hit.x))*(.74+.16*sin(hit.x*170.));
  room=mix(room,vec3(.31,.37,.32),backHit*max(shelf,cabinet)*.74);
  room=mix(room,vec3(.78,.77,.67),curtain*.64);
  return room;
}

vec3 specularBRDF(vec3 n,vec3 v,vec3 l,vec3 f0,float roughness) {
  vec3 h=normalize(l+v);
  float nv=max(dot(n,v),.001), nl=max(dot(n,l),.001), nh=max(dot(n,h),0.);
  float alpha=roughness*roughness, a2=alpha*alpha;
  float denominator=nh*nh*(a2-1.)+1.;
  float distribution=a2/max(3.14159*denominator*denominator,.00002);
  float k=(roughness+1.)*(roughness+1.)*.125;
  float visibility=(nv/(nv*(1.-k)+k))*(nl/(nl*(1.-k)+k));
  vec3 fresnel=f0+(1.-f0)*pow(1.-max(dot(v,h),0.),5.);
  return distribution*visibility*fresnel/max(4.*nv*nl,.001);
}

vec3 reliefNormal(vec3 n,vec2 gradient,float amount) {
  vec3 tangent=abs(n.y)>.6?vec3(1,0,0):abs(n.x)>.6?vec3(0,0,1):vec3(1,0,0);
  vec3 bitangent=abs(n.y)>.6?vec3(0,0,1):vec3(0,1,0);
  return normalize(n-tangent*gradient.x*amount-bitangent*gradient.y*amount);
}

float shadow(vec3 n) {
  if (vLight.z<0. || vLight.z>1. || any(lessThan(vLight.xy,vec2(.003))) || any(greaterThan(vLight.xy,vec2(.997)))) return 1.;
  float bias = max(.00036,.00122*(1.-dot(n,uSun)));
  float result = 0., total = 0.;
  for (int j=-1; j<=1; ++j) for (int i=-1; i<=1; ++i) {
    float weight=(i==0?2.:1.)*(j==0?2.:1.);
    result += weight*step(vLight.z-bias,texture(uShadow,vLight.xy+vec2(float(i),float(j))*uTexel*1.47).r);
    total+=weight;
  }
  return result/total;
}

vec3 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance) {
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${FILM_HEIGHT_ORIGIN.toFixed(1)}+(round(cell.a*255.)-1.)*${FILM_HEIGHT_STEP};
  return cell.a>0. && abs(height-bed)<tolerance?cell.rgb:vec3(0.);
}

void main() {
  if (uMirrorPass && vPos.y<.037) discard;
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye-vPos);
  vec3 base = vTint.rgb;
  int kind = int(vTint.a+.5);
  if (kind==22 && n.y<.5) discard;
  vec2 xz = vPos.xz;
  vec2 wall = abs(n.x) > .6 ? vPos.zy : vPos.xy;
  vec2 tex = abs(n.y) > .6 ? xz : wall;
  float viewDist = length(uEye-vPos);
  float grain = (hash(floor(tex*128.))-.5)*(1.-smoothstep(8.,60.,viewDist));
  grain*=1.-smoothstep(.40,1.50,max(length(dFdx(tex)),length(dFdy(tex)))*128.);
  float grime = noise(tex*.65);
  float rough = .55;
  float gloss = .0;
  float metal = 0.;

  if (kind==24) {
    float r=vUV.y, u=vUV.x, age=vExtra.x, fade=clamp(vExtra.w-1.,0.,1.);
    float angle=(u>.5?u-1.:u)*6.2831853, halfAngle=vExtra.y*3.14159265;
    bool sector=halfAngle>.001;
    if (sector && abs(angle)>halfAngle) discard;
    float soft=max(.006,fwidth(r)*.78);
    float rim=1.-smoothstep(.012,.045+soft,abs(r-.961));
    float seam=sector?smoothstep(halfAngle-.056,halfAngle,abs(angle))*.81:0.;
    float ticks=step(.67,fract(u*48.))*smoothstep(.78,.89,r)*.48;
    float phase=sector?clamp((angle+halfAngle)/(2.*halfAngle),0.,1.):r;
    float wave=1.-smoothstep(.015,.075+soft,abs(phase-age));
    float fragments=.54+.46*sin(r*57.-uClock*10.+sin(u*50.));
    float hatching=(1.-smoothstep(.18,.49,abs(fract((vPos.x+vPos.z)*1.62-uClock*.35)-.5)))*.31;
    if (vExtra.w<1.) {
      float light=max(max(rim,seam),wave*.85);
      vec3 emission=mix(base*.94,vec3(1.,.95,.96),light*.77);
      float alpha=max(rim*.77,seam*.77)+ticks*.18+wave*.30+(.075+hatching*.27+fragments*.053)*(.55+.45*age);
      frag=vec4(emission,min(.96,alpha));
    } else {
      float charge=max(wave*.91,rim*.27);
      float trail=step(phase,age+.045)*(.24+fragments*.22)*max(.11,1.-fade);
      frag=vec4(mix(base*.91,vec3(1.,.90,.91),charge*.8),min(.86,trail+charge*.68)*(1.-fade));
    }
    return;
  }
  if (kind==25) {
    float rim=pow(1.-max(0.,dot(n,v)),2.5);
    float veins=sin(vUV.x*32.+vUV.y*21.-uClock*19.+noise(vUV*8.)*3.7);
    float streak=smoothstep(.42,.96,veins)*.55+rim*.46;
    vec3 liquid=base*(.87+.26*max(dot(n,uSun),0.)+.12*veins);
    frag=vec4(mix(liquid,vec3(1.,.92,1.),clamp(streak,.04,.86)),1.);
    return;
  }
  if (kind==17) {
    if (dot(n,v)<=0.) discard;
    float edge=1.-smoothstep(.01,.035,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float fresnel=pow(1.-abs(dot(n,v)),3.);
    vec3 reflection=environment(reflect(-v,n),.12);
    vec3 glass=mix(vTint.rgb*.80,reflection,.32+fresnel*.46);
    float sunGlint=pow(max(dot(reflect(-uSun,n),v),0.),420.);
    frag=vec4(glass+vec3(1.,.96,.84)*sunGlint*.35,.13+fresnel*.32+edge*.16);
    return;
  }
  if (kind==16) {
    if (dot(n,v)<=0.) discard;
    float border=1.-smoothstep(.012,.065,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float flow=.5+.5*sin(vUV.x*45.+vUV.y*13.-uClock*5.);
    frag=vec4(vTint.rgb*(.92+border*.24),(.20+border*.44+flow*.08)*(1.-vExtra.x*.64));
    return;
  }
  if (kind==12) {
    float contour=sin(vUV.y*3.14159)*(.65+.35*sin(vUV.x*21.+uClock*8.));
    frag=vec4(vTint.rgb,max(0.,contour)*(.46*(1.-vExtra.x)));
    return;
  }
  if (kind==7) {
    if (dot(n,v)<=0.) discard;
    float index = vExtra.x;
    vec2 tile = vec2(mod(index,uAtlasGrid.x),floor(index/uAtlasGrid.x));
    vec2 uv = (tile+vec2(mix(.01,.99,vUV.x),mix(.02,.98,1.-vUV.y)))/uAtlasGrid;
    float alpha=texture(uAtlas,uv).a;
    if (alpha<.012) discard;
    vec3 haze=mix(vec3(.73,.84,.89),vec3(.44,.53,.49),uInterior);
    frag=vec4(mix(base,haze,smoothstep(24.,120.,viewDist)*.64),alpha);
    return;
  }
  if (kind==1 || kind==5 || kind==15) {
    float stain = noise(tex*.21) * noise(tex*1.4);
    base *= .94 + .13 * grime - .18 * stain + grain * .11;
    if (!uLite) {
      vec2 grainUV=tex*24.;
      float center=noise(grainUV);
      vec2 slope=vec2(noise(grainUV+vec2(.17,0.)),noise(grainUV+vec2(0.,.17)))-center;
      float footprint=max(length(dFdx(grainUV)),length(dFdy(grainUV)));
      n=reliefNormal(n,slope,(kind==5?.18:.12)*(1.-smoothstep(.55,2.,footprint)));
      float aggregate=smoothstep(.70,.87,noise(tex*63.));
      base*=1.-aggregate*.18*(1.-smoothstep(6.,24.,viewDist));
    }
    if (kind==1) {
      vec2 seams = abs(fract(tex/vec2(3.4,4.1)+.5)-.5);
      float cut = min(seams.x,seams.y);
      base *= mix(.83,1.,smoothstep(.001,.007,cut));
    } else {
      float puddle = smoothstep(.41,.68,noise(xz*.30)*.66+noise(xz*1.07)*.34);
      gloss = .18 + puddle*.66;
      rough = mix(.78,.19,puddle);
      base *= 1.-puddle*.18;
    }
  } else if (kind==2 || kind==4) {
    base *= .92 + grime * .14 + grain*.07;
    float streak = noise(vec2(tex.x*5.7,tex.y*.32)) * noise(tex*.81);
    base = mix(base,vec3(.47,.35,.25),smoothstep(.43,.83,streak)*.19);
    rough = kind==4 ? .26 : .68;
    gloss = kind==4 ? .45 : .2;
    if (kind==4) {
      metal=.62;
      float brush=sin(tex.y*190.+noise(tex*3.8)*7.);
      base*=1.+brush*.021*(1.-smoothstep(5.,22.,viewDist));
      rough+=noise(tex*17.)*.10;
    }
  } else if (kind==13) {
    vec2 tiles=wall/vec2(.69,.296);
    tiles.x += mod(floor(tiles.y),2.)*.5;
    vec2 uv=fract(tiles);
    float join=min(min(uv.x,1.-uv.x)*.69,min(uv.y,1.-uv.y)*.296);
    float mortar=1.-smoothstep(.010,.024+fwidth(join)*.24,join);
    float stone=hash(floor(tiles));
    base *= .91+stone*.20+grime*.105+grain*.12;
    base = mix(base,vec3(.72,.67,.57),mortar*.68*(1.-smoothstep(28.,85.,viewDist)));
    rough=.72;
  } else if (kind==14) {
    float leaf=noise(vPos.xz*13.6+vPos.y*5.8)*.58+noise(vPos.xz*4.6-vPos.y*1.7)*.42;
    base *= .69+leaf*.52;
    base += vec3(.09,.10,.026)*pow(max(dot(v,-uSun),0.),2.0);
    rough=.70;
  } else if (kind==6) {
    float ripple = sin(xz.x*4.3+xz.y*1.9+uClock*.9)*sin(xz.y*4.7-xz.x*.9-uClock*.82);
    n = normalize(vec3(ripple*.066,1.,cos(xz.x*2.7+xz.y*1.8+uClock*.8)*.055));
    gloss = .86;
    rough = .18;
  } else if (kind==8 || (kind==11 && abs(n.y)<.52)) {
    float fresnel = pow(1.-abs(dot(n,v)),5.);
    vec3 reflected=environment(reflect(-v,n),.14);
    vec3 glass = mix(vTint.rgb*.60,reflected,.56+fresnel*.34);
    if (kind==11) {
      vec2 cell=wall/vec2(2.2,3.15);
      vec2 grid=fract(cell);
      vec2 footprint=fwidth(cell);
      vec2 aa=clamp(footprint,vec2(.001),vec2(.12));
      float windowMask = smoothstep(.13-aa.x,.13+aa.x,grid.x)*(1.-smoothstep(.89-aa.x,.89+aa.x,grid.x))
        *smoothstep(.19-aa.y,.19+aa.y,grid.y)*(1.-smoothstep(.90-aa.y,.90+aa.y,grid.y));
      float detail=1.-smoothstep(.065,.31,max(footprint.x,footprint.y));
      float variant=hash(floor(cell));
      float blinds=smoothstep(.66,.72,grid.y)*smoothstep(.36,.73,variant);
      float mullion=1.-smoothstep(.009,.022,abs(grid.x-.54));
      if (!uLite && detail>.01) {
        vec3 room=windowRoom((grid-vec2(.13,.19))/vec2(.76,.71),n,v,variant);
        glass=mix(glass,mix(room,reflected,.32+fresnel*.56),detail);
      }
      glass *= .86 + variant*.20;
      glass=mix(glass,vec3(.81,.84,.79),blinds*.58+mullion*.33);
      windowMask=mix(.50,windowMask,detail);
      base = mix(base*.91,glass,windowMask);
      gloss=windowMask*.86;
      rough=mix(.68,.14,windowMask);
    } else {
      base = mix(base,glass,.82);
      gloss=.87;
      rough=.16;
    }
  } else if (kind==11 || kind==22) {
    base*=.975+grime*.055;
    rough=.74;
  } else if (kind==18) {
    float threads=sin(tex.x*225.)*sin(tex.y*225.);
    base*=.97+threads*.025*(1.-smoothstep(1.5,6.,viewDist));
    rough=.87;
  } else if (kind==19) {
    base*=.98+noise(tex*35.)*.035;
    rough=.54;
  } else if (kind==20) {
    base*=.99+noise(tex*29.)*.017;
    rough=.26; gloss=.72; metal=.08;
  } else if (kind==21) {
    base*=.96+noise(tex*33.)*.05;
    rough=.81; gloss=.06;
  } else if (kind==23) {
    float rib=sin(vUV.y*85.+sin(vUV.x*37.7)*.86);
    float nacre=pow(1.-max(0.,dot(n,v)),2.2);
    float pores=uLite?.5:noise(vUV*vec2(178.,114.));
    vec3 interference=mix(vec3(.10,.22,.40),vec3(.53,.24,.38),.5+.5*sin(vUV.x*18.85+vUV.y*8.));
    base=mix(base*(.85+pores*.22+rib*.071),interference,.32*nacre);
    rough=.24+.08*pores; gloss=.92; metal=.19;
  }

  if (kind==27 && dot(xz,xz)>${CITY_RADIUS**2}.0) discard;
  float inked = 0.;
  vec2 liquidNormal = vec2(0.);
  bool lowerInk=vExtra.y>=1.5 && vExtra.y<3.5;
  bool cabinInk=vExtra.y>4.5;
  float cabinOrigin=vExtra.y>5.5?uRailCabinX:uCabinX;
  float inkFloor=cabinInk?uCabinY:lowerInk?uUnderY:0.;
  if ((kind==1 || kind==5 || kind==15 || kind==22) && n.y>.48 && (kind==15 || vPos.y>inkFloor-.055)) {
    vec2 mapPoint=vec2(xz.x-(cabinInk?cabinOrigin:lowerInk?uUnderX:0.),xz.y);
    vec2 inkUV = (mapPoint/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      vec3 coord=vec3(inkUV,vExtra.y);
      ivec2 size=textureSize(uInk,0).xy;
      vec2 grid=inkUV*vec2(size)-.5;
      ivec2 pixel=ivec2(floor(grid));
      vec2 part=fract(grid);
      int layer=int(vExtra.y);
      float clearance=kind==15 || layer==4?.207:${FILM_HEIGHT_TOLERANCE};
      vec3 a=filmCell(pixel,size,layer,vPos.y,clearance);
      vec3 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
      vec3 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
      vec3 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
      vec3 inkState=mix(mix(a,b,part.x),mix(c,d,part.x),part.y);
      float coverage=inkState.r+inkState.g;
      float inkMask=step(.51,coverage);
      if (inkMask>.005) {
        vec3 cyan=vec3(.006,.77,.66);
        vec3 orange=vec3(.98,.27,.061);
        vec3 ink=(inkState.r>=inkState.g?cyan:orange)*(.99-inkState.b*.09);
        float flow=0.;
        if (!uLite) {
          vec3 offsetX=vec3(uInkTexel.x,0.,0.),offsetZ=vec3(0.,uInkTexel.y,0.);
          vec3 west=texture(uInk,coord-offsetX).rgb, east=texture(uInk,coord+offsetX).rgb;
          vec3 north=texture(uInk,coord-offsetZ).rgb, south=texture(uInk,coord+offsetZ).rgb;
          vec2 gradient=vec2(east.b-west.b,south.b-north.b);
          flow=length(gradient);
          float band=sin(xz.x*9.2+xz.y*5.4-uClock*4.8)*sin(xz.y*8.9-xz.x*3.7+uClock*3.2);
          float capillary=sin(xz.x*23.4-xz.y*12.6+uClock*2.1)*cos(xz.y*21.7+uClock*1.8);
          liquidNormal=-gradient*.83+vec2(band,cos(xz.y*12.-uClock*3.5))*(.021+min(.045,flow*.14))
            +vec2(capillary,-capillary)*.006*(1.-smoothstep(9.,35.,viewDist));
          float meniscus=max(0.,coverage-min(west.r+west.g,north.r+north.g));
          ink=ink*(.96+noise(xz*16.)*.08)+vec3(.22,.29,.25)*meniscus*.37;
        }
        base=ink;
        n=normalize(n+vec3(liquidNormal.x,0.,liquidNormal.y)*inkMask);
        gloss=mix(gloss,.99,inkMask);
        rough=mix(rough,.17+flow*.07,inkMask);
        inked=inkMask;
      }
    }
  }

  if (kind==9 || kind==26) { gloss = .9; rough = .18; }
  float sunlight = max(dot(n,uSun),0.);
  float direct = uEffects ? shadow(n) : 1.;
  float nv=max(dot(n,v),0.);
  vec3 albedo=linearColor(base);
  vec3 f0=mix(vec3(.04),albedo,metal);
  vec3 fresnelColor=f0+(1.-f0)*pow(1.-nv,5.);
  vec3 ambient=mix(vec3(.31,.30,.24),vec3(.53,.69,.82),n.y*.5+.5);
  vec3 reflected=environment(reflect(-v,n),rough);
  vec3 diffuse=albedo*(1.-metal*.72)*(1.-fresnelColor);
  vec3 rgb=diffuse*(ambient+vec3(1.,.91,.74)*sunlight*direct*1.82);
  rgb+=specularBRDF(n,v,uSun,f0,rough)*sunlight*direct*vec3(1.,.92,.78)*2.5;
  rgb+=reflected*fresnelColor*(.45+gloss*.9)*(1.-rough*.62);
  vec3 lampDir=normalize(vec3(.25,.85,.37));
  if (uInterior>.001) {
    vec2 lamps=abs(fract(vec2((xz.x-uZoneX)/8.8,xz.y/10.5)+.5)-.5);
    float lightPool=1.-smoothstep(.12,.69,length(lamps));
    vec3 roomLight=vec3(.76,.82,.77)+vec3(.39,.34,.24)*lightPool*(.40+max(n.y,0.)*.38);
    vec3 indoor=diffuse*roomLight+specularBRDF(n,v,lampDir,f0,max(.22,rough))*vec3(.87,.85,.69)*.90;
    indoor+=mix(vec3(.21,.26,.23),vec3(.67,.73,.66),smoothstep(-.15,.65,reflect(-v,n).y))*fresnelColor*(.33+gloss*.8)*(1.-inked*.45);
    rgb=mix(rgb,indoor,uInterior);
  }
  // A separate clear coat keeps liquid highlights distinct from pigment colour.
  if (inked>.005 || kind==9 || kind==23 || kind==26) {
    vec3 lightDirection=normalize(mix(uSun,lampDir,uInterior));
    rgb+=specularBRDF(n,v,lightDirection,vec3(.035),.145)*max(dot(n,lightDirection),0.)*mix(direct,1.,uInterior)*.68;
  }
  rgb=displayColor(rgb);
  float fresnel = pow(1.-nv,5.);

  if (uEffects && !uMirrorPass && (kind==5 || inked>.09) && gloss>.37 && n.y>.49 && abs(vPos.y)<.07) {
    vec2 uv = gl_FragCoord.xy / uViewport;
    float wobble = noise(xz*3.7)-.5;
    vec2 jitter = vec2(wobble,noise(xz*5.7)-.5)*.0065*rough+liquidNormal*.034;
    float blur = rough*.0056;
    vec3 reflected = texture(uReflection,uv+jitter).rgb*.42;
    reflected += texture(uReflection,uv+jitter+vec2(blur,blur*.73)).rgb*.29;
    reflected += texture(uReflection,uv+jitter-vec2(blur,blur*.73)).rgb*.29;
    float wet = clamp((gloss-.37)*2.05,0.,1.);
    float reflectivity=mix(wet*(.15+fresnel*.40),.08+fresnel*.29,inked);
    rgb=mix(rgb,reflected,reflectivity);
  } else if (inked>.005) {
    rgb=mix(rgb,vec3(.67,.88,.96),inked*fresnel*.18);
  }

  if (inked>.005 || kind==26) {
    float brightness=max(rgb.r,max(rgb.g,rgb.b))/max(.01,max(base.r,max(base.g,base.b)));
    rgb=mix(rgb,base*clamp(brightness,.70,1.18),max(inked,kind==26?1.:0.)*.52);
  }

  if (kind==3) rgb = base * (1.08 + .12 * (1.-abs(dot(n,v))));
  float haze = 1.-exp(-pow(viewDist*.0061,1.56));
  vec3 fog = mix(vec3(.73,.84,.89),vec3(.44,.53,.49),uInterior);
  rgb = mix(rgb,fog,haze*.84);
  frag = vec4(rgb,1.);
}`;

const shadowVertex = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
uniform mat4 uLight;
void main() { gl_Position = uLight*mat4(a0,a1,a2,a3)*vec4(aPos,1.); }`;

const shadowFragment = `#version 300 es
precision mediump float;
void main() {}`;

const skyVertex = `#version 300 es
out vec2 vScreen;
void main() {
  vScreen=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.-1.;
  gl_Position=vec4(vScreen,0.,1.);
}`;

const skyFragment = `#version 300 es
precision highp float;
in vec2 vScreen;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec3 uSun;
uniform vec2 uField;
uniform float uClock;
uniform float uInterior;
out vec4 frag;

float hash(vec2 x) {
  vec3 p = fract(vec3(x.xyx)*.1031);
  p += dot(p,p.yzx+33.33);
  return fract((p.x+p.y)*p.z);
}
float noise(vec2 p) {
  vec2 i=floor(p), f=fract(p);
  f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
}
void main() {
  vec3 ray=normalize(uForward+uRight*vScreen.x*uField.x+uUp*vScreen.y*uField.y);
  float y=max(ray.y,0.);
  vec3 sky=mix(vec3(.84,.921,.947),vec3(.275,.615,.826),pow(clamp(y,0.,1.),.54));
  vec2 p=ray.xz/max(.095,ray.y+.12)*2.3+vec2(uClock*.0045,0.);
  float c=noise(p)*.57+noise(p*2.1)*.27+noise(p*4.4)*.115+noise(p*9.1)*.045;
  float billow=noise(p+uSun.xz*.23)*.68+noise(p*2.1+uSun.xz*.41)*.32;
  float clouds=smoothstep(.51,.69,c)*smoothstep(.014,.20,y);
  vec3 cloudColour=mix(vec3(.76,.83,.85),vec3(.992,.981,.942),smoothstep(.43,.66,billow));
  sky=mix(sky,cloudColour,clouds*.92);
  float cirrus=smoothstep(.68,.83,noise(vec2(p.x*.49,p.y*4.8)))*smoothstep(.22,.60,y);
  sky=mix(sky,vec3(.91,.95,.96),cirrus*.19);
  float sun=max(dot(ray,uSun),0.);
  sky+=vec3(1.,.94,.78)*(pow(sun,28.)*.18+pow(sun,1650.)*.65);
  frag=vec4(mix(sky,vec3(.25,.31,.28),uInterior),1.);
}`;

function program(gl, vertex, fragment) {
  const shaders = [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]].map(([kind, source]) => {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  });
  const result = gl.createProgram();
  for (const shader of shaders) gl.attachShader(result, shader);
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
  for (const shader of shaders) gl.deleteShader(shader);
  return result;
}

function uniforms(gl, shader, names) {
  return Object.fromEntries(names.map(name => [name,gl.getUniformLocation(shader,name)]));
}

export function labelAtlas() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = ATLAS_ROWS*96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  LABELS.forEach((label, i) => {
    ctx.font = '900 ' + (label.length <= 3 ? 78 : label.length < 8 ? 54 : 42) + 'px Arial, sans-serif';
    ctx.fillText(label, i % 4 * 256 + 128, Math.floor(i / 4) * 96 + 49, 239);
  });
  return c;
}

function labelTexture(gl) {
  const c = labelAtlas();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,c);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}

function makeBatch(gl, mesh, vbo, ibo) {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
  for (const [loc,size,offset] of [[0,3,0],[1,3,12],[2,2,24]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,size,gl.FLOAT,false,32,offset);
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  for (let i = 0; i < 6; i++) {
    const loc = i + 4;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc,4,gl.FLOAT,false,STRIDE * 4,i * 16);
    gl.vertexAttribDivisor(loc,1);
  }
  gl.bindVertexArray(null);
  return {vao,buffer,triangles:mesh.indices.length,list:[],count:0,capacity:0};
}

export class Renderer {
  constructor(canvas, paint) {
    this.canvas = canvas;
    this.zone=0;
    this.lite=false;
    const gl = canvas.getContext('webgl2', {alpha:false,antialias:true,powerPreference:'high-performance'});
    if (!gl) {
      const error = new Error('WebGL 2 が利用できません。');
      error.name = 'WebGLUnavailable';
      throw error;
    }
    this.gl = gl;
    const driver=gl.getExtension('WEBGL_debug_renderer_info');
    this.cpuRenderer=driver ? /swiftshader|llvmpipe|software rasterizer/i.test(gl.getParameter(driver.UNMASKED_RENDERER_WEBGL)) : false;
    this.scene = program(gl,sceneVertex,sceneFragment);
    this.shadow = program(gl,shadowVertex,shadowFragment);
    this.sky = program(gl,skyVertex,skyFragment);
    this.u = uniforms(gl,this.scene,['uVP','uLight','uEye','uSun','uShadow','uInk','uAtlas','uAtlasGrid','uReflection','uViewport','uMirrorPass','uEffects','uLite','uInterior','uZoneX','uDrawOffset','uMergeStairs','uUnderX','uUnderY','uCabinX','uRailCabinX','uCabinY','uTexel','uInkTexel','uClock','uInkBounds']);
    this.s = uniforms(gl,this.sky,['uRight','uUp','uForward','uSun','uField','uClock','uInterior']);
    this.sunMatrix = multiply(ortho(80,72,1,225),view(add(scale(SUN,110),[0,1,0]),[0,0,0]));
    this.shadowUniform = gl.getUniformLocation(this.shadow,'uLight');
    this.shadowSize = Math.min(3072,gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.renderLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.inkTexture = gl.createTexture();
    this.inkSource=paint;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,paint.w,paint.h,paint.layers,0,gl.RGBA,gl.UNSIGNED_BYTE,paint.pixels);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    this.atlas = labelTexture(gl);
    this.batches = {};
    for (const [name, mesh] of Object.entries(meshes())) {
      const vbo = gl.createBuffer(), ibo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(mesh.vertices),gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(mesh.indices),gl.STATIC_DRAW);
      this.batches[name] = Object.fromEntries([...ZONE_BATCHES,'dynamic','adjacent'].map(key=>[key,makeBatch(gl,mesh,vbo,ibo)]));
    }
    this.empty = gl.createVertexArray();
    this.frame = 0;
    this.inkTime = -1;
    gl.clearDepth(1);
    gl.depthFunc(gl.LEQUAL);
  }

  setQuality(lightweight) {
    if (this.lite!==lightweight) this.frame=0;
    this.lite=lightweight;
  }

  prepareEffects() {
    if (this.effectsUnavailable) return false;
    if (this.shadowBuffer) return true;
    const gl=this.gl;
    gl.activeTexture(gl.TEXTURE0);
    this.shadowTexture = gl.createTexture();
    this.shadowBuffer = gl.createFramebuffer();
    if (!this.shadowTexture || !this.shadowBuffer) return this.disableEffects();
    gl.bindTexture(gl.TEXTURE_2D,this.shadowTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.DEPTH_COMPONENT24,this.shadowSize,this.shadowSize,0,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.shadowBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,this.shadowTexture,0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) return this.disableEffects();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    this.mirrorBuffer = gl.createFramebuffer();
    this.mirrorTexture = gl.createTexture();
    this.mirrorDepth = gl.createRenderbuffer();
    if (!this.mirrorBuffer || !this.mirrorTexture || !this.mirrorDepth) return this.disableEffects();
    gl.bindTexture(gl.TEXTURE_2D,this.mirrorTexture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    this.mirrorSize = [0,0];
    this.mirrorMatrix = new Float32Array([1,0,0,0, 0,-1,0,0, 0,0,1,0, 0,.012,0,1]);
    return true;
  }

  disableEffects() {
    const gl=this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    gl.deleteFramebuffer(this.shadowBuffer??null);
    gl.deleteFramebuffer(this.mirrorBuffer??null);
    gl.deleteTexture(this.shadowTexture??null);
    gl.deleteTexture(this.mirrorTexture??null);
    gl.deleteRenderbuffer(this.mirrorDepth??null);
    this.shadowBuffer=this.mirrorBuffer=this.shadowTexture=this.mirrorTexture=this.mirrorDepth=null;
    this.effectsUnavailable=true;
    return false;
  }

  add(type,x,y,z,w,h,d,tint,kind = 0,opts = {}) {
    const key=opts.dynamic?(this.drawingAdjacent?'adjacent':'dynamic'):ZONE_BATCHES[this.zone];
    const batch = this.batches[type][key];
    const c = typeof tint === 'number' ? color(tint) : tint;
    const basis=instanceBasis(opts);
    const [a,b,f] = basis;
    batch.list.push(
      a[0]*w,a[1]*w,a[2]*w,0,b[0]*h,b[1]*h,b[2]*h,0,f[0]*d,f[1]*d,f[2]*d,0,
      x,y,z,1,c[0],c[1],c[2],kind,opts.label ?? 0,opts.layer ?? 0,opts.stairDuplicate?1:0,opts.effect??0
    );
  }

  label(name,x,y,z,w,h,tint,yaw = 0,pitch = 0,opts = {}) {
    const label=LABELS.indexOf(name);
    if (label>=0) this.add('quad',x,y,z,w,h,1,tint,7,{yaw,pitch,...opts,label});
  }

  beam(a,b,width,depth,tint,kind = 0,opts = {}) {
    const y = unit(sub(b,a));
    const ref = Math.abs(y[2]) > .93 ? [1,0,0] : [0,0,1];
    const x = unit(cross(y,ref)), z = cross(x,y);
    const mid = scale(add(a,b),.5);
    this.add(opts.shape ?? 'box',...mid,width,Math.hypot(...sub(b,a)),depth,tint,kind,{...opts,basis:[x,y,z]});
  }

  seal() {
    for (const pair of Object.values(this.batches)) {
      for (const key of ZONE_BATCHES) this.upload(pair[key],false);
    }
  }

  upload(batch,dynamic) {
    const gl = this.gl;
    batch.count = batch.list.length / STRIDE;
    if (!batch.count) return;
    const data = new Float32Array(batch.list);
    gl.bindBuffer(gl.ARRAY_BUFFER,batch.buffer);
    if (!dynamic || data.byteLength > batch.capacity) {
      batch.capacity = dynamic ? Math.max(1024,2 ** Math.ceil(Math.log2(data.byteLength))) : data.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER,batch.capacity,dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER,0,data);
  }

  clearDynamic() {
    for (const pair of Object.values(this.batches)) {
      pair.dynamic.list.length=0;
      pair.adjacent.list.length=0;
    }
  }

  drawBatches(depth,eye,mergeStairs=false) {
    const gl=this.gl, zone=this.viewZone;
    const views=mergeStairs?[[zone,'dynamic'],[1-zone,'adjacent']]:[[zone,'dynamic']];
    if (!depth) gl.uniform1i(this.u.uMergeStairs,mergeStairs?1:0);
    const draw=alpha=>{
      for (const [level,dynamicKey] of views) {
        if (!depth) {
          const offset=ZONES[zone].x-ZONES[level].x;
          gl.uniform1f(this.u.uDrawOffset,offset);
          gl.uniform1f(this.u.uZoneX,ZONES[level].x);
          gl.uniform3f(this.u.uEye,eye[0]-offset,eye[1],eye[2]);
          gl.uniform1i(this.u.uEffects,this.effects && level===0?1:0);
        }
        for (const [key,pair] of Object.entries(this.batches)) {
          if (TRANSPARENT_MESHES.includes(key)!==alpha || depth && (key==='splat' || key==='tri')) continue;
          for (const batch of [pair[ZONE_BATCHES[level]],pair[dynamicKey]]) {
            if (!batch.count) continue;
            gl.bindVertexArray(batch.vao);
            gl.drawElementsInstanced(gl.TRIANGLES,batch.triangles,gl.UNSIGNED_SHORT,0,batch.count);
          }
        }
      }
    };
    draw(false);
    if (depth) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    draw(true);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  draw(camera,paint,clock) {
    const gl = this.gl, canvas = this.canvas;
    const dpr=devicePixelRatio || 1;
    const limit=this.renderLimit;
    const ratio=Math.min(dpr,this.lite?.85:2.5,limit/canvas.clientWidth,limit/canvas.clientHeight);
    this.viewZone=zoneOf(camera.eye[0]);
    this.mergeStairs=!!camera.stair && this.viewZone<2;
    this.interior=interiorBlend(camera);
    const w=Math.max(1,Math.round(canvas.clientWidth*ratio));
    const h=Math.max(1,Math.round(canvas.clientHeight*ratio));
    this.effects=!this.lite && this.viewZone===0 && this.interior<.995 && this.prepareEffects();
    const mirrorW=Math.max(1,Math.round(w*.74)),mirrorH=Math.max(1,Math.round(h*.74));
    if (this.effects && (this.mirrorSize[0]!==mirrorW || this.mirrorSize[1]!==mirrorH)) {
      this.effects=this.sizeMirror(mirrorW,mirrorH);
    }
    if (canvas.width!==w || canvas.height!==h) {
      canvas.width=w;
      canvas.height=h;
    }
    for (const pair of Object.values(this.batches)) {
      this.upload(pair.dynamic,true);
      if (this.mergeStairs) this.upload(pair.adjacent,true);
    }
    this.vp = multiply(perspective(w/h),view(camera.eye,camera.target));
    if (this.effects && (this.frame++ % 2)===0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.shadowBuffer);
      gl.viewport(0,0,this.shadowSize,this.shadowSize);
      gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.shadow);
      gl.uniformMatrix4fv(this.shadowUniform,false,this.sunMatrix);
      this.drawBatches(true);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    if (this.inkSource!==paint) {
      const old=this.inkSource;
      if (old.w!==paint.w || old.h!==paint.h || old.layers!==paint.layers) {
        gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,paint.w,paint.h,paint.layers,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      }
      this.inkSource=paint;
      this.lastInkMask=0;
      paint.dirtyMask=(1<<paint.layers)-1;
    }
    const visibleMask=ZONES[this.viewZone].inkMask | (this.mergeStairs?ZONES[1-this.viewZone].inkMask:0);
    const changed=paint.dirtyMask & visibleMask;
    const visibilityChanged=this.lastInkMask!==visibleMask;
    if (changed && (visibilityChanged || clock-this.inkTime>(this.lite?.055:.033) || clock<this.inkTime)) {
      const length=paint.layerSize*4;
      for (let layer=0;layer<paint.layers;layer++) {
        if (!(changed & (1<<layer))) continue;
        const data=paint.pixels.subarray(layer*length,(layer+1)*length);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,layer,paint.w,paint.h,1,gl.RGBA,gl.UNSIGNED_BYTE,data);
      }
      paint.dirtyMask&=~changed;
      this.inkTime=clock;
    }
    this.lastInkMask=visibleMask;
    const direction = unit(sub(camera.target,camera.eye));
    const right = unit(cross(direction,UP));
    const up = cross(right,direction);
    if (this.effects) {
      const reflected=([x,y,z])=>[x,-y,z];
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorBuffer);
      this.pass(mirrorW,mirrorH,reflected(direction),reflected(right),reflected(up),
        [camera.eye[0],.012-camera.eye[1],camera.eye[2]],multiply(this.vp,this.mirrorMatrix),paint,clock,true);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    this.pass(w,h,direction,right,up,camera.eye,this.vp,paint,clock,false);
    gl.bindVertexArray(null);
  }

  sizeMirror(w,h) {
    const gl=this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,this.mirrorTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,this.mirrorDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,w,h);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.mirrorTexture,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this.mirrorDepth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) return this.disableEffects();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    this.mirrorSize=[w,h];
    return true;
  }

  pass(w,h,direction,right,up,eye,vp,paint,clock,mirror) {
    const gl=this.gl;
    gl.viewport(0,0,w,h);
    if (this.interior>=.995 || this.lite) {
      gl.clearColor(mix(.68,.25,this.interior),mix(.83,.31,this.interior),mix(.89,.28,this.interior),1);
      gl.clear(gl.DEPTH_BUFFER_BIT|gl.COLOR_BUFFER_BIT);
    } else {
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.sky);
      const f=Math.tan(FOV/2);
      gl.uniform3fv(this.s.uRight,right);
      gl.uniform3fv(this.s.uUp,up);
      gl.uniform3fv(this.s.uForward,direction);
      gl.uniform3fv(this.s.uSun,SUN);
      gl.uniform2f(this.s.uField,f*w/h,f);
      gl.uniform1f(this.s.uClock,clock);
      gl.uniform1f(this.s.uInterior,this.interior);
      gl.bindVertexArray(this.empty);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.scene);
    gl.uniformMatrix4fv(this.u.uVP,false,vp);
    gl.uniformMatrix4fv(this.u.uLight,false,this.sunMatrix);
    gl.uniform3fv(this.u.uSun,SUN);
    gl.uniform2f(this.u.uTexel,1/this.shadowSize,1/this.shadowSize);
    gl.uniform2f(this.u.uInkTexel,1/paint.w,1/paint.h);
    gl.uniform2f(this.u.uInkBounds,paint.boundX,paint.boundZ);
    gl.uniform2f(this.u.uViewport,w,h);
    gl.uniform1f(this.u.uClock,clock);
    gl.uniform1i(this.u.uMirrorPass,mirror ? 1 : 0);
    gl.uniform1i(this.u.uLite,this.lite?1:0);
    gl.uniform1f(this.u.uInterior,this.interior);
    gl.uniform1f(this.u.uUnderX,UNDER_X);
    gl.uniform1f(this.u.uUnderY,UNDER_Y);
    gl.uniform1f(this.u.uCabinX,CABIN_X);
    gl.uniform1f(this.u.uRailCabinX,RAIL_CABIN_X);
    gl.uniform1f(this.u.uCabinY,CABIN_Y);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,this.effects?this.shadowTexture:this.atlas);
    gl.uniform1i(this.u.uShadow,0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    gl.uniform1i(this.u.uInk,1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D,this.atlas);
    gl.uniform1i(this.u.uAtlas,2);
    gl.uniform2f(this.u.uAtlasGrid,ATLAS_COLUMNS,ATLAS_ROWS);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,mirror || !this.effects ? this.atlas : this.mirrorTexture);
    gl.uniform1i(this.u.uReflection,3);
    this.drawBatches(false,eye,!mirror && this.mergeStairs);
  }

  project(point) {
    const m = this.vp;
    const [x,y,z] = point;
    const w = m[3]*x+m[7]*y+m[11]*z+m[15];
    if (w < .1) return null;
    return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w*.5+.5,.5-(m[1]*x+m[5]*y+m[9]*z+m[13])/w*.5];
  }
}
