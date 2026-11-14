// GLSL sources for the WebGL 2 renderer. Lighting is linear HDR with a
// physically based sun, sky image lighting, cascaded soft shadows and a
// filmic grade. Materials are procedural and sample a tileable detail map so
// surface texture stays filtered at every distance.
import {FILM_HEIGHT_ORIGIN,FILM_HEIGHT_STEP,FILM_HEIGHT_TOLERANCE} from './ink-fluid.js';
import {CABIN_Y,CITY_RADIUS,UNDER_X,UNDER_Y} from './layout.js';
import {SURFACES} from './surfaces.js';

const f=n=>Number(n).toFixed(4);
const floats=(name,values)=>`const float ${name}[${values.length}]=float[${values.length}](${values.map(f).join(',')});`;

// Real surface textures (see surfaces.js). Shared by the full and the
// lightweight scene shaders: slot names, repeat sizes, and the rules that
// pick a texture for a surface from its material, colour, shape and place.
const SURFACE_CORE=`
${SURFACES.map((surface,i)=>`const int S_${surface.id.toUpperCase()}=${i};`).join('\n')}
${floats('S_METERS',SURFACES.map(surface=>surface.meters))}
${floats('S_MIRROR',SURFACES.map(surface=>surface.pattern?1:0))}
${floats('S_TAKE',SURFACES.map(surface=>surface.take))}
uniform highp sampler2DArray uSurface;
uniform int uSurfaceSheets;
uniform float uSurfaceEdge;
uniform vec3 uSurfaceMean[${SURFACES.length}];
bool surfaceReady(int slot){return slot>=0 && ((uSurfaceSheets>>(slot/9))&1)==1;}
// p: world-plane position in metres; dx, dy: its screen derivatives, taken
// outside any branch so a texture can be chosen per pixel.
vec4 surfaceTap(int slot,vec2 p,vec2 dx,vec2 dy){
  float s=1./S_METERS[slot];
  vec2 uv=p*s;
  if (S_MIRROR[slot]>.5) uv=clamp(1.-abs(1.-mod(uv,2.)),uSurfaceEdge,1.-uSurfaceEdge);
  return textureGrad(uSurface,vec3(uv,float(slot)),dx*s,dy*s);
}
vec3 surfaceMean(int slot){return uSurfaceMean[slot];}
float sfLum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
float sfChroma(vec3 c){return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
float sfHash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float sfNoise(vec2 p){
  vec2 i=floor(p), u=fract(p);
  u=u*u*(3.-2.*u);
  return mix(mix(sfHash(i),sfHash(i+vec2(1,0)),u.x),mix(sfHash(i+vec2(0,1)),sfHash(i+vec2(1,1)),u.x),u.y);
}
// tint: the instance colour as stored (sRGB). Returns -1 for surfaces that
// keep their procedural look (lights, glass panes with rooms, ink, labels).
int surfaceFor(int kind,vec3 tint,vec3 ng,float seed,vec3 size,int shape,bool under,bool cabin,float layer,float above){
  float l=sfLum(tint), chroma=sfChroma(tint);
  bool warm=tint.r>tint.b+.06, red=tint.r>tint.g+.15, green=tint.g>tint.r+.015 && tint.g>=tint.b-.02;
  bool level=ng.y>.6, ceiling=ng.y<-.6;
  float longest=max(max(size.x,size.y),size.z), thinnest=min(min(size.x,size.y),size.z);
  // The sides of slabs, kerbs, risers and poles made of a floor material.
  if ((kind==1 || kind==5 || kind==15 || kind==27) && !level) return cabin?S_HARD_PLASTIC:under?S_CONCRETE_FORMWORK:S_CONCRETE_WEATHERED;
  if (kind==5) return S_ASPHALT;
  if (kind==1) {
    if (cabin) return S_VINYL_FLOOR;
    if (layer>3.5 && layer<4.5) return S_BALLAST;
    if (under) return l>.55?(seed<.5?S_PORCELAIN_TILES:S_TERRAZZO):S_EPOXY_FLOOR;
    if (warm && chroma>.07) return S_BRICK_PAVERS;
    return tint.g>tint.r+.008?S_SIDEWALK_PAVERS:S_CONCRETE_SLAB;
  }
  if (kind==27) return S_CONCRETE_SLAB;
  if (kind==15) return under?S_EPOXY_FLOOR:S_CONCRETE_WEATHERED;
  if (kind==2 || kind==19) {
    if (ceiling && (under || cabin)) return S_CEILING_PANEL;
    if (cabin) return S_HARD_PLASTIC;
    if (kind==19) return S_PLASTER;
    if (under) return level?S_CONCRETE_WEATHERED:l>.6?S_SUBWAY_TILES:S_CONCRETE_FORMWORK;
    if (level) return S_CONCRETE_WEATHERED;
    if (red && chroma>.12) return S_TERRACOTTA;
    if (chroma>.12 && longest>2.) return S_CORRUGATED_METAL;
    if (size.y<2.4) return seed<.5?S_CONCRETE_BLOCK:S_CONCRETE_WEATHERED;
    return seed<.25?S_CONCRETE_FORMWORK:seed<.5?S_CONCRETE_WEATHERED:seed<.75?S_PLASTER:S_ALC_PANEL;
  }
  if (kind==11) return warm?(seed<.5?S_BRICK_TAN:S_TILE_CLADDING):
    seed<.3?S_TILE_CLADDING:seed<.55?S_PLASTER:seed<.8?S_ALC_PANEL:S_CONCRETE_WEATHERED;
  if (kind==13) {
    if (shape==0) return S_BARK;
    if (level && size.y<.1 && l<.5) return seed<.5?S_SOIL:S_MULCH;
    return red?S_BRICK_RED:S_BRICK_TAN;
  }
  if (kind==29) return seed<.34?S_WOOD_PLANKS:seed<.67?S_PLYWOOD:S_WOOD_WEATHERED;
  if (kind==14) return shape==0?S_LEAVES:S_HEDGE;
  if (kind==4) {
    if (cabin || under) return chroma<.05?S_STAINLESS:S_STEEL_PAINTED_GREY;
    if (level) return above<.35?S_DRAIN_GRATE:S_DIAMOND_PLATE;
    if (longest>4.5) return S_STEEL_GIRDER;
    if (thinnest<.05 && longest>.5) return S_PERFORATED_METAL;
    if (chroma<.035 && l>.12) return seed<.5?S_GALVANIZED:S_BRUSHED_ALUMINUM;
    return green?S_STEEL_PAINTED_GREEN:S_STEEL_PAINTED_GREY;
  }
  if (kind==22) return tint.r>.8 && tint.b<.7?S_TACTILE_PAVING:S_ROAD_PAINT;
  if (kind==0) return S_PAINTED_METAL;
  if (kind==8) return S_GLASS_GRIME;
  if (kind==23) return S_CEPHALOPOD_SKIN;
  if (kind==18) return S_SEAT_FABRIC;
  if (kind==30) return S_RIPSTOP;
  if (kind==31) return S_CANVAS;
  if (kind==21) return S_RUBBER_SOLE;
  if (kind==20) return S_HARD_PLASTIC;
  return -1;
}
// Lawns, flower beds and sand lots scattered over the outer district.
int outerPatch(vec2 p,out float weight){
  float n=sfNoise(p*.031+vec2(3.1,7.7));
  weight=0.;
  if (n<.30) {weight=1.;return S_GRASS;}
  if (n<.38) {weight=smoothstep(.38,.34,n);return S_SOIL;}
  if (n>.80) {weight=1.;return S_SAND;}
  if (n>.72) {weight=smoothstep(.72,.76,n);return S_MULCH;}
  return -1;
}
`;

// Full shader helpers: texture colour against the object's own colour, and
// the relief the texture's shading implies (in metres, for bump mapping).
const SURFACE_HIGH=`
${SURFACE_CORE}
vec3 realSurface(vec4 t,int slot,vec3 tint,float strength,float depth,inout float h){
  vec3 mean=max(toLinear(surfaceMean(slot)),vec3(.012)), c=toLinear(t.rgb);
  float shade=lum(c)/max(lum(mean),.012);
  h=(shade-1.)*S_METERS[slot]*depth;
  vec3 tinted=tint*c/mean, natural=c*(lum(tint)/max(lum(mean),.012));
  return mix(tint,mix(tinted,natural,S_TAKE[slot]),strength);
}
// Three planar taps for rounded shapes (trunks, foliage, the boss).
vec4 surfaceTri(int slot,vec3 p,vec3 n,vec3 dx,vec3 dy){
  vec3 w=pow(abs(n),vec3(4.));
  w/=w.x+w.y+w.z;
  return surfaceTap(slot,p.zy,dx.zy,dy.zy)*w.x+surfaceTap(slot,p.xz,dx.xz,dy.xz)*w.y+surfaceTap(slot,p.xy,dx.xy,dy.xy)*w.z;
}
`;

export const COMMON=`
const float PI=3.14159265;
float sat(float x){return clamp(x,0.,1.);}
vec2 sat(vec2 x){return clamp(x,0.,1.);}
vec3 sat(vec3 x){return clamp(x,0.,1.);}
vec3 sat3(vec3 x){return clamp(x,0.,1.);}
float hash12(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec2 hash22(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 toLinear(vec3 c){return c*(c*(c*.305306011+.682171111)+.012522878);}
vec3 toSRGB(vec3 c){c=max(c,vec3(0.));return mix(c*12.92,1.055*pow(c,vec3(.4166667))-.055,step(vec3(.0031308),c));}
vec3 aces(vec3 x){
  const mat3 I=mat3(.59719,.07600,.02840,.35458,.90834,.13383,.04823,.01566,.83777);
  const mat3 O=mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602);
  x=I*x;
  vec3 a=x*(x+.0245786)-.000090537, b=x*(.983729*x+.4329510)+.238081;
  return sat3(O*(a/b));
}
vec3 grade(vec3 c){
  c=aces(c*vec3(1.66,1.62,1.55));
  float l=lum(c);
  c=max(mix(vec3(l),c,1.07),vec3(0.));
  c*=mix(vec3(.972,.995,1.035),vec3(1.035,1.,.952),smoothstep(.08,.75,l));
  return toSRGB(sat3(c));
}
vec2 envUV(vec3 d){return vec2(atan(d.x,-d.z)*.15915494+.5,acos(clamp(d.y,-1.,1.))*.31830989);}
vec3 envDecode(vec4 c){return c.rgb/max(vec3(1.)-c.rgb,vec3(.004));}
vec3 envEncode(vec3 c){c=max(c,vec3(0.));return c/(1.+c);}
`;

// Sky radiance, clouds and a distant skyline. Shared by the background, the
// reflection probe and the fog colour so geometry fades into the same sky.
export const SKY=`
uniform sampler2D uDetail;
uniform vec3 uSun;
uniform float uClock;
vec3 skyAtmos(vec3 d){
  float y=d.y, h=max(y,0.), mu=dot(d,uSun);
  float horizon=pow(1.-h,5.5);
  vec3 zenith=vec3(.050,.135,.390);
  vec3 hz=vec3(.44,.55,.68);
  vec3 col=mix(zenith,hz,horizon);
  col*=.84+.30*sat(mu*.5+.5);
  float a=max(mu,0.);
  col+=vec3(1.,.82,.60)*(pow(a,5.)*.16+pow(a,36.)*.42+pow(a,380.)*1.9)*mix(.55,1.,horizon);
  if (y<0.) col=mix(hz*vec3(.86,.87,.86),vec3(.105,.11,.105),sat(-y*4.5));
  return col*1.55;
}
float cloudField(vec2 p){
  vec2 q=p+vec2(uClock*.0016,uClock*.0005);
  float w=texture(uDetail,q*.11+.37).b;
  float base=texture(uDetail,q*.19+vec2(w*.07,-w*.05)).r;
  float det=texture(uDetail,q*.83-vec2(w*.11,0.)).r;
  float fine=texture(uDetail,q*2.9+.5).r;
  return base*.70+det*.30+fine*.09;
}
vec4 skyClouds(vec3 d){
  if (d.y<.004) return vec4(0.);
  vec2 p=d.xz/(d.y+.04);
  float n=cloudField(p), cover=.585;
  float dens=sat((n-cover)*3.6);
  if (dens<=.002) return vec4(0.);
  vec2 toward=uSun.xz/max(uSun.y,.25)*.09;
  float n2=cloudField(p+toward);
  float lightPath=sat((n2-cover)*2.2);
  float shade=sat(.78-lightPath*.95+(n-n2)*1.6);
  float core=sat((n-cover)*1.5);
  vec3 lit=vec3(1.07,1.03,.98)*1.72;
  vec3 dark=vec3(.40,.46,.56)*1.25;
  vec3 col=mix(dark,lit,shade)*(1.-core*.28);
  float mu=max(dot(d,uSun),0.);
  col+=vec3(1.,.86,.66)*pow(mu,14.)*(1.-dens)*2.6;
  col=mix(skyAtmos(d),col,mix(.30,1.,smoothstep(.015,.32,d.y)));
  return vec4(col,dens*smoothstep(.004,.14,d.y));
}
float skylineHeight(vec3 d){
  float az=atan(d.x,-d.z)*36.;
  float cell=floor(az);
  float h=.003+pow(hash12(vec2(cell,1.7)),2.2)*.026+step(.9,hash12(vec2(cell,9.1)))*.030;
  return h*(.55+.45*hash12(vec2(floor(az*.17),4.)));
}
vec3 skyFull(vec3 d,bool clouds,bool disk){
  vec3 col=skyAtmos(d);
  if (clouds && d.y>0.) {vec4 c=skyClouds(d);col=mix(col,c.rgb,c.a);}
  float top=skylineHeight(d);
  if (d.y<top && d.y>-.04) {
    float az=atan(d.x,-d.z)*36.;
    float id=hash12(vec2(floor(az),2.3));
    float side=step(.5,fract(az))*.5+.5;
    vec3 tower=mix(vec3(.25,.31,.37),vec3(.37,.42,.47),id)*mix(.82,1.08,side*sat(uSun.y+.3));
    float rows=step(.55,fract(d.y*640.))*step(.45,fract(az*7.))*.035;
    vec3 building=(tower+rows)*1.15;
    col=mix(building,col,.42+.38*sat(1.-(top-d.y)*40.));
  }
  if (disk) {
    float s=dot(d,uSun);
    col+=vec3(1.,.93,.80)*smoothstep(.99988,.99995,s)*70.;
  }
  return col;
}
`;

export const FULLSCREEN_VERTEX=`#version 300 es
out vec2 vUV;
void main(){
  vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  vUV=p;
  gl_Position=vec4(p*2.-1.,1.,1.);
}`;

// Tileable detail map: R value-gradient fBm, G cellular F1, B cellular
// ridges (cracks, veins), A fine grain. Generated once, mip-filtered.
export const DETAIL_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
out vec4 frag;
uniform float uSize;
vec2 gradAt(vec2 i,float period){vec2 h=hash22(mod(i,period)+.5);float a=h.x*6.2831853;return vec2(cos(a),sin(a));}
float gnoise(vec2 x,float period){
  vec2 i=floor(x), f=fract(x);
  vec2 u=f*f*f*(f*(f*6.-15.)+10.);
  float a=dot(gradAt(i,period),f), b=dot(gradAt(i+vec2(1,0),period),f-vec2(1,0));
  float c=dot(gradAt(i+vec2(0,1),period),f-vec2(0,1)), e=dot(gradAt(i+vec2(1,1),period),f-vec2(1,1));
  return mix(mix(a,b,u.x),mix(c,e,u.x),u.y);
}
float fbm(vec2 uv,float base){
  float s=0., a=.5, t=0., p=base;
  for (int i=0;i<7;i++){s+=a*gnoise(uv*p,p);t+=a;a*=.52;p*=2.;}
  return s/t;
}
vec2 cells(vec2 uv,float n){
  vec2 x=uv*n, i=floor(x), fr=fract(x);
  float f1=9., f2=9.;
  for (int y=-1;y<=1;y++) for (int k=-1;k<=1;k++) {
    vec2 g=vec2(float(k),float(y));
    vec2 o=hash22(mod(i+g,n)+.37);
    vec2 r=g+o-fr;
    float d=dot(r,r);
    if (d<f1){f2=f1;f1=d;} else if (d<f2) f2=d;
  }
  return sqrt(vec2(f1,f2));
}
void main(){
  vec2 uv=gl_FragCoord.xy/uSize;
  float r=sat(fbm(uv,4.)*1.35+.5);
  vec2 c=cells(uv,22.);
  vec2 v=cells(uv+fbm(uv,8.)*.035,9.);
  float ridge=sat(1.-(v.y-v.x)*3.2);
  float grain=sat(.5+gnoise(uv*128.,128.)*.55+gnoise(uv*256.,256.)*.35);
  frag=vec4(r,sat(c.x*1.15),ridge,grain);
}`;

// Equirectangular sky probe, encoded x/(1+x) in RGBA8 with mips per roughness.
export const ENV_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
${SKY}
uniform vec2 uSize;
out vec4 frag;
void main(){
  vec2 uv=gl_FragCoord.xy/uSize;
  float phi=(uv.x-.5)*6.2831853, theta=uv.y*PI;
  vec3 d=vec3(sin(theta)*sin(phi),cos(theta),-sin(theta)*cos(phi));
  vec3 col=skyFull(d,true,false);
  if (d.y<0.) {
    float g=sat(-d.y*3.);
    vec3 ground=mix(vec3(.30,.31,.30),vec3(.17,.17,.16),g)*(.55+.45*sat(uSun.y*1.5));
    col=mix(col,ground,smoothstep(0.,.08,-d.y));
  }
  float s=max(dot(d,uSun),0.);
  col+=vec3(1.,.9,.75)*pow(s,900.)*14.;
  frag=vec4(envEncode(col),1.);
}`;

export const SKY_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
${SKY}
in vec2 vUV;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uField;
uniform float uInterior;
uniform bool uHDR;
uniform vec2 uViewport;
uniform float uExposure;
out vec4 frag;
void main(){
  vec2 s=vUV*2.-1.;
  vec3 ray=normalize(uForward+uRight*s.x*uField.x+uUp*s.y*uField.y);
  vec3 col=skyFull(ray,true,true);
  col=mix(col,vec3(.055,.062,.058),uInterior);
  if (uHDR) {frag=vec4(col,0.);return;}
  vec3 c=grade(col*uExposure);
  vec2 q=gl_FragCoord.xy/uViewport-.5;
  c*=1.-dot(q,q)*.42;
  frag=vec4(c,1.);
}`;

export const SCENE_VERTEX=`#version 300 es
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
uniform float uDrawOffset;
uniform bool uMergeStairs;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUV;
out vec3 vLocal;
flat out vec4 vTint;
flat out vec4 vExtra;
flat out vec3 vSize;
flat out vec3 vAxisX;
flat out vec3 vAxisY;
flat out float vSeed;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  // A stable per-object number, so neighbouring buildings pick different textures.
  vec3 q=fract(a3.xyz*vec3(.1031,.1030,.0973));
  q+=dot(q,q.yzx+33.33);
  vSeed=fract((q.x+q.y)*q.z);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vPos=p.xyz;
  vNormal=normalize(transpose(inverse(m))*aNormal);
  vUV=aUV;
  vLocal=aPos;
  vTint=aTint;
  vExtra=aExtra;
  vSize=vec3(length(a0.xyz),length(a1.xyz),length(a2.xyz));
  vAxisX=a0.xyz/max(vSize.x,1e-6);
  vAxisY=a1.xyz/max(vSize.y,1e-6);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const SHADOW_VERTEX=`#version 300 es
layout(location=0) in vec3 aPos;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
uniform mat4 uLight;
void main(){gl_Position=uLight*vec4(mat3(a0.xyz,a1.xyz,a2.xyz)*aPos+a3.xyz,1.);}`;

export const SHADOW_FRAGMENT=`#version 300 es
precision mediump float;
void main(){}`;

const LAMP_ROWS=[-39,-28,-10.5,0,10.5,28,39];
const CABIN_LAMPS=[-7.9,-5.2,-1.4,1.4,5.2,7.9];

export const SCENE_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
${SKY}
in vec3 vPos;
in vec3 vNormal;
in vec2 vUV;
in vec3 vLocal;
flat in vec4 vTint;
flat in vec4 vExtra;
flat in vec3 vSize;
flat in vec3 vAxisX;
flat in vec3 vAxisY;
flat in float vSeed;
uniform vec3 uEye;
uniform vec3 uSunColor;
uniform int uShape;
uniform int uQuality;
uniform bool uHDR;
uniform bool uMirrorPass;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM0;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2DArray uInk;
uniform sampler2D uAtlas;
uniform vec2 uAtlasGrid;
uniform sampler2D uReflection;
uniform bool uReflectOn;
uniform vec2 uViewport;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform float uZoneX;
uniform float uUnderX;
uniform float uUnderY;
uniform float uCabinX;
uniform float uRailCabinX;
uniform float uCabinY;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform float uExposure;
uniform float uTrainShift;
out vec4 frag;

${SURFACE_HIGH}
const float LAMP_ROWS[${LAMP_ROWS.length}]=float[${LAMP_ROWS.length}](${LAMP_ROWS.map(f).join(',')});
const float CABIN_LAMPS[${CABIN_LAMPS.length}]=float[${CABIN_LAMPS.length}](${CABIN_LAMPS.map(f).join(',')});

vec4 det(vec2 p){return texture(uDetail,p);}
vec3 envAt(vec3 d,float lod){return envDecode(textureLod(uEnv,envUV(d),lod));}
vec3 envSpec(vec3 r,float rough){return envAt(r,clamp(sqrt(rough)*uEnvLod,0.,uEnvLod));}
vec3 envDiffuse(vec3 n){return envAt(n,uEnvLod-1.6)*.92;}

float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 fresnel(vec3 f0,float c){return f0+(1.-f0)*pow(1.-c,5.);}
vec3 specGGX(vec3 n,vec3 v,vec3 l,vec3 f0,float rough){
  vec3 h=normalize(l+v);
  float nl=max(dot(n,l),0.), nv=max(dot(n,v),1e-4), nh=max(dot(n,h),0.), a=max(rough*rough,.0016);
  return ggxD(nh,a)*visSmith(nv,nl,a)*fresnel(f0,max(dot(v,h),0.))*nl;
}
vec3 envBRDF(vec3 f0,float rough,float nv){
  const vec4 c0=vec4(-1.,-.0275,-.572,.022);
  const vec4 c1=vec4(1.,.0425,1.04,-.04);
  vec4 r=rough*c0+c1;
  float a004=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;
  vec2 ab=vec2(-1.04,1.04)*a004+r.zw;
  return f0*ab.x+ab.y;
}

float shadowTap(sampler2DShadow s,vec3 c,float texel){
  if (uQuality==0) return texture(s,c);
  float sum=0.;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++) sum+=texture(s,vec3(c.xy+vec2(float(i),float(j))*texel,c.z));
  return sum*(1./9.);
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
  float slope=1.-sat(dot(ng,uSun));
  vec3 c0=(uShadowM0*vec4(p+ng*uShadowTexel.z*(1.2+slope*1.6),1.)).xyz*.5+.5;
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y);
  float s0=1.;
  if (inner>0. && c0.z<1.) s0=shadowTap(uShadow0,vec3(c0.xy,c0.z-.00022),uShadowTexel.x);
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope*1.6),1.)).xyz*.5+.5;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=shadowTap(uShadow1,vec3(c1.xy,c1.z-.00045),uShadowTexel.y);
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}

vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}

// Window interiors: a box room traced behind the glass in local face space.
vec3 roomBehind(vec2 uv,vec3 viewT,float seed,float lightOn,float depth){
  vec3 o=vec3(uv-.5,0.);
  vec3 ray=vec3(viewT.xy,max(viewT.z,.05)/depth);
  vec2 safe=sign(ray.xy+1e-5)*max(abs(ray.xy),vec2(1e-4));
  vec2 side=(sign(safe)*.5-o.xy)/safe;
  float back=1./ray.z, t=min(back,min(side.x,side.y));
  vec3 hit=o+ray*t;
  float floorHit=step(side.y,min(back,side.x))*step(ray.y,0.);
  float ceilHit=step(side.y,min(back,side.x))*step(0.,ray.y);
  float backHit=step(back,min(side.x,side.y));
  vec3 wallC=mix(vec3(.55,.52,.46),vec3(.42,.47,.48),seed);
  vec3 col=wallC*mix(.62,.9,backHit);
  col=mix(col,vec3(.22,.18,.15)*(1.+seed*.4),floorHit);
  col=mix(col,vec3(.72,.71,.66),ceilHit);
  float furniture=backHit*step(abs(hit.x+.18-seed*.3),.22)*step(hit.y,-.12);
  col=mix(col,vec3(.18,.17,.16),furniture*.85);
  float shelf=backHit*step(.18,hit.x)*step(hit.x,.42)*step(abs(fract(hit.y*3.)-.5),.06);
  col=mix(col,vec3(.30,.26,.21),shelf);
  float lamp=ceilHit*smoothstep(.16,.05,length(hit.xz-vec2(0.,.4*depth)));
  vec3 light=mix(vec3(.30,.32,.33),vec3(1.,.82,.58)*1.6,lightOn);
  return col*light+vec3(1.,.86,.62)*lamp*lightOn*4.;
}

struct Mat {vec3 albedo; float rough; float metal; float ao; vec3 emit; float clear; float sheen; float trans; float f0;};

void main(){
  if (uMirrorPass && vPos.y<.037) discard;
  vec3 ng=normalize(vNormal);
  vec3 V=uEye-vPos;
  float dist=length(V);
  V/=dist;
  int kind=int(vTint.a+.5);
  if (kind==22 && ng.y<.5) discard;
  vec3 tint=toLinear(vTint.rgb);
  vec2 xz=vPos.xz;
  vec3 an=abs(ng);
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
  float px=max(length(dFdx(vPos)),length(dFdy(vPos)));
  bool lite=uQuality==0;
  bool hi=uQuality>=2;
  float zoneInterior=vPos.x>uUnderX*.5?1.:smoothstep(-.4,-3.2,vPos.y);
  bool cabin=vPos.x>uCabinX-640.;
  float floorY=cabin?uCabinY:vPos.x>uUnderX*.5?uUnderY:0.;
  float above=vPos.y-floorY;

  // ---------- transparent and unlit effects ----------
  if (kind==28) {
    float r=length(vUV-.5)*2.;
    float a=pow(sat(1.-r),1.7)*vExtra.x;
    frag=vec4(0.,0.,0.,a);
    return;
  }
  if (kind==24) {
    float r=vUV.y, u=vUV.x, age=vExtra.x, fade=sat(vExtra.w-1.);
    float angle=(u>.5?u-1.:u)*6.2831853, halfAngle=vExtra.y*3.14159265;
    bool sector=halfAngle>.001;
    if (sector && abs(angle)>halfAngle) discard;
    float soft=max(.006,fwidth(r)*.78);
    float rim=1.-smoothstep(.012,.045+soft,abs(r-.961));
    float seam=sector?smoothstep(halfAngle-.056,halfAngle,abs(angle))*.81:0.;
    float ticks=step(.67,fract(u*48.))*smoothstep(.78,.89,r)*.48;
    float phase=sector?sat((angle+halfAngle)/(2.*halfAngle)):r;
    float wave=1.-smoothstep(.015,.075+soft,abs(phase-age));
    float fragments=.54+.46*sin(r*57.-uClock*10.+sin(u*50.));
    float hatching=(1.-smoothstep(.18,.49,abs(fract((vPos.x+vPos.z)*1.62-uClock*.35)-.5)))*.31;
    vec3 col; float alpha;
    if (vExtra.w<1.) {
      float light=max(max(rim,seam),wave*.85);
      col=mix(tint*1.6,vec3(2.4,2.2,2.1),light*.77);
      alpha=min(.96,max(rim*.77,seam*.77)+ticks*.18+wave*.30+(.075+hatching*.27+fragments*.053)*(.55+.45*age));
    } else {
      float charge=max(wave*.91,rim*.27);
      float trail=step(phase,age+.045)*(.24+fragments*.22)*max(.11,1.-fade);
      col=mix(tint*1.5,vec3(2.3,2.,2.),charge*.8);
      alpha=min(.86,trail+charge*.68)*(1.-fade);
    }
    frag=uHDR?vec4(col,alpha):vec4(grade(col*uExposure),alpha);
    return;
  }
  if (kind==25) {
    float rim=pow(1.-max(0.,dot(ng,V)),2.5);
    float veins=sin(vUV.x*32.+vUV.y*21.-uClock*19.+det(vUV*1.3).r*9.);
    float streak=smoothstep(.42,.96,veins)*.55+rim*.46;
    vec3 liquid=tint*(1.2+.5*max(dot(ng,uSun),0.)+.25*veins);
    vec3 col=mix(liquid,vec3(2.6,2.3,2.6),sat(streak))*1.4;
    frag=uHDR?vec4(col,.0):vec4(grade(col*uExposure),1.);
    return;
  }
  if (kind==17) {
    if (dot(ng,V)<=0.) discard;
    float edge=1.-smoothstep(.01,.035,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float nv=abs(dot(ng,V));
    vec3 r=reflect(-V,ng);
    float smudge=det(uvW*.6).r;
    vec3 refl=envSpec(r,.02+smudge*.06)*mix(1.,.55,zoneInterior);
    float F=.04+.96*pow(1.-nv,5.);
    vec3 col=refl*F+tint*.05;
    col+=uSunColor*specGGX(ng,V,uSun,vec3(.04),.03)*(1.-zoneInterior);
    float alpha=sat(.10+F*.85+edge*.18+smudge*.04);
    frag=uHDR?vec4(col/max(alpha,.05),alpha):vec4(grade(col/max(alpha,.05)*uExposure),alpha);
    return;
  }
  if (kind==16) {
    if (dot(ng,V)<=0.) discard;
    float border=1.-smoothstep(.012,.065,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float flow=.5+.5*sin(vUV.x*45.+vUV.y*13.-uClock*5.);
    float caustic=det(vUV*vec2(1.1,.7)+vec2(0.,uClock*.08)).b;
    vec3 col=tint*(1.25+border*.9+caustic*.6)+vec3(1.)*pow(1.-abs(dot(ng,V)),3.)*.5;
    float alpha=(.22+border*.44+flow*.08+caustic*.08)*(1.-vExtra.x*.64);
    frag=uHDR?vec4(col,alpha):vec4(grade(col*uExposure),alpha);
    return;
  }
  if (kind==12) {
    float contour=sin(vUV.y*3.14159)*(.65+.35*sin(vUV.x*21.+uClock*8.));
    vec3 col=tint*1.9;
    float alpha=max(0.,contour)*(.46*(1.-vExtra.x));
    frag=uHDR?vec4(col,alpha):vec4(grade(col*uExposure),alpha);
    return;
  }

  // ---------- surface description ----------
  Mat m;
  m.albedo=tint; m.rough=.6; m.metal=0.; m.ao=1.; m.emit=vec3(0.);
  m.clear=0.; m.sheen=0.; m.trans=0.; m.f0=.04;
  vec3 n=ng;
  float alphaOut=1.;

  // Box-local frame: rounded edge normals and per-face coordinates.
  vec3 axZ=cross(vAxisX,vAxisY);
  vec3 lp=vLocal*vSize;
  vec3 nObj=vec3(dot(ng,vAxisX),dot(ng,vAxisY),dot(ng,axZ));
  vec3 faceMask=step(vec3(.5),abs(nObj));
  float edge=0.;
  vec2 faceUV=lp.xz, faceSize=vSize.xz;
  if (faceMask.x>.5) {faceUV=vec2(-sign(nObj.x)*lp.z,lp.y);faceSize=vSize.zy;}
  else if (faceMask.z>.5) {faceUV=vec2(sign(nObj.z)*lp.x,lp.y);faceSize=vSize.xy;}
  bool boxy=uShape==1 && kind!=3 && kind!=6 && kind!=7 && kind!=9 && kind!=22 && kind!=26;
  if (boxy) {
    float minDim=min(min(vSize.x,vSize.y),vSize.z);
    float radius=clamp(minDim*.16,.004,kind==11?.06:.04);
    float vis=smoothstep(px*.6,px*2.4,radius);
    vec3 dEdge=vSize*.5-abs(lp);
    vec3 bend=sat(1.-dEdge/radius)*(1.-faceMask);
    edge=max(max(bend.x,bend.y),bend.z);
    vec3 bent=nObj+sign(lp)*bend*vis;
    n=normalize(vAxisX*bent.x+vAxisY*bent.y+axZ*bent.z);
  }

  float grime=det(uvW*.043).r;
  float stain=det(uvW*.17+.31).r;
  float wallBase=1.-smoothstep(0.,.95+grime*.6,above);
  bool vertical=an.y<.45;

  // ---------- real surface textures ----------
  // The texture picked for this surface (surfaces.js). The procedural look
  // below stays as the fallback until its sheet has loaded.
  vec3 sdpx=dFdx(vPos), sdpy=dFdy(vPos);
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy), sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  bool belowGround=vPos.x>uUnderX*.5 && !cabin;
  int slot=uSurfaceSheets>0 && !uMirrorPass?surfaceFor(kind,vTint.rgb,ng,vSeed,vSize,uShape,belowGround,cabin,vExtra.y,above):-1;
  bool real=surfaceReady(slot);
  bool rounded=kind==14 || kind==23 || kind==13 && uShape==0;
  vec4 stex=!real?vec4(0.):rounded?surfaceTri(slot,vPos,ng,sdpx,sdpy):surfaceTap(slot,uvW,sdx,sdy);
  float surfH=0., relief=0.;

  if (kind==3) {
    float along=sat(1.-abs(vLocal.x)*2.);
    float core=.82+.18*smoothstep(0.,.6,along);
    float strength=mix(3.2,11.,zoneInterior);
    m.emit=tint*strength*core;
    m.albedo=tint*.4; m.rough=.25;
  } else if (kind==1 || kind==15 || kind==27) {
    vec4 d1=det(uvW*.31);
    vec4 d2=det(uvW*1.37);
    vec4 d3=det(uvW*5.3);
    float underground=step(uUnderX*.5,vPos.x)*(1.-float(cabin));
    if (cabin) {
      float fleck=smoothstep(.62,.7,d3.a)*.25-smoothstep(.3,.22,d3.a)*.12;
      m.albedo=tint*(.92+fleck+d1.r*.08);
      m.rough=.52-d2.r*.08;
    } else if (underground>.5 && kind==1 && lum(tint)>.30) {
      vec2 tile=fract(uvW/.6);
      vec2 tid=floor(uvW/.6);
      float joint=min(min(tile.x,1.-tile.x),min(tile.y,1.-tile.y))*.6;
      float grout=(1.-smoothstep(.003,.006+px*.5,joint))*(1.-smoothstep(.02,.07,px));
      float terr=smoothstep(.55,.75,d3.g)*.10+smoothstep(.62,.8,det(uvW*11.).a)*.06;
      m.albedo=tint*(.93+hash12(tid)*.10+terr-d1.r*.06)*mix(1.,.62,grout);
      m.rough=mix(.16+d2.r*.12,.7,grout);
      m.ao=1.-grout*.4;
    } else {
      vec2 slab=uvW/vec2(3.4,4.1);
      vec2 cell=fract(slab+.5)-.5;
      vec2 sid=floor(slab+.5);
      float cut=min(abs(cell.x)*3.4,abs(cell.y)*4.1);
      float joint=(1.-smoothstep(.004,.012+px*.6,cut))*(1.-smoothstep(.025,.09,px));
      float pores=smoothstep(.16,.04,d2.g)*.5;
      float aggregate=smoothstep(.62,.8,d3.g)*.10;
      float tone=.90+hash12(sid)*.09+(d1.r-.5)*.16+(d3.a-.5)*.07-pores*.12+aggregate;
      float oil=smoothstep(.62,.8,det(uvW*.09+.7).r)*.22;
      m.albedo=tint*tone*(1.-oil)*mix(1.,.55,joint);
      m.rough=.78+d2.r*.12-oil*.25;
      m.ao=1.-joint*.55;
      if (!lite) {
        float h0=d3.a, hx=det(uvW*5.3+vec2(.004,0.)).a, hz=det(uvW*5.3+vec2(0.,.004)).a;
        n=normalize(n+vec3(h0-hx,0.,h0-hz)*.9*(1.-smoothstep(.002,.02,px)));
      }
      if (kind==15) {
        float nosing=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)));
        m.albedo*=mix(1.,.55,nosing*step(.6,an.y));
        m.rough=mix(m.rough,.9,nosing);
      }
      if (kind==27) m.albedo*=mix(vec3(1.),vec3(.86,.95,.78),smoothstep(.55,.75,stain)*.6);
    }
    if (real) {
      // The texture replaces the procedural slabs and tiles; oil stains, stair
      // nosings and the outer district's lawns and moss go on top.
      float oil=kind==1 && underground<.5 && !cabin?smoothstep(.62,.8,det(uvW*.09+.7).r)*.18:0.;
      vec3 ground=realSurface(stex,slot,tint,1.,.010,surfH);
      if (kind==27) {
        float h2=0., h3=0., h4=0., cover=0.;
        if (surfaceReady(S_ASPHALT_WORN)) ground=mix(ground,realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(31.,17.),sdx,sdy),
          S_ASPHALT_WORN,tint*.82,1.,.010,h2),smoothstep(.42,.58,sfNoise(xz*.019+5.3)));
        int patchSlot=outerPatch(xz,cover);
        if (cover>0. && surfaceReady(patchSlot)) {
          ground=mix(ground,realSurface(surfaceTap(patchSlot,uvW,sdx,sdy),patchSlot,tint,1.,.014,h3),cover);
          surfH=mix(surfH,h3,cover);
        }
        if (surfaceReady(S_MOSS)) ground=mix(ground,realSurface(surfaceTap(S_MOSS,uvW*1.3,sdx*1.3,sdy*1.3),S_MOSS,tint,1.,.01,h4),
          smoothstep(.6,.8,stain)*.55);
      }
      if (kind==15 && surfaceReady(S_RUBBER_STAIR)) {
        float h5=0., nose=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)))*step(.6,an.y);
        ground=mix(ground,realSurface(surfaceTap(S_RUBBER_STAIR,uvW,sdx,sdy),S_RUBBER_STAIR,vec3(.05),1.,.006,h5),nose);
      }
      m.albedo=ground*(1.-oil);
      m.ao=1.;
      relief=1.;
    }
  } else if (kind==5) {
    vec4 d1=det(uvW*.23);
    vec4 d2=det(uvW*1.9);
    vec4 d3=det(uvW*7.1);
    float stones=smoothstep(.30,.08,d3.g);
    float crackZone=smoothstep(.58,.70,det(uvW*.031+.4).r);
    float tar=smoothstep(.84,.97,det(uvW*.083+.2).b)*crackZone*.85;
    float patchy=smoothstep(.45,.62,d1.r);
    vec3 asphalt=tint*.70*(.86+(d2.r-.5)*.24+stones*.32+(d3.a-.5)*.18)*mix(1.,.86,patchy);
    if (real) {
      // Fresh and worn asphalt alternate in broad stretches along the road.
      float h1=0., h2=0., aged=smoothstep(.38,.62,sfNoise(xz*.026+1.7));
      vec3 fresh=realSurface(stex,S_ASPHALT,tint*.70,1.,.008,h1), old=fresh;
      if (surfaceReady(S_ASPHALT_WORN)) old=realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(9.,23.),sdx,sdy),S_ASPHALT_WORN,tint*.70,1.,.008,h2);
      else h2=h1;
      asphalt=mix(fresh,old,aged);
      surfH=mix(h1,h2,aged);
    }
    asphalt=mix(asphalt,vec3(.018,.019,.02),tar);
    float puddle=smoothstep(.56,.70,det(xz*.045+.11).r*.75+d1.r*.35);
    if (uMirrorPass) puddle=0.;
    float wet=sat(puddle*1.6);
    if (real) relief=1.-wet;
    m.albedo=asphalt*mix(1.,.45,wet);
    m.rough=mix(.86-stones*.12,.06,puddle);
    m.ao=1.-tar*.3;
    if (!lite) {
      float h0=d3.g, hx=det(uvW*7.1+vec2(.003,0.)).g, hz=det(uvW*7.1+vec2(0.,.003)).g;
      vec3 bump=vec3(hx-h0,0.,hz-h0)*1.4*(1.-wet)*(1.-smoothstep(.002,.02,px));
      n=normalize(n+bump);
      float rip=sin(xz.x*5.1+xz.y*2.3+uClock*1.3)*sin(xz.y*4.7-xz.x*1.1-uClock*1.1);
      n=normalize(mix(n,vec3(rip*.02,1.,rip*.015),puddle));
    }
  } else if (kind==2 || kind==19) {
    vec4 d1=det(uvW*.29);
    vec4 d2=det(uvW*1.6);
    vec4 d3=det(uvW*6.2);
    float pores=smoothstep(.13,.03,d3.g);
    float tone=.92+(d1.r-.5)*.16+(d2.r-.5)*.10+(d3.a-.5)*.06-pores*.18;
    float streak=vertical?smoothstep(.45,.85,det(vec2(uvW.x*1.3,uvW.y*.07)).r)*smoothstep(.3,.7,stain):0.;
    vec3 c=tint*tone;
    c=mix(c,c*vec3(.72,.70,.64),streak*.55);
    c=mix(c,c*vec3(.62,.60,.52),wallBase*.55*float(vertical));
    float big=step(2.4,min(faceSize.x,faceSize.y))*step(lum(tint)*.2,.2)*float(vertical)*(1.-step(.18,abs(tint.r-tint.b)));
    if (big>.5 && !lite) {
      vec2 g=(faceUV+faceSize*.5)/vec2(.9,.6);
      vec2 cg=fract(g)-.5;
      float hole=smoothstep(.06,.035,length(cg*vec2(.9,.6)));
      vec2 seams=abs(fract((faceUV+faceSize*.5)/vec2(1.8,.9))-.5)*vec2(1.8,.9);
      float seam=1.-smoothstep(.002,.006+px*.6,min(seams.x,seams.y));
      c*=1.-hole*.38-seam*.18;
    }
    c=mix(c,tint*1.08+vec3(.03),edge*.5*smoothstep(.4,.7,d2.r));
    m.albedo=kind==19?tint*(.97+d2.r*.05):c;
    m.rough=.84+d2.r*.1-streak*.1;
    m.ao=1.-pores*.25;
    if (real) {
      vec3 wall=realSurface(stex,slot,tint,1.,.010,surfH);
      wall=mix(wall,wall*vec3(.72,.70,.64),streak*.35);
      wall=mix(wall,wall*vec3(.62,.60,.52),wallBase*.55*float(vertical));
      if (vertical && !cabin && !belowGround && surfaceReady(S_MOSS)) {
        float h2=0.;
        wall=mix(wall,realSurface(surfaceTap(S_MOSS,uvW,sdx,sdy),S_MOSS,tint,1.,.01,h2),wallBase*smoothstep(.62,.82,stain)*.6);
      }
      m.albedo=wall;
      m.ao=1.;
      relief=1.;
    }
    if (!lite) {
      float h0=d3.r, hx=det(uvW*6.2+vec2(.004,0.)).r, hy=det(uvW*6.2+vec2(0.,.004)).r;
      vec3 t1=an.y>.6?vec3(1,0,0):(an.x>an.z?vec3(0,0,1):vec3(1,0,0));
      vec3 t2=an.y>.6?vec3(0,0,1):vec3(0,1,0);
      n=normalize(n-(t1*(hx-h0)+t2*(hy-h0))*.55*(1.-smoothstep(.002,.02,px)));
    }
  } else if (kind==13) {
    vec2 bricks=uvW/vec2(.69,.296);
    bricks.x+=mod(floor(bricks.y),2.)*.5;
    vec2 b=fract(bricks), id=floor(bricks);
    vec2 jd=min(b,1.-b)*vec2(.69,.296);
    float joint=min(jd.x,jd.y);
    float mortar=1.-smoothstep(.006,.016+px*.5,joint);
    vec4 d2=det(uvW*1.7+id*.13);
    float stone=hash12(id);
    vec3 c=tint*(.84+stone*.24+(d2.r-.5)*.18)*mix(vec3(1.),vec3(1.04,.97,.92),hash12(id+7.)*.5);
    c=mix(c,vec3(.52,.50,.46)*(.9+d2.a*.2),mortar*.85);
    c=mix(c,c*.66,wallBase*.6*float(vertical));
    m.albedo=c;
    m.rough=mix(.74+d2.r*.12,.92,mortar);
    m.ao=1.-mortar*.45;
    if (real) {
      bool natural=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
      vec3 b=realSurface(stex,slot,tint,1.,natural?.02:.012,surfH);
      if (!natural) b=mix(b,b*.66,wallBase*.6*float(vertical));
      m.albedo=b;
      m.ao=1.;
      if (natural) m.rough=.9;
      relief=1.;
    }
    if (!lite && vertical && !real) {
      vec3 t1=an.x>an.z?vec3(0,0,1):vec3(1,0,0);
      float ex=smoothstep(.04,.0,jd.x)*sign(b.x-.5);
      float ey=smoothstep(.03,.0,jd.y)*sign(b.y-.5);
      n=normalize(n+(t1*ex+vec3(0,1,0)*ey)*.45*(1.-smoothstep(.003,.03,px)));
    }
  } else if (kind==4) {
    vec4 d1=det(uvW*.5);
    vec4 d2=det(uvW*3.1);
    float sat0=max(max(tint.r,tint.g),tint.b)-min(min(tint.r,tint.g),tint.b);
    float galvanized=step(sat0,.035)*step(.12,lum(tint));
    float wear=smoothstep(.62,.9,edge+d2.r*.45);
    float rust=smoothstep(.80,.93,det(vec2(uvW.x*.9,uvW.y*.22)+.4).r)*(1.-galvanized)*smoothstep(.55,.85,1.-lum(tint))*.65;
    vec3 paint=tint*(.94+(d1.r-.5)*.12);
    vec3 steel=vec3(.56,.57,.58), corrosion=vec3(.22,.10,.05);
    if (real) {
      paint=realSurface(stex,slot,tint,1.,.004,surfH);
      steel=realSurface(stex,slot,steel,1.,.004,surfH);
      relief=1.;
      if (surfaceReady(S_RUST)) {
        float hr=0.;
        corrosion=realSurface(surfaceTap(S_RUST,uvW,sdx,sdy),S_RUST,corrosion,1.,.006,hr);
      }
    }
    m.metal=mix(mix(.0,1.,galvanized),1.,wear*(1.-galvanized)*.8);
    m.albedo=mix(paint,steel*(.85+d2.g*.3),max(galvanized*.8,wear*.8));
    m.albedo=mix(m.albedo,corrosion,rust);
    m.rough=mix(mix(.38+d2.r*.14,.34+d2.g*.2,galvanized),.85,rust);
    if (!lite) {
      float brush=sin(dot(uvW,vec2(0.,1.))*420.+d2.r*7.)*.5+.5;
      m.rough+=brush*.05*galvanized;
      m.clear=(1.-galvanized)*(1.-wear)*.35;
    }
    m.albedo=mix(m.albedo,m.albedo*.6,wallBase*.4*float(vertical));
  } else if (kind==8 || kind==6) {
    vec3 r=reflect(-V,n);
    bool windowPane=kind==8 && vertical && min(faceSize.x,faceSize.y)>.55 && max(faceSize.x,faceSize.y)>.9 && uShape==1;
    if (kind==6 && !vertical) {
      float rip=sin(xz.x*4.3+xz.y*1.9+uClock*.9)*sin(xz.y*4.7-xz.x*.9-uClock*.82);
      n=normalize(vec3(rip*.05,1.,cos(xz.x*2.7+xz.y*1.8+uClock*.8)*.04));
      m.albedo=tint*.25; m.rough=.04; m.f0=.02;
    } else {
      float dirt=det(uvW*.8).r;
      m.albedo=tint*.05; m.rough=.02+dirt*.05; m.f0=.045;
      if (real) {
        float smear=sfLum(stex.rgb);
        m.rough=mix(m.rough,.38,smear*.55);
        m.albedo=mix(m.albedo,toLinear(stex.rgb)*.3,smear*.22);
      }
      vec3 tx=normalize(faceMask.x>.5?axZ*(-sign(nObj.x)):faceMask.z>.5?vAxisX*sign(nObj.z):vAxisX);
      vec3 ty=vAxisY;
      if (uShape==1 && vertical && max(faceSize.x,faceSize.y)>2.6) {
        vec2 paneSz=vec2(faceSize.x/max(1.,floor(faceSize.x/1.5)),faceSize.y/max(1.,floor(faceSize.y/1.7)));
        vec2 pg=(faceUV+faceSize*.5)/paneSz;
        vec2 pc=fract(pg), pid=floor(pg);
        float fr=1.-smoothstep(.025,.045,min(min(pc.x,1.-pc.x)*paneSz.x,min(pc.y,1.-pc.y)*paneSz.y));
        n=normalize(n+(tx*(hash12(pid)-.5)+ty*(hash12(pid+3.)-.5))*.035);
        m.albedo=mix(m.albedo,vec3(.05,.055,.06),fr);
        m.rough=mix(m.rough+hash12(pid+7.)*.05,.45,fr);
        m.f0=mix(m.f0,.04,fr);
      }
      if ((windowPane || kind==6) && !uMirrorPass) {
        vec3 vt=vec3(dot(-V,tx),dot(-V,ty),dot(V,n));
        vec2 cellSz=kind==6?vec2(1.6,2.7):faceSize;
        vec2 uv=(faceUV+faceSize*.5)/cellSz;
        vec2 rid=floor(uv)+floor(vPos.xz*.1);
        float seed=hash12(rid+floor(vPos.y/3.));
        float on=step(.62,hash12(rid*1.7+3.))*mix(.35,1.,zoneInterior);
        vec3 room=roomBehind(fract(uv),vec3(vt.x,vt.y,vt.z)*vec3(1.,1.,1.),seed,on,kind==6?2.2:1.6);
        float fres=.04+.96*pow(1.-max(dot(n,V),0.),5.);
        m.emit=room*(1.-fres)*mix(.38,.9,zoneInterior)*(1.-dirt*.3);
        float blind=kind==6?step(.7,seed)*smoothstep(.0,.02,fract(uv.y)-.6):0.;
        m.emit*=1.-blind*.7;
        m.albedo=mix(m.albedo,vec3(.62,.6,.55),blind);
      }
    }
  } else if (kind==11) {
    if (an.y>.55) {
      vec4 d1=det(uvW*.4);
      m.albedo=tint*.72*(.85+d1.r*.25)*mix(1.,.8,smoothstep(.6,.8,stain));
      m.rough=.9;
    } else {
      vec2 fsz=faceSize;
      // Each building picks a facade type from its paint: punched windows,
      // ribbon windows or a full glass curtain wall.
      float facade=fract(dot(vTint.rgb,vec3(17.3,7.9,11.1)));
      bool curtain=facade>.72 && fsz.y>9.;
      bool ribbon=!curtain && facade>.46;
      vec2 cellSz=vec2(fsz.x/max(1.,floor(fsz.x/(curtain?1.6:2.2))),3.15);
      vec2 g=(faceUV+fsz*.5)/cellSz;
      vec2 cell=fract(g), cid=floor(g);
      vec2 fw=fwidth(g);
      vec2 lo=curtain?vec2(.035,.05):ribbon?vec2(.02,.30):vec2(.17,.24);
      vec2 hiE=curtain?vec2(.965,.95):ribbon?vec2(.98,.82):vec2(.83,.86);
      vec2 inW=smoothstep(lo-fw,lo+fw,cell)*(1.-smoothstep(hiE-fw,hiE+fw,cell));
      float win=inW.x*inW.y;
      if (real) relief=1.-win;
      float detailVis=1.-smoothstep(.08,.35,max(fw.x,fw.y));
      vec4 d2=det(uvW*1.2);
      float under=smoothstep(lo.y,lo.y-.25,cell.y)*step(lo.x,cell.x)*step(cell.x,hiE.x);
      vec3 wall=tint*(.9+(d2.r-.5)*.14);
      if (real) wall=realSurface(stex,slot,tint,1.,.008,surfH);
      wall*=1.-under*smoothstep(.4,.8,det(vec2(g.x*3.,g.y*.25)).r)*.32;
      wall=mix(wall,wall*.8,smoothstep(.55,.8,stain)*.5);
      float sill=smoothstep(.035,.0,abs(cell.y-lo.y+.03))*step(lo.x-.03,cell.x)*step(cell.x,hiE.x+.03);
      wall=mix(wall,vec3(.75,.74,.70),sill*.6*detailVis);
      vec3 tx=normalize(faceMask.x>.5?axZ*(-sign(nObj.x)):faceMask.z>.5?vAxisX*sign(nObj.z):vAxisX);
      vec3 vt=vec3(dot(-V,tx),dot(-V,vAxisY),dot(V,n));
      vec2 recess=vt.xy/max(vt.z,.2)*.08/cellSz;
      vec2 wuv=(cell-lo)/(hiE-lo);
      vec2 rev=step(wuv,-recess*4.)+step(1.-recess*4.,wuv);
      float reveal=sat(max(rev.x,rev.y))*detailVis;
      float seed=hash12(cid+floor(vPos.xz*.37));
      float on=step(.7,hash12(cid*3.1+1.7));
      vec3 room=detailVis>.01 && !lite?roomBehind(sat(wuv),vt,seed,on,1.4):vec3(.18,.2,.21)*(.8+seed*.4);
      float mull=1.-smoothstep(.006,.014,abs(wuv.x-.5));
      float pane=hash12(cid+.3);
      vec3 glassTint=curtain?mix(vec3(.025,.04,.05),vec3(.04,.05,.045),pane):vec3(.03);
      m.albedo=mix(wall,glassTint,win);
      m.rough=mix(.82,.03+pane*.04,win);
      m.f0=mix(.04,curtain?.11:.075,win);
      vec3 nWin=normalize(n+(tx*(pane-.5)+vAxisY*(hash12(cid+5.)-.5))*.02);
      n=normalize(mix(n,nWin,win));
      float fres=.04+.96*pow(1.-max(dot(n,V),0.),5.);
      m.emit=room*win*(1.-fres)*(1.-reveal)*.30*(1.-mull*.8);
      m.albedo=mix(m.albedo,vec3(.42,.43,.42),reveal*win+mull*win*detailVis);
      m.rough=mix(m.rough,.6,reveal*win);
      m.ao=1.-reveal*win*.5;
      if (detailVis<.99) {
        m.albedo=mix(mix(wall,vec3(.08,.1,.11),.45),m.albedo,detailVis);
      }
    }
  } else if (kind==14) {
    vec3 tw=pow(abs(ng),vec3(3.));
    tw/=tw.x+tw.y+tw.z;
    vec3 q=vPos*.16;
    float clumps=det(q.zy).g*tw.x+det(q.xz+.31).g*tw.y+det(q.xy+.67).g*tw.z;
    vec3 q2=vPos*.21;
    float leaves=det(q2.zy).a*tw.x+det(q2.xz+.13).a*tw.y+det(q2.xy+.71).a*tw.z;
    float rim=1.-abs(dot(ng,V));
    if (!uMirrorPass && !lite && rim>.42 && clumps>mix(.98,.40,(rim-.42)/.58)) discard;
    float hgt=-clumps*.34+leaves*.05;
    vec3 dpx=dFdx(vPos), dpy=dFdy(vPos);
    vec3 r1=cross(dpy,ng), r2=cross(ng,dpx);
    float dt=dot(dpx,r1);
    vec3 grad=sign(dt)*(dFdx(hgt)*r1+dFdy(hgt)*r2);
    n=normalize(abs(dt)*ng-grad);
    float tone=det(vPos.xz*.05+vPos.y*.03).r;
    vec3 hue=tint*mix(vec3(.70,.84,.52),vec3(1.10,1.08,.68),tone)*(.78+leaves*.44);
    m.albedo=hue*mix(1.,.5,smoothstep(.35,.85,clumps));
    if (real) {
      m.albedo=realSurface(stex,slot,m.albedo,1.,.02,surfH);
      relief=.6;
    }
    m.rough=.6; m.f0=.03;
    m.ao=mix(.34,1.,sat(1.-clumps*.95+ng.y*.22));
    m.trans=.6;
  } else if (kind==29) {
    vec2 g=faceUV+faceSize*.5;
    vec2 along=faceSize.x>=faceSize.y?g:g.yx;
    float row=floor(along.y/.115);
    float pid=hash12(vec2(row,floor(along.x/1.3+row*.37)));
    float fibre=det(vec2(along.x*.32,along.y*3.9+pid*3.)).r;
    float rings=.5+.5*sin(along.y*41.+fibre*10.+pid*6.);
    float seam=1.-smoothstep(.003,.008+px*.5,min(fract(along.y/.115),1.-fract(along.y/.115))*.115);
    vec3 timber=tint*(.74+pid*.32)*(.84+rings*.2)*(.92+det(along*1.7).a*.16);
    m.albedo=mix(timber,timber*.32,seam);
    m.rough=.74+fibre*.12;
    m.ao=1.-seam*.5;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,1.,.012,surfH);
      m.ao=1.;
      relief=1.;
    }
    if (!lite && !real) n=normalize(n+vAxisY*(rings-.5)*.025*(1.-seam));
  } else if (kind==18 || kind==30 || kind==31) {
    vec2 w=uvW*vec2(210.,210.);
    float weave=(sin(w.x)*sin(w.y))*.5+.5;
    float fade=1.-smoothstep(.0015,.006,px);
    m.albedo=tint*(.9+det(uvW*2.).r*.12+(weave-.5)*.08*fade);
    m.rough=.88; m.sheen=.55; m.f0=.03;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,1.,.003,surfH);
      relief=.5;
    }
  } else if (kind==20) {
    float peel=det(uvW*9.).r;
    m.albedo=tint*(.97+peel*.04);
    m.rough=.30+peel*.06; m.clear=.75; m.f0=.04;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,.6,.002,surfH);
      relief=.4;
    }
    if (!lite) n=normalize(n+(vec3(det(uvW*9.+.01).r,0.,det(uvW*9.-.01).r)-peel)*.04);
  } else if (kind==21) {
    vec4 d2=det(uvW*4.);
    m.albedo=tint*(.9+d2.r*.14)+vec3(.012)*sat(n.y);
    m.rough=.68+d2.a*.1; m.sheen=.18; m.f0=.035;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,1.,.003,surfH);
      relief=.5;
    }
  } else if (kind==9) {
    m.albedo=tint*.92; m.rough=.07; m.clear=1.; m.f0=.04;
    m.trans=.35;
    m.emit=tint*.22;
  } else if (kind==23) {
    float rib=sin(vUV.y*85.+sin(vUV.x*37.7)*.86);
    float nacre=pow(1.-max(0.,dot(ng,V)),2.2);
    float pores=lite?.5:det(vUV*vec2(3.,2.)).g;
    vec3 interference=mix(vec3(.10,.22,.40),vec3(.53,.24,.38),.5+.5*sin(vUV.x*18.85+vUV.y*8.));
    m.albedo=mix(tint*(.85+pores*.22+rib*.07),toLinear(interference),.32*nacre);
    m.rough=.26+.08*pores; m.clear=.8; m.metal=.1;
    if (real) {
      m.albedo=realSurface(stex,slot,m.albedo,.8,.006,surfH);
      relief=.6;
    }
  } else if (kind==26) {
    m.albedo=tint*.95; m.rough=.09; m.clear=.9;
    m.emit=tint*.05;
  } else if (kind==7) {
    float index=vExtra.x;
    vec2 tile=vec2(mod(index,uAtlasGrid.x),floor(index/uAtlasGrid.x));
    vec2 uv=(tile+vec2(mix(.01,.99,vUV.x),mix(.02,.98,1.-vUV.y)))/uAtlasGrid;
    if (dot(ng,V)<=0.) discard;
    alphaOut=texture(uAtlas,uv).a;
    if (alphaOut<.012) discard;
    m.albedo=tint*.92; m.rough=.6;
  } else if (kind==0 || kind==22) {
    vec4 d2=det(uvW*2.3);
    float worn=an.y>.6?smoothstep(.55,.75,det(uvW*.6).r*.6+d2.r*.5):0.;
    m.albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
    m.rough=.62+worn*.2;
    if (an.y>.6 && !lite) {
      float bead=step(.985,det(uvW*31.).a)*(1.-worn);
      m.f0=mix(.04,.4,bead); m.rough=mix(m.rough,.2,bead);
    }
    if (real) {
      m.albedo=realSurface(stex,slot,m.albedo,kind==22?1.:.7,.003,surfH);
      relief=.5;
    }
  }

  // Relief from the texture's own shading (screen-space bump mapping).
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0.) {
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float area=dot(sdpx,r1);
    n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
  }

  // ---------- liquid ink on paintable floors ----------
  float inked=0.;
  vec2 liquid=vec2(0.);
  bool lowerInk=vExtra.y>=1.5 && vExtra.y<3.5;
  bool cabinInk=vExtra.y>4.5;
  float cabinOrigin=vExtra.y>5.5?uRailCabinX:uCabinX;
  float inkFloor=cabinInk?uCabinY:lowerInk?uUnderY:0.;
  if (kind==27 && dot(xz,xz)>${CITY_RADIUS**2}.0) discard;
  if ((kind==1 || kind==5 || kind==15 || kind==22) && ng.y>.48 && (kind==15 || vPos.y>inkFloor-.055)) {
    vec2 mapPoint=vec2(xz.x-(cabinInk?cabinOrigin:lowerInk?uUnderX:0.),xz.y);
    vec2 inkUV=(mapPoint/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      ivec2 size=textureSize(uInk,0).xy;
      vec2 grid=inkUV*vec2(size)-.5;
      ivec2 pixel=ivec2(floor(grid));
      vec2 part=fract(grid);
      part=part*part*(3.-2.*part);
      int layer=int(vExtra.y);
      float clearance=kind==15 || layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
      vec4 a=filmCell(pixel,size,layer,vPos.y,clearance);
      vec4 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
      vec4 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
      vec4 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
      vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
      float corners=a.r+a.g, edgeCell=abs(corners-(b.r+b.g))+abs(corners-(c.r+c.g))+abs(corners-(d.r+d.g));
      if (edgeCell>.01 && a.w*b.w*c.w*d.w>.5) {
        vec2 hs=.5/vec2(size);
        float lf=float(layer);
        st=(texture(uInk,vec3(inkUV+vec2(-hs.x,-hs.y),lf)).rgb+texture(uInk,vec3(inkUV+vec2(hs.x,-hs.y),lf)).rgb
           +texture(uInk,vec3(inkUV+vec2(-hs.x,hs.y),lf)).rgb+texture(uInk,vec3(inkUV+hs,lf)).rgb)*.25;
      }
      float coverage=st.r+st.g;
      if (coverage>.08) {
        float rough0=det(xz*.83).r*.6+det(xz*2.9).a*.4;
        float thr=.5+(rough0-.5)*.38;
        float aa=fwidth(coverage)*.9+.015;
        float mask=smoothstep(thr-aa,thr+aa,coverage);
        if (mask>.003) {
          vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014);
          float thick=st.b;
          vec3 ink=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
          if (!lite) {
            vec3 coord=vec3(inkUV,vExtra.y);
            float w0=texture(uInk,coord-vec3(uInkTexel.x,0.,0.)).b, e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float n0=texture(uInk,coord-vec3(0.,uInkTexel.y,0.)).b, s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 gradient=vec2(e0-w0,s0-n0);
            float wob=det(xz*1.7+vec2(uClock*.02,0.)).r-.5;
            liquid=-gradient*.9+vec2(wob,det(xz*1.7+.5).r-.5)*.05;
            float bubble=smoothstep(.07,.02,det(xz*4.1).g)*.25*(1.-thick);
            liquid+=vec2(bubble*.6);
          }
          m.albedo=mix(m.albedo,ink,mask);
          m.rough=mix(m.rough,.21+length(liquid)*.18,mask);
          m.metal=mix(m.metal,0.,mask);
          m.clear=mix(m.clear,.32,mask);
          m.emit=mix(m.emit,ink*.05,mask);
          m.ao=mix(m.ao,1.,mask*.6);
          m.f0=mix(m.f0,.045,mask);
          n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
          inked=mask;
        }
      }
    }
  }

  // ---------- lighting ----------
  float nv=max(dot(n,V),1e-4);
  vec3 R=reflect(-V,n);
  vec3 f0=mix(vec3(m.f0),m.albedo,m.metal);
  vec3 diffC=m.albedo*(1.-m.metal);
  float outdoor=1.-zoneInterior;
  vec3 direct=vec3(0.), ambient=vec3(0.);

  if (outdoor>.001) {
    float sh=sunShadow(vPos,ng);
    float nl=dot(n,uSun);
    float wrap=m.trans>0.?sat((nl+.4)/1.4):sat(nl);
    vec3 sun=uSunColor*sh;
    direct+=diffC*(1./PI)*sun*wrap;
    direct+=sun*specGGX(n,V,uSun,f0,max(m.rough,.03));
    if (m.clear>0.) direct+=sun*specGGX(n,V,uSun,vec3(.04),.05)*m.clear;
    if (m.trans>0.) direct+=diffC*m.trans*sun*pow(sat(dot(-V,uSun)),3.)*.9*sat(1.-nl);
    vec3 irr=envDiffuse(n);
    float bounce=sat(-n.y)*.2;
    irr+=vec3(.36,.34,.30)*bounce;
    ambient+=diffC*irr*m.ao;
    vec3 spec=envSpec(R,m.rough);
    if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
    if (uReflectOn && !uMirrorPass && ng.y>.49 && abs(vPos.y)<.08 && (m.rough<.45)) {
      vec2 suv=gl_FragCoord.xy/uViewport+n.xz*.035;
      vec3 planar=texture(uReflection,suv).rgb;
      float w=(1.-smoothstep(.08,.40,m.rough))*mix(1.,.55,inked);
      spec=mix(spec,planar,w);
    }
    float so=sat(pow(nv+m.ao,exp2(-16.*m.rough-1.))-1.+m.ao);
    ambient+=spec*envBRDF(f0,m.rough,nv)*so;
    if (m.clear>0.) {
      vec3 cspec=envSpec(R,.05);
      if (uReflectOn && !uMirrorPass && ng.y>.49 && abs(vPos.y)<.08) cspec=texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.02).rgb;
      ambient+=cspec*(.04+.96*pow(1.-nv,5.))*m.clear*so;
    }
    if (m.sheen>0.) ambient+=m.albedo*m.sheen*pow(1.-nv,4.)*irr*.9;
    direct*=outdoor; ambient*=outdoor;
  }

  if (zoneInterior>.001) {
    vec3 dl=vec3(0.), sl=vec3(0.);
    vec3 amb=mix(vec3(.112,.112,.106),vec3(.094,.094,.089),n.y*.5+.5);
    float a=max(m.rough*m.rough,.002);
    bool inCabin=cabin;
    for (int k=0;k<4;k++) {
      vec3 c; float halfLen; float I;
      if (inCabin) {
        float origin=vPos.x>uRailCabinX-640.?uRailCabinX:uCabinX;
        float lx=vPos.x-origin;
        int best=0; float bd=1e9;
        for (int j=0;j<${CABIN_LAMPS.length};j++){float dd=abs(CABIN_LAMPS[j]-lx);if(dd<bd){bd=dd;best=j;}}
        int second=best+((lx>CABIN_LAMPS[best])?1:-1);
        second=clamp(second,0,${CABIN_LAMPS.length-1});
        int col=k<2?best:second;
        c=vec3(origin+CABIN_LAMPS[col],uCabinY+2.66,(k%2==0)?-.68:.68);
        halfLen=.86; I=2.6;
      } else if (vPos.x>uUnderX*.5) {
        float lx=vPos.x-uUnderX;
        float gx=clamp(floor((lx+57.2)/8.8),0.,12.);
        float colX=-57.2+(gx+float(k/2))*8.8;
        int row=0;
        for (int j=0;j<${LAMP_ROWS.length-1};j++) if (vPos.z>LAMP_ROWS[j]) row=j;
        float rz=LAMP_ROWS[min(row+(k%2),${LAMP_ROWS.length-1})];
        c=vec3(uUnderX+colX,uUnderY+6.38,rz);
        halfLen=1.1; I=15.;
      } else {
        c=vec3(vPos.x,-6.6,vPos.z+(float(k%2)-.5)*4.);
        halfLen=.6; I=4.;
      }
      vec3 A=c-vec3(halfLen,0.,0.), B=c+vec3(halfLen,0.,0.);
      vec3 pd=vec3(clamp(vPos.x,A.x,B.x),c.y,c.z);
      vec3 L=pd-vPos;
      float d2=dot(L,L);
      vec3 l=L*inversesqrt(d2);
      float window=sat(1.-d2/(I*I*6.));
      float atten=I/(d2+.35)*window*window;
      dl+=diffC*(1./PI)*max(dot(n,l),0.)*atten;
      vec3 L0=A-vPos, L1=B-vPos, Ld=L1-L0;
      float rl=dot(R,Ld);
      float t=sat((dot(R,L0)*rl-dot(L0,Ld))/max(dot(Ld,Ld)-rl*rl,1e-4));
      vec3 Ls=L0+t*Ld;
      float ds2=dot(Ls,Ls);
      vec3 ls=Ls*inversesqrt(ds2);
      float a2=sat(a+.06/sqrt(ds2));
      float norm=(a*a)/(a2*a2);
      vec3 h=normalize(ls+V);
      float nl=max(dot(n,ls),0.);
      sl+=ggxD(max(dot(n,h),0.),a2)*norm*visSmith(nv,nl,a2)*fresnel(f0,max(dot(V,h),0.))*nl*I/(ds2+.35)*window;
      if (m.clear>0.) {
        float ac=.05; float a3=sat(ac+.06/sqrt(ds2));
        sl+=ggxD(max(dot(n,h),0.),a3)*(ac*ac)/(a3*a3)*visSmith(nv,nl,a3)*fresnel(vec3(.04),max(dot(V,h),0.))*nl*I/(ds2+.35)*window*m.clear;
      }
    }
    vec3 lampTint=vec3(1.,.95,.86);
    direct+=(dl+sl)*lampTint*zoneInterior;
    float ceilY=inCabin?uCabinY+2.7:uUnderY+6.9;
    vec3 iR=R;
    vec3 roomEnv=mix(vec3(.05,.052,.05),vec3(.16,.16,.15),sat(iR.y*.5+.5));
    if (iR.y>.02) {
      float tt=(ceilY-vPos.y)/iR.y;
      vec3 hp=vPos+iR*tt;
      float spread=.03+m.rough*m.rough*tt*.6;
      float strip;
      if (inCabin) {
        float zb=min(abs(hp.z-.68),abs(hp.z+.68));
        strip=smoothstep(.12+spread,.08,zb);
      } else {
        float lx=hp.x-uUnderX+57.2;
        float cx=abs(fract(lx/8.8+.5)-.5)*8.8;
        float zb=1e3;
        for (int j=0;j<${LAMP_ROWS.length};j++) zb=min(zb,abs(hp.z-LAMP_ROWS[j]));
        strip=smoothstep(1.1+spread,1.05,cx)*smoothstep(.2+spread,.12,zb);
      }
      roomEnv+=vec3(1.,.95,.86)*strip*mix(3.,.6,sat(m.rough*2.))*exp(-tt*.04);
    }
    float so=sat(pow(nv+m.ao,exp2(-16.*m.rough-1.))-1.+m.ao);
    vec3 ispec=roomEnv*envBRDF(f0,m.rough,nv)*so;
    if (m.clear>0.) ispec+=roomEnv*(.04+.96*pow(1.-nv,5.))*m.clear*so;
    vec3 iamb=diffC*amb*m.ao*(inCabin?1.25:1.)+ispec;
    if (m.sheen>0.) iamb+=m.albedo*m.sheen*pow(1.-nv,4.)*amb;
    ambient+=iamb*zoneInterior;
  }

  vec3 col=direct+ambient+m.emit;

  // ---------- atmosphere ----------
  vec3 dir=-V;
  float fogAmt;
  if (outdoor>.001) {
    float fall=.022;
    float h0=uEye.y, dy=vPos.y-uEye.y;
    float integral=abs(dy)>.01?(exp(-fall*h0)-exp(-fall*vPos.y))/(fall*dy):exp(-fall*h0);
    float density=.0021;
    fogAmt=1.-exp(-density*dist*max(integral,0.));
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=envAt(fdir,4.5);
    fogCol+=uSunColor*.06*pow(sat(dot(dir,uSun)),8.);
    col=mix(col,fogCol,fogAmt*outdoor);
  } else fogAmt=0.;
  if (zoneInterior>.001) {
    float iFog=1.-exp(-dist*.011);
    col=mix(col,vec3(.07,.075,.072),iFog*zoneInterior*.55);
    fogAmt=max(fogAmt,iFog*.55*zoneInterior);
  }

  if (uHDR) {
    float total=lum(col)+1e-4;
    float ambFrac=sat(lum(ambient)/total)*(1.-fogAmt);
    frag=vec4(col,kind==7?alphaOut:ambFrac);
    if (kind==7) frag.rgb=col;
  } else {
    vec3 c=grade(col*uExposure);
    vec2 q=gl_FragCoord.xy/uViewport-.5;
    c*=1.-dot(q,q)*.42;
    frag=vec4(c,alphaOut);
  }
}`;

// ---------- post processing ----------
export const SSAO_FRAGMENT=`#version 300 es
precision highp float;
uniform highp sampler2D uDepth;
uniform vec2 uInvSize;
uniform vec4 uProj;
uniform float uRadius;
uniform float uIntensity;
out vec4 frag;
float lin(float d){float z=d*2.-1.;return 2.*uProj.z*uProj.w/(uProj.w+uProj.z-z*(uProj.w-uProj.z));}
vec3 viewPos(vec2 uv){float z=lin(textureLod(uDepth,uv,0.).r);return vec3((uv*2.-1.)*uProj.xy*z,-z);}
void main(){
  vec2 uv=gl_FragCoord.xy*uInvSize;
  float raw=textureLod(uDepth,uv,0.).r;
  if (raw>=.99999) {frag=vec4(1.);return;}
  vec3 P=viewPos(uv);
  vec3 pr=viewPos(uv+vec2(uInvSize.x,0.)), pl=viewPos(uv-vec2(uInvSize.x,0.));
  vec3 pt=viewPos(uv+vec2(0.,uInvSize.y)), pb=viewPos(uv-vec2(0.,uInvSize.y));
  vec3 dx=abs(pr.z-P.z)<abs(P.z-pl.z)?pr-P:P-pl;
  vec3 dy=abs(pt.z-P.z)<abs(P.z-pb.z)?pt-P:P-pb;
  vec3 N=normalize(cross(dx,dy));
  float z=-P.z;
  float radius=uRadius*mix(1.,2.4,smoothstep(8.,60.,z));
  float sr=min(radius/(z*uProj.y)*.5,.09);
  float aspect=uProj.x/uProj.y;
  float noise=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
  float ang=noise*6.2831853;
  float sum=0.;
  const int COUNT=12;
  for (int i=0;i<COUNT;i++){
    float t=(float(i)+.5)/float(COUNT);
    float a=ang+float(i)*2.3999632;
    vec2 off=vec2(cos(a)/aspect,sin(a))*sr*sqrt(t);
    vec3 Q=viewPos(uv+off);
    vec3 v=Q-P;
    float vv=dot(v,v);
    float fall=max(0.,1.-vv/(radius*radius));
    sum+=max(0.,dot(v,N)-.003*z)*fall/(vv+.012);
  }
  float ao=max(0.,1.-sum*2.*uIntensity/float(COUNT));
  frag=vec4(pow(ao,1.25),0.,0.,1.);
}`;

export const BLUR_FRAGMENT=`#version 300 es
precision highp float;
uniform sampler2D uAO;
uniform highp sampler2D uDepth;
uniform vec2 uStep;
uniform vec4 uProj;
out vec4 frag;
float lin(float d){float z=d*2.-1.;return 2.*uProj.z*uProj.w/(uProj.w+uProj.z-z*(uProj.w-uProj.z));}
void main(){
  vec2 size=vec2(textureSize(uAO,0));
  vec2 uv=gl_FragCoord.xy/size;
  float zc=lin(textureLod(uDepth,uv,0.).r);
  float sum=0., wsum=0.;
  for (int i=-4;i<=4;i++){
    vec2 o=uv+uStep*float(i);
    float z=lin(textureLod(uDepth,o,0.).r);
    float w=exp(-float(i*i)*.11)*max(0.,1.-abs(z-zc)/(zc*.045+.04));
    sum+=textureLod(uAO,o,0.).r*w;
    wsum+=w;
  }
  frag=vec4(sum/max(wsum,1e-4),0.,0.,1.);
}`;

export const DOWN_FRAGMENT=`#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform bool uFirst;
uniform float uThreshold;
out vec4 frag;
vec3 tap(vec2 uv){return textureLod(uSrc,uv,0.).rgb;}
float karis(vec3 c){return 1./(1.+max(max(c.r,c.g),c.b)*.25);}
void main(){
  vec2 uv=(floor(gl_FragCoord.xy)+.5)*2.*uTexel;
  vec3 A=tap(uv+uTexel*vec2(-2,-2)), B=tap(uv+uTexel*vec2(0,-2)), C=tap(uv+uTexel*vec2(2,-2));
  vec3 D=tap(uv+uTexel*vec2(-1,-1)), E=tap(uv+uTexel*vec2(1,-1));
  vec3 F=tap(uv+uTexel*vec2(-2,0)), G=tap(uv), H=tap(uv+uTexel*vec2(2,0));
  vec3 I=tap(uv+uTexel*vec2(-1,1)), J=tap(uv+uTexel*vec2(1,1));
  vec3 K=tap(uv+uTexel*vec2(-2,2)), L=tap(uv+uTexel*vec2(0,2)), M=tap(uv+uTexel*vec2(2,2));
  vec3 c;
  if (uFirst) {
    vec3 g0=(D+E+I+J)*.25, g1=(A+B+F+G)*.25, g2=(B+C+G+H)*.25, g3=(F+G+K+L)*.25, g4=(G+H+L+M)*.25;
    float w0=karis(g0)*.5, w1=karis(g1)*.125, w2=karis(g2)*.125, w3=karis(g3)*.125, w4=karis(g4)*.125;
    c=(g0*w0+g1*w1+g2*w2+g3*w3+g4*w4)/(w0+w1+w2+w3+w4);
    float br=max(max(c.r,c.g),c.b);
    float knee=uThreshold*.6;
    float soft=clamp(br-uThreshold+knee,0.,2.*knee);
    soft=soft*soft/(4.*knee+1e-4);
    c*=max(soft,br-uThreshold)/max(br,1e-4);
  } else {
    c=(D+E+I+J)*.125+(A+C+K+M)*.03125+(B+F+H+L)*.0625+G*.125;
  }
  frag=vec4(c,1.);
}`;

export const UP_FRAGMENT=`#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uWeight;
out vec4 frag;
void main(){
  vec2 uv=gl_FragCoord.xy/vec2(textureSize(uSrc,0)*2);
  vec3 c=textureLod(uSrc,uv,0.).rgb*4.;
  c+=(textureLod(uSrc,uv+vec2(-1,0)*uTexel,0.).rgb+textureLod(uSrc,uv+vec2(1,0)*uTexel,0.).rgb
     +textureLod(uSrc,uv+vec2(0,-1)*uTexel,0.).rgb+textureLod(uSrc,uv+vec2(0,1)*uTexel,0.).rgb)*2.;
  c+=textureLod(uSrc,uv+vec2(-1,-1)*uTexel,0.).rgb+textureLod(uSrc,uv+vec2(1,-1)*uTexel,0.).rgb
     +textureLod(uSrc,uv+vec2(-1,1)*uTexel,0.).rgb+textureLod(uSrc,uv+vec2(1,1)*uTexel,0.).rgb;
  frag=vec4(c*(uWeight/16.),1.);
}`;

export const COMPOSITE_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
in vec2 vUV;
uniform sampler2D uColor;
uniform sampler2D uAO;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uAOStrength;
uniform float uTime;
uniform float uInterior;
uniform bool uAOOn;
uniform bool uBloomOn;
uniform bool uFXAA;
out vec4 frag;
vec3 hdr(vec2 uv){
  vec4 c=textureLod(uColor,uv,0.);
  if (uAOOn) {float ao=textureLod(uAO,uv,0.).r;c.rgb*=mix(1.,ao,sat(c.a)*uAOStrength);}
  return c.rgb;
}
float lumaAt(vec2 uv){vec3 c=textureLod(uColor,uv,0.).rgb*uExposure;return sqrt(lum(c/(1.+c)));}
void main(){
  vec2 uv=vUV;
  if (uFXAA) {
    float nw=lumaAt(uv+vec2(-1,-1)*uTexel), ne=lumaAt(uv+vec2(1,-1)*uTexel);
    float sw=lumaAt(uv+vec2(-1,1)*uTexel), se=lumaAt(uv+vec2(1,1)*uTexel), mid=lumaAt(uv);
    vec2 dir=vec2(-((nw+ne)-(sw+se)),(nw+sw)-(ne+se));
    float reduce=max((nw+ne+sw+se)*.03125,.0078125);
    float rcp=1./(min(abs(dir.x),abs(dir.y))+reduce);
    dir=clamp(dir*rcp,-6.,6.)*uTexel;
    float lo=min(mid,min(min(nw,ne),min(sw,se))), hi=max(mid,max(max(nw,ne),max(sw,se)));
    if (hi-lo>.045) uv+=dir*.18;
  }
  vec2 d=uv-.5;
  float r2=dot(d,d);
  vec2 ca=d*r2*.0065;
  vec3 col=vec3(hdr(uv-ca).r,hdr(uv).g,hdr(uv+ca).b);
  if (uBloomOn) col+=textureLod(uBloom,uv,0.).rgb*uBloomStrength;
  vec3 c=grade(col*uExposure);
  c*=mix(1.,.70,smoothstep(.10,.62,r2*1.5));
  float grain=hash12(gl_FragCoord.xy+fract(uTime*7.31)*vec2(311.,173.))-.5;
  c+=grain*.022*(1.-c*.7);
  frag=vec4(c,1.);
}`;

// ---------- lightweight path ----------
// One cheap pass for the lite and ultra-lite modes: flat sun and ambient
// light, no shadow maps, no reflections, no detail map. Geometry fades into
// the horizon colour before the shortened draw distance cuts it off.
export const LITE_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUV;
flat in vec4 vTint;
flat in vec4 vExtra;
flat in vec3 vSize;
flat in float vSeed;
uniform int uShape;
uniform vec3 uEye;
uniform vec3 uSun;
uniform float uClock;
uniform sampler2DArray uInk;
uniform sampler2D uAtlas;
uniform vec2 uAtlasGrid;
uniform float uUnderX;
uniform float uUnderY;
uniform float uCabinX;
uniform float uRailCabinX;
uniform float uCabinY;
uniform vec2 uInkBounds;
uniform vec3 uFog;
uniform vec2 uFogRange;
out vec4 frag;
${SURFACE_CORE}
// The texture's colour against the surface's own (sRGB, no relief).
vec3 liteSurface(vec3 t,int slot,vec3 base){
  vec3 mean=max(surfaceMean(slot),vec3(.02));
  return mix(base*t/mean,t*(sfLum(base)/max(sfLum(mean),.02)),S_TAKE[slot]);
}
float sat(float x){return clamp(x,0.,1.);}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec3 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  return cell.a>0. && abs(height-bed)<tolerance?cell.rgb:vec3(0.);
}
void main(){
  vec3 ng=normalize(vNormal);
  vec3 V=uEye-vPos;
  float dist=length(V);
  V/=dist;
  int kind=int(vTint.a+.5);
  if (kind==22 && ng.y<.5) discard;
  vec3 tint=vTint.rgb;
  vec2 xz=vPos.xz;
  float zoneInterior=vPos.x>uUnderX*.5?1.:smoothstep(-.4,-3.2,vPos.y);
  float far=smoothstep(uFogRange.x,uFogRange.y,dist);
  float haze=mix(far,max(far,.55*(1.-exp(-dist*.011))),zoneInterior);
  vec3 fogCol=mix(uFog,vec3(.07,.075,.072),zoneInterior);

  if (kind==28) {
    float r=length(vUV-.5)*2.;
    frag=vec4(0.,0.,0.,pow(sat(1.-r),1.7)*vExtra.x);
    return;
  }
  if (kind==24) {
    float r=vUV.y, u=vUV.x, age=vExtra.x, fade=sat(vExtra.w-1.);
    float angle=(u>.5?u-1.:u)*6.2831853, halfAngle=vExtra.y*3.14159265;
    bool sector=halfAngle>.001;
    if (sector && abs(angle)>halfAngle) discard;
    float soft=max(.006,fwidth(r)*.78);
    float rim=1.-smoothstep(.012,.045+soft,abs(r-.961));
    float seam=sector?smoothstep(halfAngle-.056,halfAngle,abs(angle))*.81:0.;
    float phase=sector?sat((angle+halfAngle)/(2.*halfAngle)):r;
    float wave=1.-smoothstep(.015,.075+soft,abs(phase-age));
    vec3 col; float alpha;
    if (vExtra.w<1.) {
      float light=max(max(rim,seam),wave*.85);
      col=mix(tint,vec3(1.),light*.7);
      alpha=min(.96,max(rim*.77,seam*.77)+wave*.30+.13*(.55+.45*age));
    } else {
      float charge=max(wave*.91,rim*.27);
      float trail=step(phase,age+.045)*.34*max(.11,1.-fade);
      col=mix(tint,vec3(1.),charge*.75);
      alpha=min(.86,trail+charge*.68)*(1.-fade);
    }
    frag=vec4(col,alpha);
    return;
  }
  if (kind==25) {
    float rim=pow(1.-max(0.,dot(ng,V)),2.5);
    vec3 col=min(tint*(1.05+.3*max(dot(ng,uSun),0.))+vec3(.5,.42,.5)*rim,vec3(1.));
    frag=vec4(mix(col,fogCol,haze),1.);
    return;
  }
  if (kind==17) {
    if (dot(ng,V)<=0.) discard;
    float edge=1.-smoothstep(.01,.035,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    frag=vec4(mix(tint*.7+.22,fogCol,haze),.22+edge*.3);
    return;
  }
  if (kind==16) {
    if (dot(ng,V)<=0.) discard;
    float border=1.-smoothstep(.012,.065,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float flow=.5+.5*sin(vUV.x*45.+vUV.y*13.-uClock*5.);
    frag=vec4(min(tint*(1.+border*.5),vec3(1.)),(.26+border*.44+flow*.08)*(1.-vExtra.x*.64));
    return;
  }
  if (kind==12) {
    float contour=sin(vUV.y*3.14159)*(.65+.35*sin(vUV.x*21.+uClock*8.));
    frag=vec4(min(tint*1.25,vec3(1.)),max(0.,contour)*(.5*(1.-vExtra.x)));
    return;
  }
  if (kind==7) {
    float index=vExtra.x;
    vec2 tile=vec2(mod(index,uAtlasGrid.x),floor(index/uAtlasGrid.x));
    vec2 uv=(tile+vec2(mix(.01,.99,vUV.x),mix(.02,.98,1.-vUV.y)))/uAtlasGrid;
    if (dot(ng,V)<=0.) discard;
    float a=texture(uAtlas,uv).a;
    if (a<.012) discard;
    frag=vec4(mix(tint*.92,fogCol,haze),a);
    return;
  }
  if (kind==27 && dot(xz,xz)>${CITY_RADIUS**2}.0) discard;

  vec3 an=abs(ng);
  vec3 col=tint*.93;
  float glow=0.;
  // Real surface texture: a single tap and no relief in the lightweight modes.
  bool cabinZone=vPos.x>uCabinX-640., lowerZone=vPos.x>uUnderX*.5 && !cabinZone;
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
  vec2 sdx=dFdx(uvW), sdy=dFdy(uvW);
  int slot=uSurfaceSheets>0?surfaceFor(kind,tint,ng,vSeed,vSize,uShape,lowerZone,cabinZone,vExtra.y,
    vPos.y-(cabinZone?uCabinY:lowerZone?uUnderY:0.)):-1;
  bool real=surfaceReady(slot) && kind!=8;
  vec4 stex=real?surfaceTap(slot,uvW,sdx,sdy):vec4(0.);
  if (kind==3) {col=min(tint*1.18+.05,vec3(1.));glow=1.;}
  else if (kind==5) col=tint*.72;
  else if (kind==11) {
    if (an.y>.55) col=tint*.66;
    else {
      vec2 g=vec2((an.x>an.z?vPos.z:vPos.x)/2.2,vPos.y/3.15);
      vec2 c=fract(g);
      float win=step(.17,c.x)*step(c.x,.83)*step(.24,c.y)*step(c.y,.86);
      float lit=step(.72,hash(floor(g)));
      col=mix(real?liteSurface(stex.rgb,slot,tint*.9):tint*.9,mix(vec3(.13,.19,.23),vec3(.78,.66,.42),lit*.55),win*(1.-smoothstep(36.,70.,dist)*.6));
    }
  }
  else if (kind==8 || kind==6) col=mix(vec3(.10,.16,.20),tint,.35)+.10*sat(ng.y);
  else if (kind==14) col=tint*(.62+.38*hash(floor(vPos.xz*.9)+floor(vPos.y*.9)));
  else if (kind==13) col=tint*(.9-.12*step(.9,fract(vPos.y/.296)));
  else if (kind==9 || kind==26) col=tint*.98;
  if (real && kind!=11) {
    vec3 base=col;
    col=liteSurface(stex.rgb,slot,base);
    float cover=0.;
    int patchSlot=kind==27?outerPatch(xz,cover):-1;
    if (cover>0. && surfaceReady(patchSlot)) col=mix(col,liteSurface(surfaceTap(patchSlot,uvW,sdx,sdy).rgb,patchSlot,base),cover);
  }

  bool lowerInk=vExtra.y>=1.5 && vExtra.y<3.5;
  bool cabinInk=vExtra.y>4.5;
  float cabinOrigin=vExtra.y>5.5?uRailCabinX:uCabinX;
  float inkFloor=cabinInk?uCabinY:lowerInk?uUnderY:0.;
  float inked=0.;
  if ((kind==1 || kind==5 || kind==15 || kind==22) && ng.y>.48 && (kind==15 || vPos.y>inkFloor-.055)) {
    vec2 mapPoint=vec2(xz.x-(cabinInk?cabinOrigin:lowerInk?uUnderX:0.),xz.y);
    vec2 inkUV=(mapPoint/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      ivec2 size=textureSize(uInk,0).xy;
      int layer=int(vExtra.y);
      float clearance=kind==15 || layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
      // Four taps keep the ink edge smooth even at 300 lines.
      vec2 grid=inkUV*vec2(size)-.5;
      ivec2 pixel=ivec2(floor(grid));
      vec2 part=fract(grid);
      part=part*part*(3.-2.*part);
      vec3 a=filmCell(pixel,size,layer,vPos.y,clearance);
      vec3 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
      vec3 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
      vec3 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
      vec3 st=mix(mix(a,b,part.x),mix(c,d,part.x),part.y);
      float mask=smoothstep(.42,.58,st.r+st.g);
      if (mask>.003) {
        vec3 ink=(st.r>=st.g?vec3(.063,.847,.745):vec3(1.,.424,.2))*(1.-st.b*.16);
        col=mix(col,ink,mask);
        inked=mask;
      }
    }
  }

  float ndl=max(dot(ng,uSun),0.);
  vec3 sunLight=vec3(.60,.63,.69)+vec3(.50,.45,.36)*ndl+.06*ng.y;
  vec3 roomLight=vec3(.74,.73,.70)+.16*ng.y;
  vec3 light=mix(sunLight,roomLight,zoneInterior);
  light=mix(light,vec3(1.),max(glow,inked*.4));
  col*=light;
  if (kind==9 || kind==26) col+=tint*.08;
  frag=vec4(mix(col,fogCol,haze),1.);
}`;

export const LITE_SKY_FRAGMENT=`#version 300 es
precision highp float;
in vec2 vUV;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec3 uSun;
uniform vec3 uFog;
uniform vec2 uField;
uniform float uInterior;
out vec4 frag;
void main(){
  vec2 s=vUV*2.-1.;
  vec3 ray=normalize(uForward+uRight*s.x*uField.x+uUp*s.y*uField.y);
  float h=clamp(ray.y,0.,1.), sun=max(dot(ray,uSun),0.);
  vec3 col=mix(uFog,vec3(.30,.50,.80),1.-pow(1.-h,3.2));
  col+=vec3(1.,.92,.74)*pow(sun,420.)*1.2+vec3(.25,.20,.12)*pow(sun,10.);
  if (ray.y<0.) col=mix(uFog,uFog*.72,clamp(-ray.y*5.,0.,1.));
  frag=vec4(mix(col,vec3(.055,.062,.058),uInterior),1.);
}`;
