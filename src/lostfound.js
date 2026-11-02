/**
 * lostfound.js — 失物包计时、赎金与到期出售（§5.1、§5.2、附录 A.7/A.8/A.12）
 *
 * 不读写 DOM；不直接改金币/库存（赎回由 actions.redeemLostBag 完成），
 * 只负责「天数、费率、赎金、到期清理」这几件纯计算。
 */

import { LOST_FOUND } from '../config.js';
import { getHeart } from './state.js';

/** 失物当日算第 1 天：N = 当前日 − 丢失日 + 1 */
export function lostBagAgeDays(state, bag) {
  return state.day - bag.day + 1;
}

/** 地精保管费率（‰）：N≤2 为 1000；N=3~7 每天 +100；上限 1500 */
export function goblinRatePermille(ageDays) {
  if (ageDays <= LOST_FOUND.GOBLIN_GRACE_DAYS) return LOST_FOUND.RATE_BASE_PERMILLE;
  const rate = LOST_FOUND.RATE_BASE_PERMILLE
    + (ageDays - LOST_FOUND.GOBLIN_GRACE_DAYS) * LOST_FOUND.GOBLIN_DAILY_SURCHARGE_PERMILLE;
  return Math.min(rate, LOST_FOUND.GOBLIN_MAX_RATE_PERMILLE);
}

/** 熟客代管费率（‰）：Rate = 1000 − 90 × Heart，Heart 取赎回当下的心数 */
export function familiarRatePermille(heart) {
  return Math.max(
    LOST_FOUND.FAMILIAR_MIN_RATE_PERMILLE,
    LOST_FOUND.RATE_BASE_PERMILLE - LOST_FOUND.FAMILIAR_RATE_STEP_PERMILLE * heart,
  );
}

/** 赎金 = round(估值合计 × Rate‰ / 1000)，整数运算 */
export function ransomGold(totalValue, ratePermille) {
  return Math.round((totalValue * ratePermille) / LOST_FOUND.RATE_BASE_PERMILLE);
}

/** 当前赎回报价：地精看天数，熟客看代管人当前心数 */
export function lostBagRansom(state, bag) {
  const ageDays = lostBagAgeDays(state, bag);

  if (bag.owner === 'GUEST' && bag.caretakerGuestId) {
    const heart = getHeart(state.affectionExp[bag.caretakerGuestId] ?? 0);
    const ratePermille = familiarRatePermille(heart);
    return { owner: 'GUEST', ageDays, heart, ratePermille, gold: ransomGold(bag.totalValue, ratePermille) };
  }

  const ratePermille = goblinRatePermille(ageDays);
  return { owner: 'GOBLIN', ageDays, ratePermille, gold: ransomGold(bag.totalValue, ratePermille) };
}

/** 次日开盘：第 8 天（N≥8）的失物包被出售，永久消失 */
export function processLostBagsOnNextDay(state) {
  const sold = [];
  const kept = [];
  for (const bag of state.lostBags) {
    if (lostBagAgeDays(state, bag) >= LOST_FOUND.GOBLIN_SELL_DAY) sold.push(bag);
    else kept.push(bag);
  }
  state.lostBags = kept;
  return sold;
}
