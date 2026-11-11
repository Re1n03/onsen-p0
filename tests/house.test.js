/**
 * tests/house.test.js — 馆等级到客间隔查表（Q5~Q9，㉔b）
 *
 * 期望值全部写死字面数字，不由 config / 被测代码计算。
 * Q9 / Q7c 的字面值来自「改动前代码」实测：
 *   nextArrivalAt(seed=1) = 35
 *   开局抽取之后的第 1~10 次间隔 = [25,33,40,40,29,34,36,31,40,32]
 *   （口径：createInitialState({seed:1}) 已完成第 1 抽，随后连续 10 次）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOUSE_LEVELS } from '../config.js';
import { createInitialState, rollArrivalInterval } from '../src/state.js';
import { nextDay } from '../src/actions.js';
import { closeDay, tick } from '../src/clock.js';

// ============================================================
// Q5 表字面值
// ============================================================
test('Q5 HOUSE_LEVELS 1~5 字面值：25/40、22/35、20/32、18/30、16/26', () => {
  const expected = [
    [1, 25, 40],
    [2, 22, 35],
    [3, 20, 32],
    [4, 18, 30],
    [5, 16, 26],
  ];
  assert.equal(Object.keys(HOUSE_LEVELS).length, 5);
  for (const [level, min, max] of expected) {
    assert.equal(HOUSE_LEVELS[level].arrivalMinSeconds, min, `馆 ${level} 的 min`);
    assert.equal(HOUSE_LEVELS[level].arrivalMaxSeconds, max, `馆 ${level} 的 max`);
  }
});

// ============================================================
// Q6 取值范围
// ============================================================
test('Q6 取值范围：1~5 馆各 5 种子 × 2000 次，整数且在区间内，两端都出现过', () => {
  const cases = [
    [1, 25, 40],
    [2, 22, 35],
    [3, 20, 32],
    [4, 18, 30],
    [5, 16, 26],
  ];
  const seeds = [1, 2, 3, 4, 5];

  for (const [level, min, max] of cases) {
    let sawMin = false;
    let sawMax = false;
    for (const seed of seeds) {
      const state = createInitialState({ seed });
      state.houseLevel = level;
      for (let i = 0; i < 2000; i += 1) {
        const value = rollArrivalInterval(state);
        assert.equal(Number.isInteger(value), true, `馆 ${level} 种子 ${seed} 第 ${i} 次不是整数`);
        assert.ok(value >= min && value <= max, `馆 ${level} 种子 ${seed} 第 ${i} 次 = ${value}`);
        if (value === min) sawMin = true;
        if (value === max) sawMax = true;
      }
    }
    assert.equal(sawMin, true, `馆 ${level} 从未出现 min=${min}`);
    assert.equal(sawMax, true, `馆 ${level} 从未出现 max=${max}`);
  }
});

// ============================================================
// Q7 三个读取点的接线（真实流程）
// ============================================================
test('Q7 接线：nextDay 馆5 / 真实 tick 馆1与馆5 / 开局第一次抽取', () => {
  // a) 真实 nextDay：馆等级 5，200 个种子（真实流程：先 closeDay，再 nextDay）
  let anyBelow25 = false;
  for (let seed = 1; seed <= 200; seed += 1) {
    const state = createInitialState({ seed });
    state.houseLevel = 5;
    closeDay(state);
    const result = nextDay(state);
    assert.equal(result.ok, true, `种子 ${seed} 的 nextDay 应成功`);
    const wait = state.nextArrivalAt;
    assert.ok(wait >= 16 && wait <= 26, `种子 ${seed} 的 nextDay 到客等待 ${wait}`);
    if (wait < 25) anyBelow25 = true;
  }
  assert.equal(anyBelow25, true, '200 个种子中没有任何一个 < 25');

  // b) 真实 tick：馆 1 与馆 5 各跑 480 秒，用 state.arrivals（含落空/被拒，与 D1 同口径）
  //    只检查相邻拍间隔（i >= 1）；第一拍由 a) 证明。
  const seed = 20261101;
  const house1 = createInitialState({ seed });
  house1.houseLevel = 1;
  for (let i = 0; i < 480; i += 1) tick(house1);
  assert.ok(house1.arrivals.length >= 10, `馆1 到客拍数 ${house1.arrivals.length}`);
  for (let i = 1; i < house1.arrivals.length; i += 1) {
    const gap = house1.arrivals[i] - house1.arrivals[i - 1];
    assert.ok(gap >= 25 && gap <= 40, `馆1 第 ${i} 个间隔 ${gap}`);
  }

  const house5 = createInitialState({ seed });
  house5.houseLevel = 5; // 注意：nextArrivalAt 仍是开局按馆 1 抽出的旧值
  for (let i = 0; i < 480; i += 1) tick(house5);
  assert.ok(house5.arrivals.length >= 10, `馆5 到客拍数 ${house5.arrivals.length}`);
  let anyGapBelow25 = false;
  for (let i = 1; i < house5.arrivals.length; i += 1) {
    const gap = house5.arrivals[i] - house5.arrivals[i - 1];
    assert.ok(gap >= 16 && gap <= 26, `馆5 第 ${i} 个间隔 ${gap}`);
    if (gap < 25) anyGapBelow25 = true;
  }
  assert.equal(anyGapBelow25, true, '馆5 没有任何间隔 < 25');

  // c) 开局第一次抽取（馆 1）
  assert.equal(createInitialState({ seed: 1 }).nextArrivalAt, 35);
});

// ============================================================
// Q8 未知馆等级
// ============================================================
test('Q8 未知馆等级：0/6/1.5/NaN 抛 RangeError 且不抽随机数；undefined/null 按馆 1', () => {
  for (const bad of [0, 6, 1.5, NaN]) {
    const state = createInitialState({ seed: 1 });
    state.houseLevel = bad;
    const before = state.rng.getSeed();
    assert.throws(
      () => rollArrivalInterval(state),
      (error) => error instanceof RangeError && error.message === 'UNKNOWN_HOUSE_LEVEL',
      `houseLevel=${String(bad)} 应抛 RangeError('UNKNOWN_HOUSE_LEVEL')`,
    );
    assert.equal(state.rng.getSeed(), before, `houseLevel=${String(bad)} 抛错时不应抽随机数`);
  }

  for (const empty of [undefined, null]) {
    const state = createInitialState({ seed: 1 });
    state.houseLevel = empty;
    const value = rollArrivalInterval(state);
    assert.equal(Number.isInteger(value), true);
    assert.ok(value >= 25 && value <= 40, `houseLevel=${String(empty)} 应按馆 1 抽，实际 ${value}`);
  }
});

// ============================================================
// Q9 馆 1 逐字节
// ============================================================
test('Q9 馆 1 逐字节：seed 1 连续 10 次 = [25,33,40,40,29,34,36,31,40,32]', () => {
  const state = createInitialState({ seed: 1 });
  assert.equal(state.nextArrivalAt, 35);
  const values = [];
  for (let i = 0; i < 10; i += 1) values.push(rollArrivalInterval(state));
  assert.deepEqual(values, [25, 33, 40, 40, 29, 34, 36, 31, 40, 32]);
});
