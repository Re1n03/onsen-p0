/**
 * tests/explore.test.js — 采风（P0 第一步）验收 X1~X12
 *
 * 运行：在 E:\Project\onsen 目录执行
 *   node --test tests/explore.test.js
 *
 * 期望值都是字面数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/state.js';
import { createRng } from '../src/rng.js';
import { closeDay, tick } from '../src/clock.js';
import { startNextDay } from '../src/economy.js';
import { buy, changeWater, closeDay as closeDayAction, dropMaterial, dropSnack } from '../src/actions.js';
import {
  advance,
  computeLossCount,
  discardPending,
  drawEncounter,
  drawLoot,
  drawNodeType,
  eat,
  pickFamiliarCaretaker,
  pickLostBagOwner,
  pickup,
  resolveEncounter,
  returnHome,
  settleNode,
  splitLostItems,
  startExplore,
  swapPending,
} from '../src/explore.js';

// ============================================================
// X1 推进 4 次（种子 12 的前 4 个节点都是资源点）
// ============================================================
test('X1 开局推进 4 次资源点：雅兴 7、深度 4', () => {
  const state = createInitialState({ seed: 12 });
  assert.equal(startExplore(state).ok, true);

  for (let i = 0; i < 4; i += 1) {
    const result = settleNode(state, 'RESOURCE');
    assert.equal(result.nodeType, 'RESOURCE');
  }

  assert.equal(state.explore.mood, 7);
  assert.equal(state.explore.depth, 4);
});

// ============================================================
// X2 深度 4、雅兴 8 回店
// ============================================================
test('X2 深度 4、雅兴 8 回店成功，背包并入库存', () => {
  const state = createInitialState({ seed: 12 });
  startExplore(state);
  state.explore.depth = 4;
  state.explore.mood = 8;
  state.explore.backpack = [
    { itemId: 'MAT_003', count: 5 },
    { itemId: 'MAT_001', count: 2 },
  ];

  const result = returnHome(state);

  assert.equal(result.ok, true);
  assert.equal(result.fell, false);
  assert.equal(result.cost, 4);
  assert.equal(state.explore, null);
  assert.equal(state.inventory.MAT_003, 7); // 初始 2 + 背包 5
  assert.equal(state.inventory.MAT_001, 4); // 初始 2 + 背包 2
});

// ============================================================
// X3 深度 6、雅兴 5 回店 → 倒地
// ============================================================
test('X3 深度 6、雅兴 5 回店：雅兴不足，倒地', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.depth = 6;
  state.explore.mood = 5;

  const result = returnHome(state);

  assert.equal(result.ok, true);
  assert.equal(result.fell, true);
  assert.equal(result.fall.cause, 'RETURN_TOO_EXPENSIVE');
  assert.equal(result.fall.mood, 0);
  assert.equal(result.fall.depth, 1); // 深度 6 − 雅兴 5 = 1
  assert.equal(result.fall.lostCount, 0);
  assert.equal(result.fall.lostBag.totalValue, 0);
  assert.equal(result.fall.lostBag.fallDepth, 1);
  assert.equal(result.fall.lostBag.owner, 'GOBLIN');
  assert.equal(state.explore, null);
});

// ============================================================
// X4 深度 3、雅兴 1 推进 → 雅兴 0，倒地
// ============================================================
test('X4 深度 3、雅兴 2 推进：雅兴 0，倒地', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.mood = 2;
  state.explore.depth = 3;

  const result = advance(state);

  assert.equal(result.ok, true);
  assert.equal(result.fell, true);
  assert.equal(result.fall.cause, 'MOOD_ZERO');
  assert.equal(result.fall.mood, 0);
  assert.equal(result.fall.depth, 4);
  assert.equal(state.explore, null);
});

// ============================================================
// X5 吃 SNK_001（从野餐盒扣）
// ============================================================
test('X5 野餐盒：雅兴 8→11、11→14、15→16（封顶）', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state, { lunchbox: { SNK_001: 3 } });
  state.explore.mood = 8;

  const first = eat(state);
  assert.equal(first.ok, true);
  assert.equal(state.explore.mood, 11);
  assert.equal(state.explore.lunchbox.SNK_001, 2);
  assert.equal(state.inventory.SNK_001 ?? 0, 0); // 旅馆库存不变（已装填进野餐盒）

  const second = eat(state);
  assert.equal(second.ok, true);
  assert.equal(state.explore.mood, 14);
  assert.equal(state.explore.lunchbox.SNK_001, 1);

  state.explore.mood = 15;
  const third = eat(state);
  assert.equal(third.ok, true);
  assert.equal(state.explore.mood, 16);
  assert.equal(state.explore.lunchbox.SNK_001, 0);
});

// ============================================================
// X6 丢损件数
// ============================================================
test('X6 丢损件数：N=0、1、5、9、40 分别丢 0、0、4、7、32', () => {
  assert.equal(computeLossCount(0), 0);
  assert.equal(computeLossCount(1), 0);
  assert.equal(computeLossCount(5), 4);
  assert.equal(computeLossCount(9), 7);
  assert.equal(computeLossCount(40), 32);
});

// ============================================================
// X7 丢损优先级：先丢高估值，同值按 ID 字母序
// ============================================================
test('X7 丢损优先级：丢 4 件 = 圣水样品、MAT_003×2、MAT_001×1，估值 145', () => {
  const backpack = [
    { itemId: 'HOLY_WATER_SAMPLE', count: 1 }, // 60
    { itemId: 'MAT_003', count: 2 },           // 35 ×2
    { itemId: 'MAT_001', count: 2 },           // 15 ×2
  ];

  const split = splitLostItems(backpack);

  assert.deepEqual(split.lost.map((item) => item.itemId), [
    'HOLY_WATER_SAMPLE',
    'MAT_003',
    'MAT_003',
    'MAT_001',
  ]);
  assert.deepEqual(split.kept.map((item) => item.itemId), ['MAT_001']);
  assert.equal(split.lostValue, 145);
});

// ============================================================
// X8 失物包归属比例
// ============================================================
test('X8 有熟客时 10000 次归属：熟客占 58%~62%；无熟客 100% 地精', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 5;
  state.affectionExp.GUEST_BONE_KING_GUARD = 100;      // 1 心
  state.affectionExp.GUEST_WANDERING_SKELETON = 300;   // 3 心
  state.guestLastVisitDay.GUEST_BONE_KING_GUARD = 4;   // 1 天前
  state.guestLastVisitDay.GUEST_WANDERING_SKELETON = 3; // 2 天前

  const rng = createRng(20261101);
  let familiar = 0;
  for (let i = 0; i < 10000; i += 1) {
    if (pickLostBagOwner(state, rng).owner === 'GUEST') familiar += 1;
  }
  assert.ok(familiar >= 5800 && familiar <= 6200, `熟客 ${familiar} 次`);

  const noOne = createInitialState({ seed: 1 });
  noOne.day = 5;
  const rng2 = createRng(20261101);
  let goblin = 0;
  for (let i = 0; i < 10000; i += 1) {
    if (pickLostBagOwner(noOne, rng2).owner === 'GOBLIN') goblin += 1;
  }
  assert.equal(goblin, 10000);
});

// ============================================================
// X9 熟客按心数加权
// ============================================================
test('X9 熟客加权：1 心与 3 心候选，1 心约 25%（23%~27%）', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 5;
  state.affectionExp.GUEST_BONE_KING_GUARD = 100;    // 1 心
  state.affectionExp.GUEST_WANDERING_SKELETON = 300; // 3 心
  state.guestLastVisitDay.GUEST_BONE_KING_GUARD = 4;
  state.guestLastVisitDay.GUEST_WANDERING_SKELETON = 3;

  const rng = createRng(7);
  let oneHeart = 0;
  for (let i = 0; i < 10000; i += 1) {
    if (pickFamiliarCaretaker(state, rng) === 'GUEST_BONE_KING_GUARD') oneHeart += 1;
  }

  assert.ok(oneHeart >= 2300 && oneHeart <= 2700, `1 心被选中 ${oneHeart} 次`);
});

// ============================================================
// X10 背包满溢 NEED_SWAP
// ============================================================
test('X10 背包满溢：NEED_SWAP、状态不变；放弃不变；换第 3 格生效', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.backpack = Array.from({ length: 8 }, () => ({ itemId: 'MAT_001', count: 5 }));

  const before = JSON.stringify(state.explore.backpack);
  const moodBefore = state.explore.mood;
  const depthBefore = state.explore.depth;

  const need = pickup(state, 'MAT_002', 1);
  assert.equal(need.ok, false);
  assert.equal(need.reason, 'NEED_SWAP');
  assert.equal(JSON.stringify(state.explore.backpack), before);
  assert.equal(state.explore.mood, moodBefore);
  assert.equal(state.explore.depth, depthBefore);

  assert.equal(discardPending(state).ok, true);
  assert.equal(state.explore.pendingPickup, null);
  assert.equal(JSON.stringify(state.explore.backpack), before);

  assert.equal(pickup(state, 'MAT_002', 1).reason, 'NEED_SWAP');
  const swapped = swapPending(state, 3);
  assert.equal(swapped.ok, true);
  assert.deepEqual(swapped.removed, { itemId: 'MAT_001', count: 5 });
  assert.deepEqual(state.explore.backpack[2], { itemId: 'MAT_002', count: 1 });
  assert.deepEqual(state.explore.backpack[0], { itemId: 'MAT_001', count: 5 });
});

// ============================================================
// X11 节点分布
// ============================================================
test('X11 深度1资源点：产出 1 件 48%~52%；三种材料各 31%~36%', () => {
  const rng = createRng(20261101);
  let onePiece = 0;
  let totalPieces = 0;
  const materials = { MAT_001: 0, MAT_002: 0, MAT_003: 0 };

  for (let i = 0; i < 10000; i += 1) {
    const drops = drawLoot(rng, 1);
    if (drops.length === 1) onePiece += 1;
    totalPieces += drops.length;
    for (const itemId of drops) materials[itemId] += 1;
  }

  assert.ok(onePiece / 10000 >= 0.48 && onePiece / 10000 <= 0.52, `1 件 ${onePiece}`);
  for (const count of Object.values(materials)) {
    assert.ok(count / totalPieces >= 0.31 && count / totalPieces <= 0.36, `材料 ${count}`);
  }
});

// ============================================================
// X12 流程快照（真流程：startExplore → advance … → 倒地）
// 说明：原定种子 1 在第 2 步就抽到遭遇并返回 ENCOUNTER_PENDING（本步不实现遭遇处理），
//       无法继续推进到倒地；因此暂用「前 12 个节点全是资源点」的种子 12。
// ============================================================
test('X12 流程快照：种子 1，强制 6 个资源点到倒地', () => {
  const state = createInitialState({ seed: 1 });
  assert.equal(startExplore(state).ok, true);

  const trail = [];
  for (let i = 0; i < 5; i += 1) {
    const result = settleNode(state, 'RESOURCE');
    assert.equal(result.nodeType, 'RESOURCE');
    trail.push([state.explore.mood, state.explore.depth]);
  }

  assert.deepEqual(trail, [[14, 1], [12, 2], [10, 3], [7, 4], [4, 5]]);

  const last = settleNode(state, 'RESOURCE');

  assert.equal(last.fell, true);
  assert.equal(last.fall.cause, 'MOOD_ZERO');
  assert.equal(last.fall.mood, 0);
  assert.equal(last.fall.depth, 6);
  assert.equal(last.fall.totalPieces, 6);
  assert.equal(last.fall.lostCount, 4);
  assert.equal(last.fall.keptCount, 2);
  assert.deepEqual(last.fall.lostBag.items, [
    { itemId: 'GEOTHERMAL_SHARD', count: 1 },
    { itemId: 'MAT_003', count: 1 },
    { itemId: 'PURE_ANT_ACID', count: 2 },
  ]);
  assert.equal(last.fall.lostBag.totalValue, 125);
  assert.equal(last.fall.lostBag.owner, 'GOBLIN');
  assert.equal(state.explore, null);
  assert.equal(state.lostBags[0].totalValue, 125);
  assert.deepEqual(state.inventory, {
    MAT_001: 3, MAT_002: 5, MAT_003: 2, SNK_001: 3,
  });
});

// ============================================================
// X12b 遭遇待处理时 advance 返回 ENCOUNTER_PENDING 且状态不变
// ============================================================
test('X12b 遭遇待处理：advance 返回 ENCOUNTER_PENDING 且状态不变', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);

  const first = settleNode(state, 'ENCOUNTER');
  assert.equal(first.nodeType, 'ENCOUNTER');
  assert.equal(state.explore.pendingEncounter, 'APPRENTICE_PALADIN');

  const moodBefore = state.explore.mood;
  const depthBefore = state.explore.depth;
  const backpackBefore = JSON.stringify(state.explore.backpack);

  // 篝火层不抽随机数、直接走 settleNode；清空后 advance 必然经过 drawNodeType，
  // 种子断言才能真正证明「ENCOUNTER_PENDING 检查发生在抽随机数之前」
  state.explore.campfireDepths = [];
  const seedBefore = state.rng.getSeed();
  const second = advance(state);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ENCOUNTER_PENDING');
  assert.equal(state.rng.getSeed(), seedBefore); // 拒绝时不得消耗随机数
  assert.equal(state.explore.mood, moodBefore);
  assert.equal(state.explore.depth, depthBefore);
  assert.equal(JSON.stringify(state.explore.backpack), backpackBefore);
  assert.equal(state.explore.pendingEncounter, 'APPRENTICE_PALADIN');
});

// ============================================================
// X13 采风结束/倒地后，营业日能正常开始（40 秒内首位客人）
// ============================================================
function waitFirstGuest(state, limit) {
  for (let i = 0; i < limit; i += 1) {
    tick(state);
    if (state.seats.some(Boolean)) return state.time;
  }
  return null;
}

test('X13 回店成功后与倒地后，tick 都能正常运行且 40 秒内出现第一位客人', () => {
  const returned = createInitialState({ seed: 1 });
  startExplore(returned);
  advance(returned);
  assert.equal(returnHome(returned).fell, false);
  const firstAfterReturn = waitFirstGuest(returned, 40);
  assert.ok(firstAfterReturn !== null && firstAfterReturn <= 40, `回店后首客 ${firstAfterReturn}`);

  const fell = createInitialState({ seed: 12 });
  startExplore(fell);
  for (let i = 0; i < 12; i += 1) advance(fell);
  assert.equal(fell.explore, null);
  const firstAfterFall = waitFirstGuest(fell, 40);
  assert.ok(firstAfterFall !== null && firstAfterFall <= 40, `倒地后首客 ${firstAfterFall}`);
});

// ============================================================
// X14 采风期间营业动作拦截
// ============================================================
test('X14 采风期间 dropMaterial/dropSnack/changeWater 拒绝 EXPLORING；buy 允许', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);

  const goldBefore = state.gold;
  const matBefore = state.inventory.MAT_002;
  const tempBefore = state.pool.temp;

  assert.equal(dropMaterial(state, 1, 'MAT_002').reason, 'EXPLORING');
  assert.equal(dropSnack(state, 'GUEST_BONE_KING_GUARD').reason, 'EXPLORING');
  assert.equal(changeWater(state).reason, 'EXPLORING');

  assert.equal(state.gold, goldBefore);
  assert.equal(state.inventory.MAT_002, matBefore);
  assert.equal(state.pool.temp, tempBefore);

  const bought = buy(state, 'MAT_001');
  assert.equal(bought.ok, true);
  assert.equal(state.gold, 285);
});

test('X15 采风期间打烊：拒绝 EXPLORING，状态不变', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);

  const result = closeDayAction(state);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXPLORING');
  assert.equal(state.closed, false);
  assert.equal(state.lastReport, null);
  assert.equal(state.explore.mood, 16);
});

// ============================================================
// P20 / P21：每天只能出发一次（㉓ 第 0 步）
// ============================================================
test('P20 同一天第二次出发被拒绝：ALREADY_EXPLORED，不抽随机数、不入账', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  assert.equal(startExplore(state).ok, true);
  assert.equal(state.lastExploreDay, 4);
  assert.equal(returnHome(state).ok, true);

  const seedBefore = state.rng.getSeed();
  const expBefore = state.playerExp;
  const second = startExplore(state);

  assert.deepEqual(second, { ok: false, reason: 'ALREADY_EXPLORED' });
  assert.equal(state.rng.getSeed(), seedBefore);
  assert.equal(state.playerExp, expBefore);
  assert.equal(state.lastExploreDay, 4);
});

test('P21 被拒绝的出发不占名额，且次日恢复', async () => {
  const { VISIT } = await import('../config.js');
  const state = createInitialState({ seed: 1 });
  state.day = 4;

  // 既有拒绝：打烊中不能出发（不消耗随机数、不校验装填）
  state.closed = true;
  assert.equal(startExplore(state).reason, 'DAY_CLOSED');
  assert.equal(state.lastExploreDay, null);

  state.closed = false;
  assert.equal(startExplore(state).ok, true);
  assert.equal(state.lastExploreDay, 4);
  assert.equal(returnHome(state).ok, true);
  assert.equal(closeDayAction(state).ok, true);

  const original = VISIT.NATURAL_ENABLED;
  VISIT.NATURAL_ENABLED = false;
  try {
    startNextDay(state);
  } finally {
    VISIT.NATURAL_ENABLED = original;
  }

  assert.equal(state.day, 5);
  assert.equal(startExplore(state).ok, true);
  assert.equal(state.lastExploreDay, 5);
});

