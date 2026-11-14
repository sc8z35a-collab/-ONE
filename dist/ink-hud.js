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

export function inkResult(paint) {
  const cyan=paint.percent(0), amber=paint.percent(1), gap=Math.abs(cyan-amber);
  let digits=gap?Math.max(1,Math.ceil(-Math.log10(gap))):1;
  if (gap && cyan.toFixed(digits)===amber.toFixed(digits)) digits++;
  return {
    scores:[cyan,amber].map(value=>value.toFixed(digits)+'%'),
    title:cyan===amber?'引き分け':cyan>amber?'シアンの勝利':'アンバーの勝利'
  };
}
