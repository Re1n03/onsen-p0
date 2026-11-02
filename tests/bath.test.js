/**
 * tests/bath.test.js — 汤池规则验收（T1~T19）
 *
 * 运行：在 E:\Project\onsen 目录执行
 *   node --test tests/bath.test.js
 *
 * 全部断言都是整数相等；数值单位见 config.js 顶部「单位总表」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPool,
  injectMaterial,
  tickPool,
  getTempZone,
  tempMatchPct,
  comfortDeltaPerSecond,
  stepSecond,
  isAngry,
  onGuestLeave,
  tipMultPctFor,
  settleBreakdown,
  settleAngryGold,
} from '../src/bath.js';

import { GUEST, SETTLEMENT } from '../config.js';

// 推进 seconds 秒（每秒先水温、再满意度、再洁净度）
function runSeconds(pool, guests, seconds) {
  let nextPool = pool;
  let nextGuests = guests;
  for (let i = 0; i < seconds; i++) {
    const result = stepSecond(nextPool, nextGuests);
    nextPool = result.pool;
    nextGuests = result.guests;
  }
  return { pool: nextPool, guests: nextGuests };
}

// ============================================================
// 水温模型 T1~T6（单位 0.1℃，450 = 45.0℃）
// ============================================================

test('T1 室温 25.0℃ 投入 MAT_002 → 立即 45.0℃', () => {
  const pool = injectMaterial(createPool(), 'MAT_002');
  assert.equal(pool.temp, 450);
});

test('T2 接 T1，40 秒后 → 37.0℃', () => {
  let pool = injectMaterial(createPool(), 'MAT_002');
  for (let i = 0; i < 40; i++) pool = tickPool(pool);
  assert.equal(pool.temp, 370);
});

test('T3 连续投入 3 次 MAT_002 → 85.0℃（ΔT 线性累加）', () => {
  let pool = createPool();
  pool = injectMaterial(pool, 'MAT_002');
  pool = injectMaterial(pool, 'MAT_002');
  pool = injectMaterial(pool, 'MAT_002');
  assert.equal(pool.temp, 850);
});

test('T4 连续投入 5 次 MAT_002 → 夹紧到 100.0℃', () => {
  let pool = createPool();
  for (let i = 0; i < 5; i++) pool = injectMaterial(pool, 'MAT_002');
  assert.equal(pool.temp, 1000);
});

test('T5 投入 MAT_001 → 10.0℃；20 秒后 → 14.0℃（向室温回升）', () => {
  let pool = injectMaterial(createPool(), 'MAT_001');
  assert.equal(pool.temp, 100);
  for (let i = 0; i < 20; i++) pool = tickPool(pool);
  assert.equal(pool.temp, 140);
});

test('T6 0 秒与 30 秒各投一次 MAT_002：水温累加，词条剩余 60 秒（不是 90 秒）', () => {
  let pool = injectMaterial(createPool(), 'MAT_002');
  // 走 30 秒：水温 450 − 2×30 = 390；词条 60 − 30 = 30
  for (let i = 0; i < 30; i++) pool = tickPool(pool);
  assert.equal(pool.temp, 390);
  assert.equal(pool.buffs.MAT_002.remainingSeconds, 30);

  // 30 秒时再投一次：390 + 200 = 590（59.0℃），词条刷新为 max(30, 60) = 60
  pool = injectMaterial(pool, 'MAT_002');
  assert.equal(pool.temp, 590);
  assert.equal(pool.buffs.MAT_002.remainingSeconds, 60);
});

// ============================================================
// 温度区间边界 T7~T8（区间含端点）
// ============================================================

test('T7 人族区间边界', () => {
  assert.equal(getTempZone('HUMAN', 380), 'FAVORITE');      // 38.0℃
  assert.equal(getTempZone('HUMAN', 379), 'TOLERANT');      // 37.9℃
  assert.equal(getTempZone('HUMAN', 320), 'TOLERANT');      // 32.0℃
  assert.equal(getTempZone('HUMAN', 319), 'UNCOMFORTABLE'); // 31.9℃
  assert.equal(getTempZone('HUMAN', 199), 'EXTREME');       // 19.9℃
});

test('T8 亡灵区间边界', () => {
  assert.equal(getTempZone('UNDEAD', 250), 'FAVORITE');     // 25.0℃
  assert.equal(getTempZone('UNDEAD', 350), 'TOLERANT');     // 35.0℃
  assert.equal(getTempZone('UNDEAD', 351), 'UNCOMFORTABLE');// 35.1℃
  assert.equal(getTempZone('UNDEAD', 400), 'UNCOMFORTABLE');// 40.0℃
  assert.equal(getTempZone('UNDEAD', 401), 'EXTREME');      // 40.1℃
});

// ============================================================
// 满意度结算 T9~T11（单位 0.01，−200 = −2.00/秒）
// ============================================================

test('T9 极限区：洁净度 100 每秒 −2.00；洁净度 10 每秒 −5.00', () => {
  assert.equal(comfortDeltaPerSecond({ race: 'UNDEAD', temp: 450, clean: 1000 }), -200);
  assert.equal(comfortDeltaPerSecond({ race: 'UNDEAD', temp: 450, clean: 100 }), -500);
});

test('T10 同池亡灵与人族、45.0℃、洁净度 100：人族 +1.50/秒，亡灵 −2.00/秒，互不影响', () => {
  assert.equal(tempMatchPct('HUMAN', 450), 150);
  assert.equal(comfortDeltaPerSecond({ race: 'HUMAN', temp: 450, clean: 1000 }), 150);
  assert.equal(comfortDeltaPerSecond({ race: 'UNDEAD', temp: 450, clean: 1000 }), -200);
});

test('T11 亡灵单独在 45.0℃：10 秒后满意度归零怒离，实收 25G', () => {
  let pool = injectMaterial(createPool(), 'MAT_002');
  let guests = [{ race: 'UNDEAD', comfort: GUEST.COMFORT_INITIAL }];
  let seconds = 0;

  while (!isAngry(guests[0]) && seconds < 120) {
    const result = stepSecond(pool, guests);
    pool = result.pool;
    guests = result.guests;
    seconds++;
  }

  assert.equal(seconds, 10);
  assert.equal(guests[0].comfort, 0);
  assert.equal(settleAngryGold(), 25);
});

// ============================================================
// 策划案 3.7 示例 T12
// ============================================================

test('T12 人族单独入座、25.0℃、0 秒投 MAT_002、停 60 秒 → 满意度 85.00，金币 76G', () => {
  let pool = injectMaterial(createPool(), 'MAT_002');
  let guests = [{ race: 'HUMAN', comfort: GUEST.COMFORT_INITIAL }];

  const result = runSeconds(pool, guests, 60);
  guests = result.guests;

  assert.equal(guests[0].comfort, 8500);                       // 85.00
  assert.equal(settleBreakdown({ comfort: guests[0].comfort }).totalGold, 76);
});

// ============================================================
// 金币结算 T13~T17（单位 G）
// ============================================================

test('T13 满意度 100、10 心、无其他加成 → 110G', () => {
  assert.equal(settleBreakdown({ comfort: 10000, heart: 10 }).totalGold, 110);
});

test('T14 满意度 80、3 心 → 50 + 30×0.8×1.3 = 81.2 → 81G', () => {
  assert.equal(settleBreakdown({ comfort: 8000, heart: 3 }).totalGold, 81);
});

test('T15 亡灵、满意度 100、MAT_003 生效（2.00×）→ 50 + 60 = 110G', () => {
  let pool = createPool();
  pool = injectMaterial(pool, 'MAT_003');
  const tipMultPct = tipMultPctFor(pool, 'UNDEAD');
  assert.equal(tipMultPct, 200);
  assert.equal(settleBreakdown({ comfort: 10000, heart: 0, tipMultPct }).totalGold, 110);
});

test('T16 满意度 50、声望 ≥ +30 → 60 + 15 = 75G', () => {
  assert.equal(settleBreakdown({ comfort: 5000, repMultPct: SETTLEMENT.REP_MULT_PCT }).totalGold, 75);
});

test('T17 金额出现 .5 时向上取整：75.5 → 76', () => {
  // 门票 50 + 小费 30 × 0.85 = 25.5 → 75.5 → 76
  assert.equal(settleBreakdown({ comfort: 8500 }).totalGold, 76);
});

// ============================================================
// 洁净度 T18~T19（单位 0.1，910 = 91.0）
// ============================================================

test('T18 一位客人停留 60 秒后离场 → 100.0 − 6.0 − 3.0 = 91.0', () => {
  let pool = createPool();
  let guests = [{ race: 'UNDEAD', comfort: GUEST.COMFORT_INITIAL }];

  const result = runSeconds(pool, guests, 60);
  pool = result.pool;
  assert.equal(pool.clean, 940);                                // 60 秒 × 0.1 = 6.0

  pool = onGuestLeave(pool);
  assert.equal(pool.clean, 910);                                // 再 −3.0
});

test('T19 两位客人同时停留 60 秒后各自离场 → 100.0 − 12.0 − 6.0 = 82.0', () => {
  let pool = createPool();
  let guests = [
    { race: 'UNDEAD', comfort: GUEST.COMFORT_INITIAL },
    { race: 'HUMAN', comfort: GUEST.COMFORT_INITIAL },
  ];

  const result = runSeconds(pool, guests, 60);
  pool = result.pool;
  assert.equal(pool.clean, 880);                                // 60 秒 × 2 × 0.1 = 12.0

  pool = onGuestLeave(pool);
  pool = onGuestLeave(pool);
  assert.equal(pool.clean, 820);                                // 再 −3.0 × 2
});
