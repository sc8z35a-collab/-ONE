import {clamp} from './render.js';
import {INK_EPSILON} from './weapons.js';

export function inkReadout(actor) {
  const capacity=Math.max(1,actor.tankMax), tank=clamp(actor.tank,0,capacity), cost=actor.weapon.cost;
  const uses=Math.max(0,Math.floor((tank+INK_EPSILON)/cost));
  const unit=actor.weapon.roller?'回':'発';
  return {
    ratio:tank/capacity,after:Math.max(0,tank-cost)/capacity,cost:cost/capacity,
    percent:Math.ceil(tank/capacity*100)+'%',capacity:Math.ceil(tank)+' / '+capacity,
    usage:'消費 '+Number(cost.toFixed(4))+' / '+unit,remaining:'あと'+uses+unit,
    low:uses===0 || tank/capacity<.20,empty:uses===0,
    accessible:'残りインク '+Math.ceil(tank)+'、上限 '+capacity+'。1'+unit+'の消費 '+cost+'。あと'+uses+unit+'。'
  };
}

export function inkResult(paint,battle=null) {
  const cyan=paint.percent(0), amber=paint.percent(1);
  const bossAlive=!!battle?.boss?.active && typeof paint.percent==='function';
  const boss=bossAlive?paint.percent(2):0;
  const gaps=[Math.abs(cyan-amber)];
  if (bossAlive) gaps.push(Math.abs(cyan-boss),Math.abs(amber-boss));
  const pos=gaps.filter(g=>g>0);
  const minGap=pos.length?Math.min(...pos):0;
  let digits=minGap?Math.max(1,Math.ceil(-Math.log10(minGap))):1;
  if (minGap && (cyan.toFixed(digits)===amber.toFixed(digits) ||
      (bossAlive && (cyan.toFixed(digits)===boss.toFixed(digits) || amber.toFixed(digits)===boss.toFixed(digits))))) {
    digits++;
  }
  const scores=(bossAlive?[cyan,amber,boss]:[cyan,amber]).map(value=>value.toFixed(digits)+'%');
  let title, winner=-1;
  if (bossAlive && boss>cyan && boss>amber) {
    title='オオモノイカの勝利';
    winner=2;
  } else if (cyan===amber && (!bossAlive || cyan>=boss)) {
    title='引き分け';
    winner=-1;
  } else if (bossAlive && ((cyan===boss && cyan>amber) || (amber===boss && amber>cyan))) {
    title='引き分け';
    winner=-1;
  } else if (cyan>amber) {
    title='シアンの勝利';
    winner=0;
  } else {
    title='アンバーの勝利';
    winner=1;
  }
  return {
    scores,
    bossAlive,
    bossScore:bossAlive?scores[2]:null,
    winner,
    title
  };
}
