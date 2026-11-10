/**
 * tests/labor.test.js — 体力系统 L1~L18
 *
 * 运行：node --test tests/labor.test.js
 * 期望值都是字面数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXPLORE } from '../config.js';
import { createInitialState } from '../src/state.js';
import { createRng } from '../src/rng.js';
import {
  advance,
  drawEventType,
  drawLoot,
  drawNodeType,
  eat,
  returnCost,
  returnHome,
  settleNode,
  startExplore,
} from '../src/explore.js';
import { sellItem, upgradeMood } from '../src/actions.js';

const SNACK = 'SNK_001';

test('L1 全部资源点：16 → 14 → 12 → 10 → 7 → 4 → 0 倒地', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);

  const trail = [];
  for (let i = 0; i < 5; i += 1) {
    const result = settleNode(state, 'RESOURCE');
    assert.ok(!result.fell);
    trail.push([state.explore.mood, state.explore.depth]);
  }
  assert.deepEqual(trail, [[14, 1], [12, 2], [10, 3], [7, 4], [4, 5]]);

  const last = settleNode(state, 'RESOURCE');
  assert.equal(last.fell, true);
  assert.equal(last.fall.mood, 0);
  assert.equal(last.fall.depth, 6);
  assert.equal(state.explore, null);
});

test('L2 第 1 层遭遇：赶路 1 + 遭遇 2 → 13，遭遇待处理', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);

  const node = settleNode(state, 'ENCOUNTER');
  assert.equal(node.nodeType, 'ENCOUNTER');
  assert.equal(state.explore.mood, 13);
  assert.equal(state.explore.depth, 1);
  assert.ok(state.explore.pendingEncounter);
});

test('L3 篝火：8 到第 4 层 → 10；14 → 封顶 16', () => {
  const low = createInitialState({ seed: 1 });
  startExplore(low);
  low.explore.depth = 3;
  low.explore.mood = 8;
  settleNode(low, 'CAMPFIRE');
  assert.equal(low.explore.mood, 10);
  assert.equal(low.explore.depth, 4);

  const high = createInitialState({ seed: 1 });
  startExplore(high);
  high.explore.depth = 3;
  high.explore.mood = 14;
  settleNode(high, 'CAMPFIRE');
  assert.equal(high.explore.mood, 16);
});

test('L4 篝火深度：首个 3~6 各 23%~27%；第二个 48%~52%，7~10 各 22%~28%', () => {
  const first = { 3: 0, 4: 0, 5: 0, 6: 0 };
  const second = { 7: 0, 8: 0, 9: 0, 10: 0 };
  let secondCount = 0;

  for (let seed = 1; seed <= 10000; seed += 1) {
    const state = createInitialState({ seed });
    startExplore(state);
    const depths = state.explore.campfireDepths;
    first[depths[0]] += 1;
    if (depths[1] !== undefined) {
      second[depths[1]] += 1;
      secondCount += 1;
    }
  }

  for (const depth of [3, 4, 5, 6]) {
    assert.ok(first[depth] / 10000 >= 0.23 && first[depth] / 10000 <= 0.27, `首个 ${depth}: ${first[depth]}`);
  }
  assert.ok(secondCount / 10000 >= 0.48 && secondCount / 10000 <= 0.52, `第二个 ${secondCount}`);
  for (const depth of [7, 8, 9, 10]) {
    assert.ok(second[depth] / secondCount >= 0.22 && second[depth] / secondCount <= 0.28, `第二个 ${depth}: ${second[depth]}`);
  }
});

test('L5 返程：returnCost 0/5/8；深度5雅兴5成功、雅兴4倒地；不消耗随机数', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  for (const depth of [0, 5, 8]) {
    state.explore.depth = depth;
    assert.equal(returnCost(state), depth);
  }

  const seedBefore = state.rng.getSeed();
  const success = createInitialState({ seed: 1 });
  startExplore(success);
  success.explore.depth = 5;
  success.explore.mood = 5;
  const seedBeforeSuccess = success.rng.getSeed();
  assert.equal(returnHome(success).fell, false);
  assert.equal(success.rng.getSeed(), seedBeforeSuccess);

  const fail = createInitialState({ seed: 1 });
  startExplore(fail);
  fail.explore.depth = 5;
  fail.explore.mood = 4;
  const seedBeforeFail = fail.rng.getSeed();
  assert.equal(returnHome(fail).fell, true);
  assert.equal(fail.rng.getSeed(), seedBeforeFail);

  assert.equal(typeof seedBefore, 'number');
});

test('L6 吃小食续航：3 → 6 → 9；返程 7 成功，野餐盒 0', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state, { lunchbox: { [SNACK]: 2 } });
  state.explore.depth = 7;
  state.explore.mood = 3;

  assert.equal(eat(state).mood, 6);
  assert.equal(eat(state).mood, 9);
  assert.deepEqual(state.explore.lunchbox, { SNK_001: 0 });

  const returned = returnHome(state);
  assert.equal(returned.ok, true);
  assert.equal(returned.fell, false);
  assert.equal(returned.cost, 7);
});

test('L7 装填拒绝：NO_ITEM / LUNCHBOX_FULL / BACKPACK_FULL', () => {
  // 库存 3，装 3 → 库存 0
  const ok = createInitialState({ seed: 1 });
  const okResult = startExplore(ok, { lunchbox: { [SNACK]: 3 } });
  assert.equal(okResult.ok, true);
  assert.equal(ok.inventory.SNK_001 ?? 0, 0);

  // 独立夹具：库存 0，装 2 → NO_ITEM
  const empty = createInitialState({ seed: 1 });
  empty.inventory.SNK_001 = 0;
  assert.equal(startExplore(empty, { lunchbox: { [SNACK]: 2 } }).reason, 'NO_ITEM');

  // 独立夹具：库存 6，装 5 → LUNCHBOX_FULL
  const lunch = createInitialState({ seed: 1 });
  lunch.inventory.SNK_001 = 6;
  assert.equal(startExplore(lunch, { lunchbox: { [SNACK]: 5 } }).reason, 'LUNCHBOX_FULL');

  // 独立夹具：MAT_001×41 需要 9 格 → BACKPACK_FULL
  const backpack = createInitialState({ seed: 1 });
  backpack.inventory.MAT_001 = 50;
  assert.equal(startExplore(backpack, { backpack: { MAT_001: 41 } }).reason, 'BACKPACK_FULL');

  // 2 格正常装填
  const two = createInitialState({ seed: 1 });
  two.inventory.MAT_001 = 2;
  two.inventory.MAT_003 = 1;
  const twoResult = startExplore(two, { backpack: { MAT_001: 2, MAT_003: 1 } });
  assert.equal(twoResult.ok, true);
  assert.deepEqual(two.explore.backpack, [
    { itemId: 'MAT_001', count: 2 },
    { itemId: 'MAT_003', count: 1 },
  ]);
});

test('L9 回店与倒地：野餐盒剩余回库存；倒地只丢背包 80%', () => {
  const returned = createInitialState({ seed: 1 });
  startExplore(returned, { lunchbox: { [SNACK]: 2 }, backpack: { MAT_001: 2 } });
  const result = returnHome(returned);
  assert.equal(result.fell, false);
  assert.equal(returned.inventory.SNK_001, 3); // 3 −2 +2
  assert.equal(returned.inventory.MAT_001, 2); // 2 −2 +2

  const fell = createInitialState({ seed: 1 });
  fell.inventory.MAT_001 = 6;
  startExplore(fell, { lunchbox: { [SNACK]: 2 }, backpack: { MAT_001: 4 } });
  fell.explore.mood = 1;
  const fallResult = settleNode(fell, 'RESOURCE');
  assert.equal(fallResult.fell, true);
  assert.equal(fallResult.fall.totalPieces, 4);
  assert.equal(fallResult.fall.lostCount, 3);
  assert.equal(fallResult.fall.keptCount, 1);
  assert.equal(fallResult.fall.lostBag.totalValue, 45);
  assert.equal(fell.inventory.SNK_001, 3); // 野餐盒 2 份仍回库存
  assert.equal(fell.inventory.MAT_001, 3); // 6 −4 + 保留 1
});

test('L10 升级：3000 → 500、上限19；再升 NOT_ENOUGH_GOLD；满级 MAX_LEVEL；采风 EXPLORING；等级1 出发 19', () => {
  const state = createInitialState({ seed: 1 });
  state.gold = 3000;
  state.playerLevel = 3;

  const first = upgradeMood(state);
  assert.equal(first.ok, true);
  assert.equal(state.gold, 500);
  assert.equal(first.moodMax, 19);

  const goldBefore = state.gold;
  const second = upgradeMood(state);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'NOT_ENOUGH_GOLD');
  assert.equal(state.gold, goldBefore);

  state.moodLevel = 4;
  assert.equal(upgradeMood(state).reason, 'MAX_LEVEL');

  const exploring = createInitialState({ seed: 1 });
  startExplore(exploring);
  assert.equal(upgradeMood(exploring).reason, 'EXPLORING');

  const level1 = createInitialState({ seed: 1 });
  level1.moodLevel = 1;
  startExplore(level1);
  assert.equal(level1.explore.mood, 19);
});

test('L11 泥泞：15 → 12 → 9 → 5 → 2', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.depth = 1;
  state.explore.mood = 15;
  state.explore.mudRemaining = 3;

  const trail = [];
  for (let i = 0; i < 4; i += 1) {
    const result = settleNode(state, 'RESOURCE');
    assert.ok(!result.fell);
    trail.push([state.explore.mood, state.explore.depth]);
  }
  assert.deepEqual(trail, [[12, 2], [9, 3], [5, 4], [2, 5]]);
});

test('L12 偷食与野餐篮', () => {
  const steal = createInitialState({ seed: 1 });
  startExplore(steal, { lunchbox: { [SNACK]: 2 } });
  steal.explore.mood = 10;
  settleNode(steal, 'EVENT', 'BEAST_STEAL');
  assert.deepEqual(steal.explore.lunchbox, { SNK_001: 1 });
  assert.equal(steal.explore.mood, 9);

  const empty = createInitialState({ seed: 1 });
  startExplore(empty);
  empty.explore.mood = 10;
  settleNode(empty, 'EVENT', 'BEAST_STEAL');
  assert.equal(empty.explore.mood, 8);

  const kill = createInitialState({ seed: 1 });
  startExplore(kill);
  kill.explore.mood = 1;
  const killed = settleNode(kill, 'EVENT', 'BEAST_STEAL');
  assert.equal(killed.fell, true);
  assert.equal(killed.fall.mood, 0);

  const basket = createInitialState({ seed: 1 });
  startExplore(basket, { lunchbox: { [SNACK]: 2 } });
  settleNode(basket, 'EVENT', 'PICNIC_BASKET');
  assert.deepEqual(basket.explore.lunchbox, { SNK_001: 3 });

  const full = createInitialState({ seed: 1 });
  full.inventory.SNK_001 = 4;
  startExplore(full, { lunchbox: { [SNACK]: 4 } });
  settleNode(full, 'EVENT', 'PICNIC_BASKET');
  assert.deepEqual(full.explore.lunchbox, { SNK_001: 4 });
});

test('L13 节点与事件概率；偷食权重覆盖为 100 后 42%~58%', () => {
  const rng = createRng(20261101);
  const nodes = { RESOURCE: 0, ENCOUNTER: 0, EVENT: 0 };
  const events = { MUD: 0, PICNIC_BASKET: 0, BEAST_STEAL: 0 };

  for (let i = 0; i < 10000; i += 1) {
    const node = drawNodeType(rng);
    nodes[node] += 1;
    if (node === 'EVENT') events[drawEventType(rng)] += 1;
  }

  assert.ok(nodes.RESOURCE / 10000 >= 0.53 && nodes.RESOURCE / 10000 <= 0.57, `资源 ${nodes.RESOURCE}`);
  assert.ok(nodes.ENCOUNTER / 10000 >= 0.26 && nodes.ENCOUNTER / 10000 <= 0.30, `遭遇 ${nodes.ENCOUNTER}`);
  assert.ok(nodes.EVENT / 10000 >= 0.15 && nodes.EVENT / 10000 <= 0.19, `事件 ${nodes.EVENT}`);
  assert.equal(events.BEAST_STEAL, 0);

  const totalEvents = events.MUD + events.PICNIC_BASKET;
  assert.ok(events.MUD / totalEvents >= 0.48 && events.MUD / totalEvents <= 0.52, `泥泞 ${events.MUD}`);
  assert.ok(events.PICNIC_BASKET / totalEvents >= 0.48 && events.PICNIC_BASKET / totalEvents <= 0.52, `野餐篮 ${events.PICNIC_BASKET}`);

  EXPLORE.EVENT_WEIGHT.BEAST_STEAL = 100;
  try {
    let beast = 0;
    for (let i = 0; i < 10000; i += 1) {
      if (drawEventType(rng) === 'BEAST_STEAL') beast += 1;
    }
    assert.ok(beast / 10000 >= 0.42 && beast / 10000 <= 0.58, `偷食 ${beast}`);
  } finally {
    EXPLORE.EVENT_WEIGHT.BEAST_STEAL = 0;
  }
});

test('L14 稀有物梯度与内部权重', () => {
  const rng = createRng(777);
  const rareShare = {};
  for (const depth of [1, 2, 4, 6, 8]) {
    let rare = 0;
    let total = 0;
    for (let i = 0; i < 10000; i += 1) {
      for (const itemId of drawLoot(rng, depth)) {
        total += 1;
        if (!itemId.startsWith('MAT_')) rare += 1;
      }
    }
    rareShare[depth] = rare / total;
  }
  assert.equal(rareShare[1], 0);
  assert.ok(rareShare[2] >= 0.08 && rareShare[2] <= 0.12, `d2 ${rareShare[2]}`);
  assert.ok(rareShare[4] >= 0.28 && rareShare[4] <= 0.32, `d4 ${rareShare[4]}`);
  assert.ok(rareShare[6] >= 0.48 && rareShare[6] <= 0.52, `d6 ${rareShare[6]}`);
  assert.ok(rareShare[8] >= 0.68 && rareShare[8] <= 0.72, `d8 ${rareShare[8]}`);

  const low = {};
  let lowRare = 0;
  for (let i = 0; i < 10000; i += 1) {
    for (const itemId of drawLoot(rng, 5)) {
      if (!itemId.startsWith('MAT_')) {
        low[itemId] = (low[itemId] ?? 0) + 1;
        lowRare += 1;
      }
    }
  }
  assert.ok(low.PURE_ANT_ACID / lowRare >= 0.57 && low.PURE_ANT_ACID / lowRare <= 0.63, `d5 蚁酸 ${low.PURE_ANT_ACID}`);

  const high = {};
  let highRare = 0;
  for (let i = 0; i < 10000; i += 1) {
    for (const itemId of drawLoot(rng, 7)) {
      if (!itemId.startsWith('MAT_')) {
        high[itemId] = (high[itemId] ?? 0) + 1;
        highRare += 1;
      }
    }
  }
  assert.ok(high.HOLY_WATER_SAMPLE / highRare >= 0.37 && high.HOLY_WATER_SAMPLE / highRare <= 0.43, `d7 圣水 ${high.HOLY_WATER_SAMPLE}`);
});

test('L15 出售：36/8/10/18/28/42；EXPLORING / NO_ITEM / NOT_SELLABLE', () => {
  const cases = [
    ['MAT_003', 2, 36, 336],
    ['MAT_001', 1, 8, 308],
    ['MAT_002', 1, 10, 310],
    ['PURE_ANT_ACID', 1, 18, 318],
    ['GEOTHERMAL_SHARD', 1, 28, 328],
    ['HOLY_WATER_SAMPLE', 1, 42, 342],
  ];
  for (const [itemId, qty, totalGold, gold] of cases) {
    const state = createInitialState({ seed: 1 });
    state.inventory[itemId] = (state.inventory[itemId] ?? 0) + qty;
    const result = sellItem(state, itemId, qty);
    assert.equal(result.ok, true);
    assert.equal(result.totalGold, totalGold);
    assert.equal(state.gold, gold);
  }

  const exploring = createInitialState({ seed: 1 });
  startExplore(exploring);
  assert.equal(sellItem(exploring, 'MAT_001', 1).reason, 'EXPLORING');

  const empty = createInitialState({ seed: 1 });
  empty.inventory.MAT_001 = 0;
  assert.equal(sellItem(empty, 'MAT_001', 1).reason, 'NO_ITEM');

  const notSellable = createInitialState({ seed: 1 });
  assert.equal(sellItem(notSellable, 'VOUCHER', 1).reason, 'NOT_SELLABLE');
});

test('L16 雅兴2、深度0、强制资源点：1 → 0 倒地，背包空、无奖励', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.mood = 2;

  const result = settleNode(state, 'RESOURCE');

  assert.equal(result.fell, true);
  assert.equal(result.fall.mood, 0);
  assert.equal(result.fall.depth, 1);
  assert.equal(result.fall.totalPieces, 0);
  assert.equal(result.fall.lostCount, 0);
});

test('L17 流程快照：带 4 小食 + 1 MAT_001，回店成功并出售背包战利品', () => {
  const state = createInitialState({ seed: 1 });
  state.inventory.SNK_001 = 4;
  startExplore(state, { lunchbox: { SNK_001: 4 }, backpack: { MAT_001: 1 } });

  const trail = [];
  const snap = () => ({
    mood: state.explore.mood,
    depth: state.explore.depth,
    lunchbox: structuredClone(state.explore.lunchbox),
    backpack: structuredClone(state.explore.backpack),
  });

  trail.push({ act: 'start', ...snap() });

  let guard = 0;
  while (state.explore && guard < 30) {
    guard += 1;
    if (state.explore.pendingEncounter) return assert.fail('L17 快照不应出现遭遇');
    if (state.explore.mood <= state.explore.depth + 5) break;
    const result = advance(state);
    trail.push({ act: 'advance', nodeType: result.nodeType, eventType: result.eventType ?? null, ...snap() });
  }

  const backpackBefore = structuredClone(state.explore.backpack);
  const returned = returnHome(state);
  assert.equal(returned.fell, false);
  assert.equal(returned.cost, 5);

  const brought = {};
  for (const slot of backpackBefore) brought[slot.itemId] = (brought[slot.itemId] ?? 0) + slot.count;
  for (const [itemId, qty] of Object.entries(brought)) sellItem(state, itemId, qty);

  assert.deepEqual(trail, [
    { act: 'start', mood: 16, depth: 0, lunchbox: { SNK_001: 4 }, backpack: [{ itemId: 'MAT_001', count: 1 }] },
    { act: 'advance', nodeType: 'EVENT', eventType: 'PICNIC_BASKET', mood: 15, depth: 1, lunchbox: { SNK_001: 4 }, backpack: [{ itemId: 'MAT_001', count: 1 }] },
    { act: 'advance', nodeType: 'RESOURCE', eventType: null, mood: 13, depth: 2, lunchbox: { SNK_001: 4 }, backpack: [{ itemId: 'MAT_001', count: 1 }, { itemId: 'MAT_002', count: 2 }] },
    { act: 'advance', nodeType: 'CAMPFIRE', eventType: null, mood: 16, depth: 3, lunchbox: { SNK_001: 4 }, backpack: [{ itemId: 'MAT_001', count: 1 }, { itemId: 'MAT_002', count: 2 }] },
    { act: 'advance', nodeType: 'RESOURCE', eventType: null, mood: 13, depth: 4, lunchbox: { SNK_001: 4 }, backpack: [{ itemId: 'MAT_001', count: 2 }, { itemId: 'MAT_002', count: 2 }] },
    { act: 'advance', nodeType: 'RESOURCE', eventType: null, mood: 10, depth: 5, lunchbox: { SNK_001: 4 }, backpack: [{ itemId: 'MAT_001', count: 2 }, { itemId: 'MAT_002', count: 2 }, { itemId: 'PURE_ANT_ACID', count: 1 }] },
  ]);

  assert.deepEqual(brought, { MAT_001: 2, MAT_002: 2, PURE_ANT_ACID: 1 });
  assert.equal(state.gold, 354);
  assert.deepEqual(state.inventory, {
    MAT_001: 1, MAT_002: 4, MAT_003: 2, SNK_001: 4,
  });
});

test('L18 雅兴夹紧：深度3、雅兴1 推进倒地，fall.mood 不为负', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.depth = 3;
  state.explore.mood = 1;

  const result = settleNode(state, 'RESOURCE');

  assert.equal(result.fell, true);
  assert.equal(result.fall.mood, 0);
  assert.equal(result.fall.depth, 4);
  assert.equal(state.explore, null);
});
