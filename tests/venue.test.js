/**
 * tests/venue.test.js — 到访者入场与初识好感（㉒b-2，N38~N50）
 *
 * 运行：node --test --test-isolation=none tests/venue.test.js
 *
 * 全部流程走真实 nextDay 与真实 tick；事件一律按 type 过滤，不对整条事件数组做 deepEqual。
 * 期望值都是字面数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GUESTS, VISIT } from '../config.js';
import { createGuest, createInitialState, getHeart } from '../src/state.js';
import { closeDay, tick, tryChangeWater } from '../src/clock.js';
import { nextDay } from '../src/actions.js';
import { startExplore, negotiate } from '../src/explore.js';
import { getTempZone } from '../src/bath.js';

function runTicks(state, seconds) {
  const events = [];
  for (let i = 0; i < seconds; i += 1) events.push(...tick(state));
  return events;
}

function eventsOfType(events, type) {
  return events.filter((event) => event.type === type);
}

function forceChance(rng, value) {
  const original = rng.chancePercent;
  rng.chancePercent = () => value;
  return () => { rng.chancePercent = original; };
}

function withNaturalEnabled(enabled, fn) {
  const original = VISIT.NATURAL_ENABLED;
  VISIT.NATURAL_ENABLED = enabled;
  try {
    return fn();
  } finally {
    VISIT.NATURAL_ENABLED = original;
  }
}

/** 打烊后走真实 nextDay */
function openNextDay(state) {
  closeDay(state);
  return nextDay(state);
}

// ============================================================
// N38 pendingVisitors 新结构
// ============================================================
test('N38 pendingVisitors 新结构：保底 guaranteed，邀请与保底同日只 1 条', () => {
  // (a) 第 5 天保底
  const guarded = createInitialState({ seed: 1 });
  guarded.day = 4;
  const restoreNatural = forceChance(guarded.visitRng, false); // 关掉自然掷点（含圣骑士）
  try {
    openNextDay(guarded); // day5
  } finally {
    restoreNatural();
  }
  assert.equal(guarded.day, 5);
  assert.deepEqual(guarded.pendingVisitors, [
    { npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 5 },
  ]);
  assert.equal(guarded.firstVisit.ANT_FOREMAN, 5);

  // (b) 邀请与保底同日：邀请先处理，保底不重复
  const invited = createInitialState({ seed: 1 });
  invited.day = 4;
  invited.invites = [{ npcId: 'ANT_FOREMAN', day: 4 }];
  const restoreRng = forceChance(invited.rng, true);
  const restoreVisit = forceChance(invited.visitRng, false);
  try {
    openNextDay(invited); // day5
  } finally {
    restoreRng();
    restoreVisit();
  }
  assert.deepEqual(invited.pendingVisitors, [
    { npcId: 'ANT_FOREMAN', source: 'invite', day: 5 },
  ]);
});

// ============================================================
// N39 到访者占用到客拍入座
// ============================================================
test('N39 到访者占用到客拍入座：第 10 秒入座、不抽普通客人', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 10;

  const events = runTicks(state, 10);

  assert.equal(state.seats[0].guestId, 'ANT_FOREMAN');
  assert.equal(state.seats[0].satiety, 50);
  assert.deepEqual(state.pendingVisitors, []);
  assert.deepEqual(state.arrivals, [10]);
  const seated = eventsOfType(events, 'visitorSeated');
  assert.deepEqual(seated, [
    { type: 'visitorSeated', at: 10, npcId: 'ANT_FOREMAN', seat: 0, source: 'guaranteed' },
  ]);
  // 2 次抽数：createInitialState 1 次 + 到客拍重掷 1 次（没有 pickWeighted）
  assert.equal(state.rng.getSeed(), 3663131627);
  assert.equal(state.visitRng.getSeed(), 2654435770);
});

// ============================================================
// N40 两位到访者按序入场
// ============================================================
test('N40 两位到访者按顺序入场：seat 0 → seat 1', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.pendingVisitors = [
    { npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 },
    { npcId: 'APPRENTICE_PALADIN', source: 'natural', day: 2 },
  ];
  state.nextArrivalAt = 10;

  const first = runTicks(state, 10);
  assert.equal(state.seats[0].guestId, 'ANT_FOREMAN');
  assert.deepEqual(state.pendingVisitors, [
    { npcId: 'APPRENTICE_PALADIN', source: 'natural', day: 2 },
  ]);

  state.nextArrivalAt = 30;
  const second = runTicks(state, 20);

  assert.equal(state.seats[1].guestId, 'APPRENTICE_PALADIN');
  assert.deepEqual(state.pendingVisitors, []);

  const seated = [...eventsOfType(first, 'visitorSeated'), ...eventsOfType(second, 'visitorSeated')];
  assert.deepEqual(seated.map((event) => event.seat), [0, 1]);
  assert.deepEqual(seated.map((event) => event.npcId), ['ANT_FOREMAN', 'APPRENTICE_PALADIN']);
});

// ============================================================
// N41 候位满则推迟且保留
// ============================================================
test('N41 候位满则推迟：visitorDeferred、pending 保留、queue 不变', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.seats[0] = createGuest(state, 'GUEST_BONE_KING_GUARD');
  state.seats[1] = createGuest(state, 'GUEST_WANDERING_SKELETON');
  state.queue = [
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
  ];
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 10;

  const events = runTicks(state, 10);

  const deferred = eventsOfType(events, 'visitorDeferred');
  assert.deepEqual(deferred, [
    {
      type: 'visitorDeferred', at: 10, npcId: 'ANT_FOREMAN', source: 'guaranteed', reason: 'QUEUE_FULL',
    },
  ]);
  assert.equal(state.pendingVisitors.length, 1);
  assert.equal(state.queue.length, 3);
  assert.equal(state.daily.guestsSeated, 0);
  assert.equal(state.gold, 300);
});

// ============================================================
// N42 推迟后入队，入队不写好感与到访日
// ============================================================
test('N42 推迟后入队：visitorQueued，入队不写好感/到访日', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.seats[0] = createGuest(state, 'GUEST_BONE_KING_GUARD');
  state.seats[1] = createGuest(state, 'GUEST_WANDERING_SKELETON');
  state.queue = [
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
  ];
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 10;
  runTicks(state, 10); // 第 10 秒推迟

  // 夹具：清空候位（模拟队列腾出空位），下一拍到客
  state.queue = [];
  state.nextArrivalAt = 11;
  const events = runTicks(state, 1);

  assert.deepEqual(eventsOfType(events, 'visitorQueued'), [
    { type: 'visitorQueued', at: 11, npcId: 'ANT_FOREMAN', source: 'guaranteed' },
  ]);
  assert.deepEqual(state.pendingVisitors, []);
  assert.equal(state.queue[0].guestId, 'ANT_FOREMAN');
  assert.equal(state.affectionExp.ANT_FOREMAN, undefined);
  assert.equal(state.guestLastVisitDay.ANT_FOREMAN, undefined);
  assert.equal(state.daily.guestsSeated, 0);
});

// ============================================================
// N43 补位入座才写好感与到访日
// ============================================================
test('N43 候位补位入座：只发 guestSeated，好感 10、guestLastVisitDay 写入', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.seats[0] = createGuest(state, 'GUEST_BONE_KING_GUARD');
  state.seats[1] = createGuest(state, 'GUEST_WANDERING_SKELETON');
  state.queue = [
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
    { guestId: 'GUEST_APPRENTICE_SWORDSMAN', enqueuedAt: 0 },
  ];
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 10;
  runTicks(state, 10); // 推迟
  state.queue = [];
  state.nextArrivalAt = 11;
  runTicks(state, 1); // 入队（第 11 秒）
  assert.equal(state.affectionExp.ANT_FOREMAN, undefined);

  // tick 顺序：离场（第 7 步）先于补位（第 8 步）；把 0 号座客人推到第 60 秒
  state.seats[0].secondsInPool = 59;
  const events = runTicks(state, 1); // 第 12 秒：离场 + 补位

  assert.equal(state.seats[0].guestId, 'ANT_FOREMAN');
  assert.equal(state.affectionExp.ANT_FOREMAN, 10);
  assert.equal(state.guestLastVisitDay.ANT_FOREMAN, state.day);
  assert.equal(state.daily.guestsSeated, 1);
  const seated = eventsOfType(events, 'guestSeated');
  assert.equal(seated.length, 1);
  assert.equal(seated[0].guestId, 'ANT_FOREMAN');
  assert.equal(seated[0].seat, 0);
  assert.equal(eventsOfType(events, 'visitorSeated').length, 0);
});

// ============================================================
// N44 候位 45 秒超时（到访者白来）
// ============================================================
test('N44 候位 45 秒超时：queueTimeout + visitorLost，无好感/金币变化', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.seats[0] = createGuest(state, 'GUEST_BONE_KING_GUARD');
  state.seats[1] = createGuest(state, 'GUEST_WANDERING_SKELETON');
  // 默认水温 25.0℃ 是亡灵（UNDEAD）的喜爱区，两位熟客不会怒离
  assert.equal(getTempZone('UNDEAD', state.pool.temp), 'FAVORITE');
  state.queue = [];
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 1;

  const firstTick = runTicks(state, 1); // 第 1 秒入队
  assert.deepEqual(eventsOfType(firstTick, 'visitorQueued'), [
    { type: 'visitorQueued', at: 1, npcId: 'ANT_FOREMAN', source: 'guaranteed' },
  ]);
  assert.deepEqual(state.pendingVisitors, []);

  state.nextArrivalAt = 999; // 切断后续到客，避免第三位熟客入队
  const events = runTicks(state, 45); // 第 2~46 秒

  assert.deepEqual(eventsOfType(events, 'queueTimeout'), [
    { type: 'queueTimeout', at: 46, guestId: 'ANT_FOREMAN' },
  ]);
  assert.deepEqual(eventsOfType(events, 'visitorLost'), [
    { type: 'visitorLost', at: 46, npcId: 'ANT_FOREMAN', reason: 'QUEUE_TIMEOUT' },
  ]);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(state.pendingVisitors, []);
  assert.equal(state.affectionExp.ANT_FOREMAN, undefined);
  assert.equal(state.guestLastVisitDay.ANT_FOREMAN, undefined);
  assert.equal(state.daily.guestsSeated, 0);
  assert.equal(state.gold, 300);
});

// ============================================================
// N45 同日只入座一次
// ============================================================
test('N45 同日只入座一次：visitorSeated 仅 1 次，70 秒后不再出现', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 10;
  const events = runTicks(state, 10);
  assert.equal(eventsOfType(events, 'visitorSeated').length, 1);

  state.nextArrivalAt = 70;
  while (state.time < 480) {
    events.push(...runTicks(state, 1));
    if (state.time > 70) {
      const inSeats = state.seats.some((guest) => guest && guest.guestId === 'ANT_FOREMAN');
      const inQueue = state.queue.some((entry) => entry.guestId === 'ANT_FOREMAN');
      assert.equal(inSeats, false);
      assert.equal(inQueue, false);
    }
  }

  assert.equal(eventsOfType(events, 'visitorSeated').length, 1);
});

// ============================================================
// N46 初识解除 NOT_ACQUAINTED（真实流程）
// ============================================================
test('N46 初识解除 NOT_ACQUAINTED：第 5 天保底入座 → 好感 10 → 次日谈判 ok', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  const restore = forceChance(state.visitRng, false);
  try {
    openNextDay(state); // day5：保底蚁工头
  } finally {
    restore();
  }
  assert.equal(state.day, 5);

  state.nextArrivalAt = 5;
  runTicks(state, 5);
  assert.equal(state.seats[0].guestId, 'ANT_FOREMAN');
  assert.equal(state.affectionExp.ANT_FOREMAN, 10);
  assert.equal(getHeart(10), 0);
  assert.deepEqual(state.pendingVisitors, []);

  openNextDay(state); // day6
  assert.equal(state.day, 6);
  assert.equal(state.time, 0);
  assert.equal(state.closed, false);

  const started = startExplore(state);
  assert.equal(started.ok, true);
  state.explore.pendingEncounter = 'ANT_FOREMAN';
  state.explore.negotiationTried = false;

  const result = negotiate(state, []);
  assert.notEqual(result.reason, 'NOT_ACQUAINTED');
  assert.equal(result.ok, true);
});

// ============================================================
// N47 声望 NEUTRAL 首次真实触发
// ============================================================
test('N47 声望 NEUTRAL 首次触发：蚁工头 39.9℃ 起、停满 60 秒 → 满意度 99.00、合计 80G', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 1;
  state.pool.temp = 399; // 39.9℃，避开 40.0℃ 区间边界
  state.pool.clean = 1000;

  runTicks(state, 1); // 第 1 秒入座
  assert.equal(state.seats[0].guestId, 'ANT_FOREMAN');
  state.nextArrivalAt = 999; // 切断后续到客

  const events = runTicks(state, 59); // 第 2~60 秒，第 60 秒离场

  const left = eventsOfType(events, 'guestLeft');
  assert.equal(left.length, 1);
  assert.equal(left[0].guestId, 'ANT_FOREMAN');
  assert.equal(left[0].comfort, 9900);   // 2000 + 150×49 + 50×11
  assert.equal(left[0].mode, 'normal');
  assert.equal(left[0].ticket, 50);
  assert.equal(left[0].tip, 30);
  assert.equal(left[0].gold, 80);

  assert.equal(state.reputation.NEUTRAL, 1);
  assert.equal(state.reputation.ORDER, 0);
  assert.equal(state.reputation.MONSTER, 0);
  assert.equal(state.affectionExp.ANT_FOREMAN, 30); // 10 + 20（满意度 ≥80 离场）
  assert.equal(state.daily.guestsSeated, 1);
  assert.equal(state.daily.ticketIncome, 50);
  assert.equal(state.daily.tipIncome, 30);
});

// ============================================================
// N48 声望 ORDER 首次真实触发
// ============================================================
test('N48 声望 ORDER 首次触发：圣骑士满意度 81.50 离场 → 合计 77G', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  state.pendingVisitors = [{ npcId: 'APPRENTICE_PALADIN', source: 'natural', day: 2 }];
  state.nextArrivalAt = 1;
  state.pool.temp = 420;
  state.pool.clean = 1000;

  runTicks(state, 1); // 第 1 秒入座（经 seatGuest）
  assert.equal(state.seats[0].guestId, 'APPRENTICE_PALADIN');
  assert.equal(state.seats[0].comfort, 2150);

  // 夹具造数：把这位圣骑士推到第 60 秒、满意度 80.00
  state.seats[0].comfort = 8000;
  state.seats[0].secondsInPool = 59;

  const events = runTicks(state, 1); // 第 2 秒：水温 41.6℃ 喜爱区 +150 → 8150，离场

  const left = eventsOfType(events, 'guestLeft');
  assert.equal(left.length, 1);
  assert.equal(left[0].guestId, 'APPRENTICE_PALADIN');
  assert.equal(left[0].comfort, 8150);
  assert.equal(left[0].ticket, 50);
  assert.equal(left[0].tip, 27);
  assert.equal(left[0].gold, 77);

  assert.equal(state.reputation.ORDER, 1);
  assert.equal(state.reputation.NEUTRAL, 0);
  assert.equal(state.reputation.MONSTER, 0);
  assert.equal(state.affectionExp.APPRENTICE_PALADIN, 130); // 100 + 10 + 20
});

// ============================================================
// N49 无到访者随机数基线（逐字节不变）
// ============================================================
test('N49 无到访者随机数基线：第 1 天与第 2 天的种子/日报逐字节不变', () => {
  const first = createInitialState({ seed: 1 });
  runTicks(first, 60);
  assert.equal(first.rng.getSeed(), 3031295957);
  assert.equal(first.visitRng.getSeed(), 2654435770);
  assert.deepEqual(first.arrivals, [35]);
  assert.equal(first.daily.guestsSeated, 1);

  const day1 = createInitialState({ seed: 1 });
  runTicks(day1, 480);
  assert.equal(day1.rng.getSeed(), 3783437721);
  assert.equal(day1.daily.guestsSeated, 14);
  const report1 = closeDay(day1);
  assert.equal(day1.rng.getSeed(), 1320036238);
  assert.deepEqual(report1, {
    day: 1,
    guests: 14,
    ticketIncome: 525,
    tipIncome: 159,
    snackIncome: 0,
    totalIncome: 684,
    tax: 120,
    net: 564,
  });

  const day2 = createInitialState({ seed: 1 });
  closeDay(day2);
  withNaturalEnabled(false, () => {
    nextDay(day2);
  });
  assert.equal(day2.day, 2);
  assert.deepEqual(day2.pendingVisitors, []);
  assert.equal(day2.rng.getSeed(), 3663131627);

  runTicks(day2, 480);
  assert.equal(day2.rng.getSeed(), 1320036238);
  assert.equal(day2.daily.guestsSeated, 14);
  const report2 = closeDay(day2);
  assert.equal(day2.rng.getSeed(), 3151602051);
  assert.deepEqual(report2, {
    day: 2,
    guests: 14,
    ticketIncome: 525,
    tipIncome: 141,
    snackIncome: 0,
    totalIncome: 666,
    tax: 120,
    net: 546,
  });
});

// ============================================================
// N50 换水期间到访者只入队不入座
// ============================================================
test('N50 换水期间到访者只入队不入座', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 2;
  assert.equal(tryChangeWater(state).ok, true);
  state.pendingVisitors = [{ npcId: 'ANT_FOREMAN', source: 'guaranteed', day: 2 }];
  state.nextArrivalAt = 1;

  const events = runTicks(state, 1);

  assert.deepEqual(state.seats, [null, null]);
  assert.deepEqual(state.queue, [{ guestId: 'ANT_FOREMAN', enqueuedAt: 1 }]);
  assert.deepEqual(eventsOfType(events, 'visitorQueued'), [
    { type: 'visitorQueued', at: 1, npcId: 'ANT_FOREMAN', source: 'guaranteed' },
  ]);
  assert.equal(state.waterChange.remainingSeconds, 7); // 换水总时长 8 秒
});
