/**
 * tests/upgrade.test.js — 雅兴升级的玩家等级门槛（Q1~Q4）
 *
 * 期望值全部写死字面数字，不由 config / 被测代码计算。
 * 门槛占位值：0→1 / 1→2 / 2→3 / 3→4 = 玩家等级 3 / 8 / 13 / 18
 * 价格：2500 / 6000 / 11000 / 18000
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/state.js';
import { upgradeMood } from '../src/actions.js';
import { startExplore } from '../src/explore.js';

/** 新状态：玩家等级 30，保证只测价格/其它条件 */
function stateAtLevel30() {
  const state = createInitialState({ seed: 1 });
  state.playerLevel = 30;
  return state;
}

// ============================================================
// Q1 价格逐档
// ============================================================
const PRICE_CASES = [
  { level: 0, price: 2500, short: 2499, moodMax: 19 },
  { level: 1, price: 6000, short: 5999, moodMax: 22 },
  { level: 2, price: 11000, short: 10999, moodMax: 25 },
  { level: 3, price: 18000, short: 17999, moodMax: 28 },
];

test('Q1 价格逐档：恰好价格成功且金币归 0；价格−1 返回 NOT_ENOUGH_GOLD', () => {
  for (const item of PRICE_CASES) {
    const state = stateAtLevel30();
    state.moodLevel = item.level;
    state.gold = item.price;

    const result = upgradeMood(state);
    assert.equal(result.ok, true, `雅兴 ${item.level}→${item.level + 1} 应成功`);
    assert.equal(result.level, item.level + 1);
    assert.equal(result.moodMax, item.moodMax);
    assert.equal(result.gold, 0);
    assert.equal(state.gold, 0);
    assert.equal(state.moodLevel, item.level + 1);
    assert.equal(state.playerLevel, 30);

    const poor = stateAtLevel30();
    poor.moodLevel = item.level;
    poor.gold = item.short;

    const denied = upgradeMood(poor);
    assert.equal(denied.ok, false, `雅兴 ${item.level}→${item.level + 1} 少 1G 应失败`);
    assert.equal(denied.reason, 'NOT_ENOUGH_GOLD');
    assert.equal(poor.gold, item.short);
    assert.equal(poor.moodLevel, item.level);
  }
});

// ============================================================
// Q2 门槛逐档
// ============================================================
const THRESHOLD_CASES = [
  { level: 0, below: 2, at: 3, price: 2500, moodMax: 19, goldAfter: 997500 },
  { level: 1, below: 7, at: 8, price: 6000, moodMax: 22, goldAfter: 994000 },
  { level: 2, below: 12, at: 13, price: 11000, moodMax: 25, goldAfter: 989000 },
  { level: 3, below: 17, at: 18, price: 18000, moodMax: 28, goldAfter: 982000 },
];

test('Q2 门槛逐档：2/7/12/17 拒绝；3/8/13/18 成功且 moodMax 19/22/25/28', () => {
  for (const item of THRESHOLD_CASES) {
    const low = createInitialState({ seed: 1 });
    low.moodLevel = item.level;
    low.playerLevel = item.below;
    low.gold = 1_000_000;

    const denied = upgradeMood(low);
    assert.equal(denied.ok, false, `玩家 ${item.below} 级不足以升雅兴 ${item.level}→${item.level + 1}`);
    assert.equal(denied.reason, 'PLAYER_LEVEL_TOO_LOW');
    assert.equal(low.gold, 1_000_000);
    assert.equal(low.moodLevel, item.level);
    assert.equal(low.playerLevel, item.below);

    const ok = createInitialState({ seed: 1 });
    ok.moodLevel = item.level;
    ok.playerLevel = item.at;
    ok.gold = 1_000_000;

    const result = upgradeMood(ok);
    assert.equal(result.ok, true, `玩家 ${item.at} 级应可升雅兴 ${item.level}→${item.level + 1}`);
    assert.equal(result.moodMax, item.moodMax);
    assert.equal(ok.moodLevel, item.level + 1);
    assert.equal(ok.playerLevel, item.at);
    assert.equal(ok.gold, item.goldAfter);
  }

  // 补充：playerLevel 缺失时按 1 级处理 → 仍拒绝（对应实现 (state.playerLevel ?? 1)）
  const missing = createInitialState({ seed: 1 });
  delete missing.playerLevel;
  missing.moodLevel = 0;
  missing.gold = 2500;
  assert.equal(upgradeMood(missing).reason, 'PLAYER_LEVEL_TOO_LOW');
  assert.equal(missing.gold, 2500);
});

// ============================================================
// Q3 拒绝顺序
// ============================================================
test('Q3 拒绝顺序：EXPLORING → MAX_LEVEL → NOT_ENOUGH_GOLD → PLAYER_LEVEL_TOO_LOW', () => {
  // 采风中 + 金币不足 + 等级不足 → EXPLORING
  const exploring = createInitialState({ seed: 1 });
  startExplore(exploring);
  exploring.gold = 0;
  exploring.playerLevel = 1;
  assert.equal(upgradeMood(exploring).reason, 'EXPLORING');

  // 采风中 + 满级 → 仍是 EXPLORING（证明 EXPLORING 先于 MAX_LEVEL）
  const exploringFull = createInitialState({ seed: 1 });
  startExplore(exploringFull);
  exploringFull.moodLevel = 4;
  exploringFull.gold = 0;
  exploringFull.playerLevel = 1;
  assert.equal(upgradeMood(exploringFull).reason, 'EXPLORING');

  // 满级 + 金币不足 + 等级不足 → MAX_LEVEL
  const full = createInitialState({ seed: 1 });
  full.moodLevel = 4;
  full.gold = 0;
  full.playerLevel = 1;
  assert.equal(upgradeMood(full).reason, 'MAX_LEVEL');

  // 金币不足 + 等级不足 → NOT_ENOUGH_GOLD
  const poor = createInitialState({ seed: 1 });
  poor.moodLevel = 0;
  poor.gold = 2499;
  poor.playerLevel = 2;
  assert.equal(upgradeMood(poor).reason, 'NOT_ENOUGH_GOLD');

  // 金币足 + 等级不足 → PLAYER_LEVEL_TOO_LOW
  const low = createInitialState({ seed: 1 });
  low.moodLevel = 0;
  low.gold = 2500;
  low.playerLevel = 2;
  assert.equal(upgradeMood(low).reason, 'PLAYER_LEVEL_TOO_LOW');
});

// ============================================================
// Q4 被拒绝不动状态、不抽随机数
// ============================================================
function withExp(state) {
  state.playerExp = 42;
  state.expLog.push({
    type: 'expGained', at: null, amount: 42, source: 'test', playerLevel: 1, playerExp: 42,
  });
  return state;
}

function snapshot(state) {
  return {
    gold: state.gold,
    moodLevel: state.moodLevel,
    playerLevel: state.playerLevel,
    playerExp: state.playerExp,
    expLogLength: state.expLog.length,
    rngSeed: state.rng.getSeed(),
  };
}

test('Q4 被拒绝不动状态、不抽随机数；成功升级也不动经验', () => {
  const cases = [];

  const exploring = withExp(createInitialState({ seed: 1 }));
  startExplore(exploring);
  exploring.gold = 0;
  exploring.playerLevel = 1;
  cases.push(['EXPLORING', exploring]);

  const full = withExp(createInitialState({ seed: 1 }));
  full.moodLevel = 4;
  full.gold = 0;
  full.playerLevel = 1;
  cases.push(['MAX_LEVEL', full]);

  const poor = withExp(createInitialState({ seed: 1 }));
  poor.moodLevel = 0;
  poor.gold = 2499;
  poor.playerLevel = 2;
  cases.push(['NOT_ENOUGH_GOLD', poor]);

  const low = withExp(createInitialState({ seed: 1 }));
  low.moodLevel = 0;
  low.gold = 2500;
  low.playerLevel = 2;
  cases.push(['PLAYER_LEVEL_TOO_LOW', low]);

  for (const [reason, state] of cases) {
    const before = snapshot(state);
    const result = upgradeMood(state);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(snapshot(state), before, `${reason} 拒绝后状态应与调用前完全一致`);
    assert.equal(snapshot(state).playerExp, 42);
    assert.equal(snapshot(state).expLogLength, 1);
  }

  // 成功升级：经验与经验日志不动
  const success = withExp(stateAtLevel30());
  success.moodLevel = 0;
  success.gold = 2500;
  const beforeSuccess = snapshot(success);
  const result = upgradeMood(success);
  assert.equal(result.ok, true);
  assert.equal(success.gold, 0);
  assert.equal(success.moodLevel, 1);
  assert.equal(success.playerExp, beforeSuccess.playerExp);
  assert.equal(success.expLog.length, beforeSuccess.expLogLength);
  assert.equal(success.rng.getSeed(), beforeSuccess.rngSeed);
  assert.equal(success.playerExp, 42);
  assert.equal(success.expLog.length, 1);
});
