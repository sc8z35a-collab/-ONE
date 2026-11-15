import {FILM_HEIGHT_TOLERANCE,decodeFilmHeight} from './ink-fluid.js';
import {Renderer,SUN,STRIDE,clamp,cross,dot,hazardDisk,labelAtlas,mantleMesh,meshes,mix,multiply,packInstance,perspective,sub,unit,view} from './render.js';

import {CITY_RADIUS,ZONES,inkOrigin,inkY,interiorBlend,zoneOf} from './layout.js';

const NEAR=.12;
const CYAN=[16,207,186], AMBER=[239,103,52];
const transparent=kind=>kind===7 || kind===12 || kind===16 || kind===17 || kind===24;
const pack=(r,g,b)=>(255<<24)|(Math.min(255,b)<<16)|(Math.min(255,g)<<8)|Math.min(255,r);

function buildInstance(list,i,mesh) {
  const p=[list[i+12],list[i+13],list[i+14]];
  const a=list.slice(i,i+3),b=list.slice(i+4,i+7),c=list.slice(i+8,i+11);
  const a2=dot(a,a),b2=dot(b,b),c2=dot(c,c);
  const determinant=dot(a,cross(b,c));
  const normals=[cross(b,c),cross(c,a),cross(a,b)].map(row=>row.map(value=>value/determinant));
  const v=new Float32Array(mesh.vertices.length);
  for (let j=0;j<v.length;j+=8) {
    const [x,y,z,nx,ny,nz,u,t]=mesh.vertices.slice(j,j+8);
    for (let k=0;k<3;k++) {
      v[j+k]=p[k]+a[k]*x+b[k]*y+c[k]*z;
      v[j+3+k]=normals[0][k]*nx+normals[1][k]*ny+normals[2][k]*nz;
    }
    v[j+6]=u;
    v[j+7]=t;
  }
  const faces=new Float32Array(mesh.indices.length);
  for (let j=0;j<mesh.indices.length;j+=3) {
    const a=mesh.indices[j]*8,b=mesh.indices[j+1]*8,c=mesh.indices[j+2]*8;
    faces.set(unit([v[a+3]+v[b+3]+v[c+3],v[a+4]+v[b+4]+v[c+4],v[a+5]+v[b+5]+v[c+5]]),j);
  }
  return {p,v,faces,radius:.5*Math.sqrt(a2+b2+c2),indices:mesh.indices,
    color:list.slice(i+16,i+19),kind:list[i+19],label:list[i+20],layer:list[i+21],stairDuplicate:list[i+22]>0,effect:list[i+23]};
}

function visibleFilmOwner(p,index,y,tolerance) {
  const px=index*4, depth=p.pixels[px+3];
  return depth>0 && Math.abs(y-decodeFilmHeight(depth))<tolerance?p.owner[index]:0;
}

function filmOwner(p,layer,u,v,y,tolerance) {
  const x=Math.floor(u),z=Math.floor(v);
  if (x<0 || x>=p.w || z<0 || z>=p.h) return 0;
  const a=layer+z*p.w+x,b=a+(x+1<p.w?1:0),c=a+(z+1<p.h?p.w:0),d=c+b-a;
  const aTeam=visibleFilmOwner(p,a,y,tolerance), bTeam=visibleFilmOwner(p,b,y,tolerance);
  const cTeam=visibleFilmOwner(p,c,y,tolerance), dTeam=visibleFilmOwner(p,d,y,tolerance);
  if (aTeam===bTeam && aTeam===cTeam && aTeam===dTeam) return aTeam;
  const tx=u-x,tz=v-z;
  const aw=(1-tx)*(1-tz),bw=tx*(1-tz),cw=(1-tx)*tz,dw=tx*tz;
  const cyan=(aTeam===1?aw:0)+(bTeam===1?bw:0)+(cTeam===1?cw:0)+(dTeam===1?dw:0);
  const amber=(aTeam===2?aw:0)+(bTeam===2?bw:0)+(cTeam===2?cw:0)+(dTeam===2?dw:0);
  return cyan+amber<.51?0:cyan>=amber?1:2;
}

export class SoftwareRenderer {
  constructor(canvas) {
    this.canvas=canvas;
    this.cpuRenderer=true;
    this.zone=0;
    this.lite=false;
    this.ctx=canvas.getContext('2d',{alpha:false});
    if (!this.ctx) throw new Error('Canvas 2D が利用できません。');
    this.mesh=meshes(true);
    this.batches=Object.fromEntries(Object.keys(this.mesh).map(name=>[name,{static:{list:[]},lower:{list:[]},cabin:{list:[]},railCabin:{list:[]},dynamic:{list:[]},adjacent:{list:[]}}]));
    this.static=[[],[],[],[]];
    const atlas=labelAtlas();
    this.atlas=atlas.getContext('2d').getImageData(0,0,atlas.width,atlas.height).data;
  }

  add(type,x,y,z,w,h,d,tint,kind=0,opts={}) {
    const pair=this.batches[type];
    if (!pair) return;
    const list=pair[opts.dynamic?(this.drawingAdjacent?'adjacent':'dynamic'):['static','lower','cabin','railCabin'][this.zone]].list;
    packInstance(list,list.length,x,y,z,w,h,d,tint,kind,opts);
  }
  label(...args) { Renderer.prototype.label.call(this,...args); }
  beam(...args) { Renderer.prototype.beam.call(this,...args); }
  clearDynamic() {
    for (const pair of Object.values(this.batches)) {
      pair.dynamic.list.length=0;
      pair.adjacent.list.length=0;
    }
  }
  project(point) { return Renderer.prototype.project.call(this,point); }

  setQuality(level) {
    this.quality=level===true?'lite':level===false?'high':level;
    this.lite=this.quality!=='high';
    this.ultra=this.quality==='ultra';
  }

  seal() {
    for (const [name,batch] of Object.entries(this.batches)) {
      for (const [zone,list] of [[0,batch.static.list],[1,batch.lower.list],[2,batch.cabin.list],[3,batch.railCabin.list]]) {
        const mesh=this.mesh[name];
        for (let i=0;i<list.length;i+=STRIDE) this.static[zone].push(buildInstance(list,i,mesh));
        list.length=0;
      }
    }
  }

  configureWorld(world,paint) {
    this.world=world;
    this.shadow=null;
    if (this.lite) return;
    const map=new Uint8Array(paint.layerSize);
    const mx=x=>(x/paint.boundX+1)*.5*paint.w;
    const mz=z=>(z/paint.boundZ+1)*.5*paint.h;
    const bx=i=>((i+.5)/paint.w*2-1)*paint.boundX;
    const bz=i=>((i+.5)/paint.h*2-1)*paint.boundZ;
    for (const {min,max} of world.solids) {
      if (zoneOf(min[0])!==0) continue;
      const from=min[1]/SUN[1], to=max[1]/SUN[1];
      const x0=clamp(Math.floor(mx(min[0]-SUN[0]*from)),0,paint.w-1);
      const x1=clamp(Math.ceil(mx(max[0]-SUN[0]*to)),0,paint.w-1);
      const z0=clamp(Math.floor(mz(min[2]-SUN[2]*to)),0,paint.h-1);
      const z1=clamp(Math.ceil(mz(max[2]-SUN[2]*from)),0,paint.h-1);
      for (let j=z0;j<=z1;j++) for (let i=x0;i<=x1;i++) {
        const x=bx(i),z=bz(j);
        const enter=Math.max(from,(max[0]-x)/SUN[0],(min[2]-z)/SUN[2]);
        const exit=Math.min(to,(min[0]-x)/SUN[0],(max[2]-z)/SUN[2]);
        if (exit>=enter) map[j*paint.w+i]=1;
      }
    }
    this.shadow=map;
  }

  draw(camera,paint,clock=0) {
    const canvas=this.canvas;
    // Lightweight modes keep the same 400 / 300 lines as the WebGL renderer.
    const short=Math.max(1,Math.min(canvas.clientWidth,canvas.clientHeight));
    const ratio=this.lite?Math.min(1,(this.ultra?300:400)/short):Math.min(1,1024/canvas.clientWidth,576/canvas.clientHeight);
    this.viewZone=zoneOf(camera.eye[0]);
    this.interior=interiorBlend(camera);
    if (!this.lite && !this.shadow && this.world) this.configureWorld(this.world,paint);
    const W=Math.max(1,Math.round(canvas.clientWidth*ratio));
    const H=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if (!this.image || W!==canvas.width || H!==canvas.height) {
      canvas.width=W;
      canvas.height=H;
      this.image=this.ctx.createImageData(W,H);
      this.buffer=new Uint32Array(this.image.data.buffer);
      this.depth=new Float32Array(W*H);
    }
    this.W=W;
    this.H=H;
    this.aspect=W/H;
    this.focal=H*.5/Math.tan(58*Math.PI/360);
    this.eye=camera.eye;
    this.direction=unit(sub(camera.target,camera.eye));
    this.right=unit(cross(this.direction,[0,1,0]));
    this.up=cross(this.right,this.direction);
    this.paint=paint;
    this.clock=clock;
    this.vp=multiply(perspective(W/H),view(camera.eye,camera.target));
    this.depth.fill(0);
    for (let i=0;i<H;i++) {
      const y=clamp(this.direction[1]+(H/2-i)/this.focal,0,.76);
      const a=Math.sqrt(y);
      this.buffer.fill(pack(mix(218-a*98,67,this.interior),mix(234-a*46,82,this.interior),mix(243-a*22,75,this.interior)),i*W,(i+1)*W);
    }
    const overlays=[];
    const mergeStairs=!!camera.stair && this.viewZone<2;
    const draw=item=>{
      if (mergeStairs && item.stairDuplicate) return;
      if (transparent(item.kind)) overlays.push({item,eye:this.eye,distance:dot(sub(item.p,this.eye),this.direction)});
      else this.renderInstance(item);
    };
    const views=mergeStairs?[[this.viewZone,'dynamic'],[1-this.viewZone,'adjacent']]:[[this.viewZone,'dynamic']];
    for (const [zone,key] of views) {
      this.eye=[camera.eye[0]+ZONES[zone].x-ZONES[this.viewZone].x,camera.eye[1],camera.eye[2]];
      for (const item of this.static[zone]) draw(item);
      for (const [name,pair] of Object.entries(this.batches)) {
        const list=pair[key].list;
        if (!list.length) continue;
        let mesh=this.mesh[name];
        if (!this.lite && name==='mantle') mesh=this.bossMantle??=mantleMesh(false);
        if (!this.lite && name==='hazard') mesh=this.bossWarning??=hazardDisk(false);
        for (let i=0;i<list.length;i+=STRIDE) draw(buildInstance(list,i,mesh));
      }
    }
    overlays.sort((a,b)=>b.distance-a.distance);
    for (const {item,eye} of overlays) {
      this.eye=eye;
      this.renderInstance(item);
    }
    this.eye=camera.eye;
    this.ctx.putImageData(this.image,0,0);
  }

  projectVertex(v,index) {
    const dx=v[index]-this.eye[0], dy=v[index+1]-this.eye[1], dz=v[index+2]-this.eye[2];
    const [a,b,c]=[this.right,this.up,this.direction];
    return [
      a[0]*dx+a[1]*dy+a[2]*dz,
      b[0]*dx+b[1]*dy+b[2]*dz,
      c[0]*dx+c[1]*dy+c[2]*dz,
      v[index],v[index+1],v[index+2],v[index+6],v[index+7]
    ];
  }

  renderInstance(item) {
    const rel=sub(item.p,this.eye), dist=dot(rel,this.direction), radius=item.radius;
    const span=dist*Math.tan(58*Math.PI/360);
    if (dist+radius<NEAR || dist-radius>1200
      || Math.abs(dot(rel,this.right))>span*this.aspect+radius*1.49
      || Math.abs(dot(rel,this.up))>span+radius*1.31
      || (dist>25 && radius*this.focal/dist<.58)) return;
    const {v,indices,faces}=item;
    const projected=[];
    const fog=clamp((Math.hypot(...rel)-13)/140,0,.69);
    for (let i=0;i<v.length;i+=8) projected.push(this.projectVertex(v,i));
    for (let i=0;i<indices.length;i+=3) {
      const ia=indices[i]*8,ib=indices[i+1]*8,ic=indices[i+2]*8;
      const nx=faces[i],ny=faces[i+1],nz=faces[i+2];
      if (item.kind===22 && ny<.5) continue;
      if (nx*(this.eye[0]-v[ia])+ny*(this.eye[1]-v[ia+1])+nz*(this.eye[2]-v[ia+2])<=0) continue;
      const n=[nx,ny,nz];
      const base=[projected[indices[i]],projected[indices[i+1]],projected[indices[i+2]]];
      if (base.every(p=>p[2]<NEAR)) continue;
      const face=base.every(p=>p[2]>=NEAR)?base:this.clip(base);
      const daylight=.64+Math.max(n[1],0)*.16+Math.max(0,dot(n,SUN))*.43;
      const lambert=item.kind===7?1:(item.kind===3 || item.kind===24 || item.kind===25)?1.16:mix(daylight,.85+Math.max(n[1],0)*.12,this.interior);
      let shine=0;
      if (!this.lite && [4,6,8,9,11,17,20].includes(item.kind)) {
        const eyeDir=unit(sub(this.eye,item.p)), half=unit([eyeDir[0]+SUN[0],eyeDir[1]+SUN[1],eyeDir[2]+SUN[2]]);
        shine=Math.pow(Math.max(0,dot(n,half)),item.kind===4?65:95)*.29;
      }
      const tint=item.color.map((v,k)=>(v*lambert*(1-fog)+shine*[1,.96,.86][k]+[.73,.84,.89][k]*fog)*255);
      const surface=(item.kind===1 || item.kind===5 || item.kind===15 || item.kind===22) && n[1]>.48 &&
        (item.kind===15 || Math.max(v[ia+1],v[ib+1],v[ic+1])>inkY(item.layer)-.055);
      for (let j=1;j<face.length-1;j++) this.triangle(face[0],face[j],face[j+1],tint,item,n,surface);
    }
  }

  clip(vertices) {
    const result=[];
    let last=vertices[vertices.length-1];
    for (const next of vertices) {
      const a=last[2]>=NEAR,b=next[2]>=NEAR;
      if (a!==b) {
        const t=(NEAR-last[2])/(next[2]-last[2]);
        result.push(last.map((v,i)=>v+(next[i]-v)*t));
      }
      if (b) result.push(next);
      last=next;
    }
    return result;
  }

  triangle(a,b,c,tint,item,n,surface) {
    const W=this.W,H=this.H,f=this.focal;
    const qa=1/a[2],qb=1/b[2],qc=1/c[2];
    const ax=W/2+a[0]*qa*f,ay=H/2-a[1]*qa*f;
    const bx=W/2+b[0]*qb*f,by=H/2-b[1]*qb*f;
    const cx=W/2+c[0]*qc*f,cy=H/2-c[1]*qc*f;
    const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(W-1,Math.floor(Math.max(ax,bx,cx)-.5));
    const y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),y1=Math.min(H-1,Math.floor(Math.max(ay,by,cy)-.5));
    if (x1<x0 || y1<y0) return;
    const area=(bx-ax)*(cy-ay)-(cx-ax)*(by-ay);
    if (Math.abs(area)<.00001) return;
    const ia=1/area, dbx=(cy-ay)*ia, dby=(ax-cx)*ia, dcx=(ay-by)*ia, dcy=(bx-ax)*ia;
    const bs=(x0+.5-ax)*dbx+(y0+.5-ay)*dby, cs=(x0+.5-ax)*dcx+(y0+.5-ay)*dcy;
    const depth=this.depth, buf=this.buffer, p=this.paint;
    const label=item.kind===7, hazard=item.kind===24, windows=item.kind===11 && Math.abs(n[1])<.5;
    const masonry=item.kind===13 && Math.abs(n[1])<.6;
    const material=!this.lite && [2,4,8,9,18,19,20,21].includes(item.kind);
    const textured=surface || label || windows || masonry || material || item.kind===27;
    const base=pack(...tint);
    const inkMap=this.lite || this.interior>.5?null:this.shadow, layer=item.layer*p.layerSize;
    const [xA,xB,xC]=[a[3]*qa,b[3]*qb,c[3]*qc];
    const [yA,yB,yC]=[a[4]*qa,b[4]*qb,c[4]*qc];
    const [zA,zB,zC]=[a[5]*qa,b[5]*qb,c[5]*qc];
    const [uA,uB,uC]=[a[6]*qa,b[6]*qb,c[6]*qc];
    const [vA,vB,vC]=[a[7]*qa,b[7]*qb,c[7]*qc];
    const labelX=(item.label%4)*256, labelY=Math.floor(item.label/4)*96;
    for (let y=y0;y<=y1;y++) {
      let B=bs+(y-y0)*dby, C=cs+(y-y0)*dcy;
      let i=y*W+x0;
      for (let x=x0;x<=x1;x++,i++,B+=dbx,C+=dcx) {
        const A=1-B-C;
        if (A<-.00001 || B<-.00001 || C<-.00001) continue;
        const q=A*qa+B*qb+C*qc;
        if (q<=depth[i] && !(item.kind===26 && depth[i]-q<q*.000012)) continue;
        let rgb=base, labelAlpha=1;
        if (hazard) {
          const u=(A*uA+B*uB+C*uC)/q,r=(A*vA+B*vB+C*vC)/q;
          const angle=(u>.5?u-1:u)*Math.PI*2, edge=item.layer*Math.PI;
          if (edge>0 && Math.abs(angle)>edge) continue;
          const travel=edge>0?(angle+edge)/(edge*2):r;
          const ring=Math.abs(r-.96)<.032 || edge>0 && Math.abs(angle)>edge-.057;
          const pulse=Math.max(0,1-Math.abs(travel-item.label)*15);
          if (item.effect>=1) {
            labelAlpha=(.17+.53*pulse)*Math.max(0,2-item.effect);
          } else {
            const dash=r>.86 && (u*48%1)>.68;
            labelAlpha=ring?.82:.10+.29*pulse+(dash?.28:0);
          }
        } else if (textured) {
          if (label) {
            const u=(A*uA+B*uB+C*uC)/q,t=(A*vA+B*vB+C*vC)/q;
            const index=((labelY+clamp(Math.floor((1-t)*96),0,95))*1024+labelX+clamp(Math.floor(u*256),0,255))*4;
            labelAlpha=this.atlas[index+3]/255;
            if (labelAlpha<.012) continue;
          } else {
            const wx=(A*xA+B*xB+C*xC)/q, wz=(A*zA+B*zB+C*zC)/q;
            if (item.kind===27 && wx*wx+wz*wz>CITY_RADIUS**2) continue;
            if (surface) {
              const u=((wx-inkOrigin(item.layer))/p.boundX+1)*.5*p.w,v=(wz/p.boundZ+1)*.5*p.h;
              const index=Math.floor(v)*p.w+Math.floor(u), within=u>=0 && u<p.w && v>=0 && v<p.h;
              const ink=(index+layer)*4;
              const wy=(A*yA+B*yB+C*yC)/q;
              const tolerance=item.kind===15 || item.layer===4?.207:FILM_HEIGHT_TOLERANCE;
              const owner=filmOwner(p,layer,u-.5,v-.5,wy,tolerance);
              const strength=owner?1:0, mixAmount=owner===2?1:0;
              const hash=((Math.imul(Math.floor(wx*19),4787)^Math.imul(Math.floor(wz*19),60757))&127)/127;
              const shadowed=within && inkMap?.[index] && !item.layer;
              const shade=(shadowed ? .87 : 1)*(.96+hash*.066);
              const vx=this.eye[0]-wx,vy=this.eye[1]-wy,vz=this.eye[2]-wz;
              const inv=1/Math.max(.1,Math.hypot(vx,vy,vz));
              const grazing=Math.pow(1-Math.max(0,vy*inv),5);
              const wave=this.lite?0:Math.sin(wx*9.2+wz*5.4-this.clock*4.8)*Math.cos(wz*8.9+this.clock*3.2);
              const shimmer=strength?(5+grazing*43+wave*2.1):item.kind===5?Math.max(0,Math.sin(wx*.81+wz*.36)-.23)*4.1:0;
              const wet=within?p.pixels[ink+2]/255:0;
              const light=(.95+wet*.06)*strength;
              const red=tint[0]*(1-strength)+(CYAN[0]+(AMBER[0]-CYAN[0])*mixAmount)*light;
              const green=tint[1]*(1-strength)+(CYAN[1]+(AMBER[1]-CYAN[1])*mixAmount)*light;
              const blue=tint[2]*(1-strength)+(CYAN[2]+(AMBER[2]-CYAN[2])*mixAmount)*light;
              rgb=pack(red*shade+shimmer,green*shade+shimmer,blue*shade+shimmer*1.35);
            } else {
              const wy=(A*yA+B*yB+C*yC)/q;
              const u=(Math.abs(n[0])>.5?wz:wx)/2.2,v=wy/3.15;
              const ux=u-Math.floor(u),vy=v-Math.floor(v);
              if (masonry) {
                const row=Math.floor(wy/.296), stone=(Math.abs(n[0])>.5?wz:wx)/.69+(row&1)*.5;
                const side=stone-Math.floor(stone), level=wy/.296-row;
                const joint=Math.min(side,1-side)*.69<.021 || Math.min(level,1-level)*.296<.018;
                const grain=((Math.imul(Math.floor(stone),5139)^Math.imul(row,3091))&127)/127;
                const tone=joint?.84:.93+grain*.13;
                rgb=pack(tint[0]*tone,tint[1]*tone,tint[2]*tone);
              } else if (material) {
                const grain=((Math.imul(Math.floor(wx*38),4787)^Math.imul(Math.floor((wy+wz)*38),60757))&127)/127;
                const brushed=item.kind===4?.96+.04*Math.sin(wy*190.):.96+grain*.07;
                rgb=pack(tint[0]*brushed,tint[1]*brushed,tint[2]*brushed);
                if (item.kind===8) {
                  const reflection=clamp((this.eye[1]-wy)/Math.max(1,1/q)*.5+.5,0,1);
                  rgb=pack(tint[0]*.65+42*reflection,tint[1]*.69+62*reflection,tint[2]*.73+70*reflection);
                }
              } else if (ux>.13 && ux<.9 && vy>.21 && vy<.89) {
                const blind=vy>.69 && ((Math.floor(u)+Math.floor(v))&3)===0;
                const drift=(Math.abs(n[0])>.5?this.eye[2]-wz:this.eye[0]-wx)*.065/Math.max(1,1/q);
                const roomX=ux+drift,side=roomX<.24 || roomX>.80, floor=vy<.30;
                const cabinet=roomX>.31 && roomX<.43 && vy<.48;
                const tone=side?.65:floor?.59:cabinet?.53:.87;
                rgb=blind?pack(tint[0]*1.04,tint[1]*1.02,tint[2]*.95):pack(tint[0]*tone,tint[1]*(tone+.08),tint[2]*(tone+.12));
              }
            }
          }
        }
        if (transparent(item.kind)) {
          const opacity=label || hazard?labelAlpha:item.kind===17?.21:item.kind===16?.34*(1-item.label*.64):(1-item.label)*.37;
          const under=buf[i];
          buf[i]=pack((under&255)*(1-opacity)+tint[0]*opacity,
            ((under>>>8)&255)*(1-opacity)+tint[1]*opacity,
            ((under>>>16)&255)*(1-opacity)+tint[2]*opacity);
        } else {
          depth[i]=q;
          buf[i]=rgb;
        }
      }
    }
  }
}
