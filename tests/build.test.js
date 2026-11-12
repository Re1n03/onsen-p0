/**
 * tests/build.test.js — 馆建造（Q10~Q21）
 *
 * 期望值全部写死字面数字，不由 config / 被测代码计算。
 * Q19 的 nextArrivalAt、到客拍数、相邻间隔最小值/最大值为「实测」：
 *   git archive 6f4e527 冻结副本，seed=1，逐档建到 2/3/4/5，
 *   再 closeDay → nextDay → 480 次真实 tick。
 *
 * 说明：Q13 的 EXPLORING + time>0、以及 houseLevel=5 + playerLevel=1
 * 是合成夹具（真实流程中 startExplore 要求 time===0，且玩家 1 级时馆不可能到 5）；
 * 其余拒绝夹具都是可达状态。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOUSE_BUILD } from '../config.js';
import { createInitialState } from '../src/state.js';
import { buildHouse, closeDay, nextDay } from '../src/actions.js';
import { tick } from '../src/clock.js';
import { startExplore } from '../src/explore.js';

function fresh(seed = 1) {
  return createInitialState({ seed });
}

function stock(state, count = 12) {
  state.inventory = { MAT_001: count, MAT_002: count, MAT_003: count };
}

function snapshot(state) {
  return {
    gold: state.gold,
    inventory: JSON.stringify(state.inventory),
    houseLevel: state.houseLevel,
    nextArrivalAt: state.nextArrivalAt,
    rng: state.rng.getSeed(),
    visitRng: state.visitRng.getSeed(),
    playerExp: state.playerExp,
    expLogLength: state.expLog.length,
  };
}

function expectRejected(state, reason) {
  const before = snapshot(state);
  const result = buildHouse(state);
  assert.equal(result.ok, false, `${reason} 应拒绝`);
  assert.equal(result.reason, reason);
  assert.deepEqual(snapshot(state), before, `${reason} 拒绝后状态应完全不变`);
}

// ============================================================
// Q10 配置字面值（含「不放 minPlayerLevel」与材料白名单）
// ============================================================
test('Q10 HOUSE_BUILD 字面值：MAX_LEVEL 5；四档 3000/4200/5400/6600；材料 1/2/3/4 件；无 minPlayerLevel', () => {
  assert.equal(HOUSE_BUILD.MAX_LEVEL, 5);
  assert.deepEqual(Object.keys(HOUSE_BUILD).sort(), ['LEVELS', 'MAX_LEVEL']);
  assert.deepEqual(Object.keys(HOUSE_BUILD.LEVELS), ['2', '3', '4', '5']);

  const expected = [
    [2, 3000, { MAT_001: 1, MAT_002: 1, MAT_003: 1 }],
    [3, 4200, { MAT_001: 2, MAT_002: 2, MAT_003: 2 }],
    [4, 5400, { MAT_001: 3, MAT_002: 3, MAT_003: 3 }],
    [5, 6600, { MAT_001: 4, MAT_002: 4, MAT_003: 4 }],
  ];
  for (const [level, gold, materials] of expected) {
    const plan = HOUSE_BUILD.LEVELS[level];
    assert.equal(plan.gold, gold, `馆 ${level} gold`);
    assert.deepEqual(plan.materials, materials, `馆 ${level} materials`);
    assert.equal(Object.hasOwn(plan, 'minPlayerLevel'), false, `馆 ${level} 不应有 minPlayerLevel`);
    assert.deepEqual(
      Object.keys(plan.materials).sort(),
      ['MAT_001', 'MAT_002', 'MAT_003'],
      `馆 ${level} 材料键必须严格为 MAT_001~003`,
    );
  }
});

// ============================================================
// Q11 资格逐档：4/9/14/19 拒绝，5/10/15/20 成功；playerLevel 缺失按 1
// ============================================================
test('Q11 资格逐档：4/9/14/19 拒绝；5/10/15/20 成功；playerLevel 缺失 → PLAYER_LEVEL_TOO_LOW', () => {
  const cases = [
    [2, 5, 27000],
    [3, 10, 25800],
    [4, 15, 24600],
    [5, 20, 23400],
  ];

  for (const [target, need, goldAfter] of cases) {
    const low = fresh();
    low.houseLevel = target - 1;
    low.playerLevel = need - 1;
    low.gold = 30000;
    stock(low, 12);
    expectRejected(low, 'PLAYER_LEVEL_TOO_LOW');

    const ok = fresh();
    ok.houseLevel = target - 1;
    ok.playerLevel = need;
    ok.gold = 30000;
    stock(ok, 12);
    const result = buildHouse(ok);
    assert.equal(result.ok, true, `玩家 ${need} 级应可建馆 ${target}`);
    assert.equal(ok.houseLevel, target);
    assert.equal(result.houseLevel, target);
    assert.equal(ok.gold, goldAfter);
  }

  const missing = fresh();
  missing.houseLevel = 1;
  delete missing.playerLevel;
  missing.gold = 3000;
  stock(missing, 1);
  assert.equal(buildHouse(missing).reason, 'PLAYER_LEVEL_TOO_LOW');
});

// ============================================================
// Q12 时机：time=0 成功；tick 1 次 / tick 480 次未 closeDay → BUSINESS_STARTED；closeDay 后成功
// ============================================================
test('Q12 时机：开盘前成功；营业中（含 480 秒未打烊）拒绝；真实 closeDay 后成功', () => {
  // a) 开局 time=0 → 成功
  const open = fresh();
  open.playerLevel = 5;
  open.gold = 3123;
  stock(open, 1);
  assert.equal(open.closed, false);
  assert.equal(open.time, 0);
  const opened = buildHouse(open);
  assert.equal(opened.ok, true);
  assert.equal(open.houseLevel, 2);
  assert.equal(open.gold, 123);

  // b) 真实 tick 1 次 → BUSINESS_STARTED
  const mid = fresh();
  mid.playerLevel = 5;
  mid.gold = 3123;
  stock(mid, 1);
  tick(mid);
  assert.equal(mid.time, 1);
  assert.equal(mid.closed, false);
  expectRejected(mid, 'BUSINESS_STARTED');

  // c) 真实 tick 满 480 次且未 closeDay → 仍 BUSINESS_STARTED
  const late = fresh();
  late.playerLevel = 5;
  late.gold = 3123;
  stock(late, 1);
  for (let i = 0; i < 480; i += 1) tick(late);
  assert.equal(late.time, 480);
  assert.equal(late.closed, false);
  expectRejected(late, 'BUSINESS_STARTED');

  // d) 真实 closeDay 后（closed=true，time 仍为 480）→ 成功
  const closed = fresh();
  closed.playerLevel = 5;
  for (let i = 0; i < 480; i += 1) tick(closed);
  closeDay(closed);
  assert.equal(closed.closed, true);
  assert.equal(closed.time, 480);
  closed.gold = 3123;
  stock(closed, 1);
  const afterClose = buildHouse(closed);
  assert.equal(afterClose.ok, true);
  assert.equal(closed.houseLevel, 2);
  assert.equal(closed.gold, 123);
});

// ============================================================
// Q13 拒绝顺序逐层剥离
// ============================================================
test('Q13 拒绝顺序：EXPLORING → BUSINESS_STARTED → MAX_LEVEL → PLAYER_LEVEL_TOO_LOW → NOT_ENOUGH_MATERIALS → NOT_ENOUGH_GOLD → 成功', () => {
  const state = fresh();
  startExplore(state);          // 真实 explore，但随后把 time 拨到 1（合成不可达组合）
  state.time = 1;
  state.houseLevel = 5;         // 合成：正常玩家 1 级时馆不会到 5
  state.playerLevel = 1;
  state.gold = 0;
  state.inventory = {};

  assert.equal(buildHouse(state).reason, 'EXPLORING');

  state.explore = null;         // 修正 1：离开采风
  assert.equal(buildHouse(state).reason, 'BUSINESS_STARTED');

  state.time = 0;               // 修正 2：回到开盘前
  assert.equal(buildHouse(state).reason, 'MAX_LEVEL');

  state.houseLevel = 1;         // 修正 3：馆降到 1
  assert.equal(buildHouse(state).reason, 'PLAYER_LEVEL_TOO_LOW');

  state.playerLevel = 5;        // 修正 4：玩家到 5 级
  assert.equal(buildHouse(state).reason, 'NOT_ENOUGH_MATERIALS');

  state.inventory = { MAT_001: 1, MAT_002: 1, MAT_003: 1 }; // 修正 5：材料齐
  assert.equal(buildHouse(state).reason, 'NOT_ENOUGH_GOLD');

  state.gold = 3000;            // 修正 6：金币齐
  const result = buildHouse(state);
  assert.equal(result.ok, true);
  assert.equal(state.houseLevel, 2);
  assert.equal(state.gold, 0);
  assert.deepEqual(state.inventory, {});
});

// ============================================================
// Q14 拒绝零变更（六种拒绝各一遍）
// ============================================================
test('Q14 拒绝零变更：六种拒绝都不改状态、不动两条随机流、不入经验', () => {
  // EXPLORING
  const exploring = fresh();
  startExplore(exploring);
  exploring.playerLevel = 5;
  exploring.gold = 3000;
  stock(exploring, 1);
  expectRejected(exploring, 'EXPLORING');

  // BUSINESS_STARTED
  const business = fresh();
  business.playerLevel = 5;
  business.gold = 3000;
  stock(business, 1);
  tick(business);
  expectRejected(business, 'BUSINESS_STARTED');

  // MAX_LEVEL
  const maxed = fresh();
  maxed.houseLevel = 5;
  maxed.playerLevel = 30;
  maxed.gold = 30000;
  stock(maxed, 12);
  expectRejected(maxed, 'MAX_LEVEL');

  // PLAYER_LEVEL_TOO_LOW
  const lowLevel = fresh();
  lowLevel.playerLevel = 4;
  lowLevel.gold = 3000;
  stock(lowLevel, 1);
  expectRejected(lowLevel, 'PLAYER_LEVEL_TOO_LOW');

  // NOT_ENOUGH_MATERIALS
  const noMat = fresh();
  noMat.playerLevel = 5;
  noMat.gold = 3000;
  noMat.inventory = { MAT_001: 0, MAT_002: 1, MAT_003: 1 };
  expectRejected(noMat, 'NOT_ENOUGH_MATERIALS');

  // NOT_ENOUGH_GOLD
  const poor = fresh();
  poor.playerLevel = 5;
  poor.gold = 2999;
  stock(poor, 1);
  expectRejected(poor, 'NOT_ENOUGH_GOLD');
});

// ============================================================
// Q15 成功的副作用：nextArrivalAt / 两流种子 / 经验 / 无关库存 / 返回值 / materials 拷贝
// ============================================================
test('Q15 成功副作用：nextArrivalAt 不变、两流不抽、经验不动、无关库存不动、materials 是浅拷贝', () => {
  const state = fresh();
  state.day = 4; // 非教学日，便于「入账经验」变异能在 playerExp 上显形
  state.playerExp = 42;
  state.expLog.push({
    type: 'expGained', at: null, amount: 42, source: 'test', playerLevel: 1, playerExp: 42,
  });

  state.playerLevel = 5;
  state.gold = 3123;
  state.inventory = { MAT_001: 2, MAT_002: 4, MAT_003: 2, SNK_001: 3 };
  const before = snapshot(state);

  const result = buildHouse(state);
  assert.deepEqual(result, {
    ok: true,
    houseLevel: 2,
    gold: 123,
    materials: { MAT_001: 1, MAT_002: 1, MAT_003: 1 },
  });
  assert.equal(state.houseLevel, 2);
  assert.equal(state.gold, 123);
  assert.equal(state.nextArrivalAt, before.nextArrivalAt);
  assert.equal(state.rng.getSeed(), before.rng);
  assert.equal(state.visitRng.getSeed(), before.visitRng);
  assert.equal(state.playerExp, 42);
  assert.equal(state.expLog.length, 1);
  assert.deepEqual(state.inventory, { MAT_001: 1, MAT_002: 3, MAT_003: 1, SNK_001: 3 });

  // materials 必须是浅拷贝，改它不能污染 config
  assert.notEqual(result.materials, HOUSE_BUILD.LEVELS[2].materials);
  result.materials.MAT_001 = 99;
  assert.equal(HOUSE_BUILD.LEVELS[2].materials.MAT_001, 1);
});

// ============================================================
// Q16 材料边界：每种各差一件 / 恰好 / 富余
// ============================================================
test('Q16 材料边界：三种材料各差一件都拒绝；恰好扣空；富余留 1', () => {
  for (const itemId of ['MAT_001', 'MAT_002', 'MAT_003']) {
    const short = fresh();
    short.playerLevel = 5;
    short.gold = 3000;
    short.inventory = { MAT_001: 1, MAT_002: 1, MAT_003: 1 };
    short.inventory[itemId] = 0;
    expectRejected(short, 'NOT_ENOUGH_MATERIALS');
  }

  const exact = fresh();
  exact.playerLevel = 5;
  exact.gold = 3000;
  stock(exact, 1);
  const exactResult = buildHouse(exact);
  assert.equal(exactResult.ok, true);
  assert.equal(exact.gold, 0);
  assert.deepEqual(exact.inventory, {});

  const spare = fresh();
  spare.playerLevel = 5;
  spare.gold = 3000;
  stock(spare, 2);
  const spareResult = buildHouse(spare);
  assert.equal(spareResult.ok, true);
  assert.equal(spare.gold, 0);
  assert.deepEqual(spare.inventory, { MAT_001: 1, MAT_002: 1, MAT_003: 1 });
});

// ============================================================
// Q17 金币边界：2999 拒绝 / 3000 恰好
// ============================================================
test('Q17 金币边界：2999 拒绝且状态不变；3000 恰好成功并归 0', () => {
  const short = fresh();
  short.playerLevel = 5;
  short.gold = 2999;
  stock(short, 1);
  expectRejected(short, 'NOT_ENOUGH_GOLD');

  const exact = fresh();
  exact.playerLevel = 5;
  exact.gold = 3000;
  stock(exact, 1);
  const result = buildHouse(exact);
  assert.equal(result.ok, true);
  assert.equal(exact.gold, 0);
  assert.deepEqual(exact.inventory, {});
});

// ============================================================
// Q18 满级
// ============================================================
test('Q18 满级：houseLevel 5 → MAX_LEVEL，状态不变', () => {
  const state = fresh();
  state.houseLevel = 5;
  state.playerLevel = 30;
  state.gold = 30000;
  stock(state, 12);
  expectRejected(state, 'MAX_LEVEL');
});

// ============================================================
// Q19 接线：2→5 全阶梯 + 真实 closeDay/nextDay + 一天真实 tick
// 以下 nextArrivalAt / arrivalCount / minGap / maxGap 为「实测」（seed=1）。
// ============================================================
test('Q19 接线：2→5 每档真实 closeDay/nextDay 后 nextArrivalAt 字面值，真实 tick 的间隔最小/最大字面值', () => {
  const cases = [
    { target: 2, wait: 22, arrivalCount: 17, minGap: 22, maxGap: 35 },
    { target: 3, wait: 20, arrivalCount: 18, minGap: 20, maxGap: 32 },
    { target: 4, wait: 18, arrivalCount: 20, minGap: 18, maxGap: 30 },
    { target: 5, wait: 16, arrivalCount: 22, minGap: 16, maxGap: 26 },
  ];

  for (const item of cases) {
    const state = fresh(1);
    state.playerLevel = 30;
    state.gold = 30000;
    stock(state, 12);

    while (state.houseLevel < item.target) {
      const result = buildHouse(state);
      assert.equal(result.ok, true, `建到馆 ${item.target} 的第 ${state.houseLevel + 1} 步应成功`);
    }
    assert.equal(state.houseLevel, item.target);

    closeDay(state);
    nextDay(state);
    assert.equal(state.day, 2);
    assert.equal(state.nextArrivalAt, item.wait, `馆 ${item.target} 的 nextArrivalAt（实测）`);

    for (let i = 0; i < 480; i += 1) tick(state);
    assert.equal(state.arrivals.length, item.arrivalCount, `馆 ${item.target} 的到客拍数（实测）`);
    const gaps = [];
    for (let i = 1; i < state.arrivals.length; i += 1) {
      gaps.push(state.arrivals[i] - state.arrivals[i - 1]);
    }
    assert.equal(Math.min(...gaps), item.minGap, `馆 ${item.target} 的最小间隔（实测）`);
    assert.equal(Math.max(...gaps), item.maxGap, `馆 ${item.target} 的最大间隔（实测）`);
  }
});

// ============================================================
// Q20 到访者接线：建到馆 3 后真实 nextDay（强制通过）含 ANT_R3；馆 1 对照不含
// ============================================================
test('Q20 到访者接线：馆 3 的 pendingVisitors 含 ANT_R3；馆 1 对照不含', () => {
  const built = fresh(20261111);
  built.playerLevel = 10;
  built.gold = 10000;
  built.inventory = { MAT_001: 6, MAT_002: 6, MAT_003: 6 };
  assert.equal(buildHouse(built).ok, true);
  assert.equal(buildHouse(built).ok, true);
  assert.equal(built.houseLevel, 3);

  closeDay(built);
  const originalBuilt = built.visitRng.chancePercent;
  built.visitRng.chancePercent = () => true;
  try {
    nextDay(built);
  } finally {
    built.visitRng.chancePercent = originalBuilt;
  }
  assert.deepEqual(built.pendingVisitors, [
    { npcId: 'ANT_FOREMAN', source: 'natural', day: 2 },
    { npcId: 'APPRENTICE_PALADIN', source: 'natural', day: 2 },
    { npcId: 'ANT_R3', source: 'natural', day: 2 },
  ]);

  const control = fresh(20261111);
  closeDay(control);
  const originalControl = control.visitRng.chancePercent;
  control.visitRng.chancePercent = () => true;
  try {
    nextDay(control);
  } finally {
    control.visitRng.chancePercent = originalControl;
  }
  assert.deepEqual(control.pendingVisitors, [
    { npcId: 'ANT_FOREMAN', source: 'natural', day: 2 },
    { npcId: 'APPRENTICE_PALADIN', source: 'natural', day: 2 },
  ]);
  assert.equal(control.pendingVisitors.some((entry) => entry.npcId === 'ANT_R3'), false);
});

// ============================================================
// Q21 同日连建：打烊后资源一次给足，连续建 2→3
// ============================================================
test('Q21 同日连建：打烊后 2→3 连续成功，houseLevel 与余额字面值', () => {
  const state = fresh();
  closeDay(state);
  assert.equal(state.closed, true);
  state.playerLevel = 10;
  state.gold = 7590;
  state.inventory = { MAT_001: 3, MAT_002: 3, MAT_003: 3 };

  const first = buildHouse(state);
  assert.deepEqual(first, {
    ok: true,
    houseLevel: 2,
    gold: 4590,
    materials: { MAT_001: 1, MAT_002: 1, MAT_003: 1 },
  });
  const second = buildHouse(state);
  assert.deepEqual(second, {
    ok: true,
    houseLevel: 3,
    gold: 390,
    materials: { MAT_001: 2, MAT_002: 2, MAT_003: 2 },
  });

  assert.equal(state.houseLevel, 3);
  assert.equal(state.gold, 390);
  assert.deepEqual(state.inventory, {});
  assert.equal(state.closed, true);
  assert.equal(state.time, 0);
});
