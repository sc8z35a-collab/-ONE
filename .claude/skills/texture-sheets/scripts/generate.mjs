#!/usr/bin/env node
// Generates INK//SHIFT texture sheets with OpenAI's gpt-image-2.5-sunburst:
// one square image per sheet, holding a 3×3 grid of nine seamless textures.
//
//   node .claude/skills/texture-sheets/scripts/generate.mjs [sheet ...] [--size 2880x2880] [--quality medium] [--force]
//
// The key is read from OPENAI_API_KEY and sent only to api.openai.com. In a
// Claude Code cloud session where the key is saved as a network secret, run
// with OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1: Node's fetch then
// goes through the session's proxy, which adds the real key.
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'../../../..');
const {SURFACE_SHEETS,sheetPrompt}=await import(join(root,'dist/surfaces.js'));

const MODEL='gpt-image-2.5-sunburst';
// Square sizes from the largest the API allows for 1:1 down to the standard one.
const SIZES=['2880x2880','2048x2048','1024x1024'];
const SHIPPED=1536;

const args=process.argv.slice(2), option=(name,fallback)=>{
  const at=args.indexOf('--'+name);
  return at>=0?args.splice(at,2)[1]:fallback;
};
const force=args.includes('--force') && !!args.splice(args.indexOf('--force'),1);
const firstSize=option('size',SIZES[0]), quality=option('quality','medium'), parallel=Number(option('parallel','3'));
const wanted=args.length?args:SURFACE_SHEETS.map(sheet=>sheet.id);
const unknown=wanted.filter(id=>!SURFACE_SHEETS.some(sheet=>sheet.id===id));
if (unknown.length) throw new Error('Unknown sheet: '+unknown.join(', ')+' (have '+SURFACE_SHEETS.map(s=>s.id).join(', ')+')');
const key=process.env.OPENAI_API_KEY;
if (!key) throw new Error('Set OPENAI_API_KEY (in a cloud session with a saved network secret: OPENAI_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1).');

const sourceDir=join(root,'textures/source'), shippedDir=join(root,'dist/textures');
mkdirSync(sourceDir,{recursive:true});
mkdirSync(shippedDir,{recursive:true});

async function request(prompt,size) {
  const response=await fetch('https://api.openai.com/v1/images/generations',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
    body:JSON.stringify({model:MODEL,prompt,size,quality,n:1,output_format:'webp',output_compression:95}),
    signal:AbortSignal.timeout(15*60*1000)
  });
  const body=await response.json().catch(()=>({}));
  if (!response.ok) {
    const error=new Error(body.error?.message ?? 'HTTP '+response.status);
    error.status=response.status;
    error.param=body.error?.param;
    throw error;
  }
  return {bytes:Buffer.from(body.data[0].b64_json,'base64'),usage:body.usage ?? null};
}

// The full-size original is kept in textures/source; the game ships a copy
// of at most 1536×1536 (its texture layers are at most 512 px). Smaller
// originals, such as supplied sheets, are never upscaled.
function ship(source,target) {
  try {
    execFileSync('ffmpeg',['-v','error','-y','-i',source,'-vf',`scale='min(iw,${SHIPPED})':'min(ih,${SHIPPED})':flags=lanczos`,'-c:v','libwebp','-quality','88',target]);
  } catch {
    copyFileSync(source,target);
    console.warn('  ffmpeg with libwebp not found: shipped the full-size image');
  }
}

async function generate(sheet) {
  const source=join(sourceDir,sheet.id+'.webp');
  if (existsSync(source) && !force) {
    console.log(sheet.id+': already generated (use --force to replace)');
    ship(source,join(shippedDir,sheet.id+'.webp'));
    return;
  }
  const prompt=sheetPrompt(sheet);
  let size=firstSize, result=null;
  for (const candidate of [firstSize,...SIZES.filter(value=>value!==firstSize)]) {
    size=candidate;
    try {
      console.log(sheet.id+': generating '+size+' quality '+quality+' …');
      result=await request(prompt,size);
      break;
    } catch (error) {
      // An unsupported size moves on to the next one; anything else stops.
      if (!(error.status===400 && (error.param==='size' || /size|resolution|pixel/i.test(error.message)))) throw error;
      console.warn('  '+size+' refused: '+error.message);
    }
  }
  if (!result) throw new Error(sheet.id+': no supported size');
  writeFileSync(source,result.bytes);
  writeFileSync(join(sourceDir,sheet.id+'.json'),JSON.stringify({model:MODEL,size,quality,created:new Date().toISOString(),
    cells:sheet.cells.map(cell=>cell.id),prompt,usage:result.usage},null,2)+'\n');
  ship(source,join(shippedDir,sheet.id+'.webp'));
  console.log(sheet.id+': saved '+(result.bytes.length/1048576).toFixed(1)+' MB');
}

const queue=SURFACE_SHEETS.filter(sheet=>wanted.includes(sheet.id));
const failures=[];
await Promise.all(Array.from({length:Math.max(1,parallel)},async()=>{
  for (let sheet;(sheet=queue.shift());) {
    try {await generate(sheet);}
    catch (error) {failures.push(sheet.id);console.error(sheet.id+': '+error.message);}
  }
}));
// The game loads exactly the sheets listed here.
const shipped=SURFACE_SHEETS.map(sheet=>sheet.id).filter(id=>readdirSync(shippedDir).includes(id+'.webp'));
writeFileSync(join(shippedDir,'index.json'),JSON.stringify({version:1,sheets:shipped},null,2)+'\n');
console.log('Installed sheets: '+(shipped.join(', ') || 'none'));
if (failures.length) {
  console.error('Failed: '+failures.join(', '));
  process.exit(1);
}
