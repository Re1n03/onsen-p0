/**
 * tests/ui.test.js — 界面稳定性检查（假 DOM，不需要浏览器）
 *
 * 目的：
 *  1. 连续 render 3 次后，所有可交互元素还是同一个节点（引用相等）；
 *  2. 倍速按钮在任意倍速下都能点击切换；
 *  3. 点击已占用投料槽会弹出「这个槽位还在生效中」；
 *  4. 提示条 2 秒后消失（setTimeout 收到 2000）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantExp } from '../src/player.js';
import { buildHouse } from '../src/actions.js';

// ---------------- 最小假 DOM ----------------
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
    this.value = '';
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

  // 只支持 '[data-action]'：从点击目标向上找带 data-action 的祖先
  closest(selector) {
    if (selector !== '[data-action]') return null;
    let node = this;
    while (node) {
      if (node.dataset && node.dataset.action) return node;
      node = node.parentNode;
    }
    return null;
  }
}

const elements = new Map();
for (const id of [
  'hud', 'speed-buttons', 'pool-state', 'slots', 'seat-cards', 'queue', 'tray',
  'inventory', 'shop', 'overlay', 'report', 'toast', 'seed', 'run-buttons', 'pool-actions',
]) {
  elements.set(id, new FakeElement('div'));
}

let documentClickHandler = null;
globalThis.document = {
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tag) => new FakeElement(tag),
  addEventListener: (type, handler) => {
    if (type === 'click') documentClickHandler = handler;
  },
};

const timeoutDelays = [];
globalThis.setInterval = () => 1;
globalThis.clearInterval = () => {};
globalThis.setTimeout = (fn, ms) => {
  timeoutDelays.push(ms);
  return timeoutDelays.length;
};
globalThis.clearTimeout = () => {};

// 假 DOM 就绪后再加载页面脚本
const ui = await import('../src/ui.js');

const click = (node) => ui.handleClick({ target: node });
const clickEl = (dataset) => {
  const node = new FakeElement('button');
  Object.assign(node.dataset, dataset);
  return node;
};

// ============================================================
// 1. 可交互元素在 render 之后引用不变
// ============================================================
test('连续 render 3 次后，可交互元素仍是同一批节点（引用相等）', () => {
  const snapshot = () => ({
    speed: [...ui.interactive.speedButtons],
    slots: ui.interactive.slots.map((entry) => entry.node),
    inventory: ui.interactive.inventoryButtons.map((entry) => entry.node),
    shop: [...ui.interactive.shopButtons],
    bubbles: ui.interactive.bubbles.map((entry) => entry.node),
    water: [ui.interactive.waterButton],
    close: [ui.interactive.closeButton],
    restart: [...ui.interactive.restartButtons],
  });

  const before = snapshot();
  ui.render();
  ui.render();
  ui.render();
  const after = snapshot();

  for (const key of Object.keys(before)) {
    assert.equal(after[key].length, before[key].length, `${key} 数量变了`);
    for (let index = 0; index < before[key].length; index += 1) {
      assert.equal(after[key][index], before[key][index], `${key}[${index}] 被重画替换了`);
    }
  }
});

// ============================================================
// 2. 任意倍速下，倍速按钮都能点击
// ============================================================
test('倍速按钮在任意倍速下都可点击切换', () => {
  const bySpeed = new Map(ui.interactive.speedButtons.map((button) => [Number(button.dataset.speed), button]));

  for (const target of [20, 1, 5, 1, 20, 5, 1]) {
    click(bySpeed.get(target));
    assert.equal(ui.getSpeed(), target, `切到 ×${target} 没生效`);
  }
});

// ============================================================
// 3. 点击已占用的投料槽 → 明确提示
// ============================================================
test('点击已占用投料槽 → 弹出「这个槽位还在生效中」', () => {
  const material = ui.interactive.inventoryButtons.find((entry) => entry.id === 'MAT_002');
  click(material.node);              // 选中 MAT_002
  const slot = ui.interactive.slots[0].node;

  click(slot);                       // 投入成功
  assert.equal(slot.className, 'slot filled');

  click(slot);                       // 再点已占用
  assert.equal(elements.get('toast').textContent, '这个槽位还在生效中');
  assert.equal(elements.get('toast').hidden, false);
  assert.equal(timeoutDelays.at(-1), 2000);
});

// ============================================================
// U1 遭遇 NPC 客人的候位名称与座位色带（纯函数）
// ============================================================
test('U1 候位名称与色带：遭遇 NPC 按 ENCOUNTERS 名称与个人区间', () => {
  assert.equal(ui.queueGuestName('ANT_FOREMAN'), '红魔蚁工头');
  assert.equal(ui.queueGuestName('GUEST_BONE_KING_GUARD'), '骨王近卫');
  assert.equal(ui.queueGuestName('NOT_A_GUEST'), 'NOT_A_GUEST');

  assert.deepEqual(ui.bandSegmentsFor({ race: 'CLERGY', guestId: 'APPRENTICE_PALADIN' }), [
    { zone: 'EXTREME', from: 0, to: 180 },
    { zone: 'UNCOMFORTABLE', from: 180, to: 340 },
    { zone: 'TOLERANT', from: 340, to: 400 },
    { zone: 'FAVORITE', from: 400, to: 450 },
    { zone: 'TOLERANT', from: 450, to: 480 },
    { zone: 'UNCOMFORTABLE', from: 480, to: 520 },
    { zone: 'EXTREME', from: 520, to: 1000 },
  ]);
});

// ============================================================
// 批 A（U2~U5）：HUD 只读展示与渲染安全
// ============================================================
function resetUi() {
  elements.get('seed').value = '1';
  click(ui.interactive.restartButtons[0]);
  return ui.getState();
}

function findHud(hudKey) {
  const walk = (node) => {
    if (node.dataset && node.dataset.hud === hudKey) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(elements.get('hud'));
}

function throwingRng(label) {
  const boom = () => {
    throw new Error(`${label} 不应在渲染路径被调用`);
  };
  return {
    getSeed: boom,
    nextUint32: boom,
    next: boom,
    nextInt: boom,
    chancePercent: boom,
    pick: boom,
    pickWeighted: boom,
  };
}

// ============================================================
// U2 玩家等级与经验条
// ============================================================
test('U2 玩家等级与经验条：教学日小字、进度计算、不读 expLog、真实 grantExp 升 2 级', () => {
  const state = resetUi();

  assert.equal(findHud('player-level').textContent, '玩家 Lv.1');
  assert.equal(findHud('player-exp-text').textContent, '0/60');
  assert.equal(findHud('player-exp-fill').style.width, '0%');
  assert.equal(findHud('teach-note').hidden, false);
  assert.equal(findHud('teach-note').textContent, '教学日不计经验');

  state.day = 4;
  ui.render();
  assert.equal(findHud('teach-note').hidden, true);

  state.playerExp = 30;
  ui.render();
  assert.equal(findHud('player-exp-text').textContent, '30/60');
  assert.equal(findHud('player-exp-fill').style.width, '50%');

  // 塞入明显错误的假 expGained，证明渲染不读 expLog
  state.expLog.push({
    type: 'expGained',
    at: 10,
    amount: 9999,
    source: 'guest',
    playerLevel: 10,
    playerExp: 9999,
  });
  ui.render();
  assert.equal(findHud('player-level').textContent, '玩家 Lv.1');
  assert.equal(findHud('player-exp-text').textContent, '30/60');
  assert.equal(findHud('player-exp-fill').style.width, '50%');

  // 经验超出升级所需时进度条夹紧到 100%
  state.playerExp = 90;
  ui.render();
  assert.equal(findHud('player-exp-text').textContent, '90/60');
  assert.equal(findHud('player-exp-fill').style.width, '100%');

  // 真实 grantExp 升到 2 级
  state.playerExp = 0;
  const gained = grantExp(state, 60, 'guest', 0);
  assert.equal(gained.levels, 1);
  ui.render();
  assert.equal(findHud('player-level').textContent, '玩家 Lv.2');
  assert.equal(findHud('player-exp-text').textContent, '0/67');
  assert.equal(findHud('player-exp-fill').style.width, '0%');
});

// ============================================================
// U3 满级显示
// ============================================================
test('U3 满级：真实 grantExp 升至 30 级显示已满级与 100%，再入账 capped 后不变', () => {
  const state = resetUi();
  state.day = 4;
  state.playerLevel = 29;
  state.playerExp = 0;

  grantExp(state, 99999, 'guest', 0);
  ui.render();

  assert.equal(findHud('player-level').textContent, '玩家 Lv.30');
  assert.equal(findHud('player-exp-text').textContent, '已满级');
  assert.equal(findHud('player-exp-fill').style.width, '100%');
  assert.equal(findHud('teach-note').hidden, true);

  const capped = grantExp(state, 100, 'guest', 1);
  assert.equal(capped.capped, true);
  ui.render();

  assert.equal(findHud('player-level').textContent, '玩家 Lv.30');
  assert.equal(findHud('player-exp-text').textContent, '已满级');
  assert.equal(findHud('player-exp-fill').style.width, '100%');
});

// ============================================================
// U4 馆等级显示
// ============================================================
test('U4 馆等级：1~5 级、undefined/null 回退馆 1、真实 buildHouse 升至馆 2', () => {
  const state = resetUi();

  for (const level of [1, 2, 3, 4, 5]) {
    state.houseLevel = level;
    ui.render();
    assert.equal(findHud('house-level').textContent, `馆 Lv.${level}`);
  }

  delete state.houseLevel;
  ui.render();
  assert.equal(findHud('house-level').textContent, '馆 Lv.1');

  state.houseLevel = null;
  ui.render();
  assert.equal(findHud('house-level').textContent, '馆 Lv.1');

  // 真实 buildHouse 流程
  const fresh = resetUi();
  fresh.playerLevel = 5;
  fresh.gold = 3000;
  fresh.inventory = { MAT_001: 1, MAT_002: 1, MAT_003: 1 };
  const built = buildHouse(fresh);
  assert.equal(built.ok, true);
  ui.render();
  assert.equal(findHud('house-level').textContent, '馆 Lv.2');
});

// ============================================================
// U5 渲染只读且不抽随机数
// ============================================================
test('U5 渲染只读且不抽随机数：种子不变、抛错桩不触发、state 序列化逐字相同', () => {
  const state = resetUi();
  state.playerLevel = 7;
  state.houseLevel = 3;
  state.queue = [
    { guestId: 'GUEST_BONE_KING_GUARD', enqueuedAt: 5 },
    { guestId: 'ANT_FOREMAN', enqueuedAt: 10 },
  ];
  state.expLog = [
    { type: 'expGained', at: 10, amount: 5, source: 'guest', playerLevel: 7, playerExp: 0 },
    { type: 'playerLevelUp', at: 20, level: 7 },
  ];

  // 甲：渲染前后随机流种子不变 + 状态序列化不变
  const rngSeedBefore = state.rng.getSeed();
  const visitSeedBefore = state.visitRng.getSeed();
  const jsonBefore = JSON.stringify(state);

  ui.render();

  assert.equal(elements.get('queue').textContent.includes('骨王近卫'), true);
  assert.equal(elements.get('queue').textContent.includes('红魔蚁工头'), true);
  assert.equal(state.rng.getSeed(), rngSeedBefore);
  assert.equal(state.visitRng.getSeed(), visitSeedBefore);
  assert.equal(JSON.stringify(state), jsonBefore);

  // 乙：替换为一调用就抛错的桩，连续 render 两次不得抛错
  const origRng = state.rng;
  const origVisitRng = state.visitRng;
  const origRandom = Math.random;
  state.rng = throwingRng('state.rng');
  state.visitRng = throwingRng('state.visitRng');
  Math.random = () => {
    throw new Error('Math.random 不应在渲染路径被调用');
  };
  try {
    ui.render();
    ui.render();
  } finally {
    state.rng = origRng;
    state.visitRng = origVisitRng;
    Math.random = origRandom;
  }

  assert.equal(state.rng.getSeed(), rngSeedBefore);
  assert.equal(state.visitRng.getSeed(), visitSeedBefore);
  assert.equal(JSON.stringify(state), jsonBefore);

  resetUi();
});
