/**
 * actions.js — 前台动作（P0）
 *
 * 玩家能做的动作都走这里，统一返回：
 *   成功 { ok: true, ... }
 *   拒绝 { ok: false, reason: '原因' }，且保证「被拒绝时 state 一点都没变」。
 *
 * 动作：buy / dropMaterial / dropSnack / changeWater / closeDay / nextDay /
 *       drinkHotSpring / redeemLostBag。
 * 打烊后所有动作返回 DAY_CLOSED；采风期间营业动作返回 EXPLORING。
 * 不读写 DOM。
 */

import {
  AFFINITY,
  EXPLORE,
  HOUSE_BUILD,
  ITEM_VALUES,
  LOST_FOUND,
  MATERIALS,
  POOL,
  SNACKS,
  UNITS,
} from '../config.js';
import { addInventory, inventoryCount, removeInventory } from './state.js';
import { injectMaterial } from './bath.js';
import { closeDay as closeDayClock, putSnackOnTray, tryChangeWater } from './clock.js';
import { lostBagRansom } from './lostfound.js';
import { unlockedHouseLevel } from './player.js';
import { startNextDay } from './economy.js';

function fail(reason) {
  return { ok: false, reason };
}

/** 补给箱价格：材料看 MATERIALS.buyPrice，小食看 SNACKS.buyPrice；未知物品返回 null */
function buyPriceOf(itemId) {
  if (MATERIALS[itemId]) return MATERIALS[itemId].buyPrice;
  if (SNACKS[itemId]) return SNACKS[itemId].buyPrice;
  return null;
}

/**
 * 从补给箱购买 1 件。
 * 拒绝原因：DAY_CLOSED / UNKNOWN_ITEM / NOT_ENOUGH_GOLD
 */
export function buy(state, itemId) {
  if (state.closed) return fail('DAY_CLOSED');

  const price = buyPriceOf(itemId);
  if (price === null) return fail('UNKNOWN_ITEM');
  if (state.gold < price) return fail('NOT_ENOUGH_GOLD');

  state.gold -= price;
  addInventory(state, itemId, 1);

  return {
    ok: true,
    itemId,
    price,
    gold: state.gold,
    count: inventoryCount(state, itemId),
  };
}

/**
 * 把一个材料投入第 slot 个投料槽（slot 从 1 开始，共 3 个）。
 * 成功：扣 1 件库存、占住该槽、按 ΔT 改变水温。
 * 槽位会在这个材料的词条持续时间结束后自动释放（MAT_001 45s / MAT_002 60s / MAT_003 90s）。
 * 拒绝原因：DAY_CLOSED / INVALID_SLOT / SLOT_OCCUPIED / UNKNOWN_ITEM / NO_ITEM
 */
export function dropMaterial(state, slot, itemId) {
  if (state.closed) return fail('DAY_CLOSED');
  if (state.explore) return fail('EXPLORING'); // 采风期间营业动作一律拒绝
  if (state.drinking) return fail('DRINKING'); // 喝热水期间不能投料
  if (!Number.isInteger(slot) || slot < 1 || slot > state.slots.length) return fail('INVALID_SLOT');

  const activeSlots = POOL.INGREDIENT_SLOTS
    - (state.cold ? LOST_FOUND.COLD_NEXT_DAY_SLOT_PENALTY : 0);
  if (slot > activeSlots) return fail('COLD_SLOT_LOCKED');

  const index = slot - 1;
  if (state.slots[index] !== null) return fail('SLOT_OCCUPIED');
  if (!MATERIALS[itemId]) return fail('UNKNOWN_ITEM');
  if (inventoryCount(state, itemId) <= 0) return fail('NO_ITEM');

  removeInventory(state, itemId, 1);
  state.slots[index] = {
    itemId,
    remainingSeconds: MATERIALS[itemId].buffSeconds,
  };
  state.pool = injectMaterial(state.pool, itemId);

  return {
    ok: true,
    slot,
    itemId,
    temp: state.pool.temp,
    count: inventoryCount(state, itemId),
  };
}

/**
 * 给指定客人投放一份 SNK_001（只能给正在点单的客人；托盘最多 1 份）。
 * 拒绝原因：DAY_CLOSED / GUEST_NOT_FOUND / NO_ORDERING_GUEST / TRAY_FULL / NO_ITEM
 */
export function dropSnack(state, guestId) {
  if (state.closed) return fail('DAY_CLOSED');
  if (state.explore) return fail('EXPLORING'); // 采风期间营业动作一律拒绝
  if (state.drinking) return fail('DRINKING'); // 喝热水期间不能投放小食
  if (!guestId) return fail('GUEST_NOT_FOUND');
  return putSnackOnTray(state, guestId);
}

/**
 * 打烊（只能执行一次）。
 * 第一次：{ ok: true, report }
 * 第二次：{ ok: false, reason: 'ALREADY_CLOSED' }
 */
export function closeDay(state) {
  if (state.closed) return fail('ALREADY_CLOSED');
  if (state.explore) return fail('EXPLORING'); // 采风期间不能打烊
  const report = closeDayClock(state);
  return { ok: true, report };
}

/**
 * 换水清池（页面按钮用，动作层统一入口）。
 * 规则：随时可用（池里有客人也可以），20G / 8 秒，换水期间客人状态冻结。
 * 拒绝原因：DAY_CLOSED / ALREADY_CHANGING / NOT_ENOUGH_GOLD
 */
export function changeWater(state) {
  if (state.closed) return fail('DAY_CLOSED');
  if (state.explore) return fail('EXPLORING'); // 采风期间营业动作一律拒绝
  if (state.drinking) return fail('DRINKING'); // 喝热水期间不能换水
  return tryChangeWater(state);
}

/**
 * 进入次日（只能在 closeDay 之后）。
 * 内部接 economy.startNextDay：赊账利息、声望回升、体验券、槽位/水温/洁净度重置、
 * 感冒生效、失物包计时与出售都在那里一次完成。
 * 拒绝原因：EXPLORING / NOT_CLOSED
 */
export function nextDay(state) {
  if (state.explore) return fail('EXPLORING');
  if (!state.closed) return fail('NOT_CLOSED');

  const events = startNextDay(state);
  return { ok: true, day: state.day, events };
}

/**
 * 饮用热温泉水（感冒时可用）：耗时 20 秒，期间不能投料/投放小食/换水。
 * 拒绝原因：DAY_CLOSED / EXPLORING / ALREADY_DRINKING / NOT_COLD
 */
export function drinkHotSpring(state) {
  if (state.closed) return fail('DAY_CLOSED');
  if (state.explore) return fail('EXPLORING');
  if (state.drinking) return fail('ALREADY_DRINKING');
  if (!state.cold) return fail('NOT_COLD');

  state.drinking = { remainingSeconds: LOST_FOUND.COLD_CURE_SECONDS };
  return { ok: true, remainingSeconds: LOST_FOUND.COLD_CURE_SECONDS };
}

/**
 * 赎回失物包：Ransom = round(估值 × Rate‰ / 1000)；成功扣金币、物品入库存、删包；
 * 熟客代管时该熟客好感经验 −30（最低 0）。
 * 拒绝原因：EXPLORING / BAG_NOT_FOUND / NOT_ENOUGH_GOLD
 */
export function redeemLostBag(state, bagId) {
  if (state.explore) return fail('EXPLORING');

  const bag = state.lostBags.find((entry) => entry.id === bagId);
  if (!bag) return fail('BAG_NOT_FOUND');

  const quote = lostBagRansom(state, bag);
  if (state.gold < quote.gold) return fail('NOT_ENOUGH_GOLD');

  state.gold -= quote.gold;
  for (const item of bag.items) addInventory(state, item.itemId, item.count);
  state.lostBags = state.lostBags.filter((entry) => entry !== bag);

  if (bag.owner === 'GUEST' && bag.caretakerGuestId) {
    const current = state.affectionExp[bag.caretakerGuestId] ?? 0;
    state.affectionExp[bag.caretakerGuestId] = Math.max(0, current - AFFINITY.RANSOM_AFFINITY_COST);
  }

  return {
    ok: true,
    paid: quote.gold,
    ratePermille: quote.ratePermille,
    items: bag.items,
  };
}

// 备注：每日开盘赠送 1 张体验券（上限 3）属于「开盘」，不是玩家动作，
// 因此实现在 economy.startNextDay（helper 在 state.grantDailyVoucher）。

/**
 * 升级雅兴上限：等级 0~4，费用 1600/3400/6000/9000。
 * 拒绝原因（按检查顺序）：EXPLORING / MAX_LEVEL / NOT_ENOUGH_GOLD / PLAYER_LEVEL_TOO_LOW
 */
export function upgradeMood(state) {
  if (state.explore) return fail('EXPLORING');

  const level = state.moodLevel ?? 0;
  const maxLevel = EXPLORE.MOOD_LEVELS.length - 1;
  if (level >= maxLevel) return fail('MAX_LEVEL');

  const cost = EXPLORE.UPGRADE_COSTS[level];
  if (state.gold < cost) return fail('NOT_ENOUGH_GOLD');

  const minLevel = EXPLORE.UPGRADE_MIN_PLAYER_LEVEL[level];
  if ((state.playerLevel ?? 1) < minLevel) return fail('PLAYER_LEVEL_TOO_LOW');

  state.gold -= cost;
  state.moodLevel = level + 1;
  return {
    ok: true,
    level: state.moodLevel,
    moodMax: EXPLORE.MOOD_LEVELS[state.moodLevel],
    gold: state.gold,
  };
}

/**
 * 馆建造：馆等级 +1（1→2 … 4→5）。
 * 资格只读 unlockedHouseLevel（PLAYER_LEVEL.UNLOCK_HOUSE_LEVEL 单一来源）。
 * 拒绝原因（按检查顺序）：
 *   EXPLORING / BUSINESS_STARTED / MAX_LEVEL / PLAYER_LEVEL_TOO_LOW /
 *   NOT_ENOUGH_MATERIALS / NOT_ENOUGH_GOLD
 * 所有拒绝检查都在改状态、抽随机数之前；成功不重排 nextArrivalAt、不入经验、不写日报。
 * 允许开盘前（closed=false 且 time=0）与打烊后（closed=true）执行；
 * closed=false 且 time≠0（含 480 秒未 closeDay）视为营业中。
 */
export function buildHouse(state) {
  if (state.explore) return fail('EXPLORING');
  if (state.closed === false && state.time !== 0) return fail('BUSINESS_STARTED');

  const level = state.houseLevel ?? 1;
  if (level >= HOUSE_BUILD.MAX_LEVEL) return fail('MAX_LEVEL');

  const target = level + 1;
  const plan = HOUSE_BUILD.LEVELS[target];
  if (unlockedHouseLevel(state.playerLevel ?? 1) < target) return fail('PLAYER_LEVEL_TOO_LOW');

  for (const [itemId, count] of Object.entries(plan.materials)) {
    if (inventoryCount(state, itemId) < count) return fail('NOT_ENOUGH_MATERIALS');
  }
  if (state.gold < plan.gold) return fail('NOT_ENOUGH_GOLD');

  for (const [itemId, count] of Object.entries(plan.materials)) {
    removeInventory(state, itemId, count);
  }
  state.gold -= plan.gold;
  state.houseLevel = target;

  return {
    ok: true,
    houseLevel: state.houseLevel,
    gold: state.gold,
    materials: { ...plan.materials },
  };
}

/**
 * 盈余出售：材料按 50%、稀有物按 70% 收购；每件四舍五入（.5 向上）。
 * 拒绝原因：EXPLORING / NOT_SELLABLE / NO_ITEM / INVALID_COUNT
 */
export function sellItem(state, itemId, qty = 1) {
  if (state.explore) return fail('EXPLORING');
  if (!Number.isInteger(qty) || qty <= 0) return fail('INVALID_COUNT');

  const value = ITEM_VALUES[itemId];
  if (!value) return fail('NOT_SELLABLE');
  if (inventoryCount(state, itemId) < qty) return fail('NO_ITEM');

  const ratePct = MATERIALS[itemId]
    ? EXPLORE.SELL_RATE_PCT.MATERIAL
    : EXPLORE.SELL_RATE_PCT.RARE;
  const unitGold = Math.round((value * ratePct) / UNITS.PERCENT);
  const totalGold = unitGold * qty;

  removeInventory(state, itemId, qty);
  state.gold += totalGold;

  return { ok: true, unitGold, totalGold, gold: state.gold };
}
