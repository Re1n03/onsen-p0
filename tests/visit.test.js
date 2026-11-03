/**
 * tests/visit.test.js — 温泉馆吸引力与到访判定（A.20，㉒a）
 *
 * N25~N36：吸引力/概率/夹紧/门槛/保底/抽样/随机数隔离/开关。
 * 期望值全部是字面数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENCOUNTERS, VISIT } from '../config.js';
import { createInitialState } from '../src/state.js';
import { closeDay, nextDay } from '../src/actions.js';
import {
  attractionOf,
  inviteBonusOf,
  invitedVisitChance,
  naturalVisitChance,
} from '../src/visit.js';

/** 打烊后走真实 nextDay（第 1 天 → 第 2 天，依次类推） */
function openNextDay(state) {
  closeDay(state);
  return nextDay(state);
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

function forceChance(rng, value) {
  const original = rng.chancePercent;
  rng.chancePercent = () => value;
  return () => { rng.chancePercent = original; };
}

test('N25 吸引力与邀请加成：馆等级1~5 → A 5/15/30/50/75、邀请加成 1/2/4/6/8', () => {
  const cases = [
    [1, 5, 1],
    [2, 15, 2],
    [3, 30, 4],
    [4, 50, 6],
    [5, 75, 8],
  ];
  for (const [level, expectedAttraction, expectedBonus] of cases) {
    const state = createInitialState({ seed: 1 });
    state.houseLevel = level;
    state.facilities = [];
    assert.equal(attractionOf(state), expectedAttraction, `等级 ${level} 吸引力`);
    assert.equal(inviteBonusOf(state), expectedBonus, `等级 ${level} 邀请加成`);
  }
});

test('N26 到访概率字面值：27/28、15/16、21/22、45', () => {
  const state = createInitialState({ seed: 1 });
  state.houseLevel = 1;
  state.facilities = [];

  state.affectionExp.APPRENTICE_PALADIN = 100;
  assert.equal(naturalVisitChance(state, 'APPRENTICE_PALADIN'), 27);
  assert.equal(invitedVisitChance(state, 'APPRENTICE_PALADIN'), 28);

  state.affectionExp.ANT_FOREMAN = 0;
  assert.equal(naturalVisitChance(state, 'ANT_FOREMAN'), 15);
  assert.equal(invitedVisitChance(state, 'ANT_FOREMAN'), 16);

  state.affectionExp.ANT_FOREMAN = 300;
  assert.equal(naturalVisitChance(state, 'ANT_FOREMAN'), 21);
  assert.equal(invitedVisitChance(state, 'ANT_FOREMAN'), 22);

  state.affectionExp.APPRENTICE_PALADIN = 1000;
  assert.equal(naturalVisitChance(state, 'APPRENTICE_PALADIN'), 45);
});

test('N27 夹紧：等级5圣骑士1000 → 95；阶位5蚁工头0+等级1 → 0', () => {
  const high = createInitialState({ seed: 1 });
  high.houseLevel = 5;
  high.affectionExp.APPRENTICE_PALADIN = 1000;
  assert.equal(naturalVisitChance(high, 'APPRENTICE_PALADIN'), 95);

  const originalRank = ENCOUNTERS.ANT_FOREMAN.rank;
  try {
    ENCOUNTERS.ANT_FOREMAN.rank = 5;
    const low = createInitialState({ seed: 1 });
    low.houseLevel = 1;
    low.affectionExp.ANT_FOREMAN = 0;
    assert.equal(naturalVisitChance(low, 'ANT_FOREMAN'), 0);
  } finally {
    ENCOUNTERS.ANT_FOREMAN.rank = originalRank;
  }
});

test('N28 门槛：蚁工头 minHouseLevel=2、馆等级1 → 不掷点；馆等级2恢复', () => {
  const originalMin = ENCOUNTERS.ANT_FOREMAN.minHouseLevel;
  try {
    ENCOUNTERS.ANT_FOREMAN.minHouseLevel = 2;

    const blocked = createInitialState({ seed: 1 });
    blocked.houseLevel = 1;
    const restoreBlocked = forceChance(blocked.visitRng, true);
    let blockedAdvanced;
    try {
      blockedAdvanced = openNextDay(blocked);
    } finally {
      restoreBlocked();
    }
    assert.equal(blocked.pendingVisitors.includes('ANT_FOREMAN'), false);
    assert.equal(
      blockedAdvanced.events.filter((event) => event.type === 'visitorArrives'
        && event.npcId === 'ANT_FOREMAN').length,
      0,
    );

    const allowed = createInitialState({ seed: 1 });
    allowed.houseLevel = 2;
    const restoreAllowed = forceChance(allowed.visitRng, true);
    try {
      openNextDay(allowed);
    } finally {
      restoreAllowed();
    }
    assert.equal(allowed.pendingVisitors.includes('ANT_FOREMAN'), true);
    assert.equal(allowed.firstVisit.ANT_FOREMAN, 2);
  } finally {
    ENCOUNTERS.ANT_FOREMAN.minHouseLevel = originalMin;
  }
});

test('N29 保底：第4天不触发；第5天强制失败仍到访，source guaranteed、firstVisit=5', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 3;
  const restoreDay4 = forceChance(state.visitRng, false);
  try {
    openNextDay(state); // day4
  } finally {
    restoreDay4();
  }
  assert.equal(state.day, 4);
  assert.equal(state.firstVisit.ANT_FOREMAN, undefined);
  assert.deepEqual(state.pendingVisitors, []);

  const restoreDay5 = forceChance(state.visitRng, false);
  let advanced;
  try {
    advanced = openNextDay(state); // day5
  } finally {
    restoreDay5();
  }
  assert.equal(state.day, 5);
  assert.deepEqual(state.pendingVisitors, ['ANT_FOREMAN']);
  assert.equal(state.firstVisit.ANT_FOREMAN, 5);
  const arrivals = advanced.events.filter((event) => event.type === 'visitorArrives');
  assert.deepEqual(arrivals, [
    { type: 'visitorArrives', npcId: 'ANT_FOREMAN', day: 5, source: 'guaranteed' },
  ]);
});

test('N30 提前到访抽样：1万种子，第5天前到访约 38.59%（36%~41%），第5天后全部到访', () => {
  const total = 10000;
  let beforeDay5 = 0;
  const states = [];
  for (let index = 0; index < total; index += 1) {
    const state = createInitialState({ seed: index + 1 });
    openNextDay(state); // day2
    openNextDay(state); // day3
    openNextDay(state); // day4
    if (state.firstVisit.ANT_FOREMAN !== undefined) beforeDay5 += 1;
    states.push(state);
  }
  const ratio = beforeDay5 / total;
  assert.ok(ratio >= 0.36 && ratio <= 0.41, `第5天前到访 ${beforeDay5}`);

  let afterDay5 = 0;
  for (const state of states) {
    openNextDay(state); // day5
    if (state.firstVisit.ANT_FOREMAN !== undefined) afterDay5 += 1;
  }
  assert.equal(afterDay5, 10000);
});

test('N31 自然到访抽样：1万种子走真实 nextDay，圣骑士命中 25%~29%', () => {
  const total = 10000;
  let hit = 0;
  for (let index = 0; index < total; index += 1) {
    const state = createInitialState({ seed: index + 1 });
    openNextDay(state); // day2
    if (state.pendingVisitors.includes('APPRENTICE_PALADIN')) hit += 1;
  }
  assert.ok(hit / total >= 0.25 && hit / total <= 0.29, `圣骑士到访 ${hit}`);
});

test('N32 被邀请只掷一次：1万种子命中 14%~18%，次日 pendingVisitors 清空', () => {
  const total = 10000;
  let hit = 0;
  withNaturalEnabled(false, () => {
    for (let index = 0; index < total; index += 1) {
      const state = createInitialState({ seed: index + 1 });
      state.invites = [{ npcId: 'ANT_FOREMAN', day: 1 }];
      openNextDay(state); // day2
      const arrived = state.pendingVisitors.filter((npcId) => npcId === 'ANT_FOREMAN').length;
      assert.ok(arrived <= 1);
      if (arrived === 1) hit += 1;
    }
    assert.ok(hit / total >= 0.14 && hit / total <= 0.18, `受邀到访 ${hit}`);

    const cleared = createInitialState({ seed: 1 });
    cleared.invites = [{ npcId: 'ANT_FOREMAN', day: 1 }];
    openNextDay(cleared); // day2
    openNextDay(cleared); // day3
    assert.deepEqual(cleared.pendingVisitors, []);
  });
});

test('N33 随机数隔离：开关自然到访不改变 state.rng 种子；visitRng 仅在开启时推进', () => {
  const seed = 20261102;
  const naturalOn = createInitialState({ seed });
  const naturalOff = createInitialState({ seed });
  const visitSeedOn = naturalOn.visitRng.getSeed();
  const visitSeedOff = naturalOff.visitRng.getSeed();

  withNaturalEnabled(true, () => {
    openNextDay(naturalOn);
    openNextDay(naturalOn);
  });
  withNaturalEnabled(false, () => {
    openNextDay(naturalOff);
    openNextDay(naturalOff);
  });

  assert.equal(naturalOn.rng.getSeed(), naturalOff.rng.getSeed());
  assert.notEqual(naturalOn.visitRng.getSeed(), visitSeedOn);
  assert.equal(naturalOff.visitRng.getSeed(), visitSeedOff);
});

test('N34 开关：关闭自然到访时未邀请者不到访，被邀请的仍正常掷点', () => {
  withNaturalEnabled(false, () => {
    const state = createInitialState({ seed: 1 });
    state.invites = [{ npcId: 'ANT_FOREMAN', day: 1 }];
    const restoreRng = forceChance(state.rng, true);
    const restoreVisitRng = forceChance(state.visitRng, true);
    try {
      openNextDay(state); // day2
    } finally {
      restoreRng();
      restoreVisitRng();
    }
    assert.deepEqual(state.pendingVisitors, ['ANT_FOREMAN']);
    assert.equal(state.pendingVisitors.includes('APPRENTICE_PALADIN'), false);

    openNextDay(state); // day3
    assert.deepEqual(state.pendingVisitors, []);
  });
});

test('N35 保底忽略门槛：蚁工头 minHouseLevel=2、馆等级1，第5天仍保底到访', () => {
  const originalMin = ENCOUNTERS.ANT_FOREMAN.minHouseLevel;
  try {
    ENCOUNTERS.ANT_FOREMAN.minHouseLevel = 2;
    const state = createInitialState({ seed: 1 });
    state.houseLevel = 1;
    state.day = 4;
    const restore = forceChance(state.visitRng, false);
    let advanced;
    try {
      advanced = openNextDay(state); // day5
    } finally {
      restore();
    }
    assert.deepEqual(state.pendingVisitors, ['ANT_FOREMAN']);
    assert.equal(state.firstVisit.ANT_FOREMAN, 5);
    const arrivals = advanced.events.filter((event) => event.type === 'visitorArrives');
    assert.deepEqual(arrivals, [
      { type: 'visitorArrives', npcId: 'ANT_FOREMAN', day: 5, source: 'guaranteed' },
    ]);
  } finally {
    ENCOUNTERS.ANT_FOREMAN.minHouseLevel = originalMin;
  }
});

test('N36 保底用 >=：第5天关闭自然不到访，第6天打开后补保底、firstVisit=6', () => {
  const state = createInitialState({ seed: 1 });
  state.day = 4;
  const restore = forceChance(state.visitRng, false);
  try {
    withNaturalEnabled(false, () => {
      openNextDay(state); // day5：自然关闭，不触发保底
    });
    assert.equal(state.day, 5);
    assert.equal(state.firstVisit.ANT_FOREMAN, undefined);
    assert.deepEqual(state.pendingVisitors, []);

    let advanced;
    withNaturalEnabled(true, () => {
      advanced = openNextDay(state); // day6：>= 保底补触发
    });
    assert.equal(state.day, 6);
    assert.deepEqual(state.pendingVisitors, ['ANT_FOREMAN']);
    assert.equal(state.firstVisit.ANT_FOREMAN, 6);
    const arrivals = advanced.events.filter((event) => event.type === 'visitorArrives');
    assert.deepEqual(arrivals, [
      { type: 'visitorArrives', npcId: 'ANT_FOREMAN', day: 6, source: 'guaranteed' },
    ]);
  } finally {
    restore();
  }
});
