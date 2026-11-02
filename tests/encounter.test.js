/**
 * tests/encounter.test.js — 遭遇系统 v2（N1~N16 + Y13 重录）
 *
 * 运行：node --test tests/encounter.test.js
 * 期望值都是字面数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENCOUNTERS } from '../config.js';
import { createInitialState } from '../src/state.js';
import { createRng } from '../src/rng.js';
import {
  advance,
  discardPending,
  eat,
  flee,
  fight,
  invite,
  inviteChance,
  negotiate,
  negotiationChance,
  resolveEncounter,
  returnHome,
  rollInvitations,
  settleNode,
  startExplore,
  swapPending,
} from '../src/explore.js';
import { closeDay, nextDay } from '../src/actions.js';

function makeEncounter(npcId, seed = 1) {
  const state = createInitialState({ seed });
  startExplore(state);
  state.explore.pendingEncounter = npcId;
  state.explore.negotiationTried = false;
  state.explore.invitedNpcs = [];
  state.affectionExp[npcId] = Math.max(
    state.affectionExp[npcId] ?? 0,
    ENCOUNTERS[npcId].startAffinityExp,
  );
  return state;
}

function forceChance(state, value) {
  const original = state.rng.chancePercent;
  state.rng.chancePercent = () => value;
  return () => { state.rng.chancePercent = original; };
}

test('N1 蚁工头经验0：谈判 NOT_ACQUAINTED；经验10可谈判', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.affectionExp.ANT_FOREMAN = 0;
  const before = JSON.stringify({ mood: state.explore.mood, backpack: state.explore.backpack });

  const denied = negotiate(state, ['SNK_001']);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'NOT_ACQUAINTED');
  assert.equal(JSON.stringify({ mood: state.explore.mood, backpack: state.explore.backpack }), before);

  state.affectionExp.ANT_FOREMAN = 10;
  const restore = forceChance(state, true);
  try {
    const result = negotiate(state, []);
    assert.equal(result.ok, true);
    assert.equal(result.success, true);
  } finally {
    restore();
  }
});

test('N2 圣骑士谈判概率：38/48/73/89/0/13/95', () => {
  const state = createInitialState({ seed: 1 });
  const cases = [
    [['SNK_001'], 38],
    [['SNK_001', 'SNK_001'], 48],
    [['SNK_001', 'HOLY_WATER_SAMPLE'], 73],
    [['SNK_001', 'HOLY_WATER_SAMPLE', 'FRAGMENT'], 89],
    [['MAT_003'], 0],
    [['SNK_001', 'MAT_003'], 13],
  ];
  for (const [offer, expected] of cases) {
    assert.equal(negotiationChance(state, 'APPRENTICE_PALADIN', offer), expected);
  }
  state.affectionExp.APPRENTICE_PALADIN = 1000;
  assert.equal(negotiationChance(state, 'APPRENTICE_PALADIN', ['SNK_001']), 95);
});

test('N3 蚁工头谈判概率：34/46/58/26；第4件 TOO_MANY_ITEMS', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.affectionExp.ANT_FOREMAN = 10;
  assert.equal(negotiationChance(state, 'ANT_FOREMAN', ['SNK_001']), 34);
  assert.equal(negotiationChance(state, 'ANT_FOREMAN', ['SNK_001', 'SNK_001']), 46);
  assert.equal(negotiationChance(state, 'ANT_FOREMAN', ['SNK_001', 'SNK_001', 'SNK_001']), 58);
  assert.equal(negotiationChance(state, 'ANT_FOREMAN', ['FRAGMENT']), 26);

  const result = negotiate(state, ['SNK_001', 'SNK_001', 'SNK_001', 'SNK_001']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOO_MANY_ITEMS');
});

test('N4 谈判概率抽样：圣骑士 36%~40%；蚁工头 56%~60%', () => {
  const paladin = createInitialState({ seed: 1 });
  const rng = paladin.rng;
  paladin.affectionExp.APPRENTICE_PALADIN = 100;
  let paladinSuccess = 0;
  for (let i = 0; i < 10000; i += 1) {
    paladin.explore = {
      mood: 13, depth: 1, lunchbox: { SNK_001: 1 }, backpack: [],
      pendingEncounter: 'APPRENTICE_PALADIN', negotiationTried: false,
      invitedNpcs: [], pendingPickup: null,
    };
    if (negotiate(paladin, ['SNK_001']).success) paladinSuccess += 1;
  }
  assert.ok(paladinSuccess / 10000 >= 0.36 && paladinSuccess / 10000 <= 0.40, `圣骑士 ${paladinSuccess}`);

  const ant = createInitialState({ seed: 1 });
  ant.affectionExp.ANT_FOREMAN = 10;
  let antSuccess = 0;
  for (let i = 0; i < 10000; i += 1) {
    ant.explore = {
      mood: 13, depth: 1, lunchbox: { SNK_001: 3 }, backpack: [],
      pendingEncounter: 'ANT_FOREMAN', negotiationTried: false,
      invitedNpcs: [], pendingPickup: null,
    };
    if (negotiate(ant, ['SNK_001', 'SNK_001', 'SNK_001']).success) antSuccess += 1;
  }
  assert.ok(antSuccess / 10000 >= 0.56 && antSuccess / 10000 <= 0.60, `蚁工头 ${antSuccess}`);
  assert.ok(rng !== null);
});

test('N5 谈判成功/失败：消耗物品、回礼/锁定、后续可战斗逃跑邀请', () => {
  const success = makeEncounter('APPRENTICE_PALADIN');
  success.explore.lunchbox = { SNK_001: 1 };
  success.fragments = 1;
  const restoreTrue = forceChance(success, true);
  let result;
  try {
    result = negotiate(success, ['SNK_001', 'FRAGMENT']);
  } finally {
    restoreTrue();
  }
  assert.equal(result.ok, true);
  assert.equal(result.success, true);
  assert.equal(result.chance, 54);
  assert.equal(success.explore.lunchbox.SNK_001, 0);
  assert.equal(success.fragments, 0);
  assert.deepEqual(success.explore.backpack, [{ itemId: 'HOLY_WATER_SAMPLE', count: 1 }]);
  assert.equal(success.affectionExp.APPRENTICE_PALADIN, 110);
  assert.equal(success.explore.pendingEncounter, null);

  const fail = makeEncounter('APPRENTICE_PALADIN');
  fail.explore.lunchbox = { SNK_001: 1 };
  fail.fragments = 1;
  const restoreFalse = forceChance(fail, false);
  try {
    result = negotiate(fail, ['SNK_001', 'FRAGMENT']);
  } finally {
    restoreFalse();
  }
  assert.equal(result.success, false);
  assert.equal(fail.explore.lunchbox.SNK_001, 0);
  assert.equal(fail.fragments, 0);
  assert.equal(fail.explore.pendingEncounter, 'APPRENTICE_PALADIN');
  assert.equal(fail.explore.negotiationTried, true);

  assert.equal(negotiate(fail, []).reason, 'ALREADY_TRIED');
  assert.equal(invite(fail).ok, true);
  assert.equal(fight(fail).ok, true);
});

test('N6 谈判好感每日上限：已有55，再+10只生效+5', () => {
  const state = makeEncounter('APPRENTICE_PALADIN');
  state.explore.lunchbox = { SNK_001: 1 };
  state.dailyAffinityExp.APPRENTICE_PALADIN = 55;
  const restore = forceChance(state, true);
  try {
    negotiate(state, ['SNK_001']);
  } finally {
    restore();
  }
  assert.equal(state.affectionExp.APPRENTICE_PALADIN, 105);
  assert.equal(state.dailyAffinityExp.APPRENTICE_PALADIN, 60);
});

test('N7 战斗：付 2×ENCOUNTER；战利品；好感−20；深度6付6', () => {
  const ant = makeEncounter('ANT_FOREMAN');
  ant.explore.depth = 3;
  ant.explore.mood = 13;
  ant.affectionExp.ANT_FOREMAN = 50;
  const result = fight(ant);
  assert.equal(result.ok, true);
  assert.equal(result.cost, 4);
  assert.equal(ant.explore.mood, 9);
  assert.deepEqual(ant.explore.backpack, [{ itemId: 'GEOTHERMAL_SHARD', count: 1 }]);
  assert.equal(ant.affectionExp.ANT_FOREMAN, 30);
  assert.equal(ant.explore.pendingEncounter, null);

  const low = makeEncounter('ANT_FOREMAN');
  low.explore.depth = 3;
  low.explore.mood = 13;
  low.affectionExp.ANT_FOREMAN = 10;
  fight(low);
  assert.equal(low.affectionExp.ANT_FOREMAN, 0);

  const deep = makeEncounter('ANT_FOREMAN');
  deep.explore.depth = 6;
  deep.explore.mood = 20;
  deep.affectionExp.ANT_FOREMAN = 50;
  assert.equal(fight(deep).cost, 6);
  assert.equal(deep.explore.mood, 14);
});

test('N8 战斗倒地：雅兴4、深度3 → 付4后0，倒地在深度3，不发奖励', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.explore.depth = 3;
  state.explore.mood = 4;
  state.affectionExp.ANT_FOREMAN = 50;

  const result = fight(state);

  assert.equal(result.ok, true);
  assert.equal(result.fell, true);
  assert.equal(result.fall.mood, 0);
  assert.equal(result.fall.depth, 3);
  assert.deepEqual(state.explore, null);
  assert.equal(result.loot, undefined);
});

test('N9 逃跑：材料−1、付返程3回店；无材料 NO_MATERIAL', () => {
  const state = createInitialState({ seed: 1 });
  state.inventory.MAT_001 = 2;
  startExplore(state, { backpack: { MAT_001: 1 } });
  state.explore.pendingEncounter = 'ANT_FOREMAN';
  state.explore.depth = 3;
  state.explore.mood = 9;

  const result = flee(state, 'MAT_001');

  assert.equal(result.ok, true);
  assert.equal(result.fled, true);
  assert.equal(result.fell, false);
  assert.equal(result.cost, 3);
  assert.equal(state.explore, null);
  assert.equal(state.inventory.MAT_001, 1); // 开局 2 − 装填 1，背包的 1 被消耗

  const empty = makeEncounter('ANT_FOREMAN');
  empty.explore.backpack = [];
  const before = JSON.stringify({ mood: empty.explore.mood, pending: empty.explore.pendingEncounter });
  const denied = flee(empty, 'MAT_001');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'NO_MATERIAL');
  assert.equal(JSON.stringify({ mood: empty.explore.mood, pending: empty.explore.pendingEncounter }), before);
});

test('N10 逃跑倒地位置：3/2→1；8/6→2', () => {
  const shallow = makeEncounter('ANT_FOREMAN');
  shallow.explore.backpack = [{ itemId: 'MAT_001', count: 1 }];
  shallow.explore.depth = 3;
  shallow.explore.mood = 2;
  const a = flee(shallow, 'MAT_001');
  assert.equal(a.fell, true);
  assert.equal(a.fall.depth, 1);
  assert.equal(a.fall.mood, 0);

  const deep = makeEncounter('ANT_FOREMAN');
  deep.explore.backpack = [{ itemId: 'MAT_001', count: 1 }];
  deep.explore.depth = 8;
  deep.explore.mood = 6;
  const b = flee(deep, 'MAT_001');
  assert.equal(b.fall.depth, 2);
  assert.equal(b.fall.mood, 0);
});

test('N11 普通回店不足：6/5→1；5/4→1；4/1→3；相等成功', () => {
  const cases = [[6, 5, 1], [5, 4, 1], [4, 1, 3]];
  for (const [depth, mood, fallDepth] of cases) {
    const state = createInitialState({ seed: 1 });
    startExplore(state);
    state.explore.depth = depth;
    state.explore.mood = mood;
    const result = returnHome(state);
    assert.equal(result.fell, true);
    assert.equal(result.fall.depth, fallDepth);
    assert.equal(result.fall.mood, 0);
  }

  const equal = createInitialState({ seed: 1 });
  startExplore(equal);
  equal.explore.depth = 5;
  equal.explore.mood = 5;
  assert.equal(returnHome(equal).fell, false);
});

test('N12 邀请：券3→2、同NPC一次、无券 NO_VOUCHER、遭遇仍在、好感不变、chance25', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.vouchers = 3;
  const expBefore = state.affectionExp.ANT_FOREMAN;

  const result = invite(state);
  assert.equal(result.ok, true);
  assert.equal(result.chance, 25);
  assert.equal(state.vouchers, 2);
  assert.deepEqual(state.invites, [{ npcId: 'ANT_FOREMAN', day: 1 }]);
  assert.equal(state.explore.pendingEncounter, 'ANT_FOREMAN');
  assert.equal(state.affectionExp.ANT_FOREMAN, expBefore);

  assert.equal(invite(state).reason, 'ALREADY_INVITED');

  const none = makeEncounter('ANT_FOREMAN');
  none.vouchers = 0;
  assert.equal(invite(none).reason, 'NO_VOUCHER');
});

test('N13 邀请到访：两位 NPC chance 25；10000 次 23%~27% 记入 pendingVisitors', () => {
  const state = createInitialState({ seed: 1 });
  assert.equal(inviteChance(state, 'ANT_FOREMAN'), 25);
  assert.equal(inviteChance(state, 'APPRENTICE_PALADIN'), 25);

  const rng = createRng(20261102);
  let hit = 0;
  for (let i = 0; i < 10000; i += 1) {
    const trial = createInitialState({ seed: i + 1 });
    trial.day = 2;
    trial.invites = [{ npcId: 'ANT_FOREMAN', day: 1 }];
    rollInvitations(trial, rng);
    if (trial.pendingVisitors.length > 0) hit += 1;
    assert.deepEqual(trial.invites, []);
  }
  assert.ok(hit / 10000 >= 0.23 && hit / 10000 <= 0.27, `到访 ${hit}`);
});

test('N14 旧选项 FEED/VOUCHER/TALK/ESCAPE → UNKNOWN_OPTION，状态不变', () => {
  const state = makeEncounter('ANT_FOREMAN');
  const before = JSON.stringify({
    mood: state.explore.mood,
    depth: state.explore.depth,
    backpack: state.explore.backpack,
    lunchbox: state.explore.lunchbox,
    vouchers: state.vouchers,
    fragments: state.fragments,
    pending: state.explore.pendingEncounter,
  });

  for (const option of ['FEED', 'VOUCHER', 'TALK', 'ESCAPE']) {
    const result = resolveEncounter(state, option);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNKNOWN_OPTION');
  }
  assert.equal(JSON.stringify({
    mood: state.explore.mood,
    depth: state.explore.depth,
    backpack: state.explore.backpack,
    lunchbox: state.explore.lunchbox,
    vouchers: state.vouchers,
    fragments: state.fragments,
    pending: state.explore.pendingEncounter,
  }), before);
});

test('N15 快照：强制圣骑士，谈判 [SNK, 碎片] 成功，再资源点', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state, { lunchbox: { SNK_001: 1 } });
  state.fragments = 1;

  const trail = [];
  settleNode(state, 'ENCOUNTER');
  state.explore.pendingEncounter = 'APPRENTICE_PALADIN';
  state.affectionExp.APPRENTICE_PALADIN = 100;
  trail.push({ act: 'encounter', mood: state.explore.mood, depth: state.explore.depth, pending: state.explore.pendingEncounter });

  const restore = forceChance(state, true);
  let negotiated;
  try {
    negotiated = negotiate(state, ['SNK_001', 'FRAGMENT']);
  } finally {
    restore();
  }
  trail.push({
    act: 'negotiate', chance: negotiated.chance, mood: state.explore.mood,
    depth: state.explore.depth, backpack: structuredClone(state.explore.backpack),
    pending: state.explore.pendingEncounter,
  });

  settleNode(state, 'RESOURCE');
  trail.push({ act: 'resource', mood: state.explore.mood, depth: state.explore.depth, backpack: structuredClone(state.explore.backpack) });

  assert.deepEqual(trail, [
    { act: 'encounter', mood: 13, depth: 1, pending: 'APPRENTICE_PALADIN' },
    { act: 'negotiate', chance: 54, mood: 13, depth: 1, backpack: [{ itemId: 'HOLY_WATER_SAMPLE', count: 1 }], pending: null },
    { act: 'resource', mood: 11, depth: 2, backpack: [{ itemId: 'HOLY_WATER_SAMPLE', count: 1 }, { itemId: 'MAT_002', count: 2 }] },
  ]);
});

test('N16 快照：蚁工头邀请→谈判不可用→战斗→资源→再遭遇→逃跑→nextDay 掷邀请', () => {
  const state = createInitialState({ seed: 1 });
  state.inventory.MAT_001 = 2;
  startExplore(state, { backpack: { MAT_001: 1 } });

  settleNode(state, 'ENCOUNTER');
  state.explore.pendingEncounter = 'ANT_FOREMAN';
  state.affectionExp.ANT_FOREMAN = 0;

  const invited = invite(state);
  assert.equal(invited.chance, 25);
  assert.deepEqual(state.invites, [{ npcId: 'ANT_FOREMAN', day: 1 }]);
  assert.equal(negotiate(state, ['MAT_001']).reason, 'NOT_ACQUAINTED');

  const fought = fight(state);
  assert.equal(fought.cost, 4);
  assert.equal(state.explore.mood, 9);
  assert.equal(state.explore.pendingEncounter, null);

  settleNode(state, 'RESOURCE');
  assert.equal(state.explore.mood, 7);
  assert.equal(state.explore.depth, 2);

  settleNode(state, 'ENCOUNTER');
  state.explore.pendingEncounter = 'ANT_FOREMAN';
  const fled = flee(state, 'MAT_001');
  assert.equal(fled.fell, false);
  assert.equal(fled.cost, 3);
  assert.equal(state.explore, null);

  closeDay(state);
  const advanced = nextDay(state);
  assert.equal(advanced.ok, true);
  assert.equal(state.day, 2);
  assert.deepEqual(state.invites, []);
  assert.deepEqual(state.pendingVisitors, []);
});

// ============================================================
// N17~N22：谈判校验/取整、邀请到访、pendingPickup、小食共用
// ============================================================

test('N17 谈判先校验后扣除：野餐盒 1 份却报 2 份 → NO_ITEM，状态不变', () => {
  const state = makeEncounter('APPRENTICE_PALADIN');
  state.explore.lunchbox = { SNK_001: 1 };

  const snapshot = () => JSON.stringify({
    mood: state.explore.mood,
    depth: state.explore.depth,
    lunchbox: state.explore.lunchbox,
    backpack: state.explore.backpack,
    pending: state.explore.pendingEncounter,
    tried: state.explore.negotiationTried,
    affection: state.affectionExp.APPRENTICE_PALADIN,
    fragments: state.fragments,
  });
  const before = snapshot();

  const result = negotiate(state, ['SNK_001', 'SNK_001']);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_ITEM');
  assert.equal(snapshot(), before);
  assert.equal(state.explore.lunchbox.SNK_001, 1);
  assert.equal(state.affectionExp.APPRENTICE_PALADIN, 100);
  assert.equal(state.explore.pendingEncounter, 'APPRENTICE_PALADIN');
  assert.equal(state.explore.negotiationTried, false);
});

test('N18 谈判取整规则：26 / 1 / 21（字面值）', () => {
  const paladin = createInitialState({ seed: 1 });
  paladin.affectionExp.APPRENTICE_PALADIN = 100;
  assert.equal(negotiationChance(paladin, 'APPRENTICE_PALADIN', ['MAT_001', 'MAT_001']), 26);
  assert.equal(negotiationChance(paladin, 'APPRENTICE_PALADIN', ['SNK_001', 'MAT_003', 'MAT_003']), 1);

  const ant = createInitialState({ seed: 1 });
  ant.affectionExp.ANT_FOREMAN = 10;
  assert.equal(negotiationChance(ant, 'ANT_FOREMAN', ['MAT_001', 'MAT_001', 'MAT_001']), 21);
});

test('N19 邀请到访：强制抽中，真实 nextDay → pendingVisitors 含 NPC、invites 清空', () => {
  const state = createInitialState({ seed: 1 });
  startExplore(state);
  state.explore.pendingEncounter = 'ANT_FOREMAN';

  assert.equal(invite(state).ok, true);
  assert.deepEqual(state.invites, [{ npcId: 'ANT_FOREMAN', day: 1 }]);

  assert.equal(returnHome(state).fell, false);
  closeDay(state);
  assert.equal(state.closed, true);

  // nextDay 流程里只有 rollInvitations 调用 chancePercent（本用例打烊时池内无客人）
  const original = state.rng.chancePercent;
  state.rng.chancePercent = () => true;
  let advanced;
  try {
    advanced = nextDay(state);
  } finally {
    state.rng.chancePercent = original;
  }

  assert.equal(advanced.ok, true);
  assert.equal(state.day, 2);
  assert.deepEqual(state.pendingVisitors, ['ANT_FOREMAN']);
  assert.deepEqual(state.invites, []);
  const visitorEvents = advanced.events.filter((event) => event.type === 'visitorInvited');
  assert.equal(visitorEvents.length, 1);
  assert.equal(visitorEvents[0].npcId, 'ANT_FOREMAN');
  assert.equal(visitorEvents[0].day, 2);
});

test('N20 谈判成功且背包满：pending 圣水样品；回店/逃跑 NEED_SWAP；放弃后回店成功', () => {
  const state = makeEncounter('APPRENTICE_PALADIN');
  state.explore.lunchbox = { SNK_001: 1 };
  state.explore.backpack = Array.from({ length: 8 }, () => ({ itemId: 'MAT_001', count: 5 }));

  const restore = forceChance(state, true);
  let negotiated;
  try {
    negotiated = negotiate(state, ['SNK_001']);
  } finally {
    restore();
  }

  assert.equal(negotiated.ok, true);
  assert.equal(negotiated.success, true);
  assert.equal(negotiated.chance, 38);
  assert.equal(negotiated.gift, 'HOLY_WATER_SAMPLE');
  assert.equal(negotiated.needSwap, true);
  assert.deepEqual(state.explore.pendingPickup, { itemId: 'HOLY_WATER_SAMPLE', count: 1 });
  assert.equal(state.explore.pendingEncounter, null);
  assert.equal(state.explore.lunchbox.SNK_001, 0);
  assert.equal(state.explore.backpack.length, 8);
  assert.equal(state.affectionExp.APPRENTICE_PALADIN, 110);
  assert.equal(state.explore.mood, 16);
  assert.equal(state.explore.depth, 0);

  const snapshot = () => JSON.stringify({
    mood: state.explore.mood,
    depth: state.explore.depth,
    backpack: state.explore.backpack,
    lunchbox: state.explore.lunchbox,
    pendingPickup: state.explore.pendingPickup,
    affection: state.affectionExp.APPRENTICE_PALADIN,
    gold: state.gold,
    inventory: state.inventory,
  });
  const before = snapshot();

  assert.equal(returnHome(state).reason, 'NEED_SWAP');
  assert.equal(flee(state, 'MAT_001').reason, 'NEED_SWAP');
  assert.equal(snapshot(), before);

  assert.equal(discardPending(state).ok, true);
  assert.equal(state.explore.pendingPickup, null);
  assert.equal(state.explore.backpack.length, 8);

  const returned = returnHome(state);
  assert.equal(returned.ok, true);
  assert.equal(returned.fell, false);
  assert.equal(returned.cost, 0);
  assert.equal(state.explore, null);
  assert.equal(state.inventory.MAT_001, 42);
  assert.equal(state.inventory.SNK_001, 3);
  assert.equal(state.inventory.HOLY_WATER_SAMPLE, undefined);
});

test('N21 战斗胜利且背包满：pending 地热碎晶；换第 1 格后回店；被换整叠消失', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.explore.depth = 3;
  state.explore.mood = 13;
  state.affectionExp.ANT_FOREMAN = 50;
  state.explore.backpack = [
    { itemId: 'PURE_ANT_ACID', count: 5 },
    ...Array.from({ length: 7 }, () => ({ itemId: 'MAT_002', count: 5 })),
  ];

  const fought = fight(state);
  assert.equal(fought.ok, true);
  assert.equal(fought.cost, 4);
  assert.equal(fought.loot, 'GEOTHERMAL_SHARD');
  assert.equal(fought.needSwap, true);
  assert.deepEqual(state.explore.pendingPickup, { itemId: 'GEOTHERMAL_SHARD', count: 1 });
  assert.equal(state.explore.pendingEncounter, null);
  assert.equal(state.explore.mood, 9);
  assert.equal(state.explore.depth, 3);
  assert.equal(state.affectionExp.ANT_FOREMAN, 30);

  const snapshot = () => JSON.stringify({
    mood: state.explore.mood,
    depth: state.explore.depth,
    backpack: state.explore.backpack,
    pendingPickup: state.explore.pendingPickup,
    affection: state.affectionExp.ANT_FOREMAN,
    inventory: state.inventory,
  });
  const before = snapshot();

  assert.equal(returnHome(state).reason, 'NEED_SWAP');
  // 背包里没有 MAT_001：NEED_SWAP 必须早于 NO_MATERIAL
  assert.equal(flee(state, 'MAT_001').reason, 'NEED_SWAP');
  assert.equal(snapshot(), before);

  const swapped = swapPending(state, 1);
  assert.equal(swapped.ok, true);
  assert.deepEqual(swapped.removed, { itemId: 'PURE_ANT_ACID', count: 5 });
  assert.deepEqual(state.explore.backpack[0], { itemId: 'GEOTHERMAL_SHARD', count: 1 });
  assert.equal(state.explore.backpack.length, 8);

  const returned = returnHome(state);
  assert.equal(returned.ok, true);
  assert.equal(returned.fell, false);
  assert.equal(returned.cost, 3);
  assert.equal(state.explore, null);
  assert.equal(state.inventory.GEOTHERMAL_SHARD, 1);
  assert.equal(state.inventory.MAT_002, 39);
  assert.equal(state.inventory.MAT_001, 2);
  assert.equal(state.inventory.PURE_ANT_ACID, undefined);
});

test('N22 小食共用：谈判消耗野餐盒；pending 期间吃小食仍允许（eat 不拦）', () => {
  const state = createInitialState({ seed: 1 });
  state.inventory.SNK_001 = 4;
  assert.equal(startExplore(state, { lunchbox: { SNK_001: 4 } }).ok, true);
  state.explore.pendingEncounter = 'APPRENTICE_PALADIN';
  state.affectionExp.APPRENTICE_PALADIN = 100;
  state.explore.mood = 10;
  state.explore.depth = 2;
  // 背包塞满，让谈判回礼走 NEED_SWAP，从而在 pending 状态下验证 eat
  state.explore.backpack = Array.from({ length: 8 }, () => ({ itemId: 'MAT_001', count: 5 }));

  const restore = forceChance(state, true);
  try {
    negotiate(state, ['SNK_001', 'SNK_001']);
  } finally {
    restore();
  }

  assert.equal(state.explore.lunchbox.SNK_001, 2);
  assert.deepEqual(state.explore.pendingPickup, { itemId: 'HOLY_WATER_SAMPLE', count: 1 });
  assert.equal(state.explore.mood, 10);
  assert.equal(state.explore.depth, 2);

  assert.deepEqual(eat(state), { ok: true, mood: 13, lunchbox: 1 });
  assert.equal(state.explore.lunchbox.SNK_001, 1);

  // 现状口径：pending 期间 eat 不被拦截
  const pendingEat = eat(state);
  assert.equal(pendingEat.ok, true);
  assert.equal(pendingEat.mood, 16);
  assert.equal(state.explore.lunchbox.SNK_001, 0);
  assert.deepEqual(state.explore.pendingPickup, { itemId: 'HOLY_WATER_SAMPLE', count: 1 });
});

test('Y13 重录：强制蚁工头战斗→资源→回店快照', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.explore.depth = 1;
  state.explore.mood = 13;
  state.affectionExp.ANT_FOREMAN = 50;

  const fought = fight(state);
  assert.equal(fought.cost, 4);
  assert.equal(state.explore.mood, 9); // N23 补断言：13 − 4，旧期望未改
  assert.deepEqual(state.explore.backpack, [{ itemId: 'GEOTHERMAL_SHARD', count: 1 }]);

  settleNode(state, 'RESOURCE');
  assert.equal(state.explore.mood, 7);
  assert.equal(state.explore.depth, 2);

  const returned = returnHome(state);
  assert.equal(returned.fell, false);
  assert.equal(returned.cost, 2);
  assert.equal(state.explore, null);
});

test('N24 pendingPickup 时 advance / settleNode 返回 NEED_SWAP，状态不变', () => {
  const state = makeEncounter('ANT_FOREMAN');
  state.explore.pendingEncounter = null;
  state.explore.pendingPickup = { itemId: 'MAT_001', count: 1 };
  state.explore.mood = 12;
  state.explore.depth = 4;
  state.explore.backpack = [{ itemId: 'MAT_002', count: 2 }];
  state.explore.lunchbox = { SNK_001: 1 };

  const snapshot = () => JSON.stringify({
    mood: state.explore.mood,
    depth: state.explore.depth,
    backpack: state.explore.backpack,
    lunchbox: state.explore.lunchbox,
    pendingPickup: state.explore.pendingPickup,
  });
  const before = snapshot();

  const advanced = advance(state);
  assert.equal(advanced.ok, false);
  assert.equal(advanced.reason, 'NEED_SWAP');
  assert.equal(snapshot(), before);

  const settled = settleNode(state, 'RESOURCE');
  assert.equal(settled.ok, false);
  assert.equal(settled.reason, 'NEED_SWAP');
  assert.equal(snapshot(), before);
});
