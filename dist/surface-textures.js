// Loads the texture sheets (see surfaces.js) into one texture array. Each
// sheet image is cut into its nine cells on the GPU; irregular materials are
// blended into seamless tiles on the way, regular patterns are copied as they
// are and mirrored by the scene shader instead. Only shipped sheets get layers:
// renderer.surfaceMeans holds, per slot, its average colour and its layer
// (-1 until that sheet has loaded).
import {FULLSCREEN_VERTEX} from './render-shaders.js';
import {CELL_INSET,SURFACE_SHEETS,TEXTURE_VERSION} from './surfaces.js';

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
  // Blending flattens contrast; restore it around the cell's average colour.
  vec3 mean=vec3(0.);
  for (int j=0;j<4;j++) for (int i=0;i<4;i++) mean+=textureLod(uSheet,uCell.xy+(vec2(i,j)+.5)*.25*uCell.zw,4.).rgb;
  mean*=1./16.;
  frag=vec4(clamp(mean+(blend-mean)/pow(a*a+b*b+c*c+d*d,.35),0.,1.),1.);
}`;

function compile(gl,kind,source) {
  const shader=gl.createShader(kind);
  gl.shaderSource(shader,source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

function cutter(gl) {
  const program=gl.createProgram();
  for (const [kind,source] of [[gl.VERTEX_SHADER,FULLSCREEN_VERTEX],[gl.FRAGMENT_SHADER,CUT_FRAGMENT]]) gl.attachShader(program,compile(gl,kind,source));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return {program,buffer:gl.createFramebuffer(),sheet:gl.getUniformLocation(program,'uSheet'),
    cell:gl.getUniformLocation(program,'uCell'),seamless:gl.getUniformLocation(program,'uSeamless')};
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
    Math.min(8,gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT)||1));
  return texture;
}

function cutSheet(renderer,image,index,base,units) {
  const gl=renderer.gl, kit=renderer.surfaceCutter ??= cutter(gl);
  const sheet=gl.createTexture();
  gl.activeTexture(gl.TEXTURE0+units.sheet);
  gl.bindTexture(gl.TEXTURE_2D,sheet);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER,kit.buffer);
  gl.useProgram(kit.program);
  gl.uniform1i(kit.sheet,units.sheet);
  gl.viewport(0,0,renderer.surfaceSize,renderer.surfaceSize);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(renderer.empty);
  const inset=CELL_INSET/3, span=1/3-2*inset;
  for (let i=0;i<9;i++) {
    const cell=SURFACE_SHEETS[index].cells[i], [left,top,right,bottom]=cell.crop ?? [0,0,1,1];
    gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,renderer.surfaceTexture,0,base+i);
    gl.uniform4f(kit.cell,(i%3)/3+inset+left*span,Math.floor(i/3)/3+inset+top*span,(right-left)*span,(bottom-top)*span);
    gl.uniform1i(kit.seamless,cell.pattern?0:1);
    gl.drawArrays(gl.TRIANGLES,0,3);
  }
  gl.bindVertexArray(null);
  gl.deleteTexture(sheet);
  gl.activeTexture(gl.TEXTURE0+units.surface);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY,renderer.surfaceTexture);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  // Each layer's one-pixel mip is its average colour, read back once so the
  // shaders compare against it without another texture tap per pixel.
  const top=Math.floor(Math.log2(renderer.surfaceSize)), pixel=new Uint8Array(4);
  for (let i=0;i<9;i++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,renderer.surfaceTexture,top,base+i);
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    renderer.surfaceMeans.set([pixel[0]/255,pixel[1]/255,pixel[2]/255,base+i],(index*9+i)*4);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
}

// Fetches every sheet listed in textures/index.json, one at a time, and
// marks each loaded sheet in renderer.surfaceSheets so the shaders use it.
export async function loadSurfaceSheets(renderer,{size=512,units,base=''}={}) {
  const gl=renderer.gl;
  if (!gl || renderer.surfaceLoading) return renderer.surfaceLoading;
  renderer.surfaceLoading=(async()=>{
    let listed=[];
    try {
      const response=await fetch(base+'textures/index.json?v='+TEXTURE_VERSION,{cache:'no-cache'});
      if (response.ok) listed=(await response.json()).sheets ?? [];
    } catch { return 0; }
    const wanted=SURFACE_SHEETS.map((sheet,index)=>({sheet,index})).filter(({sheet})=>listed.includes(sheet.id))
      .map((entry,order)=>({...entry,base:order*9}));
    if (!wanted.length) return 0;
    if (!renderer.surfaceTexture || renderer.surfaceSize!==size || renderer.surfaceLayers!==wanted.length*9) {
      if (renderer.surfaceTexture) gl.deleteTexture(renderer.surfaceTexture);
      renderer.surfaceTexture=surfaceArray(gl,size,units.surface,renderer.anisotropy,wanted.length*9);
      renderer.surfaceSize=size;
      renderer.surfaceLayers=wanted.length*9;
      renderer.surfaceSheets=0;
      for (let slot=3;slot<renderer.surfaceMeans.length;slot+=4) renderer.surfaceMeans[slot]=-1;
    }
    for (const {sheet,index,base} of wanted) {
      try {
        const response=await fetch(base+'textures/'+sheet.id+'.webp?v='+TEXTURE_VERSION);
        if (!response.ok) continue;
        const image=await createImageBitmap(await response.blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
        if (gl.isContextLost()) return renderer.surfaceSheets;
        cutSheet(renderer,image,index,base,units);
        image.close?.();
        renderer.surfaceSheets|=1<<index;
      } catch (error) {
        console.warn('Texture sheet unavailable: '+sheet.id,error);
      }
    }
    return renderer.surfaceSheets;
  })().finally(()=>{renderer.surfaceLoading=null;});
  return renderer.surfaceLoading;
}
