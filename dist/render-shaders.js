// GLSL sources for the WebGL 2 renderer. Lighting is linear HDR with a
// physically based sun, sky image lighting, cascaded soft shadows and a
// filmic grade. Materials are procedural and sample a tileable detail map so
// surface texture stays filtered at every distance.
import {FILM_HEIGHT_ORIGIN,FILM_HEIGHT_STEP,FILM_HEIGHT_TOLERANCE} from './ink-fluid.js';
import {CABIN_Y,CITY_RADIUS,UNDER_X,UNDER_Y} from './layout.js';
import {SURFACES,smallSurface} from './surfaces.js';

const f=n=>Number(n).toFixed(4);
const floats=(name,values)=>`const float ${name}[${values.length}]=float[${values.length}](${values.map(f).join(',')});`;

// Real surface textures (see surfaces.js). Shared by the full and the
// lightweight scene shaders: slot names, repeat sizes, and the rules that
// pick a texture for a surface from its material, colour, shape and place.
const SURFACE_CORE=`
${SURFACES.map((surface,i)=>`const int S_${surface.id.toUpperCase()}=${i};`).join('\n')}
${floats('S_METERS',SURFACES.map(surface=>surface.meters))}
${floats('S_MIRROR',SURFACES.map(surface=>surface.pattern && !surface.repeat?1:0))}
${floats('S_TAKE',SURFACES.map(surface=>surface.take))}
${floats('S_SMALL',SURFACES.map(surface=>smallSurface(surface)?1:0))}
// Large surfaces and small parts live in two arrays of different sizes.
uniform highp sampler2DArray uSurface;
uniform highp sampler2DArray uSurfaceSmall;
uniform int uSurfaceSheets;
uniform vec2 uSurfaceEdge;
// Per slot: average colour (rgb) and texture-array layer (a, -1 = not loaded).
// A uniform block, so the table can grow without eating into the plain
// uniform space that small mobile GPUs keep tight (224 vectors at minimum).
layout(std140) uniform SurfaceTable{vec4 uSurfaceMean[${SURFACES.length}];};
bool surfaceReady(int slot){return slot>=0 && uSurfaceMean[slot].a>-.5;}
// p: world-plane position in metres; dx, dy: its screen derivatives, taken
// outside any branch so a texture can be chosen per pixel.
vec4 surfaceTap(int slot,vec2 p,vec2 dx,vec2 dy){
  float s=1./S_METERS[slot];
  vec2 uv=p*s;
  bool small=S_SMALL[slot]>.5;
  float edge=small?uSurfaceEdge.y:uSurfaceEdge.x;
  if (S_MIRROR[slot]>.5) uv=clamp(1.-abs(1.-mod(uv,2.)),edge,1.-edge);
  vec3 at=vec3(uv,uSurfaceMean[slot].a);
  if (small) return textureGrad(uSurfaceSmall,at,dx*s,dy*s);
  return textureGrad(uSurface,at,dx*s,dy*s);
}
// For places without usable derivatives (rooms traced behind windows).
vec4 surfaceLod(int slot,vec2 p,float lod){
  vec2 uv=p/S_METERS[slot];
  bool small=S_SMALL[slot]>.5;
  float edge=small?uSurfaceEdge.y:uSurfaceEdge.x;
  if (S_MIRROR[slot]>.5) uv=clamp(1.-abs(1.-mod(uv,2.)),edge,1.-edge);
  vec3 at=vec3(uv,uSurfaceMean[slot].a);
  if (small) return textureLod(uSurfaceSmall,at,lod);
  return textureLod(uSurface,at,lod);
}
vec3 surfaceMean(int slot){return uSurfaceMean[slot].rgb;}
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
// Apartment blocks (kind 10): the front wears its style (residential.js
// APARTMENT_STYLES), the back the access corridors, the ends a gable wall.
int apartmentSlot(int style,int face){
  if (face==1) return S_APT_CORRIDOR;
  if (face==2) return S_APT_ENDWALL;
  return style==0?S_APT_BALCONY:style==1?S_APT_LOGGIA:style==2?S_APT_RIBBON:style==3?S_APT_FINS:
    style==4?S_APT_SCREEN:style==5?S_APT_BRICK:S_APT_GLASS;
}
#ifndef FAST_SLOT
// Flat roofs: membrane, gravel, timber decks and a few solar arrays.
int roofFor(float seed){return seed<.45?S_ROOF_MEMBRANE:seed<.7?S_ROOF_GRAVEL:seed<.87?S_ROOFTOP_DECK:S_SOLAR_PANEL;}
int surfaceFor(int kind,vec3 tint,vec3 ng,float seed,vec3 size,int shape,bool under,bool cabin,float layer,float above){
  float l=sfLum(tint), chroma=sfChroma(tint);
  bool warm=tint.r>tint.b+.06, red=tint.r>tint.g+.15, green=tint.g>tint.r+.015 && tint.g>=tint.b-.02, blue=tint.b>tint.r+.06;
  bool level=ng.y>.6, ceiling=ng.y<-.6, sloped=ng.y>.6 && ng.y<.995;
  float longest=max(max(size.x,size.y),size.z), thinnest=min(min(size.x,size.y),size.z);
  float middle=size.x+size.y+size.z-longest-thinnest;
  // Facades choose by their paint, not per box, so every block of one
  // building (and all of its faces) wears the same cladding.
  float house=fract(dot(tint,vec3(31.7,19.3,23.9)));
  // Undersides of decks, the overpass and apartment ceilings.
  if (ceiling && !under && !cabin && above>2. && (kind==1 || kind==2 || kind==15)) return l>.72?S_GYPSUM_PAINTED:S_CONCRETE_SOFFIT;
  // Track: rail heads and sleepers on both lines.
  if (kind==1 && !warm && thinnest<.07 && middle<.2 && longest>15.) return S_RAIL_STEEL;
  if (kind==1 && !warm && longest<3. && middle<.32 && thinnest<.12 && (layer>3.5 && layer<4.5 || under)) return S_CONCRETE_SLEEPER;
  // The sides of slabs, kerbs, risers and poles made of a floor material.
  if ((kind==1 || kind==5 || kind==15 || kind==27) && !level) {
    if (cabin) return S_HARD_PLASTIC;
    if (under) return S_CONCRETE_FORMWORK;
    return size.y<.4 && above<.5?S_GRANITE_CURB:S_CONCRETE_WEATHERED;
  }
  if (kind==5) {
    if (under) return S_WET_ASPHALT;
    if (red && chroma>.1) return S_RED_ASPHALT;
    if (green && chroma>.06) return S_GREEN_LANE;
    if (longest<40.) return S_PARKING_ASPHALT;
    return seed<.35?S_ASPHALT_PATCHED:S_ASPHALT;
  }
  if (kind==1) {
    if (cabin) return S_VINYL_FLOOR;
    if (layer>3.5 && layer<4.5) return S_BALLAST;
    // Tops of barriers and low blocks are concrete, not floor finishes.
    if (size.y>.3 && longest<6.) return S_CONCRETE_WEATHERED;
    // The three walk-in apartments: wood, carpet and tatami rooms.
    if (!under && size.y<.05 && longest>8. && middle>4.) return warm && chroma>.15?S_WOOD_FLOORING:green || blue?S_CARPET_TILE:S_TATAMI;
    if (under) {
      if (longest>60. && middle<4.5) return S_BALLAST;
      if (shape==2) return S_RUBBER_STUD_FLOOR;
      if (l>.55) return longest<12. && size.y<.2 && middle>1.5?S_CHECKER_TILE:seed<.34?S_PORCELAIN_TILES:seed<.67?S_TERRAZZO:S_MARBLE;
      return seed<.4?S_EPOXY_FLOOR:seed<.7?S_POLISHED_CONCRETE:S_GARAGE_CONCRETE;
    }
    if (warm && chroma>.07) return seed<.75?S_BRICK_PAVERS:S_GRANITE_SETTS;
    if (tint.g>tint.r+.008) return seed<.35?S_MOSSY_PAVERS:S_SIDEWALK_PAVERS;
    return seed<.18?S_EXPOSED_AGGREGATE:seed<.3?S_GRANITE_SETTS:S_CONCRETE_SLAB;
  }
  if (kind==27) return S_CONCRETE_SLAB;
  if (kind==15) return under?S_EPOXY_FLOOR:S_CONCRETE_WEATHERED;
  if (kind==2 || kind==19) {
    if (ceiling && (under || cabin)) return S_CEILING_PANEL;
    if (cabin) return S_HARD_PLASTIC;
    if (kind==19) return seed<.7?S_PLASTER:S_SHIKKUI;
    if (under) {
      if (level) return S_CONCRETE_WEATHERED;
      if (warm && size.y<3. && longest<9.) return S_PEGBOARD;
      if (l>.6) return seed<.55?S_SUBWAY_TILES:seed<.8?S_GLASS_MOSAIC:S_MOSAIC_TILE_WALL;
      return S_CONCRETE_FORMWORK;
    }
    if (level) return above>3.?roofFor(seed):above>.75 && above<1.25 && longest<3.?S_LAMINATE_COUNTER:S_CONCRETE_WEATHERED;
    // Apartment interiors: papered walls the height of one storey.
    if (l>.7 && size.y>2.9 && size.y<3.3 && longest>20.) return S_VINYL_WALLPAPER;
    // Shop awnings: thin pitched strips above the doors.
    if (size.y<.1 && longest>.6 && longest<1.2 && above>2.2) return S_AWNING_CANVAS;
    // Red: containers stay weathering steel; only tall facades get louvres.
    if (red && chroma>.12) return longest>4.?(size.y>3.2 && house>.5?S_TERRACOTTA_LOUVER:S_CORTEN_STEEL):
      seed<.6?S_TERRACOTTA:S_GLAZED_BRICK_TILE;
    if (blue && chroma>.12 && size.y>2.4) return seed<.5?S_SPANDREL_GLASS:S_TITANIUM_PANEL;
    if (green && chroma>.12 && size.y>2.4 && seed<.4) return S_COPPER_PATINA;
    if (chroma>.12 && longest>2.) return seed<.35?S_CORRUGATED_METAL:seed<.6?S_TIN_SIDING:seed<.85?S_ALUMINUM_COMPOSITE:S_PEELING_PAINT_WALL;
    if (l<.2 && size.y>1.) return seed<.4?S_YAKISUGI:seed<.7?S_SLATE_CLADDING:S_SHITAMI_BOARD;
    // Garden fences of houses: thin, warm and long.
    if (warm && size.y>.8 && size.y<2.4 && thinnest<.3 && longest>2. && seed<.45) return seed<.25?S_BAMBOO_FENCE:S_KOSHI_LATTICE;
    if (above<1.4 && size.y<1.3 && longest>1.5 && l<.55 && chroma<.08) return S_POLISHED_GRANITE;
    if (size.y>1.8 && size.y<3.2 && l<.45 && chroma<.06 && longest>1.5) return seed<.5?S_ROLLING_SHUTTER:S_CONCRETE_BLOCK;
    if (warm && longest<.9 && l>.25 && l<.7) return S_CARDBOARD;
    if (size.y<2.4) {
      // Plinths and blocks stay masonry; free-standing walls get the
      // garden-wall finishes (pierced blocks, ivy, namako, gabions).
      if (thinnest>.45 || longest<1.5) return seed<.3?S_CONCRETE_BLOCK:seed<.48?S_EFFLORESCENCE_WALL:
        seed<.72?S_CONCRETE_WEATHERED:seed<.86?S_SPLIT_FACE_BLOCK:S_STONE_RETAINING;
      return seed<.12?S_CONCRETE_BLOCK:seed<.22?S_EFFLORESCENCE_WALL:seed<.32?S_CONCRETE_WEATHERED:
        seed<.42?S_SPLIT_FACE_BLOCK:seed<.52?S_BREEZE_BLOCK:seed<.62?S_WALL_MOSS_DAMP:seed<.71?S_IVY_WALL:
        seed<.79?S_STONE_RETAINING:seed<.86?S_NAMAKO_WALL:seed<.93?S_GABION_WALL:S_GRAFFITI_BUFF;
    }
    // Earth and stone tones: clay walls, sandstone and long facade tiles.
    float h=house;
    if (warm && chroma>.05 && l>.35 && h<.36) return h<.12?S_MORTAR_WASHI:h<.24?S_SANDSTONE_PANEL:S_NICHOKAKE_TILE;
    if (l>.78 && h>.8) return h<.9?S_SHIKKUI:S_PEELING_PAINT_WALL;
    return h<.1?S_CONCRETE_FORMWORK:h<.2?S_CONCRETE_WEATHERED:h<.27?S_RAIN_STREAKS_WALL:h<.34?S_PLASTER:
      h<.4?S_STUCCO_CRACKED:h<.46?S_LATH_MORTAR:h<.52?S_ALC_PANEL:h<.59?S_PRECAST_PANEL:h<.65?S_SPRAY_TILE:
      h<.71?S_CERAMIC_SIDING:h<.77?S_GRAFFITI_BUFF:h<.84?S_CAST_STONE:h<.9?S_TRAVERTINE:h<.95?S_BRONZE_PANEL:S_MIRROR_STAINLESS;
  }
  if (kind==11) {
    float h=house;
    if (level) return roofFor(h);
    if (warm) return h<.2?S_BRICK_TAN:h<.35?S_TILE_CLADDING:h<.48?S_NICHOKAKE_TILE:h<.58?S_MOSAIC_TILE_WALL:
      h<.7?S_SPRAY_TILE:h<.8?S_CERAMIC_SIDING:h<.9?S_SANDSTONE_PANEL:S_TRAVERTINE;
    return h<.14?S_TILE_CLADDING:h<.25?S_PLASTER:h<.35?S_ALC_PANEL:h<.45?S_CONCRETE_WEATHERED:
      h<.53?S_RAIN_STREAKS_WALL:h<.66?S_PRECAST_PANEL:h<.76?S_ALUMINUM_COMPOSITE:h<.84?S_CAST_STONE:
      h<.9?S_TITANIUM_PANEL:h<.95?S_STUCCO_CRACKED:S_BRONZE_PANEL;
  }
  if (kind==13) {
    if (shape==0) return S_BARK;
    if (level && size.y<.1 && l<.5) return seed<.4?S_SOIL:seed<.75?S_MULCH:S_FALLEN_LEAVES;
    if (chroma<.06 && size.y>3.5 && size.y<6.) return S_TUNNEL_LINING;
    if (l>.7) return S_BRICK_PAINTED;
    if (seed>.88 && size.y>1.5) return S_IVY_WALL;
    return red?S_BRICK_RED:seed<.8?S_BRICK_TAN:S_GLAZED_BRICK_TILE;
  }
  if (kind==29) return level && longest>2.?S_ROOFTOP_DECK:
    seed<.2?S_WOOD_PLANKS:seed<.4?S_PLYWOOD:seed<.6?S_WOOD_WEATHERED:seed<.8?S_PAINTED_WOOD:S_SHITAMI_BOARD;
  // Hedge tops; their tall sides read as dense planted walls.
  if (kind==14) return shape==0?S_LEAVES:!level && size.y>1.2?S_GREEN_WALL:S_HEDGE;
  if (kind==4) {
    if (cabin || under) return chroma<.05?S_STAINLESS:S_STEEL_PAINTED_GREY;
    if (sloped && above>3.) return blue?S_SOLAR_PANEL:red?(seed<.5?S_KAWARA_TILE:S_STANDING_SEAM_ROOF):
      seed<.55?S_STANDING_SEAM_ROOF:seed<.85?S_ZINC_SHINGLE:S_COPPER_PATINA;
    if (longest<.26 && l<.3) return S_KNURLED_GRIP;
    if (longest<.8 && chroma>.12) return S_ANODIZED_ALUMINUM;
    if (level && above<.35) return shape==0?S_CAST_IRON:S_DRAIN_GRATE;
    if (level && above>.7 && above<1.25 && longest<3.) return S_LAMINATE_COUNTER;
    if (level) return S_DIAMOND_PLATE;
    if (longest<.9 && l<.36 && chroma<.08) return S_CERAKOTE;
    if (red && chroma>.15 && l<.5) return S_CORTEN_STEEL;
    if (longest>4.5) return S_STEEL_GIRDER;
    if (thinnest<.05 && longest>.5) return seed<.35?S_PERFORATED_METAL:seed<.7?S_EXPANDED_METAL:S_WOVEN_MESH;
    if (above>3. && thinnest>.4 && longest<2.2) return S_METAL_LOUVER;
    if (warm && l<.4 && chroma<.15 && longest>1.) return S_BRONZE_PANEL;
    if (chroma<.035 && l>.12) return seed<.5?S_GALVANIZED:S_BRUSHED_ALUMINUM;
    return green?S_STEEL_PAINTED_GREEN:S_STEEL_PAINTED_GREY;
  }
  if (kind==22) return tint.r>.8 && tint.b<.7?S_TACTILE_PAVING:S_ROAD_PAINT;
  if (kind==0) return l>.8 && thinnest<.06 && longest<.8?S_REFLECTIVE_TAPE:
    l<.15 && thinnest<.3 && middle>.8 && longest>1.2?S_LED_BILLBOARD_OFF:S_PAINTED_METAL;
  if (kind==8) return l>.62?(level || ceiling?S_FROSTED_GLASS:seed<.5?S_GLASS_BLOCK:S_CHANNEL_GLASS):S_GLASS_GRIME;
  // Shop fascia light boxes (the lamps themselves stay untextured).
  if (kind==3) return middle>.3 && longest>1.4?S_LIGHTBOX_PANEL:-1;
  if (kind==23) return shape==0 && thinnest<.9?S_SUCKER_SKIN:S_CEPHALOPOD_SKIN;
  if (kind==18) return cabin?S_SEAT_FABRIC:l<.25?S_NEOPRENE:S_SPORT_MESH;
  if (kind==30) return S_RIPSTOP;
  if (kind==31) return longest>.3?S_BALLISTIC_NYLON:S_CANVAS;
  if (kind==21) return ceiling?S_BOOT_TREAD:thinnest<.07?S_RUBBER_SOLE:l<.3 && longest<.6?S_LEATHER:S_RUBBER_SOLE;
  if (kind==20) return l<.3?S_CARBON_FIBER:S_HARD_PLASTIC;
  if (kind==26) return S_DRIED_INK;
  return -1;
}
#endif
// Lawns, flower beds and sand lots scattered over the outer district.
int outerPatch(vec2 p,out float weight){
  float n=sfNoise(p*.031+vec2(3.1,7.7));
  weight=0.;
  if (n<.27) {weight=1.;return S_GRASS;}
  if (n<.31) {weight=smoothstep(.31,.29,n);return S_FALLEN_LEAVES;}
  if (n<.38) {weight=smoothstep(.38,.34,n);return S_SOIL;}
  if (n>.80) {weight=1.;return S_SAND;}
  if (n>.72) {weight=smoothstep(.72,.76,n);return S_MULCH;}
  if (n>.48 && n<.56) {weight=smoothstep(.48,.51,n)*smoothstep(.56,.53,n);return S_CONCRETE_CRACKED;}
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
float pow5(float x){float x2=x*x;return x2*x2*x;}
float hash12(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
vec2 hash22(vec2 p){vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));q+=dot(q,q.yzx+33.33);return fract((q.xx+q.yz)*q.zy);}
float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 toLinear(vec3 c){return c*(c*(c*.305306011+.682171111)+.012522878);}
vec3 toSRGB(vec3 c){c=max(c,vec3(0.));vec3 s1=sqrt(c),s2=sqrt(s1),s3=sqrt(s2);return max(vec3(0.),.662002687*s1+.684122060*s2-.323583601*s3-.022541147*c);}
vec3 aces(vec3 x){
  const mat3 I=mat3(.59719,.07600,.02840,.35458,.90834,.13383,.04823,.01566,.83777);
  const mat3 O=mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602);
  x=I*x;
  vec3 a=x*(x+.0245786)-.000090537, b=x*(.983729*x+.4329510)+.238081;
  return sat3(O*(a/b));
}
vec3 grade(vec3 c){
  c=max(c*vec3(1.64,1.60,1.54),vec3(0.));
  // AgX-inspired highlight crosstalk: rolls intense sun glints, neon and fire toward
  // natural filmic white without yellow/magenta hue skew while preserving deep contrast.
  float peak=max(max(c.r,c.g),c.b);
  c=mix(c,vec3(lum(c)),smoothstep(1.15,6.5,peak)*.30);
  c=aces(c);
  float l=lum(c);
  c=max(mix(vec3(l),c,1.08),vec3(0.));
  c*=mix(vec3(.968,.994,1.038),vec3(1.032,1.002,.956),smoothstep(.08,.78,l));
  return toSRGB(sat3(c));
}
vec2 envUV(vec3 d){return vec2(atan(d.x,-d.z)*.15915494+.5,acos(clamp(d.y,-1.,1.))*.31830989);}
// Exact-cardinal octahedral normal packing into RGBA8: maps [-1,1] -> [0,254/255] so all 6
// axis-aligned normals (+/-X,+/-Y,+/-Z) reconstruct with 0.0000 degree quantization error.
vec2 octEnc(vec3 n){
  vec2 p=n.xz/(abs(n.x)+abs(n.y)+abs(n.z)+1e-6);
  if (n.y<0.) p=(1.-abs(p.yx))*vec2(p.x>=0.?1.:-1.,p.y>=0.?1.:-1.);
  return p*(127./255.)+(127./255.);
}
vec3 octDec(vec2 e){
  vec2 f=clamp((e*255.-127.)*(1./127.),vec2(-1.),vec2(1.));
  vec3 n=vec3(f.x,1.-abs(f.x)-abs(f.y),f.y);
  if (n.y<0.) n.xz=(1.-abs(n.zx))*vec2(n.x>=0.?1.:-1.,n.z>=0.?1.:-1.);
  return normalize(n);
}
vec3 envDecode(vec4 c){return c.rgb/max(vec3(1.)-c.rgb,vec3(.004));}
vec3 envEncode(vec3 c){c=max(c,vec3(0.));return c/(1.+c);}
`;

// Sky radiance, clouds and a distant skyline. Shared by the background, the
// reflection probe and the fog colour so geometry fades into the same sky.
export const SKY=`
uniform sampler2D uDetail;
uniform vec3 uSun;
uniform float uClock;
uniform float uBossRage;
uniform float uRainLevel;
vec3 skyAtmos(vec3 d){
  float y=d.y, h=max(y,0.), mu=dot(d,uSun);
  float horizon=pow(1.-h,5.5);
  vec3 zenith=mix(mix(vec3(.050,.135,.390),vec3(.055,.068,.088),uRainLevel),vec3(.018,.003,.005),uBossRage);
  vec3 hz=mix(mix(vec3(.44,.55,.68),vec3(.13,.155,.185),uRainLevel),vec3(.30,.020,.026),uBossRage);
  vec3 col=mix(zenith,hz,horizon);
  col*=.84+.30*sat(mu*.5+.5)*(1.-uRainLevel*.75);
  float a=max(mu,0.);
  vec3 sunTint=mix(vec3(1.,.82,.60),vec3(.92,.10,.08),uBossRage)*(1.-uRainLevel*.86);
  col+=sunTint*(pow(a,5.)*.16+pow(a,36.)*.42+pow(a,380.)*1.9)*mix(.55,1.,horizon);
  if (y<0.) col=mix(hz*mix(vec3(.86,.87,.86),vec3(.35,.08,.09),uBossRage),mix(vec3(.105,.11,.105),vec3(.018,.005,.008),uBossRage),sat(-y*4.5));
  return col*mix(mix(1.55,.88,uRainLevel),1.25,uBossRage);
}
// Streamlined 2-tap warped cloud field + 1-tap light path (3 taps vs 8, crisp at any resolution).
float cloudField(vec2 p){
  vec2 q=p+vec2(uClock*.0016,uClock*.0005);
  vec4 t0=texture(uDetail,q*.19);
  vec4 t1=texture(uDetail,q*.83+vec2(t0.b*.09,-t0.b*.07));
  return t0.r*.70+t1.r*.30+t1.a*.09;
}
vec4 skyClouds(vec3 d,vec3 atmos){
  if (d.y<.004) return vec4(0.);
  vec2 p=d.xz/(d.y+.04);
  float n=cloudField(p), cover=mix(mix(.585,.22,uRainLevel),.43,uBossRage);
  float dens=sat((n-cover)*mix(3.6,5.2,uRainLevel));
  if (dens<=.002) return vec4(0.);
  vec2 q2=p+uSun.xz/max(uSun.y,.25)*.09+vec2(uClock*.0016,uClock*.0005);
  float n2=texture(uDetail,q2*.19).r*.76+texture(uDetail,q2*.83).r*.28;
  float lightPath=sat((n2-cover)*2.2);
  float shade=sat(.78-lightPath*.95+(n-n2)*1.6);
  float core=sat((n-cover)*1.5);
  vec3 lit=mix(mix(vec3(1.07,1.03,.98)*1.72,vec3(.24,.28,.33),uRainLevel),vec3(.52,.045,.055),uBossRage);
  vec3 dark=mix(mix(vec3(.40,.46,.56)*1.25,vec3(.085,.098,.115),uRainLevel),vec3(.015,.005,.008),uBossRage);
  vec3 col=mix(dark,lit,shade)*(1.-core*mix(.28,.55,max(uBossRage,uRainLevel*.85)));
  float mu=max(dot(d,uSun),0.);
  col+=mix(vec3(1.,.86,.66),vec3(.75,.07,.06),uBossRage)*pow(mu,14.)*(1.-dens)*2.6*(1.-uRainLevel*.88);
  col=mix(atmos,col,mix(.30,1.,smoothstep(.015,.32,d.y)));
  return vec4(col,dens*smoothstep(.004,.14,d.y));
}
float skylineHeight(float az){
  float cell=floor(az);
  float h=.003+pow(hash12(vec2(cell,1.7)),2.2)*.026+step(.9,hash12(vec2(cell,9.1)))*.030;
  return h*(.55+.45*hash12(vec2(floor(az*.17),4.)));
}
vec3 skyFull(vec3 d,bool clouds,bool disk){
  vec3 atmos=skyAtmos(d);
  vec3 col=atmos;
  if (clouds && d.y>0.) {vec4 c=skyClouds(d,atmos);col=mix(col,c.rgb,c.a);}
  if (d.y<.06 && d.y>-.04) {
    float az=atan(d.x,-d.z)*36.;
    float top=skylineHeight(az);
    if (d.y<top) {
      float id=hash12(vec2(floor(az),2.3));
      float side=step(.5,fract(az))*.5+.5;
      vec3 tower=mix(mix(vec3(.25,.31,.37),vec3(.06,.02,.03),uBossRage),mix(vec3(.37,.42,.47),vec3(.11,.025,.032),uBossRage),id)*mix(.82,1.08,side*sat(uSun.y+.3));
      float rows=step(.55,fract(d.y*640.))*step(.45,fract(az*7.))*.035;
      vec3 building=(tower+rows*mix(vec3(1.),vec3(.8,.12,.1),uBossRage))*1.15;
      col=mix(building,col,.42+.38*sat(1.-(top-d.y)*40.));
    }
  }
  if (disk) {
    float s=dot(d,uSun);
    vec3 dTint=mix(vec3(1.,.93,.80),vec3(.88,.08,.07),uBossRage);
    col+=dTint*smoothstep(.99988,.99995,s)*mix(70.,22.,uBossRage);
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
  for (int i=0;i<6;i++){s+=a*gnoise(uv*p,p);t+=a;a*=.52;p*=2.;}
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
  float f0=fbm(uv,4.);
  float r=sat(f0*1.35+.5);
  vec2 c=cells(uv,22.);
  vec2 v=cells(uv+f0*.032,9.);
  float ridge=sat(1.-(v.y-v.x)*3.2);
  float grain=sat(.5+gnoise(uv*64.,64.)*.55+gnoise(uv*128.,128.)*.35);
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
    vec3 gCol=mix(mix(vec3(.30,.31,.30),vec3(.17,.17,.16),g),mix(vec3(.10,.02,.03),vec3(.03,.01,.015),g),uBossRage);
    vec3 ground=gCol*(.55+.45*sat(uSun.y*1.5));
    col=mix(col,ground,smoothstep(0.,.08,-d.y));
  }
  float s=max(dot(d,uSun),0.);
  col+=mix(vec3(1.,.9,.75),vec3(.85,.10,.08),uBossRage)*pow(s,900.)*14.;
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

// Single-tap sky for planar reflections, reusing the pre-baked sky probe.
export const MIRROR_SKY_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
in vec2 vUV;
uniform sampler2D uEnv;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uForward;
uniform vec2 uField;
out vec4 frag;
void main(){
  vec2 s=vUV*2.-1.;
  vec3 ray=normalize(uForward+uRight*s.x*uField.x+uUp*s.y*uField.y);
  frag=vec4(envDecode(textureLod(uEnv,envUV(ray),0.)),0.);
}`;

// Bit-identical position shader for the Hi-Z depth pre-pass.
export const DEPTH_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
layout(location=9) in vec4 aExtra;
uniform mat4 uVP;
uniform float uDrawOffset;
uniform bool uMergeStairs;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const SCENE_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
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
#ifdef USE_SHADOW0
uniform mat4 uShadowM0;
uniform vec4 uShadowTexel;
uniform vec3 uSun;
out vec3 vShadow0;
#endif
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
flat out vec3 vSlots;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  // A stable per-object number, so neighbouring buildings pick different textures.
  vec3 q=fract(a3.xyz*vec3(.1031,.1030,.0973));
  q+=dot(q,q.yzx+33.33);
  vSeed=fract((q.x+q.y)*q.z);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vPos=p.xyz;
  // Analytical orthogonal inverse-transpose without 3x3 matrix inversion or sqrt.
  vec3 wn=normalize(a0.xyz*(aNormal.x/max(dot(a0.xyz,a0.xyz),1e-12))
                   +a1.xyz*(aNormal.y/max(dot(a1.xyz,a1.xyz),1e-12))
                   +a2.xyz*(aNormal.z/max(dot(a2.xyz,a2.xyz),1e-12)));
  vNormal=wn;
#ifdef USE_SHADOW0
  float slope0=1.-clamp(dot(wn,uSun),0.,1.);
  vShadow0=(uShadowM0*vec4(p.xyz+wn*uShadowTexel.z*(1.2+slope0*1.6),1.)).xyz*.5+.5;
#endif
  vUV=aUV;
  vLocal=aPos;
  vTint=aTint;
  vExtra=aExtra;
  vSize=vec3(length(a0.xyz),length(a1.xyz),length(a2.xyz));
  vAxisX=a0.xyz/max(vSize.x,1e-6);
  vAxisY=a1.xyz/max(vSize.y,1e-6);
  vSlots=vec3(a0.w,a1.w,a2.w);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

// Minimal vertex shader for pure architectural & dynamic opaque solids.
// Packs (slotTop, slotSide, slotBot, inkLayer) into a single flat vec4 varying,
// and optionally pre-projects orthographic Cascade-0 shadow coords per vertex.
export const ARCH_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
layout(location=8) in vec4 aTint;
layout(location=9) in vec4 aExtra;
uniform mat4 uVP;
uniform float uDrawOffset;
uniform bool uMergeStairs;
#ifdef USE_SHADOW0
uniform mat4 uShadowM0;
uniform vec4 uShadowTexel;
uniform vec3 uSun;
out vec3 vShadow0;
#endif
out vec3 vPos;
out vec3 vNormal;
flat out vec4 vTint;
flat out vec4 vSlots;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vPos=p.xyz;
  vec3 wn=normalize(a0.xyz*(aNormal.x/max(dot(a0.xyz,a0.xyz),1e-12))
                   +a1.xyz*(aNormal.y/max(dot(a1.xyz,a1.xyz),1e-12))
                   +a2.xyz*(aNormal.z/max(dot(a2.xyz,a2.xyz),1e-12)));
  vNormal=wn;
#ifdef USE_SHADOW0
  float slope0=1.-clamp(dot(wn,uSun),0.,1.);
  vShadow0=(uShadowM0*vec4(p.xyz+wn*uShadowTexel.z*(1.2+slope0*1.6),1.)).xyz*.5+.5;
#endif
  vTint=aTint;
  vSlots=vec4(a0.w,a1.w,a2.w,aExtra.y);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

// Specialized lean zero-discard outdoor PBR shader for opaque architectural AND
// dynamic PBR surfaces (kinds 0, 1, 2, 3, 4, 9, 13, 15, 18, 19, 20, 21, 29, 30, 31).
// Uses vertex-precomputed Cascade-0 shadows, 2-tap checkerboard hardware PCF,
// analytical SH diffuse irradiance & analytical fog (zero uEnv taps on matte surfaces).
export const ARCH_OUTDOOR_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
in vec3 vPos;
in vec3 vNormal;
#ifdef USE_SHADOW0
in vec3 vShadow0;
#endif
flat in vec4 vTint;
flat in vec4 vSlots;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform int uQuality;
uniform bool uHDR;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM0;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2DArray uInk;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform sampler2D uEnv;
uniform sampler2D uDetail;
uniform float uEnvLod;
uniform vec2 uViewport;
uniform float uExposure;
uniform float uDrawFar;
uniform float uRaytrace;
uniform float uWetLevel;
uniform float uBossRage;
uniform float uRainLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;
${SURFACE_HIGH}
vec3 envAt(vec3 d,float lod){return envDecode(textureLod(uEnv,envUV(d),lod));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 envBRDF(vec3 f0,float rough,float nv){
  const vec4 c0=vec4(-1.,-.0275,-.572,.022);
  const vec4 c1=vec4(1.,.0425,1.04,-.04);
  vec4 r=rough*c0+c1;
  float a004=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;
  vec2 ab=vec2(-1.04,1.04)*a004+r.zw;
  return f0*ab.x+ab.y;
}
// 2-tap checkerboard-alternated hardware-bilinear PCF (8 filtered texels, zero cos/sin).
float shadowTap(sampler2DShadow s,vec3 c,float texel){
  int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
  vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(texel*1.22);
  return (texture(s,vec3(c.xy+d,c.z))+texture(s,vec3(c.xy-d,c.z)))*.5;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
#ifdef USE_SHADOW0
  vec3 c0=vShadow0;
#else
  float slope=1.-sat(dot(ng,uSun));
  vec3 c0=(uShadowM0*vec4(p+ng*uShadowTexel.z*(1.2+slope*1.6),1.)).xyz*.5+.5;
#endif
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y);
  float s0=1.;
  if (inner>0. && c0.z<1.) s0=shadowTap(uShadow0,vec3(c0.xy,c0.z-.00022),uShadowTexel.x);
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  float slope1=1.-sat(dot(ng,uSun));
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope1*1.6),1.)).xyz*.5+.5;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}
void main(){
  vec3 ng=normalize(vNormal), V=uEye-vPos;
  float dist=length(V); V/=dist;
  int kind=int(vTint.a+.5);
  vec3 tint=toLinear(vTint.rgb), an=abs(ng);
  vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
  vec3 sdpx=dFdx(vPos), sdpy=dFdy(vPos);
  float px=max(length(sdpx),length(sdpy));
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy), sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  int slot=uSurfaceSheets>0?int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5)):-1;
  bool real=surfaceReady(slot);
  if (kind==3) {
    vec3 col=tint*3.2;
    if (real) {
      vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
      col*=mix(vec3(1.),toLinear(stex.rgb)/max(toLinear(surfaceMean(slot)),vec3(.05)),.75);
    }
    vec3 dir=-V;
    float fall=mix(.022,.004,uRainLevel), h0=uEye.y, dy=vPos.y-uEye.y;
    float integral=abs(dy)>.01?(exp(-fall*h0)-exp(-fall*vPos.y))/(fall*dy):exp(-fall*h0);
    float density=mix(.0021,.072,uRainLevel);
    float fogAmt=1.-exp(-density*dist*max(integral,0.));
    if (uDrawFar>0.) fogAmt=max(fogAmt,smoothstep(uDrawFar*.6,uDrawFar*.97,dist));
    if (fogAmt>.002) {
      vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
      vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
      col=mix(col,fogCol,fogAmt);
    }
    if (uHDR) frag=vec4(col,0.);
    else {vec3 c=grade(col*uExposure);vec2 q=gl_FragCoord.xy/uViewport-.5;frag=vec4(c*(1.-dot(q,q)*.42),1.);}
    return;
  }
  bool vertical=an.y<.45;
  float wallBase=vertical && vPos.y<1.65 && (kind==2 || kind==4 || kind==13 || kind==19)?1.-smoothstep(0.,.95+texture(uDetail,uvW*.043).r*.6,vPos.y):0.;
  vec3 albedo=tint, emit=vec3(0.);
  float rough=.86, metal=0., f0Base=.04, clear=0., sheen=0., trans=0., surfH=0., relief=0.;
  if (kind==4) {
    vec4 d2=texture(uDetail,uvW*3.1);
    float sat0=max(max(tint.r,tint.g),tint.b)-min(min(tint.r,tint.g),tint.b);
    float galvanized=step(sat0,.035)*step(.12,lum(tint));
    metal=galvanized;
    vec3 baseCol=mix(tint,vec3(.56,.57,.58)*(.85+d2.g*.3),galvanized*.8);
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,baseCol,1.,.004,surfH);
      relief=1.;
    } else {
      albedo=baseCol*(.94+(d2.r-.5)*.12);
    }
    rough=mix(.38+d2.r*.14,.34+d2.g*.2,galvanized);
    albedo=mix(albedo,albedo*.6,wallBase*.4*float(vertical));
  } else if (kind==1 || kind==15) {
    float oil=kind==1?smoothstep(.62,.8,texture(uDetail,uvW*.09+.7).r)*.18:0.;
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH)*(1.-oil);
      relief=1.;
    } else {
      albedo=tint*(.92+(texture(uDetail,uvW*.31).r-.5)*.14)*(1.-oil);
    }
    rough=.82-oil*.25;
  } else if (kind==20) {
    clear=.75; f0Base=.04;
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,.6,.002,surfH);
      rough=.33; relief=.4;
    } else {
      float peel=texture(uDetail,uvW*9.).r;
      albedo=tint*(.97+peel*.04);
      rough=.30+peel*.06;
    }
  } else if (kind==21) {
    sheen=.18; f0Base=.035;
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.003,surfH);
      rough=.72; relief=.5;
    } else {
      vec4 d2=texture(uDetail,uvW*4.);
      albedo=tint*(.9+d2.r*.14)+vec3(.012)*sat(ng.y);
      rough=.68+d2.a*.1;
    }
  } else if (kind==18 || kind==30 || kind==31) {
    rough=.88; sheen=.55; f0Base=.03;
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.003,surfH);
      relief=.5;
    } else {
      albedo=tint*(.9+texture(uDetail,uvW*2.).r*.12);
    }
  } else if (kind==9) {
    albedo=tint*.92; rough=.07; clear=1.; f0Base=.04; trans=.35; emit=tint*.22;
  } else if (kind==0) {
    vec4 d2=texture(uDetail,uvW*2.3);
    float worn=an.y>.6?smoothstep(.55,.75,texture(uDetail,uvW*.6).r*.6+d2.r*.5):0.;
    albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
    rough=.62+worn*.2;
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,.7,.003,surfH);
      relief=.5;
    }
  } else if (real) {
    vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
    float depth=kind==13 || kind==29?.012:.010;
    albedo=realSurface(stex,slot,tint,1.,depth,surfH);
    relief=1.;
    if (kind==2 || kind==19) {
      albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55*float(vertical));
      rough=.88;
    } else if (kind==13) {
      bool nat=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
      if (!nat) albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
      rough=nat?.9:.78;
    } else rough=.78;
  } else if (kind==13) {
    vec2 bricks=uvW/vec2(.69,.296);
    bricks.x+=mod(floor(bricks.y),2.)*.5;
    vec2 b=fract(bricks), id=floor(bricks);
    vec2 jd=min(b,1.-b)*vec2(.69,.296);
    float mortar=1.-smoothstep(.006,.016+px*.5,min(jd.x,jd.y));
    float stone=hash12(id);
    albedo=mix(tint*(.84+stone*.24),vec3(.52,.50,.46),mortar*.85);
    albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
    rough=mix(.78,.92,mortar);
  } else {
    float g=texture(uDetail,uvW*.29).r;
    albedo=tint*(.92+(g-.5)*.16);
    if (vertical) albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55);
  }
  vec3 n=ng;
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0. && px<.03) {
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float area=dot(sdpx,r1);
    n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
  }
  if ((kind==1 || kind==15) && ng.y>.48 && (kind==15 || vPos.y>-.055)) {
    vec2 inkUV=(vPos.xz/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      vec4 inkProbe=texture(uInk,vec3(inkUV,vSlots.w));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid);
        part=part*part*(3.-2.*part);
        int layer=int(vSlots.w);
        float clearance=kind==15 || layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        vec4 a=filmCell(pixel,size,layer,vPos.y,clearance);
        vec4 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
        vec4 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
        vec4 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
        vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=texture(uDetail,vPos.xz*.83);
          float thr=.5+(iDet.r*.6+iDet.a*.4-.5)*.38;
          float aa=fwidth(coverage)*.9+.015;
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            vec3 teamInk=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            vec3 coord=vec3(inkUV,vSlots.w);
            float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 liquid=-vec2(e0-thick,s0-thick)*1.62;
            albedo=mix(albedo,ink,mask);
            rough=mix(rough,mix(.21,.065,bossMask)+length(liquid)*.18,mask);
            metal=mix(metal,0.,mask);
            emit=mix(ink*.05,vec3(.042,.006,.014),bossMask)*mask;
            f0Base=mix(f0Base,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
          }
        }
      }
    }
  }
  float wetEnv=max(uWetLevel,uBossRage*.58);
  if (wetEnv>.002 && ng.y>.42 && kind!=0 && kind!=3 && kind!=9) {
    float pNoise=texture(uDetail,uvW*.17+vec2(.13,.41)).r;
    float puddle=smoothstep(.44,.76,pNoise+.26*wetEnv)*wetEnv;
    albedo=mix(albedo,albedo*.62,puddle*.68);
    rough=mix(rough,mix(.14,.045,clamp(uRaytrace+puddle*.4,0.,1.)),puddle*(kind==1?.86:.56));
    f0Base=mix(f0Base,.055,puddle*.65);
  }
  float nv=max(dot(n,V),1e-4), nl=dot(n,uSun);
  vec3 R=reflect(-V,n), direct=vec3(0.);
  vec3 f0=mix(vec3(f0Base),albedo,metal);
  vec3 diffC=albedo*(1.-metal);
  if (nl>.001 || trans>0.) {
    float sh=sunShadow(vPos,ng);
    if (sh>.001) {
      vec3 sun=uSunColor*sh;
      float wrap=trans>0.?sat((nl+.4)/1.4):nl;
      direct=diffC*(1./PI)*sun*wrap;
      if (nl>.001) {
        vec3 h=normalize(uSun+V);
        float nh=max(dot(n,h),0.), vh=max(dot(V,h),0.), a=max(rough*rough,.0016);
        vec3 F=f0+(1.-f0)*pow5(1.-vh);
        direct+=sun*(ggxD(nh,a)*visSmith(nv,nl,a)*F*nl);
        if (clear>0.) {
          float ac=.0025;
          vec3 Fc=vec3(.04)+vec3(.96)*pow5(1.-vh);
          direct+=sun*(ggxD(nh,ac)*visSmith(nv,nl,ac)*Fc*nl)*clear;
        }
      }
      if (trans>0.) direct+=diffC*trans*sun*pow(sat(dot(-V,uSun)),3.)*.9*sat(1.-nl);
    }
  }
  vec3 irr=shDiffuse(n)+vec3(.36,.34,.30)*(sat(-n.y)*.2);
  if (uBossRage>.005) irr=mix(irr,irr*vec3(1.15,.36,.34)+vec3(.028,.004,.005),uBossRage*.55);
  // Matte dielectrics reuse SH irradiance (zero uEnv texture fetches on ~85% of pixels!).
  vec3 spec=(rough>.72 && metal<.01)?irr:envAt(R,clamp(sqrt(rough)*uEnvLod,0.,uEnvLod));
  if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
  vec3 ambient=diffC*irr+spec*envBRDF(f0,rough,nv);
  if (clear>0.) ambient+=envAt(R,clamp(sqrt(.05)*uEnvLod,0.,uEnvLod))*(.04+.96*pow5(1.-nv))*clear;
  if (sheen>0.) {float s1=1.-nv, s2=s1*s1; ambient+=albedo*sheen*(s2*s2)*irr*.9;}
  vec3 col=direct+ambient+emit;
  vec3 dir=-V;
  float fall=mix(.022,.004,uRainLevel), h0=uEye.y, dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(exp(-fall*h0)-exp(-fall*vPos.y))/(fall*dy):exp(-fall*h0);
  float density=mix(.0021,.072,uRainLevel);
  float fogAmt=1.-exp(-density*dist*max(integral,0.));
  if (uDrawFar>0.) fogAmt=max(fogAmt,smoothstep(uDrawFar*.6,uDrawFar*.97,dist));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
    col=mix(col,fogCol,fogAmt);
  }
  if (uHDR) frag=vec4(col,sat(lum(ambient)/(lum(col)+1e-4))*(1.-fogAmt));
  else {
    vec3 c=grade(col*uExposure);
    vec2 q=gl_FragCoord.xy/uViewport-.5;
    frag=vec4(c*(1.-dot(q,q)*.42),1.);
  }
}`;

const LAMP_ROWS=[-39,-28,-10.5,0,10.5,28,39];
const CABIN_LAMPS=[-7.9,-5.2,-1.4,1.4,5.2,7.9];

// Specialized 4-varying interior PBR shader for underground & cabin opaque
// architectural surfaces (kinds 0, 1, 2, 3, 4, 13, 15, 19, 29 — ~99% of interior).
export const ARCH_INTERIOR_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
${COMMON}
in vec3 vPos;
in vec3 vNormal;
flat in vec4 vTint;
flat in vec4 vSlots;
uniform vec3 uEye;
uniform bool uHDR;
uniform sampler2D uDetail;
uniform sampler2DArray uInk;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform float uUnderX;
uniform float uUnderY;
uniform float uCabinX;
uniform float uRailCabinX;
uniform float uCabinY;
uniform vec2 uViewport;
uniform float uExposure;
out vec4 frag;
${SURFACE_HIGH}
const float LAMP_ROWS[${LAMP_ROWS.length}]=float[${LAMP_ROWS.length}](${LAMP_ROWS.map(f).join(',')});
const float CABIN_LAMPS[${CABIN_LAMPS.length}]=float[${CABIN_LAMPS.length}](${CABIN_LAMPS.map(f).join(',')});
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 envBRDF(vec3 f0,float rough,float nv){
  const vec4 c0=vec4(-1.,-.0275,-.572,.022);
  const vec4 c1=vec4(1.,.0425,1.04,-.04);
  vec4 r=rough*c0+c1;
  float a004=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;
  vec2 ab=vec2(-1.04,1.04)*a004+r.zw;
  return f0*ab.x+ab.y;
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}
void main(){
  vec3 ng=normalize(vNormal), V=uEye-vPos;
  float dist=length(V); V/=dist;
  int kind=int(vTint.a+.5);
  vec3 tint=toLinear(vTint.rgb), an=abs(ng);
  vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
  vec3 sdpx=dFdx(vPos), sdpy=dFdy(vPos);
  float px=max(length(sdpx),length(sdpy));
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy), sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  bool inCabin=vPos.x>uCabinX-640.;
  bool inUnder=!inCabin && vPos.x>uUnderX*.5;
  float floorY=inCabin?uCabinY:inUnder?uUnderY:0.;
  float localY=vPos.y-floorY;
  int slot=uSurfaceSheets>0?int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5)):-1;
  bool real=surfaceReady(slot);
  if (kind==3) {
    vec3 col=tint*11.;
    if (real) {
      vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
      col*=mix(vec3(1.),toLinear(stex.rgb)/max(toLinear(surfaceMean(slot)),vec3(.05)),.75);
    }
    float iFog=(1.-exp(-dist*.011))*.55;
    col=mix(col,vec3(.07,.075,.072),iFog);
    if (uHDR) frag=vec4(col,0.);
    else {vec3 c=grade(col*uExposure);vec2 q=gl_FragCoord.xy/uViewport-.5;frag=vec4(c*(1.-dot(q,q)*.42),1.);}
    return;
  }
  bool vertical=an.y<.45;
  float wallBase=vertical && localY<1.65?1.-smoothstep(0.,.95+texture(uDetail,uvW*.043).r*.6,localY):0.;
  vec3 albedo=tint, emit=vec3(0.);
  float rough=.86, metal=0., f0Base=.04, surfH=0., relief=0.;
  if (kind==4) {
    vec4 d2=texture(uDetail,uvW*3.1);
    float sat0=max(max(tint.r,tint.g),tint.b)-min(min(tint.r,tint.g),tint.b);
    float galvanized=step(sat0,.035)*step(.12,lum(tint));
    metal=galvanized;
    vec3 baseCol=mix(tint,vec3(.56,.57,.58)*(.85+d2.g*.3),galvanized*.8);
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,baseCol,1.,.004,surfH);
      relief=1.;
    } else {
      albedo=baseCol*(.94+(d2.r-.5)*.12);
    }
    rough=mix(.38+d2.r*.14,.34+d2.g*.2,galvanized);
    albedo=mix(albedo,albedo*.6,wallBase*.4*float(vertical));
  } else if (kind==1 || kind==15) {
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH);
      relief=1.;
    } else {
      albedo=tint*(.93+(texture(uDetail,uvW*.31).r-.5)*.12);
    }
    rough=inCabin?.48:(inUnder && kind==1 && lum(tint)>.30?.22:.82);
  } else if (kind==0) {
    vec4 d2=texture(uDetail,uvW*2.3);
    float worn=an.y>.6?smoothstep(.55,.75,texture(uDetail,uvW*.6).r*.6+d2.r*.5):0.;
    albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
    rough=.62+worn*.2;
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,.7,.003,surfH);
      relief=.5;
    }
  } else if (real) {
    vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
    float depth=kind==13 || kind==29?.012:.010;
    albedo=realSurface(stex,slot,tint,1.,depth,surfH);
    relief=1.;
    if (kind==2 || kind==19) {
      albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55*float(vertical));
      rough=.88;
    } else if (kind==13) {
      bool nat=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
      if (!nat) albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
      rough=nat?.9:.78;
    } else rough=.78;
  } else if (kind==13) {
    vec2 bricks=uvW/vec2(.69,.296);
    bricks.x+=mod(floor(bricks.y),2.)*.5;
    vec2 b=fract(bricks), id=floor(bricks);
    vec2 jd=min(b,1.-b)*vec2(.69,.296);
    float mortar=1.-smoothstep(.006,.016+px*.5,min(jd.x,jd.y));
    float stone=hash12(id);
    albedo=mix(tint*(.84+stone*.24),vec3(.52,.50,.46),mortar*.85);
    albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
    rough=mix(.78,.92,mortar);
  } else {
    float g=texture(uDetail,uvW*.29).r;
    albedo=tint*(.92+(g-.5)*.16);
    if (vertical) albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55);
  }
  vec3 n=ng;
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0. && px<.03) {
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float area=dot(sdpx,r1);
    n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
  }
  if ((kind==1 || kind==15) && ng.y>.48 && (kind==15 || vPos.y>floorY-.055)) {
    float lyr=vSlots.w;
    bool cabinInk=lyr>4.5, lowerInk=lyr>=1.5 && lyr<3.5;
    float originX=cabinInk?(lyr>5.5?uRailCabinX:uCabinX):lowerInk?uUnderX:0.;
    vec2 inkUV=(vec2(vPos.x-originX,vPos.z)/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      vec4 inkProbe=texture(uInk,vec3(inkUV,lyr));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid);
        part=part*part*(3.-2.*part);
        int layer=int(lyr);
        float clearance=kind==15 || layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        vec4 a=filmCell(pixel,size,layer,vPos.y,clearance);
        vec4 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
        vec4 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
        vec4 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
        vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=texture(uDetail,vPos.xz*.83);
          float thr=.5+(iDet.r*.6+iDet.a*.4-.5)*.38;
          float aa=fwidth(coverage)*.9+.015;
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            vec3 teamInk=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            vec3 coord=vec3(inkUV,lyr);
            float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 liquid=-vec2(e0-thick,s0-thick)*1.62;
            albedo=mix(albedo,ink,mask);
            rough=mix(rough,mix(.21,.065,bossMask)+length(liquid)*.18,mask);
            metal=mix(metal,0.,mask);
            emit=mix(ink*.05,vec3(.042,.006,.014),bossMask)*mask;
            f0Base=mix(f0Base,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
          }
        }
      }
    }
  }
  float nv=max(dot(n,V),1e-4);
  vec3 R=reflect(-V,n);
  vec3 f0=mix(vec3(f0Base),albedo,metal);
  vec3 diffC=albedo*(1.-metal);
  vec3 dl=vec3(0.), sl=vec3(0.);
  vec3 amb=mix(vec3(.112,.112,.106),vec3(.094,.094,.089),n.y*.5+.5);
  float a=max(rough*rough,.002);
#ifdef SAFE
  amb*=2.2;
#else
  int cBest=0, cSecond=0, uRow=0;
  float cOrigin=0., uColBase=0.;
  if (inCabin) {
    cOrigin=vPos.x>uRailCabinX-640.?uRailCabinX:uCabinX;
    float lx=vPos.x-cOrigin, bd=1e9;
    for (int j=0;j<${CABIN_LAMPS.length};j++){float dd=abs(CABIN_LAMPS[j]-lx);if(dd<bd){bd=dd;cBest=j;}}
    cSecond=clamp(cBest+((lx>CABIN_LAMPS[cBest])?1:-1),0,${CABIN_LAMPS.length-1});
  } else if (inUnder) {
    float lx=vPos.x-uUnderX;
    float gx=clamp(floor((lx+57.2)/8.8),0.,12.);
    uColBase=-57.2+gx*8.8;
    for (int j=0;j<${LAMP_ROWS.length-1};j++) if (vPos.z>LAMP_ROWS[j]) uRow=j;
  }
  bool matte=rough>=.72;
  for (int k=0;k<4;k++) {
    vec3 c; float halfLen; float I;
    if (inCabin) {
      int col=k<2?cBest:cSecond;
      c=vec3(cOrigin+CABIN_LAMPS[col],uCabinY+2.66,(k%2==0)?-.68:.68);
      halfLen=.86; I=2.6;
    } else if (inUnder) {
      float colX=uColBase+float(k/2)*8.8;
      float rz=LAMP_ROWS[min(uRow+(k%2),${LAMP_ROWS.length-1})];
      c=vec3(uUnderX+colX,uUnderY+6.38,rz);
      halfLen=1.1; I=15.;
    } else {
      c=vec3(vPos.x,-6.6,vPos.z+(float(k%2)-.5)*4.);
      halfLen=.6; I=4.;
    }
    vec3 pd=vec3(clamp(vPos.x,c.x-halfLen,c.x+halfLen),c.y,c.z);
    vec3 L=pd-vPos;
    float d2=dot(L,L);
    float window=sat(1.-d2/(I*I*6.));
    if (window<=.001) continue;
    float invD=inversesqrt(d2);
    vec3 l=L*invD;
    float ndl=max(dot(n,l),0.);
    float atten=I/(d2+.35)*window*window;
    dl+=diffC*(1./PI)*ndl*atten;
    if (matte) {
      if (ndl>.001 && atten>.04) {
        vec3 h=normalize(l+V);
        float vh=max(dot(V,h),0.), a2=sat(a+.06*invD);
        vec3 F=f0+(1.-f0)*pow5(1.-vh);
        sl+=ggxD(max(dot(n,h),0.),a2)*(a*a)/(a2*a2)*visSmith(nv,ndl,a2)*F*ndl*atten;
      }
    } else if (ndl>.001 || rough<.55) {
      vec3 L0=c-vec3(halfLen,0.,0.)-vPos, Ld=vec3(2.*halfLen,0.,0.);
      float rl=dot(R,Ld);
      float t=sat((dot(R,L0)*rl-dot(L0,Ld))/max(dot(Ld,Ld)-rl*rl,1e-4));
      vec3 Ls=L0+t*Ld;
      float ds2=dot(Ls,Ls), invDs=inversesqrt(ds2);
      vec3 ls=Ls*invDs;
      float nl=max(dot(n,ls),0.);
      if (nl>.001) {
        float a2=sat(a+.06*invDs);
        vec3 h=normalize(ls+V);
        vec3 F=f0+(1.-f0)*pow5(1.-max(dot(V,h),0.));
        sl+=ggxD(max(dot(n,h),0.),a2)*(a*a)/(a2*a2)*visSmith(nv,nl,a2)*F*(nl*I/(ds2+.35)*window);
      }
    }
  }
#endif
  vec3 direct=(dl+sl)*vec3(1.,.95,.86);
  vec3 roomEnv=mix(vec3(.05,.052,.05),vec3(.16,.16,.15),sat(R.y*.5+.5));
  if (R.y>.02 && rough<.72) {
    float ceilY=inCabin?uCabinY+2.7:uUnderY+6.9;
    float tt=(ceilY-vPos.y)/R.y;
    vec3 hp=vPos+R*tt;
    float spread=.03+rough*rough*tt*.6;
    float strip;
    if (inCabin) {
      strip=smoothstep(.12+spread,.08,min(abs(hp.z-.68),abs(hp.z+.68)));
    } else {
      float lx=hp.x-uUnderX+57.2;
      float cx=abs(fract(lx/8.8+.5)-.5)*8.8;
      float zb=min(min(min(abs(hp.z+39.),abs(hp.z+28.)),min(abs(hp.z+10.5),abs(hp.z))),
                   min(min(abs(hp.z-10.5),abs(hp.z-28.)),abs(hp.z-39.)));
      strip=smoothstep(1.1+spread,1.05,cx)*smoothstep(.2+spread,.12,zb);
    }
    roomEnv+=vec3(1.,.95,.86)*strip*mix(3.,.6,sat(rough*2.))*exp(-tt*.04);
  }
  vec3 ambient=diffC*amb*(inCabin?1.25:1.)+roomEnv*envBRDF(f0,rough,nv);
  vec3 col=direct+ambient+emit;
  float iFog=(1.-exp(-dist*.011))*.55;
  col=mix(col,vec3(.07,.075,.072),iFog);
  if (uHDR) frag=vec4(col,sat(lum(ambient)/(lum(col)+1e-4))*(1.-iFog));
  else {
    vec3 c=grade(col*uExposure);
    vec2 q=gl_FragCoord.xy/uViewport-.5;
    frag=vec4(c*(1.-dot(q,q)*.42),1.);
  }
}`;

export const SHADOW_VERTEX=`#version 300 es
layout(location=0) in vec3 aPos;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
uniform mat4 uLight;
void main(){gl_Position=uLight*vec4(mat3(a0.xyz,a1.xyz,a2.xyz)*aPos+a3.xyz,1.);}`;

export const SHADOW_BAKED_VERTEX=`#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uLight;
void main(){gl_Position=uLight*vec4(aPos,1.);}`;

export const SHADOW_FRAGMENT=`#version 300 es
precision mediump float;
void main(){}`;

// Ultra-lightweight HDR shader dedicated to street-level planar reflections:
// skips shadows, detail/bump maps, room raytracing and interior lamp loops.
export const MIRROR_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DArray;
${COMMON}
in vec3 vPos;
in vec3 vNormal;
in vec2 vUV;
flat in vec4 vTint;
flat in vec4 vExtra;
flat in vec3 vSlots;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
${SURFACE_CORE}
out vec4 frag;
void main(){
#ifndef MIRROR_OPAQUE
  if (vPos.y<.037) discard;
#endif
  int kind=int(vTint.a+.5);
  vec3 ng=normalize(vNormal);
  vec3 tint=toLinear(vTint.rgb);
  vec3 albedo=tint, emit=vec3(0.);
  vec3 an=abs(ng);
  if (kind==3) {
    emit=tint*3.2; albedo=tint*.4;
  } else if (kind==25) {
    frag=vec4(tint*1.8,0.); return;
  } else if (kind==8 || kind==6) {
    vec3 V=normalize(uEye-vPos);
    vec3 R=reflect(-V,ng);
    float fres=.04+.96*pow5(1.-max(dot(ng,V),0.));
    vec3 refl=envDecode(textureLod(uEnv,envUV(R),1.));
    albedo=tint*.18;
    emit=refl*fres+tint*.10;
  } else if (uSurfaceSheets>0) {
    int slot=int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5));
    if (surfaceReady(slot)) {
      vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
      vec4 t=surfaceLod(slot,uvW,2.);
      vec3 mean=max(toLinear(surfaceMean(slot)),vec3(.012)), c=toLinear(t.rgb);
      vec3 tinted=tint*c/mean, natural=c*(lum(tint)/max(lum(mean),.012));
      albedo=mix(tinted,natural,S_TAKE[slot]);
    }
  }
  if (kind==11 && an.y<=.55) albedo=mix(albedo,vec3(.08,.11,.13),.38);
  else if (kind==5) albedo*=.70;
  float nl=max(dot(ng,uSun),0.);
  float shT=clamp(.5-ng.y*.7071068,0.,1.);
  vec3 irr=max(mix(uSH0,uSH1,shT)+uSH2*ng.x+uSH3*ng.z+uSH4*(shT*(1.-shT)),vec3(0.));
  vec3 col=albedo*(uSunColor*(nl/PI)+irr)+emit;
  vec3 V=uEye-vPos;
  float dist=length(V);
  vec3 dir=-V/max(dist,1e-4);
  float fall=.022, h0=uEye.y, dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(exp(-fall*h0)-exp(-fall*vPos.y))/(fall*dy):exp(-fall*h0);
  float fogAmt=1.-exp(-.0021*dist*max(integral,0.));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=max(uFog0+uFog1*fdir.y+uFog2*fdir.x+uFog3*fdir.z,vec3(0.));
    col=mix(col,fogCol,fogAmt);
  }
  frag=vec4(col,0.);
}`;

// ---------- 3-MRT Deferred Outdoor & 2-MRT Deferred Mirror Pipeline ----------
// Eliminates 10x-15x forward fragment overdraw by writing compact G-Buffers
// (G0: RGB8 tint + kind, G1: RGB8 exact-cardinal oct normal + surface slot + meta,
// and for complex facades/windows only G2: RGBA32F face coords & size) and executing
// exact PBR + 2-cascade shadow + ink + room-raytrace + sky lighting at 1.00x overdraw.
export const GBUF_ARCH_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
layout(location=8) in vec4 aTint;
layout(location=9) in vec4 aExtra;
uniform mat4 uVP;
uniform float uDrawOffset;
uniform bool uMergeStairs;
out vec3 vNormal;
#ifdef MIRROR_CLIP
out float vPosY;
#endif
flat out vec4 vTint;
flat out vec4 vSlots;
void main(){
#ifdef MIRROR_CLIP
  if (a3.y+(abs(a0.y)+abs(a1.y)+abs(a2.y))*.62<.037) {gl_Position=vec4(2.,2.,2.,1.);return;}
#endif
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
#ifdef MIRROR_CLIP
  vPosY=p.y;
#endif
  vNormal=normalize(a0.xyz*(aNormal.x/max(dot(a0.xyz,a0.xyz),1e-12))
                   +a1.xyz*(aNormal.y/max(dot(a1.xyz,a1.xyz),1e-12))
                   +a2.xyz*(aNormal.z/max(dot(a2.xyz,a2.xyz),1e-12)));
  vTint=aTint;
  vSlots=vec4(a0.w,a1.w,a2.w,aExtra.y);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const GBUF_ARCH_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
in vec3 vNormal;
#ifdef MIRROR_CLIP
in float vPosY;
#endif
flat in vec4 vTint;
flat in vec4 vSlots;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
void main(){
#ifdef MIRROR_CLIP
  if (vPosY<.037) discard;
#endif
  vec3 ng=normalize(vNormal);
  float slot=floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5);
  float meta=clamp(floor(vSlots.w+.5),0.,15.);
  g0=vec4(vTint.rgb,floor(vTint.a+.5)/255.);
  g1=vec4(octEnc(ng),(clamp(slot,-1.,253.)+1.)/255.,meta/255.);
}`;

export const GBUF_FULL_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
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
out vec3 vNormal;
out vec2 vUV;
out vec3 vLocal;
flat out vec4 vTint;
flat out vec4 vExtra;
flat out vec3 vSize;
flat out vec3 vAxisX;
flat out vec3 vAxisY;
flat out float vSeed;
flat out vec3 vSlots;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec3 q=fract(a3.xyz*vec3(.1031,.1030,.0973));
  q+=dot(q,q.yzx+33.33);
  vSeed=fract((q.x+q.y)*q.z);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vNormal=normalize(a0.xyz*(aNormal.x/max(dot(a0.xyz,a0.xyz),1e-12))
                   +a1.xyz*(aNormal.y/max(dot(a1.xyz,a1.xyz),1e-12))
                   +a2.xyz*(aNormal.z/max(dot(a2.xyz,a2.xyz),1e-12)));
  vUV=aUV;
  vLocal=aPos;
  vTint=aTint;
  vExtra=aExtra;
  vSize=vec3(length(a0.xyz),length(a1.xyz),length(a2.xyz));
  vAxisX=a0.xyz/max(vSize.x,1e-6);
  vAxisY=a1.xyz/max(vSize.y,1e-6);
  vSlots=vec3(a0.w,a1.w,a2.w);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const GBUF_FULL_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
const int S_ROOF_MEMBRANE=${SURFACES.findIndex(s=>s.id==='roof_membrane')};
const int S_APT_CORRIDOR=${SURFACES.findIndex(s=>s.id==='apt_corridor')};
const int S_APT_ENDWALL=${SURFACES.findIndex(s=>s.id==='apt_endwall')};
const int S_APT_BALCONY=${SURFACES.findIndex(s=>s.id==='apt_balcony')};
const int S_APT_LOGGIA=${SURFACES.findIndex(s=>s.id==='apt_loggia')};
const int S_APT_RIBBON=${SURFACES.findIndex(s=>s.id==='apt_ribbon')};
const int S_APT_FINS=${SURFACES.findIndex(s=>s.id==='apt_fins')};
const int S_APT_SCREEN=${SURFACES.findIndex(s=>s.id==='apt_screen')};
const int S_APT_BRICK=${SURFACES.findIndex(s=>s.id==='apt_brick')};
const int S_APT_GLASS=${SURFACES.findIndex(s=>s.id==='apt_glass')};
int apartmentSlot(int style,int face){
  if (face==1) return S_APT_CORRIDOR;
  if (face==2) return S_APT_ENDWALL;
  return style==0?S_APT_BALCONY:style==1?S_APT_LOGGIA:style==2?S_APT_RIBBON:style==3?S_APT_FINS:
    style==4?S_APT_SCREEN:style==5?S_APT_BRICK:S_APT_GLASS;
}
in vec3 vNormal;
in vec2 vUV;
in vec3 vLocal;
flat in vec4 vTint;
flat in vec4 vExtra;
flat in vec3 vSize;
flat in vec3 vAxisX;
flat in vec3 vAxisY;
flat in float vSeed;
flat in vec3 vSlots;
uniform int uShape;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
layout(location=2) out vec4 g2;
void main(){
  vec3 ng=normalize(vNormal);
  int kind=int(vTint.a+.5);
  float slot=floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5);
  float meta=0.;
  vec4 extra=vec4(0.);
  if (kind==6 || kind==8 || kind==10 || kind==11 || kind==15 || kind==29) {
    vec3 axZ=cross(vAxisX,vAxisY);
    vec3 lp=vLocal*vSize;
    vec3 nObj=vec3(dot(ng,vAxisX),dot(ng,vAxisY),dot(ng,axZ));
    vec3 fMask=step(vec3(.5),abs(nObj));
    vec2 faceUV=lp.xz, faceSize=vSize.xz;
    if (fMask.x>.5) {faceUV=vec2(-sign(nObj.x)*lp.z,lp.y); faceSize=vSize.zy;}
    else if (fMask.z>.5) {faceUV=vec2(sign(nObj.z)*lp.x,lp.y); faceSize=vSize.xy;}
    if (kind==10) {
      if (abs(ng.y)>.55) slot=float(S_ROOF_MEMBRANE);
      else {
        int face=fMask.z>.5?(nObj.z>0.?0:1):2;
        slot=float(apartmentSlot(int(vExtra.x+.5),face));
      }
      meta=16.+floor(clamp(vSeed,0.,.999)*15.+.5);
      extra=vec4(faceUV+faceSize*.5,faceSize);
    } else if (kind==15) {
      meta=16.+clamp(floor(vExtra.y+.5),0.,15.);
      extra=vec4(faceUV,faceSize);
    } else {
      meta=16.+clamp(float(uShape),0.,15.);
      extra=vec4(faceUV+faceSize*.5,faceSize);
    }
  } else if (kind==23 || kind==25) {
    meta=16.+clamp(float(uShape),0.,15.);
    extra=vec4(vUV,0.,0.);
  } else if (kind==5) {
    meta=16.+clamp(floor(vExtra.y+.5),0.,15.);
  } else {
    meta=16.+clamp(float(uShape),0.,15.);
  }
  g0=vec4(vTint.rgb,float(kind)/255.);
  g1=vec4(octEnc(ng),(clamp(slot,-1.,253.)+1.)/255.,meta/255.);
  g2=extra;
}`;

// Zero-fragment-math flat-faceted G-buffer shader (box, ramp, tri, bevel:lo):
// precomputes octahedral normal, surface slot, kind & ink layer once per vertex
// so fragment shading is literally two register moves (g0=vG0; g1=vG1;).
export const GBUF_FLAT_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=4) in vec4 a0;
layout(location=5) in vec4 a1;
layout(location=6) in vec4 a2;
layout(location=7) in vec4 a3;
layout(location=8) in vec4 aTint;
layout(location=9) in vec4 aExtra;
uniform mat4 uVP;
uniform float uDrawOffset;
uniform bool uMergeStairs;
#ifdef MIRROR_CLIP
out float vPosY;
#endif
flat out vec4 vG0;
flat out vec4 vG1;
vec2 octEnc(vec3 n){
  vec2 p=n.xz/(abs(n.x)+abs(n.y)+abs(n.z)+1e-6);
  if (n.y<0.) p=(1.-abs(p.yx))*vec2(p.x>=0.?1.:-1.,p.y>=0.?1.:-1.);
  return p*(127./255.)+(127./255.);
}
void main(){
#ifdef MIRROR_CLIP
  if (a3.y+(abs(a0.y)+abs(a1.y)+abs(a2.y))*.62<.037) {gl_Position=vec4(2.,2.,2.,1.);return;}
#endif
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
#ifdef MIRROR_CLIP
  vPosY=p.y;
#endif
  vec3 invS2=1./max(vec3(dot(a0.xyz,a0.xyz),dot(a1.xyz,a1.xyz),dot(a2.xyz,a2.xyz)),vec3(1e-12));
  vec3 wn=normalize(a0.xyz*(aNormal.x*invS2.x)+a1.xyz*(aNormal.y*invS2.y)+a2.xyz*(aNormal.z*invS2.z));
  float slot=floor((wn.y>.6?a0.w:wn.y<-.6?a2.w:a1.w)+.5);
  float meta=clamp(floor(aExtra.y+.5),0.,15.);
  vG0=vec4(aTint.rgb,floor(aTint.a+.5)/255.);
  vG1=vec4(octEnc(wn),(clamp(slot,-1.,253.)+1.)/255.,meta/255.);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const GBUF_FLAT_FRAGMENT=`#version 300 es
precision highp float;
#ifdef MIRROR_CLIP
in float vPosY;
#endif
flat in vec4 vG0;
flat in vec4 vG1;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
void main(){
#ifdef MIRROR_CLIP
  if (vPosY<.037) discard;
#endif
  g0=vG0;
  g1=vG1;
}`;

// Flat-faceted 3-MRT Full G-buffer shader (box/ramp/bevel:lo facades, windows, roads, stairs, wood):
// moves all basis/normal/faceSize/apartmentSlot/octEnc work to the vertex shader,
// leaving only 1 smooth vec2 (vFaceUV) and 3 register writes per fragment.
export const GBUF_FULL_FLAT_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
const int S_ROOF_MEMBRANE=${SURFACES.findIndex(s=>s.id==='roof_membrane')};
const int S_APT_CORRIDOR=${SURFACES.findIndex(s=>s.id==='apt_corridor')};
const int S_APT_ENDWALL=${SURFACES.findIndex(s=>s.id==='apt_endwall')};
const int S_APT_BALCONY=${SURFACES.findIndex(s=>s.id==='apt_balcony')};
const int S_APT_LOGGIA=${SURFACES.findIndex(s=>s.id==='apt_loggia')};
const int S_APT_RIBBON=${SURFACES.findIndex(s=>s.id==='apt_ribbon')};
const int S_APT_FINS=${SURFACES.findIndex(s=>s.id==='apt_fins')};
const int S_APT_SCREEN=${SURFACES.findIndex(s=>s.id==='apt_screen')};
const int S_APT_BRICK=${SURFACES.findIndex(s=>s.id==='apt_brick')};
const int S_APT_GLASS=${SURFACES.findIndex(s=>s.id==='apt_glass')};
int apartmentSlot(int style,int face){
  if (face==1) return S_APT_CORRIDOR;
  if (face==2) return S_APT_ENDWALL;
  return style==0?S_APT_BALCONY:style==1?S_APT_LOGGIA:style==2?S_APT_RIBBON:style==3?S_APT_FINS:
    style==4?S_APT_SCREEN:style==5?S_APT_BRICK:S_APT_GLASS;
}
vec2 octEnc(vec3 n){
  vec2 p=n.xz/(abs(n.x)+abs(n.y)+abs(n.z)+1e-6);
  if (n.y<0.) p=(1.-abs(p.yx))*vec2(p.x>=0.?1.:-1.,p.y>=0.?1.:-1.);
  return p*(127./255.)+(127./255.);
}
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
uniform int uShape;
flat out vec4 vG0;
flat out vec4 vG1;
out vec2 vFaceUV;
flat out vec2 vFaceSize;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vec3 vSize=vec3(length(a0.xyz),length(a1.xyz),length(a2.xyz));
  vec3 invS=1./max(vSize,vec3(1e-6));
  vec3 ax=a0.xyz*invS.x, ay=a1.xyz*invS.y, az=a2.xyz*invS.z;
  vec3 wn=normalize(ax*(aNormal.x*invS.x)+ay*(aNormal.y*invS.y)+az*(aNormal.z*invS.z));
  int kind=int(aTint.a+.5);
  float slot=floor((wn.y>.6?a0.w:wn.y<-.6?a2.w:a1.w)+.5);
  float meta=16.+clamp(float(uShape),0.,15.);
  vec2 fuv=vec2(0.), fsz=vec2(0.);
  if (kind==6 || kind==8 || kind==10 || kind==11 || kind==15 || kind==29) {
    vec3 lp=aPos*vSize;
    vec3 nObj=vec3(dot(wn,ax),dot(wn,ay),dot(wn,cross(ax,ay)));
    vec3 fMask=step(vec3(.5),abs(nObj));
    vec2 faceUV=lp.xz, faceSize=vSize.xz;
    if (fMask.x>.5) {faceUV=vec2(-sign(nObj.x)*lp.z,lp.y); faceSize=vSize.zy;}
    else if (fMask.z>.5) {faceUV=vec2(sign(nObj.z)*lp.x,lp.y); faceSize=vSize.xy;}
    fsz=faceSize;
    if (kind==10) {
      if (abs(wn.y)>.55) slot=float(S_ROOF_MEMBRANE);
      else {
        int face=fMask.z>.5?(nObj.z>0.?0:1):2;
        slot=float(apartmentSlot(int(aExtra.x+.5),face));
      }
      vec3 q=fract(a3.xyz*vec3(.1031,.1030,.0973));
      q+=dot(q,q.yzx+33.33);
      float vSeed=fract((q.x+q.y)*q.z);
      meta=16.+floor(clamp(vSeed,0.,.999)*15.+.5);
      fuv=faceUV+faceSize*.5;
    } else if (kind==15) {
      meta=16.+clamp(floor(aExtra.y+.5),0.,15.);
      fuv=faceUV;
    } else {
      fuv=faceUV+faceSize*.5;
    }
  } else if (kind==23 || kind==25) {
    fuv=aUV;
  } else if (kind==5) {
    meta=16.+clamp(floor(aExtra.y+.5),0.,15.);
  }
  vG0=vec4(aTint.rgb,float(kind)/255.);
  vG1=vec4(octEnc(wn),(clamp(slot,-1.,253.)+1.)/255.,meta/255.);
  vFaceUV=fuv;
  vFaceSize=fsz;
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const GBUF_FULL_FLAT_FRAGMENT=`#version 300 es
precision highp float;
flat in vec4 vG0;
flat in vec4 vG1;
in vec2 vFaceUV;
flat in vec2 vFaceSize;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
layout(location=2) out vec4 g2;
void main(){
  g0=vG0;
  g1=vG1;
  g2=vec4(vFaceUV,vFaceSize);
}`;

// Non-instanced baked/streamed G-buffer shaders: eliminate per-instance drawElementsInstanced
// dispatch overhead with pre-transformed world vertices and byte-packed G-buffer payloads.
export const GBUF_BAKED_FLAT_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aG0;
layout(location=2) in vec4 aG1;
uniform mat4 uVP;
#ifdef MIRROR_CLIP
out float vPosY;
#endif
flat out vec4 vG0;
flat out vec4 vG1;
void main(){
#ifdef MIRROR_CLIP
  vPosY=aPos.y;
#endif
  vG0=aG0;
  vG1=aG1;
  gl_Position=uVP*vec4(aPos,1.);
}`;

export const GBUF_BAKED_FLAT_FRAGMENT=`#version 300 es
precision highp float;
#ifdef MIRROR_CLIP
in float vPosY;
#endif
flat in vec4 vG0;
flat in vec4 vG1;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
void main(){
#ifdef MIRROR_CLIP
  if (vPosY<.037) discard;
#endif
  g0=vG0;
  g1=vG1;
}`;

export const GBUF_BAKED_FULL_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aG0;
layout(location=2) in vec4 aG1;
layout(location=3) in vec4 aG2;
uniform mat4 uVP;
flat out vec4 vG0;
flat out vec4 vG1;
out vec4 vG2;
void main(){
  vG0=aG0;
  vG1=aG1;
  vG2=aG2;
  gl_Position=uVP*vec4(aPos,1.);
}`;

export const GBUF_BAKED_FULL_FRAGMENT=`#version 300 es
precision highp float;
flat in vec4 vG0;
flat in vec4 vG1;
in vec4 vG2;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
layout(location=2) out vec4 g2;
void main(){
  g0=vG0;
  g1=vG1;
  g2=vG2;
}`;

export const GBUF_BAKED_ARCH_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aNorm;
layout(location=2) in vec4 aG0;
layout(location=3) in vec4 aMeta;
uniform mat4 uVP;
out vec3 vNormal;
#ifdef MIRROR_CLIP
out float vPosY;
#endif
flat out vec4 vG0;
flat out vec4 vMeta;
void main(){
  vNormal=aNorm.xyz;
#ifdef MIRROR_CLIP
  vPosY=aPos.y;
#endif
  vG0=aG0;
  vMeta=aMeta;
  gl_Position=uVP*vec4(aPos,1.);
}`;

export const GBUF_BAKED_ARCH_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
in vec3 vNormal;
#ifdef MIRROR_CLIP
in float vPosY;
#endif
flat in vec4 vG0;
flat in vec4 vMeta;
layout(location=0) out vec4 g0;
layout(location=1) out vec4 g1;
void main(){
#ifdef MIRROR_CLIP
  if (vPosY<.037) discard;
#endif
  vec3 ng=normalize(vNormal);
  float slot1=ng.y>.6?vMeta.x:ng.y<-.6?vMeta.z:vMeta.y;
  g0=vG0;
  g1=vec4(octEnc(ng),slot1*(1./255.),vMeta.w*(1./255.));
}`;

// Single-pass branch-coherent Deferred Outdoor PBR + Sky shader (analytic vRay,
// #define NO_SURFACES 1 procedural fast path, 0.06% sky early-return, 18.9% full-PBR
// branch isolation, pre-biased 3x4 affine shadows & CPU-hoisted uFogParams).
export const DEFERRED_OUTDOOR_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
${SKY}
in vec2 vUV;
in vec3 vRay;
uniform highp sampler2D uGDepth;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform highp sampler2D uG2;
uniform vec2 uDepthAB;
uniform vec3 uEye;
uniform float uPixelStep;
uniform vec3 uSunColor;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM0;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2DArray uInk;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform vec4 uInkActiveBox;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform sampler2D uReflection;
uniform bool uReflectOn;
uniform vec2 uViewport;
uniform vec4 uFogParams;
uniform float uRaytrace;
uniform float uWetLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;
#ifndef NO_SURFACES
${SURFACE_HIGH}
#endif
vec4 det(vec2 p){return texture(uDetail,p);}
vec3 envSpec(vec3 r,float rough){return envDecode(textureLod(uEnv,envUV(r),clamp(sqrt(rough)*uEnvLod,0.,uEnvLod)));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 specGGX(vec3 n,vec3 v,vec3 l,vec3 f0,float rough,float nv,float nl){
  vec3 h=normalize(l+v);
  float nh=max(dot(n,h),0.), a=max(rough*rough,.0016);
  vec3 F=f0+(1.-f0)*pow5(1.-max(dot(v,h),0.));
  return ggxD(nh,a)*visSmith(nv,nl,a)*F*nl;
}
vec2 envBRDF_AB(float rough,float nv){
  const vec4 c0=vec4(-1.,-.0275,-.572,.022);
  const vec4 c1=vec4(1.,.0425,1.04,-.04);
  vec4 r=rough*c0+c1;
  float a004=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;
  return vec2(-1.04,1.04)*a004+r.zw;
}
vec3 envBRDF(vec3 f0,float rough,float nv){
  vec2 ab=envBRDF_AB(rough,nv);
  return f0*ab.x+ab.y;
}
// Physically-based Rayleigh cool sky scatter + two-lobe Mie sun forward scatter aerial perspective.
vec3 aerialFog(vec3 dir){
  vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
  vec3 baseFog=fogEnv(fdir);
  float clearAir=(1.-uRainLevel*.82)*(1.-uBossRage*.88);
  vec3 rayleigh=vec3(.52,.72,1.04)*(lum(baseFog)*.26)*clearAir*smoothstep(-.05,.32,dir.y+.10);
  float sm=sat(dot(dir,uSun)); float sm2=sm*sm; float sm8=sm2*sm2; sm8*=sm8;
  vec3 mie=uSunColor*((sm2*.032+sm8*.092)*(1.-uRainLevel*.88));
  vec3 rainCol=mix(vec3(.13,.155,.185),vec3(.16,.035,.042),uBossRage);
  return mix(baseFog+rayleigh+mie,rainCol,uRainLevel*.55);
}
float shadowTap(sampler2DShadow s,vec3 c,float texel){
  int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
  vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(texel*1.22);
  return (texture(s,vec3(c.xy+d,c.z))+texture(s,vec3(c.xy-d,c.z)))*.5;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
  float slope=1.-sat(dot(ng,uSun));
  vec3 q0=p+ng*(uShadowTexel.z*(1.2+slope*1.6));
  vec3 c0=uShadowM0[0].xyz*q0.x+uShadowM0[1].xyz*q0.y+uShadowM0[2].xyz*q0.z+uShadowM0[3].xyz;
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y);
  float s0=1.;
  if (inner>0. && c0.z<1.) s0=shadowTap(uShadow0,vec3(c0.xy,c0.z-.00022),uShadowTexel.x);
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  vec3 q1=p+ng*(uShadowTexel.w*(1.2+slope*1.6));
  vec3 c1=uShadowM1[0].xyz*q1.x+uShadowM1[1].xyz*q1.y+uShadowM1[2].xyz*q1.z+uShadowM1[3].xyz;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}
vec3 roomBehind(vec2 uv,vec3 viewT,float seed,float lightOn,float depth,float px){
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
  vec3 col=wallC*mix(.74,.9,backHit);
  col=mix(col,vec3(.22,.18,.15)*(1.+seed*.4),floorHit);
  col=mix(col,vec3(.72,.71,.66),ceilHit);
  float furniture=backHit*step(abs(hit.x+.18-seed*.3),.22)*step(hit.y,-.12);
  col=mix(col,vec3(.18,.17,.16),furniture*.85);
#ifndef NO_SURFACES
  if (uSurfaceSheets>0 && px<.045) {
    float texels=.5/uSurfaceEdge.x, metres=1.5;
    int floorSlot=seed<.33?S_TATAMI:seed<.66?S_WOOD_FLOORING:S_CARPET_TILE;
    int wallSlot=fract(seed*7.31)<.5?S_VINYL_WALLPAPER:S_GYPSUM_PAINTED;
    if (floorHit>.5 && surfaceReady(floorSlot)) {
      float lod=log2(max(px*2.5*texels/S_METERS[floorSlot],1.));
      vec3 c=toLinear(surfaceLod(floorSlot,hit.xz*metres,lod).rgb);
      col=c*(.9+seed*.2);
    } else if (ceilHit<.5 && surfaceReady(wallSlot)) {
      float lod=log2(max(px*2.*texels/S_METERS[wallSlot],1.));
      vec2 wp=(backHit>.5?hit.xy:vec2(hit.z,hit.y))*metres;
      vec3 c=toLinear(surfaceLod(wallSlot,wp,lod).rgb);
      col*=c/max(toLinear(surfaceMean(wallSlot)),vec3(.02));
    }
  }
#endif
  float shelf=backHit*step(.18,hit.x)*step(hit.x,.42)*step(abs(fract(hit.y*3.)-.5),.06);
  col=mix(col,vec3(.30,.26,.21),shelf);
  float lamp=ceilHit*smoothstep(.16,.05,length(hit.xz-vec2(0.,.4*depth)));
  vec3 light=mix(vec3(.30,.32,.33),vec3(1.,.82,.58)*1.6,lightOn);
  return col*light+vec3(1.,.86,.62)*lamp*lightOn*4.;
}
void main(){
  ivec2 ipx=ivec2(gl_FragCoord.xy);
  float rawD=texelFetch(uGDepth,ipx,0).r;
  float invRL=inversesqrt(dot(vRay,vRay));
  vec3 dir=vRay*invRL;
  if (rawD>=.99999) {
    frag=vec4(skyFull(dir,true,true),0.);
    return;
  }
  float zView=uDepthAB.x/(uDepthAB.y-rawD);
  vec3 vPos=uEye+vRay*zView;
  float dist=zView/invRL;
  vec3 V=-dir;
  vec4 g0=texelFetch(uG0,ipx,0);
  vec4 g1=texelFetch(uG1,ipx,0);
  int kind=int(g0.a*255.+.5);
  vec3 ng=octDec(g1.rg);
  int meta=int(g1.a*255.+.5);
  bool isFull=(meta&16)!=0;
  int lowMeta=meta&15;
  vec3 tint=toLinear(g0.rgb);
  vec3 an=abs(ng);
  vec2 xz=vPos.xz;
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
#ifdef NO_SURFACES
  float px=dist*uPixelStep;
#else
  vec3 sdpxRaw=dFdx(vPos), sdpyRaw=dFdy(vPos);
  float maxStep=max(dist*uPixelStep*5.,0.008), maxStep2=maxStep*maxStep;
  float ldx2=dot(sdpxRaw,sdpxRaw), ldy2=dot(sdpyRaw,sdpyRaw);
  bool discEdge=(ldx2>maxStep2 || ldy2>maxStep2);
  vec3 sdpx=ldx2>maxStep2?sdpxRaw*(maxStep*inversesqrt(ldx2)):sdpxRaw;
  vec3 sdpy=ldy2>maxStep2?sdpyRaw*(maxStep*inversesqrt(ldy2)):sdpyRaw;
  float px=max(length(sdpx),length(sdpy));
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy);
  vec2 sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  int slot=uSurfaceSheets>0?(int(g1.b*255.+.5)-1):-1;
  bool real=surfaceReady(slot);
#endif

  if (kind==3) {
    vec3 col=tint*3.2;
#ifndef NO_SURFACES
    if (real) {
      vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
      col*=mix(vec3(1.),toLinear(stex.rgb)/max(toLinear(surfaceMean(slot)),vec3(.05)),.75);
    }
#endif
    float dy=vPos.y-uEye.y;
    float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
    float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
    if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
    if (fogAmt>.002) col=mix(col,aerialFog(dir),fogAmt);
    frag=vec4(col,0.);
    return;
  }
  if (kind==25) {
    vec2 uv2=texelFetch(uG2,ipx,0).xy;
    float rim=pow(1.-max(0.,dot(ng,V)),2.5);
    float veins=sin(uv2.x*32.+uv2.y*21.-uClock*19.+det(uv2*1.3).r*9.);
    float streak=smoothstep(.42,.96,veins)*.55+rim*.46;
    vec3 liquid=tint*(1.2+.5*max(dot(ng,uSun),0.)+.25*veins);
    vec3 col=mix(liquid,vec3(2.6,2.3,2.6),sat(streak))*1.4;
    frag=vec4(col,0.);
    return;
  }

  bool vertical=an.y<.45;
  float wallBase=vertical && vPos.y<1.65 && (kind==2 || kind==4 || kind==10 || kind==13 || kind==19)?
    1.-smoothstep(0.,.95+det(uvW*.043).r*.6,vPos.y):0.;
  vec3 albedo=tint, emit=vec3(0.), n=ng;
  float rough=.86, metal=0., ao=1., f0Base=.04, clear=0., sheen=0., trans=0., surfH=0., relief=0.;

  if (!isFull) {
    if (kind==1) {
      float oil=smoothstep(.62,.8,det(uvW*.09+.7).r)*.18;
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH)*(1.-oil); relief=1.;}
      else
#endif
      albedo=tint*(.92+(det(uvW*.31).r-.5)*.14)*(1.-oil);
      rough=.82-oil*.25;
    } else if (kind==4) {
      vec4 d2=det(uvW*3.1);
      float sat0=max(max(tint.r,tint.g),tint.b)-min(min(tint.r,tint.g),tint.b);
      float galvanized=step(sat0,.035)*step(.12,lum(tint));
      metal=galvanized;
      vec3 baseCol=mix(tint,vec3(.56,.57,.58)*(.85+d2.g*.3),galvanized*.8);
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,baseCol,1.,.004,surfH); relief=1.;}
      else
#endif
      albedo=baseCol*(.94+(d2.r-.5)*.12);
      rough=mix(.38+d2.r*.14,.34+d2.g*.2,galvanized);
      albedo=mix(albedo,albedo*.6,wallBase*.4*float(vertical));
    } else if (kind==2 || kind==19) {
#ifndef NO_SURFACES
      if (real) {
        albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH); relief=1.;
        albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55*float(vertical)); rough=.88;
      } else
#endif
      {
        float g=det(uvW*.29).r;
        albedo=tint*(.92+(g-.5)*.16);
        if (vertical) albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55);
      }
    } else if (kind==20) {
      clear=.75;
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,.6,.002,surfH); rough=.33; relief=.4;}
      else
#endif
      {float peel=det(uvW*9.).r; albedo=tint*(.97+peel*.04); rough=.30+peel*.06;}
    } else if (kind==21) {
      sheen=.18; f0Base=.035;
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.003,surfH); rough=.72; relief=.5;}
      else
#endif
      {vec4 d2=det(uvW*4.); albedo=tint*(.9+d2.r*.14)+vec3(.012)*sat(ng.y); rough=.68+d2.a*.1;}
    } else if (kind==18 || kind==30 || kind==31) {
      rough=.88; sheen=.55; f0Base=.03;
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.003,surfH); relief=.5;}
      else
#endif
      albedo=tint*(.9+det(uvW*2.).r*.12);
    } else if (kind==9) {
      albedo=tint*.92; rough=.07; clear=1.; trans=.35; emit=tint*.22;
    } else if (kind==0 || kind==22) {
      vec4 d2=det(uvW*2.3);
      float worn=an.y>.6?smoothstep(.55,.75,det(uvW*.6).r*.6+d2.r*.5):0.;
      albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
      rough=.62+worn*.2;
      if (kind==22 && an.y>.6 && px<.015) {
        float bead=step(.985,det(uvW*31.).a)*(1.-worn);
        f0Base=mix(.04,.4,bead); rough=mix(rough,.2,bead);
      }
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,kind==22?1.:.7,.003,surfH); relief=.5;}
#endif
    } else if (kind==13) {
#ifndef NO_SURFACES
      if (real) {
        albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.012,surfH); relief=1.;
        bool nat=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
        if (!nat) albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
        rough=nat?.9:.78;
      } else
#endif
      {
        vec2 bricks=uvW/vec2(.69,.296);
        bricks.x+=mod(floor(bricks.y),2.)*.5;
        vec2 b=fract(bricks), id=floor(bricks);
        vec2 jd=min(b,1.-b)*vec2(.69,.296);
        float mortar=1.-smoothstep(.006,.016+px*.5,min(jd.x,jd.y));
        albedo=mix(tint*(.84+hash12(id)*.24),vec3(.52,.50,.46),mortar*.85);
        albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
        rough=mix(.78,.92,mortar);
      }
    } else {
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH); relief=1.; rough=.78;}
      else
#endif
      {
        float g=det(uvW*.29).r;
        albedo=tint*(.92+(g-.5)*.16);
        if (vertical) albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55);
      }
    }
#ifndef NO_SURFACES
    surfH*=relief*(1.-smoothstep(.004,.03,px));
    vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
    if (relief>0. && px<.03 && !discEdge) {
      vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
      float area=dot(sdpx,r1);
      n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
    }
#endif
  } else {
    // Full PBR path (~19% of screen): roads, skyscrapers, apartments, windows, stairs, wood, boss.
#ifdef NO_SURFACES
    vec3 sdpxRaw=dFdx(vPos), sdpyRaw=dFdy(vPos);
    float maxStep=max(dist*uPixelStep*5.,0.008), maxStep2=maxStep*maxStep;
    float ldx2=dot(sdpxRaw,sdpxRaw), ldy2=dot(sdpyRaw,sdpyRaw);
    bool discEdge=(ldx2>maxStep2 || ldy2>maxStep2);
    vec3 sdpx=ldx2>maxStep2?sdpxRaw*(maxStep*inversesqrt(ldx2)):sdpxRaw;
    vec3 sdpy=ldy2>maxStep2?sdpyRaw*(maxStep*inversesqrt(ldy2)):sdpyRaw;
    px=max(length(sdpx),length(sdpy));
#endif
    rough=.6;
    if (kind==5) {
      vec4 d1=det(uvW*.23);
      float crackZone=smoothstep(.58,.70,det(uvW*.031+.4).r);
      float tar=crackZone>.005?smoothstep(.84,.97,det(uvW*.083+.2).b)*crackZone*.85:0.;
      float puddleField=det(xz*.045+.11).r*.75+d1.r*.35+uWetLevel*.10;
      float puddle=smoothstep(.56,.70,puddleField);
      // Capillary damp shoreline halo around puddles (darkens porous stone at water's edge)
      float dampRing=smoothstep(.42,.60,puddleField)*(1.-puddle);
      float wet=sat(puddle*1.6);
      vec3 asphalt;
#ifndef NO_SURFACES
      if (real) {
        vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
        float h1=0., h2=0., aged=smoothstep(.38,.62,sfNoise(xz*.026+1.7));
        vec3 fresh=realSurface(stex,S_ASPHALT,tint*.70,1.,.008,h1), old=fresh;
        if (aged>.01 && surfaceReady(S_ASPHALT_WORN)) old=realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(9.,23.),sdx,sdy),S_ASPHALT_WORN,tint*.70,1.,.008,h2);
        else h2=h1;
        asphalt=mix(fresh,old,aged);
        surfH=mix(h1,h2,aged);
        relief=1.-wet;
        rough=mix(.82,.05,puddle);
      } else
#endif
      {
        vec4 d2=det(uvW*1.9), d3=det(uvW*7.1);
        float stones=smoothstep(.30,.08,d3.g), patchy=smoothstep(.45,.62,d1.r);
        asphalt=tint*.70*(.86+(d2.r-.5)*.24+stones*.32+(d3.a-.5)*.18)*mix(1.,.86,patchy);
        rough=mix(.86-stones*.12,.05,puddle);
        surfH=-d3.g*.0045;
        relief=1.-wet;
      }
      rough=mix(rough,rough*.64,dampRing);
      f0Base=mix(f0Base,.021,puddle);
      asphalt=mix(asphalt,vec3(.018,.019,.02),tar);
      albedo=asphalt*mix(1.,.44,sat(wet+dampRing*.68));
      ao=1.-tar*.3;
      if (puddle>.01) {
        float t1=uClock*1.3, t2=uClock*2.7;
        float r1=sin(xz.x*5.1+xz.y*2.3+t1)*sin(xz.y*4.7-xz.x*1.1-t1*.85);
        float r2=sin(xz.x*13.7-xz.y*9.4+t2)*cos(xz.y*11.3+xz.x*8.9-t2*1.15);
        float rAmp=mix(.018,.034,uRainLevel);
        n=normalize(mix(n,vec3((r1+r2*.42)*rAmp,1.,(r1*.75-r2*.38)*rAmp),puddle));
      }
    } else if (kind==10) {
      vec4 g2=texelFetch(uG2,ipx,0);
      vec2 fp=g2.xy, fsz=g2.zw;
      if (an.y>.55) {
        albedo=tint*.66; rough=.9;
#ifndef NO_SURFACES
        if (uSurfaceSheets>0 && surfaceReady(S_ROOF_MEMBRANE)) {
          albedo=realSurface(surfaceTap(S_ROOF_MEMBRANE,uvW,sdx,sdy),S_ROOF_MEMBRANE,tint*.66,1.,.01,surfH);
          relief=1.;
        }
#endif
      } else {
        vec2 rs=vec2(max(1.,floor(fsz.x/6.+.5))/fsz.x,1./5.84);
        float parapet=step(fsz.y-1.05,fp.y);
#ifndef NO_SURFACES
        if (real) {
          vec3 tx=an.y<.99?normalize(cross(vec3(0.,1.,0.),ng)):vec3(1.,0.,0.);
          vec2 fdx=vec2(dot(sdpx,tx),sdpx.y), fdy=vec2(dot(sdpy,tx),sdpy.y);
          float seed=float(lowMeta)/15.;
          float cell=hash12(floor(fp*rs*vec2(1.,2.))+seed*13.);
          vec4 t=surfaceTap(slot,fp*rs,fdx*rs,fdy*rs);
          vec3 c=realSurface(t,slot,tint,1.,0.,surfH)*(.96+cell*.08);
          float glass=smoothstep(.02,.07,t.b-t.r)*smoothstep(.62,.3,t.b)*(1.-parapet);
          albedo=mix(c,tint*.86,parapet);
          rough=mix(.82,.1,glass);
          f0Base=mix(.04,.06,glass);
        } else
#endif
        {
          float storey=fract(fp.y/2.92);
          float win=step(.25,storey)*step(storey,.8)*step(.12,fract(fp.x*rs.x*2.))*step(fract(fp.x*rs.x*2.),.88);
          albedo=mix(tint*.92,vec3(.05,.06,.07),win*(1.-parapet));
          rough=mix(.85,.12,win);
        }
        albedo=mix(albedo,albedo*vec3(.72,.70,.64),wallBase*.5);
      }
    } else if (kind==8 || kind==6) {
      vec4 g2=texelFetch(uG2,ipx,0);
      vec2 fp=g2.xy, faceSize=g2.zw;
      bool windowPane=kind==8 && vertical && min(faceSize.x,faceSize.y)>.55 && max(faceSize.x,faceSize.y)>.9 && lowMeta==1;
      if (kind==6 && !vertical) {
        float rip=sin(xz.x*4.3+xz.y*1.9+uClock*.9)*sin(xz.y*4.7-xz.x*.9-uClock*.82);
        n=normalize(vec3(rip*.05,1.,cos(xz.x*2.7+xz.y*1.8+uClock*.8)*.04));
        albedo=tint*.25; rough=.04; f0Base=.02;
      } else {
        float dirt=det(uvW*.8).r;
        albedo=tint*.05; rough=.02+dirt*.05; f0Base=.045;
#ifndef NO_SURFACES
        if (real) {
          vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
          float smear=sfLum(stex.rgb);
          rough=mix(rough,.38,smear*.55);
          albedo=mix(albedo,toLinear(stex.rgb)*.3,smear*.22);
        }
#endif
        vec3 tx=an.y<.99?normalize(cross(vec3(0.,1.,0.),ng)):vec3(1.,0.,0.);
        vec3 ty=vec3(0.,1.,0.);
        if (lowMeta==1 && vertical && max(faceSize.x,faceSize.y)>2.6) {
          vec2 paneSz=vec2(faceSize.x/max(1.,floor(faceSize.x/1.5)),faceSize.y/max(1.,floor(faceSize.y/1.7)));
          vec2 pg=fp/paneSz, pc=fract(pg), pid=floor(pg);
          float fr=1.-smoothstep(.025,.045,min(min(pc.x,1.-pc.x)*paneSz.x,min(pc.y,1.-pc.y)*paneSz.y));
          n=normalize(n+(tx*(hash12(pid)-.5)+ty*(hash12(pid+3.)-.5))*.035);
          albedo=mix(albedo,vec3(.05,.055,.06),fr);
          rough=mix(rough+hash12(pid+7.)*.05,.45,fr);
          f0Base=mix(f0Base,.04,fr);
        }
        if (windowPane || kind==6) {
          vec3 vt=vec3(dot(-V,tx),dot(-V,ty),dot(V,n));
          vec2 cellSz=kind==6?vec2(1.6,2.7):faceSize;
          vec2 uv=fp/cellSz;
          vec2 rid=floor(uv)+floor(vPos.xz*.1);
          float seed=hash12(rid+floor(vPos.y/3.));
          float on=step(.62,hash12(rid*1.7+3.))*.35;
#ifdef SAFE
          vec3 room=vec3(.2,.21,.2)*(.7+seed*.5);
#else
          vec3 room=(px<.12 && dist<65.)?roomBehind(fract(uv),vt,seed,on,kind==6?2.2:1.6,px):mix(vec3(.22,.23,.24),vec3(.62,.52,.38),on)*(.75+seed*.45);
#endif
          float fres=.04+.96*pow5(1.-max(dot(n,V),0.));
          emit=room*(1.-fres)*(kind==6?.22:.34)*(1.-dirt*.3);
          f0Base=kind==6?.07:f0Base;
          float blind=kind==6?step(.7,seed)*smoothstep(.0,.02,fract(uv.y)-.6):0.;
          emit*=1.-blind*.7;
          albedo=mix(albedo,vec3(.62,.6,.55),blind);
#if !defined(SAFE) && !defined(NO_SURFACES)
          if (kind==6 && uSurfaceSheets>0) {
            if (blind>0. && surfaceReady(S_WINDOW_BLINDS)) albedo=mix(albedo,toLinear(surfaceTap(S_WINDOW_BLINDS,uvW,sdx,sdy).rgb)*.85,blind);
            float reed=step(.47,seed)*step(seed,.55);
            if (reed>0. && surfaceReady(S_SUDARE)) {albedo=mix(albedo,toLinear(surfaceTap(S_SUDARE,uvW,sdx,sdy).rgb)*.8,.88); emit*=.3; f0Base=mix(f0Base,.03,.88);}
            float paper=step(.55,seed)*step(seed,.7);
            if (paper>0. && surfaceReady(S_SHOJI_PAPER)) {vec3 shoji=toLinear(surfaceTap(S_SHOJI_PAPER,uvW,sdx,sdy).rgb); emit=shoji*mix(.16,.55,on)*(1.-fres); albedo=mix(albedo,shoji*.45,.5);}
          }
#endif
        }
      }
    } else if (kind==11) {
      if (an.y>.55) {
#ifndef NO_SURFACES
        if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint*.72,1.,.01,surfH); rough=.9; relief=1.;}
        else
#endif
        {vec4 d1=det(uvW*.4); albedo=tint*.72*(.85+d1.r*.25)*mix(1.,.8,smoothstep(.6,.8,det(uvW*.17+.31).r)); rough=.9;}
      } else {
        vec4 g2=texelFetch(uG2,ipx,0);
        vec2 fp=g2.xy, fsz=g2.zw;
        vec3 tx=an.y<.99?normalize(cross(vec3(0.,1.,0.),ng)):vec3(1.,0.,0.);
        vec2 fdx=vec2(dot(sdpx,tx),sdpx.y), fdy=vec2(dot(sdpy,tx),sdpy.y);
        float facade=fract(dot(g0.rgb,vec3(17.3,7.9,11.1)));
        bool curtain=facade>.72 && fsz.y>9.;
        bool ribbon=!curtain && facade>.46;
        vec2 cellSz=vec2(fsz.x/max(1.,floor(fsz.x/(curtain?1.6:2.2))),3.15);
        vec2 g=fp/cellSz, cell=fract(g), cid=floor(g);
        vec2 fw=(abs(fdx)+abs(fdy))/cellSz;
        vec2 lo=curtain?vec2(.035,.05):ribbon?vec2(.02,.30):vec2(.17,.24);
        vec2 hiE=curtain?vec2(.965,.95):ribbon?vec2(.98,.82):vec2(.83,.86);
        vec2 inW=smoothstep(lo-fw,lo+fw,cell)*(1.-smoothstep(hiE-fw,hiE+fw,cell));
        float win=inW.x*inW.y;
        float detailVis=1.-smoothstep(.10,.30,max(fw.x,fw.y));
        vec3 wall=tint;
        if (win<.995 && detailVis>.01) {
#ifndef NO_SURFACES
          if (real) {wall=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.008,surfH); relief=1.-win;}
          else
#endif
          wall=tint*(.9+(det(uvW*1.2).r-.5)*.14);
          if (detailVis>.25) {
            float under=smoothstep(lo.y,lo.y-.25,cell.y)*step(lo.x,cell.x)*step(cell.x,hiE.x);
            if (under>.005) wall*=1.-under*smoothstep(.4,.8,det(vec2(g.x*3.,g.y*.25)).r)*.32;
            float stain=det(uvW*.17+.31).r;
            wall=mix(wall,wall*.8,smoothstep(.55,.8,stain)*.5);
          }
          float sill=smoothstep(.035,.0,abs(cell.y-lo.y+.03))*step(lo.x-.03,cell.x)*step(cell.x,hiE.x+.03);
          wall=mix(wall,vec3(.75,.74,.70),sill*.6*detailVis);
        }
        albedo=wall; rough=.82;
        if (win>.002 && detailVis>.005) {
          vec3 vt=vec3(dot(-V,tx),-V.y,dot(V,n));
          vec2 recess=vt.xy/max(vt.z,.2)*.08/cellSz;
          vec2 wuv=(cell-lo)/(hiE-lo);
          vec2 rev=step(wuv,-recess*4.)+step(1.-recess*4.,wuv);
          float reveal=sat(max(rev.x,rev.y))*detailVis;
          float seed=hash12(cid+floor(vPos.xz*.37));
          float on=step(.7,hash12(cid*3.1+1.7));
#ifdef SAFE
          vec3 room=vec3(.18,.2,.21)*(.8+seed*.4);
#else
          vec3 room=(detailVis>.30 && dist<75.)?roomBehind(sat(wuv),vt,seed,on,1.4,px):mix(vec3(.22,.23,.24),vec3(.62,.52,.38),on)*(.75+seed*.45);
#endif
          float mull=1.-smoothstep(.006,.014,abs(wuv.x-.5));
          float pane=hash12(cid+.3);
          vec3 glassTint=curtain?mix(vec3(.025,.04,.05),vec3(.04,.05,.045),pane):vec3(.03);
          albedo=mix(wall,glassTint,win);
          rough=mix(.82,.03+pane*.04,win);
          f0Base=mix(.04,curtain?.11:.075,win);
          vec3 nWin=normalize(n+(tx*(pane-.5)+vec3(0.,1.,0.)*(hash12(cid+5.)-.5))*.02);
          n=normalize(mix(n,nWin,win));
          float fres=.04+.96*pow5(1.-max(dot(n,V),0.));
          emit=room*win*(1.-fres)*(1.-reveal)*.30*(1.-mull*.8);
          albedo=mix(albedo,vec3(.42,.43,.42),reveal*win+mull*win*detailVis);
          rough=mix(rough,.6,reveal*win);
          ao=1.-reveal*win*.5;
        }
        if (detailVis<.99) {
          vec3 far=mix(wall,vec3(.08,.1,.11),.45);
#ifndef NO_SURFACES
          float pick=fract(facade*7.3);
          int farSlot=curtain?(pick<.5?S_REFLECTIVE_GLASS:S_MIRROR_STAINLESS):
            ribbon || fsz.y>26.?S_FACADE_OFFICE_FAR:
            fsz.y<13. && vPos.y-fp.y<1. && pick<.6?S_FACADE_RETAIL_FAR:S_FACADE_APARTMENT_FAR;
          if (uSurfaceSheets>0 && surfaceReady(farSlot)) {
            float hf=0.;
            far=realSurface(surfaceTap(farSlot,fp,fdx,fdy),farSlot,tint,1.,0.,hf);
            float glassy=1.-smoothstep(.04,.16,lum(far));
            f0Base=mix(f0Base,curtain?.11:.06,(1.-detailVis)*(curtain?1.:glassy));
            rough=mix(rough,mix(.8,.08,curtain?1.:glassy),1.-detailVis);
          }
#endif
          albedo=mix(far,albedo,detailVis);
        }
      }
    } else if (kind==15) {
      vec4 g2=texelFetch(uG2,ipx,0);
      vec2 faceUV=g2.xy, faceSize=g2.zw;
      float nose=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)))*step(.6,an.y);
#ifndef NO_SURFACES
      if (real) {
        vec3 ground=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH);
        if (nose>.01 && surfaceReady(S_RUBBER_STAIR)) {
          float h5=0.;
          ground=mix(ground,realSurface(surfaceTap(S_RUBBER_STAIR,uvW,sdx,sdy),S_RUBBER_STAIR,vec3(.05),1.,.006,h5),nose);
        }
        albedo=ground; rough=mix(.82,.9,nose); relief=1.;
      } else
#endif
      {
        albedo=tint*(.92+(det(uvW*.31).r-.5)*.14)*mix(1.,.55,nose);
        rough=mix(.82,.9,nose);
      }
    } else if (kind==13) {
#ifndef NO_SURFACES
      if (real) {
        vec4 stex=lowMeta==0?surfaceTri(slot,vPos,ng,sdpx,sdpy):surfaceTap(slot,uvW,sdx,sdy);
        bool nat=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
        vec3 b=realSurface(stex,slot,tint,1.,nat?.02:.012,surfH);
        if (!nat) b=mix(b,b*.66,wallBase*.6*float(vertical));
        albedo=b; rough=nat?.9:.78; relief=1.;
      } else
#endif
      {
        vec2 bricks=uvW/vec2(.69,.296);
        bricks.x+=mod(floor(bricks.y),2.)*.5;
        vec2 b=fract(bricks), id=floor(bricks);
        vec2 jd=min(b,1.-b)*vec2(.69,.296);
        float mortar=1.-smoothstep(.006,.016+px*.5,min(jd.x,jd.y));
        vec4 d2=det(uvW*1.7+id*.13);
        vec3 c=tint*(.84+hash12(id)*.24+(d2.r-.5)*.18)*mix(vec3(1.),vec3(1.04,.97,.92),hash12(id+7.)*.5);
        c=mix(c,vec3(.52,.50,.46)*(.9+d2.a*.2),mortar*.85);
        albedo=mix(c,c*.66,wallBase*.6*float(vertical));
        rough=mix(.74+d2.r*.12,.92,mortar);
        ao=1.-mortar*.45;
      }
    } else if (kind==23) {
      vec2 uv2=texelFetch(uG2,ipx,0).xy;
      float rib=sin(uv2.y*85.+sin(uv2.x*37.7)*.86);
      float nacre=pow(1.-max(0.,dot(ng,V)),2.2);
      float pores=det(uv2*vec2(3.,2.)).g;
      vec3 interference=mix(vec3(.10,.22,.40),vec3(.53,.24,.38),.5+.5*sin(uv2.x*18.85+uv2.y*8.));
      albedo=mix(tint*(.85+pores*.22+rib*.07),toLinear(interference),.32*nacre);
      rough=.26+.08*pores; clear=.8; metal=.1;
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTri(slot,vPos,ng,sdpx,sdpy),slot,albedo,.8,.006,surfH); relief=.5;}
#endif
    } else if (kind==26) {
      albedo=tint*.95; rough=.09; clear=.9; emit=tint*.05;
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,.35,.002,surfH); relief=.3;}
#endif
    } else if (kind==29) {
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.012,surfH); rough=.78; relief=1.;}
      else
#endif
      {
        vec4 g2=texelFetch(uG2,ipx,0);
        vec2 g=g2.xy, faceSize=g2.zw;
        vec2 along=faceSize.x>=faceSize.y?g:g.yx;
        float row=floor(along.y/.115);
        float pid=hash12(vec2(row,floor(along.x/1.3+row*.37)));
        float fibre=det(vec2(along.x*.32,along.y*3.9+pid*3.)).r;
        float rings=.5+.5*sin(along.y*41.+fibre*10.+pid*6.);
        float seam=1.-smoothstep(.003,.008+px*.5,min(fract(along.y/.115),1.-fract(along.y/.115))*.115);
        vec3 timber=tint*(.74+pid*.32)*(.84+rings*.2)*(.92+det(along*1.7).a*.16);
        albedo=mix(timber,timber*.32,seam);
        rough=.74+fibre*.12;
        ao=1.-seam*.5;
        vec3 ty=an.y<.99?vec3(0.,1.,0.):vec3(0.,0.,1.);
        n=normalize(n+ty*(rings-.5)*.025*(1.-seam));
      }
    }
    surfH*=relief*(1.-smoothstep(.004,.03,px));
    vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
    if (relief>0. && px<.03 && !discEdge) {
      vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
      float area=dot(sdpx,r1);
      n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
    }
  }

  // Liquid ink on paintable outdoor floors, roads, markings, and stairs.
  float inked=0.;
  if ((kind==1 || kind==5 || kind==15 || kind==22) && ng.y>.48 && (kind==15 || vPos.y>-.055) &&
      xz.x>=uInkActiveBox.x && xz.x<=uInkActiveBox.y && xz.y>=uInkActiveBox.z && xz.y<=uInkActiveBox.w) {
    vec2 inkUV=(xz/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      float fLayer=float(lowMeta);
      vec4 inkProbe=texture(uInk,vec3(inkUV,fLayer));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid);
        part=part*part*(3.-2.*part);
        float clearance=kind==15 || lowMeta==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        vec4 a=filmCell(pixel,size,lowMeta,vPos.y,clearance);
        vec4 b=filmCell(pixel+ivec2(1,0),size,lowMeta,vPos.y,clearance);
        vec4 c=filmCell(pixel+ivec2(0,1),size,lowMeta,vPos.y,clearance);
        vec4 d=filmCell(pixel+ivec2(1,1),size,lowMeta,vPos.y,clearance);
        vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=det(xz*.83);
          float thr=.5+(iDet.r*.6+iDet.a*.4-.5)*.38;
          float aa=max(px*.85,.015);
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            // Glossy liquid ink meniscus rim + Beer-Lambert optical saturation depth
            float meniscus=smoothstep(.03,.38,mask)*(1.-smoothstep(.38,.88,mask));
            vec3 teamInk=(st.r>=st.g?cyan:amber)*mix(1.05,.84,thick);
            teamInk=max(mix(vec3(lum(teamInk)),teamInk,1.+thick*.18),vec3(0.));
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            vec3 coord=vec3(inkUV,fLayer);
            float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 liquid=-vec2(e0-thick,s0-thick)*(1.62+meniscus*.88);
            if (isFull) {
              vec4 wDet=det(xz*1.7+vec2(uClock*.02,0.));
              liquid+=vec2(wDet.r-.5,wDet.b-.5)*.05+vec2(smoothstep(.07,.02,wDet.g)*.15*(1.-thick));
              ao=mix(ao,1.,mask*.6);
            }
            clear=max(clear,mix(.36,.70,bossMask)*mask+meniscus*.42);
            albedo=mix(albedo,ink,mask);
            rough=mix(rough,mix(.15,.055,bossMask)+length(liquid)*.16,mask);
            metal=mix(metal,0.,mask);
            emit=mix(emit,mix(ink*.05,vec3(.042,.006,.014),bossMask),mask);
            f0Base=mix(f0Base,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
            inked=mask;
          }
        }
      }
    }
  }

  // Exact street wetness parity with physical capillary shoreline halo & water IOR.
  if (!isFull && kind!=22) {
    float wetEnv=max(uWetLevel,uBossRage*.58);
    if (wetEnv>.002 && ng.y>.42 && kind!=0 && kind!=9) {
      float pNoise=det(uvW*.17+vec2(.13,.41)).r+.26*wetEnv;
      float puddle=smoothstep(.44,.76,pNoise)*wetEnv;
      float dampHalo=smoothstep(.28,.50,pNoise)*(1.-puddle)*wetEnv;
      albedo=mix(albedo,albedo*.60,sat(puddle*.70+dampHalo*.42));
      rough=mix(rough,mix(.12,.042,clamp(uRaytrace+puddle*.4,0.,1.)),puddle*(kind==1?.88:.58));
      f0Base=mix(f0Base,.024,puddle*.65);
      clear=max(clear,puddle*.42);
    }
  } else if (uWetLevel>.02 || uRaytrace>.5) {
    float upWet=smoothstep(.65,.95,ng.y)*sat(1.-inked);
    if (upWet>.002) {
      float pNoise=det(xz*.11).r;
      float puddle=smoothstep(.42,.66,pNoise);
      float dampHalo=smoothstep(.28,.48,pNoise)*(1.-puddle);
      float wetAmt=sat(uWetLevel*upWet*(.45+.55*puddle)+(uRaytrace>.5?upWet*puddle*.22:0.));
      rough=mix(rough,.058,wetAmt);
      clear=max(clear,wetAmt*.60);
      f0Base=mix(f0Base,.024,wetAmt*puddle*.7);
      albedo=mix(albedo,albedo*.70,sat(wetAmt*.66+uWetLevel*upWet*dampHalo*.34));
    }
  }

  // Physically based outdoor lighting with Kulla-Conty multi-scattering energy conservation.
  float nv=max(dot(n,V),1e-4), nl=dot(n,uSun);
  vec3 R=reflect(-V,n), direct=vec3(0.);
  vec3 f0=mix(vec3(f0Base),albedo,metal);
  vec3 diffC=albedo*(1.-metal);
  vec2 brdfAB=envBRDF_AB(rough,nv);
  float Ess=brdfAB.x+brdfAB.y, Ems=max(1.-Ess,0.);
  vec3 FssEss=f0*brdfAB.x+brdfAB.y;
  vec3 Favg=f0+(1.-f0)*.047619;
  vec3 FmsEms=(FssEss*Favg/(1.-Favg*Ems))*Ems;
  if (nl>.001 || trans>0.) {
    float sh=sunShadow(vPos,ng);
    if (sh>.001) {
      vec3 sun=uSunColor*sh;
      float wrap=trans>0.?sat((nl+.4)/1.4):nl;
      direct=diffC*(1./PI)*sun*wrap;
      if (nl>.001) {
        vec3 h=normalize(uSun+V);
        float nh=max(dot(n,h),0.), vh5=pow5(1.-max(dot(V,h),0.));
        float mr=max(rough,.03), a=max(mr*mr,.0016);
        vec3 F=f0+(1.-f0)*vh5;
        vec3 msDirect=1.+f0*(1./max(Ess,.15)-1.);
        direct+=sun*(ggxD(nh,a)*visSmith(nv,nl,a)*F*msDirect*nl);
        if (clear>0.) {
          float ac=.0025;
          direct+=sun*(ggxD(nh,ac)*visSmith(nv,nl,ac)*(.04+.96*vh5)*nl*clear);
        }
      }
      if (trans>0.) direct+=diffC*trans*sun*pow(sat(dot(-V,uSun)),3.)*.9*sat(1.-nl);
    }
  }
  vec3 irr=shDiffuse(n)+vec3(.36,.34,.30)*(sat(-n.y)*.2);
  if (uBossRage>.005) irr=mix(irr,irr*vec3(1.12,.52,.58)+vec3(.04,.005,.01),uBossRage*.55);
  float so=ao>=.999?1.:sat(pow(nv+ao,exp2(-16.*rough-1.))-1.+ao);
  vec3 ambient;
  if (rough>.72 && metal<.01 && clear<=0.) {
    vec3 spec=(R.y<0.?mix(1.,.55,sat(-R.y*4.)):1.)*(FssEss+FmsEms)*so;
    ambient=irr*(diffC*ao+spec);
  } else {
    vec3 spec=(rough>.72 && metal<.01)?irr:envSpec(R,rough);
    if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
    bool hasPlanar=isFull && uReflectOn && ng.y>.49 && abs(vPos.y)<.08;
    bool usedPlanar=false;
    vec3 planar=vec3(0.);
    if (hasPlanar && rough<.45) {
      planar=texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.035).rgb;
      usedPlanar=true;
      float w=(1.-smoothstep(.08,.40,rough))*mix(1.,.55,inked);
      spec=mix(spec,planar,w);
    }
    ambient=diffC*irr*ao+(spec*FssEss+irr*FmsEms)*so;
    if (clear>0.) {
      vec3 cspec=hasPlanar?(usedPlanar?planar:texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.02).rgb):envSpec(R,.05);
      ambient+=cspec*(.04+.96*pow5(1.-nv))*clear*so;
    }
  }
  if (sheen>0.) {float s1=1.-nv, s2=s1*s1; ambient+=albedo*sheen*(s2*s2)*irr*.9;}
  vec3 col=direct+ambient+emit;

  float dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
  float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
  if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
  if (fogAmt>.002) col=mix(col,aerialFog(dir),fogAmt);
  frag=vec4(col,sat(lum(ambient)/(lum(col)+1e-4))*(1.-fogAmt));
}`;

// Fullscreen ray-interpolating vertex shader: eliminates per-pixel uInvVP mat4 multiplies
// by reconstructing exact world positions via uEye + vRay * (uDepthAB.x / (uDepthAB.y - rawD)).
export const DEFERRED_RAY_VERTEX=`#version 300 es
precision highp float;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec2 uField;
out vec2 vUV;
out vec3 vRay;
void main(){
  vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));
  vUV=p;
  vec2 s=p*2.-1.;
  vRay=uForward+uRight*(s.x*uField.x)+uUp*(s.y*uField.y);
  gl_Position=vec4(s,1.,1.);
}`;

// Stencil-dispatched (stencil==1) ultra-lean Deferred Outdoor Arch PBR shader (~81% of screen).
// Supports #define NO_SURFACES 1 when procedural mode is active to strip all SurfaceTable/dFdx/dFdy code.
export const DEFERRED_ARCH_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
in vec2 vUV;
in vec3 vRay;
uniform highp sampler2D uGDepth;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform vec2 uDepthAB;
uniform vec3 uEye;
uniform float uPixelStep;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM0;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2DArray uInk;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform sampler2D uDetail;
uniform vec4 uFogParams;
uniform float uRaytrace;
uniform float uWetLevel;
uniform float uBossRage;
uniform float uRainLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;
#ifndef NO_SURFACES
${SURFACE_HIGH}
#endif
vec4 det(vec2 p){return texture(uDetail,p);}
vec3 envSpec(vec3 r,float rough){return envDecode(textureLod(uEnv,envUV(r),clamp(sqrt(rough)*uEnvLod,0.,uEnvLod)));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 specGGX(vec3 n,vec3 v,vec3 l,vec3 f0,float rough,float nv,float nl){
  vec3 h=normalize(l+v);
  float nh=max(dot(n,h),0.), a=max(rough*rough,.0016);
  vec3 F=f0+(1.-f0)*pow5(1.-max(dot(v,h),0.));
  return ggxD(nh,a)*visSmith(nv,nl,a)*F*nl;
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
  int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
  vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(texel*1.22);
  return (texture(s,vec3(c.xy+d,c.z))+texture(s,vec3(c.xy-d,c.z)))*.5;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
  float slope=1.-sat(dot(ng,uSun));
  vec3 c0=(uShadowM0*vec4(p+ng*uShadowTexel.z*(1.2+slope*1.6),1.)).xyz;
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y);
  float s0=1.;
  if (inner>0. && c0.z<1.) s0=shadowTap(uShadow0,vec3(c0.xy,c0.z-.00022),uShadowTexel.x);
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope*1.6),1.)).xyz;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}
void main(){
  ivec2 ipx=ivec2(gl_FragCoord.xy);
  float rawD=texelFetch(uGDepth,ipx,0).r;
  float zView=uDepthAB.x/(uDepthAB.y-rawD);
  vec3 vPos=uEye+vRay*zView;
  float invRL=inversesqrt(dot(vRay,vRay));
  float dist=zView/invRL;
  vec3 dir=vRay*invRL;
  vec3 V=-dir;
  vec4 g0=texelFetch(uG0,ipx,0);
  vec4 g1=texelFetch(uG1,ipx,0);
  int kind=int(g0.a*255.+.5);
  vec3 ng=octDec(g1.rg);
  vec3 tint=toLinear(g0.rgb);
  vec3 an=abs(ng);
  vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
#ifdef NO_SURFACES
  float px=dist*uPixelStep;
#else
  vec3 sdpxRaw=dFdx(vPos), sdpyRaw=dFdy(vPos);
  float maxStep=max(dist*uPixelStep*5.,0.008), maxStep2=maxStep*maxStep;
  float ldx2=dot(sdpxRaw,sdpxRaw), ldy2=dot(sdpyRaw,sdpyRaw);
  bool discEdge=(ldx2>maxStep2 || ldy2>maxStep2);
  vec3 sdpx=ldx2>maxStep2?sdpxRaw*(maxStep*inversesqrt(ldx2)):sdpxRaw;
  vec3 sdpy=ldy2>maxStep2?sdpyRaw*(maxStep*inversesqrt(ldy2)):sdpyRaw;
  float px=max(length(sdpx),length(sdpy));
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy);
  vec2 sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  int slot=uSurfaceSheets>0?(int(g1.b*255.+.5)-1):-1;
  bool real=surfaceReady(slot);
#endif
  if (kind==3) {
    vec3 col=tint*3.2;
#ifndef NO_SURFACES
    if (real) {
      vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
      col*=mix(vec3(1.),toLinear(stex.rgb)/max(toLinear(surfaceMean(slot)),vec3(.05)),.75);
    }
#endif
    float dy=vPos.y-uEye.y;
    float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
    float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
    if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
    if (fogAmt>.002) {
      vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
      vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
      col=mix(col,fogCol,fogAmt);
    }
    frag=vec4(col,0.);
    return;
  }
  bool vertical=an.y<.45;
  float wallBase=vertical && vPos.y<1.65 && (kind==2 || kind==4 || kind==13 || kind==19)?
    1.-smoothstep(0.,.95+det(uvW*.043).r*.6,vPos.y):0.;
  vec3 albedo=tint, emit=vec3(0.), n=ng;
  float rough=.86, metal=0., f0Base=.04, clear=0., sheen=0., trans=0.;
#ifndef NO_SURFACES
  float surfH=0., relief=0.;
#endif
  if (kind==1) {
    float oil=smoothstep(.62,.8,det(uvW*.09+.7).r)*.18;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH)*(1.-oil); relief=1.;}
    else
#endif
    albedo=tint*(.92+(det(uvW*.31).r-.5)*.14)*(1.-oil);
    rough=.82-oil*.25;
  } else if (kind==4) {
    vec4 d2=det(uvW*3.1);
    float sat0=max(max(tint.r,tint.g),tint.b)-min(min(tint.r,tint.g),tint.b);
    float galvanized=step(sat0,.035)*step(.12,lum(tint));
    metal=galvanized;
    vec3 baseCol=mix(tint,vec3(.56,.57,.58)*(.85+d2.g*.3),galvanized*.8);
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,baseCol,1.,.004,surfH); relief=1.;}
    else
#endif
    albedo=baseCol*(.94+(d2.r-.5)*.12);
    rough=mix(.38+d2.r*.14,.34+d2.g*.2,galvanized);
    albedo=mix(albedo,albedo*.6,wallBase*.4*float(vertical));
  } else if (kind==2 || kind==19) {
#ifndef NO_SURFACES
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH); relief=1.;
      albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55*float(vertical)); rough=.88;
    } else
#endif
    {
      float g=det(uvW*.29).r;
      albedo=tint*(.92+(g-.5)*.16);
      if (vertical) albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55);
    }
  } else if (kind==20) {
    clear=.75;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,.6,.002,surfH); rough=.33; relief=.4;}
    else
#endif
    {float peel=det(uvW*9.).r; albedo=tint*(.97+peel*.04); rough=.30+peel*.06;}
  } else if (kind==21) {
    sheen=.18; f0Base=.035;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.003,surfH); rough=.72; relief=.5;}
    else
#endif
    {vec4 d2=det(uvW*4.); albedo=tint*(.9+d2.r*.14)+vec3(.012)*sat(ng.y); rough=.68+d2.a*.1;}
  } else if (kind==18 || kind==30 || kind==31) {
    rough=.88; sheen=.55; f0Base=.03;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.003,surfH); relief=.5;}
    else
#endif
    albedo=tint*(.9+det(uvW*2.).r*.12);
  } else if (kind==9) {
    albedo=tint*.92; rough=.07; clear=1.; trans=.35; emit=tint*.22;
  } else if (kind==0) {
    vec4 d2=det(uvW*2.3);
    float worn=an.y>.6?smoothstep(.55,.75,det(uvW*.6).r*.6+d2.r*.5):0.;
    albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
    rough=.62+worn*.2;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,.7,.003,surfH); relief=.5;}
#endif
  } else if (kind==13) {
#ifndef NO_SURFACES
    if (real) {
      albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.012,surfH); relief=1.;
      bool nat=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
      if (!nat) albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
      rough=nat?.9:.78;
    } else
#endif
    {
      vec2 bricks=uvW/vec2(.69,.296);
      bricks.x+=mod(floor(bricks.y),2.)*.5;
      vec2 b=fract(bricks), id=floor(bricks);
      vec2 jd=min(b,1.-b)*vec2(.69,.296);
      float mortar=1.-smoothstep(.006,.016+px*.5,min(jd.x,jd.y));
      albedo=mix(tint*(.84+hash12(id)*.24),vec3(.52,.50,.46),mortar*.85);
      albedo=mix(albedo,albedo*.66,wallBase*.6*float(vertical));
      rough=mix(.78,.92,mortar);
    }
  } else {
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH); relief=1.; rough=.78;}
    else
#endif
    {
      float g=det(uvW*.29).r;
      albedo=tint*(.92+(g-.5)*.16);
      if (vertical) albedo=mix(albedo,albedo*vec3(.62,.60,.52),wallBase*.55);
    }
  }
#ifndef NO_SURFACES
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0. && px<.03 && !discEdge) {
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float area=dot(sdpx,r1);
    n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
  }
#endif
  if (kind==1 && ng.y>.48 && vPos.y>-.055) {
    vec2 inkUV=(vPos.xz/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      int lowMeta=int(g1.a*255.+.5)&15;
      float fLayer=float(lowMeta);
      vec4 inkProbe=texture(uInk,vec3(inkUV,fLayer));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid);
        part=part*part*(3.-2.*part);
        float clearance=lowMeta==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        vec4 a=filmCell(pixel,size,lowMeta,vPos.y,clearance);
        vec4 b=filmCell(pixel+ivec2(1,0),size,lowMeta,vPos.y,clearance);
        vec4 c=filmCell(pixel+ivec2(0,1),size,lowMeta,vPos.y,clearance);
        vec4 d=filmCell(pixel+ivec2(1,1),size,lowMeta,vPos.y,clearance);
        vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=det(vPos.xz*.83);
          float thr=.5+(iDet.r*.6+iDet.a*.4-.5)*.38;
          float aa=max(px*.85,.015);
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            vec3 teamInk=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            vec3 coord=vec3(inkUV,fLayer);
            float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 liquid=-vec2(e0-thick,s0-thick)*1.62;
            albedo=mix(albedo,ink,mask);
            rough=mix(rough,mix(.21,.065,bossMask)+length(liquid)*.18,mask);
            metal=mix(metal,0.,mask);
            emit=mix(emit,mix(ink*.05,vec3(.042,.006,.014),bossMask),mask);
            f0Base=mix(f0Base,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
          }
        }
      }
    }
  }
  float wetEnv=max(uWetLevel,uBossRage*.58);
  if (wetEnv>.002 && ng.y>.42 && kind!=0 && kind!=9) {
    float pNoise=det(uvW*.17+vec2(.13,.41)).r;
    float puddle=smoothstep(.44,.76,pNoise+.26*wetEnv)*wetEnv;
    albedo=mix(albedo,albedo*.62,puddle*.68);
    rough=mix(rough,mix(.14,.045,clamp(uRaytrace+puddle*.4,0.,1.)),puddle*(kind==1?.86:.56));
    f0Base=mix(f0Base,.055,puddle*.65);
  }
  float nv=max(dot(n,V),1e-4), nl=dot(n,uSun);
  vec3 R=reflect(-V,n), direct=vec3(0.);
  vec3 f0=mix(vec3(f0Base),albedo,metal);
  vec3 diffC=albedo*(1.-metal);
  if (nl>.001 || trans>0.) {
    float sh=sunShadow(vPos,ng);
    if (sh>.001) {
      vec3 sun=uSunColor*sh;
      float wrap=trans>0.?sat((nl+.4)/1.4):nl;
      direct=diffC*(1./PI)*sun*wrap;
      if (nl>.001) {
        direct+=sun*specGGX(n,V,uSun,f0,max(rough,.03),nv,nl);
        if (clear>0.) direct+=sun*specGGX(n,V,uSun,vec3(.04),.05,nv,nl)*clear;
      }
      if (trans>0.) direct+=diffC*trans*sun*pow(sat(dot(-V,uSun)),3.)*.9*sat(1.-nl);
    }
  }
  vec3 irr=shDiffuse(n)+vec3(.36,.34,.30)*(sat(-n.y)*.2);
  if (uBossRage>.005) irr=mix(irr,irr*vec3(1.12,.52,.58)+vec3(.04,.005,.01),uBossRage*.55);
  vec3 spec=(rough>.72 && metal<.01)?irr:envSpec(R,rough);
  if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
  vec3 ambient=diffC*irr+spec*envBRDF(f0,rough,nv);
  if (clear>0.) ambient+=envSpec(R,.05)*(.04+.96*pow5(1.-nv))*clear;
  if (sheen>0.) {float s1=1.-nv, s2=s1*s1; ambient+=albedo*sheen*(s2*s2)*irr*.9;}
  vec3 col=direct+ambient+emit;
  float dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
  float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
  if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
    col=mix(col,fogCol,fogAmt);
  }
  frag=vec4(col,sat(lum(ambient)/(lum(col)+1e-4))*(1.-fogAmt));
}`;

// Stencil-dispatched (stencil==2) Deferred Outdoor Full PBR shader (~19% of screen: roads, facades, windows, wood, boss).
export const DEFERRED_FULL_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
in vec2 vUV;
in vec3 vRay;
uniform highp sampler2D uGDepth;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform highp sampler2D uG2;
uniform vec2 uDepthAB;
uniform vec3 uEye;
uniform float uPixelStep;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM0;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2DArray uInk;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform sampler2D uDetail;
uniform sampler2D uReflection;
uniform bool uReflectOn;
uniform vec2 uViewport;
uniform float uClock;
uniform vec4 uFogParams;
uniform float uRaytrace;
uniform float uWetLevel;
uniform float uBossRage;
uniform float uRainLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;
#ifndef NO_SURFACES
${SURFACE_HIGH}
#endif
vec4 det(vec2 p){return texture(uDetail,p);}
vec3 envSpec(vec3 r,float rough){return envDecode(textureLod(uEnv,envUV(r),clamp(sqrt(rough)*uEnvLod,0.,uEnvLod)));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 specGGX(vec3 n,vec3 v,vec3 l,vec3 f0,float rough,float nv,float nl){
  vec3 h=normalize(l+v);
  float nh=max(dot(n,h),0.), a=max(rough*rough,.0016);
  vec3 F=f0+(1.-f0)*pow5(1.-max(dot(v,h),0.));
  return ggxD(nh,a)*visSmith(nv,nl,a)*F*nl;
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
  int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
  vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(texel*1.22);
  return (texture(s,vec3(c.xy+d,c.z))+texture(s,vec3(c.xy-d,c.z)))*.5;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
  float slope=1.-sat(dot(ng,uSun));
  vec3 c0=(uShadowM0*vec4(p+ng*uShadowTexel.z*(1.2+slope*1.6),1.)).xyz;
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y);
  float s0=1.;
  if (inner>0. && c0.z<1.) s0=shadowTap(uShadow0,vec3(c0.xy,c0.z-.00022),uShadowTexel.x);
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope*1.6),1.)).xyz;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}
vec3 roomBehind(vec2 uv,vec3 viewT,float seed,float lightOn,float depth,float px){
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
  vec3 col=wallC*mix(.74,.9,backHit);
  col=mix(col,vec3(.22,.18,.15)*(1.+seed*.4),floorHit);
  col=mix(col,vec3(.72,.71,.66),ceilHit);
  float furniture=backHit*step(abs(hit.x+.18-seed*.3),.22)*step(hit.y,-.12);
  col=mix(col,vec3(.18,.17,.16),furniture*.85);
#ifndef NO_SURFACES
  if (uSurfaceSheets>0 && px<.045) {
    float texels=.5/uSurfaceEdge.x, metres=1.5;
    int floorSlot=seed<.33?S_TATAMI:seed<.66?S_WOOD_FLOORING:S_CARPET_TILE;
    int wallSlot=fract(seed*7.31)<.5?S_VINYL_WALLPAPER:S_GYPSUM_PAINTED;
    if (floorHit>.5 && surfaceReady(floorSlot)) {
      float lod=log2(max(px*2.5*texels/S_METERS[floorSlot],1.));
      vec3 c=toLinear(surfaceLod(floorSlot,hit.xz*metres,lod).rgb);
      col=c*(.9+seed*.2);
    } else if (ceilHit<.5 && surfaceReady(wallSlot)) {
      float lod=log2(max(px*2.*texels/S_METERS[wallSlot],1.));
      vec2 wp=(backHit>.5?hit.xy:vec2(hit.z,hit.y))*metres;
      vec3 c=toLinear(surfaceLod(wallSlot,wp,lod).rgb);
      col*=c/max(toLinear(surfaceMean(wallSlot)),vec3(.02));
    }
  }
#endif
  float shelf=backHit*step(.18,hit.x)*step(hit.x,.42)*step(abs(fract(hit.y*3.)-.5),.06);
  col=mix(col,vec3(.30,.26,.21),shelf);
  float lamp=ceilHit*smoothstep(.16,.05,length(hit.xz-vec2(0.,.4*depth)));
  vec3 light=mix(vec3(.30,.32,.33),vec3(1.,.82,.58)*1.6,lightOn);
  return col*light+vec3(1.,.86,.62)*lamp*lightOn*4.;
}
void main(){
  ivec2 ipx=ivec2(gl_FragCoord.xy);
  float rawD=texelFetch(uGDepth,ipx,0).r;
  float zView=uDepthAB.x/(uDepthAB.y-rawD);
  vec3 vPos=uEye+vRay*zView;
  vec3 sdpxRaw=dFdx(vPos), sdpyRaw=dFdy(vPos);
  float invRL=inversesqrt(dot(vRay,vRay));
  float dist=zView/invRL;
  vec3 dir=vRay*invRL;
  vec3 V=-dir;
  vec4 g0=texelFetch(uG0,ipx,0);
  vec4 g1=texelFetch(uG1,ipx,0);
  int kind=int(g0.a*255.+.5);
  vec3 ng=octDec(g1.rg);
  int lowMeta=int(g1.a*255.+.5)&15;
  vec3 tint=toLinear(g0.rgb);
  vec3 an=abs(ng);
  vec2 xz=vPos.xz;
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
  float maxStep=max(dist*uPixelStep*5.,0.008), maxStep2=maxStep*maxStep;
  float ldx2=dot(sdpxRaw,sdpxRaw), ldy2=dot(sdpyRaw,sdpyRaw);
  bool discEdge=(ldx2>maxStep2 || ldy2>maxStep2);
  vec3 sdpx=ldx2>maxStep2?sdpxRaw*(maxStep*inversesqrt(ldx2)):sdpxRaw;
  vec3 sdpy=ldy2>maxStep2?sdpyRaw*(maxStep*inversesqrt(ldy2)):sdpyRaw;
  float px=max(length(sdpx),length(sdpy));
#ifndef NO_SURFACES
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy);
  vec2 sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  int slot=uSurfaceSheets>0?(int(g1.b*255.+.5)-1):-1;
  bool real=surfaceReady(slot);
#endif
  if (kind==25) {
    vec2 uv2=texelFetch(uG2,ipx,0).xy;
    float rim=pow(1.-max(0.,dot(ng,V)),2.5);
    float veins=sin(uv2.x*32.+uv2.y*21.-uClock*19.+det(uv2*1.3).r*9.);
    float streak=smoothstep(.42,.96,veins)*.55+rim*.46;
    vec3 liquid=tint*(1.2+.5*max(dot(ng,uSun),0.)+.25*veins);
    vec3 col=mix(liquid,vec3(2.6,2.3,2.6),sat(streak))*1.4;
    frag=vec4(col,0.);
    return;
  }
  bool vertical=an.y<.45;
  float wallBase=vertical && vPos.y<1.65 && (kind==10 || kind==13)?
    1.-smoothstep(0.,.95+det(uvW*.043).r*.6,vPos.y):0.;
  vec3 albedo=tint, emit=vec3(0.), n=ng;
  float rough=.6, metal=0., ao=1., f0Base=.04, clear=0., surfH=0., relief=0.;
  if (kind==5) {
    vec4 d1=det(uvW*.23);
    float crackZone=smoothstep(.58,.70,det(uvW*.031+.4).r);
    float tar=crackZone>.005?smoothstep(.84,.97,det(uvW*.083+.2).b)*crackZone*.85:0.;
    float puddle=smoothstep(.56,.70,det(xz*.045+.11).r*.75+d1.r*.35);
    float wet=sat(puddle*1.6);
    vec3 asphalt;
#ifndef NO_SURFACES
    if (real) {
      vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
      float h1=0., h2=0., aged=smoothstep(.38,.62,sfNoise(xz*.026+1.7));
      vec3 fresh=realSurface(stex,S_ASPHALT,tint*.70,1.,.008,h1), old=fresh;
      if (aged>.01 && surfaceReady(S_ASPHALT_WORN)) old=realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(9.,23.),sdx,sdy),S_ASPHALT_WORN,tint*.70,1.,.008,h2);
      else h2=h1;
      asphalt=mix(fresh,old,aged);
      surfH=mix(h1,h2,aged);
      relief=1.-wet;
      rough=mix(.82,.06,puddle);
    } else
#endif
    {
      vec4 d2=det(uvW*1.9), d3=det(uvW*7.1);
      float stones=smoothstep(.30,.08,d3.g), patchy=smoothstep(.45,.62,d1.r);
      asphalt=tint*.70*(.86+(d2.r-.5)*.24+stones*.32+(d3.a-.5)*.18)*mix(1.,.86,patchy);
      rough=mix(.86-stones*.12,.06,puddle);
      surfH=-d3.g*.0045;
      relief=1.-wet;
    }
    asphalt=mix(asphalt,vec3(.018,.019,.02),tar);
    albedo=asphalt*mix(1.,.45,wet);
    ao=1.-tar*.3;
    if (puddle>.01) {
      float rip=sin(xz.x*5.1+xz.y*2.3+uClock*1.3)*sin(xz.y*4.7-xz.x*1.1-uClock*1.1);
      n=normalize(mix(n,vec3(rip*.02,1.,rip*.015),puddle));
    }
  } else if (kind==10) {
    vec4 g2=texelFetch(uG2,ipx,0);
    vec2 fp=g2.xy, fsz=g2.zw;
    if (an.y>.55) {
      albedo=tint*.66; rough=.9;
#ifndef NO_SURFACES
      if (uSurfaceSheets>0 && surfaceReady(S_ROOF_MEMBRANE)) {
        albedo=realSurface(surfaceTap(S_ROOF_MEMBRANE,uvW,sdx,sdy),S_ROOF_MEMBRANE,tint*.66,1.,.01,surfH);
        relief=1.;
      }
#endif
    } else {
      vec2 rs=vec2(max(1.,floor(fsz.x/6.+.5))/fsz.x,1./5.84);
      float parapet=step(fsz.y-1.05,fp.y);
#ifndef NO_SURFACES
      if (real) {
        vec3 tx=an.y<.99?normalize(cross(vec3(0.,1.,0.),ng)):vec3(1.,0.,0.);
        vec2 fdx=vec2(dot(sdpx,tx),sdpx.y), fdy=vec2(dot(sdpy,tx),sdpy.y);
        float seed=float(lowMeta)/15.;
        float cell=hash12(floor(fp*rs*vec2(1.,2.))+seed*13.);
        vec4 t=surfaceTap(slot,fp*rs,fdx*rs,fdy*rs);
        vec3 c=realSurface(t,slot,tint,1.,0.,surfH)*(.96+cell*.08);
        float glass=smoothstep(.02,.07,t.b-t.r)*smoothstep(.62,.3,t.b)*(1.-parapet);
        albedo=mix(c,tint*.86,parapet);
        rough=mix(.82,.1,glass);
        f0Base=mix(.04,.06,glass);
      } else
#endif
      {
        float storey=fract(fp.y/2.92);
        float win=step(.25,storey)*step(storey,.8)*step(.12,fract(fp.x*rs.x*2.))*step(fract(fp.x*rs.x*2.),.88);
        albedo=mix(tint*.92,vec3(.05,.06,.07),win*(1.-parapet));
        rough=mix(.85,.12,win);
      }
      albedo=mix(albedo,albedo*vec3(.72,.70,.64),wallBase*.5);
    }
  } else if (kind==8 || kind==6) {
    vec4 g2=texelFetch(uG2,ipx,0);
    vec2 fp=g2.xy, faceSize=g2.zw;
    bool windowPane=kind==8 && vertical && min(faceSize.x,faceSize.y)>.55 && max(faceSize.x,faceSize.y)>.9 && lowMeta==1;
    if (kind==6 && !vertical) {
      float rip=sin(xz.x*4.3+xz.y*1.9+uClock*.9)*sin(xz.y*4.7-xz.x*.9-uClock*.82);
      n=normalize(vec3(rip*.05,1.,cos(xz.x*2.7+xz.y*1.8+uClock*.8)*.04));
      albedo=tint*.25; rough=.04; f0Base=.02;
    } else {
      float dirt=det(uvW*.8).r;
      albedo=tint*.05; rough=.02+dirt*.05; f0Base=.045;
#ifndef NO_SURFACES
      if (real) {
        vec4 stex=surfaceTap(slot,uvW,sdx,sdy);
        float smear=sfLum(stex.rgb);
        rough=mix(rough,.38,smear*.55);
        albedo=mix(albedo,toLinear(stex.rgb)*.3,smear*.22);
      }
#endif
      vec3 tx=an.y<.99?normalize(cross(vec3(0.,1.,0.),ng)):vec3(1.,0.,0.);
      vec3 ty=vec3(0.,1.,0.);
      if (lowMeta==1 && vertical && max(faceSize.x,faceSize.y)>2.6) {
        vec2 paneSz=vec2(faceSize.x/max(1.,floor(faceSize.x/1.5)),faceSize.y/max(1.,floor(faceSize.y/1.7)));
        vec2 pg=fp/paneSz, pc=fract(pg), pid=floor(pg);
        float fr=1.-smoothstep(.025,.045,min(min(pc.x,1.-pc.x)*paneSz.x,min(pc.y,1.-pc.y)*paneSz.y));
        n=normalize(n+(tx*(hash12(pid)-.5)+ty*(hash12(pid+3.)-.5))*.035);
        albedo=mix(albedo,vec3(.05,.055,.06),fr);
        rough=mix(rough+hash12(pid+7.)*.05,.45,fr);
        f0Base=mix(f0Base,.04,fr);
      }
      if (windowPane || kind==6) {
        vec3 vt=vec3(dot(-V,tx),dot(-V,ty),dot(V,n));
        vec2 cellSz=kind==6?vec2(1.6,2.7):faceSize;
        vec2 uv=fp/cellSz;
        vec2 rid=floor(uv)+floor(vPos.xz*.1);
        float seed=hash12(rid+floor(vPos.y/3.));
        float on=step(.62,hash12(rid*1.7+3.))*.35;
#ifdef SAFE
        vec3 room=vec3(.2,.21,.2)*(.7+seed*.5);
#else
        vec3 room=(px<.12 && dist<65.)?roomBehind(fract(uv),vt,seed,on,kind==6?2.2:1.6,px):mix(vec3(.22,.23,.24),vec3(.62,.52,.38),on)*(.75+seed*.45);
#endif
        float fres=.04+.96*pow5(1.-max(dot(n,V),0.));
        emit=room*(1.-fres)*(kind==6?.22:.34)*(1.-dirt*.3);
        f0Base=kind==6?.07:f0Base;
        float blind=kind==6?step(.7,seed)*smoothstep(.0,.02,fract(uv.y)-.6):0.;
        emit*=1.-blind*.7;
        albedo=mix(albedo,vec3(.62,.6,.55),blind);
#if !defined(SAFE) && !defined(NO_SURFACES)
        if (kind==6 && uSurfaceSheets>0) {
          if (blind>0. && surfaceReady(S_WINDOW_BLINDS)) albedo=mix(albedo,toLinear(surfaceTap(S_WINDOW_BLINDS,uvW,sdx,sdy).rgb)*.85,blind);
          float reed=step(.47,seed)*step(seed,.55);
          if (reed>0. && surfaceReady(S_SUDARE)) {albedo=mix(albedo,toLinear(surfaceTap(S_SUDARE,uvW,sdx,sdy).rgb)*.8,.88); emit*=.3; f0Base=mix(f0Base,.03,.88);}
          float paper=step(.55,seed)*step(seed,.7);
          if (paper>0. && surfaceReady(S_SHOJI_PAPER)) {vec3 shoji=toLinear(surfaceTap(S_SHOJI_PAPER,uvW,sdx,sdy).rgb); emit=shoji*mix(.16,.55,on)*(1.-fres); albedo=mix(albedo,shoji*.45,.5);}
        }
#endif
      }
    }
  } else if (kind==11) {
    if (an.y>.55) {
#ifndef NO_SURFACES
      if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint*.72,1.,.01,surfH); rough=.9; relief=1.;}
      else
#endif
      {vec4 d1=det(uvW*.4); albedo=tint*.72*(.85+d1.r*.25)*mix(1.,.8,smoothstep(.6,.8,det(uvW*.17+.31).r)); rough=.9;}
    } else {
      vec4 g2=texelFetch(uG2,ipx,0);
      vec2 fp=g2.xy, fsz=g2.zw;
      vec3 tx=an.y<.99?normalize(cross(vec3(0.,1.,0.),ng)):vec3(1.,0.,0.);
      vec2 fdx=vec2(dot(sdpx,tx),sdpx.y), fdy=vec2(dot(sdpy,tx),sdpy.y);
      float facade=fract(dot(g0.rgb,vec3(17.3,7.9,11.1)));
      bool curtain=facade>.72 && fsz.y>9.;
      bool ribbon=!curtain && facade>.46;
      vec2 cellSz=vec2(fsz.x/max(1.,floor(fsz.x/(curtain?1.6:2.2))),3.15);
      vec2 g=fp/cellSz, cell=fract(g), cid=floor(g);
      vec2 fw=(abs(fdx)+abs(fdy))/cellSz;
      vec2 lo=curtain?vec2(.035,.05):ribbon?vec2(.02,.30):vec2(.17,.24);
      vec2 hiE=curtain?vec2(.965,.95):ribbon?vec2(.98,.82):vec2(.83,.86);
      vec2 inW=smoothstep(lo-fw,lo+fw,cell)*(1.-smoothstep(hiE-fw,hiE+fw,cell));
      float win=inW.x*inW.y;
      float detailVis=1.-smoothstep(.10,.30,max(fw.x,fw.y));
      vec3 wall=tint;
      if (win<.995 && detailVis>.01) {
#ifndef NO_SURFACES
        if (real) {wall=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.008,surfH); relief=1.-win;}
        else
#endif
        wall=tint*(.9+(det(uvW*1.2).r-.5)*.14);
        if (detailVis>.25) {
          float under=smoothstep(lo.y,lo.y-.25,cell.y)*step(lo.x,cell.x)*step(cell.x,hiE.x);
          if (under>.005) wall*=1.-under*smoothstep(.4,.8,det(vec2(g.x*3.,g.y*.25)).r)*.32;
          float stain=det(uvW*.17+.31).r;
          wall=mix(wall,wall*.8,smoothstep(.55,.8,stain)*.5);
        }
        float sill=smoothstep(.035,.0,abs(cell.y-lo.y+.03))*step(lo.x-.03,cell.x)*step(cell.x,hiE.x+.03);
        wall=mix(wall,vec3(.75,.74,.70),sill*.6*detailVis);
      }
      albedo=wall; rough=.82;
      if (win>.002 && detailVis>.005) {
        vec3 vt=vec3(dot(-V,tx),-V.y,dot(V,n));
        vec2 recess=vt.xy/max(vt.z,.2)*.08/cellSz;
        vec2 wuv=(cell-lo)/(hiE-lo);
        vec2 rev=step(wuv,-recess*4.)+step(1.-recess*4.,wuv);
        float reveal=sat(max(rev.x,rev.y))*detailVis;
        float seed=hash12(cid+floor(vPos.xz*.37));
        float on=step(.7,hash12(cid*3.1+1.7));
#ifdef SAFE
        vec3 room=vec3(.18,.2,.21)*(.8+seed*.4);
#else
        vec3 room=(detailVis>.30 && dist<75.)?roomBehind(sat(wuv),vt,seed,on,1.4,px):mix(vec3(.22,.23,.24),vec3(.62,.52,.38),on)*(.75+seed*.45);
#endif
        float mull=1.-smoothstep(.006,.014,abs(wuv.x-.5));
        float pane=hash12(cid+.3);
        vec3 glassTint=curtain?mix(vec3(.025,.04,.05),vec3(.04,.05,.045),pane):vec3(.03);
        albedo=mix(wall,glassTint,win);
        rough=mix(.82,.03+pane*.04,win);
        f0Base=mix(.04,curtain?.11:.075,win);
        vec3 nWin=normalize(n+(tx*(pane-.5)+vec3(0.,1.,0.)*(hash12(cid+5.)-.5))*.02);
        n=normalize(mix(n,nWin,win));
        float fres=.04+.96*pow5(1.-max(dot(n,V),0.));
        emit=room*win*(1.-fres)*(1.-reveal)*.30*(1.-mull*.8);
        albedo=mix(albedo,vec3(.42,.43,.42),reveal*win+mull*win*detailVis);
        rough=mix(rough,.6,reveal*win);
        ao=1.-reveal*win*.5;
      }
      if (detailVis<.99) {
        vec3 far=mix(wall,vec3(.08,.1,.11),.45);
#ifndef NO_SURFACES
        float pick=fract(facade*7.3);
        int farSlot=curtain?(pick<.5?S_REFLECTIVE_GLASS:S_MIRROR_STAINLESS):
          ribbon || fsz.y>26.?S_FACADE_OFFICE_FAR:
          fsz.y<13. && vPos.y-fp.y<1. && pick<.6?S_FACADE_RETAIL_FAR:S_FACADE_APARTMENT_FAR;
        if (uSurfaceSheets>0 && surfaceReady(farSlot)) {
          float hf=0.;
          far=realSurface(surfaceTap(farSlot,fp,fdx,fdy),farSlot,tint,1.,0.,hf);
          float glassy=1.-smoothstep(.04,.16,lum(far));
          f0Base=mix(f0Base,curtain?.11:.06,(1.-detailVis)*(curtain?1.:glassy));
          rough=mix(rough,mix(.8,.08,curtain?1.:glassy),1.-detailVis);
        }
#endif
        albedo=mix(far,albedo,detailVis);
      }
    }
  } else if (kind==15) {
    vec4 g2=texelFetch(uG2,ipx,0);
    vec2 faceUV=g2.xy, faceSize=g2.zw;
    float nose=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)))*step(.6,an.y);
#ifndef NO_SURFACES
    if (real) {
      vec3 ground=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH);
      if (nose>.01 && surfaceReady(S_RUBBER_STAIR)) {
        float h5=0.;
        ground=mix(ground,realSurface(surfaceTap(S_RUBBER_STAIR,uvW,sdx,sdy),S_RUBBER_STAIR,vec3(.05),1.,.006,h5),nose);
      }
      albedo=ground; rough=mix(.82,.9,nose); relief=1.;
    } else
#endif
    {
      albedo=tint*(.92+(det(uvW*.31).r-.5)*.14)*mix(1.,.55,nose);
      rough=mix(.82,.9,nose);
    }
  } else if (kind==23) {
    vec2 uv2=texelFetch(uG2,ipx,0).xy;
    float rib=sin(uv2.y*85.+sin(uv2.x*37.7)*.86);
    float nacre=pow(1.-max(0.,dot(ng,V)),2.2);
    float pores=det(uv2*vec2(3.,2.)).g;
    vec3 interference=mix(vec3(.10,.22,.40),vec3(.53,.24,.38),.5+.5*sin(uv2.x*18.85+uv2.y*8.));
    albedo=mix(tint*(.85+pores*.22+rib*.07),toLinear(interference),.32*nacre);
    rough=.26+.08*pores; clear=.8; metal=.1;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTri(slot,vPos,ng,sdpx,sdpy),slot,albedo,.8,.006,surfH); relief=.5;}
#endif
  } else if (kind==29) {
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.012,surfH); rough=.78; relief=1.;}
    else
#endif
    {
      vec4 g2=texelFetch(uG2,ipx,0);
      vec2 g=g2.xy, faceSize=g2.zw;
      vec2 along=faceSize.x>=faceSize.y?g:g.yx;
      float row=floor(along.y/.115);
      float pid=hash12(vec2(row,floor(along.x/1.3+row*.37)));
      float fibre=det(vec2(along.x*.32,along.y*3.9+pid*3.)).r;
      float rings=.5+.5*sin(along.y*41.+fibre*10.+pid*6.);
      float seam=1.-smoothstep(.003,.008+px*.5,min(fract(along.y/.115),1.-fract(along.y/.115))*.115);
      vec3 timber=tint*(.74+pid*.32)*(.84+rings*.2)*(.92+det(along*1.7).a*.16);
      albedo=mix(timber,timber*.32,seam);
      rough=.74+fibre*.12;
      ao=1.-seam*.5;
      vec3 ty=an.y<.99?vec3(0.,1.,0.):vec3(0.,0.,1.);
      n=normalize(n+ty*(rings-.5)*.025*(1.-seam));
    }
  } else if (kind==13) {
#ifndef NO_SURFACES
    if (real) {
      vec4 stex=lowMeta==0?surfaceTri(slot,vPos,ng,sdpx,sdpy):surfaceTap(slot,uvW,sdx,sdy);
      bool nat=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
      vec3 b=realSurface(stex,slot,tint,1.,nat?.02:.012,surfH);
      if (!nat) b=mix(b,b*.66,wallBase*.6*float(vertical));
      albedo=b; rough=nat?.9:.78; relief=1.;
    } else
#endif
    {
      vec2 bricks=uvW/vec2(.69,.296);
      bricks.x+=mod(floor(bricks.y),2.)*.5;
      vec2 b=fract(bricks), id=floor(bricks);
      vec2 jd=min(b,1.-b)*vec2(.69,.296);
      float mortar=1.-smoothstep(.006,.016+px*.5,min(jd.x,jd.y));
      vec4 d2=det(uvW*1.7+id*.13);
      vec3 c=tint*(.84+hash12(id)*.24+(d2.r-.5)*.18)*mix(vec3(1.),vec3(1.04,.97,.92),hash12(id+7.)*.5);
      c=mix(c,vec3(.52,.50,.46)*(.9+d2.a*.2),mortar*.85);
      albedo=mix(c,c*.66,wallBase*.6*float(vertical));
      rough=mix(.74+d2.r*.12,.92,mortar);
      ao=1.-mortar*.45;
    }
  } else if (kind==26) {
    albedo=tint*.95; rough=.09; clear=.9; emit=tint*.05;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,.35,.002,surfH); relief=.3;}
#endif
  }
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0. && px<.03 && !discEdge) {
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float area=dot(sdpx,r1);
    n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
  }
  float inked=0.;
  if ((kind==5 || kind==15) && ng.y>.48 && (kind==15 || vPos.y>-.055)) {
    vec2 inkUV=(xz/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      float fLayer=float(lowMeta);
      vec4 inkProbe=texture(uInk,vec3(inkUV,fLayer));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid);
        part=part*part*(3.-2.*part);
        float clearance=kind==15 || lowMeta==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        vec4 a=filmCell(pixel,size,lowMeta,vPos.y,clearance);
        vec4 b=filmCell(pixel+ivec2(1,0),size,lowMeta,vPos.y,clearance);
        vec4 c=filmCell(pixel+ivec2(0,1),size,lowMeta,vPos.y,clearance);
        vec4 d=filmCell(pixel+ivec2(1,1),size,lowMeta,vPos.y,clearance);
        vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=det(xz*.83);
          float thr=.5+(iDet.r*.6+iDet.a*.4-.5)*.38;
          float aa=max(px*.85,.015);
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            vec3 teamInk=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            vec3 coord=vec3(inkUV,fLayer);
            float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 liquid=-vec2(e0-thick,s0-thick)*1.62;
            vec4 wDet=det(xz*1.7+vec2(uClock*.02,0.));
            liquid+=vec2(wDet.r-.5,wDet.b-.5)*.05+vec2(smoothstep(.07,.02,wDet.g)*.15*(1.-thick));
            clear=mix(clear,mix(.32,.65,bossMask),mask);
            ao=mix(ao,1.,mask*.6);
            albedo=mix(albedo,ink,mask);
            rough=mix(rough,mix(.21,.065,bossMask)+length(liquid)*.18,mask);
            metal=mix(metal,0.,mask);
            emit=mix(emit,mix(ink*.05,vec3(.042,.006,.014),bossMask),mask);
            f0Base=mix(f0Base,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
            inked=mask;
          }
        }
      }
    }
  }
  if (uWetLevel>.02 || uRaytrace>.5) {
    float upWet=smoothstep(.65,.95,ng.y)*sat(1.-inked);
    if (upWet>.002) {
      float puddle=smoothstep(.42,.66,det(xz*.11).r);
      float wetAmt=sat(uWetLevel*upWet*(.45+.55*puddle)+(uRaytrace>.5?upWet*puddle*.22:0.));
      rough=mix(rough,.065,wetAmt);
      clear=max(clear,wetAmt*.58);
      f0Base=max(f0Base,.045*wetAmt);
      albedo=mix(albedo,albedo*.72,wetAmt*.65);
    }
  }
  float nv=max(dot(n,V),1e-4), nl=dot(n,uSun);
  vec3 R=reflect(-V,n), direct=vec3(0.);
  vec3 f0=mix(vec3(f0Base),albedo,metal);
  vec3 diffC=albedo*(1.-metal);
  if (nl>.001) {
    float sh=sunShadow(vPos,ng);
    if (sh>.001) {
      vec3 sun=uSunColor*sh;
      direct=diffC*(1./PI)*sun*nl+sun*specGGX(n,V,uSun,f0,max(rough,.03),nv,nl);
      if (clear>0.) direct+=sun*specGGX(n,V,uSun,vec3(.04),.05,nv,nl)*clear;
    }
  }
  vec3 irr=shDiffuse(n)+vec3(.36,.34,.30)*(sat(-n.y)*.2);
  if (uBossRage>.005) irr=mix(irr,irr*vec3(1.12,.52,.58)+vec3(.04,.005,.01),uBossRage*.55);
  vec3 spec=(rough>.72 && metal<.01)?irr:envSpec(R,rough);
  if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
  bool hasPlanar=uReflectOn && ng.y>.49 && abs(vPos.y)<.08;
  bool usedPlanar=false;
  vec3 planar=vec3(0.);
  if (hasPlanar && rough<.45) {
    planar=texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.035).rgb;
    usedPlanar=true;
    float w=(1.-smoothstep(.08,.40,rough))*mix(1.,.55,inked);
    spec=mix(spec,planar,w);
  }
  float so=ao>=.999?1.:sat(pow(nv+ao,exp2(-16.*rough-1.))-1.+ao);
  vec3 ambient=diffC*irr*ao+spec*envBRDF(f0,rough,nv)*so;
  if (clear>0.) {
    vec3 cspec=hasPlanar?(usedPlanar?planar:texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.02).rgb):envSpec(R,.05);
    ambient+=cspec*(.04+.96*pow5(1.-nv))*clear*so;
  }
  vec3 col=direct+ambient+emit;
  float dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
  float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
  if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
    col=mix(col,fogCol,fogAmt);
  }
  frag=vec4(col,sat(lum(ambient)/(lum(col)+1e-4))*(1.-fogAmt));
}`;

// Dedicated ultra-lean Stage 4 transparent shader (only kinds 7, 12, 16, 17, 24, 28 — ~95 lines vs 1,100).
export const SCENE_ALPHA_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
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
flat out vec4 vTint;
flat out vec4 vExtra;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vPos=p.xyz;
  vNormal=normalize(a0.xyz*(aNormal.x/max(dot(a0.xyz,a0.xyz),1e-12))
                   +a1.xyz*(aNormal.y/max(dot(a1.xyz,a1.xyz),1e-12))
                   +a2.xyz*(aNormal.z/max(dot(a2.xyz,a2.xyz),1e-12)));
  vUV=aUV;
  vTint=aTint;
  vExtra=aExtra;
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

export const SCENE_ALPHA_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DShadow;
${COMMON}
in vec3 vPos;
in vec3 vNormal;
in vec2 vUV;
flat in vec4 vTint;
flat in vec4 vExtra;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM0;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2D uAtlas;
uniform vec2 uAtlasGrid;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform sampler2D uDetail;
uniform float uClock;
uniform vec4 uFogParams;
uniform float uBossRage;
uniform float uRainLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;
vec3 envSpec(vec3 r,float rough){return envDecode(textureLod(uEnv,envUV(r),clamp(sqrt(rough)*uEnvLod,0.,uEnvLod)));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 specGGX(vec3 n,vec3 v,vec3 l,vec3 f0,float rough){
  vec3 h=normalize(l+v);
  float nl=max(dot(n,l),0.), nv=max(dot(n,v),1e-4), nh=max(dot(n,h),0.), a=max(rough*rough,.0016);
  vec3 F=f0+(1.-f0)*pow5(1.-max(dot(v,h),0.));
  return ggxD(nh,a)*visSmith(nv,nl,a)*F*nl;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
  float slope=1.-sat(dot(ng,uSun));
  vec3 c0=(uShadowM0*vec4(p+ng*uShadowTexel.z*(1.2+slope*1.6),1.)).xyz;
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y), s0=1.;
  if (inner>0. && c0.z<1.) {
    int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
    vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(uShadowTexel.x*1.22);
    s0=(texture(uShadow0,vec3(c0.xy+d,c0.z-.00022))+texture(uShadow0,vec3(c0.xy-d,c0.z-.00022)))*.5;
  }
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope*1.6),1.)).xyz;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}
void main(){
  int kind=int(vTint.a+.5);
  if (kind==28) {
    float r=length(vUV-.5)*2.;
    frag=vec4(0.,0.,0.,pow(sat(1.-r),1.7)*vExtra.x);
    return;
  }
  vec3 tint=toLinear(vTint.rgb);
  if (kind==12) {
    float contour=sin(vUV.y*3.14159)*(.65+.35*sin(vUV.x*21.+uClock*8.));
    frag=vec4(tint*1.9,max(0.,contour)*(.46*(1.-vExtra.x)));
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
    frag=vec4(col,alpha);
    return;
  }
  vec3 ng=normalize(vNormal), V=uEye-vPos;
  float dist=length(V); V/=max(dist,1e-5);
  if (kind==16) {
    if (dot(ng,V)<=0.) discard;
    float border=1.-smoothstep(.012,.065,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float flow=.5+.5*sin(vUV.x*45.+vUV.y*13.-uClock*5.);
    float caustic=texture(uDetail,vUV*vec2(1.1,.7)+vec2(0.,uClock*.08)).b;
    vec3 col=tint*(1.25+border*.9+caustic*.6)+vec3(1.)*pow(1.-abs(dot(ng,V)),3.)*.5;
    float alpha=(.22+border*.44+flow*.08+caustic*.08)*(1.-vExtra.x*.64);
    frag=vec4(col,alpha);
    return;
  }
  if (kind==17) {
    if (dot(ng,V)<=0.) discard;
    float edge=1.-smoothstep(.01,.035,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float nv=abs(dot(ng,V));
    vec3 an=abs(ng);
    vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
    float smudge=texture(uDetail,uvW*.6).r;
    vec3 refl=envSpec(reflect(-V,ng),.02+smudge*.06);
    float F=.04+.96*pow5(1.-nv);
    vec3 col=refl*F+tint*.05+uSunColor*specGGX(ng,V,uSun,vec3(.04),.03);
    float alpha=sat(.10+F*.85+edge*.18+smudge*.04);
    frag=vec4(col/max(alpha,.05),alpha);
    return;
  }
  float alphaOut=1.;
  vec3 albedo=tint;
  if (kind==7) {
    if (dot(ng,V)<=0.) discard;
    float index=vExtra.x;
    vec2 tile=vec2(mod(index,uAtlasGrid.x),floor(index/uAtlasGrid.x));
    vec2 uv=(tile+vec2(mix(.01,.99,vUV.x),mix(.02,.98,1.-vUV.y)))/uAtlasGrid;
    alphaOut=texture(uAtlas,uv).a;
    if (alphaOut<.012) discard;
    albedo=tint*.92;
  }
  float nl=max(dot(ng,uSun),0.), nv=max(dot(ng,V),1e-4);
  vec3 direct=vec3(0.);
  if (nl>.001) {
    float sh=sunShadow(vPos,ng);
    if (sh>.001) direct=uSunColor*sh*(albedo*(nl/PI)+specGGX(ng,V,uSun,vec3(.04),.6));
  }
  vec3 irr=shDiffuse(ng)+vec3(.36,.34,.30)*(sat(-ng.y)*.2);
  if (uBossRage>.005) irr=mix(irr,irr*vec3(1.12,.52,.58)+vec3(.04,.005,.01),uBossRage*.55);
  vec3 R=reflect(-V,ng);
  vec3 spec=envSpec(R,.6);
  if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
  const vec4 c0=vec4(-1.,-.0275,-.572,.022), c1=vec4(1.,.0425,1.04,-.04);
  vec4 r=.6*c0+c1;
  float a004=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;
  vec2 ab=vec2(-1.04,1.04)*a004+r.zw;
  vec3 col=direct+albedo*irr+spec*(vec3(.04)*ab.x+ab.y);
  vec3 dir=-V;
  float dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
  float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
  if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
    col=mix(col,fogCol,fogAmt);
  }
  frag=vec4(col,alphaOut);
}`;

// Dedicated lean Stage 2 outdoor cutout & decal shader (kinds 14 foliage, 22 road paint, 27 outer disk, 26/9 splats).
export const SCENE_CUTOUT_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
in vec3 vPos;
in vec3 vNormal;
in vec3 vShadow0;
flat in vec4 vTint;
flat in vec4 vSlots;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform bool uShadowOn;
uniform int uCascades;
uniform sampler2DShadow uShadow0;
uniform sampler2DShadow uShadow1;
uniform mat4 uShadowM1;
uniform vec4 uShadowTexel;
uniform sampler2DArray uInk;
uniform vec2 uInkTexel;
uniform vec2 uInkBounds;
uniform vec4 uInkActiveBox;
uniform sampler2D uEnv;
uniform float uEnvLod;
uniform sampler2D uDetail;
uniform float uClock;
uniform vec4 uFogParams;
uniform float uRaytrace;
uniform float uWetLevel;
uniform float uBossRage;
uniform float uRainLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;
#ifndef NO_SURFACES
${SURFACE_HIGH}
#endif
vec4 det(vec2 p){return texture(uDetail,p);}
vec3 envSpec(vec3 r,float rough){return envDecode(textureLod(uEnv,envUV(r),clamp(sqrt(rough)*uEnvLod,0.,uEnvLod)));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}
float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 specGGX(vec3 n,vec3 v,vec3 l,vec3 f0,float rough,float nv,float nl){
  vec3 h=normalize(l+v);
  float nh=max(dot(n,h),0.), a=max(rough*rough,.0016);
  vec3 F=f0+(1.-f0)*pow5(1.-max(dot(v,h),0.));
  return ggxD(nh,a)*visSmith(nv,nl,a)*F*nl;
}
vec3 envBRDF(vec3 f0,float rough,float nv){
  const vec4 c0=vec4(-1.,-.0275,-.572,.022);
  const vec4 c1=vec4(1.,.0425,1.04,-.04);
  vec4 r=rough*c0+c1;
  float a004=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;
  vec2 ab=vec2(-1.04,1.04)*a004+r.zw;
  return f0*ab.x+ab.y;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
  vec3 c0=vShadow0;
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y), s0=1.;
  if (inner>0. && c0.z<1.) {
    int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
    vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(uShadowTexel.x*1.22);
    s0=(texture(uShadow0,vec3(c0.xy+d,c0.z-.00022))+texture(uShadow0,vec3(c0.xy-d,c0.z-.00022)))*.5;
  }
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  float slope1=1.-sat(dot(ng,uSun));
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope1*1.6),1.)).xyz;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}
void main(){
  vec3 ng=normalize(vNormal);
  int kind=int(vTint.a+.5);
  if (kind==22 && ng.y<.5) discard;
  vec2 xz=vPos.xz;
  if (kind==27 && dot(xz,xz)>${CITY_RADIUS**2}.0) discard;
  vec3 V=uEye-vPos;
  float dist=length(V); V/=max(dist,1e-5);
  vec3 tint=toLinear(vTint.rgb), an=abs(ng);
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
  vec3 sdpx=dFdx(vPos), sdpy=dFdy(vPos);
  float px=max(length(sdpx),length(sdpy));
#ifndef NO_SURFACES
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy), sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  int slot=uSurfaceSheets>0?int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5)):-1;
  bool real=surfaceReady(slot);
  float surfH=0., relief=0.;
#endif
  vec3 albedo=tint, emit=vec3(0.), n=ng;
  float rough=.6, ao=1., f0Base=.04, clear=0., trans=0.;
  if (kind==14) {
    vec3 tw=pow(an,vec3(3.));
    tw/=tw.x+tw.y+tw.z;
    vec3 q=vPos*.16;
    vec4 cX=det(q.zy), cY=det(q.xz+.31), cZ=det(q.xy+.67);
    float clumps=cX.g*tw.x+cY.g*tw.y+cZ.g*tw.z;
    float leaves=cX.a*tw.x+cY.a*tw.y+cZ.a*tw.z;
    float rim=1.-abs(dot(ng,V));
    if (rim>.42 && clumps>mix(.98,.40,(rim-.42)/.58)) discard;
    float hgt=-clumps*.34+leaves*.05;
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float dt=dot(sdpx,r1);
    n=normalize(abs(dt)*ng-sign(dt)*(dFdx(hgt)*r1+dFdy(hgt)*r2));
    float tone=det(xz*.05+vPos.y*.03).r;
    vec3 hue=tint*mix(vec3(.70,.84,.52),vec3(1.10,1.08,.68),tone)*(.78+leaves*.44);
    albedo=hue*mix(1.,.5,smoothstep(.35,.85,clumps));
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTri(slot,vPos,ng,sdpx,sdpy),slot,albedo,1.,.02,surfH); relief=.6;}
#endif
    rough=.6; f0Base=.03;
    ao=mix(.34,1.,sat(1.-clumps*.95+ng.y*.22));
    trans=.6;
  } else if (kind==22 || kind==0) {
    vec4 d2=det(uvW*2.3);
    float worn=an.y>.6?smoothstep(.55,.75,det(uvW*.6).r*.6+d2.r*.5):0.;
    albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
    rough=.62+worn*.2;
    if (an.y>.6 && px<.015) {
      float bead=step(.985,det(uvW*31.).a)*(1.-worn);
      f0Base=mix(.04,.4,bead); rough=mix(rough,.2,bead);
    }
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,kind==22?1.:.7,.003,surfH); relief=.5;}
#endif
  } else if (kind==27) {
#ifndef NO_SURFACES
    if (real) {
      vec3 ground=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.010,surfH);
      float h2=0., h3=0., h4=0., cover=0.;
      float stain=det(uvW*.17+.31).r;
      float wornW=smoothstep(.42,.58,sfNoise(xz*.019+5.3));
      if (wornW>.01 && surfaceReady(S_ASPHALT_WORN)) ground=mix(ground,realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(31.,17.),sdx,sdy),S_ASPHALT_WORN,tint*.82,1.,.010,h2),wornW);
      int patchSlot=outerPatch(xz,cover);
      if (cover>0. && surfaceReady(patchSlot)) {ground=mix(ground,realSurface(surfaceTap(patchSlot,uvW,sdx,sdy),patchSlot,tint,1.,.014,h3),cover); surfH=mix(surfH,h3,cover);}
      float mossW=smoothstep(.6,.8,stain)*.55;
      if (mossW>.01 && surfaceReady(S_MOSS)) ground=mix(ground,realSurface(surfaceTap(S_MOSS,uvW*1.3,sdx*1.3,sdy*1.3),S_MOSS,tint,1.,.01,h4),mossW);
      albedo=ground; rough=.82; relief=1.;
    } else
#endif
    {
      vec4 d1=det(uvW*.31), d2=det(uvW*1.37), d3=det(uvW*5.3);
      float pores=smoothstep(.16,.04,d2.g)*.5, aggregate=smoothstep(.62,.8,d3.g)*.10;
      float tone=.90+(d1.r-.5)*.16+(d3.a-.5)*.07-pores*.12+aggregate;
      float oil=smoothstep(.62,.8,det(uvW*.09+.7).r)*.22;
      albedo=tint*tone*(1.-oil)*mix(vec3(1.),vec3(.86,.95,.78),smoothstep(.55,.75,det(uvW*.17+.31).r)*.6);
      rough=.78+d2.r*.12-oil*.25;
    }
  } else if (kind==26) {
    albedo=tint*.95; rough=.09; clear=.9; emit=tint*.05;
#ifndef NO_SURFACES
    if (real) {albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,albedo,.35,.002,surfH); relief=.3;}
#endif
  } else if (kind==9) {
    albedo=tint*.92; rough=.07; clear=1.; trans=.35; emit=tint*.22;
  } else {
    albedo=tint*(.92+(det(uvW*.29).r-.5)*.16); rough=.82;
  }
#ifndef NO_SURFACES
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0. && px<.03) {
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float area=dot(sdpx,r1);
    n=normalize(abs(area)*n-sign(area)*(surfSlope.x*r1+surfSlope.y*r2));
  }
#endif
  float inked=0.;
  if (kind==22 && ng.y>.48 && vPos.y>-.055 &&
      xz.x>=uInkActiveBox.x && xz.x<=uInkActiveBox.y && xz.y>=uInkActiveBox.z && xz.y<=uInkActiveBox.w) {
    vec2 inkUV=(xz/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      vec4 inkProbe=texture(uInk,vec3(inkUV,vSlots.w));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid); part=part*part*(3.-2.*part);
        int layer=int(vSlots.w+.5);
        float clearance=layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        vec4 a=filmCell(pixel,size,layer,vPos.y,clearance);
        vec4 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
        vec4 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
        vec4 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
        vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=det(xz*.83);
          float thr=.5+(iDet.r*.6+iDet.a*.4-.5)*.38;
          float aa=fwidth(coverage)*.9+.015;
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            vec3 teamInk=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            vec3 coord=vec3(inkUV,vSlots.w);
            float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
            float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
            vec2 liquid=-vec2(e0-thick,s0-thick)*1.62;
            albedo=mix(albedo,ink,mask);
            rough=mix(rough,mix(.21,.065,bossMask)+length(liquid)*.18,mask);
            clear=mix(clear,mix(.32,.65,bossMask),mask);
            emit=mix(emit,mix(ink*.05,vec3(.042,.006,.014),bossMask),mask);
            f0Base=mix(f0Base,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
            inked=mask;
          }
        }
      }
    }
  }
  if ((uWetLevel>.02 || uRaytrace>.5) && kind!=14) {
    float upWet=smoothstep(.65,.95,ng.y)*sat(1.-inked);
    if (upWet>.002) {
      float puddle=smoothstep(.42,.66,det(xz*.11).r);
      float wetAmt=sat(uWetLevel*upWet*(.45+.55*puddle)+(uRaytrace>.5?upWet*puddle*.22:0.));
      rough=mix(rough,.065,wetAmt);
      clear=max(clear,wetAmt*.58);
      f0Base=max(f0Base,.045*wetAmt);
      albedo=mix(albedo,albedo*.72,wetAmt*.65);
    }
  }
  float nv=max(dot(n,V),1e-4), nl=dot(n,uSun);
  vec3 R=reflect(-V,n), direct=vec3(0.);
  vec3 f0=vec3(f0Base);
  if (nl>.001 || trans>0.) {
    float sh=sunShadow(vPos,ng);
    if (sh>.001) {
      vec3 sun=uSunColor*sh;
      float wrap=trans>0.?sat((nl+.4)/1.4):nl;
      direct=albedo*(1./PI)*sun*wrap;
      if (nl>.001) {
        direct+=sun*specGGX(n,V,uSun,f0,max(rough,.03),nv,nl);
        if (clear>0.) direct+=sun*specGGX(n,V,uSun,vec3(.04),.05,nv,nl)*clear;
      }
      if (trans>0.) direct+=albedo*trans*sun*pow(sat(dot(-V,uSun)),3.)*.9*sat(1.-nl);
    }
  }
  vec3 irr=shDiffuse(n)+vec3(.36,.34,.30)*(sat(-n.y)*.2);
  if (uBossRage>.005) irr=mix(irr,irr*vec3(1.12,.52,.58)+vec3(.04,.005,.01),uBossRage*.55);
  vec3 spec=rough>.72?irr:envSpec(R,rough);
  if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
  float so=ao>=.999?1.:sat(pow(nv+ao,exp2(-16.*rough-1.))-1.+ao);
  vec3 ambient=albedo*irr*ao+spec*envBRDF(f0,rough,nv)*so;
  if (clear>0.) ambient+=envSpec(R,.05)*(.04+.96*pow5(1.-nv))*clear*so;
  vec3 col=direct+ambient+emit;
  vec3 dir=-V;
  float dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(uFogParams.z-exp(-uFogParams.x*vPos.y))/(uFogParams.x*dy):uFogParams.z;
  float fogAmt=1.-exp(-uFogParams.y*dist*max(integral,0.));
  if (uFogParams.w>0.) fogAmt=max(fogAmt,smoothstep(uFogParams.w*.6,uFogParams.w*.97,dist));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
    col=mix(col,fogCol,fogAmt);
  }
  frag=vec4(col,sat(lum(ambient)/(lum(col)+1e-4))*(1.-fogAmt));
}`;

// Single-pass 2-MRT Deferred Mirror lighting + pre-baked sky probe (analytic vRay reconstruction, 1.00x overdraw).
export const DEFERRED_MIRROR_FRAGMENT=`#version 300 es
#define FAST_SLOT 1
precision highp float;
precision highp sampler2DArray;
${COMMON}
in vec2 vUV;
in vec3 vRay;
uniform highp sampler2D uMDepth;
uniform sampler2D uMG0;
uniform sampler2D uMG1;
uniform vec2 uDepthAB;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform sampler2D uEnv;
uniform float uMirrorExpH0;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
#ifndef NO_SURFACES
${SURFACE_CORE}
#endif
out vec4 frag;
void main(){
  ivec2 ipx=ivec2(gl_FragCoord.xy);
  float rawD=texelFetch(uMDepth,ipx,0).r;
  float invRL=inversesqrt(dot(vRay,vRay));
  vec3 dir=vRay*invRL;
  if (rawD>=.99999) {
    frag=vec4(envDecode(textureLod(uEnv,envUV(dir),0.)),0.);
    return;
  }
  float zView=uDepthAB.x/(uDepthAB.y-rawD);
  vec3 vPos=uEye+vRay*zView;
  float dist=zView/invRL;
  vec3 V=-dir;
  vec4 g0=texelFetch(uMG0,ipx,0);
  vec4 g1=texelFetch(uMG1,ipx,0);
  int kind=int(g0.a*255.+.5);
  vec3 ng=octDec(g1.rg);
  vec3 tint=toLinear(g0.rgb);
  vec3 albedo=tint, emit=vec3(0.);
  vec3 an=abs(ng);
  if (kind==3) {
    emit=tint*3.2; albedo=tint*.4;
  } else if (kind==25) {
    frag=vec4(tint*1.8,0.); return;
  } else if (kind==8 || kind==6) {
    vec3 R=reflect(-V,ng);
    float fres=.04+.96*pow5(1.-max(dot(ng,V),0.));
    vec3 refl=envDecode(textureLod(uEnv,envUV(R),1.));
    albedo=tint*.18;
    emit=refl*fres+tint*.10;
  }
#ifndef NO_SURFACES
  else if (uSurfaceSheets>0) {
    int slot=int(g1.b*255.+.5)-1;
    if (surfaceReady(slot)) {
      vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
      vec4 t=surfaceLod(slot,uvW,2.);
      vec3 mean=max(toLinear(surfaceMean(slot)),vec3(.012)), c=toLinear(t.rgb);
      vec3 tinted=tint*c/mean, natural=c*(lum(tint)/max(lum(mean),.012));
      albedo=mix(tinted,natural,S_TAKE[slot]);
    }
  }
#endif
  if (kind==11 && an.y<=.55) albedo=mix(albedo,vec3(.08,.11,.13),.38);
  else if (kind==5) albedo*=.70;
  float nl=max(dot(ng,uSun),0.);
  float shT=clamp(.5-ng.y*.7071068,0.,1.);
  vec3 irr=max(mix(uSH0,uSH1,shT)+uSH2*ng.x+uSH3*ng.z+uSH4*(shT*(1.-shT)),vec3(0.));
  vec3 col=albedo*(uSunColor*(nl/PI)+irr)+emit;
  float dy=vPos.y-uEye.y;
  float integral=abs(dy)>.01?(uMirrorExpH0-exp(-.022*vPos.y))/(.022*dy):uMirrorExpH0;
  float fogAmt=1.-exp(-.0021*dist*max(integral,0.));
  if (fogAmt>.002) {
    vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
    vec3 fogCol=max(uFog0+uFog1*fdir.y+uFog2*fdir.x+uFog3*fdir.z,vec3(0.));
    col=mix(col,fogCol,fogAmt);
  }
  frag=vec4(col,0.);
}`;



export const SCENE_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
${COMMON}
${SKY}
in vec3 vPos;
in vec3 vNormal;
#ifdef USE_SHADOW0
in vec3 vShadow0;
#endif
in vec2 vUV;
in vec3 vLocal;
flat in vec4 vTint;
flat in vec4 vExtra;
flat in vec3 vSize;
flat in vec3 vAxisX;
flat in vec3 vAxisY;
flat in float vSeed;
flat in vec3 vSlots;
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
uniform float uDrawFar;
uniform float uRaytrace;
uniform float uWetLevel;
uniform vec3 uSH0;
uniform vec3 uSH1;
uniform vec3 uSH2;
uniform vec3 uSH3;
uniform vec3 uSH4;
uniform vec3 uFog0;
uniform vec3 uFog1;
uniform vec3 uFog2;
uniform vec3 uFog3;
out vec4 frag;

${SURFACE_HIGH}
const float LAMP_ROWS[${LAMP_ROWS.length}]=float[${LAMP_ROWS.length}](${LAMP_ROWS.map(f).join(',')});
const float CABIN_LAMPS[${CABIN_LAMPS.length}]=float[${CABIN_LAMPS.length}](${CABIN_LAMPS.map(f).join(',')});

vec4 det(vec2 p){return texture(uDetail,p);}
vec3 envAt(vec3 d,float lod){return envDecode(textureLod(uEnv,envUV(d),lod));}
vec3 envSpec(vec3 r,float rough){return envAt(r,clamp(sqrt(rough)*uEnvLod,0.,uEnvLod));}
vec3 shDiffuse(vec3 n){float t=clamp(.5-n.y*.7071068,0.,1.);return max(mix(uSH0,uSH1,t)+uSH2*n.x+uSH3*n.z+uSH4*(t*(1.-t)),vec3(0.));}
vec3 fogEnv(vec3 d){return max(uFog0+uFog1*d.y+uFog2*d.x+uFog3*d.z,vec3(0.));}

float ggxD(float nh,float a){float a2=a*a;float d=nh*nh*(a2-1.)+1.;return a2/max(PI*d*d,1e-6);}
float visSmith(float nv,float nl,float a){float k=a*.5;return .25/max((nv*(1.-k)+k)*(nl*(1.-k)+k),1e-4);}
vec3 fresnel(vec3 f0,float c){return f0+(1.-f0)*pow5(1.-c);}
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

// 2-tap checkerboard-alternated hardware-bilinear PCF (8 filtered texels, zero cos/sin).
float shadowTap(sampler2DShadow s,vec3 c,float texel){
  if (uQuality==0) return texture(s,c);
  int chk=(int(gl_FragCoord.x)^int(gl_FragCoord.y))&1;
  vec2 d=(chk==0?vec2(.62,.44):vec2(-.44,.62))*(texel*1.22);
  return (texture(s,vec3(c.xy+d,c.z))+texture(s,vec3(c.xy-d,c.z)))*.5;
}
float sunShadow(vec3 p,vec3 ng){
  if (!uShadowOn) return 1.;
#ifdef USE_SHADOW0
  vec3 c0=vShadow0;
#else
  float slope=1.-sat(dot(ng,uSun));
  vec3 c0=(uShadowM0*vec4(p+ng*uShadowTexel.z*(1.2+slope*1.6),1.)).xyz*.5+.5;
#endif
  vec2 e0=min(c0.xy,1.-c0.xy);
  float inner=min(e0.x,e0.y);
  float s0=1.;
  if (inner>0. && c0.z<1.) s0=shadowTap(uShadow0,vec3(c0.xy,c0.z-.00022),uShadowTexel.x);
  if (uCascades<2) return inner>0.?s0:1.;
  float blend=smoothstep(.0,.08,inner);
  if (blend>=1.) return s0;
  float slope1=1.-sat(dot(ng,uSun));
  vec3 c1=(uShadowM1*vec4(p+ng*uShadowTexel.w*(1.2+slope1*1.6),1.)).xyz*.5+.5;
  vec2 e1=min(c1.xy,1.-c1.xy);
  float s1=1.;
  // Far cascade uses single hardware-bilinear PCF tap (9x cheaper than 3x3).
  if (min(e1.x,e1.y)>0. && c1.z<1.) s1=texture(uShadow1,vec3(c1.xy,c1.z-.00045));
  s1=mix(1.,s1,smoothstep(0.,.06,min(e1.x,e1.y)));
  return mix(s1,s0,blend);
}

vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  bool match=cell.a>0. && abs(height-bed)<tolerance;
  return vec4(match?cell.rgb:vec3(0.),cell.a<=0. || match?1.:0.);
}

#ifndef CUTOUT_ONLY
// Window interiors: a box room traced behind the glass in local face space.
vec3 roomBehind(vec2 uv,vec3 viewT,float seed,float lightOn,float depth,float px){
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
  vec3 col=wallC*mix(.74,.9,backHit);
  col=mix(col,vec3(.22,.18,.15)*(1.+seed*.4),floorHit);
  col=mix(col,vec3(.72,.71,.66),ceilHit);
  float furniture=backHit*step(abs(hit.x+.18-seed*.3),.22)*step(hit.y,-.12);
  col=mix(col,vec3(.18,.17,.16),furniture*.85);
  // Real floors and walls once the interior sheets are loaded: tatami, wood
  // or carpet underfoot, wallpaper or painted board on the walls.
  if (uSurfaceSheets>0 && px<.045) {
    float texels=.5/uSurfaceEdge.x, metres=1.5;
    int floorSlot=seed<.33?S_TATAMI:seed<.66?S_WOOD_FLOORING:S_CARPET_TILE;
    int wallSlot=fract(seed*7.31)<.5?S_VINYL_WALLPAPER:S_GYPSUM_PAINTED;
    if (floorHit>.5 && surfaceReady(floorSlot)) {
      float lod=log2(max(px*2.5*texels/S_METERS[floorSlot],1.));
      vec3 c=toLinear(surfaceLod(floorSlot,hit.xz*metres,lod).rgb);
      col=c*(.9+seed*.2);
    } else if (ceilHit<.5 && surfaceReady(wallSlot)) {
      float lod=log2(max(px*2.*texels/S_METERS[wallSlot],1.));
      vec2 wp=(backHit>.5?hit.xy:vec2(hit.z,hit.y))*metres;
      vec3 c=toLinear(surfaceLod(wallSlot,wp,lod).rgb);
      col*=c/max(toLinear(surfaceMean(wallSlot)),vec3(.02));
    }
  }
  float shelf=backHit*step(.18,hit.x)*step(hit.x,.42)*step(abs(fract(hit.y*3.)-.5),.06);
  col=mix(col,vec3(.30,.26,.21),shelf);
  float lamp=ceilHit*smoothstep(.16,.05,length(hit.xz-vec2(0.,.4*depth)));
  vec3 light=mix(vec3(.30,.32,.33),vec3(1.,.82,.58)*1.6,lightOn);
  return col*light+vec3(1.,.86,.62)*lamp*lightOn*4.;
}
#endif

struct Mat {vec3 albedo; float rough; float metal; float ao; vec3 emit; float clear; float sheen; float trans; float f0;};

void main(){
#ifndef OPAQUE_PURE
  if (uMirrorPass && vPos.y<.037) discard;
#endif
  vec3 ng=normalize(vNormal);
  vec3 V=uEye-vPos;
  float dist=length(V);
  V/=dist;
  int kind=int(vTint.a+.5);
#ifndef OPAQUE_PURE
  if (kind==22 && ng.y<.5) discard;
#endif
  vec3 tint=toLinear(vTint.rgb);
  vec2 xz=vPos.xz;
  vec3 an=abs(ng);
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
  vec3 sdpx=dFdx(vPos), sdpy=dFdy(vPos);
  float px=max(length(sdpx),length(sdpy));
  bool lite=uQuality==0;
  float zoneInterior=vPos.x>uUnderX*.5?1.:smoothstep(-.4,-3.2,vPos.y);
  bool cabin=vPos.x>uCabinX-640.;
  float floorY=cabin?uCabinY:vPos.x>uUnderX*.5?uUnderY:0.;
  float above=vPos.y-floorY;

  // ---------- transparent and unlit effects ----------
#if !defined(OPAQUE_PURE) && !defined(CUTOUT_ONLY)
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
#endif
#ifndef CUTOUT_ONLY
  if (kind==25) {
    float rim=pow(1.-max(0.,dot(ng,V)),2.5);
    float veins=sin(vUV.x*32.+vUV.y*21.-uClock*19.+det(vUV*1.3).r*9.);
    float streak=smoothstep(.42,.96,veins)*.55+rim*.46;
    vec3 liquid=tint*(1.2+.5*max(dot(ng,uSun),0.)+.25*veins);
    vec3 col=mix(liquid,vec3(2.6,2.3,2.6),sat(streak))*1.4;
    frag=uHDR?vec4(col,.0):vec4(grade(col*uExposure),1.);
    return;
  }
#endif
#if !defined(OPAQUE_PURE) && !defined(CUTOUT_ONLY)
  if (kind==17) {
    if (dot(ng,V)<=0.) discard;
    float edge=1.-smoothstep(.01,.035,min(min(vUV.x,1.-vUV.x),min(vUV.y,1.-vUV.y)));
    float nv=abs(dot(ng,V));
    vec3 r=reflect(-V,ng);
    float smudge=det(uvW*.6).r;
    vec3 refl=envSpec(r,.02+smudge*.06)*mix(1.,.55,zoneInterior);
    float F=.04+.96*pow5(1.-nv);
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
#endif

  // ---------- surface description ----------
  Mat m;
  m.albedo=tint; m.rough=.6; m.metal=0.; m.ao=1.; m.emit=vec3(0.);
  m.clear=0.; m.sheen=0.; m.trans=0.; m.f0=.04;
  vec3 n=ng;
  float alphaOut=1.;

  // Box-local frame: compute only when face coordinates or close-up edge beveling are visible.
  vec3 axZ=vec3(0.,0.,1.), nObj=ng, faceMask=vec3(0.,1.,0.);
  float edge=0.;
  vec2 faceUV=vec2(0.), faceSize=vSize.xz;
  bool boxy=uShape==1 && kind!=3 && kind!=6 && kind!=7 && kind!=9 && kind!=22 && kind!=26;
  bool needFace=kind==6 || kind==8 || kind==10 || kind==11 || kind==15 || kind==2 || kind==29 || (boxy && px<.08);
  if (needFace) {
    axZ=cross(vAxisX,vAxisY);
    vec3 lp=vLocal*vSize;
    nObj=vec3(dot(ng,vAxisX),dot(ng,vAxisY),dot(ng,axZ));
    faceMask=step(vec3(.5),abs(nObj));
    faceUV=lp.xz;
    if (faceMask.x>.5) {faceUV=vec2(-sign(nObj.x)*lp.z,lp.y);faceSize=vSize.zy;}
    else if (faceMask.z>.5) {faceUV=vec2(sign(nObj.z)*lp.x,lp.y);faceSize=vSize.xy;}
    if (boxy && px<.08) {
      float minDim=min(min(vSize.x,vSize.y),vSize.z);
      float radius=clamp(minDim*.16,.004,kind==11?.06:.04);
      float vis=smoothstep(px*.6,px*2.4,radius);
      if (vis>.001) {
        vec3 dEdge=vSize*.5-abs(lp);
        vec3 bend=sat(1.-dEdge/radius)*(1.-faceMask);
        edge=max(max(bend.x,bend.y),bend.z);
        vec3 bent=nObj+sign(lp)*bend*vis;
        n=normalize(vAxisX*bent.x+vAxisY*bent.y+axZ*bent.z);
      }
    }
  }

  bool vertical=an.y<.45;
  // Evaluate grime only near street level on vertical walls where wallBase > 0.
  float wallBase=vertical && above<1.65?1.-smoothstep(0.,.95+det(uvW*.043).r*.6,above):0.;

  // ---------- real surface textures ----------
  // The texture picked for this surface (surfaces.js). The procedural look
  // below stays as the fallback until its sheet has loaded.
  vec2 sdx=an.y>.6?sdpx.xz:(an.x>an.z?sdpx.zy:sdpx.xy), sdy=an.y>.6?sdpy.xz:(an.x>an.z?sdpy.zy:sdpy.xy);
  bool belowGround=vPos.x>uUnderX*.5 && !cabin;
#ifdef FAST_SLOT
  int slot=uSurfaceSheets>0 && !uMirrorPass?int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5)):-1;
#else
  int slot=uSurfaceSheets>0 && !uMirrorPass?surfaceFor(kind,vTint.rgb,ng,vSeed,vSize,uShape,belowGround,cabin,vExtra.y,above):-1;
#endif
  bool real=surfaceReady(slot);
  bool rounded=kind==14 || kind==23 || kind==13 && uShape==0;
  vec4 stex=!real || kind==11?vec4(0.):rounded?surfaceTri(slot,vPos,ng,sdpx,sdpy):surfaceTap(slot,uvW,sdx,sdy);
  float surfH=0., relief=0.;

  if (kind==5) {
    vec4 d1=det(uvW*.23);
    float crackZone=smoothstep(.58,.70,det(uvW*.031+.4).r);
    float tar=crackZone>.005?smoothstep(.84,.97,det(uvW*.083+.2).b)*crackZone*.85:0.;
    float puddle=uMirrorPass?0.:smoothstep(.56,.70,det(xz*.045+.11).r*.75+d1.r*.35);
    float wet=sat(puddle*1.6);
    vec3 asphalt;
    if (real) {
      // Fresh and worn asphalt alternate in broad stretches along the road.
      float h1=0., h2=0., aged=smoothstep(.38,.62,sfNoise(xz*.026+1.7));
      vec3 fresh=realSurface(stex,S_ASPHALT,tint*.70,1.,.008,h1), old=fresh;
      if (aged>.01 && surfaceReady(S_ASPHALT_WORN)) old=realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(9.,23.),sdx,sdy),S_ASPHALT_WORN,tint*.70,1.,.008,h2);
      else h2=h1;
      asphalt=mix(fresh,old,aged);
      surfH=mix(h1,h2,aged);
      relief=1.-wet;
      m.rough=mix(.82,.06,puddle);
    } else {
      vec4 d2=det(uvW*1.9);
      vec4 d3=det(uvW*7.1);
      float stones=smoothstep(.30,.08,d3.g);
      float patchy=smoothstep(.45,.62,d1.r);
      asphalt=tint*.70*(.86+(d2.r-.5)*.24+stones*.32+(d3.a-.5)*.18)*mix(1.,.86,patchy);
      m.rough=mix(.86-stones*.12,.06,puddle);
      if (!lite) {
        surfH=-d3.g*.0045;
        relief=1.-wet;
      }
    }
    asphalt=mix(asphalt,vec3(.018,.019,.02),tar);
    m.albedo=asphalt*mix(1.,.45,wet);
    m.ao=1.-tar*.3;
    if (!lite && puddle>.01) {
      float rip=sin(xz.x*5.1+xz.y*2.3+uClock*1.3)*sin(xz.y*4.7-xz.x*1.1-uClock*1.1);
      n=normalize(mix(n,vec3(rip*.02,1.,rip*.015),puddle));
    }
#ifndef FULL_OUTDOOR
  } else if (kind==3) {
    float along=sat(1.-abs(vLocal.x)*2.);
    float core=.82+.18*smoothstep(0.,.6,along);
    float strength=mix(3.2,11.,zoneInterior);
    m.emit=tint*strength*core;
    m.albedo=tint*.4; m.rough=.25;
    // Light boxes glow through milky acrylic split by a thin frame.
    if (real) m.emit*=mix(vec3(1.),toLinear(stex.rgb)/max(toLinear(surfaceMean(slot)),vec3(.05)),.75);
  } else if (kind==1 || kind==15 || kind==27) {
    float underground=step(uUnderX*.5,vPos.x)*(1.-float(cabin));
    if (real) {
      // The texture replaces the procedural slabs and tiles; oil stains, stair
      // nosings and the outer district's lawns and moss go on top.
      float oil=kind==1 && underground<.5 && !cabin?smoothstep(.62,.8,det(uvW*.09+.7).r)*.18:0.;
      vec3 ground=realSurface(stex,slot,tint,1.,.010,surfH);
      m.rough=cabin?.48:(underground>.5 && kind==1 && lum(tint)>.30?.22:.82-oil*.25);
      if (kind==27) {
        float h2=0., h3=0., h4=0., cover=0.;
        float stain=det(uvW*.17+.31).r;
        float wornW=smoothstep(.42,.58,sfNoise(xz*.019+5.3));
        if (wornW>.01 && surfaceReady(S_ASPHALT_WORN)) ground=mix(ground,realSurface(surfaceTap(S_ASPHALT_WORN,uvW+vec2(31.,17.),sdx,sdy),
          S_ASPHALT_WORN,tint*.82,1.,.010,h2),wornW);
        int patchSlot=outerPatch(xz,cover);
        if (cover>0. && surfaceReady(patchSlot)) {
          ground=mix(ground,realSurface(surfaceTap(patchSlot,uvW,sdx,sdy),patchSlot,tint,1.,.014,h3),cover);
          surfH=mix(surfH,h3,cover);
        }
        float mossW=smoothstep(.6,.8,stain)*.55;
        if (mossW>.01 && surfaceReady(S_MOSS)) ground=mix(ground,realSurface(surfaceTap(S_MOSS,uvW*1.3,sdx*1.3,sdy*1.3),S_MOSS,tint,1.,.01,h4),mossW);
      }
      if (kind==15) {
        float nose=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)))*step(.6,an.y);
        if (nose>.01 && surfaceReady(S_RUBBER_STAIR)) {
          float h5=0.;
          ground=mix(ground,realSurface(surfaceTap(S_RUBBER_STAIR,uvW,sdx,sdy),S_RUBBER_STAIR,vec3(.05),1.,.006,h5),nose);
        }
        m.rough=mix(m.rough,.9,nose);
      }
      m.albedo=ground*(1.-oil);
      m.ao=1.;
      relief=1.;
    } else {
      vec4 d1=det(uvW*.31);
      vec4 d2=det(uvW*1.37);
      vec4 d3=det(uvW*5.3);
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
        if (!lite && px<.02) {
          float h0=d3.a, hx=det(uvW*5.3+vec2(.004,0.)).a, hz=det(uvW*5.3+vec2(0.,.004)).a;
          n=normalize(n+vec3(h0-hx,0.,h0-hz)*.9*(1.-smoothstep(.002,.02,px)));
        }
        if (kind==15) {
          float nosing=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)));
          m.albedo*=mix(1.,.55,nosing*step(.6,an.y));
          m.rough=mix(m.rough,.9,nosing);
        }
        if (kind==27) m.albedo*=mix(vec3(1.),vec3(.86,.95,.78),smoothstep(.55,.75,det(uvW*.17+.31).r)*.6);
      }
    }
  } else if (kind==2 || kind==19) {
    float stain=vertical?det(uvW*.17+.31).r:0.;
    float streak=vertical && stain>.3?smoothstep(.45,.85,det(vec2(uvW.x*1.3,uvW.y*.07)).r)*smoothstep(.3,.7,stain):0.;
    if (real) {
      vec3 wall=realSurface(stex,slot,tint,1.,.010,surfH);
      wall=mix(wall,wall*vec3(.72,.70,.64),streak*.35);
      wall=mix(wall,wall*vec3(.62,.60,.52),wallBase*.55*float(vertical));
      if (wallBase>.01 && vertical && !cabin && !belowGround && stain>.62 && surfaceReady(S_MOSS)) {
        float h2=0.;
        wall=mix(wall,realSurface(surfaceTap(S_MOSS,uvW,sdx,sdy),S_MOSS,tint,1.,.01,h2),wallBase*smoothstep(.62,.82,stain)*.6);
      }
      m.albedo=wall;
      m.rough=.88-streak*.1;
      m.ao=1.;
      relief=1.;
    } else {
      vec4 d1=det(uvW*.29);
      vec4 d2=det(uvW*1.6);
      vec4 d3=det(uvW*6.2);
      float pores=smoothstep(.13,.03,d3.g);
      float tone=.92+(d1.r-.5)*.16+(d2.r-.5)*.10+(d3.a-.5)*.06-pores*.18;
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
      if (!lite && px<.02) {
        float h0=d3.r, hx=det(uvW*6.2+vec2(.004,0.)).r, hy=det(uvW*6.2+vec2(0.,.004)).r;
        vec3 t1=an.y>.6?vec3(1,0,0):(an.x>an.z?vec3(0,0,1):vec3(1,0,0));
        vec3 t2=an.y>.6?vec3(0,0,1):vec3(0,1,0);
        n=normalize(n-(t1*(hx-h0)+t2*(hy-h0))*.55*(1.-smoothstep(.002,.02,px)));
      }
    }
#else
  } else if (kind==15) {
    float nose=smoothstep(.06,.02,min(faceSize.x*.5-abs(faceUV.x),faceSize.y*.5-abs(faceUV.y)))*step(.6,an.y);
    if (real) {
      vec3 ground=realSurface(stex,slot,tint,1.,.010,surfH);
      if (nose>.01 && surfaceReady(S_RUBBER_STAIR)) {
        float h5=0.;
        ground=mix(ground,realSurface(surfaceTap(S_RUBBER_STAIR,uvW,sdx,sdy),S_RUBBER_STAIR,vec3(.05),1.,.006,h5),nose);
      }
      m.albedo=ground; m.rough=mix(.82,.9,nose); relief=1.;
    } else {
      m.albedo=tint*(.92+(det(uvW*.31).r-.5)*.14)*mix(1.,.55,nose);
      m.rough=mix(.82,.9,nose);
    }
#endif
  } else if (kind==13) {
    if (real) {
      bool natural=slot==S_BARK || slot==S_SOIL || slot==S_MULCH;
      vec3 b=realSurface(stex,slot,tint,1.,natural?.02:.012,surfH);
      if (!natural) b=mix(b,b*.66,wallBase*.6*float(vertical));
      m.albedo=b;
      m.ao=1.;
      m.rough=natural?.9:.78;
      relief=1.;
    } else {
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
      if (!lite && vertical && px<.03) {
        vec3 t1=an.x>an.z?vec3(0,0,1):vec3(1,0,0);
        float ex=smoothstep(.04,.0,jd.x)*sign(b.x-.5);
        float ey=smoothstep(.03,.0,jd.y)*sign(b.y-.5);
        n=normalize(n+(t1*ex+vec3(0,1,0)*ey)*.45*(1.-smoothstep(.003,.03,px)));
      }
    }
#ifndef FULL_OUTDOOR
  } else if (kind==4) {
    vec4 d2=det(uvW*3.1);
    float sat0=max(max(tint.r,tint.g),tint.b)-min(min(tint.r,tint.g),tint.b);
    float galvanized=step(sat0,.035)*step(.12,lum(tint));
    float wear=smoothstep(.62,.9,edge+d2.r*.45);
    float rust=galvanized<.5?smoothstep(.80,.93,det(vec2(uvW.x*.9,uvW.y*.22)+.4).r)*smoothstep(.55,.85,1.-lum(tint))*.65:0.;
    vec3 paint, steel=vec3(.56,.57,.58), corrosion=vec3(.22,.10,.05);
    if (real) {
      paint=realSurface(stex,slot,tint,1.,.004,surfH);
      steel=realSurface(stex,slot,steel,1.,.004,surfH);
      relief=1.;
      if (rust>.01 && surfaceReady(S_RUST)) {
        float hr=0.;
        corrosion=realSurface(surfaceTap(S_RUST,uvW,sdx,sdy),S_RUST,corrosion,1.,.006,hr);
      }
    } else {
      paint=tint*(.94+(det(uvW*.5).r-.5)*.12);
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
#endif
#ifndef CUTOUT_ONLY
  } else if (kind==8 || kind==6) {
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
#ifdef SAFE
        vec3 room=vec3(.2,.21,.2)*(.7+seed*.5);
#else
        vec3 room=(px<.12 && dist<65.)?roomBehind(fract(uv),vt,seed,on,kind==6?2.2:1.6,px):mix(vec3(.22,.23,.24),vec3(.62,.52,.38),on)*(.75+seed*.45);
#endif
        float fres=.04+.96*pow5(1.-max(dot(n,V),0.));
        m.emit=room*(1.-fres)*mix(kind==6?.22:.34,.9,zoneInterior)*(1.-dirt*.3);
        m.f0=kind==6?.07:m.f0;
        float blind=kind==6?step(.7,seed)*smoothstep(.0,.02,fract(uv.y)-.6):0.;
        m.emit*=1.-blind*.7;
        m.albedo=mix(m.albedo,vec3(.62,.6,.55),blind);
#ifndef SAFE
        // Apartment windows: slatted blinds, or shoji screens glowing from inside.
        if (kind==6 && uSurfaceSheets>0) {
          if (blind>0. && surfaceReady(S_WINDOW_BLINDS))
            m.albedo=mix(m.albedo,toLinear(surfaceTap(S_WINDOW_BLINDS,uvW,sdx,sdy).rgb)*.85,blind);
          // Sudare reed blinds hung outside a few windows.
          float reed=step(.47,seed)*step(seed,.55);
          if (reed>0. && surfaceReady(S_SUDARE)) {
            m.albedo=mix(m.albedo,toLinear(surfaceTap(S_SUDARE,uvW,sdx,sdy).rgb)*.8,.88);
            m.emit*=.3;
            m.f0=mix(m.f0,.03,.88);
          }
          float paper=step(.55,seed)*step(seed,.7);
          if (paper>0. && surfaceReady(S_SHOJI_PAPER)) {
            vec3 shoji=toLinear(surfaceTap(S_SHOJI_PAPER,uvW,sdx,sdy).rgb);
            m.emit=shoji*mix(.16,.55,on)*(1.-fres);
            m.albedo=mix(m.albedo,shoji*.45,.5);
          }
        }
#endif
      }
    }
  } else if (kind==11) {
    if (an.y>.55) {
      if (real) {
        m.albedo=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint*.72,1.,.01,surfH);
        m.rough=.9;
        relief=1.;
      } else {
        vec4 d1=det(uvW*.4);
        m.albedo=tint*.72*(.85+d1.r*.25)*mix(1.,.8,smoothstep(.6,.8,det(uvW*.17+.31).r));
        m.rough=.9;
      }
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
      // Face position from its lower corner, for the distant facade photos.
      vec2 fp=faceUV+fsz*.5, fdx=dFdx(fp), fdy=dFdy(fp);
      vec2 lo=curtain?vec2(.035,.05):ribbon?vec2(.02,.30):vec2(.17,.24);
      vec2 hiE=curtain?vec2(.965,.95):ribbon?vec2(.98,.82):vec2(.83,.86);
      vec2 inW=smoothstep(lo-fw,lo+fw,cell)*(1.-smoothstep(hiE-fw,hiE+fw,cell));
      float win=inW.x*inW.y;
      float detailVis=1.-smoothstep(.10,.30,max(fw.x,fw.y));
      vec3 wall=tint;
      if (win<.995 && detailVis>.01) {
        if (real) {
          wall=realSurface(surfaceTap(slot,uvW,sdx,sdy),slot,tint,1.,.008,surfH);
          relief=1.-win;
        } else {
          wall=tint*(.9+(det(uvW*1.2).r-.5)*.14);
        }
        if (detailVis>.25) {
          float under=smoothstep(lo.y,lo.y-.25,cell.y)*step(lo.x,cell.x)*step(cell.x,hiE.x);
          if (under>.005) wall*=1.-under*smoothstep(.4,.8,det(vec2(g.x*3.,g.y*.25)).r)*.32;
          float stain=det(uvW*.17+.31).r;
          wall=mix(wall,wall*.8,smoothstep(.55,.8,stain)*.5);
        }
        float sill=smoothstep(.035,.0,abs(cell.y-lo.y+.03))*step(lo.x-.03,cell.x)*step(cell.x,hiE.x+.03);
        wall=mix(wall,vec3(.75,.74,.70),sill*.6*detailVis);
      }
      m.albedo=wall;
      m.rough=.82;
      if (win>.002 && detailVis>.005) {
        vec3 tx=normalize(faceMask.x>.5?axZ*(-sign(nObj.x)):faceMask.z>.5?vAxisX*sign(nObj.z):vAxisX);
        vec3 vt=vec3(dot(-V,tx),dot(-V,vAxisY),dot(V,n));
        vec2 recess=vt.xy/max(vt.z,.2)*.08/cellSz;
        vec2 wuv=(cell-lo)/(hiE-lo);
        vec2 rev=step(wuv,-recess*4.)+step(1.-recess*4.,wuv);
        float reveal=sat(max(rev.x,rev.y))*detailVis;
        float seed=hash12(cid+floor(vPos.xz*.37));
        float on=step(.7,hash12(cid*3.1+1.7));
#ifdef SAFE
        vec3 room=vec3(.18,.2,.21)*(.8+seed*.4);
#else
        // Gate full 3D box room raytracing to windows with resolvable screen footprint.
        vec3 room=(detailVis>.30 && dist<75. && !lite)?roomBehind(sat(wuv),vt,seed,on,1.4,px):mix(vec3(.22,.23,.24),vec3(.62,.52,.38),on)*(.75+seed*.45);
#endif
        float mull=1.-smoothstep(.006,.014,abs(wuv.x-.5));
        float pane=hash12(cid+.3);
        vec3 glassTint=curtain?mix(vec3(.025,.04,.05),vec3(.04,.05,.045),pane):vec3(.03);
        m.albedo=mix(wall,glassTint,win);
        m.rough=mix(.82,.03+pane*.04,win);
        m.f0=mix(.04,curtain?.11:.075,win);
        vec3 nWin=normalize(n+(tx*(pane-.5)+vAxisY*(hash12(cid+5.)-.5))*.02);
        n=normalize(mix(n,nWin,win));
        float fres=.04+.96*pow5(1.-max(dot(n,V),0.));
        m.emit=room*win*(1.-fres)*(1.-reveal)*.30*(1.-mull*.8);
        m.albedo=mix(m.albedo,vec3(.42,.43,.42),reveal*win+mull*win*detailVis);
        m.rough=mix(m.rough,.6,reveal*win);
        m.ao=1.-reveal*win*.5;
      }
      if (detailVis<.99) {
        // Far away the window grid shrinks below a pixel: show a photographed
        // facade of the same type instead of a flat average.
        vec3 far=mix(wall,vec3(.08,.1,.11),.45);
        float pick=fract(facade*7.3);
        int farSlot=curtain?(pick<.5?S_REFLECTIVE_GLASS:S_MIRROR_STAINLESS):
          ribbon || fsz.y>26.?S_FACADE_OFFICE_FAR:
          // Shop signs only on low buildings standing on the street, not on
          // the stacked segments of a tower.
          fsz.y<13. && vPos.y-fp.y<1. && pick<.6?S_FACADE_RETAIL_FAR:S_FACADE_APARTMENT_FAR;
        if (uSurfaceSheets>0 && surfaceReady(farSlot)) {
          float hf=0.;
          far=realSurface(surfaceTap(farSlot,fp,fdx,fdy),farSlot,tint,1.,0.,hf);
          float glassy=1.-smoothstep(.04,.16,lum(far));
          m.f0=mix(m.f0,curtain?.11:.06,(1.-detailVis)*(curtain?1.:glassy));
          m.rough=mix(m.rough,mix(.8,.08,curtain?1.:glassy),1.-detailVis);
        }
        m.albedo=mix(far,m.albedo,detailVis);
      }
    }
  } else if (kind==10) {
    // Apartment blocks are single boxes: the drawn facade sheet supplies the
    // balconies, windows, corridors and gable walls. Each face fits a whole
    // number of dwelling units across, two storeys per repeat.
    vec2 fsz=faceSize, fp=faceUV+fsz*.5, fdx=dFdx(fp), fdy=dFdy(fp);
    if (an.y>.55) {
      m.albedo=tint*.66;
      m.rough=.9;
      if (uSurfaceSheets>0 && surfaceReady(S_ROOF_MEMBRANE)) {
        m.albedo=realSurface(surfaceTap(S_ROOF_MEMBRANE,uvW,sdx,sdy),S_ROOF_MEMBRANE,tint*.66,1.,.01,surfH);
        relief=1.;
      }
    } else {
      int face=faceMask.z>.5?(nObj.z>0.?0:1):2;
      int aslot=apartmentSlot(int(vExtra.x+.5),face);
      vec2 rs=vec2(max(1.,floor(fsz.x/6.+.5))/fsz.x,1./5.84);
      float parapet=step(fsz.y-1.05,fp.y);
      float cell=hash12(floor(fp*rs*vec2(1.,2.))+vSeed*13.);
      if (uSurfaceSheets>0 && surfaceReady(aslot)) {
        vec4 t=surfaceTap(aslot,fp*rs,fdx*rs,fdy*rs);
        vec3 c=realSurface(t,aslot,tint,1.,.0,surfH)*(.96+cell*.08);
        // Glazing reads as glass: dark, bluish, smooth and reflective.
        float glass=smoothstep(.02,.07,t.b-t.r)*smoothstep(.62,.3,t.b)*(1.-parapet);
        m.albedo=mix(c,tint*.86,parapet);
        m.rough=mix(.82,.1,glass);
        m.f0=mix(.04,.06,glass);
      } else {
        // Before the sheet loads: storey bands and dark window strips.
        float storey=fract(fp.y/2.92);
        float win=step(.25,storey)*step(storey,.8)*step(.12,fract(fp.x*rs.x*2.))*step(fract(fp.x*rs.x*2.),.88);
        m.albedo=mix(tint*.92,vec3(.05,.06,.07),win*(1.-parapet));
        m.rough=mix(.85,.12,win);
      }
      m.albedo=mix(m.albedo,m.albedo*vec3(.72,.70,.64),wallBase*.5);
    }
#endif
#ifndef FULL_OUTDOOR
  } else if (kind==14) {
    vec3 tw=pow(abs(ng),vec3(3.));
    tw/=tw.x+tw.y+tw.z;
    vec3 q=vPos*.16;
    vec4 cX=det(q.zy), cY=det(q.xz+.31), cZ=det(q.xy+.67);
    float clumps=cX.g*tw.x+cY.g*tw.y+cZ.g*tw.z;
    float leaves=cX.a*tw.x+cY.a*tw.y+cZ.a*tw.z;
#ifndef OPAQUE_PURE
    float rim=1.-abs(dot(ng,V));
    if (!uMirrorPass && !lite && rim>.42 && clumps>mix(.98,.40,(rim-.42)/.58)) discard;
#endif
    float hgt=-clumps*.34+leaves*.05;
    vec3 r1=cross(sdpy,ng), r2=cross(ng,sdpx);
    float dt=dot(sdpx,r1);
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
    if (real) {
      m.albedo=realSurface(stex,slot,tint,1.,.012,surfH);
      m.rough=.78;
      m.ao=1.;
      relief=1.;
    } else {
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
      if (!lite) n=normalize(n+vAxisY*(rings-.5)*.025*(1.-seam));
    }
  } else if (kind==18 || kind==30 || kind==31) {
    m.rough=.88; m.sheen=.55; m.f0=.03;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,1.,.003,surfH);
      relief=.5;
    } else {
      vec2 w=uvW*vec2(210.,210.);
      float weave=(sin(w.x)*sin(w.y))*.5+.5;
      float fade=1.-smoothstep(.0015,.006,px);
      m.albedo=tint*(.9+det(uvW*2.).r*.12+(weave-.5)*.08*fade);
    }
  } else if (kind==20) {
    m.clear=.75; m.f0=.04;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,.6,.002,surfH);
      m.rough=.33;
      relief=.4;
    } else {
      float peel=det(uvW*9.).r;
      m.albedo=tint*(.97+peel*.04);
      m.rough=.30+peel*.06;
      if (!lite && px<.02) n=normalize(n+(vec3(det(uvW*9.+.01).r,0.,det(uvW*9.-.01).r)-peel)*.04);
    }
  } else if (kind==21) {
    m.sheen=.18; m.f0=.035;
    if (real) {
      m.albedo=realSurface(stex,slot,tint,1.,.003,surfH);
      m.rough=.72;
      relief=.5;
    } else {
      vec4 d2=det(uvW*4.);
      m.albedo=tint*(.9+d2.r*.14)+vec3(.012)*sat(n.y);
      m.rough=.68+d2.a*.1;
    }
  } else if (kind==9) {
    m.albedo=tint*.92; m.rough=.07; m.clear=1.; m.f0=.04;
    m.trans=.35;
    m.emit=tint*.22;
#endif
#ifndef CUTOUT_ONLY
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
#endif
  } else if (kind==26) {
    m.albedo=tint*.95; m.rough=.09; m.clear=.9;
    m.emit=tint*.05;
    if (real) {
      m.albedo=realSurface(stex,slot,m.albedo,.35,.002,surfH);
      relief=.3;
    }
#if !defined(OPAQUE_PURE) && !defined(CUTOUT_ONLY)
  } else if (kind==7) {
    float index=vExtra.x;
    vec2 tile=vec2(mod(index,uAtlasGrid.x),floor(index/uAtlasGrid.x));
    vec2 uv=(tile+vec2(mix(.01,.99,vUV.x),mix(.02,.98,1.-vUV.y)))/uAtlasGrid;
    if (dot(ng,V)<=0.) discard;
    alphaOut=texture(uAtlas,uv).a;
    if (alphaOut<.012) discard;
    m.albedo=tint*.92; m.rough=.6;
#endif
#ifndef FULL_OUTDOOR
  } else if (kind==0 || kind==22) {
    vec4 d2=det(uvW*2.3);
    float worn=an.y>.6?smoothstep(.55,.75,det(uvW*.6).r*.6+d2.r*.5):0.;
    m.albedo=mix(tint*(.95+d2.a*.08),tint*.55+vec3(.05),worn*.7);
    m.rough=.62+worn*.2;
    if (an.y>.6 && !lite && px<.015) {
      float bead=step(.985,det(uvW*31.).a)*(1.-worn);
      m.f0=mix(.04,.4,bead); m.rough=mix(m.rough,.2,bead);
    }
    if (real) {
      m.albedo=realSurface(stex,slot,m.albedo,kind==22?1.:.7,.003,surfH);
      relief=.5;
    }
#endif
  }

  // Relief from the texture's own shading (screen-space bump mapping).
  surfH*=relief*(1.-smoothstep(.004,.03,px));
  vec2 surfSlope=vec2(dFdx(surfH),dFdy(surfH));
  if (relief>0. && px<.03) {
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
#ifndef OPAQUE_PURE
  if (kind==27 && dot(xz,xz)>${CITY_RADIUS**2}.0) discard;
#endif
  if ((kind==1 || kind==5 || kind==15 || kind==22) && ng.y>.48 && (kind==15 || vPos.y>inkFloor-.055)) {
    vec2 mapPoint=vec2(xz.x-(cabinInk?cabinOrigin:lowerInk?uUnderX:0.),xz.y);
    vec2 inkUV=(mapPoint/uInkBounds+1.)*.5;
    if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
      // Single hardware-bilinear probe skips all 4-15 taps on dry floor pixels.
      vec4 inkProbe=texture(uInk,vec3(inkUV,vExtra.y));
      if (inkProbe.r+inkProbe.g>.002) {
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
        float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
        float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
        if (coverage>.08) {
          vec4 iDet=det(xz*.83);
          float rough0=iDet.r*.6+iDet.a*.4;
          float thr=.5+(rough0-.5)*.38;
          float aa=fwidth(coverage)*.9+.015;
          float mask=smoothstep(thr-aa,thr+aa,coverage);
          if (mask>.003) {
            vec3 cyan=vec3(.0,.31,.265), amber=vec3(.72,.095,.014), bossCol=vec3(.014,.010,.020);
            float thick=st.b;
            vec3 teamInk=(st.r>=st.g?cyan:amber)*(1.02-thick*.18);
            vec3 ink=mix(teamInk,bossCol*(1.05-thick*.15),smoothstep(.3,.7,bossMask));
            if (!lite) {
              vec3 coord=vec3(inkUV,vExtra.y);
              float e0=texture(uInk,coord+vec3(uInkTexel.x,0.,0.)).b;
              float s0=texture(uInk,coord+vec3(0.,uInkTexel.y,0.)).b;
              vec2 gradient=vec2(e0-thick,s0-thick)*1.8;
              vec4 wDet=det(xz*1.7+vec2(uClock*.02,0.));
              liquid=-gradient*.9+vec2(wDet.r-.5,wDet.b-.5)*.05;
              float bubble=smoothstep(.07,.02,wDet.g)*.25*(1.-thick);
              liquid+=vec2(bubble*.6);
            }
            m.albedo=mix(m.albedo,ink,mask);
            m.rough=mix(m.rough,mix(.21,.065,bossMask)+length(liquid)*.18,mask);
            m.metal=mix(m.metal,0.,mask);
            m.clear=mix(m.clear,mix(.32,.65,bossMask),mask);
            m.emit=mix(m.emit,mix(ink*.05,vec3(.042,.006,.014),bossMask),mask);
            m.ao=mix(m.ao,1.,mask*.6);
            m.f0=mix(m.f0,mix(.045,.075,bossMask),mask);
            n=normalize(mix(n,normalize(ng+vec3(liquid.x,0.,liquid.y)),mask));
            inked=mask;
          }
        }
      }
    }
  }

  // ---------- lighting ----------
  float nv=max(dot(n,V),1e-4);
  if (zoneInterior<.5 && (uWetLevel>.02 || uRaytrace>.5)) {
    float upWet=smoothstep(.65,.95,ng.y)*sat(1.-inked);
    if (upWet>.002) {
      float puddle=smoothstep(.42,.66,det(xz*.11).r);
      float wetAmt=sat(uWetLevel*upWet*(.45+.55*puddle)+(uRaytrace>.5?upWet*puddle*.22:0.));
      m.rough=mix(m.rough,.065,wetAmt);
      m.clear=max(m.clear,wetAmt*.58);
      m.f0=max(m.f0,.045*wetAmt);
      m.albedo=mix(m.albedo,m.albedo*.72,wetAmt*.65);
    }
  }
  vec3 R=reflect(-V,n);
  vec3 f0=mix(vec3(m.f0),m.albedo,m.metal);
  vec3 diffC=m.albedo*(1.-m.metal);
  float outdoor=1.-zoneInterior;
  vec3 direct=vec3(0.), ambient=vec3(0.);

#ifndef INTERIOR_ONLY
  if (outdoor>.001) {
    float nl=dot(n,uSun);
    // Skip shadow map lookups on opaque back-lit faces where direct sun is 0.
    float sh=(nl>.001 || m.trans>0.)?sunShadow(vPos,ng):0.;
    float wrap=m.trans>0.?sat((nl+.4)/1.4):sat(nl);
    vec3 sun=uSunColor*sh;
    if (sh>.001) {
      direct+=diffC*(1./PI)*sun*wrap;
      if (nl>.001) {
        direct+=sun*specGGX(n,V,uSun,f0,max(m.rough,.03));
        if (m.clear>0.) direct+=sun*specGGX(n,V,uSun,vec3(.04),.05)*m.clear;
      }
      if (m.trans>0.) direct+=diffC*m.trans*sun*pow(sat(dot(-V,uSun)),3.)*.9*sat(1.-nl);
    }
    vec3 irr=shDiffuse(n);
    float bounce=sat(-n.y)*.2;
    irr+=vec3(.36,.34,.30)*bounce;
    if (uBossRage>.01) irr=mix(irr,irr*vec3(1.12,.52,.58)+vec3(.04,.005,.01),uBossRage*.55);
    ambient+=diffC*irr*m.ao;
    vec3 spec=(m.rough>.72 && m.metal<.01)?irr:envSpec(R,m.rough);
    if (R.y<0.) spec*=mix(1.,.55,sat(-R.y*4.));
    bool hasPlanar=uReflectOn && !uMirrorPass && ng.y>.49 && abs(vPos.y)<.08;
    bool usedPlanar=false;
    vec3 planar=vec3(0.);
    if (hasPlanar && m.rough<.45) {
      planar=texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.035).rgb;
      usedPlanar=true;
      float w=(1.-smoothstep(.08,.40,m.rough))*mix(1.,.55,inked);
      spec=mix(spec,planar,w);
    }
    float so=m.ao>=.999?1.:sat(pow(nv+m.ao,exp2(-16.*m.rough-1.))-1.+m.ao);
    ambient+=spec*envBRDF(f0,m.rough,nv)*so;
    if (m.clear>0.) {
      vec3 cspec=hasPlanar?(usedPlanar?planar:texture(uReflection,gl_FragCoord.xy/uViewport+n.xz*.02).rgb):envSpec(R,.05);
      ambient+=cspec*(.04+.96*pow5(1.-nv))*m.clear*so;
    }
    if (m.sheen>0.) {float s1=1.-nv, s2=s1*s1; ambient+=m.albedo*m.sheen*(s2*s2)*irr*.9;}
    direct*=outdoor; ambient*=outdoor;
  }
#endif

#ifndef OUTDOOR_ONLY
  if (zoneInterior>.001) {
    vec3 dl=vec3(0.), sl=vec3(0.);
    vec3 amb=mix(vec3(.112,.112,.106),vec3(.094,.094,.089),n.y*.5+.5);
    float a=max(m.rough*m.rough,.002);
    bool inCabin=cabin;
#ifdef SAFE
    amb*=2.2;
#else
    // Hoist nearest-lamp indexing outside the 4-lamp loop (eliminates 75% of loop iterations).
    int cBest=0, cSecond=0, uRow=0;
    float cOrigin=0., uColBase=0.;
    bool inUnder=!inCabin && vPos.x>uUnderX*.5;
    if (inCabin) {
      cOrigin=vPos.x>uRailCabinX-640.?uRailCabinX:uCabinX;
      float lx=vPos.x-cOrigin, bd=1e9;
      for (int j=0;j<${CABIN_LAMPS.length};j++){float dd=abs(CABIN_LAMPS[j]-lx);if(dd<bd){bd=dd;cBest=j;}}
      cSecond=clamp(cBest+((lx>CABIN_LAMPS[cBest])?1:-1),0,${CABIN_LAMPS.length-1});
    } else if (inUnder) {
      float lx=vPos.x-uUnderX;
      float gx=clamp(floor((lx+57.2)/8.8),0.,12.);
      uColBase=-57.2+gx*8.8;
      for (int j=0;j<${LAMP_ROWS.length-1};j++) if (vPos.z>LAMP_ROWS[j]) uRow=j;
    }
    for (int k=0;k<4;k++) {
      vec3 c; float halfLen; float I;
      if (inCabin) {
        int col=k<2?cBest:cSecond;
        c=vec3(cOrigin+CABIN_LAMPS[col],uCabinY+2.66,(k%2==0)?-.68:.68);
        halfLen=.86; I=2.6;
      } else if (inUnder) {
        float colX=uColBase+float(k/2)*8.8;
        float rz=LAMP_ROWS[min(uRow+(k%2),${LAMP_ROWS.length-1})];
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
      float window=sat(1.-d2/(I*I*6.));
      if (window<=.001) continue;
      float invD=inversesqrt(d2);
      vec3 l=L*invD;
      float ndl=max(dot(n,l),0.);
      float atten=I/(d2+.35)*window*window;
      dl+=diffC*(1./PI)*ndl*atten;
      if (ndl>.001 && m.rough>=.72 && m.clear<=.001) {
        vec3 h=normalize(l+V);
        float a2=sat(a+.06*invD);
        sl+=ggxD(max(dot(n,h),0.),a2)*(a*a)/(a2*a2)*visSmith(nv,ndl,a2)*fresnel(f0,max(dot(V,h),0.))*ndl*atten;
      } else if (ndl>.001 || m.rough<.55) {
        vec3 L0=A-vPos, L1=B-vPos, Ld=L1-L0;
        float rl=dot(R,Ld);
        float t=sat((dot(R,L0)*rl-dot(L0,Ld))/max(dot(Ld,Ld)-rl*rl,1e-4));
        vec3 Ls=L0+t*Ld;
        float ds2=dot(Ls,Ls);
        float invDs=inversesqrt(ds2);
        vec3 ls=Ls*invDs;
        float nl=max(dot(n,ls),0.);
        if (nl>.001) {
          float a2=sat(a+.06*invDs);
          float norm=(a*a)/(a2*a2);
          vec3 h=normalize(ls+V);
          float specBase=nl*I/(ds2+.35)*window;
          sl+=ggxD(max(dot(n,h),0.),a2)*norm*visSmith(nv,nl,a2)*fresnel(f0,max(dot(V,h),0.))*specBase;
          if (m.clear>0.) {
            float ac=.05; float a3=sat(ac+.06*invDs);
            sl+=ggxD(max(dot(n,h),0.),a3)*(ac*ac)/(a3*a3)*visSmith(nv,nl,a3)*fresnel(vec3(.04),max(dot(V,h),0.))*specBase*m.clear;
          }
        }
      }
    }
#endif
    vec3 lampTint=vec3(1.,.95,.86);
    direct+=(dl+sl)*lampTint*zoneInterior;
    float ceilY=inCabin?uCabinY+2.7:uUnderY+6.9;
    vec3 iR=R;
    vec3 roomEnv=mix(vec3(.05,.052,.05),vec3(.16,.16,.15),sat(iR.y*.5+.5));
    if (iR.y>.02 && (m.rough<.78 || m.clear>0.)) {
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
        float zb=min(min(min(abs(hp.z+39.),abs(hp.z+28.)),min(abs(hp.z+10.5),abs(hp.z))),
                     min(min(abs(hp.z-10.5),abs(hp.z-28.)),abs(hp.z-39.)));
        strip=smoothstep(1.1+spread,1.05,cx)*smoothstep(.2+spread,.12,zb);
      }
      roomEnv+=vec3(1.,.95,.86)*strip*mix(3.,.6,sat(m.rough*2.))*exp(-tt*.04);
    }
    float so=m.ao>=.999?1.:sat(pow(nv+m.ao,exp2(-16.*m.rough-1.))-1.+m.ao);
    vec3 ispec=roomEnv*envBRDF(f0,m.rough,nv)*so;
    if (m.clear>0.) ispec+=roomEnv*(.04+.96*pow5(1.-nv))*m.clear*so;
    vec3 iamb=diffC*amb*m.ao*(inCabin?1.25:1.)+ispec;
    if (m.sheen>0.) {float s1=1.-nv, s2=s1*s1; iamb+=m.albedo*m.sheen*(s2*s2)*amb;}
    ambient+=iamb*zoneInterior;
  }
#endif

  vec3 col=direct+ambient+m.emit;

  // ---------- atmosphere ----------
  vec3 dir=-V;
  float fogAmt=0.;
#ifndef INTERIOR_ONLY
  if (outdoor>.001) {
    float fall=mix(.022,.004,uRainLevel);
    float h0=uEye.y, dy=vPos.y-uEye.y;
    float integral=abs(dy)>.01?(exp(-fall*h0)-exp(-fall*vPos.y))/(fall*dy):exp(-fall*h0);
    float density=mix(.0021,.072,uRainLevel);
    fogAmt=1.-exp(-density*dist*max(integral,0.));
    // A shortened draw distance (settings) fades the city into the haze
    // before the chunks stop drawing.
    if (uDrawFar>0.) fogAmt=max(fogAmt,smoothstep(uDrawFar*.6,uDrawFar*.97,dist));
    if (fogAmt>.002) {
      vec3 fdir=normalize(vec3(dir.x,max(dir.y,.035),dir.z));
      vec3 fogCol=mix(fogEnv(fdir)+uSunColor*.06*pow(sat(dot(dir,uSun)),8.)*(1.-uRainLevel),vec3(.13,.155,.185),uRainLevel*.55);
      col=mix(col,fogCol,fogAmt*outdoor);
    }
  }
#endif
#ifndef OUTDOOR_ONLY
  if (zoneInterior>.001) {
    float iFog=1.-exp(-dist*.011);
    col=mix(col,vec3(.07,.075,.072),iFog*zoneInterior*.55);
    fogAmt=max(fogAmt,iFog*.55*zoneInterior);
  }
#endif

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
// 6-tap IGN-rotated golden-angle hemisphere AO (incremental 2D rotation + const radii).
export const SSAO_FRAGMENT=`#version 300 es
precision highp float;
uniform highp sampler2D uDepth;
uniform vec2 uInvSize;
uniform vec4 uProj;
uniform float uRadius;
uniform float uIntensity;
out vec4 frag;
float lin(float d){return (uProj.z*uProj.w)/(uProj.w-d*(uProj.w-uProj.z));}
vec3 viewPosZ(vec2 uv,float z){return vec3((uv*2.-1.)*uProj.xy*z,-z);}
const float AO_R[6]=float[6](.288675,.5,.645497,.763763,.866025,.957427);
void main(){
  vec2 uv=gl_FragCoord.xy*uInvSize;
  float raw=textureLod(uDepth,uv,0.).r;
  if (raw>=.99999) {frag=vec4(1.);return;}
  float z=lin(raw);
  vec3 P=viewPosZ(uv,z);
  float zr=lin(textureLod(uDepth,uv+vec2(uInvSize.x,0.),0.).r);
  float zl=lin(textureLod(uDepth,uv-vec2(uInvSize.x,0.),0.).r);
  float zt=lin(textureLod(uDepth,uv+vec2(0.,uInvSize.y),0.).r);
  float zb=lin(textureLod(uDepth,uv-vec2(0.,uInvSize.y),0.).r);
  vec3 dx=abs(zr-z)<abs(z-zl)?viewPosZ(uv+vec2(uInvSize.x,0.),zr)-P:P-viewPosZ(uv-vec2(uInvSize.x,0.),zl);
  vec3 dy=abs(zt-z)<abs(z-zb)?viewPosZ(uv+vec2(0.,uInvSize.y),zt)-P:P-viewPosZ(uv-vec2(0.,uInvSize.y),zb);
  vec3 N=normalize(cross(dx,dy));
  float radius=uRadius*mix(1.,2.4,smoothstep(8.,60.,z));
  float sr=min(radius/(z*uProj.y)*.5,.09);
  float invAspect=uProj.y/uProj.x;
  float noise=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));
  float ang=noise*6.2831853;
  vec2 dir=vec2(cos(ang),sin(ang));
  const mat2 G=mat2(-.73736888,.67549029,-.67549029,-.73736888);
  float sum=0.;
  float invR2=1./(radius*radius);
  for (int i=0;i<6;i++){
    vec2 off=vec2(dir.x*invAspect,dir.y)*(sr*AO_R[i]);
    dir=G*dir;
    vec2 qv=uv+off;
    vec3 Q=viewPosZ(qv,lin(textureLod(uDepth,qv,0.).r));
    vec3 v=Q-P;
    float vv=dot(v,v);
    float fall=max(0.,1.-vv*invR2);
    sum+=max(0.,dot(v,N)-.003*z)*fall/(vv+.012);
  }
  float ao=max(0.,1.-sum*(uIntensity/3.));
  frag=vec4(pow(ao,1.25),0.,0.,1.);
}`;

// 5-tap depth-aware bilateral blur (wide 1.6x stride, ~1.8x faster than 9-tap).
export const BLUR_FRAGMENT=`#version 300 es
precision highp float;
uniform sampler2D uAO;
uniform highp sampler2D uDepth;
uniform vec2 uStep;
uniform vec4 uProj;
out vec4 frag;
float lin(float d){return (uProj.z*uProj.w)/(uProj.w-d*(uProj.w-uProj.z));}
void main(){
  vec2 size=vec2(textureSize(uAO,0));
  vec2 uv=gl_FragCoord.xy/size;
  float zc=lin(textureLod(uDepth,uv,0.).r);
  float invRange=1./(zc*.045+.04);
  float sum=textureLod(uAO,uv,0.).r, wsum=1.;
  vec2 s1=uStep*1.35, s2=uStep*2.9;
  for (int k=0;k<4;k++) {
    vec2 o=uv+(k==0?-s2:k==1?-s1:k==2?s1:s2);
    float gw=(k==1 || k==2)?.72:.36;
    float z=lin(textureLod(uDepth,o,0.).r);
    float w=gw*max(0.,1.-abs(z-zc)*invRange);
    sum+=textureLod(uAO,o,0.).r*w;
    wsum+=w;
  }
  frag=vec4(sum/max(wsum,1e-4),0.,0.,1.);
}`;

// Dual-Kawase bloom downsample: 5-tap Karis on first pass, 4-tap bilinear box after.
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
  vec3 d0=tap(uv+uTexel*vec2(-1.,-1.)), d1=tap(uv+uTexel*vec2(1.,-1.));
  vec3 d2=tap(uv+uTexel*vec2(-1., 1.)), d3=tap(uv+uTexel*vec2(1., 1.));
  vec3 c;
  if (uFirst) {
    vec3 m=tap(uv);
    float w0=karis(d0), w1=karis(d1), w2=karis(d2), w3=karis(d3), wm=karis(m)*2.;
    c=(d0*w0+d1*w1+d2*w2+d3*w3+m*wm)/(w0+w1+w2+w3+wm);
    float br=max(max(c.r,c.g),c.b);
    float knee=uThreshold*.6;
    float soft=clamp(br-uThreshold+knee,0.,2.*knee);
    soft=soft*soft/(4.*knee+1e-4);
    c*=max(soft,br-uThreshold)/max(br,1e-4);
  } else {
    c=(d0+d1+d2+d3)*.25;
  }
  frag=vec4(c,1.);
}`;

// Dual-Kawase 4-tap bilinear tent upsample (~2.25x faster than 9-tap).
export const UP_FRAGMENT=`#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uWeight;
out vec4 frag;
void main(){
  vec2 uv=gl_FragCoord.xy/vec2(textureSize(uSrc,0)*2);
  vec2 h=uTexel*.5;
  vec3 c=textureLod(uSrc,uv+vec2(-h.x,-h.y),0.).rgb
        +textureLod(uSrc,uv+vec2( h.x,-h.y),0.).rgb
        +textureLod(uSrc,uv+vec2(-h.x, h.y),0.).rgb
        +textureLod(uSrc,uv+vec2( h.x, h.y),0.).rgb;
  frag=vec4(c*(uWeight*.25),1.);
}`;

// Composite pass: single-AO fetch + subpixel FXAA + CAS + ULTRA Real-Time Raytracing
// (analytic vRay reconstruction, zero-division screen-space linear DDA SSR + binary search,
// zero-division contact shadows, 1-bounce SSGI & light shafts).
export const COMPOSITE_FRAGMENT=`#version 300 es
precision highp float;
${COMMON}
in vec2 vUV;
#ifndef NO_RAYTRACE
in vec3 vRay;
#endif
uniform sampler2D uColor;
uniform sampler2D uAO;
uniform sampler2D uBloom;
uniform highp sampler2D uDepth;
uniform vec2 uTexel;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uAOStrength;
uniform float uTime;
uniform float uInterior;
uniform float uRaytrace;
uniform float uBossRage;
uniform float uWetLevel;
uniform float uRainLevel;
uniform mat4 uVP;
uniform vec2 uDepthAB;
uniform vec3 uRayDX;
uniform vec3 uRayDY;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uSunUV;
uniform vec4 uHSun;
uniform bool uAOOn;
uniform bool uBloomOn;
uniform bool uFXAA;
out vec4 frag;
float pluma(vec3 c){float l=lum(c)*uExposure;return l/(1.+l);}
vec4 toH(vec4 c){return vec4((c.xyz+c.w)*.5,c.w);}
void main(){
  vec2 uv=vUV;
  ivec2 iSize=textureSize(uColor,0), iMax=iSize-1;
  vec2 fSize=vec2(iSize);
  ivec2 ipx=clamp(ivec2(gl_FragCoord.xy),ivec2(0),iMax);
  int xL=max(ipx.x-1,0), xR=min(ipx.x+1,iMax.x);
  int yD=max(ipx.y-1,0), yU=min(ipx.y+1,iMax.y);
  vec4 cM=texelFetch(uColor,ipx,0);
  vec3 cN=texelFetch(uColor,ivec2(ipx.x,yD),0).rgb;
  vec3 cS=texelFetch(uColor,ivec2(ipx.x,yU),0).rgb;
  vec3 cW=texelFetch(uColor,ivec2(xL,ipx.y),0).rgb;
  vec3 cE=texelFetch(uColor,ivec2(xR,ipx.y),0).rgb;
  vec3 col=cM.rgb;
  if (uFXAA) {
    float lM=pluma(col), lN=pluma(cN), lS=pluma(cS), lW=pluma(cW), lE=pluma(cE);
    float lo=min(lM,min(min(lN,lS),min(lW,lE))), hi=max(lM,max(max(lN,lS),max(lW,lE)));
    float contrast=hi-lo;
    if (contrast>max(.032,hi*.085)) {
      float lNW=pluma(texelFetch(uColor,ivec2(xL,yD),0).rgb);
      float lNE=pluma(texelFetch(uColor,ivec2(xR,yD),0).rgb);
      float lSW=pluma(texelFetch(uColor,ivec2(xL,yU),0).rgb);
      float lSE=pluma(texelFetch(uColor,ivec2(xR,yU),0).rgb);
      vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));
      float reduce=max((lNW+lNE+lSW+lSE)*.03125,.0078125);
      float rcp=1./(min(abs(dir.x),abs(dir.y))+reduce);
      dir=clamp(dir*rcp,-4.,4.)*uTexel;
      vec3 aaA=.5*(textureLod(uColor,uv+dir*(1./3.-.5),0.).rgb+textureLod(uColor,uv+dir*(2./3.-.5),0.).rgb);
      float lA=pluma(aaA);
      col=(lA<lo || lA>hi)?mix(col,aaA,.45):aaA;
    }
  }
  vec3 mn=min(col,min(min(cN,cS),min(cW,cE)));
  vec3 mx=max(col,max(max(cN,cS),max(cW,cE)));
  vec3 amp=sqrt(clamp(min(mn,max(vec3(0.),2.-mx))/max(mx,vec3(1e-4)),0.,1.));
  vec3 w=-amp*.075;
  col=max((col+(cN+cS+cW+cE)*w)/(1.+4.*w),vec3(0.));
  vec2 d=uv-.5;
  float r2=dot(d,d);
  if (r2>.035) {
    vec2 ca=d*r2*.005;
    col.r=mix(col.r,textureLod(uColor,uv-ca,0.).r,.7);
    col.b=mix(col.b,textureLod(uColor,uv+ca,0.).b,.7);
  }
  if (uAOOn) {
    float ao=textureLod(uAO,uv,0.).r;
    col*=mix(1.,ao,sat(cM.a)*uAOStrength);
  }

  // ULTRA Real-Time Raytracing Stage: Homogeneous Accelerating SSR, CPU-Hoisted Contact Shadows, 1-Bounce SSGI & Light Shafts.
#ifndef NO_RAYTRACE
  if (uRaytrace>.5) {
    float zC=texelFetch(uDepth,ipx,0).r;
    float invRL=inversesqrt(dot(vRay,vRay));
    vec3 V=-vRay*invRL;
    if (zC<.99992) {
      float zView=uDepthAB.x/(uDepthAB.y-zC);
      float camDist=zView/invRL;
      float zL=texelFetch(uDepth,ivec2(xL,ipx.y),0).r;
      float zR=texelFetch(uDepth,ivec2(xR,ipx.y),0).r;
      float zD=texelFetch(uDepth,ivec2(ipx.x,yD),0).r;
      float zU=texelFetch(uDepth,ivec2(ipx.x,yU),0).r;
      vec3 pxDX=uRayDX*uTexel.x, pxDY=uRayDY*uTexel.y;
      bool useR=abs(zR-zC)<abs(zC-zL);
      float zX=uDepthAB.x/(uDepthAB.y-(useR?zR:zL));
      vec3 dX=vRay*(useR?(zX-zView):(zView-zX))+pxDX*zX;
      bool useU=abs(zU-zC)<abs(zC-zD);
      float zY=uDepthAB.x/(uDepthAB.y-(useU?zU:zD));
      vec3 dY=vRay*(useU?(zY-zView):(zView-zY))+pxDY*zY;
      vec3 N=normalize(cross(dX,dY));
      if (dot(N,V)<0.) N=-N;
      float ign=hash12(gl_FragCoord.xy+fract(uTime*11.7)*vec2(173.,293.));
      // Pixel-scaled homogeneous UVZ origin with zero mat4 multiply (clip.w == zView exactly).
      vec4 hP=vec4(uv*fSize,zC,1.)*zView;
      vec4 hN=toH(uVP*vec4(N,0.));
      hN.xy*=fSize;
      vec2 bMin=fSize*.002, bMax=fSize*.998;

      // 1. Adaptive-Budget Homogeneous SSR: crisp 20-step smooth trajectory on glossy/wet surfaces
      // (reflWeight > 0.09) with exact 1-by-1 steps 1..10, and fast 10-step budget on matte/faint surfaces.
      vec3 R=reflect(-V,N);
      float ndv=max(dot(N,V),0.);
      float fresnel=mix(.045,.88,pow5(1.-ndv));
      float upFloor=smoothstep(.65,.95,abs(N.y));
      float wetGloss=sat(.22+uWetLevel*.55+uBossRage*.25);
      float reflWeight=sat(fresnel*(upFloor*(.35+wetGloss*.65)+(1.-upFloor)*.38))*smoothstep(140.,18.,camDist);
      if (reflWeight>.025) {
        vec3 rtHitCol=mix(mix(vec3(.22,.34,.52),vec3(.22,.02,.03),uBossRage),vec3(.04,.02,.03),sat(-R.y*2.));
        float rtAlpha=0.;
        float stepLen=clamp(camDist*.035,.18,1.15);
        vec4 hStep=toH(uVP*vec4(R*stepLen,0.));
        hStep.xy*=fSize;
        vec4 hCur=hP+hN*.05;
        vec4 hPrev=hCur;
        bool hiRefl=reflWeight>.09;
        int maxSteps=hiRefl?20:10;
        int binSteps=hiRefl?3:2;
        for (int i=1;i<=20;i++) {
          if (i>maxSteps) break;
          float sCur=hiRefl
            ?(i<=10?(1.+float(i)*.10)*(i==1?.5+ign*.5:1.):(2.05+float(i-11)*.25))
            :(i<=5?(1.+float(i)*.12)*(i==1?.5+ign*.5:1.):(1.80+float(i-6)*.55));
          hCur=hPrev+hStep*sCur;
          if (hCur.w<=.05) break;
          float invW=1./hCur.w;
          vec2 spx=hCur.xy*invW;
          if (spx.x<=bMin.x || spx.x>=bMax.x || spx.y<=bMin.y || spx.y>=bMax.y) break;
          float sceneD=texelFetch(uDepth,ivec2(spx),0).r;
          float diff=hCur.z*invW-sceneD;
          if (diff>0. && diff<.028 && sceneD<.9999) {
            vec4 lo=hPrev, hi=hCur;
            for (int b=0;b<3;b++) {
              if (b>=binSteps) break;
              vec4 mid=(lo+hi)*.5;
              float mInv=1./mid.w;
              float msd=texelFetch(uDepth,clamp(ivec2(mid.xy*mInv),ivec2(0),iMax),0).r;
              if (mid.z*mInv>msd) hi=mid; else lo=mid;
            }
            vec2 fuv=clamp((hi.xy/hi.w)*uTexel,vec2(.002),vec2(.998));
            float edgeFade=sat(min(min(fuv.x,1.-fuv.x),min(fuv.y,1.-fuv.y))*12.);
            rtHitCol=textureLod(uColor,fuv,0.).rgb;
            rtAlpha=edgeFade;
            break;
          }
          hPrev=hCur;
        }
        col=mix(col,max(col,rtHitCol*1.08),reflWeight*mix(.28,1.,rtAlpha));
      }

      // 2. CPU-Hoisted Homogeneous Micro Contact Shadows with physical blocker-distance penumbra (6 steps)
      if (uInterior<.85 && dot(N,uSun)>.05 && camDist<58.) {
        float cShadow=1.;
        vec4 hc=hP+hN*.03+uHSun*(ign*.43);
        for (int s=1;s<=6;s++) {
          hc+=uHSun;
          if (hc.w<=.05) break;
          float invW=1./hc.w;
          vec2 spx=hc.xy*invW;
          if (spx.x<0. || spx.x>=fSize.x || spx.y<0. || spx.y>=fSize.y) break;
          float sRay=hc.z*invW;
          float sDepth=texelFetch(uDepth,ivec2(spx),0).r;
          if (sRay>sDepth && (sRay-sDepth)<.0045) {
            cShadow=mix(.34,.78,float(s-1)*.18);
            break;
          }
        }
        col*=mix(1.,cShadow,(1.-uInterior)*smoothstep(58.,12.,camDist)*.72);
      }

      // 3. 1-Bounce Chromatic Raytraced Global Illumination (6 Golden-Angle Hemisphere Rays / SSGI)
      vec3 gi=vec3(0.);
      float giSpan=clamp(camDist*.08,.65,3.2);
      float a0=ign*6.283;
      vec2 gRot=vec2(cos(a0),sin(a0));
      const mat2 GG=mat2(-.73736888,.67549029,-.67549029,-.73736888);
      float giPxStep=giSpan*(28./6.);
      ivec2 gMin=ivec2(1), gMax=iMax-1;
      for (int k=0;k<6;k++) {
        vec2 offPx=gRot*(float(k+1)*giPxStep);
        gRot=GG*gRot;
        ivec2 gpx=clamp(ipx+ivec2(offPx),gMin,gMax);
        float gd=texelFetch(uDepth,gpx,0).r;
        if (gd<.9998) {
          vec2 dpx=vec2(gpx-ipx);
          float gz=uDepthAB.x/(uDepthAB.y-gd);
          vec3 gDir=vRay*(gz-zView)+(pxDX*dpx.x+pxDY*dpx.y)*gz;
          float ndg=dot(N,gDir);
          if (ndg>0.) {
            float len2=dot(gDir,gDir);
            float align=min(1.,ndg*inversesqrt(max(len2,1e-8)));
            vec3 sampleCol=texelFetch(uColor,gpx,0).rgb;
            float sl=lum(sampleCol);
            vec3 bounceCol=max(mix(vec3(sl),sampleCol,1.22),vec3(0.));
            gi+=bounceCol*(align/(1.+(len2+.25)*.20));
          }
        }
      }
      gi=min(gi*(.19*(1.-uBossRage*.25)),vec3(1.8));
      col+=col*gi*.58+gi*.14;
    }

    // 4. Volumetric Sun / Crimson-Storm Light Shafts (CPU-hoisted sun screen UV)
    if (uInterior<.8 && uSunUV.z>.05) {
      float sunAlign=max(dot(-V,uSun),0.);
      if (sunAlign>.35) {
        vec2 delta=(uv-uSunUV.xy)*.14;
        float shaft=0.;
        vec2 tuv=uv;
        for (int g=0;g<5;g++) {
          tuv-=delta;
          if (tuv.x>0. && tuv.x<1. && tuv.y>0. && tuv.y<1.) {
            float td=texelFetch(uDepth,ivec2(tuv*fSize),0).r;
            shaft+=step(.999,td);
          }
        }
        vec3 shaftTint=mix(vec3(1.,.90,.72),vec3(.88,.10,.09),uBossRage);
        col+=shaftTint*(shaft*.045)*pow(sunAlign,5.)*(1.-uInterior);
      }
    }
  }
#endif

  if (uBloomOn) col+=textureLod(uBloom,uv,0.).rgb*uBloomStrength;
  if (uRainLevel>.01 && uInterior<.8) {
    float rainStrength=uRainLevel*(1.-uInterior*.75);
    float s0=fract(sin(floor(uv.x*185.+uv.y*24.)*12.9898)*43758.5453);
    float dropA=smoothstep(.92,1.,sin((uv.y*12.+uv.x*2.4+uTime*8.5+s0*6.28)*3.14159));
    float s1=fract(sin(floor(uv.x*290.-uv.y*18.)*78.233)*19432.23);
    float dropB=smoothstep(.94,1.,sin((uv.y*18.+uv.x*3.1+uTime*11.2+s1*6.28)*3.14159));
    float streak=(dropA*.55+dropB*.45)*rainStrength;
    col=mix(col,vec3(.24,.28,.33),rainStrength*.24)+vec3(.42,.49,.56)*streak*.42;
  }
  vec3 c=grade(col*uExposure);
  c*=mix(1.,.70,smoothstep(.10,.62,r2*1.5));
  float grain=hash12(gl_FragCoord.xy+fract(uTime*7.31)*vec2(311.,173.))-.5;
  c+=grain*.020*(1.-c*.7);
  frag=vec4(c,1.);
}`;

// ---------- lightweight path ----------
export const LITE_VERTEX=`#version 300 es
precision highp float;
invariant gl_Position;
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
flat out vec4 vTint;
flat out vec4 vExtra;
flat out vec3 vSlots;
void main(){
  mat3 m=mat3(a0.xyz,a1.xyz,a2.xyz);
  vec4 p=vec4(m*aPos+a3.xyz,1.);
  vPos=p.xyz;
  vNormal=normalize(a0.xyz*(aNormal.x/max(dot(a0.xyz,a0.xyz),1e-12))
                   +a1.xyz*(aNormal.y/max(dot(a1.xyz,a1.xyz),1e-12))
                   +a2.xyz*(aNormal.z/max(dot(a2.xyz,a2.xyz),1e-12)));
  vUV=aUV;
  vTint=aTint;
  vExtra=aExtra;
  vSlots=vec3(a0.w,a1.w,a2.w);
  p.x+=uDrawOffset;
  gl_Position=uMergeStairs && aExtra.z>.5?vec4(2.,2.,2.,1.):uVP*p;
}`;

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
#ifndef FAST_SLOT
flat in vec3 vSize;
flat in float vSeed;
#endif
flat in vec3 vSlots;
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
uniform float uBossRage;
uniform float uRainLevel;
out vec4 frag;
${SURFACE_CORE}
// The texture's colour against the surface's own (sRGB, no relief).
vec3 liteSurface(vec3 t,int slot,vec3 base){
  vec3 mean=max(surfaceMean(slot),vec3(.02));
  return mix(base*t/mean,t*(sfLum(base)/max(sfLum(mean),.02)),S_TAKE[slot]);
}
float sat(float x){return clamp(x,0.,1.);}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  return cell.a>0. && abs(height-bed)<tolerance?cell:vec4(0.);
}
void main(){
  vec3 ng=normalize(vNormal);
  vec3 V=uEye-vPos;
  float dist=length(V);
  V/=dist;
  int kind=int(vTint.a+.5);
#ifndef OPAQUE_PURE
  if (kind==22 && ng.y<.5) discard;
#endif
  vec3 tint=vTint.rgb;
  vec2 xz=vPos.xz;
  float zoneInterior=vPos.x>uUnderX*.5?1.:smoothstep(-.4,-3.2,vPos.y);
  float far=max(smoothstep(uFogRange.x,uFogRange.y,dist),uRainLevel*(1.-exp(-max(0.,dist-2.5)*.075)));
  float haze=mix(far,max(far,.55*(1.-exp(-dist*.011))),zoneInterior);
  vec3 outFog=mix(mix(uFog,vec3(.24,.28,.33),uRainLevel*.88),vec3(.085,.018,.022),uBossRage*.9);
  vec3 fogCol=mix(outFog,vec3(.07,.075,.072),zoneInterior);

#ifndef OPAQUE_PURE
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
#endif
  if (kind==25) {
    float rim=pow(1.-max(0.,dot(ng,V)),2.5);
    vec3 col=min(tint*(1.05+.3*max(dot(ng,uSun),0.))+vec3(.5,.42,.5)*rim,vec3(1.));
    frag=vec4(mix(col,fogCol,haze),1.);
    return;
  }
#ifndef OPAQUE_PURE
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
#endif

  vec3 an=abs(ng);
  vec3 col=tint*.93;
  float glow=0.;
  // Real surface texture: a single tap and no relief in the lightweight modes.
  vec2 uvW=an.y>.6?xz:(an.x>an.z?vPos.zy:vPos.xy);
  vec2 sdx=dFdx(uvW), sdy=dFdy(uvW);
#ifdef FAST_SLOT
  int slot=uSurfaceSheets>0?int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5)):-1;
#else
  bool cabinZone=vPos.x>uCabinX-640., lowerZone=vPos.x>uUnderX*.5 && !cabinZone;
  int slot=uSurfaceSheets>0?surfaceFor(kind,tint,ng,vSeed,vSize,uShape,lowerZone,cabinZone,vExtra.y,
    vPos.y-(cabinZone?uCabinY:lowerZone?uUnderY:0.)):-1;
#endif
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
  else if (kind==10) {
    if (an.y>.55) col=tint*.66;
    else {
      // Fronts face the street, toward the middle of the city.
      int face=dot(ng.xz,-vPos.xz)>0.?0:1;
      int aslot=apartmentSlot(int(vExtra.x+.5),face);
      vec2 ap=vec2((an.x>an.z?vPos.z:vPos.x)/6.,vPos.y/5.84);
      col=uSurfaceSheets>0 && surfaceReady(aslot)?liteSurface(surfaceTap(aslot,ap,dFdx(ap),dFdy(ap)).rgb,aslot,tint):tint*.9;
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
      // Fast-path bilinear probe skips 4 texelFetch on dry floor pixels.
      vec4 inkProbe=texture(uInk,vec3(inkUV,vExtra.y));
      if (inkProbe.r+inkProbe.g>.002) {
        ivec2 size=textureSize(uInk,0).xy;
        int layer=int(vExtra.y);
        float clearance=kind==15 || layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
        // Four taps keep the ink edge smooth even at 300 lines.
        vec2 grid=inkUV*vec2(size)-.5;
        ivec2 pixel=ivec2(floor(grid));
        vec2 part=fract(grid);
        part=part*part*(3.-2.*part);
          vec4 ca=filmCell(pixel,size,layer,vPos.y,clearance);
          vec4 cb=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
          vec4 cc=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
          vec4 cd=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
          vec3 st=mix(mix(ca.rgb,cb.rgb,part.x),mix(cc.rgb,cd.rgb,part.x),part.y);
          float bossMask=mix(mix(step(1.35,ca.r+ca.g),step(1.35,cb.r+cb.g),part.x),mix(step(1.35,cc.r+cc.g),step(1.35,cd.r+cd.g),part.x),part.y);
          float coverage=mix(mix(min(1.,ca.r+ca.g),min(1.,cb.r+cb.g),part.x),mix(min(1.,cc.r+cc.g),min(1.,cd.r+cd.g),part.x),part.y);
          float mask=smoothstep(.42,.58,coverage);
          if (mask>.003) {
            vec3 teamInk=(st.r>=st.g?vec3(.063,.847,.745):vec3(1.,.424,.2))*(1.-st.b*.16);
            vec3 bossInk=vec3(.026,.018,.036)*(1.-st.b*.12);
            vec3 ink=mix(teamInk,bossInk,smoothstep(.3,.7,bossMask));
            col=mix(col,ink,mask);
            inked=mask;
          }
      }
    }
  }

  float ndl=max(dot(ng,uSun),0.);
  vec3 daySun=vec3(.60,.63,.69)+vec3(.50,.45,.36)*ndl+.06*ng.y;
  vec3 stormSun=vec3(.18,.075,.08)+vec3(.24,.06,.05)*ndl+.02*ng.y;
  vec3 sunLight=mix(daySun,stormSun,uBossRage);
  vec3 roomLight=vec3(.74,.73,.70)+.16*ng.y;
  vec3 light=mix(sunLight,roomLight,zoneInterior);
  light=mix(light,vec3(1.),max(glow,inked*.4));
  col*=light;
  if (kind==9 || kind==26) col+=tint*.08;
  frag=vec4(mix(col,fogCol,haze),1.);
}`;

// Minimal 4-varying architectural shader for lite and ultra-lite modes (kinds 0, 1, 2, 3, 4, 13, 15, 19, 29).
export const ARCH_LITE_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec3 vPos;
in vec3 vNormal;
flat in vec4 vTint;
flat in vec4 vSlots;
uniform vec3 uEye;
uniform vec3 uSun;
uniform sampler2DArray uInk;
uniform float uUnderX;
uniform float uUnderY;
uniform float uCabinX;
uniform float uRailCabinX;
uniform float uCabinY;
uniform vec2 uInkBounds;
uniform vec3 uFog;
uniform vec2 uFogRange;
uniform float uBossRage;
uniform float uRainLevel;
out vec4 frag;
${SURFACE_CORE}
vec3 liteSurface(vec3 t,int slot,vec3 base){
  vec3 mean=max(surfaceMean(slot),vec3(.02));
  return mix(base*t/mean,t*(sfLum(base)/max(sfLum(mean),.02)),S_TAKE[slot]);
}
vec4 filmCell(ivec2 pixel,ivec2 size,int layer,float height,float tolerance){
  vec4 cell=texelFetch(uInk,ivec3(clamp(pixel,ivec2(0),size-1),layer),0);
  float bed=${f(FILM_HEIGHT_ORIGIN)}+(round(cell.a*255.)-1.)*${f(FILM_HEIGHT_STEP)};
  return cell.a>0. && abs(height-bed)<tolerance?cell:vec4(0.);
}
void main(){
  vec3 ng=normalize(vNormal);
  float dist=length(uEye-vPos);
  int kind=int(vTint.a+.5);
  vec3 col=vTint.rgb*.93;
  float glow=0.;
  if (kind==3) {col=min(vTint.rgb*1.18+.05,vec3(1.));glow=1.;}
  else if (kind==13) col=vTint.rgb*(.9-.12*step(.9,fract(vPos.y/.296)));
  else if (kind==9) col=vTint.rgb*.98;
  if (uSurfaceSheets>0) {
    int slot=int(floor((ng.y>.6?vSlots.x:ng.y<-.6?vSlots.z:vSlots.y)+.5));
    if (surfaceReady(slot)) {
      vec3 an=abs(ng);
      vec2 uvW=an.y>.6?vPos.xz:(an.x>an.z?vPos.zy:vPos.xy);
      vec4 stex=surfaceTap(slot,uvW,dFdx(uvW),dFdy(uvW));
      col=liteSurface(stex.rgb,slot,col);
    }
  }
  float inked=0.;
  if ((kind==1 || kind==15) && ng.y>.48) {
    float lyr=vSlots.w;
    bool lowerInk=lyr>=1.5 && lyr<3.5, cabinInk=lyr>4.5;
    float inkFloor=cabinInk?uCabinY:lowerInk?uUnderY:0.;
    if (kind==15 || vPos.y>inkFloor-.055) {
      float originX=cabinInk?(lyr>5.5?uRailCabinX:uCabinX):lowerInk?uUnderX:0.;
      vec2 inkUV=(vec2(vPos.x-originX,vPos.z)/uInkBounds+1.)*.5;
      if (all(greaterThan(inkUV,vec2(0))) && all(lessThan(inkUV,vec2(1)))) {
        vec4 inkProbe=texture(uInk,vec3(inkUV,lyr));
        if (inkProbe.r+inkProbe.g>.002) {
          ivec2 size=textureSize(uInk,0).xy;
          int layer=int(lyr);
          float clearance=kind==15 || layer==4?.207:${f(FILM_HEIGHT_TOLERANCE)};
          vec2 grid=inkUV*vec2(size)-.5;
          ivec2 pixel=ivec2(floor(grid));
          vec2 part=fract(grid);
          part=part*part*(3.-2.*part);
          vec4 a=filmCell(pixel,size,layer,vPos.y,clearance);
          vec4 b=filmCell(pixel+ivec2(1,0),size,layer,vPos.y,clearance);
          vec4 c=filmCell(pixel+ivec2(0,1),size,layer,vPos.y,clearance);
          vec4 d=filmCell(pixel+ivec2(1,1),size,layer,vPos.y,clearance);
          vec3 st=mix(mix(a.rgb,b.rgb,part.x),mix(c.rgb,d.rgb,part.x),part.y);
          float bossMask=mix(mix(step(1.35,a.r+a.g),step(1.35,b.r+b.g),part.x),mix(step(1.35,c.r+c.g),step(1.35,d.r+d.g),part.x),part.y);
          float coverage=mix(mix(min(1.,a.r+a.g),min(1.,b.r+b.g),part.x),mix(min(1.,c.r+c.g),min(1.,d.r+d.g),part.x),part.y);
          float mask=smoothstep(.42,.58,coverage);
          if (mask>.003) {
            vec3 teamInk=(st.r>=st.g?vec3(.063,.847,.745):vec3(1.,.424,.2))*(1.-st.b*.16);
            vec3 bossInk=vec3(.026,.018,.036)*(1.-st.b*.12);
            vec3 ink=mix(teamInk,bossInk,smoothstep(.3,.7,bossMask));
            col=mix(col,ink,mask);
            inked=mask;
          }
        }
      }
    }
  }
  float zoneInterior=vPos.x>uUnderX*.5?1.:smoothstep(-.4,-3.2,vPos.y);
  float far=max(smoothstep(uFogRange.x,uFogRange.y,dist),uRainLevel*(1.-exp(-max(0.,dist-2.5)*.075)));
  float haze=mix(far,max(far,.55*(1.-exp(-dist*.011))),zoneInterior);
  vec3 outFog=mix(mix(uFog,vec3(.24,.28,.33),uRainLevel*.88),vec3(.085,.018,.022),uBossRage*.9);
  vec3 fogCol=mix(outFog,vec3(.07,.075,.072),zoneInterior);
  float ndl=max(dot(ng,uSun),0.);
  vec3 daySun=vec3(.60,.63,.69)+vec3(.50,.45,.36)*ndl*(1.-uRainLevel*.75)+.06*ng.y;
  vec3 stormSun=vec3(.18,.075,.08)+vec3(.24,.06,.05)*ndl+.02*ng.y;
  vec3 sunLight=mix(daySun,stormSun,uBossRage);
  vec3 light=mix(sunLight,vec3(.74,.73,.70)+.16*ng.y,zoneInterior);
  light=mix(light,vec3(1.),max(glow,inked*.4));
  col*=light;
  if (kind==9) col+=vTint.rgb*.08;
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
uniform float uBossRage;
uniform float uRainLevel;
out vec4 frag;
void main(){
  vec2 s=vUV*2.-1.;
  vec3 ray=normalize(uForward+uRight*s.x*uField.x+uUp*s.y*uField.y);
  float h=clamp(ray.y,0.,1.), sun=max(dot(ray,uSun),0.);
  vec3 horizon=mix(mix(uFog,vec3(.24,.28,.33),uRainLevel*.88),vec3(.14,.022,.025),uBossRage);
  vec3 zenith=mix(mix(vec3(.30,.50,.80),vec3(.10,.12,.15),uRainLevel*.85),vec3(.028,.004,.006),uBossRage);
  vec3 col=mix(horizon,zenith,1.-pow(1.-h,3.2));
  vec3 sunDisk=mix(vec3(1.,.92,.74),vec3(.55,.06,.05),uBossRage)*(1.-uRainLevel*.9);
  vec3 sunHalo=mix(vec3(.25,.20,.12),vec3(.18,.02,.02),uBossRage)*(1.-uRainLevel*.85);
  col+=sunDisk*pow(sun,420.)*(1.2-uBossRage*.55)+sunHalo*pow(sun,10.);
  if (ray.y<0.) col=mix(horizon,horizon*.72,clamp(-ray.y*5.,0.,1.));
  frag=vec4(mix(col,vec3(.055,.062,.058),uInterior),1.);
}`;
