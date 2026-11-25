import {CABIN_X,CABIN_Y,RAIL_CABIN_X,UNDER_X,UNDER_Y,ZONES,interiorBlend,zoneOf} from './layout.js';
import {OccluderCuller} from './occlusion.js';
import {ARCH_INTERIOR_FRAGMENT,ARCH_LITE_FRAGMENT,ARCH_OUTDOOR_FRAGMENT,ARCH_VERTEX,BLUR_FRAGMENT,COMPOSITE_FRAGMENT,DEPTH_VERTEX,DETAIL_FRAGMENT,DOWN_FRAGMENT,ENV_FRAGMENT,
  FULLSCREEN_VERTEX,LITE_FRAGMENT,LITE_SKY_FRAGMENT,LITE_VERTEX,MIRROR_FRAGMENT,MIRROR_SKY_FRAGMENT,SCENE_FRAGMENT,SCENE_VERTEX,SHADOW_FRAGMENT,
  SHADOW_VERTEX,SKY_FRAGMENT,SSAO_FRAGMENT,UP_FRAGMENT} from './render-shaders.js';
import {writeSurfaceSlots} from './surface-solver.js';
import {loadSurfaceSheets,surfaceArray} from './surface-textures.js';
import {SURFACE_COUNT} from './surfaces.js';

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

// Late-morning sun: 43 degrees high, warm, from the south-west.
export const SUN = unit([-0.46, 0.66, 0.50]);
const SUN_RADIANCE = [3.55, 3.22, 2.80];
const UP = [0, 1, 0];
export const STRIDE = 24;
const FOV = 58 * Math.PI / 180;
const NEAR = .12, FAR = 1200;
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
// Static scene chunks: 20 m cells in Morton order partitioned by cutout flag,
// material fast-path class, 4 effective solid-angle tiers, and shadow role.
const CHUNK=20;
const TIER_RADII=[.24,.58,1.45];

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

// Distant chunks and shadow casters swap to these: bevels become plain boxes
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

// Writes one instance record (24 floats) without allocating, including
// pre-solved (slotTop, slotSide, slotBot) packed into a0.w, a1.w, a2.w.
export function packInstance(out,o,x,y,z,w,h,d,tint,kind,opts=EMPTY,shape=0,ensureCCW=false) {
  let r,g,b;
  if (typeof tint==='number') {r=(tint>>16&255)/255;g=(tint>>8&255)/255;b=(tint&255)/255;}
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
    } else if (!pitch) {
      const c1=Math.cos(yaw),s1=Math.sin(yaw);
      ax=c1;ay=0;az=-s1;bx=0;by=1;bz=0;cx=s1;cy=0;cz=c1;
    } else {
      const c1=Math.cos(yaw),s1=Math.sin(yaw),c2=Math.cos(pitch),s2=Math.sin(pitch);
      ax=c1;ay=0;az=-s1;bx=s1*s2;by=c2;bz=c1*s2;cx=s1*c2;cy=-s2;cz=c1*c2;
    }
  }
  out[o]=ax*w;out[o+1]=ay*w;out[o+2]=az*w;out[o+3]=-1;
  out[o+4]=bx*h;out[o+5]=by*h;out[o+6]=bz*h;out[o+7]=-1;
  out[o+8]=cx*d;out[o+9]=cy*d;out[o+10]=cz*d;out[o+11]=-1;
  out[o+12]=x;out[o+13]=y;out[o+14]=z;out[o+15]=1;
  out[o+16]=r;out[o+17]=g;out[o+18]=b;out[o+19]=kind;
  out[o+20]=opts.label??0;out[o+21]=opts.layer??0;out[o+22]=opts.stairDuplicate?1:0;out[o+23]=opts.effect??0;
  writeSurfaceSlots(out,o,shape);
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
    const inv=1/(Math.hypot(a,b,c)||1);
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

function morton(x,z) {
  let key=0;
  for (let bit=0;bit<7;bit++) key|=((x>>bit)&1)<<(2*bit)|((z>>bit)&1)<<(2*bit+1);
  return key;
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

const SCENE_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uShape','uQuality','uHDR','uMirrorPass',
  'uShadowOn','uCascades','uShadowM0','uShadowM1','uShadowTexel','uAtlasGrid','uReflectOn','uViewport','uEnvLod','uClock',
  'uZoneX','uUnderX','uUnderY','uCabinX','uRailCabinX','uCabinY','uInkTexel','uInkBounds','uExposure','uSurfaceSheets','uSurfaceEdge','uDrawFar',
  'uBossRage','uRaytrace','uWetLevel','uRainLevel'];
const ARCH_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uQuality','uHDR','uShadowOn',
  'uCascades','uShadowM0','uShadowM1','uShadowTexel','uInkTexel','uInkBounds','uEnvLod','uViewport','uExposure','uSurfaceSheets','uSurfaceEdge','uDrawFar',
  'uBossRage','uRaytrace','uWetLevel','uRainLevel'];
const ARCH_INTERIOR_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uHDR','uInkTexel','uInkBounds','uUnderX','uUnderY','uCabinX',
  'uRailCabinX','uCabinY','uViewport','uExposure','uSurfaceSheets','uSurfaceEdge'];
const MIRROR_UNIFORMS=['uVP','uDrawOffset','uMergeStairs','uEye','uSun','uSunColor','uEnvLod','uSurfaceSheets','uSurfaceEdge'];
const DEPTH_UNIFORMS=['uVP','uDrawOffset','uMergeStairs'];
const SKY_UNIFORMS=['uRight','uUp','uForward','uSun','uField','uClock','uInterior','uHDR','uViewport','uExposure','uBossRage','uRainLevel'];
const MIRROR_SKY_UNIFORMS=['uRight','uUp','uForward','uField'];
const UNIT={shadow0:0,ink:1,atlas:2,reflection:3,env:4,detail:5,shadow1:6,postA:7,postB:8,postC:9,surface:10,sheet:11,small:12};
const SCENE_SAMPLERS={uShadow0:UNIT.shadow0,uInk:UNIT.ink,uAtlas:UNIT.atlas,uReflection:UNIT.reflection,
  uEnv:UNIT.env,uDetail:UNIT.detail,uShadow1:UNIT.shadow1,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const ARCH_SAMPLERS={uShadow0:UNIT.shadow0,uShadow1:UNIT.shadow1,uInk:UNIT.ink,uEnv:UNIT.env,uDetail:UNIT.detail,
  uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
const ARCH_INTERIOR_SAMPLERS={uDetail:UNIT.detail,uInk:UNIT.ink,uSurface:UNIT.surface,uSurfaceSmall:UNIT.small};
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
const MIRROR_DRAW={lodDist:12,bevelLodDist:8,tierDist:[0,22,85,260],cull:260};
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
    this._lastEye=[0,3,18];
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
    try {
      this.scene = program(gl,SCENE_VERTEX,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1'));
      this.sceneOutdoorOpaque = program(gl,SCENE_VERTEX,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define OPAQUE_PURE 1\n#define OUTDOOR_ONLY 1'));
    } catch (error) {
      // Some older mobile drivers reject very long shaders; drop the room
      // interiors and per-lamp lighting instead of failing to start.
      console.warn('Using the reduced scene shader',error);
      this.scene = program(gl,SCENE_VERTEX,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define SAFE 1'));
      this.sceneOutdoorOpaque = program(gl,SCENE_VERTEX,withDefines(SCENE_FRAGMENT,'#define FAST_SLOT 1\n#define OPAQUE_PURE 1\n#define OUTDOOR_ONLY 1\n#define SAFE 1'));
      this.reducedShader=true;
    }
    this.archOutdoor = program(gl,ARCH_VERTEX,ARCH_OUTDOOR_FRAGMENT);
    this.depth = program(gl,DEPTH_VERTEX,SHADOW_FRAGMENT);
    this.shadow = program(gl,SHADOW_VERTEX,SHADOW_FRAGMENT);
    this.sky = program(gl,FULLSCREEN_VERTEX,SKY_FRAGMENT);
    this.u = uniforms(gl,this.scene,SCENE_UNIFORMS);
    this.uoo = uniforms(gl,this.sceneOutdoorOpaque,SCENE_UNIFORMS);
    this.ua = uniforms(gl,this.archOutdoor,ARCH_UNIFORMS);
    this.du = uniforms(gl,this.depth,DEPTH_UNIFORMS);
    this.s = uniforms(gl,this.sky,SKY_UNIFORMS);
    this.shadowUniform = gl.getUniformLocation(this.shadow,'uLight');
    for (const sh of [this.scene,this.sceneOutdoorOpaque]) {
      surfaceTable(gl,sh);
      samplers(gl,sh,SCENE_SAMPLERS);
    }
    surfaceTable(gl,this.archOutdoor);
    samplers(gl,this.archOutdoor,ARCH_SAMPLERS);
    samplers(gl,this.sky,{uDetail:UNIT.detail});
    // Mirror, interior, stair-transition, and lite shaders compile lazily on first use.
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
    const high=renderMeshes(), low=lodMeshes();
    this.vaos={};
    this.batches={};
    this.batchEntries=[];
    this.shadowBatches=[];
    this.archBatches=[];
    this.closedBatches=[];
    this.alphaBatches=[];
    this.nonAlphaBatches=[];
    for (const name of Object.keys(high)) {
      const vaos={hi:this.makeVAO(high[name]),lo:this.makeVAO(low[name])};
      this.vaos[name]=vaos;
      const pair=Object.fromEntries([...ZONE_BATCHES,'dynamic','dynamicLo','adjacent'].map(key=>[key,
        {data:new Float32Array(key==='dynamic' || key==='dynamicLo' || key==='adjacent'?STRIDE*128:0),length:0,count:0,buffer:gl.createBuffer(),capacity:0,chunks:[],buckets:null}]));
      pair.closed=CULL_MESHES.has(name);
      pair.symmetric=SYMMETRIC_CULL.has(name);
      pair.shapeId=SHAPE_IDS[name]??0;
      pair.isBevel=name==='bevel';
      pair.isAlpha=TRANSPARENT_MESHES.has(name);
      pair.isDecal=DECAL_MESHES.has(name);
      this.batches[name]=pair;
      const entry={type:name,pair,vaos,closed:pair.closed,shapeId:pair.shapeId,isBevel:pair.isBevel,isAlpha:pair.isAlpha,isDecal:pair.isDecal};
      this.batchEntries.push(entry);
      if (!pair.isAlpha && !pair.isDecal) this.shadowBatches.push(entry);
      if (pair.closed) {
        this.closedBatches.push(entry);
        if (name!=='ramp') this.archBatches.push(entry);
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
    const defs='#define FAST_SLOT 1\n#define OPAQUE_PURE 1'+(this.reducedShader?'\n#define SAFE 1':'');
    this.sceneOpaque=program(gl,SCENE_VERTEX,withDefines(SCENE_FRAGMENT,defs));
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
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.envBuffer);
    gl.useProgram(this.envProgram);
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
    this.envClock=clock;
    this.envBossRage=this.bossRage ?? 0;
    this.envRainLevel=this.rainLevel ?? 0;
    return this.envTexture;
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
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return true;
  }

  disableEffects() {
    const gl=this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.bindRenderbuffer(gl.RENDERBUFFER,null);
    this.releaseShadows();
    gl.deleteFramebuffer(this.mirrorBuffer??null);
    gl.deleteTexture(this.mirrorTexture??null);
    gl.deleteRenderbuffer(this.mirrorDepth??null);
    this.mirrorBuffer=this.mirrorTexture=this.mirrorDepth=null;
    this.effectsUnavailable=true;
    return false;
  }

  // Planar reflection for wet asphalt, puddles and liquid ink at street level.
  prepareMirror(width,height) {
    if (this.mirrorUnavailable) return false;
    const gl=this.gl;
    if (!this.mirrorBuffer) {
      this.mirrorBuffer=gl.createFramebuffer();
      this.mirrorTexture=gl.createTexture();
      this.mirrorDepth=gl.createRenderbuffer();
      this.mirrorSize=[0,0];
      this.mirrorMatrix=new Float32Array([1,0,0,0, 0,-1,0,0, 0,0,1,0, 0,.012,0,1]);
    }
    if (this.mirrorSize[0]===width && this.mirrorSize[1]===height) return true;
    gl.activeTexture(gl.TEXTURE0+UNIT.reflection);
    gl.bindTexture(gl.TEXTURE_2D,this.mirrorTexture);
    gl.texImage2D(gl.TEXTURE_2D,0,this.floatTargets?gl.RGBA16F:gl.RGBA8,width,height,0,gl.RGBA,this.floatTargets?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER,this.mirrorDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,width,height);
    gl.bindFramebuffer(gl.FRAMEBUFFER,this.mirrorBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,this.mirrorTexture,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,this.mirrorDepth);
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
        composite:make(COMPOSITE_FRAGMENT),w:0,h:0,targets:[]};
      samplers(gl,post.ssao,{uDepth:UNIT.postA});
      samplers(gl,post.blur,{uAO:UNIT.postA,uDepth:UNIT.postB});
      samplers(gl,post.down,{uSrc:UNIT.postA});
      samplers(gl,post.up,{uSrc:UNIT.postA});
      samplers(gl,post.composite,{uColor:UNIT.postA,uAO:UNIT.postB,uBloom:UNIT.postC,uDepth:UNIT.detail});
      for (const key of ['ssao','blur','down','up','composite']) post[key+'U']=uniforms(gl,post[key],
        ['uInvSize','uProj','uRadius','uIntensity','uStep','uTexel','uFirst','uThreshold','uWeight','uExposure',
          'uBloomStrength','uAOStrength','uTime','uInterior','uAOOn','uBloomOn','uFXAA',
          'uRaytrace','uBossRage','uWetLevel','uRainLevel','uVP','uInvVP','uEye','uSun']);
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
    gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,
      format===gl.DEPTH_COMPONENT24?gl.DEPTH_COMPONENT:format===gl.R8?gl.RED:gl.RGBA,type,null);
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
    if (!post.resolve) return fail();
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
    gl.useProgram(post.composite);
    const u=post.compositeU;
    gl.activeTexture(gl.TEXTURE0+UNIT.postA);
    gl.bindTexture(gl.TEXTURE_2D,post.color);
    gl.activeTexture(gl.TEXTURE0+UNIT.postB);
    gl.bindTexture(gl.TEXTURE_2D,post.aoA);
    gl.activeTexture(gl.TEXTURE0+UNIT.postC);
    gl.bindTexture(gl.TEXTURE_2D,post.bloom[0].texture);
    gl.activeTexture(gl.TEXTURE0+UNIT.detail);
    gl.bindTexture(gl.TEXTURE_2D,post.depth);
    gl.uniform2f(u.uTexel,1/width,1/height);
    gl.uniform1f(u.uExposure,this.exposure());
    gl.uniform1f(u.uBloomStrength,(this.interior>.5?.085:.06)+(this.raytrace?.022:0)+(this.bossRage??0)*.018);
    gl.uniform1f(u.uAOStrength,.92);
    gl.uniform1f(u.uTime,clock);
    gl.uniform1f(u.uInterior,this.interior);
    gl.uniform1i(u.uAOOn,ambient?1:0);
    gl.uniform1i(u.uBloomOn,1);
    gl.uniform1i(u.uFXAA,post.msaa?0:1);
    gl.uniform1f(u.uRaytrace,this.raytrace?1:0);
    gl.uniform1f(u.uBossRage,this.bossRage??0);
    gl.uniform1f(u.uWetLevel,Math.max(this.wetLevel??0,this.raytrace?.24:0));
    gl.uniform1f(u.uRainLevel,this.rainLevel??0);
    if (this.vp) {
      gl.uniformMatrix4fv(u.uVP,false,this.vp);
      gl.uniformMatrix4fv(u.uInvVP,false,invertMat4Into(this.vp,this._invVP));
    }
    gl.uniform3fv(u.uEye,this._lastEye);
    gl.uniform3fv(u.uSun,SUN);
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
      return;
    }
    const vp=multiply(perspective(aspect),view(camera.eye,camera.target));
    frustumInto(vp,this._viewPlanes);
    this._hasViewPlanes=true;
  }

  inFrustum(x,y,z,r=1) {
    if (!this._hasViewPlanes || this.drawingAdjacent || this.overview) return true;
    return sphereInPlanes(this._viewPlanes,x,y,z,r);
  }

  add(type,x,y,z,w,h,d,tint,kind = 0,opts = EMPTY) {
    const pair=this.batches[type];
    if (!pair) return;
    let batch;
    if (opts.dynamic) {
      if (this.drawingAdjacent) batch=pair.adjacent;
      else if (pair.closed) {
        let useLo=this.lite;
        if (!useLo && this.viewPoint) {
          const vp=this.viewPoint;
          const dx=x-vp[0], dy=y-vp[1], dz=z-vp[2];
          if (dx*dx+dy*dy+dz*dz>400) useLo=true;
        }
        batch=useLo?pair.dynamicLo:pair.dynamic;
      } else batch=pair.dynamic;
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
    const len=Math.hypot(dx,dy,dz), invL=1/Math.max(.00001,len);
    const yx=dx*invL, yy=dy*invL, yz=dz*invL;
    let xx,xy,xz;
    if (yz>.93 || yz<-.93) {
      const inv=1/Math.max(.00001,Math.hypot(yz,yy));
      xx=0; xy=yz*inv; xz=-yy*inv;
    } else {
      const inv=1/Math.max(.00001,Math.hypot(yy,yx));
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
    return hidden;
  }

  seal() {
    this.occluder?.clear();
    for (let i=0;i<this.batchEntries.length;i++) {
      const {type,pair}=this.batchEntries[i];
      for (let zone=0;zone<ZONE_BATCHES.length;zone++) this.sealStatic(type,pair[ZONE_BATCHES[zone]],zone);
    }
  }

  // Sorts a static batch into 20 m spatial chunks partitioned by cutout status,
  // occluder-tier band (tier >= 2 vs < 2), architectural fast-path across all
  // zones, effective cross-sectional solid-angle tier and shadow role.
  sealStatic(type,batch,zone) {
    const gl=this.gl, count=batch.length/STRIDE, source=batch.data;
    batch.chunks=[];
    batch.buckets=null;
    batch.count=count;
    if (!count) return;
    const origin=ZONES[zone].x, keys=new Uint32Array(count), radius=new Float32Array(count);
    const order=new Uint32Array(count), isTri=type==='tri', isBox=type==='box';
    const isClosed=CULL_MESHES.has(type), canArch=isClosed && type!=='ramp';
    for (let i=0;i<count;i++) {
      const o=i*STRIDE;
      let r, effR, sx=0, sy=0, sz=0;
      if (isTri) {
        // Triangles span p, p+a0, p+a1 (a2 is the unit surface normal, NOT a spatial extent!).
        const ax=source[o], ay=source[o+1], az=source[o+2];
        const bx=source[o+4], by=source[o+5], bz=source[o+6];
        const cx=(ax+bx)/3, cy=(ay+by)/3, cz=(az+bz)/3;
        const d0=cx*cx+cy*cy+cz*cz;
        const d1=(ax-cx)*(ax-cx)+(ay-cy)*(ay-cy)+(az-cz)*(az-cz);
        const d2=(bx-cx)*(bx-cx)+(by-cy)*(by-cy)+(bz-cz)*(bz-cz);
        r=Math.sqrt(Math.max(d0,d1,d2));
        effR=r;
      } else {
        const a0=source[o], a1=source[o+1], a2=source[o+2];
        const b0=source[o+4], b1=source[o+5], b2=source[o+6];
        const c0=source[o+8], c1=source[o+9], c2=source[o+10];
        const sx2=a0*a0+a1*a1+a2*a2, sy2=b0*b0+b1*b1+b2*b2, sz2=c0*c0+c1*c1+c2*c2;
        sx=Math.sqrt(sx2); sy=Math.sqrt(sy2); sz=Math.sqrt(sz2);
        r=Math.sqrt(sx2+sy2+sz2)*.5;
        // Effective cross-sectional solid-angle radius demotes thin railings,
        // window mullions and wires while preserving full reach for broad walls.
        let a=sx, b=sy, c=sz;
        if (a>b) {const t=a;a=b;b=t;}
        if (b>c) {const t=b;b=c;c=t;}
        if (a>b) {const t=a;a=b;b=t;}
        effR=Math.sqrt(b*Math.min(c,b*14))*.5;
      }
      radius[i]=r;
      const tier=effR<TIER_RADII[0]?0:effR<TIER_RADII[1]?1:effR<TIER_RADII[2]?2:3;
      const kind=Math.round(source[o+19]);
      const cutout=(kind===14 || kind===22 || kind===27)?1:0;
      const archSimple=(canArch && !cutout && (kind===0 || kind===1 || kind===2 || kind===3 || kind===4 || kind===19 || kind===29 || (kind===13 && isBox) || (zone!==0 && kind===15)))?1:0;
      let noShadow=(kind===22 || kind===27)?1:0;
      if (!noShadow && isBox && zone===0) {
        const halfY=(Math.abs(source[o+1])+Math.abs(source[o+5])+Math.abs(source[o+9]))*.5;
        if (source[o+13]+halfY<=.28 && sy<=.32 && (sx>=2 || sz>=2)) noShadow=1;
      }
      if (zone===0 && isBox && !cutout && kind!==8 && kind!==6 && kind!==3 && source[o+22]<=.5) {
        this.occluder?.addBoxFromPacked(source,o);
      }
      const cx=clamp(Math.floor((source[o+12]-origin)/CHUNK)+64,0,127);
      const cz=clamp(Math.floor(source[o+14]/CHUNK)+64,0,127);
      const loTier=tier<2?1:0;
      const subTier=(3-tier)&1;
      // Contiguous key layout: [cutout:1][loTier:1][archSimple:1][subTier:1][noShadow:1][morton:14]
      // Keeps opaqueHi, archHi, fullHi, archLo, fullLo, and cutout each contiguous in VBO memory.
      keys[i]=(cutout<<18)|(loTier<<17)|(archSimple<<16)|(subTier<<15)|(noShadow<<14)|morton(cx,cz);
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
          min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
        batch.chunks.push(chunk);
      }
      chunk.count++;
      const r=radius[i];
      for (let axis=0;axis<3;axis++) {
        const c=source[o+12+axis]+(isTri?(source[o+axis]+source[o+4+axis])/3:0);
        const lo=c-r, hi=c+r;
        if (lo<chunk.min[axis]) chunk.min[axis]=lo;
        if (hi>chunk.max[axis]) chunk.max[axis]=hi;
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

  drawStatic(type,batch,planes,eye,offset,settings,filter='all',shapeLoc=null,useOcc=false) {
    if (!batch.count) return;
    const chunks=batch.buckets?batch.buckets[filter]:batch.chunks;
    if (!chunks || !chunks.length) return;
    const vaos=this.vaos[type];
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
      this.drawRange(lod?vaos.lo:vaos.hi,batch.buffer,start,end-start);
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
      const want=d2>lodDist2?1:0;
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

  drawDynamic(type,batch,low=false,shapeLoc=null) {
    if (!batch.count) return;
    if (type==='bevel' && shapeLoc) this.gl.uniform1i(shapeLoc,low?1:3);
    this.drawRange(low?this.vaos[type].lo:this.vaos[type].hi,batch.buffer,0,batch.count);
  }

  renderShadows(camera) {
    const gl=this.gl;
    const look=[camera.target[0]-camera.eye[0],0,camera.target[2]-camera.eye[2]];
    const ahead=Math.hypot(look[0],look[2])>.001?unit(look):[0,0,-1];
    gl.useProgram(this.shadow);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.15,2);
    this._boundVao=null;
    const shadowBatches=this.shadowBatches;
    for (const [i,cascade] of this.cascades.entries()) {
      if (cascade.matrix && i>0) {
        const moved=Math.hypot(camera.eye[0]-cascade.eyeX,camera.eye[2]-cascade.eyeZ);
        if ((this.frame+i)%cascade.every && moved<3) continue;
      } else if (cascade.matrix && (this.frame+i)%cascade.every) continue;
      cascade.eyeX=camera.eye[0];
      cascade.eyeZ=camera.eye[2];
      const lead=cascade.radius*.58;
      const center=[camera.eye[0]+ahead[0]*lead,clamp(camera.eye[1],0,24)*.35,camera.eye[2]+ahead[2]*lead];
      const lightView=view(add(center,scale(SUN,230)),center);
      lightView[12]=Math.round(lightView[12]/cascade.texel)*cascade.texel;
      lightView[13]=Math.round(lightView[13]/cascade.texel)*cascade.texel;
      cascade.matrix=multiply(ortho(cascade.radius,cascade.radius,1,480),lightView);
      gl.bindFramebuffer(gl.FRAMEBUFFER,cascade.buffer);
      gl.viewport(0,0,cascade.size,cascade.size);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(this.shadowUniform,false,cascade.matrix);
      const planes=frustumInto(cascade.matrix,this._shadowPlanes);
      const settings=i?SHADOW_C1:SHADOW_C0;
      for (let b=0;b<shadowBatches.length;b++) {
        const {type,pair}=shadowBatches[b];
        this.drawStatic(type,pair.static,planes,camera.eye,0,settings,'shadow');
        this.drawDynamic(type,pair.dynamic,true);
        this.drawDynamic(type,pair.dynamicLo,true);
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
    const outdoor=this.viewZone===0 && this.interior<.995;
    // No shadow maps and no mirror pass at all in the lightweight modes.
    this.effects=outdoor && !this.lite && this.prepareEffects();
    // Visibility-gated planar reflections: skip when street-level puddles are
    // not visible (aerial overview, high elevation, or looking up into the sky).
    const needMirror=this.effects && !this.lite && this.options?.reflections!==false &&
      !this.overview && camera.eye[1]<=18 && direction[1]<=.35;
    const mirrorW=Math.max(1,Math.round(w*.35)), mirrorH=Math.max(1,Math.round(h*.35));
    this.reflections=needMirror && this.prepareMirror(mirrorW,mirrorH);
    this.hdr=!this.lite && this.preparePost(w,h);
    if (this.batchEntries) {
      for (let i=0;i<this.batchEntries.length;i++) {
        const pair=this.batchEntries[i].pair;
        this.upload(pair.dynamic);
        this.upload(pair.dynamicLo);
        if (this.mergeStairs) this.upload(pair.adjacent);
        else pair.adjacent.count=0;
      }
    } else for (const pair of Object.values(this.batches)) {
      this.upload(pair.dynamic);
      this.upload(pair.dynamicLo);
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

  // Dedicated ultra-light planar reflection pass (no shadows, no detail/bump
  // maps, no room tracing, single-tap env sky, front-face culled).
  mirrorPass(w,h,direction,right,up,eye,vp) {
    this.ensureMirrorShaders();
    const gl=this.gl;
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
    const planes=frustumInto(vp,this._mirrorPlanes);
    const settings=MIRROR_DRAW;
    const shadowBatches=this.shadowBatches;
    const setCommon=(prog,u)=>{
      gl.useProgram(prog);
      gl.uniformMatrix4fv(u.uVP,false,vp);
      gl.uniform1f(u.uDrawOffset,0);
      gl.uniform1i(u.uMergeStairs,0);
      gl.uniform3fv(u.uEye,eye);
      gl.uniform3fv(u.uSun,SUN);
      gl.uniform3fv(u.uSunColor,this._sunColor);
      gl.uniform1f(u.uEnvLod,8);
      this.bindSurfaces(u,this.surfaceSheets);
    };
    // Sub-pass 1: buildings completely above the mirror plane (zero-discard Early-Z).
    setCommon(this.sceneMirrorOpaque,this.umo);
    for (let i=0;i<shadowBatches.length;i++) {
      const {type,pair}=shadowBatches[i];
      this.drawStatic(type,pair.static,planes,eye,0,settings,'mirrorOpaque');
    }
    // Sub-pass 2: geometry straddling y = 0.037 + dynamic objects.
    setCommon(this.sceneMirror,this.um);
    for (let i=0;i<shadowBatches.length;i++) {
      const {type,pair}=shadowBatches[i];
      this.drawStatic(type,pair.static,planes,eye,0,settings,'mirrorClip');
      this.drawDynamic(type,pair.dynamic,true);
      this.drawDynamic(type,pair.dynamicLo,true);
    }
    // Single-tap pre-baked sky probe.
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.useProgram(this.skyMirror);
    const f=Math.tan(FOV/2), s=this.sm;
    gl.uniform3fv(s.uRight,right);
    gl.uniform3fv(s.uUp,up);
    gl.uniform3fv(s.uForward,direction);
    gl.uniform2f(s.uField,f*w/h,f);
    gl.bindVertexArray(this.empty);
    this._boundVao=null;
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.depthMask(true);
    gl.cullFace(gl.BACK);
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

  drawArchStage(eye,planes,settings,filter,useOcc) {
    const batchKey=ZONE_BATCHES[this.viewZone], archBatches=this.archBatches;
    for (let i=0;i<archBatches.length;i++) {
      const {type,pair}=archBatches[i];
      this.drawStatic(type,pair[batchKey],planes,eye,0,settings,filter,null,useOcc);
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
    gl.viewport(0,0,w,h);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    if (hdr) gl.clearColor(.052,.058,.055,0);
    else gl.clearColor(.23,.25,.24,1);
    gl.clear(gl.DEPTH_BUFFER_BIT|gl.COLOR_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
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
    // Stage 0: Selective Hi-Z depth pre-pass for large static occluders.
    this.depthPrepass(eye,planes,vp,settings,useOcc);
    // Stage 1: Domain-specialized zero-discard pure-opaque shading.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    if (this.viewZone===0 && this.interior<=.001 && !this.mergeStairs) {
      // Stage 1A: 4-varying outdoor architectural PBR shader (~87% of static solids).
      gl.useProgram(this.archOutdoor);
      this.bindArchUniforms(this.ua,w,h,vp,eye,paint,hdr);
      gl.depthMask(false);
      gl.depthFunc(gl.EQUAL);
      this.drawArchStage(eye,planes,settings,'archHi',useOcc);
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
      this.drawArchStage(eye,planes,settings,'archLo',useOcc);
    } else if (this.interior>=.999 && !this.mergeStairs) {
      this.ensureInteriorShader();
      gl.useProgram(this.archInterior);
      this.bindArchInteriorUniforms(this.uai,w,h,vp,eye,paint,hdr);
      gl.depthMask(false);
      gl.depthFunc(gl.EQUAL);
      this.drawArchStage(eye,planes,settings,'archHi',false);
      // Remaining ~0.5% static ramps & dynamic actors reuse pre-compiled main shader.
      gl.useProgram(this.scene);
      this.active=this.u;
      this.bindSceneUniforms(this.u,w,h,vp,paint,clock,hdr);
      this.drawSceneStage(eye,planes,settings,'fullHi',false);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'fullLo',false);
      gl.useProgram(this.archInterior);
      this.drawArchStage(eye,planes,settings,'archLo',false);
    } else {
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
    if (this.sceneLiteArch && !this.mergeStairs) {
      gl.useProgram(this.sceneLiteArch);
      this.bindLiteUniforms(this.ula,vp,paint,clock,reach);
      gl.uniform1f(this.ula.uDrawOffset,0);
      gl.uniform1i(this.ula.uMergeStairs,0);
      gl.uniform3f(this.ula.uEye,eye[0],eye[1],eye[2]);
      this.drawArchStage(eye,planes,settings,'archHi',useOcc);
      gl.useProgram(this.sceneLiteOpaque);
      this.active=this.ulo;
      this.bindLiteUniforms(this.ulo,vp,paint,clock,reach);
      this.drawSceneStage(eye,planes,settings,'fullHi',useOcc);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      this.drawSceneStage(eye,planes,settings,'fullLo',useOcc);
      gl.useProgram(this.sceneLiteArch);
      this.drawArchStage(eye,planes,settings,'archLo',useOcc);
    } else {
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
          if (shapeId!==lastShape) {gl.uniform1i(u.uShape,shapeId); lastShape=shapeId;}
          this.drawStatic(type,staticBatch,planes,eye,offset,settings,'all',u.uShape,useOcc);
          this.drawDynamic(type,dyn,this.ultralite,u.uShape);
        } else if (isHiOpaque) {
          const b=staticBatch.buckets?staticBatch.buckets[stage]:staticBatch.chunks;
          if (!staticBatch.count || !b || !b.length) continue;
          if (shapeId!==lastShape || isBevel) {gl.uniform1i(u.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
          this.drawStatic(type,staticBatch,planes,eye,offset,settings,stage,u.uShape,useOcc);
        } else if (isLoOpaque) {
          const dyn=pair[dynamicKey], dynLo=dynamicKey==='dynamic'?pair.dynamicLo:null;
          const b=staticBatch.buckets?staticBatch.buckets[stage]:staticBatch.chunks;
          const hasStatic=staticBatch.count && b && b.length;
          if (!hasStatic && !dyn.count && !(dynLo && dynLo.count)) continue;
          if (shapeId!==lastShape || isBevel) {gl.uniform1i(u.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
          if (hasStatic) this.drawStatic(type,staticBatch,planes,eye,offset,settings,stage,u.uShape,useOcc);
          if (dyn.count) this.drawDynamic(type,dyn,this.lite,u.uShape);
          if (dynLo && dynLo.count) this.drawDynamic(type,dynLo,true,u.uShape);
        } else {
          // Cutout chunks of closed meshes + non-closed opaque decals (splat, tri).
          if (closed) {
            const b=staticBatch.buckets?staticBatch.buckets.cutout:staticBatch.chunks;
            if (!staticBatch.count || !b || !b.length) continue;
            if (shapeId!==lastShape || isBevel) {gl.uniform1i(u.uShape,shapeId); lastShape=isBevel?-1:shapeId;}
            if (cullState!==1) {gl.enable(gl.CULL_FACE); cullState=1;}
            this.drawStatic(type,staticBatch,planes,eye,offset,settings,'cutout',u.uShape,useOcc);
          } else {
            const dyn=pair[dynamicKey];
            if (!staticBatch.count && !dyn.count) continue;
            if (shapeId!==lastShape) {gl.uniform1i(u.uShape,shapeId); lastShape=shapeId;}
            if (cullState!==0) {gl.disable(gl.CULL_FACE); cullState=0;}
            this.drawStatic(type,staticBatch,planes,eye,offset,settings,'all',u.uShape,useOcc);
            this.drawDynamic(type,dyn,this.lite,u.uShape);
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
