// Match records and the experience that carries over between matches.
// Every splat is worth EXP_PER_KILL; the total is added up once the match is
// over and kept per crew name on this device.
import {EXP_PER_KILL} from './battle.js';

const KEY='inkshift-career-v1';
export const LEVEL_EXP=300;
export const levelOf=exp=>1+Math.floor(Math.max(0,exp)/LEVEL_EXP);
const isCopy=actor=>!!(actor.cloneOf || actor.clone);

// How much a crew member did in the match: the measure behind the MVP camera.
export const activityOf=row=>row.kills*EXP_PER_KILL+row.area*.12+row.dealt*.08+row.supers*4-row.downs*3;

export function matchResults(battle,paint) {
  const cell=paint.boundX*2/paint.w*paint.boundZ*2/paint.h;
  const rows=battle.actors.filter(actor=>!isCopy(actor)).map(actor=>({
    name:actor.name,team:actor.team,isPlayer:!!actor.isPlayer,weapon:actor.weapon?.name ?? '',weaponId:actor.weapon?.id ?? '',
    kills:actor.kills??0,downs:actor.downs??0,painted:actor.painted??0,dealt:Math.round(actor.dealt??0),
    supers:actor.supers??0,subs:actor.subs??0
  }));
  // A copy still on the field at the horn hands its turf to its caster.
  for (const copy of battle.actors.filter(isCopy)) {
    const owner=rows.find(row=>row.team===copy.team && row.name===(copy.cloneOf?.name ?? String(copy.name).split('·e')[0]));
    if (owner) owner.painted+=copy.painted??0;
  }
  for (const row of rows) {
    row.area=Math.round(row.painted*cell);
    row.exp=row.kills*EXP_PER_KILL;
    row.activity=activityOf(row);
    delete row.painted;
  }
  return rows;
}

export function mostActive(rows,filter=()=>true) {
  return rows.filter(filter).reduce((best,row)=>!best || row.activity>best.activity?row:best,null);
}

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadCareer() {
  const empty={matches:0,exp:{}};
  try {
    const saved=JSON.parse(storage()?.getItem(KEY) || 'null');
    if (!saved || typeof saved!=='object' || typeof saved.exp!=='object' || !saved.exp) return empty;
    const exp={};
    for (const [name,value] of Object.entries(saved.exp)) if (Number.isFinite(value) && value>=0) exp[name]=Math.floor(value);
    return {matches:Number.isFinite(saved.matches)?Math.max(0,Math.floor(saved.matches)):0,exp};
  } catch { return empty; }
}

// Adds this match's EXP to the saved totals and returns them.
export function bankResults(rows) {
  const career=loadCareer();
  career.matches++;
  for (const row of rows) career.exp[row.name]=(career.exp[row.name]??0)+row.exp;
  try { storage()?.setItem(KEY,JSON.stringify(career)); } catch { /* The totals stay for this visit only. */ }
  return career;
}

export const playerExp=(career=loadCareer())=>career.exp.YOU ?? 0;
