const entries={
  4:{index:0,label:'WEST RESIDENCE',floor:0xb9a487,wall:0xd1c4ae,accent:0x8a6249},
  12:{index:1,label:'EAST RESIDENCE',floor:0xa7b5ae,wall:0xcbcfbc,accent:0x547873},
  19:{index:2,label:'COURTYARD 03',floor:0xc1b6a6,wall:0xd4cabb,accent:0x758062}
};

export const apartmentEntry=wear=>entries[wear];

export function buildApartmentEntry(world,entry,{x,front,sign,w,h,d,tint,kind}) {
  const r=world.r, {index,floor,wall,accent}=entry, yaw=sign===1?0:Math.PI;
  const roomFront=front+sign*.68, roomBack=-sign*34.49, ceiling=3.15;
  const depth=Math.abs(roomFront-roomBack), center=(roomFront+roomBack)/2;
  const door=1.58, faceH=2.68;
  world.homes.push({index,x0:x-w/2+.17,x1:x+w/2-.17,z0:Math.min(roomFront,roomBack),z1:Math.max(roomFront,roomBack),ceiling});
  world.solid(x,(ceiling+h)/2,front-sign*d/2,w,h-ceiling,d,tint,kind);
  const rear=front-sign*d, behind=Math.abs(rear-roomBack);
  if (behind>.02) world.solid(x,ceiling/2,(rear+roomBack)/2,w,ceiling,behind,wall,2);
  for (const side of [-1,1]) world.solid(x+side*(w*.5-.09),ceiling/2,center,.18,ceiling,depth,wall,2);
  world.solid(x,(ceiling+faceH)/2,roomFront,w,ceiling-faceH,.21,accent,2);
  r.add('box',x,-.006,center,w-.32,.036,depth+.14,floor,1,{layer:0});
  r.add('box',x,ceiling-.08,center,w, .16,depth,wall,2);
  r.add('box',x,ceiling-.173,center,w*.49,.039,.35,0xffedd3,3);
  for (const side of [-1,1]) {
    const paneW=(w-door)*.5, paneX=x+side*(w+door)*.25;
    world.solid(paneX,.30,roomFront,paneW,.60,.18,wall,2);
    world.solid(paneX,2.57,roomFront,paneW,.23,.18,accent,2);
    for (const post of [door*.5+.043,w*.5-.051,(w+door)*.25]) {
      world.solid(x+side*post,1.53,roomFront,.096,1.96,.15,accent,4);
    }
    for (const span of [-1,1]) world.objects.push({id:'home-'+index+'-window-'+side+'-'+span,type:'glass',
      x:paneX+span*paneW*.25,y:1.55,z:roomFront,w:paneW*.5-.10,h:1.84,d:.004,yaw});
  }
  const roadDepth=5.1, roadZ=roomFront+sign*roadDepth*.5;
  r.add('box',x,.012,roadZ,1.77,.023,roadDepth,0xbcc0ad,1,{layer:0});
  for (const side of [-1,1]) {
    r.add('box',x+side*.93,.027,roadZ,.10,.032,roadDepth,0xb8a77e,1,{layer:0});
    for (let i=0;i<10;i++) r.add('box',x+side*.63,.027,roadZ+(i-4.5)*.46,.31,.023,.055,0xc7baa0,1,{layer:0});
  }
  for (const dx of [-.56,-.28,0,.28,.56]) r.add('box',x+dx,.031,roomFront+sign*.32,.19,.031,.34,0xa59268,1,{layer:0});
  r.add('box',x,2.74,roomFront+sign*.20,2.36,.23,.46,accent,4);
  r.add('box',x,2.61,roomFront+sign*.20,1.62,.029,.21,0xffedcf,3);
  r.add('box',x,3.04,roomFront+sign*.10,w-.38,.34,.13,accent,2);
  r.label(entry.label,x,3.04,roomFront+sign*.177,w-.65,.32,0xf2e8d1,yaw);
  for (const side of [-1,1]) {
    const px=x+side*(w*.5-.76), pz=roomBack+sign*.36;
    if (index===0) {
      r.add('box',px,1.35,pz,1.08,1.46,.24,0x768482,4);
      for (let i=0;i<4;i++) for (const off of [-.33,0,.33]) {
        r.add('box',px+off,.89+i*.30,pz+sign*.14,.27,.24,.041,0x9aa59a,4);
        r.add('box',px+off,.94+i*.30,pz+sign*.164,.14,.031,.016,0x586661,4);
      }
    } else if (index===1) {
      world.solid(px,.24,pz,1.09,.45,.55,accent,2);
      r.add('bevel',px,.50,pz,1.19,.15,.57,0x94a6a1,2);
      r.add('bevel',px,.76,pz-sign*.21,1.19,.43,.13,0x94a6a1,2);
    } else {
      r.add('taper',px,.28,pz,.55,.55,.55,0xab7c59,13);
      r.add('orb',px,.86,pz,.66,.75,.61,0x748a5a,14);
      r.add('orb',px+side*.13,1.15,pz,.39,.53,.37,0x8b9e68,14);
    }
  }
}
