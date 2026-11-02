/**
 * tests/redeem.test.js — 赎回、感冒、进入次日（Z1~Z10）
 *
 * 运行：在 E:\Project\onsen 目录执行
 *   node --test tests/redeem.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/state.js';
import { tick } from '../src/clock.js';
import {
  closeDay,
  drinkHotSpring,
  dropMaterial,
  nextDay,
  redeemLostBag,
} from '../src/actions.js';
import { advance, returnHome, startExplore } from '../src/explore.js';
import { lostBagAgeDays } from '../src/lostfound.js';

const PURE = 'PURE_ANT_ACID';

function makeGoblinBag(state, { day = 1, value = 1000, id = 'BAG_1_1' } = {}) {
  const bag = {
    id,
    items: [{ itemId: PURE, count: value / 25 }],
    totalValue: value,
    day,
    owner: 'GOBLIN',
  };
  state.lostBags.push(bag);
  return bag;
}

// ============================================================
// Z1 地精包第 2 天赎回
// ============================================================
test('Z1 第 1 天倒地、包估值 1000G 归地精：第 2 天赎回 1000G', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.gold = 1500;
  const bag = makeGoblinBag(state, { day: 1, value: 1000 });

  const result = redeemLostBag(state, bag.id);

  assert.equal(result.ok, true);
  assert.equal(result.paid, 1000);
  assert.equal(result.ratePermille, 1000);
  assert.equal(state.gold, 500);
  assert.equal(state.inventory[PURE], 40); // 1000 / 25
  assert.equal(state.lostBags.length, 0);
});

// ============================================================
// Z2 第 3 天 1100G、第 7 天 1500G、第 8 天开盘出售
// ============================================================
test('Z2 地精包：第 3 天 1100G、第 7 天 1500G、第 8 天开盘出售', () => {
  const day3 = createInitialState({ seed: 1 });
  day3.day = 3;
  day3.gold = 2000;
  const bag3 = makeGoblinBag(day3, { day: 1 });
  assert.equal(redeemLostBag(day3, bag3.id).paid, 1100);
  assert.equal(day3.gold, 900);

  const day7 = createInitialState({ seed: 1 });
  day7.day = 7;
  day7.gold = 2000;
  const bag7 = makeGoblinBag(day7, { day: 1 });
  assert.equal(redeemLostBag(day7, bag7.id).paid, 1500);
  assert.equal(day7.gold, 500);

  const day8 = createInitialState({ seed: 1 });
  day8.day = 7;
  day8.closed = true;
  makeGoblinBag(day8, { day: 1 });
  assert.equal(nextDay(day8).ok, true);
  assert.equal(day8.day, 8);
  assert.equal(day8.lostBags.length, 0);
});

// ============================================================
// Z3 熟客代管赎回
// ============================================================
test('Z3 熟客代管、3 心：赎金 730G，经验 300 → 270，心数 3 → 2', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.gold = 1500;
  state.affectionExp.GUEST_BONE_KING_GUARD = 300;
  state.lostBags.push({
    id: 'BAG_1_1',
    items: [{ itemId: PURE, count: 40 }],
    totalValue: 1000,
    day: 1,
    owner: 'GUEST',
    caretakerGuestId: 'GUEST_BONE_KING_GUARD',
  });

  const result = redeemLostBag(state, 'BAG_1_1');

  assert.equal(result.ok, true);
  assert.equal(result.paid, 730);
  assert.equal(result.ratePermille, 730);
  assert.equal(state.gold, 770);
  assert.equal(state.affectionExp.GUEST_BONE_KING_GUARD, 270);
  assert.equal(Math.floor(state.affectionExp.GUEST_BONE_KING_GUARD / 100), 2);
});

// ============================================================
// Z4 金币不足
// ============================================================
test('Z4 金币不足：拒绝 NOT_ENOUGH_GOLD，金币/库存/包不变', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.gold = 500;
  const bag = makeGoblinBag(state, { day: 1, value: 1000 });
  const invBefore = JSON.stringify(state.inventory);

  const result = redeemLostBag(state, bag.id);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NOT_ENOUGH_GOLD');
  assert.equal(state.gold, 500);
  assert.equal(JSON.stringify(state.inventory), invBefore);
  assert.equal(state.lostBags.length, 1);
});

// ============================================================
// Z5 感冒与喝热水
// ============================================================
test('Z5 感冒：第 3 槽锁定；喝热水第 19 秒仍 DRINKING、第 20 秒起可投', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;
  state.day = 2;
  state.cold = true;
  state.pool.temp = 450;

  const locked = dropMaterial(state, 3, 'MAT_002');
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, 'COLD_SLOT_LOCKED');

  const drink = drinkHotSpring(state);
  assert.equal(drink.ok, true);
  assert.equal(drink.remainingSeconds, 20);

  for (let i = 0; i < 19; i += 1) tick(state);
  assert.equal(state.drinking.remainingSeconds, 1);
  assert.equal(state.pool.temp, 412); // 45.0 − 19×0.2
  assert.equal(dropMaterial(state, 1, 'MAT_002').reason, 'DRINKING');

  tick(state); // 第 20 秒
  assert.equal(state.drinking, null);
  assert.equal(state.cold, false);
  assert.equal(state.pool.temp, 410); // 45.0 − 20×0.2
  assert.equal(dropMaterial(state, 3, 'MAT_002').ok, true);
});

// ============================================================
// Z6 多日基础：赊账利息、体验券、槽位/水温/洁净度
// ============================================================
test('Z6 第 1 天税后赊账 20 → nextDay：赊账 22、体验券 2、槽位清空、25.0℃/100.0、第 2 天', () => {
  const state = createInitialState({ seed: 1 });
  state.gold = 100;

  closeDay(state);
  assert.equal(state.gold, 0);
  assert.equal(state.credit, 20);

  state.slots = [{ itemId: 'MAT_001', remainingSeconds: 10 }, null, null];

  const result = nextDay(state);

  assert.equal(result.ok, true);
  assert.equal(state.day, 2);
  assert.equal(state.credit, 22);
  assert.equal(state.vouchers, 2);
  assert.deepEqual(state.slots, [null, null, null]);
  assert.equal(state.pool.temp, 250);
  assert.equal(state.pool.clean, 1000);
});

// ============================================================
// Z7 多个失物包各自计时
// ============================================================
test('Z7 第 1 天与第 3 天各一个包：赎回第 1 天的，第 3 天的仍在且各自计时', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.gold = 1500;
  const first = makeGoblinBag(state, { day: 1, id: 'BAG_1_1' });
  const second = makeGoblinBag(state, { day: 3, id: 'BAG_3_2' });

  const result = redeemLostBag(state, first.id);

  assert.equal(result.ok, true);
  assert.equal(result.paid, 1200); // 第 4 天：N=4 → 1200‰
  assert.equal(state.gold, 300);
  assert.equal(state.lostBags.length, 1);
  assert.equal(state.lostBags[0].id, second.id);
  assert.equal(lostBagAgeDays(state, state.lostBags[0]), 2); // 第 3 天丢，第 4 天是第 2 天
});

// ============================================================
// Z8 熟客包第 8 天出售
// ============================================================
test('Z8 熟客代管的包第 8 天开盘出售', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 7;
  state.closed = true;
  state.affectionExp.GUEST_BONE_KING_GUARD = 300;
  state.lostBags.push({
    id: 'BAG_1_1',
    items: [{ itemId: PURE, count: 40 }],
    totalValue: 1000,
    day: 1,
    owner: 'GUEST',
    caretakerGuestId: 'GUEST_BONE_KING_GUARD',
  });

  const result = nextDay(state);

  assert.equal(result.ok, true);
  assert.equal(state.day, 8);
  assert.equal(state.lostBags.length, 0);
});

// ============================================================
// Z9 回店成功不感冒、倒地次日感冒
// ============================================================
test('Z9 回店成功次日无感冒；倒地次日有感冒', () => {
  const success = createInitialState({ seed: 1 });
  startExplore(success);
  advance(success);
  assert.equal(returnHome(success).fell, false);
  closeDay(success);
  nextDay(success);
  assert.equal(success.cold, false);

  const fall = createInitialState({ seed: 12 });
  startExplore(fall);
  for (let i = 0; i < 12; i += 1) advance(fall);
  assert.equal(fall.explore, null);
  closeDay(fall);
  nextDay(fall);
  assert.equal(fall.cold, true);
});

// ============================================================
// Z10 流程快照：种子 12，倒地 → 营业 → 打烊 → nextDay → 第 2 天赎回
// ============================================================
test('Z10 流程快照：倒地估值 375、次日冷、第 2 天赎回', () => {
  const state = createInitialState({ seed: 12 });
  startExplore(state);
  // 夹具：直接用与原快照相同的 17 件背包，在深度 11、雅兴 1 时推进一次倒地
  state.explore.depth = 11;
  state.explore.mood = 1;
  state.explore.backpack = [
    { itemId: 'MAT_001', count: 5 },
    { itemId: 'MAT_002', count: 4 },
    { itemId: 'MAT_003', count: 8 },
  ];
  advance(state);
  // 夹具：空抽 29 次，对齐原种子 12 营业日的 RNG 状态，保持下方 924 等旧期望不变
  for (let i = 0; i < 29; i += 1) state.rng.nextInt(0, 1);

  assert.equal(state.gold, 300);
  assert.equal(state.coldPending, true);
  assert.equal(state.lostBags.length, 1);
  assert.equal(state.lostBags[0].id, 'BAG_1_1');
  assert.equal(state.lostBags[0].totalValue, 375);
  assert.equal(state.lostBags[0].owner, 'GOBLIN');
  assert.deepEqual(state.inventory, {
    MAT_001: 6, MAT_002: 4, MAT_003: 2, SNK_001: 3,
  });

  for (let i = 0; i < 480; i += 1) tick(state);
  const closed = closeDay(state);
  assert.equal(closed.ok, true);
  assert.equal(state.gold, 924);
  assert.equal(closed.report.guests, 14);
  assert.equal(closed.report.ticketIncome, 550);
  assert.equal(closed.report.tipIncome, 194);
  assert.equal(closed.report.totalIncome, 744);
  assert.equal(closed.report.tax, 120);
  assert.equal(closed.report.net, 624);

  const advanced = nextDay(state);
  assert.equal(advanced.ok, true);
  assert.equal(state.day, 2);
  assert.equal(state.gold, 924);
  assert.equal(state.credit, 0);
  assert.equal(state.cold, true);
  assert.equal(state.vouchers, 2);
  assert.deepEqual(state.slots, [null, null, null]);
  assert.equal(state.pool.temp, 250);
  assert.equal(state.pool.clean, 1000);
  assert.equal(state.lostBags.length, 1);

  assert.equal(dropMaterial(state, 3, 'MAT_002').reason, 'COLD_SLOT_LOCKED');

  const redeemed = redeemLostBag(state, 'BAG_1_1');
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.paid, 375);
  assert.equal(redeemed.ratePermille, 1000);
  assert.equal(state.gold, 549);
  assert.deepEqual(state.inventory, {
    MAT_001: 7, MAT_002: 8, MAT_003: 10, SNK_001: 3,
  });
  assert.equal(state.lostBags.length, 0);
});
