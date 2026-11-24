// Exact CPU-side mirror of GLSL surfaceFor() in render-shaders.js.
// Pre-solves the three face-orientation surface slots (top, side, bottom)
// once per instance and packs them into the three unused instance floats
// (a0.w, a1.w, a2.w), eliminating 145 lines of per-pixel branching in the
// fragment shader with zero additional GPU memory or bandwidth.
import {CABIN_X,CABIN_Y,UNDER_X,UNDER_Y} from './layout.js';
import {SURFACES} from './surfaces.js';

const S=Object.fromEntries(SURFACES.map((surface,i)=>[surface.id.toUpperCase(),i]));

const f32=Math.fround;
const fract32=x=>f32(x-Math.floor(x));

// Exact IEEE-754 float32 match of SCENE_VERTEX vSeed hash from instance world position.
function instanceSeed(x,y,z) {
  let qx=fract32(f32(f32(x)*f32(.1031)));
  let qy=fract32(f32(f32(y)*f32(.1030)));
  let qz=fract32(f32(f32(z)*f32(.0973)));
  const c=f32(33.33);
  const d=f32(f32(qx*f32(qy+c))+f32(qy*f32(qz+c))+f32(qz*f32(qx+c)));
  qx=f32(qx+d); qy=f32(qy+d); qz=f32(qz+d);
  return fract32(f32(f32(qx+qy)*qz));
}

function roofFor(seed) {
  return seed<.45?S.ROOF_MEMBRANE:seed<.7?S.ROOF_GRAVEL:seed<.87?S.ROOFTOP_DECK:S.SOLAR_PANEL;
}

function surfaceForCore(kind,r,g,b,l,chroma,warm,red,green,blue,longest,thinnest,middle,house,level,ceiling,sloped,seed,sy,shape,under,cabin,layer,above) {
  if (ceiling && !under && !cabin && above>2 && (kind===1 || kind===2 || kind===15)) return l>.72?S.GYPSUM_PAINTED:S.CONCRETE_SOFFIT;
  if (kind===1 && !warm && thinnest<.07 && middle<.2 && longest>15) return S.RAIL_STEEL;
  if (kind===1 && !warm && longest<3 && middle<.32 && thinnest<.12 && (layer>3.5 && layer<4.5 || under)) return S.CONCRETE_SLEEPER;
  if ((kind===1 || kind===5 || kind===15 || kind===27) && !level) {
    if (cabin) return S.HARD_PLASTIC;
    if (under) return S.CONCRETE_FORMWORK;
    return sy<.4 && above<.5?S.GRANITE_CURB:S.CONCRETE_WEATHERED;
  }
  if (kind===5) {
    if (under) return S.WET_ASPHALT;
    if (red && chroma>.1) return S.RED_ASPHALT;
    if (green && chroma>.06) return S.GREEN_LANE;
    if (longest<40) return S.PARKING_ASPHALT;
    return seed<.35?S.ASPHALT_PATCHED:S.ASPHALT;
  }
  if (kind===1) {
    if (cabin) return S.VINYL_FLOOR;
    if (layer>3.5 && layer<4.5) return S.BALLAST;
    if (sy>.3 && longest<6) return S.CONCRETE_WEATHERED;
    if (!under && sy<.05 && longest>8 && middle>4) return warm && chroma>.15?S.WOOD_FLOORING:green || blue?S.CARPET_TILE:S.TATAMI;
    if (under) {
      if (longest>60 && middle<4.5) return S.BALLAST;
      if (shape===2) return S.RUBBER_STUD_FLOOR;
      if (l>.55) return longest<12 && sy<.2 && middle>1.5?S.CHECKER_TILE:seed<.34?S.PORCELAIN_TILES:seed<.67?S.TERRAZZO:S.MARBLE;
      return seed<.4?S.EPOXY_FLOOR:seed<.7?S.POLISHED_CONCRETE:S.GARAGE_CONCRETE;
    }
    if (warm && chroma>.07) return seed<.75?S.BRICK_PAVERS:S.GRANITE_SETTS;
    if (g>r+.008) return seed<.35?S.MOSSY_PAVERS:S.SIDEWALK_PAVERS;
    return seed<.18?S.EXPOSED_AGGREGATE:seed<.3?S.GRANITE_SETTS:S.CONCRETE_SLAB;
  }
  if (kind===27) return S.CONCRETE_SLAB;
  if (kind===15) return under?S.EPOXY_FLOOR:S.CONCRETE_WEATHERED;
  if (kind===2 || kind===19) {
    if (ceiling && (under || cabin)) return S.CEILING_PANEL;
    if (cabin) return S.HARD_PLASTIC;
    if (kind===19) return seed<.7?S.PLASTER:S.SHIKKUI;
    if (under) {
      if (level) return S.CONCRETE_WEATHERED;
      if (warm && sy<3 && longest<9) return S.PEGBOARD;
      if (l>.6) return seed<.55?S.SUBWAY_TILES:seed<.8?S.GLASS_MOSAIC:S.MOSAIC_TILE_WALL;
      return S.CONCRETE_FORMWORK;
    }
    if (level) return above>3?roofFor(seed):above>.75 && above<1.25 && longest<3?S.LAMINATE_COUNTER:S.CONCRETE_WEATHERED;
    if (l>.7 && sy>2.9 && sy<3.3 && longest>20) return S.VINYL_WALLPAPER;
    if (sy<.1 && longest>.6 && longest<1.2 && above>2.2) return S.AWNING_CANVAS;
    if (red && chroma>.12) return longest>4?(sy>3.2 && house>.5?S.TERRACOTTA_LOUVER:S.CORTEN_STEEL):
      seed<.6?S.TERRACOTTA:S.GLAZED_BRICK_TILE;
    if (blue && chroma>.12 && sy>2.4) return seed<.5?S.SPANDREL_GLASS:S.TITANIUM_PANEL;
    if (green && chroma>.12 && sy>2.4 && seed<.4) return S.COPPER_PATINA;
    if (chroma>.12 && longest>2) return seed<.35?S.CORRUGATED_METAL:seed<.6?S.TIN_SIDING:seed<.85?S.ALUMINUM_COMPOSITE:S.PEELING_PAINT_WALL;
    if (l<.2 && sy>1) return seed<.4?S.YAKISUGI:seed<.7?S.SLATE_CLADDING:S.SHITAMI_BOARD;
    if (warm && sy>.8 && sy<2.4 && thinnest<.3 && longest>2 && seed<.45) return seed<.25?S.BAMBOO_FENCE:S.KOSHI_LATTICE;
    if (above<1.4 && sy<1.3 && longest>1.5 && l<.55 && chroma<.08) return S.POLISHED_GRANITE;
    if (sy>1.8 && sy<3.2 && l<.45 && chroma<.06 && longest>1.5) return seed<.5?S.ROLLING_SHUTTER:S.CONCRETE_BLOCK;
    if (warm && longest<.9 && l>.25 && l<.7) return S.CARDBOARD;
    if (sy<2.4) {
      if (thinnest>.45 || longest<1.5) return seed<.3?S.CONCRETE_BLOCK:seed<.48?S.EFFLORESCENCE_WALL:
        seed<.72?S.CONCRETE_WEATHERED:seed<.86?S.SPLIT_FACE_BLOCK:S.STONE_RETAINING;
      return seed<.12?S.CONCRETE_BLOCK:seed<.22?S.EFFLORESCENCE_WALL:seed<.32?S.CONCRETE_WEATHERED:
        seed<.42?S.SPLIT_FACE_BLOCK:seed<.52?S.BREEZE_BLOCK:seed<.62?S.WALL_MOSS_DAMP:seed<.71?S.IVY_WALL:
        seed<.79?S.STONE_RETAINING:seed<.86?S.NAMAKO_WALL:seed<.93?S.GABION_WALL:S.GRAFFITI_BUFF;
    }
    const h=house;
    if (warm && chroma>.05 && l>.35 && h<.36) return h<.12?S.MORTAR_WASHI:h<.24?S.SANDSTONE_PANEL:S.NICHOKAKE_TILE;
    if (l>.78 && h>.8) return h<.9?S.SHIKKUI:S.PEELING_PAINT_WALL;
    return h<.1?S.CONCRETE_FORMWORK:h<.2?S.CONCRETE_WEATHERED:h<.27?S.RAIN_STREAKS_WALL:h<.34?S.PLASTER:
      h<.4?S.STUCCO_CRACKED:h<.46?S.LATH_MORTAR:h<.52?S.ALC_PANEL:h<.59?S.PRECAST_PANEL:h<.65?S.SPRAY_TILE:
      h<.71?S.CERAMIC_SIDING:h<.77?S.GRAFFITI_BUFF:h<.84?S.CAST_STONE:h<.9?S.TRAVERTINE:h<.95?S.BRONZE_PANEL:S.MIRROR_STAINLESS;
  }
  if (kind===11) {
    const h=house;
    if (level) return roofFor(h);
    if (warm) return h<.2?S.BRICK_TAN:h<.35?S.TILE_CLADDING:h<.48?S.NICHOKAKE_TILE:h<.58?S.MOSAIC_TILE_WALL:
      h<.7?S.SPRAY_TILE:h<.8?S.CERAMIC_SIDING:h<.9?S.SANDSTONE_PANEL:S.TRAVERTINE;
    return h<.14?S.TILE_CLADDING:h<.25?S.PLASTER:h<.35?S.ALC_PANEL:h<.45?S.CONCRETE_WEATHERED:
      h<.53?S.RAIN_STREAKS_WALL:h<.66?S.PRECAST_PANEL:h<.76?S.ALUMINUM_COMPOSITE:h<.84?S.CAST_STONE:
      h<.9?S.TITANIUM_PANEL:h<.95?S.STUCCO_CRACKED:S.BRONZE_PANEL;
  }
  if (kind===13) {
    if (shape===0) return S.BARK;
    if (level && sy<.1 && l<.5) return seed<.4?S.SOIL:seed<.75?S.MULCH:S.FALLEN_LEAVES;
    if (chroma<.06 && sy>3.5 && sy<6) return S.TUNNEL_LINING;
    if (l>.7) return S.BRICK_PAINTED;
    if (seed>.88 && sy>1.5) return S.IVY_WALL;
    return red?S.BRICK_RED:seed<.8?S.BRICK_TAN:S.GLAZED_BRICK_TILE;
  }
  if (kind===29) return level && longest>2?S.ROOFTOP_DECK:
    seed<.2?S.WOOD_PLANKS:seed<.4?S.PLYWOOD:seed<.6?S.WOOD_WEATHERED:seed<.8?S.PAINTED_WOOD:S.SHITAMI_BOARD;
  if (kind===14) return shape===0?S.LEAVES:!level && sy>1.2?S.GREEN_WALL:S.HEDGE;
  if (kind===4) {
    if (cabin || under) return chroma<.05?S.STAINLESS:S.STEEL_PAINTED_GREY;
    if (sloped && above>3) return blue?S.SOLAR_PANEL:red?(seed<.5?S.KAWARA_TILE:S.STANDING_SEAM_ROOF):
      seed<.55?S.STANDING_SEAM_ROOF:seed<.85?S.ZINC_SHINGLE:S.COPPER_PATINA;
    if (longest<.26 && l<.3) return S.KNURLED_GRIP;
    if (longest<.8 && chroma>.12) return S.ANODIZED_ALUMINUM;
    if (level && above<.35) return shape===0?S.CAST_IRON:S.DRAIN_GRATE;
    if (level && above>.7 && above<1.25 && longest<3) return S.LAMINATE_COUNTER;
    if (level) return S.DIAMOND_PLATE;
    if (longest<.9 && l<.36 && chroma<.08) return S.CERAKOTE;
    if (red && chroma>.15 && l<.5) return S.CORTEN_STEEL;
    if (longest>4.5) return S.STEEL_GIRDER;
    if (thinnest<.05 && longest>.5) return seed<.35?S.PERFORATED_METAL:seed<.7?S.EXPANDED_METAL:S.WOVEN_MESH;
    if (above>3 && thinnest>.4 && longest<2.2) return S.METAL_LOUVER;
    if (warm && l<.4 && chroma<.15 && longest>1) return S.BRONZE_PANEL;
    if (chroma<.035 && l>.12) return seed<.5?S.GALVANIZED:S.BRUSHED_ALUMINUM;
    return green?S.STEEL_PAINTED_GREEN:S.STEEL_PAINTED_GREY;
  }
  if (kind===22) return r>.8 && b<.7?S.TACTILE_PAVING:S.ROAD_PAINT;
  if (kind===0) return l>.8 && thinnest<.06 && longest<.8?S.REFLECTIVE_TAPE:
    l<.15 && thinnest<.3 && middle>.8 && longest>1.2?S.LED_BILLBOARD_OFF:S.PAINTED_METAL;
  if (kind===8) return l>.62?(level || ceiling?S.FROSTED_GLASS:seed<.5?S.GLASS_BLOCK:S.CHANNEL_GLASS):S.GLASS_GRIME;
  if (kind===3) return middle>.3 && longest>1.4?S.LIGHTBOX_PANEL:-1;
  if (kind===23) return shape===0 && thinnest<.9?S.SUCKER_SKIN:S.CEPHALOPOD_SKIN;
  if (kind===18) return cabin?S.SEAT_FABRIC:l<.25?S.NEOPRENE:S.SPORT_MESH;
  if (kind===30) return S.RIPSTOP;
  if (kind===31) return longest>.3?S.BALLISTIC_NYLON:S.CANVAS;
  if (kind===21) return ceiling?S.BOOT_TREAD:thinnest<.07?S.RUBBER_SOLE:l<.3 && longest<.6?S.LEATHER:S.RUBBER_SOLE;
  if (kind===20) return l<.3?S.CARBON_FIBER:S.HARD_PLASTIC;
  if (kind===26) return S.DRIED_INK;
  return -1;
}

export function surfaceForJS(kind,r,g,b,level,ceiling,sloped,seed,sx,sy,sz,shape,under,cabin,layer,above) {
  const l=r*.2126+g*.7152+b*.0722;
  const maxC=r>g?(r>b?r:b):(g>b?g:b);
  const minC=r<g?(r<b?r:b):(g<b?g:b);
  const chroma=maxC-minC;
  const warm=r>b+.06, red=r>g+.15, green=g>r+.015 && g>=b-.02, blue=b>r+.06;
  const longest=sx>sy?(sx>sz?sx:sz):(sy>sz?sy:sz);
  const thinnest=sx<sy?(sx<sz?sx:sz):(sy<sz?sy:sz);
  const middle=sx+sy+sz-longest-thinnest;
  const house=fract32(f32(f32(f32(r)*f32(31.7))+f32(f32(g)*f32(19.3))+f32(f32(b)*f32(23.9))));
  return surfaceForCore(kind,r,g,b,l,chroma,warm,red,green,blue,longest,thinnest,middle,house,level,ceiling,sloped,seed,sy,shape,under,cabin,layer,above);
}

// Writes (slotTop, slotSide, slotBot) into out[o+3], out[o+7], out[o+11] for one packed instance.
export function writeSurfaceSlots(out,o,shape) {
  const kind=Math.round(out[o+19]);
  // Fast exit for kinds that never map to a surfaceFor slot.
  if (kind===6 || kind===7 || kind===9 || kind===10 || kind===12 || kind===16 || kind===17 || kind===24 || kind===25 || kind===28) {
    out[o+3]=-1; out[o+7]=-1; out[o+11]=-1;
    return;
  }
  const r=out[o+16], g=out[o+17], b=out[o+18];
  // Ultra-fast paths for orientation-independent kinds.
  if (kind===22) {const s=r>.8 && b<.7?S.TACTILE_PAVING:S.ROAD_PAINT; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
  if (kind===30) {out[o+3]=S.RIPSTOP; out[o+7]=S.RIPSTOP; out[o+11]=S.RIPSTOP; return;}
  if (kind===26) {out[o+3]=S.DRIED_INK; out[o+7]=S.DRIED_INK; out[o+11]=S.DRIED_INK; return;}
  const a0=out[o], a1=out[o+1], a2=out[o+2];
  const b0=out[o+4], b1=out[o+5], b2=out[o+6];
  const c0=out[o+8], c1=out[o+9], c2=out[o+10];
  const sx=Math.sqrt(a0*a0+a1*a1+a2*a2);
  const sy=Math.sqrt(b0*b0+b1*b1+b2*b2);
  const sz=Math.sqrt(c0*c0+c1*c1+c2*c2);
  const l=r*.2126+g*.7152+b*.0722;
  const longest=sx>sy?(sx>sz?sx:sz):(sy>sz?sy:sz);
  const thinnest=sx<sy?(sx<sz?sx:sz):(sy<sz?sy:sz);
  const middle=sx+sy+sz-longest-thinnest;
  if (kind===0) {
    const s=l>.8 && thinnest<.06 && longest<.8?S.REFLECTIVE_TAPE:
      l<.15 && thinnest<.3 && middle>.8 && longest>1.2?S.LED_BILLBOARD_OFF:S.PAINTED_METAL;
    out[o+3]=s; out[o+7]=s; out[o+11]=s; return;
  }
  if (kind===3) {const s=middle>.3 && longest>1.4?S.LIGHTBOX_PANEL:-1; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
  if (kind===20) {const s=l<.3?S.CARBON_FIBER:S.HARD_PLASTIC; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
  if (kind===31) {const s=longest>.3?S.BALLISTIC_NYLON:S.CANVAS; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
  if (kind===23) {const s=shape===0 && thinnest<.9?S.SUCKER_SKIN:S.CEPHALOPOD_SKIN; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
  const x=out[o+12], y=out[o+13], z=out[o+14];
  const cabin=x>CABIN_X-640;
  if (kind===18) {const s=cabin?S.SEAT_FABRIC:l<.25?S.NEOPRENE:S.SPORT_MESH; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
  const under=x>UNDER_X*.5 && !cabin;
  const maxC=r>g?(r>b?r:b):(g>b?g:b);
  const minC=r<g?(r<b?r:b):(g<b?g:b);
  const chroma=maxC-minC;
  if (kind===4 && (cabin || under)) {
    const s=chroma<.05?S.STAINLESS:S.STEEL_PAINTED_GREY;
    out[o+3]=s; out[o+7]=s; out[o+11]=s; return;
  }
  const layer=out[o+21];
  const floorY=cabin?CABIN_Y:under?UNDER_Y:0;
  const halfY=(Math.abs(a1)+Math.abs(b1)+Math.abs(c1))*.5;
  const aboveTop=y+halfY-floorY;
  const aboveMid=y-floorY;
  const aboveBot=y-halfY-floorY;
  const seed=instanceSeed(x,y,z);
  const upY=sy>1e-6?Math.abs(b1/sy):1;
  const sloped=shape===2 || (upY>.6 && upY<.995);
  const warm=r>b+.06, red=r>g+.15, green=g>r+.015 && g>=b-.02, blue=b>r+.06;
  const house=(kind===2 || kind===11)?fract32(f32(f32(f32(r)*f32(31.7))+f32(f32(g)*f32(19.3))+f32(f32(b)*f32(23.9)))):0;
  out[o+3]=surfaceForCore(kind,r,g,b,l,chroma,warm,red,green,blue,longest,thinnest,middle,house,true,false,sloped,seed,sy,shape,under,cabin,layer,aboveTop);
  out[o+7]=surfaceForCore(kind,r,g,b,l,chroma,warm,red,green,blue,longest,thinnest,middle,house,false,false,false,seed,sy,shape,under,cabin,layer,aboveMid);
  out[o+11]=surfaceForCore(kind,r,g,b,l,chroma,warm,red,green,blue,longest,thinnest,middle,house,false,true,false,seed,sy,shape,under,cabin,layer,aboveBot);
}
