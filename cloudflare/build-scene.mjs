import {writeFile} from 'node:fs/promises';
import {World} from '../dist/world.js';
import {SCENE_FILE,SCENE_VERSION} from '../dist/layout.js';

const parts=[];
const renderer={
  zone:0,
  add(type,...args){parts.push([this.zone,type,...args]);},
  label(...args){parts.push([this.zone,'label',...args]);},
  seal(){}
};
const {solids,slabs,homes,objects,elevated}=new World(renderer);
const scene={version:SCENE_VERSION,parts,solids,slabs,homes,objects,elevated};
await writeFile(new URL(`../dist/${SCENE_FILE}`,import.meta.url),JSON.stringify(scene)+'\n');
console.log('Built the scene with '+parts.length+' instances.');
