import {CABIN_X,CABIN_Y,RAIL_CABIN_X,UNDER_X,UNDER_Y,ZONES,interiorBlend,zoneOf} from './layout.js';
import {OccluderCuller} from './occlusion.js';
import {ARCH_INTERIOR_FRAGMENT,ARCH_LITE_FRAGMENT,ARCH_OUTDOOR_FRAGMENT,ARCH_VERTEX,BLUR_FRAGMENT,COMPOSITE_FRAGMENT,DEFERRED_MIRROR_FRAGMENT,DEFERRED_OUTDOOR_FRAGMENT,DEFERRED_RAY_VERTEX,DEPTH_VERTEX,DETAIL_FRAGMENT,DOWN_FRAGMENT,ENV_FRAGMENT,
  FULLSCREEN_VERTEX,GBUF_ARCH_FRAGMENT,GBUF_ARCH_VERTEX,GBUF_BAKED_ARCH_FRAGMENT,GBUF_BAKED_ARCH_VERTEX,GBUF_BAKED_FLAT_FRAGMENT,GBUF_BAKED_FLAT_VERTEX,GBUF_BAKED_FULL_FRAGMENT,GBUF_BAKED_FULL_VERTEX,GBUF_FLAT_FRAGMENT,GBUF_FLAT_VERTEX,GBUF_FULL_FLAT_FRAGMENT,GBUF_FULL_FLAT_VERTEX,GBUF_FULL_FRAGMENT,GBUF_FULL_VERTEX,LITE_FRAGMENT,LITE_SKY_FRAGMENT,LITE_VERTEX,MIRROR_FRAGMENT,MIRROR_SKY_FRAGMENT,SCENE_ALPHA_FRAGMENT,SCENE_ALPHA_VERTEX,SCENE_CUTOUT_FRAGMENT,SCENE_FRAGMENT,SCENE_VERTEX,SHADOW_BAKED_VERTEX,SHADOW_FRAGMENT,
  SHADOW_VERTEX,SKY_FRAGMENT,SSAO_FRAGMENT,UP_FRAGMENT} from './render-shaders.js';
import {SURFACE_SLOT,writeSurfaceSlots} from './surface-solver.js';
import {loadSurfaceSheets,surfaceArray} from './surface-textures.js';
import {SURFACE_COUNT,surfaceSlot} from './surfaces.js';

export const TAU = Math.PI * 2;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const mix = (a, b, t) => a + (b - a) * t;
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (v) => {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const inv = 1 / (len > 0.00001 ? len : 0.00001);
  return [v[0] * inv, v[1] * inv, v[2] * inv];
};
export const forward = (yaw, pitch = 0) => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
export const color = (hex) => [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// Late-morning sun: 43 degrees high, warm, from the south-west.
export const SUN = unit([-0.46, 0.66, 0.50]);
const SUN_RADIANCE = [3.55, 3.22, 2.80];
const UP = [0, 1, 0];
export const STRIDE = 24;
const FOV = 58 * Math.PI / 180;
const NEAR = .12, FAR = 1200;
const DEPTH_AB = [(NEAR * FAR) / (FAR - NEAR), FAR / (FAR - NEAR)];
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
const LABEL_INDEX=new Map(LABELS.map((label,i)=>[label,i]));
const ATLAS_COLUMNS=4, ATLAS_ROWS=Math.ceil(LABELS.length/ATLAS_COLUMNS);
const TRANSPARENT_MESHES=new Set(['quad','ripple','curtain','glass','hazard','shade']);
const DECAL_MESHES=new Set(['splat','tri','shade']);
// Closed outward-wound solids eligible for hardware backface culling and Z-prepass.
const CULL_MESHES=new Set(['box','ramp','bevel','cylinder','taper','cone','orb','soft','limb','mantle','ring']);
const SYMMETRIC_CULL=new Set(['box','bevel','cylinder','taper','cone','orb','soft','limb','mantle','ring']);
const ZONE_BATCHES=['static','lower','cabin','railCabin'];
const SHAPE_IDS={box:1,ramp:2,bevel:3,soft:4};
const EMPTY={};
// Static scene chunks: 16 m cells in 6-bit Morton order (+/-512m > CITY_RADIUS)
// partitioned by cutout, solid-angle tier, material fast-path, shadow role, and 2-bit yBand.
const CHUNK=16;
const TIER_RADII=[.24,.58,1.45];
const S_ROOF_MEMBRANE=surfaceSlot('roof_membrane');
const S_APT_CORRIDOR=surfaceSlot('apt_corridor');
const S_APT_ENDWALL=surfaceSlot('apt_endwall');
const S_APT_FRONTS=[
  surfaceSlot('apt_balcony'),surfaceSlot('apt_loggia'),surfaceSlot('apt_ribbon'),
  surfaceSlot('apt_fins'),surfaceSlot('apt_screen'),surfaceSlot('apt_brick'),surfaceSlot('apt_glass')
];
function apartmentSlotJS(style,face) {
  if (face===1) return S_APT_CORRIDOR;
  if (face===2) return S_APT_ENDWALL;
  return style>=0 && style<6?S_APT_FRONTS[style]:S_APT_FRONTS[6];
}

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

function invertMat4Into(m, out = new Float32Array(16)) {
  const m00=m[0],m01=m[1],m02=m[2],m03=m[3], m10=m[4],m11=m[5],m12=m[6],m13=m[7];
  const m20=m[8],m21=m[9],m22=m[10],m23=m[11], m30=m[12],m31=m[13],m32=m[14],m33=m[15];
  const b00=m00*m11-m01*m10, b01=m00*m12-m02*m10, b02=m00*m13-m03*m10;
  const b03=m01*m12-m02*m11, b04=m01*m13-m03*m11, b05=m02*m13-m03*m12;
  const b06=m20*m31-m21*m30, b07=m20*m32-m22*m30, b08=m20*m33-m23*m30;
  const b09=m21*m32-m22*m31, b10=m21*m33-m23*m31, b11=m22*m33-m23*m32;
  let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if (!det) return out;
  det=1/det;
  out[0]=(m11*b11-m12*b10+m13*b09)*det; out[1]=(m02*b10-m01*b11-m03*b09)*det;
  out[2]=(m31*b05-m32*b04+m33*b03)*det; out[3]=(m22*b04-m21*b05-m23*b03)*det;
  out[4]=(m12*b08-m10*b11-m13*b07)*det; out[5]=(m00*b11-m02*b08+m03*b07)*det;
  out[6]=(m32*b02-m30*b05-m33*b01)*det; out[7]=(m20*b05-m22*b02+m23*b01)*det;
  out[8]=(m10*b10-m11*b08+m13*b06)*det; out[9]=(m01*b08-m00*b10-m03*b06)*det;
  out[10]=(m30*b04-m31*b02+m33*b00)*det; out[11]=(m21*b02-m20*b04-m23*b00)*det;
  out[12]=(m11*b07-m10*b09-m12*b06)*det; out[13]=(m00*b09-m01*b07+m02*b06)*det;
  out[14]=(m31*b01-m30*b03-m32*b00)*det; out[15]=(m20*b03-m21*b01+m22*b00)*det;
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
  return new Float32Array([s / aspect, 0, 0, 0, 0, s, 0, 0, 0, 0, (NEAR + FAR) / (NEAR - FAR), -1, 0, 0, 2 * NEAR * FAR / (NEAR - FAR), 0]);
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
      if (sign>0) mesh.indices.push(k,k+steps.length,k+1,k+1,k+steps.length,k+steps.length+1);
      else mesh.indices.push(k,k+1,k+steps.length,k+1,k+steps.length+1,k+steps.length);
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
  const mesh=makeMesh(), around=lowDetail?10:36, tube=lowDetail?5:10;
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
  const mesh=makeMesh(), sides=lowDetail?14:56, rows=lowDetail?8:30;
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
    mesh.indices.push(k, k + sides + 1, k + 1, k + 1, k + sides + 1, k + sides + 2);
  }
  if (!sphere) {
    for (const edge of [0, 1]) {
      const y = edge - .5, r = edge ? .5 * taper : .5;
      const center = mesh.vertex([0,y,0], [0,edge ? 1 : -1,0]);
      for (let j = 0; j <= sides; j++) {
        const angle = TAU * j / sides;
        mesh.vertex([Math.cos(angle) * r,y,Math.sin(angle) * r], [0,edge ? 1 : -1,0]);
        if (j) {
          if (edge) mesh.indices.push(center, center + j + 1, center + j);
          else mesh.indices.push(center, center + j, center + j + 1);
        }
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

// A box swept by a sphere: armour plates, boots and cushions with soft,
// continuous highlights instead of hard bevel facets.
function softBox(lowDetail) {
  const mesh=makeMesh(), radius=.24, core=.5-radius, rings=lowDetail?2:3;
  const steps=[];
  for (let i=0;i<=rings;i++) steps.push(-core-radius*Math.cos(i/rings*Math.PI/2));
  for (let i=0;i<=rings;i++) steps.push(core+radius*Math.sin(i/rings*Math.PI/2));
  const k=steps.length;
  for (let axis=0;axis<3;axis++) for (const sign of [-1,1]) {
    const base=mesh.vertices.length/8;
    for (const u of steps) for (const v of steps) {
      const p=[0,0,0];
      p[axis]=sign*.5;
      p[(axis+1)%3]=u;
      p[(axis+2)%3]=v;
      const c=p.map(n=>clamp(n,-core,core));
      const n=unit(sub(p,c));
      mesh.vertex(add(c,scale(n,radius)),n,[u+.5,v+.5]);
    }
    for (let i=0;i<k-1;i++) for (let j=0;j<k-1;j++) {
      const q=base+i*k+j;
      if (sign>0) mesh.indices.push(q,q+k,q+1,q+1,q+k,q+k+1);
      else mesh.indices.push(q,q+1,q+k,q+1,q+k+1,q+k);
    }
  }
  return mesh;
}

// Tapered capsule for limbs: domed ends and a slight muscle swell.
function limbMesh(lowDetail) {
  const mesh=makeMesh(), sides=lowDetail?10:16, rows=lowDetail?8:18, cap=.22;
  const profile=t=>{
    const base=.5*mix(1,.8,t)*(1+.07*Math.sin(Math.PI*t));
    const e=t<cap?(cap-t)/cap:t>1-cap?(t-1+cap)/cap:0;
    return base*Math.sqrt(Math.max(0,1-e*e));
  };
  for (let i=0;i<=rows;i++) {
    const t=i/rows, r=profile(t), lo=Math.max(0,t-.004), hi=Math.min(1,t+.004);
    const slope=(profile(hi)-profile(lo))/(hi-lo);
    for (let j=0;j<=sides;j++) {
      const a=j/sides*TAU, x=Math.cos(a), z=Math.sin(a);
      const n=i===0?[0,-1,0]:i===rows?[0,1,0]:unit([x,-slope,z]);
      mesh.vertex([x*r,t-.5,z*r],n,[j/sides,t]);
    }
  }
  for (let i=0;i<rows;i++) for (let j=0;j<sides;j++) {
    const q=i*(sides+1)+j;
    mesh.indices.push(q,q+sides+1,q+1,q+1,q+sides+1,q+sides+2);
  }
  return mesh;
}

function shadeQuad() {
  const mesh=makeMesh();
  mesh.face([[-.5,0,.5],[.5,0,.5],[.5,0,-.5],[-.5,0,-.5]],[0,1,0]);
  return mesh;
}

export function meshes(lowDetail = false) {
  return {
    box:block(),ramp:block(true),bevel:beveledBlock(lowDetail),cylinder:radial(false,lowDetail?9:24),
    taper:radial(false,lowDetail?8:18,1,.67),cone:radial(false,lowDetail?9:24,1,.025),orb:radial(true,lowDetail?7:24,lowDetail?4:16),mantle:mantleMesh(lowDetail),quad:panel(),splat:panel(true),tri:triangleDecal(),ripple:rippleMesh(),hazard:hazardDisk(lowDetail),ring:ringMesh(lowDetail),curtain:windowPane(),glass:windowPane(),
    soft:softBox(lowDetail),limb:limbMesh(lowDetail),shade:shadeQuad()
  };
}

// Render-only tessellation. Collision keeps meshes() so hit tests never move.
// Kept as low as the silhouettes allow: the surface textures and smooth
// normals carry the detail, and the rounded-edge shading does the bevels.
function renderMeshes() {
  const high=meshes();
  high.bevel=beveledBlock(true);
  high.orb=radial(true,12,8);
  high.cylinder=radial(false,10);
  high.taper=radial(false,10,1,.67);
  high.cone=radial(false,10,1,.025);
  high.ring=ringMesh(true);
  high.mantle=mantleMesh(true);
  high.hazard=hazardDisk(true);
  high.soft=softBox(true);
  high.limb=limbMesh(true);
  return high;
}

// Distant chunks swap to these: bevels become plain boxes
// with analytic rounded-edge shading, curved parts drop most of their segments.
function lodMeshes() {
  const low=meshes(true);
  low.bevel=block();
  low.soft=block();
  low.orb=radial(true,6,4);
  low.cylinder=radial(false,6);
  low.taper=radial(false,6,1,.67);
  low.cone=radial(false,6,1,.025);
  low.limb=radial(false,6,1,.8);
  return low;
}

// 6-vertex, 8-triangle octahedron with outward CCW winding and smooth radial normals
// for ultra-fast shadow-map and 0.35x planar-mirror proxies of spheres/mantles.
function octahedronMesh() {
  const mesh=makeMesh(), r=.54;
  mesh.vertex([r,0,0],[1,0,0],[.5,.5]);
  mesh.vertex([-r,0,0],[-1,0,0],[.5,.5]);
  mesh.vertex([0,r,0],[0,1,0],[.5,1]);
  mesh.vertex([0,-r,0],[0,-1,0],[.5,0]);
  mesh.vertex([0,0,r],[0,0,1],[.5,.5]);
  mesh.vertex([0,0,-r],[0,0,-1],[.5,.5]);
  mesh.indices.push(0,2,4, 4,2,1, 1,2,5, 5,2,0, 4,3,0, 1,3,4, 5,3,1, 0,3,5);
  return mesh;
}

function shadowMeshes(low) {
  const sh={...low}, oct=octahedronMesh(), box=block();
  sh.orb=oct;
  sh.mantle=oct;
  sh.cylinder=box;
  sh.taper=box;
  sh.limb=box;
  sh.cone=box;
  sh.ring=box;
  sh.bevel=box;
  sh.soft=box;
  return sh;
}

const _S_DRIED_INK=SURFACE_SLOT.DRIED_INK, _S_RIPSTOP=SURFACE_SLOT.RIPSTOP;
const _S_TACTILE_PAVING=SURFACE_SLOT.TACTILE_PAVING, _S_ROAD_PAINT=SURFACE_SLOT.ROAD_PAINT;
const _S_CARBON_FIBER=SURFACE_SLOT.CARBON_FIBER, _S_HARD_PLASTIC=SURFACE_SLOT.HARD_PLASTIC;
const _S_SEAT_FABRIC=SURFACE_SLOT.SEAT_FABRIC, _S_NEOPRENE=SURFACE_SLOT.NEOPRENE, _S_SPORT_MESH=SURFACE_SLOT.SPORT_MESH;
const _S_GLASS_GRIME=SURFACE_SLOT.GLASS_GRIME;
const _S_REFLECTIVE_TAPE=SURFACE_SLOT.REFLECTIVE_TAPE, _S_LED_BILLBOARD_OFF=SURFACE_SLOT.LED_BILLBOARD_OFF, _S_PAINTED_METAL=SURFACE_SLOT.PAINTED_METAL;
const _S_LIGHTBOX_PANEL=SURFACE_SLOT.LIGHTBOX_PANEL;
const _S_RUBBER_SOLE=SURFACE_SLOT.RUBBER_SOLE, _S_LEATHER=SURFACE_SLOT.LEATHER, _S_BOOT_TREAD=SURFACE_SLOT.BOOT_TREAD;
const _S_BALLISTIC_NYLON=SURFACE_SLOT.BALLISTIC_NYLON, _S_CANVAS=SURFACE_SLOT.CANVAS;
const _S_SUCKER_SKIN=SURFACE_SLOT.SUCKER_SKIN, _S_CEPHALOPOD_SKIN=SURFACE_SLOT.CEPHALOPOD_SKIN;
const _CABIN_CUT=CABIN_X-640;
// Mask of kinds that never map to a surfaceFor slot: 6,7,9,10,12,16,17,24,25,28
const _NO_SLOT_MASK=(1<<6)|(1<<7)|(1<<9)|(1<<10)|(1<<12)|(1<<16)|(1<<17)|(1<<24)|(1<<25)|(1<<28);
let _pLastYaw=NaN, _pCY=1, _pSY=0;
let _pLastPitch=NaN, _pCP=1, _pSP=0;

// Writes one instance record (24 floats) without allocating, including
// pre-solved (slotTop, slotSide, slotBot) packed into a0.w, a1.w, a2.w.
export function packInstance(out,o,x,y,z,w,h,d,tint,kind,opts=EMPTY,shape=0,ensureCCW=false) {
  let r,g,b;
  if (typeof tint==='number') {r=(tint>>16&255)*(1/255);g=(tint>>8&255)*(1/255);b=(tint&255)*(1/255);}
  else {r=tint[0];g=tint[1];b=tint[2];}
  let ax,ay,az,bx,by,bz,cx,cy,cz;
  const basis=opts.basis;
  if (basis) {
    const b0=basis[0], b1=basis[1], b2=basis[2];
    ax=b0[0];ay=b0[1];az=b0[2];bx=b1[0];by=b1[1];bz=b1[2];cx=b2[0];cy=b2[1];cz=b2[2];
    if (ensureCCW && (ax*(by*cz-bz*cy)-ay*(bx*cz-bz*cx)+az*(bx*cy-by*cx))*w*h*d<0) {
      ax=-ax;ay=-ay;az=-az;
    }
  } else {
    const yaw=opts.yaw||0, pitch=opts.pitch||0;
    if (!yaw && !pitch) {
      ax=1;ay=0;az=0;bx=0;by=1;bz=0;cx=0;cy=0;cz=1;
    } else {
      let c1, s1;
      if (yaw===_pLastYaw) {c1=_pCY; s1=_pSY;}
      else {_pLastYaw=yaw; c1=_pCY=Math.cos(yaw); s1=_pSY=Math.sin(yaw);}
      if (!pitch) {
        ax=c1;ay=0;az=-s1;bx=0;by=1;bz=0;cx=s1;cy=0;cz=c1;
      } else {
        let c2, s2;
        if (pitch===_pLastPitch) {c2=_pCP; s2=_pSP;}
        else {_pLastPitch=pitch; c2=_pCP=Math.cos(pitch); s2=_pSP=Math.sin(pitch);}
        ax=c1;ay=0;az=-s1;bx=s1*s2;by=c2;bz=c1*s2;cx=s1*c2;cy=-s2;cz=c1*c2;
      }
    }
  }
  const m0=ax*w, m1=ay*w, m2=az*w;
  const m4=bx*h, m5=by*h, m6=bz*h;
  const m8=cx*d, m9=cy*d, m10=cz*d;
  out[o]=m0;out[o+1]=m1;out[o+2]=m2;
  out[o+4]=m4;out[o+5]=m5;out[o+6]=m6;
  out[o+8]=m8;out[o+9]=m9;out[o+10]=m10;
  out[o+12]=x;out[o+13]=y;out[o+14]=z;out[o+15]=1;
  out[o+16]=r;out[o+17]=g;out[o+18]=b;out[o+19]=kind;
  out[o+20]=opts.label??0;out[o+21]=opts.layer??0;out[o+22]=opts.stairDuplicate?1:0;out[o+23]=opts.effect??0;

  // Inlined zero-overhead surface slot fast paths (bit-identical to writeSurfaceSlots).
  const k=kind|0;
  if (k>=0 && k<=31 && ((1<<k)&_NO_SLOT_MASK)!==0) {
    out[o+3]=-1; out[o+7]=-1; out[o+11]=-1;
    return;
  }
  if (k===26) {out[o+3]=_S_DRIED_INK; out[o+7]=_S_DRIED_INK; out[o+11]=_S_DRIED_INK; return;}
  if (k===30) {out[o+3]=_S_RIPSTOP; out[o+7]=_S_RIPSTOP; out[o+11]=_S_RIPSTOP; return;}
  if (k===22) {
    const cr=out[o+16], cb=out[o+18];
    const s=cr>.8 && cb<.7?_S_TACTILE_PAVING:_S_ROAD_PAINT;
    out[o+3]=s; out[o+7]=s; out[o+11]=s;
    return;
  }
  if (k===20) {
    const l=out[o+16]*.2126+out[o+17]*.7152+out[o+18]*.0722;
    const s=l<.3?_S_CARBON_FIBER:_S_HARD_PLASTIC;
    out[o+3]=s; out[o+7]=s; out[o+11]=s;
    return;
  }
  if (k===18) {
    const l=out[o+16]*.2126+out[o+17]*.7152+out[o+18]*.0722;
    const s=out[o+12]>_CABIN_CUT?_S_SEAT_FABRIC:l<.25?_S_NEOPRENE:_S_SPORT_MESH;
    out[o+3]=s; out[o+7]=s; out[o+11]=s;
    return;
  }
  if (k===0 || k===3 || k===21 || k===23 || k===31) {
    let sx, sy, sz;
    if (basis) {
      const f0=out[o], f1=out[o+1], f2=out[o+2];
      const f4=out[o+4], f5=out[o+5], f6=out[o+6];
      const f8=out[o+8], f9=out[o+9], f10=out[o+10];
      sx=Math.sqrt(f0*f0+f1*f1+f2*f2);
      sy=Math.sqrt(f4*f4+f5*f5+f6*f6);
      sz=Math.sqrt(f8*f8+f9*f9+f10*f10);
    } else {
      sx=Math.fround(w<0?-w:w); sy=Math.fround(h<0?-h:h); sz=Math.fround(d<0?-d:d);
    }
    const longest=sx>sy?(sx>sz?sx:sz):(sy>sz?sy:sz);
    const thinnest=sx<sy?(sx<sz?sx:sz):(sy<sz?sy:sz);
    if (k===31) {const s=longest>.3?_S_BALLISTIC_NYLON:_S_CANVAS; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
    if (k===23) {const s=shape===0 && thinnest<.9?_S_SUCKER_SKIN:_S_CEPHALOPOD_SKIN; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
    const middle=sx+sy+sz-longest-thinnest;
    if (k===3) {const s=middle>.3 && longest>1.4?_S_LIGHTBOX_PANEL:-1; out[o+3]=s; out[o+7]=s; out[o+11]=s; return;}
    const l=out[o+16]*.2126+out[o+17]*.7152+out[o+18]*.0722;
    if (k===0) {
      const s=l>.8 && thinnest<.06 && longest<.8?_S_REFLECTIVE_TAPE:
        l<.15 && thinnest<.3 && middle>.8 && longest>1.2?_S_LED_BILLBOARD_OFF:_S_PAINTED_METAL;
      out[o+3]=s; out[o+7]=s; out[o+11]=s;
      return;
    }
    const topSide=thinnest<.07?_S_RUBBER_SOLE:l<.3 && longest<.6?_S_LEATHER:_S_RUBBER_SOLE;
    out[o+3]=topSide; out[o+7]=topSide; out[o+11]=_S_BOOT_TREAD;
    return;
  }
  if (k===8 && out[o+16]*.2126+out[o+17]*.7152+out[o+18]*.0722<=.62) {
    out[o+3]=_S_GLASS_GRIME; out[o+7]=_S_GLASS_GRIME; out[o+11]=_S_GLASS_GRIME;
    return;
  }
  if (basis) writeSurfaceSlots(out,o,shape);
  else writeSurfaceSlots(out,o,shape,Math.fround(w<0?-w:w),Math.fround(h<0?-h:h),Math.fround(d<0?-d:d));
}

export function labelIndex(name) {
  return LABEL_INDEX.get(name) ?? -1;
}

const FRUSTUM_SPEC=[[0,1],[0,-1],[1,1],[1,-1],[2,1],[2,-1]];
function makePlanes() {
  return [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
}
function frustumInto(m,planes) {
  for (let p=0;p<6;p++) {
    const i=FRUSTUM_SPEC[p][0], s=FRUSTUM_SPEC[p][1];
    const a=m[3]+s*m[i], b=m[7]+s*m[4+i], c=m[11]+s*m[8+i], d=m[15]+s*m[12+i];
    const len=Math.sqrt(a*a+b*b+c*c);
    const inv=len>0?1/len:1;
    const dst=planes[p];
    dst[0]=a*inv; dst[1]=b*inv; dst[2]=c*inv; dst[3]=d*inv;
  }
  return planes;
}
function frustum(m) {
  return frustumInto(m,makePlanes());
}

function boxVisible(planes,min,max,ox) {
  for (let i=0;i<6;i++) {
    const p=planes[i];
    const x=(p[0]>=0?max[0]:min[0])+ox, y=p[1]>=0?max[1]:min[1], z=p[2]>=0?max[2]:min[2];
    if (p[0]*x+p[1]*y+p[2]*z+p[3]<0) return false;
  }
  return true;
}

function boxDistanceSq(e,min,max,ox) {
  const dx=Math.max(min[0]+ox-e[0],0,e[0]-max[0]-ox);
  const dy=Math.max(min[1]-e[1],0,e[1]-max[1]);
  const dz=Math.max(min[2]-e[2],0,e[2]-max[2]);
  return dx*dx+dy*dy+dz*dz;
}

function sphereInPlanes(planes,x,y,z,r) {
  for (let i=0;i<6;i++) {
    const p=planes[i];
    if (p[0]*x+p[1]*y+p[2]*z+p[3]<-r) return false;
  }
  return true;
}

function morton6(x,z) {
  let key=0;
  for (let bit=0;bit<6;bit++) key|=((x>>bit)&1)<<(2*bit)|((z>>bit)&1)<<(2*bit+1);
  return key;
}

function isArchDynamicKind(k,isBox) {
  return k===0 || k===1 || k===2 || k===3 || k===4 || k===9 || (k===13 && isBox) ||
    k===18 || k===19 || k===20 || k===21 || k===30 || k===31;
}

function extractMeshData(mesh) {
  const v=mesh.vertices, vCount=v.length/8;
  const pos=new Float32Array(vCount*3), norm=new Float32Array(vCount*3), uv=new Float32Array(vCount*2);
  for (let i=0;i<vCount;i++) {
    const s=i*8;
    pos[i*3]=v[s]; pos[i*3+1]=v[s+1]; pos[i*3+2]=v[s+2];
    norm[i*3]=v[s+3]; norm[i*3+1]=v[s+4]; norm[i*3+2]=v[s+5];
    uv[i*2]=v[s+6]; uv[i*2+1]=v[s+7];
  }
  const indices=new Uint16Array(mesh.indices);
  return {pos,norm,uv,indices,vCount,iCount:indices.length};
}

// Box geometry omitting face 0 (-Y bottom face, verts 0..3 / indices 0..5) for
// static Zone-0 boxes resting on/below ground (py - hy <= 0.035): 100% invisible
// from above ground and strictly below the y = 0.037 planar mirror clip plane.
function boxNoBotMesh(boxMesh) {
  const vertices=boxMesh.vertices.slice(32);
  const indices=boxMesh.indices.slice(6).map(i=>i-4);
  return extractMeshData({vertices,indices});
}

// Box geometry keeping ONLY face 1 (+Y top face, verts 4..7 / indices 6..11) for
// upright static Zone-0 road markings (kind==22), eliminating 5 discarded faces (83% fewer tris).
function boxTopOnlyMesh(boxMesh) {
  const vertices=boxMesh.vertices.slice(32,64);
  const indices=boxMesh.indices.slice(6,12).map(i=>i-4);
  return extractMeshData({vertices,indices});
}

function writeOctU8(u8,off,nx,ny,nz) {
  const denom=(nx<0?-nx:nx)+(ny<0?-ny:ny)+(nz<0?-nz:nz)+1e-6;
  let px=nx/denom, py=nz/denom;
  if (ny<0) {
    const ax=px<0?-px:px, ay=py<0?-py:py;
    const tpx=(1-ay)*(px>=0?1:-1);
    py=(1-ax)*(py>=0?1:-1);
    px=tpx;
  }
  const ex=(px*127+127.5)|0, ey=(py*127+127.5)|0;
  u8[off]=ex<0?0:ex>255?255:ex;
  u8[off+1]=ey<0?0:ey>255?255:ey;
}

function setupBakedAttribs(gl,mode) {
  if (mode==='flat') {
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,20,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,20,12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,4,gl.UNSIGNED_BYTE,true,20,16);
  } else if (mode==='full') {
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,36,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,36,12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,4,gl.UNSIGNED_BYTE,true,36,16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3,4,gl.FLOAT,false,36,20);
  } else if (mode==='curved') {
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.BYTE,true,24,12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,4,gl.UNSIGNED_BYTE,true,24,16);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3,4,gl.UNSIGNED_BYTE,false,24,20);
  } else {
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,12,0);
  }
}

function makeBakedVAO(gl,mode,rawBuf,idxArr,gatherIBO) {
  const vao=gl.createVertexArray(), vbo=gl.createBuffer(), ibo=gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
  gl.bufferData(gl.ARRAY_BUFFER,rawBuf,gl.STATIC_DRAW);
  setupBakedAttribs(gl,mode);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,idxArr,gl.STATIC_DRAW);
  let gatherVao=null;
  if (gatherIBO) {
    gatherVao=gl.createVertexArray();
    gl.bindVertexArray(gatherVao);
    gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
    setupBakedAttribs(gl,mode);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,gatherIBO);
  }
  gl.bindVertexArray(null);
  return {vao,gatherVao,vbo,ibo,idx:idxArr};
}

function deleteBaked(gl,batch) {
  for (const k of ['bakedFlat','bakedFull','bakedCurvedHi','bakedCurvedLo','bakedMirror']) {
    const b=batch[k];
    if (!b) continue;
    gl.deleteVertexArray(b.vao);
    if (b.gatherVao) gl.deleteVertexArray(b.gatherVao);
    gl.deleteBuffer(b.vbo);
    gl.deleteBuffer(b.ibo);
    batch[k]=null;
  }
}

function bakeStaticFlat(gl,mesh,boxNoBot,boxTopOnly,data,chunks,startF,countF,gatherIBO) {
  let totalV=0, totalI=0;
  for (let ci=0;ci<chunks.length;ci++) {
    const c=chunks[ci], end=c.start+c.count;
    for (let k=c.start;k<end;k++) {
      const o=k*STRIDE;
      const upright=data[o+1]===0 && data[o+9]===0 && data[o+5]>0;
      const m=(boxTopOnly && upright && Math.round(data[o+19])===22)
        ?boxTopOnly
        :(boxNoBot && upright && data[o+13]-data[o+5]*.5<=.035)?boxNoBot:mesh;
      totalV+=m.vCount; totalI+=m.iCount;
    }
  }
  if (!totalI) return null;
  const raw=new ArrayBuffer(totalV*20), f32=new Float32Array(raw), u8=new Uint8Array(raw);
  const idx=new Uint32Array(totalI);
  let vBase=0, iOff=0, fOff=0, bOff=0;
  for (let ci=0;ci<chunks.length;ci++) {
    const c=chunks[ci], end=c.start+c.count;
    c[startF]=iOff;
    for (let k=c.start;k<end;k++) {
      const o=k*STRIDE;
      const a00=data[o], a01=data[o+1], a02=data[o+2];
      const a10=data[o+4], a11=data[o+5], a12=data[o+6];
      const a20=data[o+8], a21=data[o+9], a22=data[o+10];
      const px=data[o+12], py=data[o+13], pz=data[o+14];
      const kind=clamp(Math.floor(data[o+19]+.5),0,255);
      const upright=a01===0 && a21===0 && a11>0;
      const m=(boxTopOnly && upright && kind===22)
        ?boxTopOnly
        :(boxNoBot && upright && py-a11*.5<=.035)?boxNoBot:mesh;
      const s0=a00*a00+a01*a01+a02*a02, s1=a10*a10+a11*a11+a12*a12, s2=a20*a20+a21*a21+a22*a22;
      const inv0=1/(s0>1e-12?s0:1e-12), inv1=1/(s1>1e-12?s1:1e-12), inv2=1/(s2>1e-12?s2:1e-12);
      const n00=a00*inv0, n01=a01*inv0, n02=a02*inv0;
      const n10=a10*inv1, n11=a11*inv1, n12=a12*inv1;
      const n20=a20*inv2, n21=a21*inv2, n22=a22*inv2;
      const r=clamp((data[o+16]*255+.5)|0,0,255), g=clamp((data[o+17]*255+.5)|0,0,255), b=clamp((data[o+18]*255+.5)|0,0,255);
      const sTop=data[o+3], sSide=data[o+7], sBot=data[o+11];
      const meta=clamp(Math.floor(data[o+21]+.5),0,15);
      const pos=m.pos, norm=m.norm, vc=m.vCount, mi=m.indices, ic=m.iCount;
      for (let v=0;v<vc;v++) {
        const vp=v*3, lx=pos[vp], ly=pos[vp+1], lz=pos[vp+2];
        f32[fOff]=a00*lx+a10*ly+a20*lz+px;
        f32[fOff+1]=a01*lx+a11*ly+a21*lz+py;
        f32[fOff+2]=a02*lx+a12*ly+a22*lz+pz;
        const lnx=norm[vp], lny=norm[vp+1], lnz=norm[vp+2];
        let wnx=n00*lnx+n10*lny+n20*lnz, wny=n01*lnx+n11*lny+n21*lnz, wnz=n02*lnx+n12*lny+n22*lnz;
        const invL=1/Math.sqrt(wnx*wnx+wny*wny+wnz*wnz+1e-24);
        wnx*=invL; wny*=invL; wnz*=invL;
        const slot=Math.floor((wny>.6?sTop:wny<-.6?sBot:sSide)+.5);
        u8[bOff+12]=r; u8[bOff+13]=g; u8[bOff+14]=b; u8[bOff+15]=kind;
        writeOctU8(u8,bOff+16,wnx,wny,wnz);
        u8[bOff+18]=(slot<-1?-1:slot>253?253:slot)+1;
        u8[bOff+19]=meta;
        fOff+=5; bOff+=20;
      }
      for (let ii=0;ii<ic;ii++) idx[iOff++]=vBase+mi[ii];
      vBase+=vc;
    }
    c[countF]=iOff-c[startF];
  }
  return makeBakedVAO(gl,'flat',raw,idx,gatherIBO);
}

function bakeStaticFull(gl,mesh,boxNoBot,data,chunks,startF,countF,shapeId,gatherIBO) {
  let totalV=0, totalI=0;
  for (let ci=0;ci<chunks.length;ci++) {
    const c=chunks[ci], end=c.start+c.count;
    for (let k=c.start;k<end;k++) {
      const o=k*STRIDE;
      const m=(boxNoBot && data[o+1]===0 && data[o+9]===0 && data[o+5]>0 && data[o+13]-data[o+5]*.5<=.035)?boxNoBot:mesh;
      totalV+=m.vCount; totalI+=m.iCount;
    }
  }
  if (!totalI) return null;
  const raw=new ArrayBuffer(totalV*36), f32=new Float32Array(raw), u8=new Uint8Array(raw);
  const idx=new Uint32Array(totalI);
  let vBase=0, iOff=0, fOff=0, bOff=0;
  const baseMeta=16+clamp(shapeId,0,15);
  for (let ci=0;ci<chunks.length;ci++) {
    const c=chunks[ci], end=c.start+c.count;
    c[startF]=iOff;
    for (let k=c.start;k<end;k++) {
      const o=k*STRIDE;
      const a00=data[o], a01=data[o+1], a02=data[o+2];
      const a10=data[o+4], a11=data[o+5], a12=data[o+6];
      const a20=data[o+8], a21=data[o+9], a22=data[o+10];
      const px=data[o+12], py=data[o+13], pz=data[o+14];
      const m=(boxNoBot && a01===0 && a21===0 && a11>0 && py-a11*.5<=.035)?boxNoBot:mesh;
      const s0=a00*a00+a01*a01+a02*a02, s1=a10*a10+a11*a11+a12*a12, s2=a20*a20+a21*a21+a22*a22;
      const vxSize=Math.sqrt(s0), vySize=Math.sqrt(s1), vzSize=Math.sqrt(s2);
      const invSx=1/(vxSize>1e-6?vxSize:1e-6), invSy=1/(vySize>1e-6?vySize:1e-6), invSz=1/(vzSize>1e-6?vzSize:1e-6);
      const ax0=a00*invSx, ax1=a01*invSx, ax2=a02*invSx;
      const ay0=a10*invSy, ay1=a11*invSy, ay2=a12*invSy;
      const az0=a20*invSz, az1=a21*invSz, az2=a22*invSz;
      const cz0=ax1*ay2-ax2*ay1, cz1=ax2*ay0-ax0*ay2, cz2=ax0*ay1-ax1*ay0;
      const n00=ax0*invSx, n01=ax1*invSx, n02=ax2*invSx;
      const n10=ay0*invSy, n11=ay1*invSy, n12=ay2*invSy;
      const n20=az0*invSz, n21=az1*invSz, n22=az2*invSz;
      const r=clamp((data[o+16]*255+.5)|0,0,255), g=clamp((data[o+17]*255+.5)|0,0,255), b=clamp((data[o+18]*255+.5)|0,0,255);
      const kind=clamp(Math.floor(data[o+19]+.5),0,255);
      const sTop=data[o+3], sSide=data[o+7], sBot=data[o+11];
      const extraX=data[o+20], extraY=data[o+21];
      const isFaceKind=kind===6 || kind===8 || kind===10 || kind===11 || kind===15 || kind===29;
      let k10Meta=baseMeta;
      if (kind===10) {
        let qx=px*.1031; qx-=Math.floor(qx);
        let qy=py*.1030; qy-=Math.floor(qy);
        let qz=pz*.0973; qz-=Math.floor(qz);
        const dd=qx*(qy+33.33)+qy*(qz+33.33)+qz*(qx+33.33);
        qx+=dd; qy+=dd; qz+=dd;
        let vSeed=(qx+qy)*qz; vSeed-=Math.floor(vSeed);
        if (vSeed<0) vSeed=0; else if (vSeed>.999) vSeed=.999;
        k10Meta=16+Math.floor(vSeed*15+.5);
      }
      const pos=m.pos, norm=m.norm, uv=m.uv, vc=m.vCount, mi=m.indices, ic=m.iCount;
      for (let v=0;v<vc;v++) {
        const vp=v*3, lx=pos[vp], ly=pos[vp+1], lz=pos[vp+2];
        f32[fOff]=a00*lx+a10*ly+a20*lz+px;
        f32[fOff+1]=a01*lx+a11*ly+a21*lz+py;
        f32[fOff+2]=a02*lx+a12*ly+a22*lz+pz;
        const lnx=norm[vp], lny=norm[vp+1], lnz=norm[vp+2];
        let wnx=n00*lnx+n10*lny+n20*lnz, wny=n01*lnx+n11*lny+n21*lnz, wnz=n02*lnx+n12*lny+n22*lnz;
        const invL=1/Math.sqrt(wnx*wnx+wny*wny+wnz*wnz+1e-24);
        wnx*=invL; wny*=invL; wnz*=invL;
        let slot=Math.floor((wny>.6?sTop:wny<-.6?sBot:sSide)+.5);
        let meta=baseMeta, fuvX=0, fuvY=0, fszX=0, fszY=0;
        if (isFaceKind) {
          const lpx=lx*vxSize, lpy=ly*vySize, lpz=lz*vzSize;
          const nObjX=wnx*ax0+wny*ax1+wnz*ax2;
          const nObjZ=wnx*cz0+wny*cz1+wnz*cz2;
          const fMaskX=Math.abs(nObjX)>=.5, fMaskZ=Math.abs(nObjZ)>=.5;
          let faceU=lpx, faceV=lpz, faceSX=vxSize, faceSY=vzSize;
          if (fMaskX) {faceU=-(nObjX>0?1:nObjX<0?-1:0)*lpz; faceV=lpy; faceSX=vzSize; faceSY=vySize;}
          else if (fMaskZ) {faceU=(nObjZ>0?1:nObjZ<0?-1:0)*lpx; faceV=lpy; faceSX=vxSize; faceSY=vySize;}
          fszX=faceSX; fszY=faceSY;
          if (kind===10) {
            if (Math.abs(wny)>.55) slot=S_ROOF_MEMBRANE;
            else slot=apartmentSlotJS(Math.floor(extraX+.5),fMaskZ?(nObjZ>0?0:1):2);
            meta=k10Meta;
            fuvX=faceU+faceSX*.5; fuvY=faceV+faceSY*.5;
          } else if (kind===15) {
            meta=16+clamp(Math.floor(extraY+.5),0,15);
            fuvX=faceU; fuvY=faceV;
          } else {
            fuvX=faceU+faceSX*.5; fuvY=faceV+faceSY*.5;
          }
        } else if (kind===23 || kind===25) {
          fuvX=uv[v*2]; fuvY=uv[v*2+1];
        } else if (kind===5) {
          meta=16+clamp(Math.floor(extraY+.5),0,15);
        }
        u8[bOff+12]=r; u8[bOff+13]=g; u8[bOff+14]=b; u8[bOff+15]=kind;
        writeOctU8(u8,bOff+16,wnx,wny,wnz);
        u8[bOff+18]=(slot<-1?-1:slot>253?253:slot)+1;
        u8[bOff+19]=meta;
        f32[fOff+5]=fuvX; f32[fOff+6]=fuvY; f32[fOff+7]=fszX; f32[fOff+8]=fszY;
        fOff+=9; bOff+=36;
      }
      for (let ii=0;ii<ic;ii++) idx[iOff++]=vBase+mi[ii];
      vBase+=vc;
    }
    c[countF]=iOff-c[startF];
  }
  return makeBakedVAO(gl,'full',raw,idx,gatherIBO);
}

function bakeStaticCurved(gl,mesh,data,chunks,startF,countF,gatherIBO) {
  let totalInst=0;
  for (let ci=0;ci<chunks.length;ci++) totalInst+=chunks[ci].count;
  if (!totalInst) return null;
  const vc=mesh.vCount, ic=mesh.iCount, pos=mesh.pos, norm=mesh.norm, mi=mesh.indices;
  const raw=new ArrayBuffer(totalInst*vc*24), f32=new Float32Array(raw), i8=new Int8Array(raw), u8=new Uint8Array(raw);
  const idx=new Uint32Array(totalInst*ic);
  let vBase=0, iOff=0, fOff=0, bOff=0;
  for (let ci=0;ci<chunks.length;ci++) {
    const c=chunks[ci], end=c.start+c.count;
    c[startF]=iOff;
    for (let k=c.start;k<end;k++) {
      const o=k*STRIDE;
      const a00=data[o], a01=data[o+1], a02=data[o+2];
      const a10=data[o+4], a11=data[o+5], a12=data[o+6];
      const a20=data[o+8], a21=data[o+9], a22=data[o+10];
      const px=data[o+12], py=data[o+13], pz=data[o+14];
      const s0=a00*a00+a01*a01+a02*a02, s1=a10*a10+a11*a11+a12*a12, s2=a20*a20+a21*a21+a22*a22;
      const inv0=1/(s0>1e-12?s0:1e-12), inv1=1/(s1>1e-12?s1:1e-12), inv2=1/(s2>1e-12?s2:1e-12);
      const n00=a00*inv0, n01=a01*inv0, n02=a02*inv0;
      const n10=a10*inv1, n11=a11*inv1, n12=a12*inv1;
      const n20=a20*inv2, n21=a21*inv2, n22=a22*inv2;
      const r=clamp((data[o+16]*255+.5)|0,0,255), g=clamp((data[o+17]*255+.5)|0,0,255), b=clamp((data[o+18]*255+.5)|0,0,255);
      const kind=clamp(Math.floor(data[o+19]+.5),0,255);
      const sT=clamp(Math.floor(data[o+3]+.5),-1,253)+1;
      const sS=clamp(Math.floor(data[o+7]+.5),-1,253)+1;
      const sB=clamp(Math.floor(data[o+11]+.5),-1,253)+1;
      const meta=clamp(Math.floor(data[o+21]+.5),0,15);
      for (let v=0;v<vc;v++) {
        const vp=v*3, lx=pos[vp], ly=pos[vp+1], lz=pos[vp+2];
        f32[fOff]=a00*lx+a10*ly+a20*lz+px;
        f32[fOff+1]=a01*lx+a11*ly+a21*lz+py;
        f32[fOff+2]=a02*lx+a12*ly+a22*lz+pz;
        const lnx=norm[vp], lny=norm[vp+1], lnz=norm[vp+2];
        let wnx=n00*lnx+n10*lny+n20*lnz, wny=n01*lnx+n11*lny+n21*lnz, wnz=n02*lnx+n12*lny+n22*lnz;
        const invL=1/Math.sqrt(wnx*wnx+wny*wny+wnz*wnz+1e-24);
        wnx*=invL; wny*=invL; wnz*=invL;
        const nxB=wnx>=0?(wnx*127+.5)|0:(wnx*127-.5)|0;
        const nyB=wny>=0?(wny*127+.5)|0:(wny*127-.5)|0;
        const nzB=wnz>=0?(wnz*127+.5)|0:(wnz*127-.5)|0;
        i8[bOff+12]=nxB<-127?-127:nxB>127?127:nxB;
        i8[bOff+13]=nyB<-127?-127:nyB>127?127:nyB;
        i8[bOff+14]=nzB<-127?-127:nzB>127?127:nzB;
        i8[bOff+15]=0;
        u8[bOff+16]=r; u8[bOff+17]=g; u8[bOff+18]=b; u8[bOff+19]=kind;
        u8[bOff+20]=sT; u8[bOff+21]=sS; u8[bOff+22]=sB; u8[bOff+23]=meta;
        fOff+=6; bOff+=24;
      }
      for (let ii=0;ii<ic;ii++) idx[iOff++]=vBase+mi[ii];
      vBase+=vc;
    }
    c[countF]=iOff-c[startF];
  }
  return makeBakedVAO(gl,'curved',raw,idx,gatherIBO);
}

// Reusable non-instanced dynamic vertex/index streamer: collapses all dynamic
// instances per pass into a single gl.drawElements(UNSIGNED_INT) call.
class DynStream {
  constructor(gl,mode,initVerts=32768,initIdx=65536) {
    this.gl=gl;
    this.mode=mode;
    this.stride=mode==='flat'?20:mode==='curved'?24:12;
    this.vCap=initVerts;
    this.iCap=initIdx;
    this.vCount=0;
    this.iCount=0;
    this.raw=new ArrayBuffer(this.vCap*this.stride);
    this.f32=new Float32Array(this.raw);
    this.u8=new Uint8Array(this.raw);
    this.i8=new Int8Array(this.raw);
    this.idx=new Uint32Array(this.iCap);
    this.vao=gl.createVertexArray();
    this.vbo=gl.createBuffer();
    this.ibo=gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER,this.vCap*this.stride,gl.STREAM_DRAW);
    setupBakedAttribs(gl,mode);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,this.iCap*4,gl.STREAM_DRAW);
    gl.bindVertexArray(null);
  }

  reset() {
    this.vCount=0;
    this.iCount=0;
  }

  ensure(addV,addI) {
    const gl=this.gl;
    if (this.vCount+addV>this.vCap) {
      let cap=this.vCap;
      while (cap<this.vCount+addV) cap<<=1;
      const next=new ArrayBuffer(cap*this.stride);
      new Uint8Array(next).set(this.u8.subarray(0,this.vCount*this.stride));
      this.raw=next;
      this.f32=new Float32Array(next);
      this.u8=new Uint8Array(next);
      this.i8=new Int8Array(next);
      this.vCap=cap;
      gl.bindBuffer(gl.ARRAY_BUFFER,this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER,cap*this.stride,gl.STREAM_DRAW);
    }
    if (this.iCount+addI>this.iCap) {
      let cap=this.iCap;
      while (cap<this.iCount+addI) cap<<=1;
      const next=new Uint32Array(cap);
      next.set(this.idx.subarray(0,this.iCount));
      this.idx=next;
      this.iCap=cap;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,cap*4,gl.STREAM_DRAW);
    }
  }

  appendFlat(mesh,data,count,clipMinY=-1e9) {
    if (!count) return;
    const vc=mesh.vCount, ic=mesh.iCount;
    this.ensure(count*vc,count*ic);
    const f32=this.f32, u8=this.u8, idx=this.idx;
    const pos=mesh.pos, norm=mesh.norm, mi=mesh.indices;
    const doClip=clipMinY>-1e8;
    let vBase=this.vCount, iOff=this.iCount, fOff=vBase*5, bOff=vBase*20;
    for (let k=0;k<count;k++) {
      const o=k*STRIDE;
      const a01=data[o+1], a11=data[o+5], a21=data[o+9], py=data[o+13];
      if (doClip && py+(Math.abs(a01)+Math.abs(a11)+Math.abs(a21))*.62<clipMinY) continue;
      const a00=data[o], a02=data[o+2], a10=data[o+4], a12=data[o+6], a20=data[o+8], a22=data[o+10];
      const px=data[o+12], pz=data[o+14];
      const s0=a00*a00+a01*a01+a02*a02, s1=a10*a10+a11*a11+a12*a12, s2=a20*a20+a21*a21+a22*a22;
      const inv0=1/(s0>1e-12?s0:1e-12), inv1=1/(s1>1e-12?s1:1e-12), inv2=1/(s2>1e-12?s2:1e-12);
      const n00=a00*inv0, n01=a01*inv0, n02=a02*inv0;
      const n10=a10*inv1, n11=a11*inv1, n12=a12*inv1;
      const n20=a20*inv2, n21=a21*inv2, n22=a22*inv2;
      const r=clamp((data[o+16]*255+.5)|0,0,255), g=clamp((data[o+17]*255+.5)|0,0,255), b=clamp((data[o+18]*255+.5)|0,0,255);
      const kind=clamp(Math.floor(data[o+19]+.5),0,255);
      const sTop=data[o+3], sSide=data[o+7], sBot=data[o+11];
      const meta=clamp(Math.floor(data[o+21]+.5),0,15);
      for (let v=0;v<vc;v++) {
        const vp=v*3, lx=pos[vp], ly=pos[vp+1], lz=pos[vp+2];
        f32[fOff]=a00*lx+a10*ly+a20*lz+px;
        f32[fOff+1]=a01*lx+a11*ly+a21*lz+py;
        f32[fOff+2]=a02*lx+a12*ly+a22*lz+pz;
        const lnx=norm[vp], lny=norm[vp+1], lnz=norm[vp+2];
        let wnx=n00*lnx+n10*lny+n20*lnz, wny=n01*lnx+n11*lny+n21*lnz, wnz=n02*lnx+n12*lny+n22*lnz;
        const invL=1/Math.sqrt(wnx*wnx+wny*wny+wnz*wnz+1e-24);
        wnx*=invL; wny*=invL; wnz*=invL;
        const slot=Math.floor((wny>.6?sTop:wny<-.6?sBot:sSide)+.5);
        u8[bOff+12]=r; u8[bOff+13]=g; u8[bOff+14]=b; u8[bOff+15]=kind;
        writeOctU8(u8,bOff+16,wnx,wny,wnz);
        u8[bOff+18]=(slot<-1?-1:slot>253?253:slot)+1;
        u8[bOff+19]=meta;
        fOff+=5; bOff+=20;
      }
      for (let ii=0;ii<ic;ii++) idx[iOff++]=vBase+mi[ii];
      vBase+=vc;
    }
    this.vCount=vBase;
    this.iCount=iOff;
  }

  appendCurved(mesh,data,count,clipMinY=-1e9) {
    if (!count) return;
    const vc=mesh.vCount, ic=mesh.iCount;
    this.ensure(count*vc,count*ic);
    const f32=this.f32, i8=this.i8, u8=this.u8, idx=this.idx;
    const pos=mesh.pos, norm=mesh.norm, mi=mesh.indices;
    const doClip=clipMinY>-1e8;
    let vBase=this.vCount, iOff=this.iCount, fOff=vBase*6, bOff=vBase*24;
    for (let k=0;k<count;k++) {
      const o=k*STRIDE;
      const a01=data[o+1], a11=data[o+5], a21=data[o+9], py=data[o+13];
      if (doClip && py+(Math.abs(a01)+Math.abs(a11)+Math.abs(a21))*.62<clipMinY) continue;
      const a00=data[o], a02=data[o+2], a10=data[o+4], a12=data[o+6], a20=data[o+8], a22=data[o+10];
      const px=data[o+12], pz=data[o+14];
      const s0=a00*a00+a01*a01+a02*a02, s1=a10*a10+a11*a11+a12*a12, s2=a20*a20+a21*a21+a22*a22;
      const inv0=1/(s0>1e-12?s0:1e-12), inv1=1/(s1>1e-12?s1:1e-12), inv2=1/(s2>1e-12?s2:1e-12);
      const n00=a00*inv0, n01=a01*inv0, n02=a02*inv0;
      const n10=a10*inv1, n11=a11*inv1, n12=a12*inv1;
      const n20=a20*inv2, n21=a21*inv2, n22=a22*inv2;
      const r=clamp((data[o+16]*255+.5)|0,0,255), g=clamp((data[o+17]*255+.5)|0,0,255), b=clamp((data[o+18]*255+.5)|0,0,255);
      const kind=clamp(Math.floor(data[o+19]+.5),0,255);
      const sT=clamp(Math.floor(data[o+3]+.5),-1,253)+1;
      const sS=clamp(Math.floor(data[o+7]+.5),-1,253)+1;
      const sB=clamp(Math.floor(data[o+11]+.5),-1,253)+1;
      const meta=clamp(Math.floor(data[o+21]+.5),0,15);
      for (let v=0;v<vc;v++) {
        const vp=v*3, lx=pos[vp], ly=pos[vp+1], lz=pos[vp+2];
        f32[fOff]=a00*lx+a10*ly+a20*lz+px;
        f32[fOff+1]=a01*lx+a11*ly+a21*lz+py;
        f32[fOff+2]=a02*lx+a12*ly+a22*lz+pz;
        const lnx=norm[vp], lny=norm[vp+1], lnz=norm[vp+2];
        let wnx=n00*lnx+n10*lny+n20*lnz, wny=n01*lnx+n11*lny+n21*lnz, wnz=n02*lnx+n12*lny+n22*lnz;
        const invL=1/Math.sqrt(wnx*wnx+wny*wny+wnz*wnz+1e-24);
        wnx*=invL; wny*=invL; wnz*=invL;
        const nxB=wnx>=0?(wnx*127+.5)|0:(wnx*127-.5)|0;
        const nyB=wny>=0?(wny*127+.5)|0:(wny*127-.5)|0;
        const nzB=wnz>=0?(wnz*127+.5)|0:(wnz*127-.5)|0;
        i8[bOff+12]=nxB<-127?-127:nxB>127?127:nxB;
        i8[bOff+13]=nyB<-127?-127:nyB>127?127:nyB;
        i8[bOff+14]=nzB<-127?-127:nzB>127?127:nzB;
        i8[bOff+15]=0;
        u8[bOff+16]=r; u8[bOff+17]=g; u8[bOff+18]=b; u8[bOff+19]=kind;
        u8[bOff+20]=sT; u8[bOff+21]=sS; u8[bOff+22]=sB; u8[bOff+23]=meta;
        fOff+=6; bOff+=24;
      }
      for (let ii=0;ii<ic;ii++) idx[iOff++]=vBase+mi[ii];
      vBase+=vc;
    }
    this.vCount=vBase;
    this.iCount=iOff;
  }

  appendShadow(meshLo,meshSh,data,count,planes) {
    if (!count) return;
    const maxV=meshLo.vCount>meshSh.vCount?meshLo.vCount:meshSh.vCount;
    const maxI=meshLo.iCount>meshSh.iCount?meshLo.iCount:meshSh.iCount;
    this.ensure(count*maxV,count*maxI);
    const f32=this.f32, idx=this.idx;
    const useProxy=meshSh!==meshLo;
    const p0=planes?planes[0]:null, p1=planes?planes[1]:null, p2=planes?planes[2]:null, p3=planes?planes[3]:null;
    const a0x=p0?Math.abs(p0[0]):0, a0y=p0?Math.abs(p0[1]):0, a0z=p0?Math.abs(p0[2]):0;
    const a1x=p1?Math.abs(p1[0]):0, a1y=p1?Math.abs(p1[1]):0, a1z=p1?Math.abs(p1[2]):0;
    const a2x=p2?Math.abs(p2[0]):0, a2y=p2?Math.abs(p2[1]):0, a2z=p2?Math.abs(p2[2]):0;
    const a3x=p3?Math.abs(p3[0]):0, a3y=p3?Math.abs(p3[1]):0, a3z=p3?Math.abs(p3[2]):0;
    let vBase=this.vCount, iOff=this.iCount, fOff=vBase*3;
    for (let k=0;k<count;k++) {
      const o=k*STRIDE;
      const a00=data[o], a01=data[o+1], a02=data[o+2];
      const a10=data[o+4], a11=data[o+5], a12=data[o+6];
      const a20=data[o+8], a21=data[o+9], a22=data[o+10];
      const px=data[o+12], py=data[o+13], pz=data[o+14];
      const ex=Math.abs(a00)+Math.abs(a10)+Math.abs(a20);
      const ey=Math.abs(a01)+Math.abs(a11)+Math.abs(a21);
      const ez=Math.abs(a02)+Math.abs(a12)+Math.abs(a22);
      if (p0) {
        const hx=ex*.62, hy=ey*.62, hz=ez*.62;
        if (p0[0]*px+p0[1]*py+p0[2]*pz+p0[3]+a0x*hx+a0y*hy+a0z*hz<0) continue;
        if (p1[0]*px+p1[1]*py+p1[2]*pz+p1[3]+a1x*hx+a1y*hy+a1z*hz<0) continue;
        if (p2[0]*px+p2[1]*py+p2[2]*pz+p2[3]+a2x*hx+a2y*hy+a2z*hz<0) continue;
        if (p3[0]*px+p3[1]*py+p3[2]*pz+p3[3]+a3x*hx+a3y*hy+a3z*hz<0) continue;
      }
      // Small dynamic pieces (<0.45m radius: projectiles, droplets, small trim) use low-poly
      // shadow proxy md.sh while large silhouettes (>=0.45m: actors, cars, Boss/Goat) keep exact md.lo.
      const m=(useProxy && ex<.90 && ey<.90 && ez<.90)?meshSh:meshLo;
      const pos=m.pos, mi=m.indices, vc=m.vCount, ic=m.iCount;
      for (let v=0;v<vc;v++) {
        const vp=v*3, lx=pos[vp], ly=pos[vp+1], lz=pos[vp+2];
        f32[fOff]=a00*lx+a10*ly+a20*lz+px;
        f32[fOff+1]=a01*lx+a11*ly+a21*lz+py;
        f32[fOff+2]=a02*lx+a12*ly+a22*lz+pz;
        fOff+=3;
      }
      for (let ii=0;ii<ic;ii++) idx[iOff++]=vBase+mi[ii];
      vBase+=vc;
    }
    this.vCount=vBase;
    this.iCount=iOff;
  }

  flush() {
    if (!this.iCount) return;
    const gl=this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER,0,this.u8.subarray(0,this.vCount*this.stride));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.ibo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER,0,this.idx.subarray(0,this.iCount));
    gl.drawElements(gl.TRIANGLES,this.iCount,gl.UNSIGNED_INT,0);
    this.vCount=0;
    this.iCount=0;
  }
}

// Solves A * X = B (n x n matrix A, n x 3 RHS B) via Gaussian elimination with partial pivoting.
function solveLinear3(A,B,n,out) {
  const M=new Float64Array(n*(n+3));
  for (let r=0;r<n;r++) {
    for (let c=0;c<n;c++) M[r*(n+3)+c]=A[r*n+c];
    for (let k=0;k<3;k++) M[r*(n+3)+n+k]=B[r*3+k];
  }
  for (let col=0;col<n;col++) {
    let piv=col, best=Math.abs(M[col*(n+3)+col]);
    for (let r=col+1;r<n;r++) {
      const v=Math.abs(M[r*(n+3)+col]);
      if (v>best) {best=v;piv=r;}
    }
    if (piv!==col) {
      for (let c=col;c<n+3;c++) {
        const t=M[col*(n+3)+c]; M[col*(n+3)+c]=M[piv*(n+3)+c]; M[piv*(n+3)+c]=t;
      }
    }
    const diag=M[col*(n+3)+col];
    if (Math.abs(diag)<1e-12) continue;
    const inv=1/diag;
    for (let c=col;c<n+3;c++) M[col*(n+3)+c]*=inv;
    for (let r=0;r<n;r++) {
      if (r===col) continue;
      const f=M[r*(n+3)+col];
      if (!f) continue;
      for (let c=col;c<n+3;c++) M[r*(n+3)+c]-=f*M[col*(n+3)+c];
    }
  }
  for (let r=0;r<n;r++) {
    out[r][0]=M[r*(n+3)+n];
    out[r][1]=M[r*(n+3)+n+1];
    out[r][2]=M[r*(n+3)+n+2];
  }
}

function equiDecode(u,v) {
  const phi=(u-.5)*TAU, theta=v*Math.PI, st=Math.sin(theta);
  return [st*Math.sin(phi),Math.cos(theta),-st*Math.cos(phi)];
}

function envDecodeCh(v) {
  return v/Math.max(1-v,0.004);
}

function sampleRectBilinear(grid,w,h,u,v,out) {
  const fx=u*w-.5, fy=v*h-.5;
  const x0=((Math.floor(fx)%w)+w)%w, x1=(x0+1)%w;
  const y0=clamp(Math.floor(fy),0,h-1), y1=Math.min(h-1,y0+1);
  const tx=fx-Math.floor(fx), ty=clamp(fy-y0,0,1);
  const i00=(y0*w+x0)*3, i10=(y0*w+x1)*3, i01=(y1*w+x0)*3, i11=(y1*w+x1)*3;
  const w00=(1-tx)*(1-ty), w10=tx*(1-ty), w01=(1-tx)*ty, w11=tx*ty;
  out[0]=grid[i00]*w00+grid[i10]*w10+grid[i01]*w01+grid[i11]*w11;
  out[1]=grid[i00+1]*w00+grid[i10+1]*w10+grid[i01+1]*w01+grid[i11+1]*w11;
  out[2]=grid[i00+2]*w00+grid[i10+2]*w10+grid[i01+2]*w01+grid[i11+2]*w11;
}

function skyAtmosFallback(dx,dy,dz,bossRage,rainLevel,out) {
  const h=dy>0?dy:0, mu=dx*SUN[0]+dy*SUN[1]+dz*SUN[2];
  const horizon=Math.pow(1-h,5.5);
  const zr=mix(mix(.050,.055,rainLevel),.018,bossRage);
  const zg=mix(mix(.135,.068,rainLevel),.003,bossRage);
  const zb=mix(mix(.390,.088,rainLevel),.005,bossRage);
  const hr=mix(mix(.44,.13,rainLevel),.30,bossRage);
  const hg=mix(mix(.55,.155,rainLevel),.020,bossRage);
  const hb=mix(mix(.68,.185,rainLevel),.026,bossRage);
  const k=.84+.30*clamp(mu*.5+.5,0,1)*(1-rainLevel*.75);
  let r=mix(zr,hr,horizon)*k, g=mix(zg,hg,horizon)*k, b=mix(zb,hb,horizon)*k;
  const a=mu>0?mu:0;
  const glow=(Math.pow(a,5)*.16+Math.pow(a,36)*.42)*mix(.55,1,horizon)*(1-rainLevel*.86);
  r+=mix(1,.92,bossRage)*glow; g+=mix(.82,.10,bossRage)*glow; b+=mix(.60,.08,bossRage)*glow;
  if (dy<0) {
    const t=clamp(-dy*4.5,0,1);
    r=mix(hr*mix(.86,.35,bossRage),mix(.105,.018,bossRage),t);
    g=mix(hg*mix(.87,.08,bossRage),mix(.11,.005,bossRage),t);
    b=mix(hb*mix(.86,.09,bossRage),mix(.105,.008,bossRage),t);
  }
  const sc=mix(mix(1.55,.88,rainLevel),1.25,bossRage);
  out[0]=r*sc; out[1]=g*sc; out[2]=b*sc;
}

// Fits exact 6-cardinal spherical irradiance (matching 256x128 equirectangular envAt(n, 6.4)*0.92
// to 0.0001 on all +/-X,+/-Y,+/-Z faces) and 4-term upper-hemisphere fog radiance from mip 4 (16x8).
function fitEnvSH(pixels16x8,bossRage,rainLevel,shOut,fogOut) {
  let hasData=false;
  if (pixels16x8) {
    for (let i=0;i<pixels16x8.length;i+=4) {
      if (pixels16x8[i] || pixels16x8[i+1] || pixels16x8[i+2]) {hasData=true; break;}
    }
  }
  const m4=new Float64Array(16*8*3);
  const tmp=[0,0,0];
  if (hasData) {
    for (let i=0;i<128;i++) {
      m4[i*3]=pixels16x8[i*4]/255;
      m4[i*3+1]=pixels16x8[i*4+1]/255;
      m4[i*3+2]=pixels16x8[i*4+2]/255;
    }
  } else {
    for (let iy=0;iy<8;iy++) for (let ix=0;ix<16;ix++) {
      const [dx,dy,dz]=equiDecode((ix+.5)/16,(iy+.5)/8);
      skyAtmosFallback(dx,dy,dz,bossRage,rainLevel,tmp);
      const o=(iy*16+ix)*3;
      m4[o]=tmp[0]/(1+tmp[0]); m4[o+1]=tmp[1]/(1+tmp[1]); m4[o+2]=tmp[2]/(1+tmp[2]);
    }
  }
  // Exact WebGL2 box mip pyramid in encoded RGBA8 space: 16x8 -> 8x4 -> 4x2 -> 2x1.
  const boxDown=(src,sw,sh)=>{
    const dw=Math.max(1,sw>>1), dh=Math.max(1,sh>>1), dst=new Float64Array(dw*dh*3);
    for (let y=0;y<dh;y++) for (let x=0;x<dw;x++) {
      const d=(y*dw+x)*3;
      for (let oy=0;oy<2;oy++) for (let ox=0;ox<2;ox++) {
        const s=(Math.min(sh-1,y*2+oy)*sw+Math.min(sw-1,x*2+ox))*3;
        dst[d]+=src[s]*.25; dst[d+1]+=src[s+1]*.25; dst[d+2]+=src[s+2]*.25;
      }
    }
    return dst;
  };
  const m5=boxDown(m4,16,8), m6=boxDown(m5,8,4), m7=boxDown(m6,4,2);
  const sA=[0,0,0], sB=[0,0,0];
  const eval64=(nx,ny,nz)=>{
    const u=(nx===0 && nz===0)?.5:(Math.atan2(nx,-nz)/TAU+.5);
    const v=Math.acos(clamp(ny,-1,1))/Math.PI;
    sampleRectBilinear(m6,4,2,u,v,sA);
    sampleRectBilinear(m7,2,1,u,v,sB);
    return [envDecodeCh(sA[0]*.6+sB[0]*.4)*.92,envDecodeCh(sA[1]*.6+sB[1]*.4)*.92,envDecodeCh(sA[2]*.6+sB[2]*.4)*.92];
  };
  const up=eval64(0,1,0), dn=eval64(0,-1,0);
  const px=eval64(1,0,0), mx=eval64(-1,0,0), pz=eval64(0,0,1), mz=eval64(0,0,-1);
  for (let c=0;c<3;c++) {
    const sideAvg=(px[c]+mx[c]+pz[c]+mz[c])*.25;
    shOut[0][c]=up[c];
    shOut[1][c]=dn[c];
    shOut[2][c]=(px[c]-mx[c])*.5;
    shOut[3][c]=(pz[c]-mz[c])*.5;
    shOut[4][c]=4*(sideAvg-(up[c]+dn[c])*.5);
  }
  const Afog=new Float64Array(16), Bfog=new Float64Array(12);
  const b4=[0,0,0,0];
  for (let iy=0;iy<8;iy++) for (let ix=0;ix<16;ix++) {
    const u=(ix+.5)/16, v=(iy+.5)/8;
    const [dx,dy,dz]=equiDecode(u,v);
    if (dy>=-.05) {
      sampleRectBilinear(m4,16,8,u,v,sA);
      sampleRectBilinear(m5,8,4,u,v,sB);
      const fr=envDecodeCh(sA[0]*.5+sB[0]*.5), fg=envDecodeCh(sA[1]*.5+sB[1]*.5), fb=envDecodeCh(sA[2]*.5+sB[2]*.5);
      b4[0]=1; b4[1]=dy; b4[2]=dx; b4[3]=dz;
      const wFog=dy<.45?2.0:0.7;
      for (let r=0;r<4;r++) {
        const wr=wFog*b4[r];
        Bfog[r*3]+=wr*fr; Bfog[r*3+1]+=wr*fg; Bfog[r*3+2]+=wr*fb;
        for (let c=0;c<4;c++) Afog[r*4+c]+=wr*b4[c];
      }
    }
  }
  for (let i=0;i<4;i++) Afog[i*4+i]+=1e-6;
  solveLinear3(Afog,Bfog,4,fogOut);
}

function withDefines(source,defs) {
  return source.replace('#version 300 es','#version 300 es\n'+defs);
}

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

// The per-texture table (colour and layer of every slot) is one uniform
// buffer shared by the full, mirror and lightweight scene shaders.
const SURFACE_TABLE=0;
function surfaceTable(gl,shader) {
  const index=gl.getUniformBlockIndex(shader,'SurfaceTable');
  if (index!==gl.INVALID_INDEX) gl.uniformBlockBinding(shader,index,SURFACE_TABLE);
}

function samplers(gl,shader,units) {
  gl.useProgram(shader);
  for (const [name,unit] of Object.entries(units)) gl.uniform1i(gl.getUniformLocation(shader,name),unit);
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
    ctx.font = '800 ' + (label.length <= 3 ? 78 : label.length < 8 ? 56 : 44) + 'px "Helvetica Neue", Arial, "Noto Sans", sans-serif';
    ctx.fillText(label, i % 4 * 256 + 128, Math.floor(i / 4) * 96 + 49, 236);
  });
  return c;
}

function labelTexture(gl,anisotropy) {
  const c = labelAtlas();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,c);
  gl.generateMipmap(gl.TEXTURE_2D);
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D,anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,4);
  return texture;
}

function biasOrthoShadowInto(m,out) {
  for (let i=0;i<12;i++) out[i]=m[i]*.5;
  out[12]=m[12]*.5+.5; out[13]=m[13]*.5+.5; out[14]=m[14]*.5+.5;
  out[3]=0; out[7]=0; out[11]=0; out[15]=1;
  return out;
}

const SH_UNIFORMS=['uSH0','uSH1','uSH2','uSH3','uSH4','uFog0','uFog1','uFog2','uFog3'];
const SCENE_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uShape','uQuality','uHDR','uMirrorPass',
  'uShadowOn','uCascades','uShadowM0','uShadowM1','uShadowTexel','uAtlasGrid','uReflectOn','uViewport','uEnvLod','uClock',
  'uZoneX','uUnderX','uUnderY','uCabinX','uRailCabinX','uCabinY','uInkTexel','uInkBounds','uExposure','uSurfaceSheets','uSurfaceEdge','uDrawFar',
  'uBossRage','uRaytrace','uWetLevel','uRainLevel',...SH_UNIFORMS];
const ARCH_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uQuality','uHDR','uShadowOn',
  'uCascades','uShadowM0','uShadowM1','uShadowTexel','uInkTexel','uInkBounds','uEnvLod','uViewport','uExposure','uSurfaceSheets','uSurfaceEdge','uDrawFar',
  'uBossRage','uRaytrace','uWetLevel','uRainLevel',...SH_UNIFORMS];
const ARCH_INTERIOR_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uHDR','uInkTexel','uInkBounds','uUnderX','uUnderY','uCabinX',
  'uRailCabinX','uCabinY','uViewport','uExposure','uSurfaceSheets','uSurfaceEdge'];
const MIRROR_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uEnvLod','uSurfaceSheets','uSurfaceEdge',...SH_UNIFORMS];
const GBUF_ARCH_UNIFORMS=['uVP','uDrawOffset','uMergeStairs'];
const GBUF_FULL_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uShape'];
const GBUF_BAKED_UNIFORMS=['uVP'];
const DEFERRED_OUTDOOR_UNIFORMS=['uForward','uRight','uUp','uField','uDepthAB','uEye','uPixelStep','uSun','uSunColor','uShadowOn',
  'uCascades','uShadowM0','uShadowM1','uShadowTexel','uInkTexel','uInkBounds','uInkActiveBox','uEnvLod','uReflectOn','uViewport','uClock','uFogParams',
  'uRaytrace','uWetLevel','uBossRage','uRainLevel','uSurfaceSheets','uSurfaceEdge',...SH_UNIFORMS];
const DEFERRED_MIRROR_UNIFORMS=['uForward','uRight','uUp','uField','uDepthAB','uEye','uSun','uSunColor','uMirrorExpH0','uSurfaceSheets','uSurfaceEdge',...SH_UNIFORMS];
const SCENE_ALPHA_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uShadowOn','uCascades','uShadowM0','uShadowM1',
  'uShadowTexel','uAtlasGrid','uEnvLod','uClock','uFogParams','uBossRage','uRainLevel',...SH_UNIFORMS];
const SCENE_CUTOUT_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uShadowOn','uCascades','uShadowM0','uShadowM1',
  'uShadowTexel','uInkTexel','uInkBounds','uInkActiveBox','uEnvLod','uClock','uFogParams','uRaytrace','uWetLevel','uBossRage','uRainLevel',
  'uSurfaceSheets','uSurfaceEdge',...SH_UNIFORMS];
const DEPTH_UNIFORMS=['uVP','uDrawOffset','uMergeStairs'];
const SKY_UNIFORMS=['uRight','uUp','uForward','uSun','uField','uClock','uInterior','uHDR','uViewport','uExposure','uBossRage','uRainLevel'];
const MIRROR_SKY_UNIFORMS=['uRight','uUp','uForward','uField'];
const UNIT={shadow0:0,ink:1,atlas:2,reflection:3,env:4,detail:5,shadow1:6,postA:7,postB:8,postC:9,surface:10,sheet:11,small:12};
const SCENE_SAMPLERS={uShadow0:UNIT.shadow0,uInk:UNIT.ink,uAtlas:UNIT.atlas,uReflection:UNIT.reflection,
  uEnv:UNIT.env,uDetail:UNIT.detail,uShadow1:UNIT.shadow1,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const ARCH_SAMPLERS={uShadow0:UNIT.shadow0,uShadow1:UNIT.shadow1,uInk:UNIT.ink,uEnv:UNIT.env,uDetail:UNIT.detail,
  uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const ARCH_INTERIOR_SAMPLERS={uDetail:UNIT.detail,uInk:UNIT.ink,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const DEFERRED_OUTDOOR_SAMPLERS={uGDepth:UNIT.postA,uG0:UNIT.postB,uG1:UNIT.postC,uG2:UNIT.sheet,
  uShadow0:UNIT.shadow0,uShadow1:UNIT.shadow1,uInk:UNIT.ink,uReflection:UNIT.reflection,
  uEnv:UNIT.env,uDetail:UNIT.detail,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const DEFERRED_MIRROR_SAMPLERS={uMDepth:UNIT.postA,uMG0:UNIT.postB,uMG1:UNIT.postC,uEnv:UNIT.env,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const SCENE_ALPHA_SAMPLERS={uShadow0:UNIT.shadow0,uShadow1:UNIT.shadow1,uAtlas:UNIT.atlas,uEnv:UNIT.env,uDetail:UNIT.detail};
const SCENE_CUTOUT_SAMPLERS={uShadow0:UNIT.shadow0,uShadow1:UNIT.shadow1,uInk:UNIT.ink,uEnv:UNIT.env,uDetail:UNIT.detail,
  uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
// Per-pass culling: LOD switch distances + 4 hierarchical effective solid-angle
// tiers (micro <0.24m, small <0.58m, medium <1.45m, large >=1.45m) + hard cut.
const HIGH_DRAW={lodDist:22,bevelLodDist:14,tierDist:[44,92,190,Infinity],cull:Infinity};
// Fixed render resolutions offered in the settings (pixels of the frame).
const RESOLUTION_PIXELS={fhd:1920*1080,'2k':2560*1440};
// The lightweight modes only draw the street around the fight: far enough to
// see every opponent a weapon can reach, with fog covering the cut.
const LITE_DRAW={lodDist:10,bevelLodDist:6,tierDist:[22,48,76,96],cull:96};
const ULTRA_DRAW={lodDist:0,bevelLodDist:0,tierDist:[12,22,46,64],cull:64};
const OVERVIEW_DRAW={lodDist:0,bevelLodDist:0,tierDist:[0,95,165,Infinity],cull:Infinity};
const MIRROR_DRAW={lodDist:0,bevelLodDist:0,tierDist:[0,22,85,260],cull:260};
const SHADOW_C0={lodDist:12,bevelLodDist:8,tierDist:[18,34,Infinity,Infinity],cull:Infinity};
const SHADOW_C1={lodDist:0,bevelLodDist:0,tierDist:[0,0,72,Infinity],cull:Infinity};
// Internal resolution of the lightweight modes, in lines on the short side.
export const LITE_LINES=400, ULTRA_LINES=300;
const LITE_FOG=[.74,.80,.85];
const LITE_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uClock','uAtlasGrid','uUnderX','uUnderY','uCabinX',
  'uRailCabinX','uCabinY','uInkBounds','uFog','uFogRange','uShape','uSurfaceSheets','uSurfaceEdge','uBossRage','uRainLevel'];
const LITE_SKY_UNIFORMS=['uRight','uUp','uForward','uSun','uFog','uField','uInterior','uBossRage','uRainLevel'];
const ENV_SIZE=[256,128];

export class Renderer {
  constructor(canvas, paint) {
    this.canvas = canvas;
    this.zone=0;
    this.quality='high';
    this.lite=false;
    this.ultralite=false;
    this.ultra=false;
    this.raytrace=false;
    this.fidelity=true;
    this.bossRage=0;
    this.wetLevel=0;
    this.envBossRage=0;
    this._invVP=new Float32Array(16);
    this._mirrorInvVP=new Float32Array(16);
    this._shadowBias0=new Float32Array(16);
    this._shadowBias1=new Float32Array(16);
    this._lastEye=[0,3,18];
    this._lastDir=[0,0,-1];
    this._lastRight=[1,0,0];
    this._lastUp=[0,1,0];
    this._lastAspect=16/9;
    this._mirrorMaxRow=0;
    this._sunColor=new Float32Array(SUN_RADIANCE);
    this.scale=1;
    this.adaptive=true;
    // Display refresh interval in ms; the frame budget follows it up to 120 fps.
    this.refreshInterval=1000/60;
    // Player graphics settings (main.js): render resolution, reflections and
    // how far the city chunks draw.
    this.options={resolution:'auto',reflections:true,drawDistance:Infinity};
    this.fixedSize=null;
    const gl = canvas.getContext('webgl2', {alpha:false,antialias:true,stencil:false,powerPreference:'high-performance'});
    if (!gl) {
      const error = new Error('WebGL 2 が利用できません。');
      error.name = 'WebGLUnavailable';
      throw error;
    }
    this.gl = gl;
    const driver=gl.getExtension('WEBGL_debug_renderer_info');
    this.cpuRenderer=driver ? /swiftshader|llvmpipe|software rasterizer/i.test(gl.getParameter(driver.UNMASKED_RENDERER_WEBGL)) : false;
    this.floatTargets=!!gl.getExtension('EXT_color_buffer_float');
    this.anisotropy=gl.getExtension('EXT_texture_filter_anisotropic');
    this.renderLimit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
    this.textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.occluder = new OccluderCuller();
    this._sh=[new Float32Array(3),new Float32Array(3),new Float32Array(3),new Float32Array(3),new Float32Array(3)];
    this._fog=[new Float32Array(3),new Float32Array(3),new Float32Array(3),new Float32Array(3)];
    this._envMip16=new Uint8Array(16*8*4);
    this._staticShadowCache=null;
    this._staticShadowDirty=true;
    this._archDynHandled=false;
    this._triHandledInArch=false;
    const sceneVert=withDefines(SCENE_VERTEX,'#define USE_SHADOW0 1');
    try {
      this.scene = program(gl,sceneVert,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define USE_SHADOW0 1'));
      this.sceneOutdoorOpaque = program(gl,sceneVert,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define OPAQUE_PURE 1\n#define OUTDOOR_ONLY 1\n#define FULL_OUTDOOR 1\n#define USE_SHADOW0 1'));
    } catch (error) {
      // Some older mobile drivers reject very long shaders; drop the room
      // interiors and per-lamp lighting instead of failing to start.
      console.warn('Using the reduced scene shader',error);
      this.scene = program(gl,sceneVert,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define USE_SHADOW0 1\n#define SAFE 1'));
      this.sceneOutdoorOpaque = program(gl,sceneVert,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define OPAQUE_PURE 1\n#define OUTDOOR_ONLY 1\n#define FULL_OUTDOOR 1\n#define USE_SHADOW0 1\n#define SAFE 1'));
      this.reducedShader=true;
    }
    this.archOutdoor = program(gl,withDefines(ARCH_VERTEX,'#define USE_SHADOW0 1'),withDefines(ARCH_OUTDOOR_FRAGMENT,'#define USE_SHADOW0 1'));
    this.depth = program(gl,DEPTH_VERTEX,SHADOW_FRAGMENT);
    this.shadow = program(gl,SHADOW_VERTEX,SHADOW_FRAGMENT);
    this.shadowBaked = program(gl,SHADOW_BAKED_VERTEX,SHADOW_FRAGMENT);
    this.sky = program(gl,FULLSCREEN_VERTEX,SKY_FRAGMENT);
    this.u = uniforms(gl,this.scene,SCENE_UNIFORMS);
    this.uoo = uniforms(gl,this.sceneOutdoorOpaque,SCENE_UNIFORMS);
    this.ua = uniforms(gl,this.archOutdoor,ARCH_UNIFORMS);
    this.du = uniforms(gl,this.depth,DEPTH_UNIFORMS);
    this.s = uniforms(gl,this.sky,SKY_UNIFORMS);
    this.shadowUniform = gl.getUniformLocation(this.shadow,'uLight');
    this.shadowBakedUniform = gl.getUniformLocation(this.shadowBaked,'uLight');
    for (const sh of [this.scene,this.sceneOutdoorOpaque]) {
      surfaceTable(gl,sh);
      samplers(gl,sh,SCENE_SAMPLERS);
    }
    surfaceTable(gl,this.archOutdoor);
    samplers(gl,this.archOutdoor,ARCH_SAMPLERS);
    samplers(gl,this.sky,{uDetail:UNIT.detail});
    // Deferred, mirror, interior, stair-transition, and lite shaders compile lazily on first use.
    this.deferredChecked = false;
    this.deferredSurfChecked = false;
    this.gbufFlat = this.gbufFullFlat = this.gbufArch = this.gbufFull = null;
    this.gbufBakedFlat = this.gbufBakedFull = this.gbufBakedArch = null;
    this.ugbfl = this.ugbfull = this.ugba = null;
    this.deferredOutdoor = this.deferredOutdoorProc = null;
    this.sceneOutdoorCutout = this.sceneOutdoorCutoutProc = this.sceneOutdoorAlpha = null;
    this.ugfl = this.ugffl = this.uga = this.ugf = this.udo = this.udop = null;
    this.uoc = this.uocp = this.uoa = null;
    this.gbufMirrorFlat = this.gbufMirrorFlatClip = this.gbufMirrorOpaque = this.gbufMirrorClip = null;
    this.gbufBakedMirrorFlat = this.gbufBakedMirrorFlatClip = this.gbufBakedMirrorArch = this.gbufBakedMirrorArchClip = null;
    this.ugbmfl = this.ugbmflc = this.ugbma = this.ugbmac = null;
    this.deferredMirror = this.deferredMirrorProc = null;
    this.ugmfl = this.ugmflc = this.ugmo = this.ugmc = this.udm = this.udmp = null;
    this.mirrorDeferredChecked = false;
    this.mirrorSurfChecked = false;
    this.sceneOpaque = this.uo = null;
    this.archInterior = this.uai = null;
    this.sceneMirror = this.sceneMirrorOpaque = this.skyMirror = null;
    this.um = this.umo = this.sm = null;
    this.sceneLite = this.sceneLiteOpaque = this.sceneLiteArch = this.skyLite = null;
    this.ul = this.ulo = this.ula = this.sl = null;
    this.liteChecked = false;
    this.empty = gl.createVertexArray();
    // Real surface textures arrive later (loadSurfaces); until then a blank
    // one-pixel array keeps the sampler valid and the shaders procedural.
    this.surfacePlaceholder=surfaceArray(gl,1,UNIT.surface,null);
    this.surfaceSmallPlaceholder=surfaceArray(gl,1,UNIT.small,null);
    this.surfaceArrays=null;
    this.surfaceSheets=0;
    // Per slot: average colour and texture layer (-1 until its sheet loads).
    this.surfaceMeans=new Float32Array(SURFACE_COUNT*4).fill(.5);
    for (let slot=3;slot<this.surfaceMeans.length;slot+=4) this.surfaceMeans[slot]=-1;
    this.surfaceBuffer=gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER,this.surfaceBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER,this.surfaceMeans,gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER,SURFACE_TABLE,this.surfaceBuffer);
    this.surfaceMeansDirty=false;
    this.inkTexture = gl.createTexture();
    this.inkSource=paint;
    gl.activeTexture(gl.TEXTURE0+UNIT.ink);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,paint.w,paint.h,paint.layers,0,gl.RGBA,gl.UNSIGNED_BYTE,paint.pixels);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0+UNIT.atlas);
    this.atlas = labelTexture(gl,this.anisotropy);
    this.dummyDepth=this.depthTexture(1,1);
    this.detail=this.makeDetail();
    this.envClock=0;
    this.env=this.renderEnv(0);
    this.placeholder=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,this.placeholder);
    gl.bufferData(gl.ARRAY_BUFFER,STRIDE*4,gl.STATIC_DRAW);
    const high=renderMeshes(), low=lodMeshes(), sh=shadowMeshes(low);
    this._boxNoBot=boxNoBotMesh(high.box);
    this._boxTopOnly=boxTopOnlyMesh(high.box);
    this._gatherIBO=gl.createBuffer();
    this._gatherCap=262144;
    this._gatherIdx=new Uint32Array(this._gatherCap);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this._gatherIBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,this._gatherCap*4,gl.STREAM_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,null);
    this._runStarts=new Int32Array(4096);
    this._runEnds=new Int32Array(4096);
    this._dynFlat=new DynStream(gl,'flat',32768,65536);
    this._dynCurved=new DynStream(gl,'curved',65536,131072);
    this._dynShadow=new DynStream(gl,'shadow',32768,65536);
    this.meshData={};
    this.vaos={};
    this.batches={};
    this.batchEntries=[];
    this.shadowBatches=[];
    this.shadowFlatBatches=[];
    this.shadowCurvedBatches=[];
    this.archBatches=[];
    this.archFlatBatches=[];
    this.archCurvedBatches=[];
    this.closedBatches=[];
    this.closedFlatBatches=[];
    this.closedCurvedBatches=[];
    this.alphaBatches=[];
    this.nonAlphaBatches=[];
    const dynKeys=['dynamic','dynamicLo','archDynamic','archDynamicLo','archVfx','archVfxLo','dynamicShadow','dynamicShadowFar','adjacent'];
    for (const name of Object.keys(high)) {
      const hiData=extractMeshData(high[name]);
      const loData=low[name]===high[name]?hiData:extractMeshData(low[name]);
      const shData=sh[name]===low[name]?loData:extractMeshData(sh[name]);
      this.meshData[name]={hi:hiData,lo:loData,sh:shData};
      const hiVao=this.makeVAO(high[name]), loVao=this.makeVAO(low[name]);
      const shVao=sh[name]===low[name]?loVao:this.makeVAO(sh[name]);
      const vaos={hi:hiVao,lo:loVao,sh:shVao,hasLod:hiVao.triangles!==loVao.triangles || name==='bevel'};
      this.vaos[name]=vaos;
      const pair=Object.fromEntries([...ZONE_BATCHES,...dynKeys].map(key=>[key,
        {data:new Float32Array(dynKeys.includes(key)?STRIDE*(key.startsWith('dynamicShadow') || key.startsWith('archVfx')?64:128):0),length:0,count:0,buffer:gl.createBuffer(),capacity:0,chunks:[],buckets:null,
          bakedFlat:null,bakedFull:null,bakedCurvedHi:null,bakedCurvedLo:null,bakedMirror:null}]));
      pair.closed=CULL_MESHES.has(name);
      pair.symmetric=SYMMETRIC_CULL.has(name);
      pair.shapeId=SHAPE_IDS[name]??0;
      pair.isBevel=name==='bevel';
      pair.isFlatLo=name==='bevel' || name==='soft';
      pair.hasLod=vaos.hasLod;
      pair.isAlpha=TRANSPARENT_MESHES.has(name);
      pair.isDecal=DECAL_MESHES.has(name);
      pair.flat=name==='box' || name==='ramp' || name==='tri';
      pair.shFlat=name!=='orb' && name!=='mantle';
      this.batches[name]=pair;
      const entry={type:name,pair,vaos,closed:pair.closed,shapeId:pair.shapeId,isBevel:pair.isBevel,
        isFlatLo:pair.isFlatLo,isAlpha:pair.isAlpha,isDecal:pair.isDecal,flat:pair.flat,shFlat:pair.shFlat};
      this.batchEntries.push(entry);
      if (!pair.isAlpha && !pair.isDecal) {
        this.shadowBatches.push(entry);
        if (pair.flat) this.shadowFlatBatches.push(entry);
        else this.shadowCurvedBatches.push(entry);
      }
      if (pair.closed) {
        this.closedBatches.push(entry);
        this.archBatches.push(entry);
        if (pair.flat) {this.closedFlatBatches.push(entry); this.archFlatBatches.push(entry);}
        else {this.closedCurvedBatches.push(entry); this.archCurvedBatches.push(entry);}
      }
      if (pair.isAlpha) this.alphaBatches.push(entry);
      else this.nonAlphaBatches.push(entry);
    }
    this._planes=makePlanes();
    this._shadowPlanes=makePlanes();
    this._mirrorPlanes=makePlanes();
    this._viewPlanes=makePlanes();
    this._hasViewPlanes=false;
    this._boundVao=null;
    this.frame = 0;
    this.inkTime = -1;
    gl.clearDepth(1);
    gl.depthFunc(gl.LEQUAL);
  }

  ensureDeferredShaders() {
    if (this.deferredChecked) return !!(this.gbufBakedFlat && this.gbufBakedFull && this.gbufBakedArch && this.gbufFlat && this.gbufFullFlat && this.gbufArch && this.gbufFull && this.deferredOutdoorProc && this.sceneOutdoorCutoutProc && this.sceneOutdoorAlpha);
    this.deferredChecked=true;
    const gl=this.gl;
    try {
      this.gbufBakedFlat=this.gbufBakedMirrorFlat ?? program(gl,GBUF_BAKED_FLAT_VERTEX,GBUF_BAKED_FLAT_FRAGMENT);
      this.gbufBakedFull=program(gl,GBUF_BAKED_FULL_VERTEX,GBUF_BAKED_FULL_FRAGMENT);
      this.gbufBakedArch=this.gbufBakedMirrorArch ?? program(gl,GBUF_BAKED_ARCH_VERTEX,GBUF_BAKED_ARCH_FRAGMENT);
      this.gbufFlat=program(gl,GBUF_FLAT_VERTEX,GBUF_FLAT_FRAGMENT);
      this.gbufFullFlat=program(gl,GBUF_FULL_FLAT_VERTEX,GBUF_FULL_FLAT_FRAGMENT);
      this.gbufArch=program(gl,GBUF_ARCH_VERTEX,GBUF_ARCH_FRAGMENT);
      this.gbufFull=program(gl,GBUF_FULL_VERTEX,GBUF_FULL_FRAGMENT);
      const procDefs='#define NO_SURFACES 1';
      const outProcDefs=this.reducedShader?'#define NO_SURFACES 1\n#define SAFE 1':procDefs;
      this.deferredOutdoorProc=program(gl,DEFERRED_RAY_VERTEX,withDefines(DEFERRED_OUTDOOR_FRAGMENT,outProcDefs));
      const cutVert=withDefines(ARCH_VERTEX,'#define USE_SHADOW0 1');
      this.sceneOutdoorCutoutProc=program(gl,cutVert,withDefines(SCENE_CUTOUT_FRAGMENT,procDefs));
      this.sceneOutdoorAlpha=program(gl,SCENE_ALPHA_VERTEX,SCENE_ALPHA_FRAGMENT);
      this.ugbfl=uniforms(gl,this.gbufBakedFlat,GBUF_BAKED_UNIFORMS);
      this.ugbfull=uniforms(gl,this.gbufBakedFull,GBUF_BAKED_UNIFORMS);
      this.ugba=uniforms(gl,this.gbufBakedArch,GBUF_BAKED_UNIFORMS);
      this.ugfl=uniforms(gl,this.gbufFlat,GBUF_ARCH_UNIFORMS);
      this.ugffl=uniforms(gl,this.gbufFullFlat,GBUF_FULL_UNIFORMS);
      this.uga=uniforms(gl,this.gbufArch,GBUF_ARCH_UNIFORMS);
      this.ugf=uniforms(gl,this.gbufFull,GBUF_FULL_UNIFORMS);
      this.udop=uniforms(gl,this.deferredOutdoorProc,DEFERRED_OUTDOOR_UNIFORMS);
      this.uocp=uniforms(gl,this.sceneOutdoorCutoutProc,SCENE_CUTOUT_UNIFORMS);
      this.uoa=uniforms(gl,this.sceneOutdoorAlpha,SCENE_ALPHA_UNIFORMS);
      samplers(gl,this.deferredOutdoorProc,DEFERRED_OUTDOOR_SAMPLERS);
      samplers(gl,this.sceneOutdoorCutoutProc,SCENE_CUTOUT_SAMPLERS);
      samplers(gl,this.sceneOutdoorAlpha,SCENE_ALPHA_SAMPLERS);
    } catch (error) {
      console.warn('Deferred outdoor PBR unavailable, falling back to forward',error);
      this.gbufBakedFlat=this.gbufBakedFull=this.gbufBakedArch=this.gbufFlat=this.gbufFullFlat=this.gbufArch=this.gbufFull=this.deferredOutdoorProc=this.sceneOutdoorCutoutProc=this.sceneOutdoorAlpha=null;
    }
    return !!(this.gbufBakedFlat && this.gbufBakedFull && this.gbufBakedArch && this.gbufFlat && this.gbufFullFlat && this.gbufArch && this.gbufFull && this.deferredOutdoorProc && this.sceneOutdoorCutoutProc && this.sceneOutdoorAlpha);
  }

  ensureDeferredSurfaceShaders() {
    if (this.deferredSurfChecked) return !!(this.deferredOutdoor && this.sceneOutdoorCutout);
    this.deferredSurfChecked=true;
    const gl=this.gl;
    try {
      const defs=this.reducedShader?'#define SAFE 1':'';
      this.deferredOutdoor=program(gl,DEFERRED_RAY_VERTEX,defs?withDefines(DEFERRED_OUTDOOR_FRAGMENT,defs):DEFERRED_OUTDOOR_FRAGMENT);
      const cutVert=withDefines(ARCH_VERTEX,'#define USE_SHADOW0 1');
      this.sceneOutdoorCutout=program(gl,cutVert,SCENE_CUTOUT_FRAGMENT);
      this.udo=uniforms(gl,this.deferredOutdoor,DEFERRED_OUTDOOR_UNIFORMS);
      this.uoc=uniforms(gl,this.sceneOutdoorCutout,SCENE_CUTOUT_UNIFORMS);
      surfaceTable(gl,this.deferredOutdoor);
      samplers(gl,this.deferredOutdoor,DEFERRED_OUTDOOR_SAMPLERS);
      surfaceTable(gl,this.sceneOutdoorCutout);
      samplers(gl,this.sceneOutdoorCutout,SCENE_CUTOUT_SAMPLERS);
    } catch (error) {
      console.warn('Deferred surface shaders unavailable, staying procedural',error);
      this.deferredOutdoor=this.sceneOutdoorCutout=null;
    }
    return !!(this.deferredOutdoor && this.sceneOutdoorCutout);
  }

  ensureDeferredMirrorShaders() {
    if (this.mirrorDeferredChecked) return !!this.deferredMirrorProc;
    this.mirrorDeferredChecked=true;
    const gl=this.gl;
    try {
      this.gbufBakedMirrorFlat=this.gbufBakedFlat ?? program(gl,GBUF_BAKED_FLAT_VERTEX,GBUF_BAKED_FLAT_FRAGMENT);
      this.gbufBakedMirrorFlatClip=program(gl,withDefines(GBUF_BAKED_FLAT_VERTEX,'#define MIRROR_CLIP 1'),withDefines(GBUF_BAKED_FLAT_FRAGMENT,'#define MIRROR_CLIP 1'));
      this.gbufBakedMirrorArch=this.gbufBakedArch ?? program(gl,GBUF_BAKED_ARCH_VERTEX,GBUF_BAKED_ARCH_FRAGMENT);
      this.gbufBakedMirrorArchClip=program(gl,withDefines(GBUF_BAKED_ARCH_VERTEX,'#define MIRROR_CLIP 1'),withDefines(GBUF_BAKED_ARCH_FRAGMENT,'#define MIRROR_CLIP 1'));
      this.deferredMirrorProc=program(gl,DEFERRED_RAY_VERTEX,withDefines(DEFERRED_MIRROR_FRAGMENT,'#define NO_SURFACES 1'));
      this.ugbmfl=uniforms(gl,this.gbufBakedMirrorFlat,GBUF_BAKED_UNIFORMS);
      this.ugbmflc=uniforms(gl,this.gbufBakedMirrorFlatClip,GBUF_BAKED_UNIFORMS);
      this.ugbma=uniforms(gl,this.gbufBakedMirrorArch,GBUF_BAKED_UNIFORMS);
      this.ugbmac=uniforms(gl,this.gbufBakedMirrorArchClip,GBUF_BAKED_UNIFORMS);
      this.udmp=uniforms(gl,this.deferredMirrorProc,DEFERRED_MIRROR_UNIFORMS);
      samplers(gl,this.deferredMirrorProc,DEFERRED_MIRROR_SAMPLERS);
    } catch (error) {
      console.warn('Deferred mirror unavailable, falling back to forward',error);
      this.gbufBakedMirrorFlat=this.gbufBakedMirrorFlatClip=this.gbufBakedMirrorArch=this.gbufBakedMirrorArchClip=this.deferredMirrorProc=null;
    }
    return !!this.deferredMirrorProc;
  }

  ensureDeferredMirrorSurfaceShader() {
    if (this.mirrorSurfChecked) return !!this.deferredMirror;
    this.mirrorSurfChecked=true;
    const gl=this.gl;
    try {
      this.deferredMirror=program(gl,DEFERRED_RAY_VERTEX,DEFERRED_MIRROR_FRAGMENT);
      this.udm=uniforms(gl,this.deferredMirror,DEFERRED_MIRROR_UNIFORMS);
      surfaceTable(gl,this.deferredMirror);
      samplers(gl,this.deferredMirror,DEFERRED_MIRROR_SAMPLERS);
    } catch (error) {
      console.warn('Deferred mirror surface shader unavailable',error);
      this.deferredMirror=null;
    }
    return !!this.deferredMirror;
  }

  ensureMirrorShaders() {
    if (this.sceneMirror) return;
    const gl=this.gl;
    this.sceneMirror = program(gl,SCENE_VERTEX,withDefines(MIRROR_FRAGMENT,'#define FAST_SLOT 1'));
    this.sceneMirrorOpaque = program(gl,SCENE_VERTEX,withDefines(MIRROR_FRAGMENT,'#define FAST_SLOT 1\n#define MIRROR_OPAQUE 1'));
    this.skyMirror = program(gl,FULLSCREEN_VERTEX,MIRROR_SKY_FRAGMENT);
    this.um = uniforms(gl,this.sceneMirror,MIRROR_UNIFORMS);
    this.umo = uniforms(gl,this.sceneMirrorOpaque,MIRROR_UNIFORMS);
    this.sm = uniforms(gl,this.skyMirror,MIRROR_SKY_UNIFORMS);
    for (const sh of [this.sceneMirror,this.sceneMirrorOpaque]) {
      surfaceTable(gl,sh);
      samplers(gl,sh,{uEnv:UNIT.env,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small});
    }
    samplers(gl,this.skyMirror,{uEnv:UNIT.env});
  }

  ensureLiteShaders() {
    if (this.liteChecked) return !!this.sceneLite;
    this.liteChecked=true;
    const gl=this.gl;
    try {
      this.sceneLite=program(gl,LITE_VERTEX,withDefines(LITE_FRAGMENT,'#define FAST_SLOT 1'));
      this.sceneLiteOpaque=program(gl,LITE_VERTEX,withDefines(LITE_FRAGMENT,'#define FAST_SLOT 1\n#define OPAQUE_PURE 1'));
      this.sceneLiteArch=program(gl,ARCH_VERTEX,ARCH_LITE_FRAGMENT);
      this.skyLite=program(gl,FULLSCREEN_VERTEX,LITE_SKY_FRAGMENT);
      this.ul=uniforms(gl,this.sceneLite,LITE_UNIFORMS);
      this.ulo=uniforms(gl,this.sceneLiteOpaque,LITE_UNIFORMS);
      this.ula=uniforms(gl,this.sceneLiteArch,LITE_UNIFORMS);
      this.sl=uniforms(gl,this.skyLite,LITE_SKY_UNIFORMS);
      for (const sh of [this.sceneLite,this.sceneLiteOpaque]) {
        samplers(gl,sh,{uInk:UNIT.ink,uAtlas:UNIT.atlas,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small});
        surfaceTable(gl,sh);
      }
      samplers(gl,this.sceneLiteArch,{uInk:UNIT.ink,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small});
      surfaceTable(gl,this.sceneLiteArch);
    } catch (error) {
      // The full shader still renders the lightweight modes, only slower.
      console.warn('Lightweight shader unavailable',error);
      this.sceneLite=this.sceneLiteOpaque=this.sceneLiteArch=this.skyLite=null;
    }
    return !!this.sceneLite;
  }

  ensureInteriorShader() {
    if (this.archInterior) return;
    const gl=this.gl;
    // Only compile the ultra-lean 4-varying interior arch shader (~99% of interior
    // geometry); remaining ramps/dynamics reuse the pre-compiled main scene shader,
    // eliminating the multi-second first-entry interior shader compilation hitch.
    this.archInterior=program(gl,ARCH_VERTEX,this.reducedShader?withDefines(ARCH_INTERIOR_FRAGMENT,'#define SAFE 1'):ARCH_INTERIOR_FRAGMENT);
    this.uai=uniforms(gl,this.archInterior,ARCH_INTERIOR_UNIFORMS);
    surfaceTable(gl,this.archInterior);
    samplers(gl,this.archInterior,ARCH_INTERIOR_SAMPLERS);
  }

  ensureCombinedOpaqueShader() {
    if (this.sceneOpaque) return;
    const gl=this.gl;
    const defs='#define FAST_SLOT 1\n#define OPAQUE_PURE 1\n#define USE_SHADOW0 1'+(this.reducedShader?'\n#define SAFE 1':'');
    this.sceneOpaque=program(gl,withDefines(SCENE_VERTEX,'#define USE_SHADOW0 1'),withDefines(SCENE_FRAGMENT,defs));
    this.uo=uniforms(gl,this.sceneOpaque,SCENE_UNIFORMS);
    surfaceTable(gl,this.sceneOpaque);
    samplers(gl,this.sceneOpaque,SCENE_SAMPLERS);
  }

  makeVAO(mesh) {
    const gl=this.gl, vao=gl.createVertexArray(), vbo=gl.createBuffer(), ibo=gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(mesh.vertices),gl.STATIC_DRAW);
    for (const [loc,size,offset] of [[0,3,0],[1,3,12],[2,2,24]]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc,size,gl.FLOAT,false,32,offset);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(mesh.indices),gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.placeholder);
    for (let i=0;i<6;i++) {
      gl.enableVertexAttribArray(4+i);
      gl.vertexAttribPointer(4+i,4,gl.FLOAT,false,STRIDE*4,i*16);
      gl.vertexAttribDivisor(4+i,1);
    }
    gl.bindVertexArray(null);
    return {vao,triangles:mesh.indices.length,buffer:null,start:-1};
  }

  depthTexture(width,height) {
    const gl=this.gl, texture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+UNIT.shadow0);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texStorage2D(gl.TEXTURE_2D,1,gl.DEPTH_COMPONENT24,width,height);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_COMPARE_MODE,gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_COMPARE_FUNC,gl.LEQUAL);
    return texture;
  }

  // Bakes the tileable detail map that procedural materials sample.
  makeDetail() {
    const gl=this.gl, size=256, texture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+UNIT.detail);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texStorage2D(gl.TEXTURE_2D,9,gl.RGBA8,size,size);
    const buffer=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    const maker=program(gl,FULLSCREEN_VERTEX,DETAIL_FRAGMENT);
    gl.useProgram(maker);
    gl.uniform1f(gl.getUniformLocation(maker,'uSize'),size);
    gl.viewport(0,0,size,size);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.deleteFramebuffer(buffer);
    gl.deleteProgram(maker);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
    return texture;
  }

  // Sky probe for reflections, ambient light and fog colour.
  renderEnv(clock) {
    const gl=this.gl, [width,height]=ENV_SIZE;
    if (!this.envProgram) {
      this.envProgram=program(gl,FULLSCREEN_VERTEX,ENV_FRAGMENT);
      samplers(gl,this.envProgram,{uDetail:UNIT.detail});
      this.envTexture=gl.createTexture();
      gl.activeTexture(gl.TEXTURE0+UNIT.env);
      gl.bindTexture(gl.TEXTURE_2D,this.envTexture);
      gl.texStorage2D(gl.TEXTURE_2D,9,gl.RGBA8,width,height);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      this.envBuffer=gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.envBuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.envTexture,0);
      this._envMipFbo=gl.createFramebuffer();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.envBuffer);
    gl.useProgram(this.envProgram);
    gl.activeTexture(gl.TEXTURE0+UNIT.detail);
    gl.bindTexture(gl.TEXTURE_2D,this.detail);
    gl.uniform2f(gl.getUniformLocation(this.envProgram,'uSize'),width,height);
    gl.uniform3fv(gl.getUniformLocation(this.envProgram,'uSun'),SUN);
    gl.uniform1f(gl.getUniformLocation(this.envProgram,'uClock'),clock);
    gl.uniform1f(gl.getUniformLocation(this.envProgram,'uBossRage'),this.bossRage ?? 0);
    gl.uniform1f(gl.getUniformLocation(this.envProgram,'uRainLevel'),this.rainLevel ?? 0);
    gl.viewport(0,0,width,height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.activeTexture(gl.TEXTURE0+UNIT.env);
    gl.bindTexture(gl.TEXTURE_2D,this.envTexture);
    gl.generateMipmap(gl.TEXTURE_2D);
    // Fit 5-term analytical SH diffuse + 4-term analytical fog from exact equirectangular mip 4 (16x8 = 512 bytes).
    this._envMip16.fill(0);
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER,this._envMipFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.envTexture,4);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE) {
        gl.readPixels(0,0,16,8,gl.RGBA,gl.UNSIGNED_BYTE,this._envMip16);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    } catch {
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    }
    fitEnvSH(this._envMip16,this.bossRage ?? 0,this.rainLevel ?? 0,this._sh,this._fog);
    this.envClock=clock;
    this.envBossRage=this.bossRage ?? 0;
    this.envRainLevel=this.rainLevel ?? 0;
    return this.envTexture;
  }

  bindEnvSH(u) {
    const gl=this.gl, sh=this._sh, fg=this._fog;
    if (u.uSH0) gl.uniform3fv(u.uSH0,sh[0]);
    if (u.uSH1) gl.uniform3fv(u.uSH1,sh[1]);
    if (u.uSH2) gl.uniform3fv(u.uSH2,sh[2]);
    if (u.uSH3) gl.uniform3fv(u.uSH3,sh[3]);
    if (u.uSH4) gl.uniform3fv(u.uSH4,sh[4]);
    if (u.uFog0) gl.uniform3fv(u.uFog0,fg[0]);
    if (u.uFog1) gl.uniform3fv(u.uFog1,fg[1]);
    if (u.uFog2) gl.uniform3fv(u.uFog2,fg[2]);
    if (u.uFog3) gl.uniform3fv(u.uFog3,fg[3]);
  }

  // Loads the generated texture sheets in the background; surfaces switch
  // from their procedural look as each sheet arrives.
  // size: texels per layer for large surfaces; small: for small parts.
  loadSurfaces({size,small}={}) {
    return loadSurfaceSheets(this,{size,small,units:{surface:UNIT.surface,small:UNIT.small,sheet:UNIT.sheet}});
  }

  bindSurfaces(u,sheets) {
    const gl=this.gl, arrays=this.surfaceArrays;
    gl.activeTexture(gl.TEXTURE0+UNIT.surface);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,arrays?.large.texture ?? this.surfacePlaceholder);
    gl.activeTexture(gl.TEXTURE0+UNIT.small);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,arrays?.small.texture ?? this.surfaceSmallPlaceholder);
    // The lightweight modes read textures with bilinear + nearest mip (2x fewer texels).
    if (this.lite && !this.liteSampler) {
      this.liteSampler=gl.createSampler();
      gl.samplerParameteri(this.liteSampler,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_NEAREST);
      gl.samplerParameteri(this.liteSampler,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.samplerParameteri(this.liteSampler,gl.TEXTURE_WRAP_S,gl.REPEAT);
      gl.samplerParameteri(this.liteSampler,gl.TEXTURE_WRAP_T,gl.REPEAT);
    }
    for (const unit of [UNIT.surface,UNIT.small]) gl.bindSampler(unit,this.lite?this.liteSampler:null);
    gl.uniform1i(u.uSurfaceSheets,arrays?sheets:0);
    gl.uniform2f(u.uSurfaceEdge,.5/(arrays?.large.size ?? 1),.5/(arrays?.small.size ?? 1));
    if (this.surfaceMeansDirty) {
      gl.bindBuffer(gl.UNIFORM_BUFFER,this.surfaceBuffer);
      gl.bufferSubData(gl.UNIFORM_BUFFER,0,this.surfaceMeans);
      this.surfaceMeansDirty=false;
    }
  }

  // Updates atmospheric crimson boss storm, blinding downpour, and street wetness levels smoothly.
  setMood({bossActive = false, raining = false, dt = 1/60} = {}) {
    const step=clamp(dt*1.35,0,1);
    const targetRage=bossActive?1:0;
    const targetWet=raining?1:bossActive?.68:0;
    const targetRain=raining?1:0;
    this.bossRage=mix(this.bossRage??0,targetRage,step);
    this.wetLevel=mix(this.wetLevel??0,targetWet,step);
    this.rainLevel=mix(this.rainLevel??0,targetRain,step);
    const r=this.bossRage, dim=1-(this.rainLevel??0)*.72;
    this._sunColor[0]=mix(SUN_RADIANCE[0],1.48,r)*dim;
    this._sunColor[1]=mix(SUN_RADIANCE[1],.34,r)*dim;
    this._sunColor[2]=mix(SUN_RADIANCE[2],.36,r)*dim;
  }

  // 'ultra' (real-time WebGL2 raytracing), 'high', 'lite' (400p) or 'ultralite' (300p).
  setQuality(level) {
    const quality=level===true?'lite':level===false?'high':['ultra','lite','ultralite'].includes(level)?level:'high';
    if (this.quality!==quality) {
      this.frame=0;
      this.scale=1;
      this.frameAverage=0;
      this.releaseShadows();
    }
    this.quality=quality;
    this.lite=quality==='lite' || quality==='ultralite';
    this.ultralite=quality==='ultralite';
    this.ultra=quality==='ultra';
    this.raytrace=quality==='ultra';
    this.fidelity=!this.lite;
  }

  releaseShadows() {
    const gl=this.gl;
    for (const cascade of this.cascades??[]) {
      gl.deleteFramebuffer(cascade.buffer);
      gl.deleteTexture(cascade.texture);
    }
    this.cascades=[];
    this.shadowBuffer=this.shadowTexture=null;
    if (this._staticShadowCache) {
      gl.deleteFramebuffer(this._staticShadowCache.buffer);
      gl.deleteTexture(this._staticShadowCache.texture);
      this._staticShadowCache=null;
    }
    this._staticShadowDirty=true;
  }

  prepareEffects() {
    if (this.effectsUnavailable) return false;
    const plan=[{size:1536,radius:21,every:1},{size:1024,radius:105,every:8}];
    if (this.shadowBuffer && this.cascades?.length===plan.length) return true;
    this.releaseShadows();
    const gl=this.gl;
    for (const [i,{size,radius,every}] of plan.entries()) {
      const edge=Math.min(size,this.textureLimit||size);
      const texture=this.depthTexture(edge,edge), buffer=gl.createFramebuffer();
      if (!texture || !buffer) return this.disableEffects();
      gl.bindFramebuffer(gl.FRAMEBUFFER,buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,texture,0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      this.cascades.push({texture,buffer,size:edge,radius,every,matrix:null,texel:2*radius/edge,eyeX:1e9,eyeZ:1e9});
      if (i===0) {
        this.shadowBuffer=buffer;
        this.shadowTexture=texture;
      }
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) return this.disableEffects();
    }
    // Guard-Band Static Cascade-0 Shadow Cache (2048x2048, +256 texel = +/-7m margin at exact C0 texel pitch).
    const c0=this.cascades[0];
    const cacheSize=2048;
    if (c0 && c0.size===1536 && (!this.textureLimit || this.textureLimit>=cacheSize)) {
      const texture=this.depthTexture(cacheSize,cacheSize), buffer=gl.createFramebuffer();
      if (texture && buffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,buffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,texture,0);
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE) {
          this._staticShadowCache={texture,buffer,size:cacheSize,radius:cacheSize*c0.texel*.5,
            texel:c0.texel,margin:(cacheSize-c0.size)>>1,tx:0,ty:0,tz:0,valid:false};
        } else {
          gl.deleteFramebuffer(buffer);
          gl.deleteTexture(texture);
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return true;
  }

  disableEffects() {
    const gl=this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    this.releaseShadows();
    gl.deleteFramebuffer(this.mirrorBuffer??null);
    gl.deleteFramebuffer(this.mirrorGBuffer??null);
    gl.deleteTexture(this.mirrorTexture??null);
    gl.deleteTexture(this.mirrorG0??null);
    gl.deleteTexture(this.mirrorG1??null);
    gl.deleteTexture(this.mirrorDepthTex??null);
    gl.deleteRenderbuffer(this.mirrorDepth??null);
    this.mirrorBuffer=this.mirrorGBuffer=this.mirrorTexture=this.mirrorG0=this.mirrorG1=this.mirrorDepthTex=this.mirrorDepth=null;
    this.effectsUnavailable=true;
    return false;
  }

  // Planar reflection for wet asphalt, puddles and liquid ink at street level.
  // Allocates a 2-MRT Deferred Mirror G-Buffer (G0/G1 + Depth24) + color-only target.
  prepareMirror(width,height) {
    if (this.mirrorUnavailable) return false;
    const gl=this.gl;
    if (!this.mirrorBuffer) {
      this.mirrorBuffer=gl.createFramebuffer();
      this.mirrorGBuffer=gl.createFramebuffer();
      this.mirrorTexture=gl.createTexture();
      this.mirrorG0=gl.createTexture();
      this.mirrorG1=gl.createTexture();
      this.mirrorDepthTex=gl.createTexture();
      this.mirrorDepth=gl.createRenderbuffer();
      this.mirrorSize=[0,0];
      this.mirrorDeferred=false;
      this.mirrorMatrix=new Float32Array([1,0,0,0, 0,-1,0,0, 0,0,1,0, 0,.012,0,1]);
    }
    if (this.mirrorSize[0]===width && this.mirrorSize[1]===height) return true;
    const initTex=(tex,unit,fmt,srcFmt,type,filter)=>{
      gl.activeTexture(gl.TEXTURE0+unit);
      gl.bindTexture(gl.TEXTURE_2D,tex);
      gl.texImage2D(gl.TEXTURE_2D,0,fmt,width,height,0,srcFmt,type,null);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    };
    initTex(this.mirrorTexture,UNIT.reflection,this.floatTargets?gl.RGBA16F:gl.RGBA8,gl.RGBA,this.floatTargets?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,gl.LINEAR);
    initTex(this.mirrorG0,UNIT.postB,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,gl.NEAREST);
    initTex(this.mirrorG1,UNIT.postC,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,gl.NEAREST);
    initTex(this.mirrorDepthTex,UNIT.postA,gl.DEPTH_COMPONENT24,gl.DEPTH_COMPONENT,gl.UNSIGNED_INT,gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorGBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.mirrorG0,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT1,gl.TEXTURE_2D,this.mirrorG1,0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,this.mirrorDepthTex,0);
    const gOk=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.mirrorTexture,0);
    if (gOk) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,null);
      this.mirrorDeferred=true;
    } else {
      gl.bindRenderbuffer(gl.RENDERBUFFER,this.mirrorDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,width,height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this.mirrorDepth);
      this.mirrorDeferred=false;
    }
    const ok=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    if (!ok) {
      this.mirrorUnavailable=true;
      return false;
    }
    this.mirrorSize=[width,height];
    return true;
  }

  // ---------- HDR target, ambient occlusion, bloom ----------
  createPost() {
    const gl=this.gl;
    try {
      const make=fragment=>program(gl,FULLSCREEN_VERTEX,fragment);
      const post={ssao:make(SSAO_FRAGMENT),blur:make(BLUR_FRAGMENT),down:make(DOWN_FRAGMENT),up:make(UP_FRAGMENT),
        composite:program(gl,DEFERRED_RAY_VERTEX,COMPOSITE_FRAGMENT),
        compositeFast:make(withDefines(COMPOSITE_FRAGMENT,'#define NO_RAYTRACE 1')),
        w:0,h:0,targets:[]};
      samplers(gl,post.ssao,{uDepth:UNIT.postA});
      samplers(gl,post.blur,{uAO:UNIT.postA,uDepth:UNIT.postB});
      samplers(gl,post.down,{uSrc:UNIT.postA});
      samplers(gl,post.up,{uSrc:UNIT.postA});
      samplers(gl,post.composite,{uColor:UNIT.postA,uAO:UNIT.postB,uBloom:UNIT.postC,uDepth:UNIT.detail});
      samplers(gl,post.compositeFast,{uColor:UNIT.postA,uAO:UNIT.postB,uBloom:UNIT.postC});
      for (const key of ['ssao','blur','down','up','composite','compositeFast']) post[key+'U']=uniforms(gl,post[key],
        ['uInvSize','uProj','uRadius','uIntensity','uStep','uTexel','uFirst','uThreshold','uWeight','uExposure',
          'uBloomStrength','uAOStrength','uTime','uInterior','uAOOn','uBloomOn','uFXAA',
          'uRaytrace','uBossRage','uWetLevel','uRainLevel','uVP','uEye','uSun',
          'uForward','uRight','uUp','uField','uDepthAB','uRayDX','uRayDY','uSunUV','uHSun']);
      const counts=gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA16F,gl.SAMPLES);
      post.deviceSamples=counts && counts.length?Math.max(...counts):0;
      // Live play runs 1x RGBA16F + Subpixel FXAA + FidelityFX CAS (eliminating
      // 4x MSAA bandwidth and resolve); offline film can request MSAA via setSamples().
      post.samples=Math.min(this.maxSamples??0,post.deviceSamples);
      return post;
    } catch (error) {
      console.warn('HDR post-processing disabled',error);
      return null;
    }
  }

  preparePost(width,height) {
    if (!this.floatTargets || this.postUnavailable) return false;
    this.post??=this.createPost();
    if (!this.post) {
      this.postUnavailable=true;
      return false;
    }
    if (this.post.w===width && this.post.h===height) return true;
    return this.sizePost(width,height);
  }

  postTexture(width,height,format,type,filter) {
    const gl=this.gl, texture=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+UNIT.postC);
    gl.bindTexture(gl.TEXTURE_2D,texture);
    const srcFormat=format===gl.DEPTH_COMPONENT24?gl.DEPTH_COMPONENT:format===gl.R8?gl.RED:gl.RGBA;
    gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,srcFormat,type,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    this.post.targets.push({texture});
    return texture;
  }

  postBuffer(attachments) {
    const gl=this.gl, buffer=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,buffer);
    for (const [point,target,kind] of attachments) {
      if (kind==='rb') gl.framebufferRenderbuffer(gl.FRAMEBUFFER,point,gl.RENDERBUFFER,target);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER,point,gl.TEXTURE_2D,target,0);
    }
    this.post.targets.push({buffer});
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE?buffer:null;
  }

  releasePost() {
    const gl=this.gl, post=this.post;
    if (!post) return;
    for (const item of post.targets) {
      if (item.texture) gl.deleteTexture(item.texture);
      if (item.buffer) gl.deleteFramebuffer(item.buffer);
      if (item.renderbuffer) gl.deleteRenderbuffer(item.renderbuffer);
    }
    post.targets=[];
    post.w=post.h=0;
  }

  sizePost(width,height) {
    const gl=this.gl, post=this.post;
    this.releasePost();
    const fail=()=>{
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      this.releasePost();
      this.postUnavailable=true;
      return false;
    };
    post.color=this.postTexture(width,height,gl.RGBA16F,gl.HALF_FLOAT,gl.LINEAR);
    post.depth=this.postTexture(width,height,gl.DEPTH_COMPONENT24,gl.UNSIGNED_INT,gl.NEAREST);
    post.resolve=this.postBuffer([[gl.COLOR_ATTACHMENT0,post.color],[gl.DEPTH_ATTACHMENT,post.depth]]);
    post.colorOnly=this.postBuffer([[gl.COLOR_ATTACHMENT0,post.color]]);
    if (!post.resolve || !post.colorOnly) return fail();
    post.msaa=null;
    if (post.samples>1) {
      const color=gl.createRenderbuffer(), depth=gl.createRenderbuffer();
      post.targets.push({renderbuffer:color},{renderbuffer:depth});
      gl.bindRenderbuffer(gl.RENDERBUFFER,color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER,post.samples,gl.RGBA16F,width,height);
      gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER,post.samples,gl.DEPTH_COMPONENT24,width,height);
      gl.bindRenderbuffer(gl.RENDERBUFFER,null);
      post.msaa=this.postBuffer([[gl.COLOR_ATTACHMENT0,color,'rb'],[gl.DEPTH_ATTACHMENT,depth,'rb']]);
      if (!post.msaa) {
        post.samples=0;
        post.msaa=null;
      }
    }
    // 3-MRT Deferred Outdoor G-Buffer sharing post.depth directly (zero stencil blit/VRAM overhead).
    post.g0=post.g1=post.g2=post.gBuffer=null;
    if (!post.msaa) {
      post.g0=this.postTexture(width,height,gl.RGBA8,gl.UNSIGNED_BYTE,gl.NEAREST);
      post.g1=this.postTexture(width,height,gl.RGBA8,gl.UNSIGNED_BYTE,gl.NEAREST);
      post.g2=this.postTexture(width,height,gl.RGBA32F,gl.FLOAT,gl.NEAREST);
      post.gBuffer=this.postBuffer([
        [gl.COLOR_ATTACHMENT0,post.g0],
        [gl.COLOR_ATTACHMENT1,post.g1],
        [gl.COLOR_ATTACHMENT2,post.g2],
        [gl.DEPTH_ATTACHMENT,post.depth]
      ]);
      if (!post.gBuffer) {
        post.g2=this.postTexture(width,height,gl.RGBA16F,gl.HALF_FLOAT,gl.NEAREST);
        post.gBuffer=this.postBuffer([
          [gl.COLOR_ATTACHMENT0,post.g0],
          [gl.COLOR_ATTACHMENT1,post.g1],
          [gl.COLOR_ATTACHMENT2,post.g2],
          [gl.DEPTH_ATTACHMENT,post.depth]
        ]);
      }
    }
    const hw=Math.max(1,width>>1), hh=Math.max(1,height>>1);
    post.half=[hw,hh];
    post.aoA=this.postTexture(hw,hh,gl.R8,gl.UNSIGNED_BYTE,gl.LINEAR);
    post.aoB=this.postTexture(hw,hh,gl.R8,gl.UNSIGNED_BYTE,gl.LINEAR);
    post.aoBufferA=this.postBuffer([[gl.COLOR_ATTACHMENT0,post.aoA]]);
    post.aoBufferB=this.postBuffer([[gl.COLOR_ATTACHMENT0,post.aoB]]);
    if (!post.aoBufferA || !post.aoBufferB) return fail();
    post.bloom=[];
    for (let w=hw,h=hh,i=0;i<4 && Math.min(w,h)>=8;i++,w=Math.max(1,w>>1),h=Math.max(1,h>>1)) {
      const texture=this.postTexture(w,h,gl.RGBA16F,gl.HALF_FLOAT,gl.LINEAR);
      const buffer=this.postBuffer([[gl.COLOR_ATTACHMENT0,texture]]);
      if (!buffer) return fail();
      post.bloom.push({texture,buffer,w,h});
    }
    if (!post.bloom.length) return fail();
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    post.w=width;
    post.h=height;
    return true;
  }

  runPost(width,height,clock) {
    const gl=this.gl, post=this.post;
    if (post.msaa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,post.msaa);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,post.resolve);
      gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT,gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.bindVertexArray(this.empty);
    const tan=Math.tan(FOV/2), proj=[tan*width/height,tan,NEAR,FAR];
    const [hw,hh]=post.half;
    const ambient=!this.lite;
    if (ambient) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,post.aoBufferA);
      gl.viewport(0,0,hw,hh);
      gl.useProgram(post.ssao);
      gl.activeTexture(gl.TEXTURE0+UNIT.postA);
      gl.bindTexture(gl.TEXTURE_2D,post.depth);
      gl.uniform2f(post.ssaoU.uInvSize,1/hw,1/hh);
      gl.uniform4fv(post.ssaoU.uProj,proj);
      gl.uniform1f(post.ssaoU.uRadius,this.interior>.5?.75:.62);
      gl.uniform1f(post.ssaoU.uIntensity,this.interior>.5?1.25:1.05);
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.useProgram(post.blur);
      gl.uniform4fv(post.blurU.uProj,proj);
      gl.activeTexture(gl.TEXTURE0+UNIT.postB);
      gl.bindTexture(gl.TEXTURE_2D,post.depth);
      for (const [target,source,step] of [[post.aoBufferB,post.aoA,[1/hw,0]],[post.aoBufferA,post.aoB,[0,1/hh]]]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER,target);
        gl.activeTexture(gl.TEXTURE0+UNIT.postA);
        gl.bindTexture(gl.TEXTURE_2D,source);
        gl.uniform2fv(post.blurU.uStep,step);
        gl.drawArrays(gl.TRIANGLES,0,3);
      }
    }
    gl.useProgram(post.down);
    for (let i=0;i<post.bloom.length;i++) {
      const level=post.bloom[i], source=i?post.bloom[i-1]:{texture:post.color,w:width,h:height};
      gl.bindFramebuffer(gl.FRAMEBUFFER,level.buffer);
      gl.viewport(0,0,level.w,level.h);
      gl.activeTexture(gl.TEXTURE0+UNIT.postA);
      gl.bindTexture(gl.TEXTURE_2D,source.texture);
      gl.uniform2f(post.downU.uTexel,1/source.w,1/source.h);
      gl.uniform1i(post.downU.uFirst,i===0?1:0);
      gl.uniform1f(post.downU.uThreshold,this.interior>.5?1.15:1.45);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    gl.useProgram(post.up);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE,gl.ONE);
    for (let i=post.bloom.length-2;i>=0;i--) {
      const level=post.bloom[i], source=post.bloom[i+1];
      gl.bindFramebuffer(gl.FRAMEBUFFER,level.buffer);
      gl.viewport(0,0,level.w,level.h);
      gl.activeTexture(gl.TEXTURE0+UNIT.postA);
      gl.bindTexture(gl.TEXTURE_2D,source.texture);
      gl.uniform2f(post.upU.uTexel,1/source.w,1/source.h);
      gl.uniform1f(post.upU.uWeight,.85);
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.viewport(0,0,width,height);
    const useRT=!!this.raytrace;
    gl.useProgram(useRT?post.composite:post.compositeFast);
    const u=useRT?post.compositeU:post.compositeFastU;
    gl.activeTexture(gl.TEXTURE0+UNIT.postA);
    gl.bindTexture(gl.TEXTURE_2D,post.color);
    gl.activeTexture(gl.TEXTURE0+UNIT.postB);
    gl.bindTexture(gl.TEXTURE_2D,post.aoA);
    gl.activeTexture(gl.TEXTURE0+UNIT.postC);
    gl.bindTexture(gl.TEXTURE_2D,post.bloom[0].texture);
    if (useRT) {
      gl.activeTexture(gl.TEXTURE0+UNIT.detail);
      gl.bindTexture(gl.TEXTURE_2D,post.depth);
    }
    gl.uniform2f(u.uTexel,1/width,1/height);
    gl.uniform1f(u.uExposure,this.exposure());
    gl.uniform1f(u.uBloomStrength,(this.interior>.5?.085:.06)+(useRT?.022:0)+(this.bossRage??0)*.018);
    gl.uniform1f(u.uAOStrength,.92);
    gl.uniform1f(u.uTime,clock);
    gl.uniform1f(u.uInterior,this.interior);
    gl.uniform1i(u.uAOOn,ambient?1:0);
    gl.uniform1i(u.uBloomOn,1);
    gl.uniform1i(u.uFXAA,post.msaa?0:1);
    gl.uniform1f(u.uRainLevel,this.rainLevel??0);
    if (useRT) {
      const fx=tan*width/height, fy=tan;
      const dir=this._lastDir, r=this._lastRight, up=this._lastUp, eye=this._lastEye;
      gl.uniform3fv(u.uForward,dir);
      gl.uniform3fv(u.uRight,r);
      gl.uniform3fv(u.uUp,up);
      gl.uniform2f(u.uField,fx,fy);
      gl.uniform2fv(u.uDepthAB,DEPTH_AB);
      gl.uniform3f(u.uRayDX,r[0]*2*fx,r[1]*2*fx,r[2]*2*fx);
      gl.uniform3f(u.uRayDY,up[0]*2*fy,up[1]*2*fy,up[2]*2*fy);
      gl.uniform1f(u.uRaytrace,1);
      gl.uniform1f(u.uBossRage,this.bossRage??0);
      gl.uniform1f(u.uWetLevel,Math.max(this.wetLevel??0,.24));
      if (this.vp) {
        const m=this.vp;
        gl.uniformMatrix4fv(u.uVP,false,m);
        const sx=eye[0]+SUN[0]*120, sy=eye[1]+SUN[1]*120, sz=eye[2]+SUN[2]*120;
        const sw=m[3]*sx+m[7]*sy+m[11]*sz+m[15];
        if (sw>.05) {
          gl.uniform3f(u.uSunUV,(m[0]*sx+m[4]*sy+m[8]*sz+m[12])/sw*.5+.5,(m[1]*sx+m[5]*sy+m[9]*sz+m[13])/sw*.5+.5,sw);
        } else gl.uniform3f(u.uSunUV,0,0,0);
        const dx=SUN[0]*.093, dy=SUN[1]*.093, dz=SUN[2]*.093;
        const cx=m[0]*dx+m[4]*dy+m[8]*dz, cy=m[1]*dx+m[5]*dy+m[9]*dz;
        const cz=m[2]*dx+m[6]*dy+m[10]*dz, cw=m[3]*dx+m[7]*dy+m[11]*dz;
        gl.uniform4f(u.uHSun,(cx+cw)*.5*width,(cy+cw)*.5*height,(cz+cw)*.5,cw);
      }
      gl.uniform3fv(u.uEye,eye);
      gl.uniform3fv(u.uSun,SUN);
    }
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.depthMask(true);
  }

  exposure() {
    return mix(1,1.32,this.interior??0);
  }

  // Multisample count of the HDR target (the film renderer lowers it for 4K).
  setSamples(count) {
    this.maxSamples=count;
    const post=this.post;
    if (!post) return;
    const samples=Math.min(count,post.deviceSamples??0);
    if (samples===post.samples) return;
    post.samples=samples;
    post.w=post.h=0;
  }

  // Holds the display's refresh rate, up to 120 fps, by trading internal
  // resolution. The lightweight modes run at a fixed resolution instead.
  adapt() {
    const now=globalThis.performance?.now?.()??0;
    const dt=this.lastDraw?now-this.lastDraw:0;
    this.lastDraw=now;
    if (!(dt>0) || dt>75) return;
    this.frameAverage=this.frameAverage?this.frameAverage*.94+dt*.06:dt;
    if (!this.adaptive || this.lite || this.fixedSize || now-(this.adaptedAt??0)<1200) return;
    this.adaptedAt=now;
    const budget=Math.max(1000/(this.options?.fps||120),this.refreshInterval||1000/60);
    if (this.frameAverage>budget*1.3 && this.scale>.5) this.scale=Math.max(.5,this.scale-.1);
    else if (this.frameAverage<budget*1.07 && this.scale<1) this.scale=Math.min(1,this.scale+.05);
  }

  get fps() {
    return this.frameAverage?1000/this.frameAverage:0;
  }

  // Computes the current frame's camera frustum before dynamic scene submission
  // so non-shadow-casting VFX (droplets, decals, ripples, sparks, rain) outside
  // the view frustum skip CPU packing and GPU upload with zero visible loss.
  prepareView(camera,aspect) {
    if (!camera || camera.overview || !(aspect>0)) {
      this._hasViewPlanes=false;
      this.viewPoint=camera?.eye ?? null;
      return;
    }
    this.viewPoint=camera.eye;
    const vp=multiply(perspective(aspect),view(camera.eye,camera.target));
    frustumInto(vp,this._viewPlanes);
    this._hasViewPlanes=true;
  }

  inFrustum(x,y,z,r=1) {
    if (!this._hasViewPlanes || this.drawingAdjacent || this.overview) return true;
    return sphereInPlanes(this._viewPlanes,x,y,z,r);
  }

  _appendPacked(batch,src) {
    const n=src.length;
    if (!n) return;
    if (batch.length+n>batch.data.length) {
      let cap=Math.max(batch.data.length*2,STRIDE*256);
      while (cap<batch.length+n) cap*=2;
      const grown=new Float32Array(cap);
      grown.set(batch.data.subarray(0,batch.length));
      batch.data=grown;
    }
    batch.data.set(src,batch.length);
    batch.length+=n;
  }

  addPacked(type,data,cx,cy,cz,rad = 2.5) {
    const pair=this.batches[type];
    if (!pair || !data.length) return;
    if (this.drawingAdjacent) {this._appendPacked(pair.adjacent,data); return;}
    const vp=this.viewPoint;
    let split=data._split;
    if (!split && pair.closed) {
      const isBox=type==='box';
      let nArch=0, nVfx=0, nFull=0;
      for (let o=0;o<data.length;o+=STRIDE) {
        const k=Math.round(data[o+19]);
        if (isArchDynamicKind(k,isBox)) {
          const sx2=data[o]*data[o]+data[o+1]*data[o+1]+data[o+2]*data[o+2];
          const sy2=data[o+4]*data[o+4]+data[o+5]*data[o+5]+data[o+6]*data[o+6];
          const sz2=data[o+8]*data[o+8]+data[o+9]*data[o+9]+data[o+10]*data[o+10];
          if (sx2<.0256 && sy2<.0256 && sz2<.0256) nVfx++;
          else nArch++;
        } else nFull++;
      }
      if (!nFull && !nVfx) split={arch:data,vfx:null,full:null};
      else if (!nArch && !nVfx) split={arch:null,vfx:null,full:data};
      else if (!nArch && !nFull) split={arch:null,vfx:data,full:null};
      else {
        const arch=nArch?new Float32Array(nArch*STRIDE):null;
        const vfx=nVfx?new Float32Array(nVfx*STRIDE):null;
        const full=nFull?new Float32Array(nFull*STRIDE):null;
        let oa=0, ov=0, of=0;
        for (let o=0;o<data.length;o+=STRIDE) {
          const slice=data.subarray(o,o+STRIDE), k=Math.round(data[o+19]);
          if (isArchDynamicKind(k,isBox)) {
            const sx2=data[o]*data[o]+data[o+1]*data[o+1]+data[o+2]*data[o+2];
            const sy2=data[o+4]*data[o+4]+data[o+5]*data[o+5]+data[o+6]*data[o+6];
            const sz2=data[o+8]*data[o+8]+data[o+9]*data[o+9]+data[o+10]*data[o+10];
            if (sx2<.0256 && sy2<.0256 && sz2<.0256) {vfx.set(slice,ov); ov+=STRIDE;}
            else {arch.set(slice,oa); oa+=STRIDE;}
          } else {full.set(slice,of); of+=STRIDE;}
        }
        split={arch,vfx,full};
      }
      data._split=split;
    }
    if (this._hasViewPlanes && !this.overview && type!=='tri') {
      if (!sphereInPlanes(this._viewPlanes,cx,cy,cz,rad)) {
        if (pair.isAlpha || pair.isDecal) return;
        let farShadow=false;
        if (vp) {
          const dx=cx-vp[0], dy=cy-vp[1], dz=cz-vp[2];
          const d2=dx*dx+dy*dy+dz*dz;
          if (d2>14400) return;
          if (d2>2025) farShadow=true;
        }
        const shBatch=farShadow?pair.dynamicShadowFar:pair.dynamicShadow;
        if (split) {
          if (split.arch) this._appendPacked(shBatch,split.arch);
          if (split.full) this._appendPacked(shBatch,split.full);
        } else this._appendPacked(shBatch,data);
        return;
      }
    }
    if (!pair.closed) {this._appendPacked(pair.dynamic,data); return;}
    const hasLod=pair.hasLod;
    let useLo=hasLod && this.lite;
    if (hasLod && !useLo && vp) {
      const dx=cx-vp[0], dy=cy-vp[1], dz=cz-vp[2];
      const d2=dx*dx+dy*dy+dz*dz;
      if (d2>2500 || rad*rad<d2*.00055) useLo=true;
    }
    if (split.arch) this._appendPacked(useLo?pair.archDynamicLo:pair.archDynamic,split.arch);
    if (split.vfx) this._appendPacked(useLo?pair.archVfxLo:pair.archVfx,split.vfx);
    if (split.full) this._appendPacked(useLo?pair.dynamicLo:pair.dynamic,split.full);
  }

  add(type,x,y,z,w,h,d,tint,kind = 0,opts = EMPTY) {
    const pair=this.batches[type];
    if (!pair) return;
    let batch;
    if (opts.dynamic) {
      if (this.drawingAdjacent) batch=pair.adjacent;
      else {
        const vp=this.viewPoint;
        const isVfx=pair.closed && w<.16 && h<.16 && d<.16;
        if (this._hasViewPlanes && !this.overview && type!=='tri') {
          const rad=Math.sqrt(w*w+h*h+d*d)*.5+.12;
          if (!sphereInPlanes(this._viewPlanes,x,y,z,rad)) {
            if (pair.isAlpha || pair.isDecal || isVfx) return;
            let farShadow=false;
            if (vp) {
              const dx=x-vp[0], dy=y-vp[1], dz=z-vp[2];
              const d2=dx*dx+dy*dy+dz*dz;
              if (d2>14400) return;
              if (d2>2025) farShadow=true;
            }
            batch=farShadow?pair.dynamicShadowFar:pair.dynamicShadow;
          }
        }
        if (!batch) {
          if (pair.closed) {
            const hasLod=pair.hasLod;
            let useLo=hasLod && this.lite;
            if (hasLod && !useLo && vp) {
              const dx=x-vp[0], dy=y-vp[1], dz=z-vp[2];
              const d2=dx*dx+dy*dy+dz*dz;
              if (d2>2500) useLo=true;
              else if (type==='bevel' || type==='soft') {
                const md=w>h?(w>d?w:d):(h>d?h:d);
                if (md*md<d2*.0025) useLo=true;
              } else if (type==='limb' || type==='cylinder' || type==='taper') {
                const cd=w<d?d:w;
                if (cd*cd<d2*.00055) useLo=true;
              } else {
                const md=w>h?(w>d?w:d):(h>d?h:d);
                if (md*md<d2*.00055) useLo=true;
              }
            }
            const isArch=isArchDynamicKind(kind,type==='box');
            batch=isArch?(isVfx?(useLo?pair.archVfxLo:pair.archVfx):(useLo?pair.archDynamicLo:pair.archDynamic)):(useLo?pair.dynamicLo:pair.dynamic);
          } else batch=pair.dynamic;
        }
      }
    } else batch=pair[ZONE_BATCHES[this.zone]];
    if (batch.length+STRIDE>batch.data.length) {
      const grown=new Float32Array(Math.max(batch.data.length*2,STRIDE*256));
      grown.set(batch.data.subarray(0,batch.length));
      batch.data=grown;
    }
    packInstance(batch.data,batch.length,x,y,z,w,h,d,tint,kind,opts,pair.shapeId,pair.symmetric);
    batch.length+=STRIDE;
  }

  label(name,x,y,z,w,h,tint,yaw = 0,pitch = 0,opts = EMPTY) {
    const label=labelIndex(name);
    if (label>=0) this.add('quad',x,y,z,w,h,1,tint,7,{yaw,pitch,...opts,label});
  }

  beam(a,b,width,depth,tint,kind = 0,opts = EMPTY) {
    const dx=b[0]-a[0], dy=b[1]-a[1], dz=b[2]-a[2];
    const len=Math.sqrt(dx*dx+dy*dy+dz*dz), invL=1/(len>.00001?len:.00001);
    const yx=dx*invL, yy=dy*invL, yz=dz*invL;
    let xx,xy,xz;
    if (yz>.93 || yz<-.93) {
      const l=Math.sqrt(yz*yz+yy*yy), inv=1/(l>.00001?l:.00001);
      xx=0; xy=yz*inv; xz=-yy*inv;
    } else {
      const l=Math.sqrt(yy*yy+yx*yx), inv=1/(l>.00001?l:.00001);
      xx=yy*inv; xy=-yx*inv; xz=0;
    }
    const bx=this._bx??(this._bx=[0,0,0]), by=this._by??(this._by=[0,0,0]), bz=this._bz??(this._bz=[0,0,0]);
    const bo=this._bo??(this._bo={basis:[bx,by,bz],dynamic:false,label:undefined,layer:undefined,stairDuplicate:false,effect:undefined,windowId:undefined});
    bx[0]=xx; bx[1]=xy; bx[2]=xz;
    by[0]=yx; by[1]=yy; by[2]=yz;
    bz[0]=xy*yz-xz*yy; bz[1]=xz*yx-xx*yz; bz[2]=xx*yy-xy*yx;
    bo.dynamic=opts.dynamic;
    bo.label=opts.label;
    bo.layer=opts.layer;
    bo.stairDuplicate=opts.stairDuplicate;
    bo.effect=opts.effect;
    bo.windowId=opts.windowId;
    this.add(opts.shape ?? 'box',(a[0]+b[0])*.5,(a[1]+b[1])*.5,(a[2]+b[2])*.5,width,len,depth,tint,kind,bo);
  }

  hideStaticRegion(zoneIndex,minX,maxX,minY,maxY,minZ,maxZ) {
    const z=this.zones?.[zoneIndex];
    if (!z || !z.batches) return 0;
    const gl=this.gl;
    let hidden=0;
    for (const batch of z.batches) {
      if (!batch || !batch.data || !batch.count) continue;
      const data=batch.data, count=batch.count;
      let dirtyMin=-1, dirtyMax=-1;
      for (let i=0;i<count;i++) {
        const o=i*STRIDE;
        if (data[o]===0 && data[o+4]===0 && data[o+8]===0) continue;
        const kind=Math.round(data[o+19]);
        // Never hide floors (1) or asphalt roads (5) or lane markings (22) or sky/emissive ground markers (0)
        if (kind===1 || kind===5 || kind===22 || kind===0 || kind===27) continue;
        const px=data[o+12], py=data[o+13], pz=data[o+14];
        if (px>=minX && px<=maxX && py>=minY && py<=maxY && pz>=minZ && pz<=maxZ) {
          for (let k=0;k<11;k++) if (k!==3 && k!==7) data[o+k]=0;
          data[o+13]=-9000;
          if (dirtyMin<0) dirtyMin=i;
          dirtyMax=i;
          hidden++;
        }
      }
      if (dirtyMin>=0 && gl && batch.buffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER,batch.buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER,dirtyMin*STRIDE*4,data.subarray(dirtyMin*STRIDE,(dirtyMax+1)*STRIDE));
      }
    }
    if (hidden>0) this._staticShadowDirty=true;
    return hidden;
  }

  seal() {
    this.occluder?.clear();
    this._staticShadowDirty=true;
    for (let i=0;i<this.batchEntries.length;i++) {
      const {type,pair}=this.batchEntries[i];
      for (let zone=0;zone<ZONE_BATCHES.length;zone++) this.sealStatic(type,pair[ZONE_BATCHES[zone]],zone);
    }
  }

  // Sorts a static batch into 16 m spatial chunks partitioned by cutout status,
  // occluder-tier band, architectural fast-path, shadow role, and 2-bit yBand,
  // then pre-bakes Zone-0 geometry into compact non-instanced static VBOs/IBOs.
  sealStatic(type,batch,zone) {
    const gl=this.gl, count=batch.length/STRIDE, source=batch.data;
    deleteBaked(gl,batch);
    batch.chunks=[];
    batch.buckets=null;
    batch.count=count;
    if (!count) return;
    const origin=ZONES[zone].x, keys=new Uint32Array(count);
    const order=new Uint32Array(count), isTri=type==='tri', isBox=type==='box';
    const isClosed=CULL_MESHES.has(type), canArch=isClosed || (isTri && zone===0);
    const ext=type==='splat'?.56:type==='mantle'?.62:.5;
    for (let i=0;i<count;i++) {
      const o=i*STRIDE;
      let effR, sx=0, sy=0, sz=0, minY=0, maxY=0;
      const py=source[o+13];
      if (isTri) {
        // Triangles span p, p+a0, p+a1 (a2 is the unit surface normal, NOT a spatial extent!).
        const ax=source[o], ay=source[o+1], az=source[o+2];
        const bx=source[o+4], by=source[o+5], bz=source[o+6];
        const cx=(ax+bx)/3, cy=(ay+by)/3, cz=(az+bz)/3;
        const d0=cx*cx+cy*cy+cz*cz;
        const d1=(ax-cx)*(ax-cx)+(ay-cy)*(ay-cy)+(az-cz)*(az-cz);
        const d2=(bx-cx)*(bx-cx)+(by-cy)*(by-cy)+(bz-cz)*(bz-cz);
        effR=Math.sqrt(Math.max(d0,d1,d2));
        minY=py+(ay<0?(by<ay?by:ay):(by<0?by:0));
        maxY=py+(ay>0?(by>ay?by:ay):(by>0?by:0));
      } else {
        const a0=source[o], a1=source[o+1], a2=source[o+2];
        const b0=source[o+4], b1=source[o+5], b2=source[o+6];
        const c0=source[o+8], c1=source[o+9], c2=source[o+10];
        const sx2=a0*a0+a1*a1+a2*a2, sy2=b0*b0+b1*b1+b2*b2, sz2=c0*c0+c1*c1+c2*c2;
        sx=Math.sqrt(sx2); sy=Math.sqrt(sy2); sz=Math.sqrt(sz2);
        const hy=(Math.abs(a1)+Math.abs(b1)+Math.abs(c1))*ext;
        minY=py-hy; maxY=py+hy;
        // Effective cross-sectional solid-angle radius demotes thin railings,
        // window mullions and wires while preserving full reach for broad walls.
        let a=sx, b=sy, c=sz;
        if (a>b) {const t=a;a=b;b=t;}
        if (b>c) {const t=b;b=c;c=t;}
        if (a>b) {const t=a;a=b;b=t;}
        effR=Math.sqrt(b*Math.min(c,b*14))*.5;
      }
      const tier=effR<TIER_RADII[0]?0:effR<TIER_RADII[1]?1:effR<TIER_RADII[2]?2:3;
      const kind=Math.round(source[o+19]);
      const isBakedMark=isBox && zone===0 && kind===22 && source[o+1]===0 && source[o+9]===0 && source[o+5]>0;
      const cutout=(kind===14 || (kind===22 && !isBakedMark) || kind===27)?1:0;
      const archSimple=(canArch && !cutout && (kind===0 || kind===1 || kind===2 || kind===3 || kind===4 || kind===19 || kind===29 || isBakedMark ||
        (kind===13 && (isBox || isTri)) || (zone!==0 && kind===15) ||
        (zone===0 && (kind===9 || kind===18 || kind===20 || kind===21 || kind===30 || kind===31))))?1:0;
      let noShadow=(kind===22 || kind===27)?1:0;
      if (!noShadow && isBox && zone===0) {
        if (maxY<=.28 && sy<=.32 && (sx>=2 || sz>=2)) noShadow=1;
      }
      if (zone===0 && isBox && !cutout && !isBakedMark && kind!==8 && kind!==6 && kind!==3 && source[o+22]<=.5) {
        this.occluder?.addBoxFromPacked(source,o);
      }
      const cx=clamp(Math.floor((source[o+12]-origin)/CHUNK)+32,0,63);
      const cz=clamp(Math.floor(source[o+14]/CHUNK)+32,0,63);
      const yBand=maxY<.04?0:minY<.04?1:minY<4.5?2:3;
      const loTier=tier<2?1:0;
      const subTier=(3-tier)&1;
      // Contiguous 19-bit key: [cutout:1][loTier:1][archSimple:1][subTier:1][noShadow:1][yBand:2][morton6:12]
      // Separates ground slabs (yBand 0), straddling walls (1), low props (2), and upper stories (3)
      // while keeping opaqueHi, archHi, fullHi, archLo, fullLo, and cutout contiguous in memory.
      keys[i]=(cutout<<18)|(loTier<<17)|(archSimple<<16)|(subTier<<15)|(noShadow<<14)|(yBand<<12)|morton6(cx,cz);
    }
    // Stable O(N) 2-pass 10-bit Radix Sort over 19-bit keys (zero JS comparator calls).
    const tmp=new Uint32Array(count), counts=new Uint32Array(1024);
    for (let i=0;i<count;i++) counts[keys[i]&1023]++;
    for (let b=0,sum=0;b<1024;b++) {const c=counts[b];counts[b]=sum;sum+=c;}
    for (let i=0;i<count;i++) tmp[counts[keys[i]&1023]++]=i;
    counts.fill(0);
    for (let i=0;i<count;i++) counts[(keys[tmp[i]]>>>10)&1023]++;
    for (let b=0,sum=0;b<1024;b++) {const c=counts[b];counts[b]=sum;sum+=c;}
    for (let i=0;i<count;i++) {const idx=tmp[i];order[counts[(keys[idx]>>>10)&1023]++]=idx;}
    const data=new Float32Array(count*STRIDE);
    let chunk=null;
    for (let k=0;k<count;k++) {
      const i=order[k], o=i*STRIDE, dst=k*STRIDE;
      for (let j=0;j<STRIDE;j++) data[dst+j]=source[o+j];
      const key=keys[i];
      if (!chunk || chunk.key!==key) {
        const cutout=(key>>18)&1, loTier=(key>>17)&1, archSimple=(key>>16)&1, subTier=(key>>15)&1, noShadow=(key>>14)&1;
        const tier=3-((loTier<<1)|subTier);
        chunk={key,start:k,count:0,tier,small:tier<=1,cutout:!!cutout,archSimple:!!archSimple,noShadow:!!noShadow,aboveMirror:true,
          bfStart:0,bfCount:0,bfullStart:0,bfullCount:0,bhiStart:0,bhiCount:0,bloStart:0,bloCount:0,bmStart:0,bmCount:0,
          min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
        batch.chunks.push(chunk);
      }
      chunk.count++;
      // Exact tight oriented AABB (no spherical radius bloat): maximizes Hi-Z occlusion hits
      // and keeps flat street/sidewalk slabs cleanly excluded from the mirror pass.
      const px=source[o+12], py=source[o+13], pz=source[o+14];
      if (isTri) {
        const ax=source[o], ay=source[o+1], az=source[o+2];
        const bx=source[o+4], by=source[o+5], bz=source[o+6];
        const lx=px+(ax<0?(bx<ax?bx:ax):(bx<0?bx:0)), hx=px+(ax>0?(bx>ax?bx:ax):(bx>0?bx:0));
        const ly=py+(ay<0?(by<ay?by:ay):(by<0?by:0)), hy=py+(ay>0?(by>ay?by:ay):(by>0?by:0));
        const lz=pz+(az<0?(bz<az?bz:az):(bz<0?bz:0)), hz=pz+(az>0?(bz>az?bz:az):(bz>0?bz:0));
        if (lx<chunk.min[0]) chunk.min[0]=lx; if (hx>chunk.max[0]) chunk.max[0]=hx;
        if (ly<chunk.min[1]) chunk.min[1]=ly; if (hy>chunk.max[1]) chunk.max[1]=hy;
        if (lz<chunk.min[2]) chunk.min[2]=lz; if (hz>chunk.max[2]) chunk.max[2]=hz;
      } else {
        const hx=(Math.abs(source[o])+Math.abs(source[o+4])+Math.abs(source[o+8]))*ext;
        const hy=(Math.abs(source[o+1])+Math.abs(source[o+5])+Math.abs(source[o+9]))*ext;
        const hz=(Math.abs(source[o+2])+Math.abs(source[o+6])+Math.abs(source[o+10]))*ext;
        if (px-hx<chunk.min[0]) chunk.min[0]=px-hx; if (px+hx>chunk.max[0]) chunk.max[0]=px+hx;
        if (py-hy<chunk.min[1]) chunk.min[1]=py-hy; if (py+hy>chunk.max[1]) chunk.max[1]=py+hy;
        if (pz-hz<chunk.min[2]) chunk.min[2]=pz-hz; if (pz+hz>chunk.max[2]) chunk.max[2]=pz+hz;
      }
    }
    // Pre-partition chunks by immutable pass filter so drawStatic scans ONLY matching chunks.
    const buckets={all:batch.chunks,opaque:[],opaqueHi:[],opaqueLo:[],archHi:[],archLo:[],fullHi:[],fullLo:[],cutout:[],shadow:[],mirrorOpaque:[],mirrorClip:[]};
    for (let i=0;i<batch.chunks.length;i++) {
      const c=batch.chunks[i];
      c.aboveMirror=c.min[1]>=.04;
      if (!c.noShadow) buckets.shadow.push(c);
      if (c.cutout) {
        buckets.cutout.push(c);
      } else {
        buckets.opaque.push(c);
        if (c.tier>=2) {
          buckets.opaqueHi.push(c);
          if (c.archSimple) buckets.archHi.push(c); else buckets.fullHi.push(c);
        } else {
          buckets.opaqueLo.push(c);
          if (c.archSimple) buckets.archLo.push(c); else buckets.fullLo.push(c);
        }
        if (c.aboveMirror) buckets.mirrorOpaque.push(c);
      }
      if (c.max[1]>=.04 && (!c.aboveMirror || c.cutout)) buckets.mirrorClip.push(c);
    }
    batch.buckets=buckets;
    // Pre-bake Zone-0 outdoor closed solids and ground triangles into non-instanced VBOs/IBOs
    // to eliminate SwiftShader/driver per-instance dispatch overhead (3.3x-4.7x faster draw).
    if (zone===0 && (isClosed || isTri)) {
      const pair=this.batches[type], md=this.meshData[type], gIBO=this._gatherIBO;
      if (pair.flat) {
        batch.bakedFlat=bakeStaticFlat(gl,md.hi,isBox?this._boxNoBot:null,isBox?this._boxTopOnly:null,data,batch.chunks,'bfStart','bfCount',gIBO);
        if ((isBox || type==='ramp') && (buckets.fullHi.length || buckets.fullLo.length)) {
          const fullChunks=[...buckets.fullHi,...buckets.fullLo];
          batch.bakedFull=bakeStaticFull(gl,md.hi,isBox?this._boxNoBot:null,data,fullChunks,'bfullStart','bfullCount',pair.shapeId,gIBO);
        }
      } else {
        batch.bakedCurvedHi=bakeStaticCurved(gl,md.hi,data,batch.chunks,'bhiStart','bhiCount',gIBO);
        if (pair.isFlatLo) {
          batch.bakedFlat=bakeStaticFlat(gl,md.lo,null,null,data,batch.chunks,'bfStart','bfCount',gIBO);
        } else {
          batch.bakedCurvedLo=bakeStaticCurved(gl,md.lo,data,batch.chunks,'bloStart','bloCount',gIBO);
          const mirrorChunks=[];
          for (let i=0;i<batch.chunks.length;i++) if (batch.chunks[i].max[1]>=.04) mirrorChunks.push(batch.chunks[i]);
          if (mirrorChunks.length) {
            batch.bakedMirror=pair.shFlat
              ?bakeStaticFlat(gl,md.sh,null,null,data,mirrorChunks,'bmStart','bmCount',gIBO)
              :bakeStaticCurved(gl,md.sh,data,mirrorChunks,'bmStart','bmCount',gIBO);
          }
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,batch.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    batch.capacity=data.byteLength;
    batch.data=new Float32Array(0);
    batch.length=0;
  }

  upload(batch) {
    const gl=this.gl;
    batch.count=batch.length/STRIDE;
    if (!batch.count) return;
    const bytes=batch.length*4;
    gl.bindBuffer(gl.ARRAY_BUFFER,batch.buffer);
    if (bytes>batch.capacity) {
      batch.capacity=Math.max(4096,2**Math.ceil(Math.log2(bytes)));
      gl.bufferData(gl.ARRAY_BUFFER,batch.capacity,gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER,0,batch.data,0,batch.length);
  }

  clearDynamic() {
    for (let i=0;i<this.batchEntries.length;i++) {
      const pair=this.batchEntries[i].pair;
      pair.dynamic.length=0;
      pair.dynamicLo.length=0;
      pair.archDynamic.length=0;
      pair.archDynamicLo.length=0;
      pair.archVfx.length=0;
      pair.archVfxLo.length=0;
      pair.dynamicShadow.length=0;
      pair.dynamicShadowFar.length=0;
      pair.adjacent.length=0;
    }
  }

  drawRange(vao,buffer,start,count) {
    const gl=this.gl;
    if (this._boundVao!==vao.vao) {
      gl.bindVertexArray(vao.vao);
      this._boundVao=vao.vao;
    }
    if (vao.buffer!==buffer || vao.start!==start) {
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      const base=start*STRIDE*4;
      for (let i=0;i<6;i++) gl.vertexAttribPointer(4+i,4,gl.FLOAT,false,STRIDE*4,base+i*16);
      vao.buffer=buffer;
      vao.start=start;
    }
    gl.drawElementsInstanced(gl.TRIANGLES,vao.triangles,gl.UNSIGNED_SHORT,0,count);
  }

  drawStatic(type,batch,planes,eye,offset,settings,filter='all',shapeLoc=null,useOcc=false,useShadowVao=false) {
    if (!batch.count) return;
    const chunks=batch.buckets?batch.buckets[filter]:batch.chunks;
    if (!chunks || !chunks.length) return;
    const vaos=this.vaos[type];
    const hasLod=!useShadowVao && vaos.hasLod;
    const isBevel=type==='bevel';
    const lodDist=isBevel?(settings.bevelLodDist??settings.lodDist):settings.lodDist;
    const lodDist2=lodDist*lodDist;
    const cull=settings.cull;
    const tierDist=settings.tierDist;
    const gl=this.gl;
    const occ=useOcc && offset===0 && this.occluder?.active?this.occluder:null;
    let lod=-1, start=0, end=0;
    const flush=()=>{
      if (end<=start) return;
      // Analytic Rounded-Edge Bevel Promotion: bevels switched to 12-tri box LOD
      // enable uShape=1 so SCENE_FRAGMENT bends rounded edges analytically.
      if (isBevel && shapeLoc) gl.uniform1i(shapeLoc,lod?1:3);
      this.drawRange(useShadowVao?vaos.sh:(lod?vaos.lo:vaos.hi),batch.buffer,start,end-start);
    };
    for (let i=0;i<chunks.length;i++) {
      const chunk=chunks[i];
      const limit=tierDist?tierDist[chunk.tier]:Infinity;
      if (limit<=0) continue;
      if (!boxVisible(planes,chunk.min,chunk.max,offset)) continue;
      const d2=boxDistanceSq(eye,chunk.min,chunk.max,offset);
      const cut=limit<cull?limit:cull;
      if (cut!==Infinity && d2>cut*cut) continue;
      if (occ && !occ.isBoxVisible(chunk.min,chunk.max,0)) continue;
      const want=hasLod && d2>lodDist2?1:0;
      if (want===lod && chunk.start===end) end=chunk.start+chunk.count;
      else {
        flush();
        lod=want;
        start=chunk.start;
        end=chunk.start+chunk.count;
      }
    }
    flush();
  }

  _drawBakedRuns(baked,starts,ends,runCount) {
    if (!runCount) return;
    const gl=this.gl;
    if (runCount<=2 || !baked.gatherVao) {
      if (this._boundVao!==baked.vao) {gl.bindVertexArray(baked.vao); this._boundVao=baked.vao;}
      for (let r=0;r<runCount;r++) {
        const s=starts[r], cnt=ends[r]-s;
        if (cnt>0) gl.drawElements(gl.TRIANGLES,cnt,gl.UNSIGNED_INT,s*4);
      }
      return;
    }
    let totalI=0;
    for (let r=0;r<runCount;r++) totalI+=ends[r]-starts[r];
    if (!totalI) return;
    if (totalI>this._gatherCap) {
      let cap=this._gatherCap;
      while (cap<totalI) cap<<=1;
      this._gatherCap=cap;
      this._gatherIdx=new Uint32Array(cap);
      gl.bindVertexArray(null);
      this._boundVao=null;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this._gatherIBO);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,cap*4,gl.STREAM_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,null);
    }
    const dst=this._gatherIdx, src=baked.idx;
    let off=0;
    for (let r=0;r<runCount;r++) {
      const s=starts[r], e=ends[r];
      dst.set(src.subarray(s,e),off);
      off+=e-s;
    }
    if (this._boundVao!==baked.gatherVao) {gl.bindVertexArray(baked.gatherVao); this._boundVao=baked.gatherVao;}
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER,0,dst.subarray(0,totalI));
    gl.drawElements(gl.TRIANGLES,totalI,gl.UNSIGNED_INT,0);
  }

  drawBakedStatic(batch,baked,startF,countF,planes,eye,settings,filter,useOcc=false,lodMode=0,lodDist2=0) {
    if (!batch.count || !baked) return;
    const chunks=batch.buckets?batch.buckets[filter]:batch.chunks;
    if (!chunks || !chunks.length) return;
    const cull=settings.cull, tierDist=settings.tierDist;
    const occ=useOcc && this.occluder?.active?this.occluder:null;
    let starts=this._runStarts, ends=this._runEnds;
    let runCount=0, start=0, end=0;
    for (let i=0;i<chunks.length;i++) {
      const chunk=chunks[i];
      const cnt=chunk[countF];
      if (!cnt) continue;
      const limit=tierDist?tierDist[chunk.tier]:Infinity;
      if (limit<=0) continue;
      if (!boxVisible(planes,chunk.min,chunk.max,0)) continue;
      const d2=boxDistanceSq(eye,chunk.min,chunk.max,0);
      const cut=limit<cull?limit:cull;
      if (cut!==Infinity && d2>cut*cut) continue;
      if (occ && !occ.isBoxVisible(chunk.min,chunk.max,0)) continue;
      if (lodMode===1 && d2>lodDist2) continue;
      if (lodMode===2 && d2<=lodDist2) continue;
      const st=chunk[startF];
      if (st===end) end=st+cnt;
      else {
        if (end>start) {
          if (runCount>=starts.length) {
            const ns=new Int32Array(starts.length*2), ne=new Int32Array(ends.length*2);
            ns.set(starts); ne.set(ends);
            starts=this._runStarts=ns; ends=this._runEnds=ne;
          }
          starts[runCount]=start; ends[runCount++]=end;
        }
        start=st; end=st+cnt;
      }
    }
    if (end>start) {
      if (runCount>=starts.length) {
        const ns=new Int32Array(starts.length*2), ne=new Int32Array(ends.length*2);
        ns.set(starts); ne.set(ends);
        starts=this._runStarts=ns; ends=this._runEnds=ne;
      }
      starts[runCount]=start; ends[runCount++]=end;
    }
    this._drawBakedRuns(baked,starts,ends,runCount);
  }

  // Coalesces two chunk buckets (e.g. archHi + archLo or fullHi + fullLo) sharing one baked VAO
  // into a single gather upload + gl.drawElements call.
  drawBakedStaticPair(batch,baked,startF,countF,planes,eye,settings,f1,f2,useOcc=false,lodMode=0,lodDist2=0) {
    if (!batch.count || !baked || !batch.buckets) return;
    const c1=batch.buckets[f1], c2=batch.buckets[f2];
    if ((!c1 || !c1.length) && (!c2 || !c2.length)) return;
    const cull=settings.cull, tierDist=settings.tierDist;
    const occ=useOcc && this.occluder?.active?this.occluder:null;
    let starts=this._runStarts, ends=this._runEnds;
    let runCount=0, start=0, end=0;
    for (let pass=0;pass<2;pass++) {
      const chunks=pass===0?c1:c2;
      if (!chunks || !chunks.length) continue;
      for (let i=0;i<chunks.length;i++) {
        const chunk=chunks[i];
        const cnt=chunk[countF];
        if (!cnt) continue;
        const limit=tierDist?tierDist[chunk.tier]:Infinity;
        if (limit<=0) continue;
        if (!boxVisible(planes,chunk.min,chunk.max,0)) continue;
        const d2=boxDistanceSq(eye,chunk.min,chunk.max,0);
        const cut=limit<cull?limit:cull;
        if (cut!==Infinity && d2>cut*cut) continue;
        if (occ && !occ.isBoxVisible(chunk.min,chunk.max,0)) continue;
        if (lodMode===1 && d2>lodDist2) continue;
        if (lodMode===2 && d2<=lodDist2) continue;
        const st=chunk[startF];
        if (st===end) end=st+cnt;
        else {
          if (end>start) {
            if (runCount>=starts.length) {
              const ns=new Int32Array(starts.length*2), ne=new Int32Array(ends.length*2);
              ns.set(starts); ne.set(ends);
              starts=this._runStarts=ns; ends=this._runEnds=ne;
            }
            starts[runCount]=start; ends[runCount++]=end;
          }
          start=st; end=st+cnt;
        }
      }
    }
    if (end>start) {
      if (runCount>=starts.length) {
        const ns=new Int32Array(starts.length*2), ne=new Int32Array(ends.length*2);
        ns.set(starts); ne.set(ends);
        starts=this._runStarts=ns; ends=this._runEnds=ne;
      }
      starts[runCount]=start; ends[runCount++]=end;
    }
    this._drawBakedRuns(baked,starts,ends,runCount);
  }

  drawBakedLOD(type,batch,planes,eye,settings,filter,useOcc=false) {
    if (!batch.count) return;
    const hi=batch.bakedCurvedHi, lo=batch.bakedCurvedLo ?? batch.bakedFlat;
    if (!hi && !lo) return;
    const chunks=batch.buckets?batch.buckets[filter]:batch.chunks;
    if (!chunks || !chunks.length) return;
    const cull=settings.cull, tierDist=settings.tierDist;
    const occ=useOcc && this.occluder?.active?this.occluder:null;
    const isBevel=type==='bevel';
    const lodDist=isBevel?(settings.bevelLodDist??settings.lodDist):settings.lodDist;
    const lodDist2=lodDist*lodDist;
    const hasLod=!!(hi && lo && this.vaos[type].hasLod);
    const loStartF=batch.bakedCurvedLo?'bloStart':'bfStart';
    const loCountF=batch.bakedCurvedLo?'bloCount':'bfCount';
    const hiS=this._runStarts, hiE=this._runEnds;
    const loS=this._runStartsLo ?? (this._runStartsLo=new Int32Array(4096));
    const loE=this._runEndsLo ?? (this._runEndsLo=new Int32Array(4096));
    let hiN=0, hiA=0, hiB=0, loN=0, loA=0, loB=0;
    for (let i=0;i<chunks.length;i++) {
      const chunk=chunks[i];
      const limit=tierDist?tierDist[chunk.tier]:Infinity;
      if (limit<=0) continue;
      if (!boxVisible(planes,chunk.min,chunk.max,0)) continue;
      const d2=boxDistanceSq(eye,chunk.min,chunk.max,0);
      const cut=limit<cull?limit:cull;
      if (cut!==Infinity && d2>cut*cut) continue;
      if (occ && !occ.isBoxVisible(chunk.min,chunk.max,0)) continue;
      const want=hasLod && d2>lodDist2?1:0;
      const st=want?chunk[loStartF]:chunk.bhiStart;
      const cnt=want?chunk[loCountF]:chunk.bhiCount;
      if (!cnt) continue;
      if (want) {
        if (st===loB) loB=st+cnt;
        else {if (loB>loA && loN<loS.length) {loS[loN]=loA; loE[loN++]=loB;} loA=st; loB=st+cnt;}
      } else {
        if (st===hiB) hiB=st+cnt;
        else {if (hiB>hiA && hiN<hiS.length) {hiS[hiN]=hiA; hiE[hiN++]=hiB;} hiA=st; hiB=st+cnt;}
      }
    }
    if (hiB>hiA && hiN<hiS.length) {hiS[hiN]=hiA; hiE[hiN++]=hiB;}
    if (loB>loA && loN<loS.length) {loS[loN]=loA; loE[loN++]=loB;}
    if (hiN && hi) this._drawBakedRuns(hi,hiS,hiE,hiN);
    if (loN && lo) this._drawBakedRuns(lo,loS,loE,loN);
  }

  drawDynamic(type,batch,low=false,shapeLoc=null) {
    if (!batch.count) return;
    if (type==='bevel' && shapeLoc) this.gl.uniform1i(shapeLoc,low?1:3);
    this.drawRange(low?this.vaos[type].lo:this.vaos[type].hi,batch.buffer,0,batch.count);
  }

  drawDynamicShadow(type,batch) {
    if (!batch.count) return;
    this.drawRange(this.vaos[type].sh,batch.buffer,0,batch.count);
  }

  _drawShadowStaticBaked(planes,eye,settings) {
    const shadowBatches=this.shadowBatches;
    for (let b=0;b<shadowBatches.length;b++) {
      const {type,pair,flat}=shadowBatches[b];
      const sb=pair.static;
      if (!sb.count) continue;
      if (flat) this.drawBakedStatic(sb,sb.bakedFlat,'bfStart','bfCount',planes,eye,settings,'shadow',false);
      else this.drawBakedLOD(type,sb,planes,eye,settings,'shadow',false);
    }
  }

  _streamDynamicShadows(planes,includeFar) {
    const shadowBatches=this.shadowBatches, st=this._dynShadow, mdAll=this.meshData;
    st.reset();
    for (let b=0;b<shadowBatches.length;b++) {
      const {type,pair}=shadowBatches[b], mLo=mdAll[type].lo, mSh=mdAll[type].sh;
      if (pair.dynamic.count) st.appendShadow(mLo,mSh,pair.dynamic.data,pair.dynamic.count,planes);
      if (pair.dynamicLo.count) st.appendShadow(mLo,mSh,pair.dynamicLo.data,pair.dynamicLo.count,planes);
      if (pair.archDynamic.count) st.appendShadow(mLo,mSh,pair.archDynamic.data,pair.archDynamic.count,planes);
      if (pair.archDynamicLo.count) st.appendShadow(mLo,mSh,pair.archDynamicLo.data,pair.archDynamicLo.count,planes);
      if (pair.dynamicShadow.count) st.appendShadow(mLo,mSh,pair.dynamicShadow.data,pair.dynamicShadow.count,planes);
      if (includeFar && pair.dynamicShadowFar.count) st.appendShadow(mLo,mSh,pair.dynamicShadowFar.data,pair.dynamicShadowFar.count,planes);
    }
    if (st.iCount) {
      st.flush();
      this._boundVao=st.vao;
    }
  }

  renderShadows(camera) {
    const gl=this.gl;
    const lx=camera.target[0]-camera.eye[0], lz=camera.target[2]-camera.eye[2];
    const ll=Math.sqrt(lx*lx+lz*lz);
    const ahead=ll>.001?[lx/ll,0,lz/ll]:[0,0,-1];
    gl.useProgram(this.shadowBaked);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.15,2);
    this._boundVao=null;
    for (const [i,cascade] of this.cascades.entries()) {
      if (cascade.matrix && i>0) {
        const dx=camera.eye[0]-cascade.eyeX, dz=camera.eye[2]-cascade.eyeZ;
        if ((this.frame+i)%cascade.every && dx*dx+dz*dz<9) continue;
      } else if (cascade.matrix && (this.frame+i)%cascade.every) continue;
      cascade.eyeX=camera.eye[0];
      cascade.eyeZ=camera.eye[2];
      const lead=cascade.radius*.58;
      const center=[camera.eye[0]+ahead[0]*lead,clamp(camera.eye[1],0,24)*.35,camera.eye[2]+ahead[2]*lead];
      const lightView=view(add(center,scale(SUN,230)),center);
      const tx=Math.round(lightView[12]/cascade.texel)*cascade.texel;
      const ty=Math.round(lightView[13]/cascade.texel)*cascade.texel;
      lightView[12]=tx;
      lightView[13]=ty;
      const cache=i===0?this._staticShadowCache:null;
      if (cache) {
        let ox=Math.round((cache.tx-tx)/cache.texel)+cache.margin;
        let oy=Math.round((cache.ty-ty)/cache.texel)+cache.margin;
        const maxOff=cache.size-cascade.size;
        if (!cache.valid || this._staticShadowDirty || ox<0 || ox>maxOff || oy<0 || oy>maxOff || Math.abs(lightView[14]-cache.tz)>12) {
          cache.tx=tx; cache.ty=ty; cache.tz=lightView[14];
          const cacheMatrix=multiply(ortho(cache.radius,cache.radius,1,480),lightView);
          gl.bindFramebuffer(gl.FRAMEBUFFER,cache.buffer);
          gl.viewport(0,0,cache.size,cache.size);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.uniformMatrix4fv(this.shadowBakedUniform,false,cacheMatrix);
          const cPlanes=frustumInto(cacheMatrix,this._shadowPlanes);
          // Pad tier/LOD radii by the cache margin so static Tier-0/1 casters entering C0
          // as the camera moves within the cached window are never missing from the blitted map.
          const pad=cache.margin*cache.texel*1.5;
          const cacheSettings={lodDist:SHADOW_C0.lodDist+pad,bevelLodDist:SHADOW_C0.bevelLodDist+pad,
            tierDist:[SHADOW_C0.tierDist[0]+pad,SHADOW_C0.tierDist[1]+pad,Infinity,Infinity],cull:Infinity};
          this._drawShadowStaticBaked(cPlanes,camera.eye,cacheSettings);
          cache.valid=true;
          this._staticShadowDirty=false;
          ox=cache.margin; oy=cache.margin;
        }
        // Keep exact lightView[14] from cache so blitted static depth & dynamic depth match bit-for-bit!
        lightView[14]=cache.tz;
        cascade.matrix=multiply(ortho(cascade.radius,cascade.radius,1,480),lightView);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,cache.buffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,cascade.buffer);
        gl.blitFramebuffer(ox,oy,ox+cascade.size,oy+cascade.size,0,0,cascade.size,cascade.size,gl.DEPTH_BUFFER_BIT,gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
        gl.bindFramebuffer(gl.FRAMEBUFFER,cascade.buffer);
        gl.viewport(0,0,cascade.size,cascade.size);
        gl.uniformMatrix4fv(this.shadowBakedUniform,false,cascade.matrix);
        const dPlanes=frustumInto(cascade.matrix,this._shadowPlanes);
        this._streamDynamicShadows(dPlanes,false);
      } else {
        cascade.matrix=multiply(ortho(cascade.radius,cascade.radius,1,480),lightView);
        gl.bindFramebuffer(gl.FRAMEBUFFER,cascade.buffer);
        gl.viewport(0,0,cascade.size,cascade.size);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix4fv(this.shadowBakedUniform,false,cascade.matrix);
        const planes=frustumInto(cascade.matrix,this._shadowPlanes);
        this._drawShadowStaticBaked(planes,camera.eye,i?SHADOW_C1:SHADOW_C0);
        this._streamDynamicShadows(planes,i>0);
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  }

  draw(camera,paint,clock) {
    const gl = this.gl, canvas = this.canvas;
    this.adapt();
    const dpr=globalThis.devicePixelRatio || 1;
    const cw=Math.max(1,canvas.clientWidth||1), ch=Math.max(1,canvas.clientHeight||1);
    const limit=this.renderLimit || 4096;
    // Offline video uses its exact frame size; the lightweight modes a fixed
    // 400p / 300p; high quality the display's own pixels within a budget.
    const pixels=RESOLUTION_PIXELS[this.options?.resolution];
    const ratio=this.fixedSize?1:this.lite?Math.min(dpr,(this.ultralite?ULTRA_LINES:LITE_LINES)/Math.min(cw,ch),limit/cw,limit/ch):
      pixels?Math.min(Math.sqrt(pixels/(cw*ch)),limit/cw,limit/ch):
      Math.min(dpr,2,Math.sqrt(2.9e6/(cw*ch)),limit/cw,limit/ch)*(this.scale||1);
    this._lastEye=camera.eye;
    this.viewZone=zoneOf(camera.eye[0]);
    this.mergeStairs=!!camera.stair && this.viewZone<2;
    this.interior=interiorBlend(camera);
    this.overview=!!camera.overview;
    const w=this.fixedSize?this.fixedSize[0]:Math.max(1,Math.round(cw*ratio));
    const h=this.fixedSize?this.fixedSize[1]:Math.max(1,Math.round(ch*ratio));
    if (canvas.width!==w || canvas.height!==h) {
      canvas.width=w;
      canvas.height=h;
    }
    const direction = unit(sub(camera.target,camera.eye));
    const right = unit(cross(direction,UP));
    const up = cross(right,direction);
    this._lastDir=direction;
    this._lastRight=right;
    this._lastUp=up;
    this._lastAspect=w/h;
    const outdoor=this.viewZone===0 && this.interior<.995;
    // No shadow maps and no mirror pass at all in the lightweight modes.
    this.effects=outdoor && !this.lite && this.prepareEffects();
    const mirrorW=Math.max(1,Math.round(w*.35)), mirrorH=Math.max(1,Math.round(h*.35));
    // Analytic horizon scissor: street puddles sit at y<=0.08, so every pixel above
    // the analytic ground horizon (plus max normal perturbation 0.035 + filter pad)
    // is never sampled by uReflection and can be hardware-scissored out cleanly.
    let mirrorMaxRow=mirrorH;
    if (camera.eye[1]>.15 && up[1]>.001) {
      const vMax=((-direction[1]/(up[1]*Math.tan(FOV/2)))+1)*.5+.045;
      mirrorMaxRow=vMax<=0?0:Math.min(mirrorH,Math.ceil(vMax*mirrorH));
    }
    this._mirrorMaxRow=mirrorMaxRow;
    // Visibility-gated planar reflections: skip when street-level puddles are
    // not visible (aerial overview, high elevation, or looking above horizon).
    const needMirror=this.effects && !this.lite && this.options?.reflections!==false &&
      !this.overview && camera.eye[1]<=18 && mirrorMaxRow>0;
    this.reflections=needMirror && this.prepareMirror(mirrorW,mirrorH);
    this.hdr=!this.lite && this.preparePost(w,h);
    const deferBaked=this.hdr && !this.post.msaa && this.post.gBuffer && this.post.colorOnly &&
      this.viewZone===0 && this.interior<=.001 && !this.mergeStairs && this.ensureDeferredShaders();
    if (this.batchEntries) {
      for (let i=0;i<this.batchEntries.length;i++) {
        const pair=this.batchEntries[i].pair;
        this.upload(pair.dynamic);
        this.upload(pair.dynamicLo);
        if (deferBaked) {
          // Baked/streamed deferred outdoor, mirror, and shadow passes read CPU data directly.
          pair.archDynamic.count=pair.archDynamic.length/STRIDE;
          pair.archDynamicLo.count=pair.archDynamicLo.length/STRIDE;
          pair.archVfx.count=pair.archVfx.length/STRIDE;
          pair.archVfxLo.count=pair.archVfxLo.length/STRIDE;
          pair.dynamicShadow.count=pair.dynamicShadow.length/STRIDE;
          pair.dynamicShadowFar.count=pair.dynamicShadowFar.length/STRIDE;
        } else {
          this.upload(pair.archDynamic);
          this.upload(pair.archDynamicLo);
          this.upload(pair.archVfx);
          this.upload(pair.archVfxLo);
          this.upload(pair.dynamicShadow);
          this.upload(pair.dynamicShadowFar);
        }
        if (this.mergeStairs) this.upload(pair.adjacent);
        else pair.adjacent.count=0;
      }
    } else for (const pair of Object.values(this.batches)) {
      this.upload(pair.dynamic);
      this.upload(pair.dynamicLo);
      this.upload(pair.archDynamic);
      this.upload(pair.archDynamicLo);
      this.upload(pair.archVfx);
      this.upload(pair.archVfxLo);
      this.upload(pair.dynamicShadow);
      this.upload(pair.dynamicShadowFar);
      if (this.mergeStairs) this.upload(pair.adjacent);
      else pair.adjacent.count=0;
    }
    this.vp = multiply(perspective(w/h),view(camera.eye,camera.target));
    if (this.effects) this.renderShadows(camera);
    this.frame++;
    gl.activeTexture(gl.TEXTURE0+UNIT.ink);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    if (this.inkSource!==paint) {
      const old=this.inkSource;
      if (old.w!==paint.w || old.h!==paint.h || old.layers!==paint.layers) {
        gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,paint.w,paint.h,paint.layers,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      }
      this.inkSource=paint;
      this.lastInkMask=0;
      if (paint.touchLayers) paint.touchLayers((1<<paint.layers)-1);
      else paint.dirtyMask=(1<<paint.layers)-1;
    }
    const visibleMask=ZONES[this.viewZone].inkMask | (this.mergeStairs?ZONES[1-this.viewZone].inkMask:0);
    const changed=paint.dirtyMask & visibleMask;
    const visibilityChanged=this.lastInkMask!==visibleMask;
    if (changed && (visibilityChanged || clock-this.inkTime>(this.ultralite?.085:this.lite?.055:.033) || clock<this.inkTime)) {
      const length=paint.layerSize*4, stride=paint.w*4;
      for (let layer=0;layer<paint.layers;layer++) {
        if (!(changed & (1<<layer))) continue;
        // Only the rows that changed since the last upload are sent.
        const first=paint.dirtyRows?paint.dirtyRows[layer*2]:0, last=paint.dirtyRows?paint.dirtyRows[layer*2+1]:paint.h-1;
        if (last<first) continue;
        const start=layer*length+first*stride, rows=last-first+1;
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,first,layer,paint.w,rows,1,gl.RGBA,gl.UNSIGNED_BYTE,
          paint.pixels.subarray(start,start+rows*stride));
      }
      paint.dirtyMask&=~changed;
      paint.clearRows?.(changed);
      this.inkTime=clock;
    }
    this.lastInkMask=visibleMask;
    if (this.envTexture && outdoor && (Math.abs(clock-this.envClock)>20 || Math.abs((this.bossRage??0)-(this.envBossRage??0))>.08 || Math.abs((this.rainLevel??0)-(this.envRainLevel??0))>.08)) this.renderEnv(clock);
    if (this.reflections) {
      const reflected=([x,y,z])=>[x,-y,z];
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorBuffer);
      this.pass(mirrorW,mirrorH,reflected(direction),reflected(right),reflected(up),
        [camera.eye[0],.012-camera.eye[1],camera.eye[2]],multiply(this.vp,this.mirrorMatrix),paint,clock,true);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.hdr?(this.post.msaa??this.post.resolve):null);
    this.pass(w,h,direction,right,up,camera.eye,this.vp,paint,clock,false);
    if (this.hdr) this.runPost(w,h,clock);
    gl.bindVertexArray(null);
    this._boundVao=null;
  }

  // Dedicated planar reflection pass: Analytic Horizon Scissor + Reflected CPU Hi-Z
  // Occlusion + Baked Non-Instanced 2-MRT Deferred G-Buffer + single-draw DynStream dynamics.
  mirrorPass(w,h,direction,right,up,eye,vp) {
    const gl=this.gl;
    const planes=frustumInto(vp,this._mirrorPlanes);
    const settings=MIRROR_DRAW;
    const shadowBatches=this.shadowBatches;
    const maxRow=Math.min(h,this._mirrorMaxRow||h);
    const useScissor=maxRow>0 && maxRow<h;
    const useOcc=!!this.occluder;
    if (useOcc) this.occluder.build(vp,eye,planes,true,.04);
    if (useScissor) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0,0,w,maxRow);
    }
    if (this.mirrorDeferred && this.ensureDeferredMirrorShaders()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorGBuffer);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1]);
      gl.viewport(0,0,w,h);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.BLEND);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT);
      this._boundVao=null;
      const mdAll=this.meshData;
      // Sub-pass 1A: flat baked solids strictly above mirror plane (2-MOV fragment, zero discard).
      gl.useProgram(this.gbufBakedMirrorFlat);
      gl.uniformMatrix4fv(this.ugbmfl.uVP,false,vp);
      for (let i=0;i<shadowBatches.length;i++) {
        const {pair,shFlat}=shadowBatches[i];
        if (!shFlat) continue;
        const sb=pair.static;
        if (sb.bakedMirror) this.drawBakedStatic(sb,sb.bakedMirror,'bmStart','bmCount',planes,eye,settings,'mirrorOpaque',useOcc);
        else this.drawBakedStatic(sb,sb.bakedFlat,'bfStart','bfCount',planes,eye,settings,'mirrorOpaque',useOcc);
      }
      // Sub-pass 1B: curved baked proxies (orb/mantle) strictly above mirror plane.
      gl.useProgram(this.gbufBakedMirrorArch);
      gl.uniformMatrix4fv(this.ugbma.uVP,false,vp);
      for (let i=0;i<shadowBatches.length;i++) {
        const {pair,shFlat}=shadowBatches[i];
        if (shFlat) continue;
        const sb=pair.static;
        this.drawBakedStatic(sb,sb.bakedMirror,'bmStart','bmCount',planes,eye,settings,'mirrorOpaque',useOcc);
      }
      // Sub-pass 2A: flat straddling static + single-draw streamed flat dynamics (CPU-culled below y=.037).
      gl.useProgram(this.gbufBakedMirrorFlatClip);
      gl.uniformMatrix4fv(this.ugbmflc.uVP,false,vp);
      const stFlat=this._dynFlat;
      stFlat.reset();
      for (let i=0;i<shadowBatches.length;i++) {
        const {type,pair,shFlat}=shadowBatches[i];
        if (!shFlat) continue;
        const sb=pair.static;
        if (sb.bakedMirror) this.drawBakedStatic(sb,sb.bakedMirror,'bmStart','bmCount',planes,eye,settings,'mirrorClip',useOcc);
        else this.drawBakedStatic(sb,sb.bakedFlat,'bfStart','bfCount',planes,eye,settings,'mirrorClip',useOcc);
        const mSh=mdAll[type].sh;
        if (pair.dynamic.count) stFlat.appendFlat(mSh,pair.dynamic.data,pair.dynamic.count,.037);
        if (pair.dynamicLo.count) stFlat.appendFlat(mSh,pair.dynamicLo.data,pair.dynamicLo.count,.037);
        if (pair.archDynamic.count) stFlat.appendFlat(mSh,pair.archDynamic.data,pair.archDynamic.count,.037);
        if (pair.archDynamicLo.count) stFlat.appendFlat(mSh,pair.archDynamicLo.data,pair.archDynamicLo.count,.037);
        if (pair.dynamicShadow.count) stFlat.appendFlat(mSh,pair.dynamicShadow.data,pair.dynamicShadow.count,.037);
      }
      if (stFlat.iCount) {stFlat.flush(); this._boundVao=stFlat.vao;}
      // Sub-pass 2B: curved straddling static + single-draw streamed octahedron dynamics.
      gl.useProgram(this.gbufBakedMirrorArchClip);
      gl.uniformMatrix4fv(this.ugbmac.uVP,false,vp);
      const stCurv=this._dynCurved;
      stCurv.reset();
      for (let i=0;i<shadowBatches.length;i++) {
        const {type,pair,shFlat}=shadowBatches[i];
        if (shFlat) continue;
        const sb=pair.static;
        this.drawBakedStatic(sb,sb.bakedMirror,'bmStart','bmCount',planes,eye,settings,'mirrorClip',useOcc);
        const mSh=mdAll[type].sh;
        if (pair.dynamic.count) stCurv.appendCurved(mSh,pair.dynamic.data,pair.dynamic.count,.037);
        if (pair.dynamicLo.count) stCurv.appendCurved(mSh,pair.dynamicLo.data,pair.dynamicLo.count,.037);
        if (pair.archDynamic.count) stCurv.appendCurved(mSh,pair.archDynamic.data,pair.archDynamic.count,.037);
        if (pair.archDynamicLo.count) stCurv.appendCurved(mSh,pair.archDynamicLo.data,pair.archDynamicLo.count,.037);
        if (pair.dynamicShadow.count) stCurv.appendCurved(mSh,pair.dynamicShadow.data,pair.dynamicShadow.count,.037);
      }
      if (stCurv.iCount) {stCurv.flush(); this._boundVao=stCurv.vao;}
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      // Single fullscreen deferred mirror lighting + sky pass into color-only mirrorBuffer.
      gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorBuffer);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      gl.activeTexture(gl.TEXTURE0+UNIT.postA);
      gl.bindTexture(gl.TEXTURE_2D,this.mirrorDepthTex);
      gl.activeTexture(gl.TEXTURE0+UNIT.postB);
      gl.bindTexture(gl.TEXTURE_2D,this.mirrorG0);
      gl.activeTexture(gl.TEXTURE0+UNIT.postC);
      gl.bindTexture(gl.TEXTURE_2D,this.mirrorG1);
      gl.activeTexture(gl.TEXTURE0+UNIT.env);
      gl.bindTexture(gl.TEXTURE_2D,this.envTexture);
      const useSurf=this.surfaceSheets>0 && this.ensureDeferredMirrorSurfaceShader();
      gl.useProgram(useSurf?this.deferredMirror:this.deferredMirrorProc);
      const u=useSurf?this.udm:this.udmp, f=Math.tan(FOV/2);
      gl.uniform3fv(u.uForward,direction);
      gl.uniform3fv(u.uRight,right);
      gl.uniform3fv(u.uUp,up);
      gl.uniform2f(u.uField,f*(this._lastAspect||w/h),f);
      gl.uniform2fv(u.uDepthAB,DEPTH_AB);
      gl.uniform3fv(u.uEye,eye);
      gl.uniform3fv(u.uSun,SUN);
      gl.uniform3fv(u.uSunColor,this._sunColor);
      gl.uniform1f(u.uMirrorExpH0,Math.exp(-.022*eye[1]));
      this.bindEnvSH(u);
      if (useSurf) this.bindSurfaces(u,this.surfaceSheets);
      gl.bindVertexArray(this.empty);
      this._boundVao=null;
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.activeTexture(gl.TEXTURE0+UNIT.postA);
      gl.bindTexture(gl.TEXTURE_2D,null);
      gl.activeTexture(gl.TEXTURE0+UNIT.postB);
      gl.bindTexture(gl.TEXTURE_2D,null);
      gl.activeTexture(gl.TEXTURE0+UNIT.postC);
      gl.bindTexture(gl.TEXTURE_2D,null);
      gl.depthMask(true);
      gl.cullFace(gl.BACK);
      if (useScissor) gl.disable(gl.SCISSOR_TEST);
      return;
    }
    this.ensureMirrorShaders();
    gl.viewport(0,0,w,h);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clearColor(.052,.058,.055,0);
    gl.clear(gl.DEPTH_BUFFER_BIT|gl.COLOR_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.activeTexture(gl.TEXTURE0+UNIT.env);
    gl.bindTexture(gl.TEXTURE_2D,this.envTexture);
    this._boundVao=null;
    const setCommon=(prog,u)=>{
      gl.useProgram(prog);
      gl.uniformMatrix4fv(u.uVP,false,vp);
      gl.uniform1f(u.uDrawOffset,0);
      gl.uniform1i(u.uMergeStairs,0);
      gl.uniform3fv(u.uEye,eye);
      gl.uniform3fv(u.uSun,SUN);
      gl.uniform3fv(u.uSunColor,this._sunColor);
      gl.uniform1f(u.uEnvLod,8);
      this.bindEnvSH(u);
      this.bindSurfaces(u,this.surfaceSheets);
    };
    setCommon(this.sceneMirrorOpaque,this.umo);
    for (let i=0;i<shadowBatches.length;i++) {
      const {type,pair}=shadowBatches[i];
      this.drawStatic(type,pair.static,planes,eye,0,settings,'mirrorOpaque',null,useOcc,true);
    }
    setCommon(this.sceneMirror,this.um);
    for (let i=0;i<shadowBatches.length;i++) {
      const {type,pair}=shadowBatches[i];
      this.drawStatic(type,pair.static,planes,eye,0,settings,'mirrorClip',null,useOcc,true);
      this.drawDynamicShadow(type,pair.dynamic);
      this.drawDynamicShadow(type,pair.dynamicLo);
      this.drawDynamicShadow(type,pair.archDynamic);
      this.drawDynamicShadow(type,pair.archDynamicLo);
      this.drawDynamicShadow(type,pair.dynamicShadow);
    }
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.useProgram(this.skyMirror);
    const f=Math.tan(FOV/2), s=this.sm;
    gl.uniform3fv(s.uRight,right);
    gl.uniform3fv(s.uUp,up);
    gl.uniform3fv(s.uForward,direction);
    gl.uniform2f(s.uField,f*(this._lastAspect||w/h),f);
    gl.bindVertexArray(this.empty);
    this._boundVao=null;
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.depthMask(true);
    gl.cullFace(gl.BACK);
    if (useScissor) gl.disable(gl.SCISSOR_TEST);
  }

  // Single-Pass Branch-Coherent 3-MRT Deferred Outdoor PBR + Sky Pipeline:
  // Rasterizes baked non-instanced static VBOs and single-draw streamed dynamic VBOs
  // into compact G-Buffers, evaluates Sky + Arch + Full PBR in one coherent pass
  // (analytic vRay, conservative uInkActiveBox culling, pre-biased 3x4 affine shadows),
  // then draws dedicated lean Cutout (Stage 2) & Alpha (Stage 4) passes against post.depth.
  deferredOutdoorPass(w,h,direction,right,up,eye,vp,paint,clock,planes,settings,useOcc) {
    const gl=this.gl, post=this.post;
    const cascades=this.effects?this.cascades:[];
    const hasC0=!!cascades[0], hasC1=!!cascades[1];
    if (hasC0) biasOrthoShadowInto(cascades[0].matrix,this._shadowBias0);
    if (hasC1) biasOrthoShadowInto(cascades[1].matrix,this._shadowBias1);
    const rain=this.rainLevel??0;
    const fogFall=mix(.022,.004,rain), fogDens=mix(.0021,.072,rain);
    const fogExpH0=Math.exp(-fogFall*eye[1]);
    const far=this.options?.drawDistance ?? Infinity;
    const drawFar=this.overview || !Number.isFinite(far)?0:far;
    const wetLvl=Math.max(this.wetLevel??0,this.raytrace?.24:0);
    const bossRage=this.bossRage??0;
    const f=Math.tan(FOV/2), fx=f*w/h, pixStep=2*f/h;
    const st0=1/(cascades[0]?.size||1), st1=1/(cascades[1]?.size||1);
    const tw0=cascades[0]?.texel||0, tw1=cascades[1]?.texel||0;
    const ab=paint.activeBox;
    const hasInkBox=ab && ab[0]<=ab[1];
    const inkMinX=ab?(hasInkBox?ab[0]:1e6):-1e6, inkMaxX=ab?(hasInkBox?ab[1]:-1e6):1e6;
    const inkMinZ=ab?(hasInkBox?ab[2]:1e6):-1e6, inkMaxZ=ab?(hasInkBox?ab[3]:-1e6):1e6;
    const mdAll=this.meshData;

    // Step 1: 3-MRT G-Buffer Geometry Pass (baked non-instanced static + single-draw DynStream).
    gl.bindFramebuffer(gl.FRAMEBUFFER,post.gBuffer);
    gl.viewport(0,0,w,h);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1,gl.NONE]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this._boundVao=null;

    // 1A-Flat: Baked static box/ramp/bevelLo/softLo + streamed flat dynamics + static tri (2-MOV fragment).
    gl.useProgram(this.gbufBakedFlat);
    gl.uniformMatrix4fv(this.ugbfl.uVP,false,vp);
    const archFlat=this.archFlatBatches, stFlat=this._dynFlat;
    stFlat.reset();
    for (let i=0;i<archFlat.length;i++) {
      const {type,pair}=archFlat[i], sb=pair.static, md=mdAll[type];
      this.drawBakedStaticPair(sb,sb.bakedFlat,'bfStart','bfCount',planes,eye,settings,'archHi','archLo',useOcc);
      if (pair.archDynamic.count) stFlat.appendFlat(md.hi,pair.archDynamic.data,pair.archDynamic.count);
      if (pair.archDynamicLo.count) stFlat.appendFlat(md.lo,pair.archDynamicLo.data,pair.archDynamicLo.count);
      if (pair.archVfx.count) stFlat.appendFlat(md.hi,pair.archVfx.data,pair.archVfx.count);
      if (pair.archVfxLo.count) stFlat.appendFlat(md.lo,pair.archVfxLo.data,pair.archVfxLo.count);
    }
    const archCurved=this.archCurvedBatches;
    for (let i=0;i<archCurved.length;i++) {
      const {type,pair,isFlatLo,isBevel}=archCurved[i];
      if (!isFlatLo) continue;
      const sb=pair.static, lodDist=isBevel?(settings.bevelLodDist??settings.lodDist):settings.lodDist, lodDist2=lodDist*lodDist;
      this.drawBakedStaticPair(sb,sb.bakedFlat,'bfStart','bfCount',planes,eye,settings,'archHi','archLo',useOcc,2,lodDist2);
      const mLo=mdAll[type].lo;
      if (pair.archDynamicLo.count) stFlat.appendFlat(mLo,pair.archDynamicLo.data,pair.archDynamicLo.count);
      if (pair.archVfxLo.count) stFlat.appendFlat(mLo,pair.archVfxLo.data,pair.archVfxLo.count);
    }
    if (stFlat.iCount) {stFlat.flush(); this._boundVao=stFlat.vao;}
    const triBatch=this.batches.tri?.static;
    if (triBatch?.count) {
      gl.disable(gl.CULL_FACE);
      this.drawBakedStaticPair(triBatch,triBatch.bakedFlat,'bfStart','bfCount',planes,eye,settings,'archHi','archLo',useOcc);
      gl.enable(gl.CULL_FACE);
    }

    // 1A-Curved: Baked smooth curved static + single-draw streamed curved dynamics -> G0 + G1.
    gl.useProgram(this.gbufBakedArch);
    gl.uniformMatrix4fv(this.ugba.uVP,false,vp);
    const stCurv=this._dynCurved;
    stCurv.reset();
    for (let i=0;i<archCurved.length;i++) {
      const {type,pair,isFlatLo,isBevel}=archCurved[i], sb=pair.static, md=mdAll[type];
      if (isFlatLo) {
        const lodDist=isBevel?(settings.bevelLodDist??settings.lodDist):settings.lodDist, lodDist2=lodDist*lodDist;
        this.drawBakedStaticPair(sb,sb.bakedCurvedHi,'bhiStart','bhiCount',planes,eye,settings,'archHi','archLo',useOcc,1,lodDist2);
        if (pair.archDynamic.count) stCurv.appendCurved(md.hi,pair.archDynamic.data,pair.archDynamic.count);
        if (pair.archVfx.count) stCurv.appendCurved(md.hi,pair.archVfx.data,pair.archVfx.count);
      } else {
        this.drawBakedLOD(type,sb,planes,eye,settings,'archHi',useOcc);
        this.drawBakedLOD(type,sb,planes,eye,settings,'archLo',useOcc);
        if (pair.archDynamic.count) stCurv.appendCurved(md.hi,pair.archDynamic.data,pair.archDynamic.count);
        if (pair.archDynamicLo.count) stCurv.appendCurved(md.lo,pair.archDynamicLo.data,pair.archDynamicLo.count);
        if (pair.archVfx.count) stCurv.appendCurved(md.hi,pair.archVfx.data,pair.archVfx.count);
        if (pair.archVfxLo.count) stCurv.appendCurved(md.lo,pair.archVfxLo.data,pair.archVfxLo.count);
      }
    }
    if (stCurv.iCount) {stCurv.flush(); this._boundVao=stCurv.vao;}

    // 1B: Complex facades, windows, roads, stairs, wood, boss -> G0 + G1 + G2.
    gl.drawBuffers([gl.COLOR_ATTACHMENT0,gl.COLOR_ATTACHMENT1,gl.COLOR_ATTACHMENT2]);
    gl.useProgram(this.gbufBakedFull);
    gl.uniformMatrix4fv(this.ugbfull.uVP,false,vp);
    const closedFlat=this.closedFlatBatches;
    let hasDynFullFlat=false;
    for (let i=0;i<closedFlat.length;i++) {
      const {pair}=closedFlat[i], sb=pair.static;
      if (sb.bakedFull) {
        this.drawBakedStaticPair(sb,sb.bakedFull,'bfullStart','bfullCount',planes,eye,settings,'fullHi','fullLo',useOcc);
      }
      if (pair.dynamic.count || pair.dynamicLo.count) hasDynFullFlat=true;
    }
    if (hasDynFullFlat) {
      gl.useProgram(this.gbufFullFlat);
      gl.uniformMatrix4fv(this.ugffl.uVP,false,vp);
      gl.uniform1f(this.ugffl.uDrawOffset,0);
      gl.uniform1i(this.ugffl.uMergeStairs,0);
      let lastShape=-1;
      for (let i=0;i<closedFlat.length;i++) {
        const {type,pair,shapeId}=closedFlat[i];
        if (!pair.dynamic.count && !pair.dynamicLo.count) continue;
        if (shapeId!==lastShape) {gl.uniform1i(this.ugffl.uShape,shapeId); lastShape=shapeId;}
        if (pair.dynamic.count) this.drawDynamic(type,pair.dynamic,false,this.ugffl.uShape);
        if (pair.dynamicLo.count) this.drawDynamic(type,pair.dynamicLo,true,this.ugffl.uShape);
      }
    }
    gl.useProgram(this.gbufFull);
    gl.uniformMatrix4fv(this.ugf.uVP,false,vp);
    gl.uniform1f(this.ugf.uDrawOffset,0);
    gl.uniform1i(this.ugf.uMergeStairs,0);
    const closedCurved=this.closedCurvedBatches;
    let lastShape=-1;
    for (let i=0;i<closedCurved.length;i++) {
      const {type,pair,shapeId,isBevel}=closedCurved[i];
      const sb=pair.static, bk=sb.buckets;
      const hasHi=sb.count && bk && bk.fullHi.length;
      const hasLo=sb.count && bk && bk.fullLo.length;
      if (!hasHi && !hasLo && !pair.dynamic.count && !pair.dynamicLo.count) continue;
      if (shapeId!==lastShape || isBevel) {gl.uniform1i(this.ugf.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
      if (hasHi) this.drawStatic(type,sb,planes,eye,0,settings,'fullHi',this.ugf.uShape,useOcc);
      if (hasLo) this.drawStatic(type,sb,planes,eye,0,settings,'fullLo',this.ugf.uShape,useOcc);
      if (pair.dynamic.count) this.drawDynamic(type,pair.dynamic,false,this.ugf.uShape);
      if (pair.dynamicLo.count) this.drawDynamic(type,pair.dynamicLo,true,this.ugf.uShape);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    const useSurf=this.surfaceSheets>0 && this.ensureDeferredSurfaceShaders();

    // Step 2: Single-pass branch-coherent Deferred Lighting + Sky into post.colorOnly.
    gl.bindFramebuffer(gl.FRAMEBUFFER,post.colorOnly);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.activeTexture(gl.TEXTURE0+UNIT.postA);
    gl.bindTexture(gl.TEXTURE_2D,post.depth);
    gl.activeTexture(gl.TEXTURE0+UNIT.postB);
    gl.bindTexture(gl.TEXTURE_2D,post.g0);
    gl.activeTexture(gl.TEXTURE0+UNIT.postC);
    gl.bindTexture(gl.TEXTURE_2D,post.g1);
    gl.activeTexture(gl.TEXTURE0+UNIT.sheet);
    gl.bindTexture(gl.TEXTURE_2D,post.g2);
    gl.useProgram(useSurf?this.deferredOutdoor:this.deferredOutdoorProc);
    const u=useSurf?this.udo:this.udop;
    gl.uniform3fv(u.uForward,direction);
    gl.uniform3fv(u.uRight,right);
    gl.uniform3fv(u.uUp,up);
    gl.uniform2f(u.uField,fx,f);
    gl.uniform2fv(u.uDepthAB,DEPTH_AB);
    gl.uniform3f(u.uEye,eye[0],eye[1],eye[2]);
    gl.uniform1f(u.uPixelStep,pixStep);
    gl.uniform3fv(u.uSun,SUN);
    gl.uniform3fv(u.uSunColor,this._sunColor);
    gl.uniform1i(u.uShadowOn,this.effects?1:0);
    gl.uniform1i(u.uCascades,cascades.length);
    if (hasC0) gl.uniformMatrix4fv(u.uShadowM0,false,this._shadowBias0);
    if (hasC1) gl.uniformMatrix4fv(u.uShadowM1,false,this._shadowBias1);
    gl.uniform4f(u.uShadowTexel,st0,st1,tw0,tw1);
    gl.uniform2f(u.uInkTexel,1/paint.w,1/paint.h);
    gl.uniform2f(u.uInkBounds,paint.boundX,paint.boundZ);
    gl.uniform4f(u.uInkActiveBox,inkMinX,inkMaxX,inkMinZ,inkMaxZ);
    gl.uniform1f(u.uEnvLod,8);
    gl.uniform1i(u.uReflectOn,this.reflections?1:0);
    gl.uniform2f(u.uViewport,w,h);
    gl.uniform1f(u.uClock,clock);
    gl.uniform4f(u.uFogParams,fogFall,fogDens,fogExpH0,drawFar);
    gl.uniform1f(u.uRaytrace,this.raytrace?1:0);
    gl.uniform1f(u.uWetLevel,wetLvl);
    gl.uniform1f(u.uBossRage,bossRage);
    gl.uniform1f(u.uRainLevel,rain);
    this.bindEnvSH(u);
    if (useSurf) this.bindSurfaces(u,this.surfaceSheets);
    gl.bindVertexArray(this.empty);
    this._boundVao=null;
    gl.drawArrays(gl.TRIANGLES,0,3);

    // Unbind G-buffer textures cleanly before attaching post.depth to post.resolve.
    gl.activeTexture(gl.TEXTURE0+UNIT.postA);
    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.activeTexture(gl.TEXTURE0+UNIT.postB);
    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.activeTexture(gl.TEXTURE0+UNIT.postC);
    gl.bindTexture(gl.TEXTURE_2D,null);
    gl.activeTexture(gl.TEXTURE0+UNIT.sheet);
    gl.bindTexture(gl.TEXTURE_2D,null);

    // Step 3: Dedicated lean Stage 2 (cutouts/decals) + Stage 4 (alpha) against populated post.depth.
    gl.bindFramebuffer(gl.FRAMEBUFFER,post.resolve);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    this._archDynHandled=true;
    this._triHandledInArch=true;
    const cutProg=useSurf?this.sceneOutdoorCutout:this.sceneOutdoorCutoutProc;
    const uc=useSurf?this.uoc:this.uocp;
    gl.useProgram(cutProg);
    this.active=uc;
    gl.uniformMatrix4fv(uc.uVP,false,vp);
    gl.uniform3fv(uc.uSun,SUN);
    gl.uniform3fv(uc.uSunColor,this._sunColor);
    gl.uniform1i(uc.uCascades,cascades.length);
    if (hasC0) gl.uniformMatrix4fv(uc.uShadowM0,false,cascades[0].matrix);
    if (hasC1) gl.uniformMatrix4fv(uc.uShadowM1,false,this._shadowBias1);
    gl.uniform4f(uc.uShadowTexel,st0,st1,tw0,tw1);
    gl.uniform2f(uc.uInkTexel,1/paint.w,1/paint.h);
    gl.uniform2f(uc.uInkBounds,paint.boundX,paint.boundZ);
    gl.uniform4f(uc.uInkActiveBox,inkMinX,inkMaxX,inkMinZ,inkMaxZ);
    gl.uniform1f(uc.uEnvLod,8);
    gl.uniform1f(uc.uClock,clock);
    gl.uniform4f(uc.uFogParams,fogFall,fogDens,fogExpH0,drawFar);
    gl.uniform1f(uc.uRaytrace,this.raytrace?1:0);
    gl.uniform1f(uc.uWetLevel,wetLvl);
    gl.uniform1f(uc.uBossRage,bossRage);
    gl.uniform1f(uc.uRainLevel,rain);
    this.bindEnvSH(uc);
    if (useSurf) this.bindSurfaces(uc,this.surfaceSheets);
    this.drawSceneStage(eye,planes,settings,'cutout',useOcc);

    const ua=this.uoa;
    gl.useProgram(this.sceneOutdoorAlpha);
    this.active=ua;
    gl.uniformMatrix4fv(ua.uVP,false,vp);
    gl.uniform3fv(ua.uSun,SUN);
    gl.uniform3fv(ua.uSunColor,this._sunColor);
    gl.uniform1i(ua.uCascades,cascades.length);
    if (hasC0) gl.uniformMatrix4fv(ua.uShadowM0,false,this._shadowBias0);
    if (hasC1) gl.uniformMatrix4fv(ua.uShadowM1,false,this._shadowBias1);
    gl.uniform4f(ua.uShadowTexel,st0,st1,tw0,tw1);
    gl.uniform2f(ua.uAtlasGrid,ATLAS_COLUMNS,ATLAS_ROWS);
    gl.uniform1f(ua.uEnvLod,8);
    gl.uniform1f(ua.uClock,clock);
    gl.uniform4f(ua.uFogParams,fogFall,fogDens,fogExpH0,drawFar);
    gl.uniform1f(ua.uBossRage,bossRage);
    gl.uniform1f(ua.uRainLevel,rain);
    this.bindEnvSH(ua);
    this.drawSceneStage(eye,planes,settings,'alpha',useOcc);
  }

  bindSceneUniforms(u,w,h,vp,paint,clock,hdr) {
    const gl=this.gl;
    gl.uniformMatrix4fv(u.uVP,false,vp);
    gl.uniform3fv(u.uSun,SUN);
    gl.uniform3fv(u.uSunColor,this._sunColor);
    gl.uniform1i(u.uQuality,this.lite?0:2);
    gl.uniform1i(u.uHDR,hdr?1:0);
    gl.uniform1i(u.uMirrorPass,0);
    gl.uniform1f(u.uExposure,this.exposure());
    gl.uniform1f(u.uBossRage,this.bossRage??0);
    gl.uniform1f(u.uRaytrace,this.raytrace?1:0);
    gl.uniform1f(u.uWetLevel,Math.max(this.wetLevel??0,this.raytrace?.24:0));
    gl.uniform1f(u.uRainLevel,this.rainLevel??0);
    const far=this.options?.drawDistance ?? Infinity;
    gl.uniform1f(u.uDrawFar,this.overview || !Number.isFinite(far)?0:far);
    gl.uniform2f(u.uViewport,w,h);
    gl.uniform1f(u.uClock,clock);
    gl.uniform1f(u.uEnvLod,8);
    gl.uniform2f(u.uInkTexel,1/paint.w,1/paint.h);
    gl.uniform2f(u.uInkBounds,paint.boundX,paint.boundZ);
    gl.uniform2f(u.uAtlasGrid,ATLAS_COLUMNS,ATLAS_ROWS);
    gl.uniform1f(u.uUnderX,UNDER_X);
    gl.uniform1f(u.uUnderY,UNDER_Y);
    gl.uniform1f(u.uCabinX,CABIN_X);
    gl.uniform1f(u.uRailCabinX,RAIL_CABIN_X);
    gl.uniform1f(u.uCabinY,CABIN_Y);
    const cascades=this.effects?this.cascades:[];
    gl.uniform1i(u.uCascades,cascades.length);
    if (cascades[0]) gl.uniformMatrix4fv(u.uShadowM0,false,cascades[0].matrix);
    if (cascades[1]) gl.uniformMatrix4fv(u.uShadowM1,false,cascades[1].matrix);
    gl.uniform4f(u.uShadowTexel,1/(cascades[0]?.size||1),1/(cascades[1]?.size||1),cascades[0]?.texel||0,cascades[1]?.texel||0);
    this.bindEnvSH(u);
    this.bindSurfaces(u,this.surfaceSheets);
  }

  bindArchUniforms(u,w,h,vp,eye,paint,hdr) {
    const gl=this.gl;
    gl.uniformMatrix4fv(u.uVP,false,vp);
    gl.uniform1f(u.uDrawOffset,0);
    gl.uniform1i(u.uMergeStairs,0);
    gl.uniform3f(u.uEye,eye[0],eye[1],eye[2]);
    gl.uniform3fv(u.uSun,SUN);
    gl.uniform3fv(u.uSunColor,this._sunColor);
    gl.uniform1i(u.uQuality,this.lite?0:2);
    gl.uniform1i(u.uHDR,hdr?1:0);
    gl.uniform1i(u.uShadowOn,this.effects?1:0);
    gl.uniform1f(u.uExposure,this.exposure());
    gl.uniform1f(u.uBossRage,this.bossRage??0);
    gl.uniform1f(u.uRaytrace,this.raytrace?1:0);
    gl.uniform1f(u.uWetLevel,Math.max(this.wetLevel??0,this.raytrace?.24:0));
    gl.uniform1f(u.uRainLevel,this.rainLevel??0);
    const far=this.options?.drawDistance ?? Infinity;
    gl.uniform1f(u.uDrawFar,this.overview || !Number.isFinite(far)?0:far);
    gl.uniform2f(u.uViewport,w,h);
    gl.uniform1f(u.uEnvLod,8);
    gl.uniform2f(u.uInkTexel,1/paint.w,1/paint.h);
    gl.uniform2f(u.uInkBounds,paint.boundX,paint.boundZ);
    const cascades=this.effects?this.cascades:[];
    gl.uniform1i(u.uCascades,cascades.length);
    if (cascades[0]) gl.uniformMatrix4fv(u.uShadowM0,false,cascades[0].matrix);
    if (cascades[1]) gl.uniformMatrix4fv(u.uShadowM1,false,cascades[1].matrix);
    gl.uniform4f(u.uShadowTexel,1/(cascades[0]?.size||1),1/(cascades[1]?.size||1),cascades[0]?.texel||0,cascades[1]?.texel||0);
    this.bindEnvSH(u);
    this.bindSurfaces(u,this.surfaceSheets);
  }

  bindArchInteriorUniforms(u,w,h,vp,eye,paint,hdr) {
    const gl=this.gl;
    gl.uniformMatrix4fv(u.uVP,false,vp);
    gl.uniform1f(u.uDrawOffset,0);
    gl.uniform1i(u.uMergeStairs,0);
    gl.uniform3f(u.uEye,eye[0],eye[1],eye[2]);
    gl.uniform1i(u.uHDR,hdr?1:0);
    gl.uniform1f(u.uExposure,this.exposure());
    gl.uniform2f(u.uViewport,w,h);
    gl.uniform2f(u.uInkTexel,1/paint.w,1/paint.h);
    gl.uniform2f(u.uInkBounds,paint.boundX,paint.boundZ);
    gl.uniform1f(u.uUnderX,UNDER_X);
    gl.uniform1f(u.uUnderY,UNDER_Y);
    gl.uniform1f(u.uCabinX,CABIN_X);
    gl.uniform1f(u.uRailCabinX,RAIL_CABIN_X);
    gl.uniform1f(u.uCabinY,CABIN_Y);
    this.bindSurfaces(u,this.surfaceSheets);
  }

  drawArchStage(eye,planes,settings,filter,useOcc,drawDyn=false,drawTri=false) {
    const batchKey=ZONE_BATCHES[this.viewZone], archBatches=this.archBatches;
    for (let i=0;i<archBatches.length;i++) {
      const {type,pair}=archBatches[i];
      this.drawStatic(type,pair[batchKey],planes,eye,0,settings,filter,null,useOcc);
      if (drawDyn) {
        if (pair.archDynamic.count) this.drawDynamic(type,pair.archDynamic,this.lite);
        if (pair.archDynamicLo.count) this.drawDynamic(type,pair.archDynamicLo,true);
        if (pair.archVfx.count) this.drawDynamic(type,pair.archVfx,this.lite);
        if (pair.archVfxLo.count) this.drawDynamic(type,pair.archVfxLo,true);
      }
    }
    if (drawTri) {
      const triPair=this.batches.tri;
      const triBatch=triPair?.[batchKey];
      if (triBatch?.count) {
        const gl=this.gl;
        gl.disable(gl.CULL_FACE);
        this.drawStatic('tri',triBatch,planes,eye,0,settings,'archHi',null,useOcc);
        this.drawStatic('tri',triBatch,planes,eye,0,settings,'archLo',null,useOcc);
        gl.enable(gl.CULL_FACE);
      }
    }
  }

  // Selective Occluder Z-Prepass: populates Z with large static occluders
  // (tier >= 2) only. Small props (tier <= 1) and dynamic actors/vehicles skip
  // pre-pass and draw once with LEQUAL so Early-Z rejects hidden props/actors
  // without double vertex submission.
  depthPrepass(eye,planes,vp,settings,useOcc=false) {
    const gl=this.gl, zone=this.viewZone, du=this.du;
    const merged=this.mergeStairs;
    const views=merged?[zone,1-zone]:[zone];
    gl.useProgram(this.depth);
    gl.uniformMatrix4fv(du.uVP,false,vp);
    gl.uniform1i(du.uMergeStairs,merged?1:0);
    gl.colorMask(false,false,false,false);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const closedBatches=this.closedBatches;
    for (let v=0;v<views.length;v++) {
      const level=views[v];
      const offset=ZONES[zone].x-ZONES[level].x;
      const batchKey=ZONE_BATCHES[level];
      gl.uniform1f(du.uDrawOffset,offset);
      for (let i=0;i<closedBatches.length;i++) {
        const {type,pair}=closedBatches[i];
        this.drawStatic(type,pair[batchKey],planes,eye,offset,settings,'opaqueHi',null,useOcc);
      }
    }
    gl.colorMask(true,true,true,true);
  }

  pass(w,h,direction,right,up,eye,vp,paint,clock,mirror) {
    if (mirror) return this.mirrorPass(w,h,direction,right,up,eye,vp);
    const gl=this.gl;
    if (this.lite && this.ensureLiteShaders()) return this.litePass(w,h,direction,right,up,eye,vp,paint,clock);
    const hdr=this.hdr;
    const cascades=this.effects?this.cascades:[];
    gl.activeTexture(gl.TEXTURE0+UNIT.shadow0);
    gl.bindTexture(gl.TEXTURE_2D,cascades[0]?.texture ?? this.dummyDepth);
    gl.activeTexture(gl.TEXTURE0+UNIT.shadow1);
    gl.bindTexture(gl.TEXTURE_2D,cascades[1]?.texture ?? this.dummyDepth);
    gl.activeTexture(gl.TEXTURE0+UNIT.ink);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    gl.activeTexture(gl.TEXTURE0+UNIT.atlas);
    gl.bindTexture(gl.TEXTURE_2D,this.atlas);
    gl.activeTexture(gl.TEXTURE0+UNIT.reflection);
    gl.bindTexture(gl.TEXTURE_2D,!this.reflections ? this.atlas : this.mirrorTexture);
    gl.activeTexture(gl.TEXTURE0+UNIT.env);
    gl.bindTexture(gl.TEXTURE_2D,this.envTexture);
    gl.activeTexture(gl.TEXTURE0+UNIT.detail);
    gl.bindTexture(gl.TEXTURE_2D,this.detail);
    this._boundVao=null;
    const planes=frustumInto(vp,this._planes);
    const settings=this.drawSettings(false);
    const useOcc=this.viewZone===0 && !this.overview && !this.mergeStairs && !!this.occluder;
    if (useOcc) this.occluder.build(vp,eye,planes);
    else if (this.occluder) this.occluder.active=false;
    if (hdr && !this.post.msaa && this.post.gBuffer && this.post.colorOnly &&
        this.viewZone===0 && this.interior<=.001 && !this.mergeStairs && this.ensureDeferredShaders()) {
      return this.deferredOutdoorPass(w,h,direction,right,up,eye,vp,paint,clock,planes,settings,useOcc);
    }
    gl.viewport(0,0,w,h);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    if (hdr) gl.clearColor(.052,.058,.055,0);
    else gl.clearColor(.23,.25,.24,1);
    gl.clear(gl.DEPTH_BUFFER_BIT|gl.COLOR_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // Stage 0: Selective Hi-Z depth pre-pass for large static occluders.
    this.depthPrepass(eye,planes,vp,settings,useOcc);
    // Stage 1: Domain-specialized zero-discard pure-opaque shading.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    if (this.viewZone===0 && this.interior<=.001 && !this.mergeStairs) {
      this._archDynHandled=true;
      this._triHandledInArch=true;
      // Stage 1A: 4-varying outdoor architectural PBR shader (~87% of static solids + dynamic PBR).
      gl.useProgram(this.archOutdoor);
      this.bindArchUniforms(this.ua,w,h,vp,eye,paint,hdr);
      gl.depthMask(false);
      gl.depthFunc(gl.EQUAL);
      this.drawArchStage(eye,planes,settings,'archHi',useOcc,false,false);
      // Stage 1B: Outdoor-specialized full PBR shader for skyscrapers/windows/roads.
      gl.useProgram(this.sceneOutdoorOpaque);
      this.active=this.uoo;
      this.bindSceneUniforms(this.uoo,w,h,vp,paint,clock,hdr);
      this.drawSceneStage(eye,planes,settings,'fullHi',useOcc);
      // Single-submission small props (tier <= 1) & dynamic objects tested against Stage 0 Z.
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'fullLo',useOcc);
      gl.useProgram(this.archOutdoor);
      this.drawArchStage(eye,planes,settings,'archLo',useOcc,true,true);
    } else if (this.interior>=.999 && !this.mergeStairs) {
      this._archDynHandled=false;
      this._triHandledInArch=false;
      this.ensureInteriorShader();
      gl.useProgram(this.archInterior);
      this.bindArchInteriorUniforms(this.uai,w,h,vp,eye,paint,hdr);
      gl.depthMask(false);
      gl.depthFunc(gl.EQUAL);
      this.drawArchStage(eye,planes,settings,'archHi',false,false,false);
      // Remaining static ramps & dynamic actors reuse pre-compiled main shader.
      gl.useProgram(this.scene);
      this.active=this.u;
      this.bindSceneUniforms(this.u,w,h,vp,paint,clock,hdr);
      this.drawSceneStage(eye,planes,settings,'fullHi',false);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'fullLo',false);
      gl.useProgram(this.archInterior);
      this.drawArchStage(eye,planes,settings,'archLo',false,false,false);
    } else {
      this._archDynHandled=false;
      this._triHandledInArch=false;
      this.ensureCombinedOpaqueShader();
      gl.useProgram(this.sceneOpaque);
      this.active=this.uo;
      this.bindSceneUniforms(this.uo,w,h,vp,paint,clock,hdr);
      gl.depthMask(false);
      gl.depthFunc(gl.EQUAL);
      this.drawSceneStage(eye,planes,settings,'opaqueHi',useOcc);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'opaqueLo',useOcc);
    }
    // Stage 2: Cutouts (foliage, road paint, outer disk) & decals (splat, tri).
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.scene);
    this.active=this.u;
    this.bindSceneUniforms(this.u,w,h,vp,paint,clock,hdr);
    this.drawSceneStage(eye,planes,settings,'cutout',useOcc);
    // Stage 3: Sky background (Early-Z skips all occluded geometry pixels).
    gl.disable(gl.CULL_FACE);
    if (this.interior<.995) {
      gl.useProgram(this.sky);
      const f=Math.tan(FOV/2), s=this.s;
      gl.uniform3fv(s.uRight,right);
      gl.uniform3fv(s.uUp,up);
      gl.uniform3fv(s.uForward,direction);
      gl.uniform3fv(s.uSun,SUN);
      gl.uniform2f(s.uField,f*w/h,f);
      gl.uniform1f(s.uClock,clock);
      gl.uniform1f(s.uInterior,this.interior);
      gl.uniform1i(s.uHDR,hdr?1:0);
      gl.uniform2f(s.uViewport,w,h);
      gl.uniform1f(s.uExposure,this.exposure());
      gl.uniform1f(s.uBossRage,this.bossRage??0);
      gl.uniform1f(s.uRainLevel,this.rainLevel??0);
      gl.depthMask(false);
      gl.bindVertexArray(this.empty);
      this._boundVao=null;
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.depthMask(true);
      gl.useProgram(this.scene);
    }
    // Stage 4: Transparent meshes (labels, glass, curtains, ripples, hazards, shade).
    this.drawSceneStage(eye,planes,settings,'alpha',useOcc);
  }

  bindLiteUniforms(u,vp,paint,clock,reach) {
    const gl=this.gl;
    gl.uniformMatrix4fv(u.uVP,false,vp);
    gl.uniform3fv(u.uSun,SUN);
    gl.uniform1f(u.uClock,clock);
    gl.uniform1f(u.uBossRage,this.bossRage??0);
    gl.uniform1f(u.uRainLevel,this.rainLevel??0);
    gl.uniform2f(u.uInkBounds,paint.boundX,paint.boundZ);
    gl.uniform2f(u.uAtlasGrid,ATLAS_COLUMNS,ATLAS_ROWS);
    gl.uniform1f(u.uUnderX,UNDER_X);
    gl.uniform1f(u.uUnderY,UNDER_Y);
    gl.uniform1f(u.uCabinX,CABIN_X);
    gl.uniform1f(u.uRailCabinX,RAIL_CABIN_X);
    gl.uniform1f(u.uCabinY,CABIN_Y);
    gl.uniform3fv(u.uFog,LITE_FOG);
    if (Number.isFinite(reach)) gl.uniform2f(u.uFogRange,reach*.5,reach*.97);
    else gl.uniform2f(u.uFogRange,1e7,2e7);
    // The ultra-light mode keeps flat colours: no texture taps at all.
    this.bindSurfaces(u,this.ultralite?0:this.surfaceSheets);
  }

  // The lightweight frame: CPU Hi-Z + Selective Z-prepass + zero-discard opaque pass.
  litePass(w,h,direction,right,up,eye,vp,paint,clock) {
    const gl=this.gl;
    const settings=this.drawSettings(false);
    const reach=settings.cull;
    gl.viewport(0,0,w,h);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    const r=this.bossRage??0, rain=this.rainLevel??0;
    const skyClear=[
      mix(mix(LITE_FOG[0],.24,rain*.88),.085,r),
      mix(mix(LITE_FOG[1],.28,rain*.88),.018,r),
      mix(mix(LITE_FOG[2],.33,rain*.88),.022,r)
    ];
    gl.clearColor(...(this.interior>.5?[.055,.062,.058]:skyClear),1);
    gl.clear(gl.DEPTH_BUFFER_BIT|gl.COLOR_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0+UNIT.ink);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,this.inkTexture);
    gl.activeTexture(gl.TEXTURE0+UNIT.atlas);
    gl.bindTexture(gl.TEXTURE_2D,this.atlas);
    gl.activeTexture(gl.TEXTURE0+UNIT.detail);
    gl.bindTexture(gl.TEXTURE_2D,this.detail);
    this._boundVao=null;
    const planes=frustumInto(vp,this._planes);
    const useOcc=this.viewZone===0 && !this.overview && !this.mergeStairs && !!this.occluder;
    if (useOcc) this.occluder.build(vp,eye,planes);
    else if (this.occluder) this.occluder.active=false;
    // Stage 0: Selective occluder Z-prepass.
    this.depthPrepass(eye,planes,vp,settings,useOcc);
    // Stage 1: Zero-discard pure-opaque lite shaders (4-varying arch + 6-varying general).
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.depthMask(false);
    gl.depthFunc(gl.EQUAL);
    this._triHandledInArch=false;
    if (this.sceneLiteArch && !this.mergeStairs) {
      this._archDynHandled=true;
      gl.useProgram(this.sceneLiteArch);
      this.bindLiteUniforms(this.ula,vp,paint,clock,reach);
      gl.uniform1f(this.ula.uDrawOffset,0);
      gl.uniform1i(this.ula.uMergeStairs,0);
      gl.uniform3f(this.ula.uEye,eye[0],eye[1],eye[2]);
      this.drawArchStage(eye,planes,settings,'archHi',useOcc,false,false);
      gl.useProgram(this.sceneLiteOpaque);
      this.active=this.ulo;
      this.bindLiteUniforms(this.ulo,vp,paint,clock,reach);
      this.drawSceneStage(eye,planes,settings,'fullHi',useOcc);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'fullLo',useOcc);
      gl.useProgram(this.sceneLiteArch);
      this.drawArchStage(eye,planes,settings,'archLo',useOcc,true,false);
    } else {
      this._archDynHandled=false;
      gl.useProgram(this.sceneLiteOpaque);
      this.active=this.ulo;
      this.bindLiteUniforms(this.ulo,vp,paint,clock,reach);
      this.drawSceneStage(eye,planes,settings,'opaqueHi',useOcc);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'opaqueLo',useOcc);
    }
    // Stage 2: Cutouts & decals.
    gl.useProgram(this.sceneLite);
    this.active=this.ul;
    this.bindLiteUniforms(this.ul,vp,paint,clock,reach);
    this.drawSceneStage(eye,planes,settings,'cutout',useOcc);
    // Stage 3: Sky.
    gl.disable(gl.CULL_FACE);
    if (this.interior<.995) {
      gl.useProgram(this.skyLite);
      const f=Math.tan(FOV/2), s=this.sl;
      gl.uniform3fv(s.uRight,right);
      gl.uniform3fv(s.uUp,up);
      gl.uniform3fv(s.uForward,direction);
      gl.uniform3fv(s.uSun,SUN);
      gl.uniform3fv(s.uFog,LITE_FOG);
      gl.uniform2f(s.uField,f*w/h,f);
      gl.uniform1f(s.uInterior,this.interior);
      gl.uniform1f(s.uBossRage,this.bossRage??0);
      gl.uniform1f(s.uRainLevel,this.rainLevel??0);
      gl.depthMask(false);
      gl.bindVertexArray(this.empty);
      this._boundVao=null;
      gl.drawArrays(gl.TRIANGLES,0,3);
      gl.depthMask(true);
      gl.useProgram(this.sceneLite);
    }
    // Stage 4: Transparents.
    this.drawSceneStage(eye,planes,settings,'alpha',useOcc);
  }

  drawSettings(mirror) {
    const preset=mirror?MIRROR_DRAW:!this.lite?(this.overview?OVERVIEW_DRAW:HIGH_DRAW):this.overview?OVERVIEW_DRAW:this.ultralite?ULTRA_DRAW:LITE_DRAW;
    const far=this.options?.drawDistance ?? Infinity;
    if (mirror || this.overview || !Number.isFinite(far)) return preset;
    // The draw-distance setting replaces the mode's own cut, near or far.
    const cached=this.cullCache;
    if (cached?.preset===preset && cached.far===far) return cached.settings;
    const settings={...preset,cull:far,lodDist:Math.min(preset.lodDist,far*.5),bevelLodDist:Math.min(preset.bevelLodDist,far*.4),
      tierDist:preset.tierDist.map(d=>Math.min(d,far))};
    this.cullCache={preset,far,settings};
    return settings;
  }

  // How far the current mode draws moving things, for callers that cull them.
  get reach() {
    return this.overview?Infinity:this.drawSettings(false).cull;
  }

  drawSceneStage(eye,planes,settings,stage,useOcc=false) {
    const gl=this.gl, zone=this.viewZone, u=this.active ?? this.u;
    const merged=this.mergeStairs;
    const viewCount=merged?2:1;
    gl.uniform1i(u.uMergeStairs,merged?1:0);
    if (stage==='alpha') {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ZERO,gl.ONE);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
    }
    const isHiOpaque=stage==='opaqueHi' || stage==='fullHi';
    const isLoOpaque=stage==='opaqueLo' || stage==='fullLo';
    const list=stage==='alpha'?this.alphaBatches:(isHiOpaque || isLoOpaque)?this.closedBatches:this.nonAlphaBatches;
    let lastShape=-1, cullState=-1;
    const hasShape=!!u.uShape;
    for (let v=0;v<viewCount;v++) {
      const level=v===0?zone:1-zone;
      const dynamicKey=v===0?'dynamic':'adjacent';
      const batchKey=ZONE_BATCHES[level];
      const offset=ZONES[zone].x-ZONES[level].x;
      gl.uniform1f(u.uDrawOffset,offset);
      if (u.uZoneX) gl.uniform1f(u.uZoneX,ZONES[level].x);
      gl.uniform3f(u.uEye,eye[0]-offset,eye[1],eye[2]);
      if (u.uShadowOn) gl.uniform1i(u.uShadowOn,this.effects && level===0?1:0);
      if (u.uReflectOn) gl.uniform1i(u.uReflectOn,this.reflections && level===0?1:0);
      for (let i=0;i<list.length;i++) {
        const {type,pair,closed,shapeId,isBevel}=list[i];
        const staticBatch=pair[batchKey];
        if (stage==='alpha') {
          const dyn=pair[dynamicKey];
          if (!staticBatch.count && !dyn.count) continue;
          if (hasShape && shapeId!==lastShape) {gl.uniform1i(u.uShape,shapeId); lastShape=shapeId;}
          this.drawStatic(type,staticBatch,planes,eye,offset,settings,'all',u.uShape,useOcc);
          this.drawDynamic(type,dyn,this.ultralite,u.uShape);
        } else if (isHiOpaque) {
          const b=staticBatch.buckets?staticBatch.buckets[stage]:staticBatch.chunks;
          if (!staticBatch.count || !b || !b.length) continue;
          if (hasShape && (shapeId!==lastShape || isBevel)) {gl.uniform1i(u.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
          this.drawStatic(type,staticBatch,planes,eye,offset,settings,stage,u.uShape,useOcc);
        } else if (isLoOpaque) {
          const dyn=pair[dynamicKey], dynLo=dynamicKey==='dynamic'?pair.dynamicLo:null;
          const archDyn=(dynamicKey==='dynamic' && !this._archDynHandled)?pair.archDynamic:null;
          const archDynLo=(dynamicKey==='dynamic' && !this._archDynHandled)?pair.archDynamicLo:null;
          const archVfx=(dynamicKey==='dynamic' && !this._archDynHandled)?pair.archVfx:null;
          const archVfxLo=(dynamicKey==='dynamic' && !this._archDynHandled)?pair.archVfxLo:null;
          const b=staticBatch.buckets?staticBatch.buckets[stage]:staticBatch.chunks;
          const hasStatic=staticBatch.count && b && b.length;
          if (!hasStatic && !dyn.count && !(dynLo && dynLo.count) && !(archDyn && archDyn.count) && !(archDynLo && archDynLo.count) &&
              !(archVfx && archVfx.count) && !(archVfxLo && archVfxLo.count)) continue;
          if (hasShape && (shapeId!==lastShape || isBevel)) {gl.uniform1i(u.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
          if (hasStatic) this.drawStatic(type,staticBatch,planes,eye,offset,settings,stage,u.uShape,useOcc);
          if (dyn.count) this.drawDynamic(type,dyn,this.lite,u.uShape);
          if (dynLo && dynLo.count) this.drawDynamic(type,dynLo,true,u.uShape);
          if (archDyn && archDyn.count) this.drawDynamic(type,archDyn,this.lite,u.uShape);
          if (archDynLo && archDynLo.count) this.drawDynamic(type,archDynLo,true,u.uShape);
          if (archVfx && archVfx.count) this.drawDynamic(type,archVfx,this.lite,u.uShape);
          if (archVfxLo && archVfxLo.count) this.drawDynamic(type,archVfxLo,true,u.uShape);
        } else {
          // Cutout chunks of closed meshes + non-closed opaque decals (splat, tri).
          if (closed) {
            const b=staticBatch.buckets?staticBatch.buckets.cutout:staticBatch.chunks;
            if (!staticBatch.count || !b || !b.length) continue;
            if (hasShape && (shapeId!==lastShape || isBevel)) {gl.uniform1i(u.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
            if (cullState!==1) {gl.enable(gl.CULL_FACE); cullState=1;}
            this.drawStatic(type,staticBatch,planes,eye,offset,settings,'cutout',u.uShape,useOcc);
          } else {
            const dyn=pair[dynamicKey];
            if (type==='tri' && this._triHandledInArch && level===0) {
              const bk=staticBatch.buckets;
              const hasRem=staticBatch.count && bk && (bk.fullHi.length || bk.fullLo.length || bk.cutout.length);
              if (!hasRem && !dyn.count) continue;
              if (hasShape && shapeId!==lastShape) {gl.uniform1i(u.uShape,shapeId); lastShape=shapeId;}
              if (cullState!==0) {gl.disable(gl.CULL_FACE); cullState=0;}
              if (hasRem) {
                this.drawStatic(type,staticBatch,planes,eye,offset,settings,'fullHi',u.uShape,useOcc);
                this.drawStatic(type,staticBatch,planes,eye,offset,settings,'fullLo',u.uShape,useOcc);
                this.drawStatic(type,staticBatch,planes,eye,offset,settings,'cutout',u.uShape,useOcc);
              }
              this.drawDynamic(type,dyn,this.lite,u.uShape);
            } else {
              if (!staticBatch.count && !dyn.count) continue;
              if (hasShape && shapeId!==lastShape) {gl.uniform1i(u.uShape,shapeId); lastShape=shapeId;}
              if (cullState!==0) {gl.disable(gl.CULL_FACE); cullState=0;}
              this.drawStatic(type,staticBatch,planes,eye,offset,settings,'all',u.uShape,useOcc);
              this.drawDynamic(type,dyn,this.lite,u.uShape);
            }
          }
        }
      }
    }
    if (stage==='alpha') {
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  project(point) {
    const m = this.vp;
    const [x,y,z] = point;
    const w = m[3]*x+m[7]*y+m[11]*z+m[15];
    if (w < .1) return null;
    return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w*.5+.5,.5-(m[1]*x+m[5]*y+m[9]*z+m[13])/w*.5];
  }
}
