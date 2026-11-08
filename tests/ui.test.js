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
