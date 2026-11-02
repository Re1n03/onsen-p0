/**
 * tests/day.test.js — 营业日主循环验收（D1~D11）
 *
 * 运行：在 E:\Project\onsen 目录执行
 *   node --test tests/day.test.js
 *
 * 所有期望值都是字面数字，不由 config 或被测函数计算。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, createGuest, gainAffinity, rollFragmentDrop } from '../src/state.js';
import { createRng } from '../src/rng.js';
import { injectMaterial, comfortDeltaPerSecond } from '../src/bath.js';
import { dropMaterial } from '../src/actions.js';
import {
  closeDay,
  enqueueGuest,
  putSnackOnTray,
  tick,
  tryChangeWater,
} from '../src/clock.js';
import { startNextDay } from '../src/economy.js';

function run(state, seconds) {
  const events = [];
  for (let i = 0; i < seconds; i++) events.push(...tick(state));
  return events;
}

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

// ============================================================
// D1 到客间隔
// ============================================================
test('D1 到客间隔都在 25~40 秒之间', () => {
  const state = createInitialState({ seed: 20261101 });
  run(state, 480);

  assert.ok(state.arrivals.length >= 10, `到客次数 ${state.arrivals.length}`);
  assert.ok(state.arrivals[0] >= 25 && state.arrivals[0] <= 40, `首客 ${state.arrivals[0]}`);

  for (let i = 1; i < state.arrivals.length; i++) {
    const gap = state.arrivals[i] - state.arrivals[i - 1];
    assert.ok(gap >= 25 && gap <= 40, `第 ${i} 个间隔 ${gap}`);
  }
});

// ============================================================
// D2 候位上限 3：第 4 位直接离开
// ============================================================
test('D2 候位满 3 人时第 4 位直接离开', () => {
  const state = createInitialState({ seed: 1 });
  state.queue = [
    { guestId: 'GUEST_BONE_KING_GUARD', enqueuedAt: 0 },
    { guestId: 'GUEST_WANDERING_SKELETON', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
  ];

  const event = enqueueGuest(state, 'GUEST_BONE_KING_GUARD', 0);

  assert.equal(event.type, 'guestRejected');
  assert.equal(event.reason, 'QUEUE_FULL');
  assert.equal(state.queue.length, 3);
});

// ============================================================
// D3 候位耐心 45 秒：超时离开，无收益、无声望变化
// ============================================================
test('D3 候位超过 45 秒离开，且不产生收益/声望变化', () => {
  const state = createInitialState({ seed: 5 });
  state.nextArrivalAt = 480; // 本测试只看候位，关掉后续到客

  const guestA = createGuest(state, 'GUEST_BONE_KING_GUARD');
  const guestB = createGuest(state, 'GUEST_WANDERING_SKELETON');
  guestA.seatedAt = 0;
  guestB.seatedAt = 0;
  state.seats[0] = guestA;
  state.seats[1] = guestB;

  enqueueGuest(state, 'GUEST_APPRENTICE_SWORDSMAN', 0);

  const events = run(state, 45);
  const timeouts = eventsOfType(events, 'queueTimeout');

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].at, 45);
  assert.equal(state.queue.length, 0);
  assert.equal(state.gold, 300);
  assert.equal(state.reputation.MONSTER, 0);
});

// ============================================================
// D4 换水（第 8 步新规则：随时可用，池内有客人也可以）
// ============================================================
test('D4 换水：池空时成功扣 20G 并恢复洁净度', () => {
  const state = createInitialState({ seed: 1 });
  state.pool.clean = 400;

  const accepted = tryChangeWater(state);
  assert.equal(accepted.ok, true);
  assert.equal(state.gold, 280);

  run(state, 8);
  assert.equal(state.pool.clean, 1000);
});

test('D4b 池内有客人时也可以换水（旧「仅池空时可用」规则作废）', () => {
  const state = createInitialState({ seed: 1 });
  state.seats[0] = createGuest(state, 'GUEST_BONE_KING_GUARD');

  const result = tryChangeWater(state);

  assert.equal(result.ok, true);
  assert.equal(state.gold, 280);
  assert.equal(state.waterChange.remainingSeconds, 8);
});

// ============================================================
// D5 小食：点单 → 食用；120 秒无人食用回收
// ============================================================
test('D5 SNK_001 点单 → 食用（+20 满意度、18G）；120 秒无人食用回收', () => {
  const state = createInitialState({ seed: 9 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  guest.satiety = 40;
  guest.seatedAt = 0;
  state.seats[0] = guest;

  const orderEvents = run(state, 30);
  const orders = eventsOfType(orderEvents, 'snackOrdered');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].at, 30);
  assert.equal(state.seats[0].orderOpen, true);

  const placed = putSnackOnTray(state);
  assert.equal(placed.ok, true);
  assert.equal(placed.claimedBy, 'GUEST_BONE_KING_GUARD');
  assert.equal(state.inventory.SNK_001, 2);

  const eatEvents = run(state, 5);
  const eaten = eventsOfType(eatEvents, 'snackEaten');
  assert.equal(eaten.length, 1);
  assert.equal(eaten[0].at, 35);
  assert.equal(eaten[0].comfortGain, 2000);
  assert.equal(eaten[0].gold, 18);
  assert.equal(state.daily.snackIncome, 18);
  assert.equal(state.gold, 318);

  // 120 秒无人食用 → 回收为堆肥，无惩罚
  const idle = createInitialState({ seed: 10 });
  idle.nextArrivalAt = 480;
  const idlePlaced = putSnackOnTray(idle);
  assert.equal(idlePlaced.ok, true);
  assert.equal(idlePlaced.claimedBy, null);
  assert.equal(idle.inventory.SNK_001, 2);

  run(idle, 119);
  assert.equal(idle.tray.length, 1);

  const recycleEvents = run(idle, 1);
  const recycled = eventsOfType(recycleEvents, 'snackRecycled');
  assert.equal(recycled.length, 1);
  assert.equal(recycled[0].at, 120);
  assert.equal(idle.tray.length, 0);
  assert.equal(idle.gold, 300);
});

// ============================================================
// D6 碎片掉落率（固定种子 10000 次）
// ============================================================
test('D6 固定种子下 10000 次碎片掉落率在 28%~32%', () => {
  const rng = createRng(20261101);
  let hit = 0;
  for (let i = 0; i < 10000; i++) {
    if (rollFragmentDrop(rng)) hit += 1;
  }
  assert.ok(hit >= 2800 && hit <= 3200, `命中 ${hit} 次`);
});

// ============================================================
// D7 好感日上限 60（AC-010）
// ============================================================
test('D7 同一 NPC 一天内好感经验合计不超过 60', () => {
  const state = createInitialState({ seed: 1 });

  assert.equal(gainAffinity(state, 'GUEST_BONE_KING_GUARD', 10), 10);
  assert.equal(gainAffinity(state, 'GUEST_BONE_KING_GUARD', 20), 20);
  assert.equal(gainAffinity(state, 'GUEST_BONE_KING_GUARD', 30), 30);
  assert.equal(gainAffinity(state, 'GUEST_BONE_KING_GUARD', 20), 0);

  assert.equal(state.dailyAffinityExp.GUEST_BONE_KING_GUARD, 60);
  assert.equal(state.affectionExp.GUEST_BONE_KING_GUARD, 60);
});

// ============================================================
// D8 赊账与次日利息
// ============================================================
test('D8 金币 100、税 120 → 赊账 20，次日变 22', () => {
  const state = createInitialState({ seed: 1 });
  state.gold = 100;

  const report = closeDay(state);
  assert.equal(report.tax, 120);
  assert.equal(state.gold, 0);
  assert.equal(state.credit, 20);

  startNextDay(state);
  assert.equal(state.credit, 22);
});

// ============================================================
// D9 只有 1 个池时，赊账超额也不停业
// ============================================================
test('D9 赊账 600 且只有 1 个池 → 不触发停业', () => {
  const state = createInitialState({ seed: 1 });
  state.credit = 600;
  state.poolCount = 1;

  const events = startNextDay(state);

  assert.equal(state.poolCount, 1);
  assert.equal(eventsOfType(events, 'poolClosed').length, 0);
});

// ============================================================
// D10 打烊时池内客人按正常离场结算（含小费）
// ============================================================
test('D10 打烊时池内客人含小费结算', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.comfort = 10000; // 100.00
  guest.seatedAt = 0;
  state.seats[0] = guest;

  const report = closeDay(state);

  assert.equal(report.ticketIncome, 50);
  assert.equal(report.tipIncome, 30);
  assert.equal(report.totalIncome, 80);
  assert.equal(state.gold, 260); // 300 + 80 − 120
});

// ============================================================
// D11 日报净收益 = 总收入 − 税
// ============================================================
test('D11 日报净收益 = 总收入 − 税', () => {
  const state = createInitialState({ seed: 1 });
  state.gold = 1000;
  state.daily.ticketIncome = 400;
  state.daily.tipIncome = 132;
  state.daily.snackIncome = 70;

  const report = closeDay(state);

  assert.equal(report.totalIncome, 602);
  assert.equal(report.tax, 120);
  assert.equal(report.net, 482);
  // 收入在离店/食用时就已入账，打烊只再扣一次税：1000 − 120 = 880
  assert.equal(state.gold, 880);
});

// ============================================================
// D12 声望自然回升只对负声望生效
// ============================================================
test('D12 声望 −50 次日 −40；−5 次日 0；+20 次日仍 +20', () => {
  const state = createInitialState({ seed: 1 });
  state.reputation.MONSTER = -50;
  state.reputation.ORDER = -5;
  state.reputation.NEUTRAL = 20;

  startNextDay(state);

  assert.equal(state.reputation.MONSTER, -40);
  assert.equal(state.reputation.ORDER, 0);
  assert.equal(state.reputation.NEUTRAL, 20);
});

// ============================================================
// D13 赊账偿还：先扣税，再用剩余金币还赊账
// ============================================================
test('D13 赊账 100、金币 500、税 120 → 金币 280、赊账 0', () => {
  const state = createInitialState({ seed: 1 });
  state.credit = 100;
  state.gold = 500;

  const report = closeDay(state);

  assert.equal(report.tax, 120);
  assert.equal(state.gold, 280);
  assert.equal(state.credit, 0);
});

// ============================================================
// D14 熟客同日再访
// ============================================================
test('D14 同一位熟客离场后，同一营业日内可再次入座', () => {
  const state = createInitialState({ seed: 11 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  run(state, 60);
  assert.equal(state.seats[0], null);

  enqueueGuest(state, 'GUEST_APPRENTICE_SWORDSMAN', state.time);
  tick(state);

  assert.equal(state.seats[0].guestId, 'GUEST_APPRENTICE_SWORDSMAN');
  assert.equal(state.seats.filter(Boolean).length, 1);
});

// ============================================================
// D15 集成：离店收入入账，且与日报一致
// ============================================================
test('D15 见习剑士单独入座、0 秒投 MAT_002、停 60 秒 → 入账 76G，日报总额 76', () => {
  const state = createInitialState({ seed: 13 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  state.seats[0] = guest;
  state.pool = injectMaterial(state.pool, 'MAT_002'); // 0 秒投入

  const events = run(state, 60);
  const left = eventsOfType(events, 'guestLeft');

  assert.equal(left.length, 1);
  assert.equal(left[0].gold, 76);
  assert.equal(state.gold, 376); // 300 + 76

  const report = closeDay(state);
  assert.equal(report.totalIncome, 76);
  assert.equal(report.ticketIncome + report.tipIncome, 76);
});

// ============================================================
// W1~W5 换水（新规则：随时可用；换水期间客人状态冻结）
// ============================================================

test('W1 换水 8 秒：满意度/停留冻结，洁净度回满，金币 −20', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  guest.comfort = 5000;
  guest.secondsInPool = 20;
  guest.seatedAt = 0;
  state.seats[0] = guest;
  state.pool.clean = 300; // 30.0

  assert.equal(tryChangeWater(state).ok, true);
  assert.equal(state.gold, 280);

  run(state, 8);

  assert.equal(state.seats[0].comfort, 5000);       // 50.00
  assert.equal(state.seats[0].secondsInPool, 20);   // 停留暂停
  assert.equal(state.pool.clean, 1000);             // 100.0
  assert.equal(state.waterChange, null);
});

test('W2 换水期间到客：不入座只进候位，耐心照常倒计时', () => {
  const state = createInitialState({ seed: 5 });
  state.nextArrivalAt = 3;

  const guestA = createGuest(state, 'GUEST_BONE_KING_GUARD');
  const guestB = createGuest(state, 'GUEST_WANDERING_SKELETON');
  guestA.seatedAt = 0;
  guestB.seatedAt = 0;
  state.seats[0] = guestA;
  state.seats[1] = guestB;

  assert.equal(tryChangeWater(state).ok, true);

  const events = run(state, 48);

  const queued = eventsOfType(events, 'guestQueued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].at, 3);
  assert.equal(state.seats.filter(Boolean).length, 2); // 换水期间没入座

  const timeouts = eventsOfType(events, 'queueTimeout');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].at, 48); // 3 + 45 秒耐心
  assert.equal(state.queue.length, 0);
});

test('W3 换水期间水温照常回落：45.0℃ → 8 秒后 43.4℃', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;
  state.pool.temp = 450;

  assert.equal(tryChangeWater(state).ok, true);
  run(state, 8);

  assert.equal(state.pool.temp, 434);
});

test('W4 换水期间投料槽倒计时照常：60 秒 → 8 秒后 52 秒', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  assert.equal(dropMaterial(state, 1, 'MAT_002').ok, true);
  assert.equal(tryChangeWater(state).ok, true);

  run(state, 8);

  assert.equal(state.slots[0].remainingSeconds, 52);
});

test('W5 换水期间再点换水 → ALREADY_CHANGING；金币 5G → NOT_ENOUGH_GOLD 且状态不变', () => {
  const state = createInitialState({ seed: 1 });
  assert.equal(tryChangeWater(state).ok, true);
  const goldAfterStart = state.gold; // 280

  const again = tryChangeWater(state);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'ALREADY_CHANGING');
  assert.equal(state.gold, goldAfterStart);
  assert.equal(state.waterChange.remainingSeconds, 8);

  const poor = createInitialState({ seed: 1 });
  poor.gold = 5;
  const noMoney = tryChangeWater(poor);
  assert.equal(noMoney.ok, false);
  assert.equal(noMoney.reason, 'NOT_ENOUGH_GOLD');
  assert.equal(poor.gold, 5);
  assert.equal(poor.waterChange, null);
});

// ============================================================
// F1~F6 不适区每秒扣满意度（新规则）
// ============================================================

test('F1 人族 25.0℃ 不适区：10 秒 15.00，40 秒怒离实收 25G', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  run(state, 10);
  assert.equal(state.seats[0].comfort, 1500); // 15.00

  const events = run(state, 30); // 第 11~40 秒
  assert.equal(state.seats[0], null);
  const angry = eventsOfType(events, 'guestAngryLeft');
  assert.equal(angry.length, 1);
  assert.equal(angry[0].at, 40);
  assert.equal(angry[0].gold, 25);
  assert.equal(state.gold, 325); // 300 + 25
});

test('F2 人族 25.0℃、洁净度 40.0：每秒 0.75，20 秒 5.00，第 27 秒怒离', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;
  state.pool.clean = 400; // 40.0

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  run(state, 20);
  assert.equal(state.seats[0].comfort, 500); // 5.00

  const events = run(state, 7); // 第 21~27 秒
  assert.equal(state.seats[0], null);
  const angry = eventsOfType(events, 'guestAngryLeft');
  assert.equal(angry.length, 1);
  assert.equal(angry[0].at, 27);
  assert.equal(angry[0].gold, 25);
});

test('F3 人族 25.0℃、洁净度 10.0：每秒 1.25，第 16 秒怒离', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;
  state.pool.clean = 100; // 10.0

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  const events = run(state, 16);

  assert.equal(state.seats[0], null);
  const angry = eventsOfType(events, 'guestAngryLeft');
  assert.equal(angry.length, 1);
  assert.equal(angry[0].at, 16);
  assert.equal(angry[0].gold, 25);
});

test('F4 亡灵 25.0℃（喜爱区）：10 秒 35.00，没有不适扣分', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  run(state, 10);

  assert.equal(state.seats[0].comfort, 3500); // 20.00 + 1.50×10
});

test('F5 人族与亡灵同池 25.0℃：10 秒后 15.00 / 35.00，互不影响', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const human = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  const undead = createGuest(state, 'GUEST_WANDERING_SKELETON');
  human.seatedAt = 0;
  undead.seatedAt = 0;
  state.seats[0] = human;
  state.seats[1] = undead;

  run(state, 10);

  assert.equal(state.seats[0].comfort, 1500); // 15.00
  assert.equal(state.seats[1].comfort, 3500); // 35.00
});

test('F6 边界：人族 31.9℃ 不适区每秒 −0.50；32.0℃ 耐受区每秒 +0.50', () => {
  assert.equal(comfortDeltaPerSecond({ race: 'HUMAN', temp: 319, clean: 1000 }), -50);
  assert.equal(comfortDeltaPerSecond({ race: 'HUMAN', temp: 320, clean: 1000 }), 50);
});

// ============================================================
// G1~G5 离场扣洁净度 −3.0（§3.6，营业日流程）
// ============================================================

test('G1 亡灵停满 60 秒正常离场：洁净度 91.0', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  const events = run(state, 60);

  assert.equal(state.seats[0], null);
  assert.equal(eventsOfType(events, 'guestLeft').length, 1);
  assert.equal(state.pool.clean, 910); // 1000 − 60 − 30
});

test('G2 人族 25.0℃ 不操作，第 40 秒怒离：洁净度 93.0', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  const events = run(state, 40);

  assert.equal(state.seats[0], null);
  assert.equal(eventsOfType(events, 'guestAngryLeft').length, 1);
  assert.equal(state.pool.clean, 930); // 1000 − 40 − 30
});

test('G3 第 10 秒打烊、池内客人被结算离场：洁净度 96.0', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  run(state, 10);
  closeDay(state);

  assert.equal(state.pool.clean, 960); // 1000 − 10 − 30
});

test('G4 候位超过 45 秒离开：洁净度不额外 −3.0', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  const guestA = createGuest(state, 'GUEST_BONE_KING_GUARD');
  const guestB = createGuest(state, 'GUEST_WANDERING_SKELETON');
  guestA.seatedAt = 0;
  guestB.seatedAt = 0;
  state.seats[0] = guestA;
  state.seats[1] = guestB;

  enqueueGuest(state, 'GUEST_APPRENTICE_SWORDSMAN', 0);
  const events = run(state, 45);

  const timeouts = eventsOfType(events, 'queueTimeout');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].at, 45);
  assert.equal(state.queue.length, 0);
  assert.equal(state.pool.clean, 910); // 1000 − 2×45，没有额外的 −30
});

test('G5 洁净度 2.0 时客人立即离场：夹紧到 0.0', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;
  state.pool.clean = 20; // 2.0

  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  guest.seatedAt = 0;
  state.seats[0] = guest;

  closeDay(state);

  assert.equal(state.pool.clean, 0);
});

// ============================================================
// H1~H2 审计补充
// ============================================================

test('H1 小食收入保留：人族吃 SNK_001 后怒离，门票 25 + 小食 18，小费 0', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;
  state.pool.clean = 100; // 10.0 → Dirty_Mult 250%，不适区每秒 −1.25

  const guest = createGuest(state, 'GUEST_APPRENTICE_SWORDSMAN');
  guest.seatedAt = 0;
  guest.secondsInPool = 30;
  guest.satiety = 40;
  guest.comfort = 1000; // 10.00
  state.seats[0] = guest;

  run(state, 1); // 触发点单气泡
  assert.equal(state.seats[0].orderOpen, true);
  assert.equal(putSnackOnTray(state, 'GUEST_APPRENTICE_SWORDSMAN').ok, true);

  let angryAt = null;
  for (let i = 0; i < 120; i += 1) {
    const events = run(state, 1);
    const angry = eventsOfType(events, 'guestAngryLeft');
    if (angry.length > 0) {
      angryAt = angry[0].at;
      break;
    }
  }

  assert.equal(state.seats[0], null);
  assert.equal(angryAt, 24);
  assert.equal(state.daily.snackIncome, 18);
  assert.equal(state.daily.ticketIncome, 25);
  assert.equal(state.daily.tipIncome, 0);
});

test('H2 流程快照：种子 1、策略 A 跑满 480 秒并打烊', () => {
  const state = createInitialState({ seed: 1 });
  for (let second = 0; second < 480; second += 1) tick(state);

  const report = closeDay(state);

  assert.equal(report.guests, 14);
  assert.equal(report.totalIncome, 684);
  assert.equal(report.tax, 120);
  assert.equal(report.net, 564);
  assert.equal(state.pool.clean, 15); // 1.5
});
