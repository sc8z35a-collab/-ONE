// Loads the texture sheets (see surfaces.js) into two texture arrays: one for
// large surfaces and a smaller one for small parts. Each sheet image is cut
// into its nine cells on the GPU; irregular materials are blended into
// seamless tiles on the way, regular patterns are copied as they are and
// mirrored by the scene shader instead. Only shipped sheets get layers:
// renderer.surfaceMeans holds, per slot, its average colour and its layer in
// its array (-1 until that sheet has loaded).
import {FULLSCREEN_VERTEX} from './render-shaders.js';
import {CELL_INSET,SURFACE_SHEETS,SURFACE_SIZES,TEXTURE_VERSION,smallSurface} from './surfaces.js';

const CUT_FRAGMENT=`#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSheet;
uniform vec4 uCell;
uniform int uSeamless;
out vec4 frag;
// The cell, upright: the top of the image is the top of the texture.
vec3 at(vec2 uv){vec2 p=fract(uv);return textureLod(uSheet,uCell.xy+vec2(p.x,1.-p.y)*uCell.zw,0.).rgb;}
void main(){
  vec2 uv=vUV;
  if (uSeamless==0) {frag=vec4(at(uv),1.);return;}
  // Four copies shifted by half a tile; each fades out where its own edge
  // falls, so the result wraps without a seam.
  vec2 w=sin(3.14159265*uv);
  w*=w;
  float a=w.x*w.y, b=(1.-w.x)*w.y, c=w.x*(1.-w.y), d=(1.-w.x)*(1.-w.y);
  vec3 blend=at(uv)*a+at(uv+vec2(.5,0.))*b+at(uv+vec2(0.,.5))*c+at(uv+.5)*d;
  // Blending flattens contrast; restore it around the cell's average colour
  // using 4 coarse mip taps instead of 16.
  vec3 mean=(textureLod(uSheet,uCell.xy+vec2(.25,.25)*uCell.zw,6.).rgb
            +textureLod(uSheet,uCell.xy+vec2(.75,.25)*uCell.zw,6.).rgb
            +textureLod(uSheet,uCell.xy+vec2(.25,.75)*uCell.zw,6.).rgb
            +textureLod(uSheet,uCell.xy+vec2(.75,.75)*uCell.zw,6.).rgb)*.25;
  frag=vec4(clamp(mean+(blend-mean)/pow(a*a+b*b+c*c+d*d,.35),0.,1.),1.);
}`;

// Copies the 1x1 top mip of every layer into a single Nx1 strip so all
// average colours read back in one GPU sync instead of one per layer.
const MEAN_FRAGMENT=`#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uArray;
uniform float uMaxLod;
out vec4 frag;
void main(){
  frag=textureLod(uArray,vec3(.5,.5,floor(gl_FragCoord.x)),uMaxLod);
}`;

function compile(gl,kind,source) {
  const shader=gl.createShader(kind);
  gl.shaderSource(shader,source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function link(gl,fragment) {
  const program=gl.createProgram();
  const vs=compile(gl,gl.VERTEX_SHADER,FULLSCREEN_VERTEX);
  const fs=compile(gl,gl.FRAGMENT_SHADER,fragment);
  gl.attachShader(program,vs);
  gl.attachShader(program,fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function cutter(gl) {
  const program=link(gl,CUT_FRAGMENT);
  const meanProgram=link(gl,MEAN_FRAGMENT);
  return {
    program,
    meanProgram,
    buffer:gl.createFramebuffer(),
    sheet:gl.getUniformLocation(program,'uSheet'),
    cell:gl.getUniformLocation(program,'uCell'),
    seamless:gl.getUniformLocation(program,'uSeamless'),
    meanArray:gl.getUniformLocation(meanProgram,'uArray'),
    meanLod:gl.getUniformLocation(meanProgram,'uMaxLod')
  };
}

export function surfaceArray(gl,size,unit,anisotropy,layers=1) {
  const texture=gl.createTexture();
  gl.activeTexture(gl.TEXTURE0+unit);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY,texture);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY,Math.floor(Math.log2(size))+1,gl.RGBA8,size,size,Math.max(1,layers));
  gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.REPEAT);
  if (anisotropy) gl.texParameterf(gl.TEXTURE_2D_ARRAY,anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
    Math.min(4,gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)||1));
  return texture;
}

// Cuts one sheet into its nine cells into mip 0 without stalling or mipmapping.
function cutSheetCells(renderer,kit,sheetTex,image,index,cells,units) {
  const gl=renderer.gl;
  gl.activeTexture(gl.TEXTURE0+units.sheet);
  gl.bindTexture(gl.TEXTURE_2D,sheetTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindFramebuffer(gl.FRAMEBUFFER,kit.buffer);
  gl.useProgram(kit.program);
  gl.uniform1i(kit.sheet,units.sheet);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(renderer.empty);
  const inset=CELL_INSET/3, span=1/3-2*inset;
  for (let i=0;i<9;i++) {
    const cell=SURFACE_SHEETS[index].cells[i], [left,top,right,bottom]=cell.crop ?? [0,0,1,1];
    const target=cells[i], array=renderer.surfaceArrays[target.array];
    gl.viewport(0,0,array.size,array.size);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,array.texture,0,target.layer);
    gl.uniform4f(kit.cell,(i%3)/3+inset+left*span,Math.floor(i/3)/3+inset+top*span,(right-left)*span,(bottom-top)*span);
    gl.uniform1i(kit.seamless,cell.pattern || cell.repeat?0:1);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
}

// Reads back the 1x1 average colour of every layer in one array with a single readPixels.
function readArrayMeans(renderer,kit,array,layerCount,sheetUnit) {
  if (!layerCount) return null;
  const gl=renderer.gl;
  gl.activeTexture(gl.TEXTURE0+array.unit);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY,array.texture);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  const strip=gl.createTexture();
  gl.activeTexture(gl.TEXTURE0+sheetUnit);
  gl.bindTexture(gl.TEXTURE_2D,strip);
  gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,layerCount,1);
  gl.bindFramebuffer(gl.FRAMEBUFFER,kit.buffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,strip,0);
  gl.viewport(0,0,layerCount,1);
  gl.useProgram(kit.meanProgram);
  gl.uniform1i(kit.meanArray,array.unit);
  gl.uniform1f(kit.meanLod,Math.floor(Math.log2(array.size)));
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(renderer.empty);
  gl.drawArrays(gl.TRIANGLES,0,3);
  const pixels=new Uint8Array(layerCount*4);
  gl.readPixels(0,0,layerCount,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,null,0);
  gl.deleteTexture(strip);
  return pixels;
}

// Fetches every sheet listed in textures/index.json concurrently, cuts all
// cells in one GPU pass, mipmaps each array once and reads back all means in
// two batched calls instead of one per layer.
export async function loadSurfaceSheets(renderer,{size=SURFACE_SIZES.high[0],small=SURFACE_SIZES.high[1],units,base=''}={}) {
  const gl=renderer.gl;
  if (!gl || renderer.surfaceLoading) return renderer.surfaceLoading;
  renderer.surfaceLoading=(async()=>{
    let listed=[];
    try {
      const response=await fetch(base+'textures/index.json?v='+TEXTURE_VERSION,{cache:'no-cache'});
      if (response.ok) listed=(await response.json()).sheets ?? [];
    } catch { return 0; }
    // Only shipped sheets get layers; each cell goes to the array of its size class.
    const counts={large:0,small:0};
    const wanted=SURFACE_SHEETS.map((sheet,index)=>({sheet,index})).filter(({sheet})=>listed.includes(sheet.id))
      .map(entry=>({...entry,cells:entry.sheet.cells.map(cell=>{
        const array=smallSurface(cell)?'small':'large';
        return {array,layer:counts[array]++};
      })}));
    if (!wanted.length) return 0;
    const shape=[size,small,counts.large,counts.small].join('/');
    if (!renderer.surfaceArrays || renderer.surfaceShape!==shape) {
      for (const array of Object.values(renderer.surfaceArrays ?? {})) gl.deleteTexture(array.texture);
      renderer.surfaceArrays={
        large:{size,unit:units.surface,texture:surfaceArray(gl,size,units.surface,renderer.anisotropy,counts.large)},
        small:{size:small,unit:units.small,texture:surfaceArray(gl,small,units.small,renderer.anisotropy,counts.small)}
      };
      renderer.surfaceShape=shape;
      renderer.surfaceSheets=0;
      for (let slot=3;slot<renderer.surfaceMeans.length;slot+=4) renderer.surfaceMeans[slot]=-1;
      renderer.surfaceMeansDirty=true;
    }
    // Fetch and decode all sheets concurrently.
    const decoded=await Promise.all(wanted.map(async entry=>{
      try {
        const response=await fetch(base+'textures/'+entry.sheet.id+'.webp?v='+TEXTURE_VERSION);
        if (!response.ok) return null;
        const image=await createImageBitmap(await response.blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
        return {...entry,image};
      } catch (error) {
        console.warn('Texture sheet unavailable: '+entry.sheet.id,error);
        return null;
      }
    }));
    if (gl.isContextLost()) {
      for (const item of decoded) item?.image?.close?.();
      return renderer.surfaceSheets;
    }
    const ready=decoded.filter(Boolean);
    if (!ready.length) return renderer.surfaceSheets;
    const kit=renderer.surfaceCutter ??= cutter(gl);
    const sheetTex=gl.createTexture();
    gl.activeTexture(gl.TEXTURE0+units.sheet);
    gl.bindTexture(gl.TEXTURE_2D,sheetTex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    let loadedMask=renderer.surfaceSheets;
    for (const {index,cells,image} of ready) {
      cutSheetCells(renderer,kit,sheetTex,image,index,cells,units);
      image.close?.();
      loadedMask|=1<<index;
    }
    gl.deleteTexture(sheetTex);
    const meanBufs={
      large:readArrayMeans(renderer,kit,renderer.surfaceArrays.large,counts.large,units.sheet),
      small:readArrayMeans(renderer,kit,renderer.surfaceArrays.small,counts.small,units.sheet)
    };
    for (const {index,cells} of ready) {
      for (let i=0;i<9;i++) {
        const target=cells[i], px=meanBufs[target.array], o=target.layer*4;
        if (px) renderer.surfaceMeans.set([px[o]/255,px[o+1]/255,px[o+2]/255,target.layer],(index*9+i)*4);
      }
    }
    renderer.surfaceSheets=loadedMask;
    renderer.surfaceMeansDirty=true;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return renderer.surfaceSheets;
  })().finally(()=>{renderer.surfaceLoading=null;});
  return renderer.surfaceLoading;
}
