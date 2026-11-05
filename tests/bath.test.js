/**
 * tests/bath.test.js — 汤池规则验收（T1~T27）
 *
 * 运行：在 D:\Project\onsen-github 目录执行
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
  tempBandSegments,
  comfortDeltaPerSecond,
  stepSecond,
  isAngry,
  onGuestLeave,
  tipMultPctFor,
  settleBreakdown,
  settleAngryGold,
  hasFactionConflict,
  tempZoneWidthBp,
  validateTempZones,
} from '../src/bath.js';

import { createInitialState, createGuest } from '../src/state.js';
import { tick } from '../src/clock.js';

import { ENCOUNTERS, GUEST, RACES, SETTLEMENT } from '../config.js';

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

// ============================================================
// T20~T27 ㉒b-1：蚁族/圣职区间、个人区间、冲突惩罚、宽度校验
// ============================================================

test('T20 种族区间边界：蚁族 28~40 / 20~46、圣职 38~45 / 32~48（含端点）', () => {
  assert.equal(getTempZone('ANT', 280), 'FAVORITE');        // 28.0℃
  assert.equal(getTempZone('ANT', 279), 'TOLERANT');        // 27.9℃
  assert.equal(getTempZone('ANT', 200), 'TOLERANT');        // 20.0℃
  assert.equal(getTempZone('ANT', 199), 'UNCOMFORTABLE');   // 19.9℃
  assert.equal(getTempZone('ANT', 100), 'UNCOMFORTABLE');   // 10.0℃（极限是严格小于）
  assert.equal(getTempZone('ANT', 99), 'EXTREME');          // 9.9℃
  assert.equal(getTempZone('ANT', 400), 'FAVORITE');        // 40.0℃
  assert.equal(getTempZone('ANT', 401), 'TOLERANT');        // 40.1℃
  assert.equal(getTempZone('ANT', 460), 'TOLERANT');        // 46.0℃
  assert.equal(getTempZone('ANT', 461), 'UNCOMFORTABLE');   // 46.1℃
  assert.equal(getTempZone('ANT', 520), 'UNCOMFORTABLE');   // 52.0℃（极限是严格大于）
  assert.equal(getTempZone('ANT', 521), 'EXTREME');         // 52.1℃

  assert.equal(getTempZone('CLERGY', 450), 'FAVORITE');     // 45.0℃
  assert.equal(getTempZone('CLERGY', 451), 'TOLERANT');     // 45.1℃
  assert.equal(getTempZone('CLERGY', 380), 'FAVORITE');     // 38.0℃
  assert.equal(getTempZone('CLERGY', 379), 'TOLERANT');     // 37.9℃
  assert.equal(getTempZone('CLERGY', 320), 'TOLERANT');     // 32.0℃
  assert.equal(getTempZone('CLERGY', 319), 'UNCOMFORTABLE');// 31.9℃
  assert.equal(getTempZone('CLERGY', 180), 'UNCOMFORTABLE');// 18.0℃
  assert.equal(getTempZone('CLERGY', 179), 'EXTREME');      // 17.9℃
  assert.equal(getTempZone('CLERGY', 480), 'TOLERANT');     // 48.0℃
  assert.equal(getTempZone('CLERGY', 481), 'UNCOMFORTABLE');// 48.1℃
  assert.equal(getTempZone('CLERGY', 520), 'UNCOMFORTABLE');// 52.0℃
  assert.equal(getTempZone('CLERGY', 521), 'EXTREME');      // 52.1℃
});

test('T21 个人区间覆盖种族区间：蚁工头 30~40/22~44、圣骑士 40~45/34~48', () => {
  assert.equal(getTempZone('ANT', 300, 'ANT_FOREMAN'), 'FAVORITE');        // 30.0℃
  assert.equal(getTempZone('ANT', 299, 'ANT_FOREMAN'), 'TOLERANT');        // 29.9℃
  assert.equal(getTempZone('ANT', 400, 'ANT_FOREMAN'), 'FAVORITE');        // 40.0℃
  assert.equal(getTempZone('ANT', 401, 'ANT_FOREMAN'), 'TOLERANT');        // 40.1℃
  assert.equal(getTempZone('ANT', 220, 'ANT_FOREMAN'), 'TOLERANT');        // 22.0℃
  assert.equal(getTempZone('ANT', 219, 'ANT_FOREMAN'), 'UNCOMFORTABLE');   // 21.9℃
  assert.equal(getTempZone('ANT', 440, 'ANT_FOREMAN'), 'TOLERANT');        // 44.0℃
  assert.equal(getTempZone('ANT', 441, 'ANT_FOREMAN'), 'UNCOMFORTABLE');   // 44.1℃
  assert.equal(getTempZone('ANT', 210, 'ANT_FOREMAN'), 'UNCOMFORTABLE');   // 种族区间本为耐受，个人区间优先
  assert.equal(getTempZone('ANT', 450, 'ANT_FOREMAN'), 'UNCOMFORTABLE');   // 种族区间本为耐受
  assert.equal(getTempZone('ANT', 99, 'ANT_FOREMAN'), 'EXTREME');          // 极限区仍按种族
  assert.equal(getTempZone('ANT', 521, 'ANT_FOREMAN'), 'EXTREME');         // 极限区仍按种族

  assert.equal(getTempZone('CLERGY', 400, 'APPRENTICE_PALADIN'), 'FAVORITE');       // 40.0℃
  assert.equal(getTempZone('CLERGY', 399, 'APPRENTICE_PALADIN'), 'TOLERANT');       // 39.9℃
  assert.equal(getTempZone('CLERGY', 450, 'APPRENTICE_PALADIN'), 'FAVORITE');       // 45.0℃
  assert.equal(getTempZone('CLERGY', 451, 'APPRENTICE_PALADIN'), 'TOLERANT');       // 45.1℃
  assert.equal(getTempZone('CLERGY', 340, 'APPRENTICE_PALADIN'), 'TOLERANT');       // 34.0℃
  assert.equal(getTempZone('CLERGY', 339, 'APPRENTICE_PALADIN'), 'UNCOMFORTABLE');  // 种族区间本为耐受
  assert.equal(getTempZone('CLERGY', 480, 'APPRENTICE_PALADIN'), 'TOLERANT');       // 48.0℃
  assert.equal(getTempZone('CLERGY', 481, 'APPRENTICE_PALADIN'), 'UNCOMFORTABLE');  // 48.1℃
  assert.equal(getTempZone('CLERGY', 179, 'APPRENTICE_PALADIN'), 'EXTREME');        // 极限区仍按种族

  // 缺省 npcId 时行为与改动前一致（种族区间）
  assert.equal(getTempZone('ANT', 210), 'TOLERANT');
  assert.equal(getTempZone('CLERGY', 339), 'TOLERANT');

  // 色带分段同样按个人区间画，极限段仍按种族（0.0~180.0 / 520.0~100.0）
  assert.deepEqual(tempBandSegments('CLERGY', 'APPRENTICE_PALADIN'), [
    { zone: 'EXTREME', from: 0, to: 180 },
    { zone: 'UNCOMFORTABLE', from: 180, to: 340 },
    { zone: 'TOLERANT', from: 340, to: 400 },
    { zone: 'FAVORITE', from: 400, to: 450 },
    { zone: 'TOLERANT', from: 450, to: 480 },
    { zone: 'UNCOMFORTABLE', from: 480, to: 520 },
    { zone: 'EXTREME', from: 520, to: 1000 },
  ]);
});

test('T22 个人区间下的每秒满意度（洁净度 100.0，单位 0.01）', () => {
  assert.equal(comfortDeltaPerSecond({ race: 'ANT', npcId: 'ANT_FOREMAN', temp: 410, clean: 1000 }), 50);
  assert.equal(comfortDeltaPerSecond({ race: 'ANT', npcId: 'ANT_FOREMAN', temp: 240, clean: 1000 }), 50);
  assert.equal(comfortDeltaPerSecond({ race: 'ANT', npcId: 'ANT_FOREMAN', temp: 150, clean: 1000 }), -50);
  assert.equal(comfortDeltaPerSecond({ race: 'ANT', npcId: 'ANT_FOREMAN', temp: 300, clean: 1000 }), 150);
  assert.equal(comfortDeltaPerSecond({ race: 'ANT', npcId: 'ANT_FOREMAN', temp: 400, clean: 1000 }), 150);

  assert.equal(comfortDeltaPerSecond({ race: 'CLERGY', npcId: 'APPRENTICE_PALADIN', temp: 410, clean: 1000 }), 150);
  assert.equal(comfortDeltaPerSecond({ race: 'CLERGY', npcId: 'APPRENTICE_PALADIN', temp: 451, clean: 1000 }), 50);
  assert.equal(comfortDeltaPerSecond({ race: 'CLERGY', npcId: 'APPRENTICE_PALADIN', temp: 339, clean: 1000 }), -50);

  // 不适罚 0.50 × Dirty_Mult 1.50 = 0.75
  assert.equal(comfortDeltaPerSecond({ race: 'ANT', npcId: 'ANT_FOREMAN', temp: 150, clean: 400 }), -75);
});

test('T23 冲突惩罚：圣职 +1.50/−1.00、亡灵极限 −2.00/−1.00（每秒）', () => {
  assert.equal(comfortDeltaPerSecond({
    race: 'CLERGY', npcId: 'APPRENTICE_PALADIN', temp: 420, clean: 1000, conflict: true,
  }), 50);
  assert.equal(comfortDeltaPerSecond({ race: 'UNDEAD', temp: 420, clean: 1000, conflict: true }), -300);
  assert.equal(comfortDeltaPerSecond({ race: 'UNDEAD', temp: 420, clean: 1000 }), -200);

  // (200 + 100) × 2.50 = 750
  assert.equal(comfortDeltaPerSecond({ race: 'UNDEAD', temp: 420, clean: 100, conflict: true }), -750);
});

test('T24 无冲突组合（stepSecond 同池判定，洁净度 100.0，水温 410）', () => {
  // 圣骑士 + 蚁工头：+1.50 / +0.50，两者都无冲突
  const antPool = stepSecond({ ...createPool(), temp: 410 }, [
    { race: 'CLERGY', guestId: 'APPRENTICE_PALADIN', comfort: 2000 },
    { race: 'ANT', guestId: 'ANT_FOREMAN', comfort: 2000 },
  ]);
  assert.equal(antPool.guests[0].comfort - 2000, 150);
  assert.equal(antPool.guests[1].comfort - 2000, 50);

  // 冲突判定本身：只认「圣职 × 魔物」，人族（ORDER）不算圣职
  assert.equal(hasFactionConflict({ race: 'CLERGY' }, { race: 'UNDEAD' }), true);
  assert.equal(hasFactionConflict({ race: 'UNDEAD' }, { race: 'CLERGY' }), true);
  assert.equal(hasFactionConflict({ race: 'CLERGY' }, { race: 'ANT' }), false);
  assert.equal(hasFactionConflict({ race: 'HUMAN' }, { race: 'UNDEAD' }), false);
  assert.equal(hasFactionConflict({ race: 'CLERGY' }, null), false);

  // 圣骑士 + 人族：+1.50 / +1.50
  const humanPool = stepSecond({ ...createPool(), temp: 410 }, [
    { race: 'CLERGY', guestId: 'APPRENTICE_PALADIN', comfort: 2000 },
    { race: 'HUMAN', guestId: 'GUEST_APPRENTICE_SWORDSMAN', comfort: 2000 },
  ]);
  assert.equal(humanPool.guests[0].comfort - 2000, 150);
  assert.equal(humanPool.guests[1].comfort - 2000, 150);

  // 人族（ORDER）+ 亡灵：不触发冲突（冲突只按「圣职」判定）
  const orderPool = stepSecond({ ...createPool(), temp: 450 }, [
    { race: 'HUMAN', guestId: 'GUEST_APPRENTICE_SWORDSMAN', comfort: 2000 },
    { race: 'UNDEAD', guestId: 'GUEST_BONE_KING_GUARD', comfort: 2000 },
  ]);
  assert.equal(orderPool.guests[0].comfort - 2000, 150);
  assert.equal(orderPool.guests[1].comfort - 2000, -200);
});

test('T25 宽度比例（万分比）：蚁工头 8333 / 8461；圣骑士 7142 / 8750', () => {
  assert.equal(tempZoneWidthBp('ANT', 'ANT_FOREMAN', 'favorite'), 8333);
  assert.equal(tempZoneWidthBp('ANT', 'ANT_FOREMAN', 'tolerant'), 8461);
  assert.equal(tempZoneWidthBp('CLERGY', 'APPRENTICE_PALADIN', 'favorite'), 7142);
  assert.equal(tempZoneWidthBp('CLERGY', 'APPRENTICE_PALADIN', 'tolerant'), 8750);
});

test('T26 配置校验：正常配置 []；反例 1 条 OVER_WIDTH、1 条 NOT_SUBSET', () => {
  assert.deepEqual(validateTempZones(), []);

  // 反例一：蚁工头耐受改成 [200,460]（子集仍成立，宽度 260 × 10000 > 260 × 8500）
  const overWidth = structuredClone(ENCOUNTERS);
  overWidth.ANT_FOREMAN.tempZone.tolerant = [200, 460];
  assert.deepEqual(validateTempZones(overWidth, RACES), [
    { npcId: 'ANT_FOREMAN', zone: 'tolerant', code: 'OVER_WIDTH' },
  ]);

  // 反例二：圣骑士喜爱改成 [375,445]（宽度 70，与种族相同不超限，但下界 375 < 380）
  const notSubset = structuredClone(ENCOUNTERS);
  notSubset.APPRENTICE_PALADIN.tempZone.favorite = [375, 445];
  assert.deepEqual(validateTempZones(notSubset, RACES), [
    { npcId: 'APPRENTICE_PALADIN', zone: 'favorite', code: 'NOT_SUBSET' },
  ]);

  // A 组：宽度恰好等于上限（蚁工头阶位 2 → 8500；221 × 10000 = 260 × 8500 = 2210000）
  // 用来钉住「> 」与「>= 」的差异：改成 >= 会误报 OVER_WIDTH
  const exactlyAtLimit = structuredClone(ENCOUNTERS);
  exactlyAtLimit.ANT_FOREMAN.tempZone.tolerant = [200, 421];
  assert.deepEqual(validateTempZones(exactlyAtLimit, RACES), []);

  // B 组：比上限多 1 个单位（222 × 10000 = 2220000 > 2210000），子集仍成立 → 只有 OVER_WIDTH
  const oneOverLimit = structuredClone(ENCOUNTERS);
  oneOverLimit.ANT_FOREMAN.tempZone.tolerant = [200, 422];
  assert.deepEqual(validateTempZones(oneOverLimit, RACES), [
    { npcId: 'ANT_FOREMAN', zone: 'tolerant', code: 'OVER_WIDTH' },
  ]);

  // C 组：上界超出种族区间（340 ≥ 320 成立，490 > 480）；宽度 150 < 160 不超限
  // 用来钉住子集判定的上界检查：去掉上界检查会返回 []
  const upperOut = structuredClone(ENCOUNTERS);
  upperOut.APPRENTICE_PALADIN.tempZone.tolerant = [340, 490];
  assert.deepEqual(validateTempZones(upperOut, RACES), [
    { npcId: 'APPRENTICE_PALADIN', zone: 'tolerant', code: 'NOT_SUBSET' },
  ]);
});

test('T27 真实 tick：圣职 × 魔物同池每秒 −1.00（5 秒 2250/500，第 7 秒亡灵怒离）', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;   // 测试期间不得到客
  state.pool.temp = 420;       // 42.0℃
  state.pool.clean = 1000;     // 100.0

  const undead = createGuest(state, 'GUEST_BONE_KING_GUARD'); // 亡灵（魔物）
  const paladin = createGuest(state, 'APPRENTICE_PALADIN');   // 圣职（遭遇 NPC 档案）
  undead.seatedAt = 0;
  paladin.seatedAt = 0;
  state.seats[0] = undead;
  state.seats[1] = paladin;

  assert.equal(state.seats[1].satiety, 50); // ENCOUNTERS 档案：固定饱腹初值，不抽随机数

  for (let i = 0; i < 5; i += 1) tick(state);
  assert.equal(state.seats[1].comfort, 2250); // 圣骑士 20.00 + (1.50 − 1.00) × 5
  assert.equal(state.seats[0].comfort, 500);  // 亡灵 20.00 − (2.00 + 1.00) × 5

  let angry = null;
  for (let i = 0; i < 2; i += 1) {
    const events = tick(state);
    const found = events.filter((event) => event.type === 'guestAngryLeft');
    if (found.length > 0) angry = found[0];
  }
  assert.equal(angry.at, 7);
  assert.equal(angry.guestId, 'GUEST_BONE_KING_GUARD');
  assert.equal(state.seats[0], null);
  assert.equal(state.seats[1].comfort, 2350); // 圣骑士 20.00 + 0.50 × 7

  // 对照组：同夹具但不放亡灵 → 第 7 秒 30.50（+1.50 × 7），差值来自冲突
  const solo = createInitialState({ seed: 1 });
  solo.nextArrivalAt = 480;
  solo.pool.temp = 420;
  solo.pool.clean = 1000;
  const only = createGuest(solo, 'APPRENTICE_PALADIN');
  only.seatedAt = 0;
  solo.seats[1] = only;

  for (let i = 0; i < 7; i += 1) tick(solo);
  assert.equal(solo.seats[1].comfort, 3050);
});
