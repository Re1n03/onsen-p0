/**
 * tests/npc.test.js — 新增到访者 NPC（ANT_R3 / CLERGY_R4 / ANT_R5，K1~K8）
 *
 * 名字与 id 为占位：K1 的 name 字面值 + K8 的 queueGuestName 字面值，改名时只改这两处。
 * 期望值全部写死字面数字，不由 config / 被测代码计算。
 * 本文件只测「到访者」接线；三位不在 EXPLORE.ENCOUNTER_CHANCE_PCT 里（K5 证明）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENCOUNTERS, EXPLORE, GUESTS, ITEM_VALUES } from '../config.js';
import { createInitialState } from '../src/state.js';
import { closeDay, nextDay } from '../src/actions.js';
import { tick } from '../src/clock.js';
import {
  getTempZone,
  hasFactionConflict,
  tempZoneWidthBp,
  validateTempZones,
} from '../src/bath.js';
import { naturalVisitChance } from '../src/visit.js';
import { drawEncounter } from '../src/explore.js';
import { createRng } from '../src/rng.js';

const NEW_IDS = ['ANT_R3', 'CLERGY_R4', 'ANT_R5'];

// ============================================================
// K1 配置字面值
// ============================================================
const EXPECTED = {
  ANT_R3: {
    name: '蚁族3阶',
    race: 'ANT',
    rank: 3,
    startAffinityExp: 0,
    minHouseLevel: 3,
    requiredFacility: null,
    guaranteeDay: null,
    tempZone: { favorite: [330, 400], tolerant: [250, 430] },
    gift: 'PURE_ANT_ACID',
    fightLoot: 'GEOTHERMAL_SHARD',
  },
  CLERGY_R4: {
    name: '圣职4阶',
    race: 'CLERGY',
    rank: 4,
    startAffinityExp: 0,
    minHouseLevel: 4,
    requiredFacility: null,
    guaranteeDay: null,
    tempZone: { favorite: [410, 448], tolerant: [380, 465] },
    gift: 'HOLY_WATER_SAMPLE',
    fightLoot: 'HOLY_WATER_SAMPLE',
  },
  ANT_R5: {
    name: '蚁族5阶',
    race: 'ANT',
    rank: 5,
    startAffinityExp: 0,
    minHouseLevel: 5,
    requiredFacility: null,
    guaranteeDay: null,
    tempZone: { favorite: [350, 394], tolerant: [320, 420] },
    gift: 'PURE_ANT_ACID',
    fightLoot: 'GEOTHERMAL_SHARD',
  },
};

test('K1 配置字面值：三位 NPC 的 8 个字段逐项字面值；gift/fightLoot 是 ITEM_VALUES 物品', () => {
  for (const id of NEW_IDS) {
    const npc = ENCOUNTERS[id];
    const expected = EXPECTED[id];
    assert.ok(npc, `${id} 应存在于 ENCOUNTERS`);
    for (const field of [
      'name', 'race', 'rank', 'startAffinityExp', 'minHouseLevel',
      'requiredFacility', 'guaranteeDay',
    ]) {
      assert.deepEqual(npc[field], expected[field], `${id}.${field}`);
    }
    assert.deepEqual(npc.tempZone, expected.tempZone, `${id}.tempZone`);
    assert.equal(npc.gift, expected.gift, `${id}.gift`);
    assert.equal(npc.fightLoot, expected.fightLoot, `${id}.fightLoot`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(ITEM_VALUES, npc.gift),
      `${id}.gift=${npc.gift} 应是 ITEM_VALUES 里存在的物品 id`,
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(ITEM_VALUES, npc.fightLoot),
      `${id}.fightLoot=${npc.fightLoot} 应是 ITEM_VALUES 里存在的物品 id`,
    );
  }
});

// ============================================================
// K2 配置校验与宽度比例
// ============================================================
test('K2 配置校验：validateTempZones() 为 []；宽度万分比 5833/6923、5428/5312、3666/3846', () => {
  assert.deepEqual(validateTempZones(), []);

  const cases = [
    ['ANT_R3', 'ANT', 5833, 6923],
    ['CLERGY_R4', 'CLERGY', 5428, 5312],
    ['ANT_R5', 'ANT', 3666, 3846],
  ];
  for (const [npcId, race, favoriteBp, tolerantBp] of cases) {
    assert.equal(tempZoneWidthBp(race, npcId, 'favorite'), favoriteBp, `${npcId} favorite`);
    assert.equal(tempZoneWidthBp(race, npcId, 'tolerant'), tolerantBp, `${npcId} tolerant`);
  }
});

// ============================================================
// K3 门槛与随机数
// ============================================================
function openNextDay(state) {
  closeDay(state);
  return nextDay(state);
}

test('K3 门槛与随机数：馆1/2 不消耗 visitRng；馆3/4/5 强制通过时 pending 顺序字面值', () => {
  // 馆 1/2：种子 20261111，真实 nextDay 到第 2 天；rng/visitRng 与 pending 为闸门 0 实测基线
  for (const level of [1, 2]) {
    const state = createInitialState({ seed: 20261111 });
    state.houseLevel = level;
    openNextDay(state);
    assert.equal(state.day, 2);
    assert.equal(state.rng.getSeed(), 3683392737, `馆${level} state.rng`);
    assert.equal(state.visitRng.getSeed(), 2042861210, `馆${level} visitRng`);
    assert.deepEqual(state.pendingVisitors, [
      { npcId: 'APPRENTICE_PALADIN', source: 'natural', day: 2 },
    ]);
    for (const id of NEW_IDS) {
      assert.equal(
        state.pendingVisitors.some((entry) => entry.npcId === id),
        false,
        `馆${level} 不应出现 ${id}`,
      );
    }
  }

  // 馆 3/4/5：强制自然掷点通过（沿用 N28 的 forceChance 手法），pending 顺序 = ENCOUNTERS 插入顺序过滤门槛
  const expectedPending = {
    3: ['ANT_FOREMAN', 'APPRENTICE_PALADIN', 'ANT_R3'],
    4: ['ANT_FOREMAN', 'APPRENTICE_PALADIN', 'ANT_R3', 'CLERGY_R4'],
    5: ['ANT_FOREMAN', 'APPRENTICE_PALADIN', 'ANT_R3', 'CLERGY_R4', 'ANT_R5'],
  };
  for (const level of [3, 4, 5]) {
    const state = createInitialState({ seed: 20261111 });
    state.houseLevel = level;
    closeDay(state);
    const original = state.visitRng.chancePercent;
    state.visitRng.chancePercent = () => true;
    try {
      nextDay(state);
    } finally {
      state.visitRng.chancePercent = original;
    }
    assert.equal(state.day, 2);
    assert.deepEqual(
      state.pendingVisitors.map((entry) => entry.npcId),
      expectedPending[level],
      `馆${level} pending 顺序`,
    );
  }
});

// ============================================================
// K4 到访概率字面值
// ============================================================
test('K4 到访概率字面值：ANT_R3 30/50/75；CLERGY_R4 馆4/5 40/65；ANT_R5 馆5 55', () => {
  const cases = [
    [3, 30, null, null],
    [4, 50, 40, null],
    [5, 75, 65, 55],
  ];
  for (const [level, r3, c4, r5] of cases) {
    const state = createInitialState({ seed: 1 });
    state.houseLevel = level;
    state.facilities = [];
    assert.equal(naturalVisitChance(state, 'ANT_R3'), r3, `馆${level} ANT_R3`);
    if (c4 !== null) assert.equal(naturalVisitChance(state, 'CLERGY_R4'), c4, `馆${level} CLERGY_R4`);
    if (r5 !== null) assert.equal(naturalVisitChance(state, 'ANT_R5'), r5, `馆${level} ANT_R5`);
  }
});

// ============================================================
// K5 不进遭遇表
// ============================================================
test('K5 不进遭遇表：ENCOUNTER_CHANCE_PCT 键严格为两位旧 NPC；drawEncounter 1 万次只命中这两位', () => {
  assert.deepEqual(
    Object.keys(EXPLORE.ENCOUNTER_CHANCE_PCT),
    ['ANT_FOREMAN', 'APPRENTICE_PALADIN'],
  );
  const rng = createRng(1);
  const seen = new Set();
  for (let index = 0; index < 10000; index += 1) seen.add(drawEncounter(rng));
  assert.deepEqual([...seen].sort(), ['ANT_FOREMAN', 'APPRENTICE_PALADIN']);
});

// ============================================================
// K6 到店全路径（真实 tick）
// ============================================================
/**
 * 手算口径（三位共用）：
 *  水温夹具每秒重置到目标温度，回落 1 秒后仍在该 NPC 的喜爱区 → Temp_Match 1.50；
 *  洁净度全程 ≥60.0 → Clean_Factor 1.00；P0 无 Speed_Bonus。
 *  初始满意度 20.00 + 每秒 +1.50 × 60 秒 = 110.00 → 夹紧到 100.00。
 *  玩家经验 = 满意度档位 5（≥80.00）+ 到访者加成 10 = 15。
 *  好感 = 到店 +10 + 高满意离场（≥80.00）+20 = 30。
 *  声望 = 该阵营首次 +1（满意度 ≥80 离场）。
 *  金币 = 门票 50 + 小费 floor(30 × 1.00 × 1.00 × 1.00) = 80。
 */
function runVisitorPath(npcId, houseLevel, tempFixture) {
  const state = createInitialState({ seed: 11 });
  state.houseLevel = houseLevel;
  state.day = 5; // 非教学日，玩家经验会入账
  state.pendingVisitors = [{ npcId, source: 'natural', day: 5 }];
  state.nextArrivalAt = 1;

  const events = [];
  let seated = null;
  let leave = null;
  for (let second = 0; second < 200 && !leave; second += 1) {
    state.pool.temp = tempFixture; // 夹具：维持目标水温
    for (const event of tick(state)) {
      events.push(event);
      if (event.type === 'visitorSeated') seated = event;
      if ((event.type === 'guestLeft' || event.type === 'guestAngryLeft') && event.guestId === npcId) {
        leave = event;
      }
    }
  }
  return { state, seated, leave, events };
}

test('K6 到店全路径：允许排队入座、停满 60 秒正常离场；满意度/经验/好感/声望字面值', () => {
  const cases = [
    // 37.0℃ ∈ ANT_R3 个人喜爱区 [330,400]；37.0℃ ∈ ANT_R5 个人喜爱区 [350,394]
    { npcId: 'ANT_R3', level: 3, temp: 370, faction: 'NEUTRAL' },
    // 42.0℃ ∈ CLERGY_R4 个人喜爱区 [410,448]
    { npcId: 'CLERGY_R4', level: 4, temp: 420, faction: 'ORDER' },
    { npcId: 'ANT_R5', level: 5, temp: 370, faction: 'NEUTRAL' },
  ];

  for (const { npcId, level, temp, faction } of cases) {
    const { state, seated, leave } = runVisitorPath(npcId, level, temp);

    assert.equal(seated.npcId, npcId, `${npcId} 应入座`);
    assert.equal(leave.type, 'guestLeft', `${npcId} 应正常离场（不是怒离）`);
    assert.equal(leave.mode, 'normal');
    assert.equal(leave.at, 60, `${npcId} 停满 60 秒离场`);

    // 满意度：20.00 + 60 × 1.50 = 110.00 → 上限 100.00
    assert.equal(leave.comfort, 10000, `${npcId} 离场满意度`);
    // 玩家经验：档位 5 + 到访者 10 = 15
    assert.equal(state.playerExp, 15, `${npcId} playerExp`);
    assert.deepEqual(state.expLog, [
      { type: 'expGained', at: 60, amount: 15, source: 'guest', playerLevel: 1, playerExp: 15 },
    ]);
    // 好感：到店 10 + 高满意 20 = 30
    assert.equal(state.affectionExp[npcId], 30, `${npcId} 好感经验`);
    // 声望：NEUTRAL / ORDER 首次 +1
    assert.equal(state.reputation[faction], 1, `${npcId} ${faction} 声望`);
    // 金币：门票 50 + 小费 30 = 80
    assert.equal(leave.ticket, 50, `${npcId} 门票`);
    assert.equal(leave.tip, 30, `${npcId} 小费`);
    assert.equal(leave.gold, 80, `${npcId} 金币`);
  }
});

// ============================================================
// K7 阵营与温度
// ============================================================
function feasibleIntervals(personA, personB) {
  const temps = [];
  for (let temp = 0; temp <= 1000; temp += 1) {
    const zoneA = getTempZone(personA.race, temp, personA.npcId);
    const zoneB = getTempZone(personB.race, temp, personB.npcId);
    const ok = (zone) => zone === 'FAVORITE' || zone === 'TOLERANT';
    if (ok(zoneA) && ok(zoneB)) temps.push(temp);
  }
  const intervals = [];
  for (const temp of temps) {
    const last = intervals[intervals.length - 1];
    if (last && temp === last[1] + 1) last[1] = temp;
    else intervals.push([temp, temp]);
  }
  return intervals;
}

test('K7 阵营与温度：圣职×亡灵冲突且无解；ANT_R3×CLERGY_R4=[380,430]、CLERGY_R4×ANT_R5=[380,420]', () => {
  const boneKing = { race: GUESTS.GUEST_BONE_KING_GUARD.race, npcId: null };
  const skeleton = { race: GUESTS.GUEST_WANDERING_SKELETON.race, npcId: null };
  const clergy = { race: 'CLERGY', npcId: 'CLERGY_R4' };
  const antR3 = { race: 'ANT', npcId: 'ANT_R3' };
  const antR5 = { race: 'ANT', npcId: 'ANT_R5' };

  for (const undead of [boneKing, skeleton]) {
    assert.equal(hasFactionConflict(clergy, undead), true);
    // 圣职个人耐受 [380,465] 与亡灵种族耐受 [100,350] 无交集 → 0~1000 内无任何水温可行
    assert.deepEqual(feasibleIntervals(clergy, undead), []);
  }

  assert.deepEqual(feasibleIntervals(antR3, clergy), [[380, 430]]);
  assert.deepEqual(feasibleIntervals(clergy, antR5), [[380, 420]]);
});

// ============================================================
// K8 UI：候位名称与色带
// ============================================================
// 假 DOM（与 tests/ui.test.js 同构）：ui.js 在模块初始化时会建 DOM 引用，
// 故必须先铺好 document 再动态 import。用带 query 的模块 URL 拿到独立实例，
// 避免与 tests/ui.test.js 的模块缓存互相串扰。
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.textContent = '';
    this.style = {};
    this._innerHTML = '';
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  closest() {
    return null;
  }
}

const k8Elements = new Map();
for (const id of [
  'hud', 'speed-buttons', 'pool-state', 'slots', 'seat-cards', 'queue', 'tray',
  'inventory', 'shop', 'overlay', 'report', 'toast', 'seed', 'run-buttons', 'pool-actions',
]) {
  k8Elements.set(id, new FakeElement('div'));
}

globalThis.document = {
  getElementById: (id) => k8Elements.get(id) ?? null,
  createElement: (tag) => new FakeElement(tag),
  addEventListener: () => {},
};
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};

const ui = await import('../src/ui.js?npc-k8');

test('K8 UI：三位候位名称字面值；ANT_R5 色带 7 段字面值', () => {
  assert.equal(ui.queueGuestName('ANT_R3'), '蚁族3阶');
  assert.equal(ui.queueGuestName('CLERGY_R4'), '圣职4阶');
  assert.equal(ui.queueGuestName('ANT_R5'), '蚁族5阶');

  assert.deepEqual(ui.bandSegmentsFor({ race: 'ANT', guestId: 'ANT_R5' }), [
    { zone: 'EXTREME', from: 0, to: 100 },
    { zone: 'UNCOMFORTABLE', from: 100, to: 320 },
    { zone: 'TOLERANT', from: 320, to: 350 },
    { zone: 'FAVORITE', from: 350, to: 394 },
    { zone: 'TOLERANT', from: 394, to: 420 },
    { zone: 'UNCOMFORTABLE', from: 420, to: 520 },
    { zone: 'EXTREME', from: 520, to: 1000 },
  ]);
});
