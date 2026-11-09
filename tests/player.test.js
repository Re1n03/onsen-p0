/**
 * tests/player.test.js — 玩家等级与经验（㉓，P1~P19）
 *
 * 运行：node --test --test-isolation=none tests/player.test.js
 *
 * 期望值都是字面数字；流程类走真实 tick / nextDay / startExplore / advance /
 * negotiate / fight / flee / returnHome。经验事件只从 state.expLog 读。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VISIT } from '../config.js';
import { createInitialState } from '../src/state.js';
import { closeDay, tick } from '../src/clock.js';
import { nextDay } from '../src/actions.js';
import { advance, fight, flee, negotiate, returnHome, startExplore } from '../src/explore.js';
import { grantExp, needExp, unlockedHouseLevel } from '../src/player.js';

const expEvents = (state) => state.expLog.filter((event) => event.type === 'expGained');
const levelEvents = (state) => state.expLog.filter((event) => event.type === 'playerLevelUp');

function runTicks(state, seconds) {
  const events = [];
  for (let i = 0; i < seconds; i += 1) events.push(...tick(state));
  return events;
}

// ============================================================
// P1 教学日三天
// ============================================================
test('P1 教学日三天：第 1~3 天各跑 480 秒，经验恒为 0', () => {
  for (const day of [1, 2, 3]) {
    const state = createInitialState({ seed: 1 });
    state.day = day;
    runTicks(state, 480);
    assert.equal(state.playerExp, 0, `day ${day} 的经验`);
    assert.equal(state.playerLevel, 1, `day ${day} 的等级`);
    assert.equal(state.expLog.length, 0, `day ${day} 的事件数`);
  }
});

// ============================================================
// P2 第 4 天入账
// ============================================================
test('P2 第 4 天入账（不关日）：480 秒后 22 点经验、6 条 expGained', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  runTicks(state, 480);

  assert.equal(state.playerExp, 22);
  assert.equal(state.playerLevel, 1);
  assert.equal(expEvents(state).length, 6);
  assert.equal(state.rng.getSeed(), 3783437721);
});

// ============================================================
// P3 升级边界（恰好够）与纯函数
// ============================================================
test('P3 升级边界恰好够：59 + 1 → 2 级、余 0、1 条 playerLevelUp', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.playerExp = 59;

  const result = grantExp(state, 1, 'test');

  assert.deepEqual(result, { gained: 1, levels: 1, capped: false });
  assert.equal(state.playerLevel, 2);
  assert.equal(state.playerExp, 0);
  assert.deepEqual(levelEvents(state).map((event) => event.level), [2]);
  assert.equal(expEvents(state).length, 1);
  assert.equal(expEvents(state)[0].amount, 1);
  assert.equal(expEvents(state)[0].source, 'test');
  assert.equal(expEvents(state)[0].playerLevel, 1);
  assert.equal(expEvents(state)[0].playerExp, 60);
});

test('P3b 纯函数：needExp 与 unlockedHouseLevel 字面值', () => {
  assert.equal(needExp(1), 60);
  assert.equal(needExp(29), 242);
  assert.equal(unlockedHouseLevel(1), 1);
  assert.equal(unlockedHouseLevel(5), 2);
  assert.equal(unlockedHouseLevel(10), 3);
  assert.equal(unlockedHouseLevel(15), 4);
  assert.equal(unlockedHouseLevel(20), 5);
  assert.equal(unlockedHouseLevel(30), 5);
});

test('P3c 到达 30 级：余数置 0，且升级循环能升到满级', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.playerLevel = 29;
  state.playerExp = 241; // need(29) = 242，差 1

  const result = grantExp(state, 5, 'test');

  assert.deepEqual(result, { gained: 5, levels: 1, capped: false });
  assert.equal(state.playerLevel, 30);
  assert.equal(state.playerExp, 0); // 246 − 242 = 4，满级后余数置 0
  assert.deepEqual(levelEvents(state).map((event) => event.level), [30]);
});

// ============================================================
// P4 差 1 点
// ============================================================
test('P4 差 1 点：58 + 1 → 仍 1 级、59 点、无 playerLevelUp', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.playerExp = 58;

  const result = grantExp(state, 1, 'test');

  assert.deepEqual(result, { gained: 1, levels: 0, capped: false });
  assert.equal(state.playerLevel, 1);
  assert.equal(state.playerExp, 59);
  assert.equal(levelEvents(state).length, 0);
});

// ============================================================
// P5 跨多级
// ============================================================
test('P5 跨多级：200 点 → 4 级、余 0、3 条 playerLevelUp', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;

  const result = grantExp(state, 200, 'test');

  assert.deepEqual(result, { gained: 200, levels: 3, capped: false });
  assert.equal(state.playerLevel, 4); // 60 + 67 + 73 = 200
  assert.equal(state.playerExp, 0);
  assert.deepEqual(levelEvents(state).map((event) => event.level), [2, 3, 4]);
  assert.equal(expEvents(state).length, 1);
  assert.equal(expEvents(state)[0].amount, 200);
});

// ============================================================
// P6 满级
// ============================================================
test('P6 满级：30 级再入账 100 → 不升级、不写日志、capped', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.playerLevel = 30;
  const before = state.expLog.length;

  const result = grantExp(state, 100, 'test');

  assert.deepEqual(result, { gained: 0, levels: 0, capped: true });
  assert.equal(state.playerLevel, 30);
  assert.equal(state.playerExp, 0);
  assert.equal(state.expLog.length, before);
});

// ============================================================
// P7 倒地保留已得
// ============================================================
test('P7 倒地保留已得：4 层 28 点，返程倒地后仍是 28', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  assert.equal(startExplore(state).ok, true);
  for (let i = 0; i < 4; i += 1) advance(state);
  assert.equal(state.playerExp, 28);

  state.explore.mood = 3;
  const result = returnHome(state);

  assert.equal(result.fell, true);
  assert.equal(result.fall.depth, 1);
  assert.equal(state.playerExp, 28);
});

// ============================================================
// P8 到访者加成（N47 真实流程）
// ============================================================
test('P8 到访者加成：蚁工头 39.9℃ 停满 60 秒 → 满意度 99.00、经验 15', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 1;
  state.pool.temp = 399;
  state.pool.clean = 1000;

  const events = runTicks(state, 60);

  const left = events.filter((event) => event.type === 'guestLeft');
  assert.equal(left.length, 1);
  assert.equal(left[0].guestId, 'ANT_FOREMAN');
  assert.equal(left[0].comfort, 9900); // 99.00
  assert.equal(state.playerExp, 15); // 5（≥80）+ 10（到访者）
  assert.equal(expEvents(state).length, 1);
  assert.equal(expEvents(state)[0].amount, 15);
});

// ============================================================
// P8b 到访者怒离不给经验
// ============================================================
test('P8b 到访者怒离不给经验：10.0℃ 的蚁工头第 40 秒怒离，经验 0', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 1;
  state.pool.temp = 100; // 10.0℃，蚁族不适区（100~199），水温回升 0.2℃/秒，40 秒内不会进耐受区
  state.pool.clean = 1000;

  const first = runTicks(state, 1); // 第 1 秒入座
  state.nextArrivalAt = 999;        // 切断后续普通到客，避免人族在极限区一起怒离
  const events = [...first, ...runTicks(state, 39)]; // 第 40 秒怒离

  const angry = events.filter((event) => event.type === 'guestAngryLeft');
  assert.equal(angry.length, 1);
  assert.equal(angry[0].guestId, 'ANT_FOREMAN');
  assert.equal(angry[0].at, 40);
  assert.equal(state.playerExp, 0);
  assert.equal(expEvents(state).length, 0);
});

// ============================================================
// P9 遭遇差异
// ============================================================
test('P9 遭遇差异：谈判失败 2、成功 6、战斗 4、逃跑 1（保留此前 7）', () => {
  // 谈判失败：seed 1，chance 18
  const fail = createInitialState({ seed: 1 });
  fail.day = 4;
  startExplore(fail);
  fail.explore.pendingEncounter = 'APPRENTICE_PALADIN';
  const failed = negotiate(fail, []);
  assert.equal(failed.success, false);
  assert.equal(failed.chance, 18);
  assert.equal(fail.playerExp, 2);
  assert.equal(expEvents(fail).at(-1).source, 'explore_negotiate');

  // 谈判成功：seed 5，chance 18
  const success = createInitialState({ seed: 5 });
  success.day = 4;
  startExplore(success);
  success.explore.pendingEncounter = 'APPRENTICE_PALADIN';
  const succeeded = negotiate(success, []);
  assert.equal(succeeded.success, true);
  assert.equal(succeeded.chance, 18);
  assert.equal(success.playerExp, 6);
  assert.equal(expEvents(success).at(-1).source, 'explore_negotiate');

  // 战斗：+4
  const fighting = createInitialState({ seed: 1 });
  fighting.day = 4;
  startExplore(fighting);
  fighting.explore.pendingEncounter = 'ANT_FOREMAN';
  const fought = fight(fighting);
  assert.equal(fought.success, true);
  assert.equal(fighting.playerExp, 4);
  assert.equal(expEvents(fighting).at(-1).source, 'explore_fight');

  // 逃跑：先推进 1 层（+7），再逃跑 +1 = 8；返程之后不再加
  const fleeing = createInitialState({ seed: 1 });
  fleeing.day = 4;
  startExplore(fleeing, { backpack: { MAT_001: 1 } });
  advance(fleeing);
  assert.equal(fleeing.playerExp, 7);
  fleeing.explore.pendingEncounter = 'ANT_FOREMAN';
  const fled = flee(fleeing, 'MAT_001');
  assert.equal(fled.fled, true);
  assert.equal(fleeing.explore, null);
  assert.equal(fleeing.playerExp, 8);
  assert.equal(expEvents(fleeing).at(-1).source, 'explore_flee');
});

// ============================================================
// P10 不抽随机数
// ============================================================
test('P10 入账不抽随机数：grantExp 前后 state.rng 种子相等', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  const before = state.rng.getSeed();
  grantExp(state, 10, 'test');
  assert.equal(state.rng.getSeed(), before);
  assert.equal(state.playerExp, 10);
});

// ============================================================
// P11 不改日报（关日）
// ============================================================
test('P11 不改日报：第 4 天 480 秒 + 打烊，日报与第 1 天同数字，经验 22', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  runTicks(state, 480);
  const report = closeDay(state);

  assert.deepEqual(report, {
    day: 4,
    guests: 14,
    ticketIncome: 525,
    tipIncome: 159,
    snackIncome: 0,
    totalIncome: 684,
    tax: 120,
    net: 564,
  });
  assert.equal(state.playerExp, 22);
  assert.equal(state.rng.getSeed(), 1320036238);
});

// ============================================================
// P12 事件形状
// ============================================================
test('P12 事件形状：expGained 与 playerLevelUp 字段齐全', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  state.playerExp = 59;
  grantExp(state, 1, 'test');

  const gained = expEvents(state)[0];
  assert.equal(gained.type, 'expGained');
  assert.equal(gained.at, null);
  assert.equal(gained.amount, 1);
  assert.equal(gained.source, 'test');
  assert.equal(gained.playerLevel, 1);
  assert.equal(gained.playerExp, 60);

  const levelUp = levelEvents(state)[0];
  assert.equal(levelUp.type, 'playerLevelUp');
  assert.equal(levelUp.at, null);
  assert.equal(levelUp.level, 2);
});

// ============================================================
// P13 返程不给经验
// ============================================================
test('P13 返程不给经验：推进后 28，returnHome 后仍 28，且只有 4 条 explore_advance', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  startExplore(state);
  for (let i = 0; i < 4; i += 1) advance(state);
  assert.equal(state.playerExp, 28);

  const returned = returnHome(state);
  assert.equal(returned.fell, false);
  assert.equal(state.playerExp, 28);

  const sources = expEvents(state).map((event) => event.source);
  assert.deepEqual(sources, [
    'explore_advance', 'explore_advance', 'explore_advance', 'explore_advance',
  ]);
});

// ============================================================
// P15 教学日采风为 0
// ============================================================
test('P15 教学日采风为 0：第 3 天 0，第 4 天 28', () => {
  const teaching = createInitialState({ seed: 1 });
  teaching.day = 3;
  startExplore(teaching);
  for (let i = 0; i < 4; i += 1) advance(teaching);
  assert.equal(teaching.playerExp, 0);

  const normal = createInitialState({ seed: 1 });
  normal.day = 4;
  startExplore(normal);
  for (let i = 0; i < 4; i += 1) advance(normal);
  assert.equal(normal.playerExp, 28);
});

// ============================================================
// P16 推进被拒绝不入账
// ============================================================
test('P16 推进被拒绝不入账：三种拒绝后仍是 7', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  startExplore(state);
  advance(state);
  assert.equal(state.playerExp, 7);

  state.explore.pendingEncounter = 'ANT_FOREMAN';
  assert.equal(advance(state).reason, 'ENCOUNTER_PENDING');
  assert.equal(state.playerExp, 7);

  state.explore.pendingEncounter = null;
  state.explore.pendingPickup = { itemId: 'MAT_001', count: 1 };
  assert.equal(advance(state).reason, 'NEED_SWAP');
  assert.equal(state.playerExp, 7);

  state.explore = null;
  assert.equal(advance(state).reason, 'NOT_EXPLORING');
  assert.equal(state.playerExp, 7);
});

// ============================================================
// P17 倒地所在层给深度经验
// ============================================================
test('P17 倒地所在层给深度经验：3 层、雅兴 1 → 第 4 层倒地，经验 7', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  startExplore(state);         // seed 1：campfireDepths = [3]，第 4 层不是篝火
  state.explore.depth = 3;
  state.explore.mood = 1;

  const result = advance(state);

  assert.equal(result.ok, true);
  assert.equal(result.fell, true);
  assert.equal(result.fall.depth, 4);
  assert.equal(state.playerExp, 7);
});

// ============================================================
// P18 战斗失败倒地不给战斗经验
// ============================================================
test('P18 战斗失败倒地不给战斗经验：深度 5、雅兴 2 → 倒地、经验 0', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  startExplore(state);
  state.explore.pendingEncounter = 'ANT_FOREMAN';
  state.explore.depth = 5;
  state.explore.mood = 2;

  const result = fight(state);

  assert.equal(result.fell, true);
  assert.equal(state.playerExp, 0);
  assert.equal(expEvents(state).length, 0);
});

// ============================================================
// P19 真实跨日 3 → 4
// ============================================================
test('P19 真实跨日 3→4：第 3 天打烊+nextDay 后跑第 4 天，经验 21', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 3;
  closeDay(state);

  const original = VISIT.NATURAL_ENABLED;
  VISIT.NATURAL_ENABLED = false;
  try {
    nextDay(state);
  } finally {
    VISIT.NATURAL_ENABLED = original;
  }

  assert.equal(state.day, 4);
  runTicks(state, 480);
  // 480 秒内 6 位离场客人共 20 点；池内还剩 1 位（满意度 30.80），
  // 它的 1 点只在真实 closeDay 的 departGuest 里入账，所以关日后是 21。
  assert.equal(state.playerExp, 20);
  closeDay(state);
  assert.equal(state.playerExp, 21);
});
