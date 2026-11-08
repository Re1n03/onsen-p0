/**
 * ui.js — 页面渲染与输入（P0）
 *
 * 结构原则（修复「点击丢失」的关键）：
 *   1. 所有可交互元素（倍速/重开/投料槽/库存材料/补给/点单气泡/换水/打烊/日报重开）
 *      只在启动时创建一次，tick 只改它们的文字/样式/显隐，绝不替换节点；
 *   2. 点击统一用事件委托，绑在 document 上（稳定父容器），不逐个绑事件；
 *   3. 提示条（toast）在独立的静态容器里，不参与 tick 重画。
 *
 * 这里不实现任何游戏规则；温度区间/色带分段由 bath.js 提供，数值全部来自 config/state。
 */

import {
  UI,
  UNITS,
  TIME,
  TEMP,
  GUEST,
  POOL,
  RACES,
  GUESTS,
  ENCOUNTERS,
  MATERIALS,
  SNACKS,
} from '../config.js';
import { createInitialState, getHeart } from './state.js';
import { tick } from './clock.js';
import { getTempZone, tempBandSegments } from './bath.js';
import { buy, changeWater, closeDay, dropMaterial, dropSnack } from './actions.js';

// ---------- 格式化 ----------
const byId = (id) => document.getElementById(id);
const toPercent = (value, max) => Math.round((value / max) * UNITS.PERCENT);
const fmtTemp = (temp) => `${(temp / UNITS.TEMP_PER_C).toFixed(1)}℃`;
const fmtPoint = (value, perPoint) => (value / perPoint).toFixed(1);
const itemName = (id) => MATERIALS[id]?.name ?? SNACKS[id]?.name ?? id;
const itemPrice = (id) => MATERIALS[id]?.buyPrice ?? SNACKS[id]?.buyPrice;

const ZONE_LABEL = {
  FAVORITE: '喜爱区',
  TOLERANT: '耐受区',
  UNCOMFORTABLE: '不适区（持续扣分）',
  EXTREME: '极限区',
};

const REASON_TEXT = {
  DAY_CLOSED: '今天已经打烊了',
  ALREADY_CLOSED: '今天已经打过烊了',
  NOT_ENOUGH_GOLD: '金币不够',
  UNKNOWN_ITEM: '没有这种物品',
  INVALID_SLOT: '没有这个投料槽',
  SLOT_OCCUPIED: '这个槽位还在生效中',
  NO_ITEM: '背包里没有这件东西',
  GUEST_NOT_FOUND: '这位客人不在池里',
  NO_ORDERING_GUEST: '这位客人现在没有点单',
  TRAY_FULL: '托盘已经有一份小食了',
  ALREADY_CHANGING: '正在换水',
};

const SHOP_IDS = [...Object.keys(MATERIALS), ...Object.keys(SNACKS)];
const INVENTORY_IDS = [...Object.keys(MATERIALS), ...Object.keys(SNACKS)];

// ---------- 只创建一次的节点引用（测试会检查它们引用不变） ----------
export const interactive = {
  speedButtons: [],
  slots: [],           // [{ node, name, note }]
  inventoryButtons: [],// [{ id, node }]
  shopButtons: [],
  bubbles: [],         // [{ index, node }]
  waterButton: null,
  closeButton: null,
  restartButtons: [],
};

const refs = {
  hud: {},
  pool: {},
  seats: [],
  report: {},
};

// ---------- 当前界面状态 ----------
let state = createInitialState();
let speed = UI.SPEEDS[0];
let selectedMaterial = null;
let timer = null;
let toastTimer = null;

// ============================================================
// 一、启动时创建 DOM（之后不再重建）
// ============================================================
function make(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildHud() {
  const hud = byId('hud');
  hud.innerHTML = '';
  for (const key of ['day', 'clock', 'remain', 'gold', 'credit', 'vouchers', 'fragments']) {
    const chip = make('span', 'chip');
    hud.appendChild(chip);
    refs.hud[key] = chip;
  }
}

function buildControls() {
  const speedBox = byId('speed-buttons');
  speedBox.innerHTML = '';
  for (const value of UI.SPEEDS) {
    const button = make('button', 'speed', `×${value}`);
    button.dataset.action = 'speed';
    button.dataset.speed = String(value);
    speedBox.appendChild(button);
    interactive.speedButtons.push(button);
  }

  const runBox = byId('run-buttons');
  runBox.innerHTML = '';
  const restart = make('button', '', '重开');
  restart.dataset.action = 'restart';
  runBox.appendChild(restart);
  interactive.restartButtons.push(restart);
}

function buildPool() {
  const box = byId('pool-state');
  box.innerHTML = '';

  const tempStat = make('div', 'stat');
  tempStat.append(make('span', '', '水温'), refs.pool.tempValue = make('b'));

  const cleanStat = make('div', 'stat');
  cleanStat.append(make('span', '', '洁净度'), refs.pool.cleanValue = make('b'));

  refs.pool.tempStat = tempStat;
  refs.pool.cleanStat = cleanStat;
  refs.pool.warn = make('div', 'warn');
  refs.pool.warn.hidden = true;

  box.append(tempStat, cleanStat, refs.pool.warn);

  const actionBox = byId('pool-actions');
  actionBox.innerHTML = '';
  const water = make('button', '', '换水清池');
  water.dataset.action = 'water';
  const close = make('button', 'danger', '打烊结算');
  close.dataset.action = 'close';
  actionBox.append(water, close);
  interactive.waterButton = water;
  interactive.closeButton = close;
}

function buildSlots() {
  const box = byId('slots');
  box.innerHTML = '';
  for (let index = 0; index < POOL.INGREDIENT_SLOTS; index++) {
    const node = make('button', 'slot');
    node.dataset.action = 'slot';
    node.dataset.slot = String(index + 1);
    const name = make('span');
    const note = make('small');
    node.append(make('span', 'slot-no', `投料槽 ${index + 1}`), name, note);
    box.appendChild(node);
    interactive.slots.push({ node, name, note });
  }
}

function buildSeats() {
  const box = byId('seat-cards');
  box.innerHTML = '';
  for (let index = 0; index < state.seats.length; index++) {
    const card = make('div', 'seat');
    const nameLine = make('div', 'seat-name');
    const nameText = make('span');
    const raceText = make('small');
    nameLine.append(nameText, raceText);

    const meta = make('div', 'line');
    const bar = make('div', 'bar');
    const barFill = make('span');
    bar.appendChild(barFill);
    const comfortLine = make('div', 'line');
    const band = make('div', 'band');

    const bubble = make('button', 'bubble', `点单：${SNACKS.SNK_001.name}（点我投放）`);
    bubble.dataset.action = 'snack';
    bubble.hidden = true;

    card.append(nameLine, meta, bar, comfortLine, band, bubble);
    box.appendChild(card);

    refs.seats.push({ card, nameText, raceText, meta, barFill, comfortLine, band, bubble });
    interactive.bubbles.push({ index, node: bubble });
  }
}

function buildInventory() {
  const box = byId('inventory');
  box.innerHTML = '';
  for (const id of INVENTORY_IDS) {
    if (MATERIALS[id]) {
      const button = make('button', 'item');
      button.dataset.action = 'select';
      button.dataset.id = id;
      box.appendChild(button);
      interactive.inventoryButtons.push({ id, node: button });
    } else {
      const span = make('span', 'item static');
      box.appendChild(span);
      interactive.inventoryButtons.push({ id, node: span });
    }
  }
}

function buildShop() {
  const box = byId('shop');
  box.innerHTML = '';
  for (const id of SHOP_IDS) {
    const button = make('button', '', `${itemName(id)} · ${itemPrice(id)}G`);
    button.dataset.action = 'buy';
    button.dataset.id = id;
    box.appendChild(button);
    interactive.shopButtons.push(button);
  }
}

function buildReport() {
  const report = byId('report');
  report.innerHTML = '';

  refs.report.title = make('h2');
  refs.report.table = make('table');
  refs.report.cells = {};
  for (const [key, label] of [
    ['guests', '接待客人'],
    ['ticketIncome', '门票收入'],
    ['tipIncome', '小费收入'],
    ['snackIncome', '小食收入'],
    ['totalIncome', '总收入'],
    ['tax', '排污税'],
    ['net', '日报净收益'],
  ]) {
    const row = make('tr');
    const value = make('td');
    row.append(make('td', '', label), value);
    refs.report.table.appendChild(row);
    refs.report.cells[key] = value;
  }

  refs.report.summary = make('p', 'net');
  refs.report.hint = make('p', 'hint');
  const restart = make('button', '', '重开一天');
  restart.dataset.action = 'restart';
  interactive.restartButtons.push(restart);

  report.append(refs.report.title, refs.report.table, refs.report.summary, refs.report.hint, restart);
}

// ============================================================
// 二、渲染（只改文字/样式/显隐，绝不替换可交互节点）
// ============================================================
function gameClockLabel() {
  const totalSeconds = TIME.OPEN_HOUR * 3600 + state.time * TIME.GAME_SECONDS_PER_TICK;
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

function renderHud() {
  const remaining = TIME.BUSINESS_DAY_SECONDS - state.time;
  refs.hud.day.textContent = `第 ${state.day} 天`;
  refs.hud.clock.textContent = gameClockLabel();
  refs.hud.remain.textContent = `剩余 ${remaining} 秒`;
  refs.hud.gold.textContent = `金币 ${state.gold}G`;
  refs.hud.credit.textContent = `赊账 ${state.credit}G`;
  refs.hud.vouchers.textContent = `体验券 ${state.vouchers}`;
  refs.hud.fragments.textContent = `碎片 ${state.fragments}`;
}

function renderControls() {
  for (const button of interactive.speedButtons) {
    const value = Number(button.dataset.speed);
    button.className = value === speed ? 'speed active' : 'speed';
  }
}

/**
 * 该客人座位卡上的温度色带分段（纯函数，供测试直接断言）：
 * 遭遇 NPC 的 guestId 就是 npcId，会按个人区间画；熟客回退到种族区间。
 */
export function bandSegmentsFor(guest) {
  return tempBandSegments(guest.race, guest.guestId);
}

/** 候位显示名：熟客 → 遭遇 NPC → 原始 id（纯函数，供测试直接断言） */
export function queueGuestName(guestId) {
  return GUESTS[guestId]?.name ?? ENCOUNTERS[guestId]?.name ?? guestId;
}

function tempBandHtml(guest, temp) {
  const span = TEMP.MAX - TEMP.MIN;
  const segments = bandSegmentsFor(guest).map((segment) => {
    const left = ((segment.from - TEMP.MIN) / span) * UNITS.PERCENT;
    const width = ((segment.to - segment.from) / span) * UNITS.PERCENT;
    return `<i class="seg zone-${segment.zone}" style="left:${left}%;width:${width}%"></i>`;
  }).join('');
  const marker = ((temp - TEMP.MIN) / span) * UNITS.PERCENT;
  return `${segments}<b class="marker" style="left:${marker}%"></b>`;
}

function renderPool() {
  refs.pool.tempValue.textContent = fmtTemp(state.pool.temp);
  refs.pool.cleanValue.textContent =
    `${fmtPoint(state.pool.clean, UNITS.CLEAN_PER_POINT)} / ${fmtPoint(GUEST.CLEAN_MAX, UNITS.CLEAN_PER_POINT)}`;
  if (state.waterChange) {
    refs.pool.warn.textContent = `换水中… 剩余 ${state.waterChange.remainingSeconds} 秒`;
    refs.pool.warn.hidden = false;
  } else {
    refs.pool.warn.hidden = true;
  }
  // 换水期间按钮置灰（节点本身不换，只改 disabled）
  interactive.waterButton.disabled = Boolean(state.waterChange);

  interactive.slots.forEach((entry, index) => {
    const slot = state.slots[index];
    if (!slot) {
      entry.node.className = 'slot';
      entry.name.textContent = '空槽';
      entry.note.textContent = selectedMaterial
        ? `点这里投入 ${itemName(selectedMaterial)}`
        : '先从库存点一个材料';
    } else {
      entry.node.className = 'slot filled';
      entry.name.textContent = itemName(slot.itemId);
      entry.note.textContent = `剩余 ${slot.remainingSeconds} 秒后释放`;
    }
  });
}

function renderSeats() {
  state.seats.forEach((guest, index) => {
    const seat = refs.seats[index];
    if (!seat) return;

    if (!guest) {
      seat.card.className = 'seat empty';
      seat.nameText.textContent = '空位';
      seat.raceText.textContent = '';
      seat.meta.textContent = '等待客人入座';
      seat.barFill.style.width = '0%';
      seat.comfortLine.textContent = '';
      seat.band.innerHTML = '';
      seat.bubble.hidden = true;
      return;
    }

    const zone = getTempZone(guest.race, state.pool.temp, guest.guestId);
    const heart = getHeart(state.affectionExp[guest.guestId] ?? 0);
    seat.card.className = 'seat';
    seat.nameText.textContent = guest.name;
    seat.raceText.textContent = RACES[guest.race].name;
    seat.meta.textContent = `好感 ${heart} 心 · 饱腹 ${guest.satiety} · 已泡 ${guest.secondsInPool} 秒`;
    seat.barFill.style.width = `${toPercent(guest.comfort, GUEST.COMFORT_MAX)}%`;
    seat.comfortLine.textContent =
      `满意度 ${fmtPoint(guest.comfort, UNITS.COMFORT_PER_POINT)} / ${fmtPoint(GUEST.COMFORT_MAX, UNITS.COMFORT_PER_POINT)} · ${ZONE_LABEL[zone]}`;
    seat.band.innerHTML = tempBandHtml(guest, state.pool.temp);

    if (guest.orderOpen) {
      seat.bubble.dataset.id = guest.guestId;
      seat.bubble.hidden = false;
    } else {
      seat.bubble.hidden = true;
    }
  });
}

function renderSide() {
  const queueNames = state.queue.map((entry) => queueGuestName(entry.guestId));
  byId('queue').textContent =
    `候位 ${state.queue.length} / ${POOL.QUEUE_LIMIT} 人${queueNames.length ? `（${queueNames.join('、')}）` : ''}`;

  if (state.tray.length === 0) {
    byId('tray').textContent = '托盘：空';
  } else {
    byId('tray').textContent = state.tray.map((item) => {
      if (!item.guestId) {
        return `托盘：${SNACKS.SNK_001.name} 未认领 · ${Math.max(0, item.recycleAt - state.time)} 秒后回收`;
      }
      return `托盘：${SNACKS.SNK_001.name} 已认领 · ${Math.max(0, item.eatAt - state.time)} 秒后食用`;
    }).join(' ');
  }

  for (const entry of interactive.inventoryButtons) {
    const count = state.inventory[entry.id] ?? 0;
    entry.node.hidden = count === 0;
    entry.node.textContent = `${itemName(entry.id)} ×${count}`;
    if (MATERIALS[entry.id]) {
      entry.node.className = selectedMaterial === entry.id ? 'item active' : 'item';
    }
  }
}

function renderReport() {
  const overlay = byId('overlay');
  if (!state.closed || !state.lastReport) {
    overlay.hidden = true;
    return;
  }

  const report = state.lastReport;
  overlay.hidden = false;
  refs.report.title.textContent = `第 ${report.day} 天 · 打烊日报`;
  refs.report.cells.guests.textContent = `${report.guests} 位`;
  refs.report.cells.ticketIncome.textContent = `${report.ticketIncome}G`;
  refs.report.cells.tipIncome.textContent = `${report.tipIncome}G`;
  refs.report.cells.snackIncome.textContent = `${report.snackIncome}G`;
  refs.report.cells.totalIncome.textContent = `${report.totalIncome}G`;
  refs.report.cells.tax.textContent = `−${report.tax}G`;
  refs.report.cells.net.textContent = `${report.net}G`;
  refs.report.summary.textContent = `当前金币 ${state.gold}G · 赊账 ${state.credit}G`;
  refs.report.hint.textContent = '';
}

export function render() {
  renderHud();
  renderControls();
  renderPool();
  renderSeats();
  renderSide();
  renderReport();
}

// ============================================================
// 三、计时与提示
// ============================================================
function restartTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  if (state.closed) return;

  timer = setInterval(() => {
    tick(state);
    render();
    if (state.closed) restartTimer();
  }, (TIME.TICK_SECONDS * 1000) / speed);
}

function toast(text) {
  const node = byId('toast');
  node.textContent = text;
  node.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, UI.TOAST_MS);
}

// ============================================================
// 四、点击（事件委托：绑在 document 这个稳定父容器上）
// ============================================================
export function handleClick(event) {
  const element = event.target.closest('[data-action]');
  if (!element) return;

  const action = element.dataset.action;

  if (action === 'speed') {
    speed = Number(element.dataset.speed);
    restartTimer();
    render();
    return;
  }
  if (action === 'restart') {
    newRun();
    return;
  }
  if (state.closed) {
    toast(REASON_TEXT.DAY_CLOSED);
    return;
  }

  if (action === 'buy') {
    const result = buy(state, element.dataset.id);
    if (!result.ok) toast(REASON_TEXT[result.reason] ?? result.reason);
    render();
  } else if (action === 'select') {
    selectedMaterial = element.dataset.id;
    render();
  } else if (action === 'slot') {
    const slotIndex = Number(element.dataset.slot) - 1;
    // 已占用的槽：点了必须明确提示（决定修改：从「不可点」改为「可点但提示」）
    if (state.slots[slotIndex]) {
      toast(REASON_TEXT.SLOT_OCCUPIED);
      return;
    }
    if (!selectedMaterial) {
      toast('先在库存里点一个材料');
      return;
    }
    const result = dropMaterial(state, slotIndex + 1, selectedMaterial);
    if (result.ok) selectedMaterial = null;
    else toast(REASON_TEXT[result.reason] ?? result.reason);
    render();
  } else if (action === 'snack') {
    const result = dropSnack(state, element.dataset.id);
    if (!result.ok) toast(REASON_TEXT[result.reason] ?? result.reason);
    render();
  } else if (action === 'water') {
    const result = changeWater(state);
    if (!result.ok) toast(REASON_TEXT[result.reason] ?? result.reason);
    render();
  } else if (action === 'close') {
    const result = closeDay(state);
    if (result.ok) restartTimer();
    else toast(REASON_TEXT[result.reason] ?? result.reason);
    render();
  }
}

function newRun() {
  const raw = Number(byId('seed').value);
  state = createInitialState({ seed: Number.isInteger(raw) ? raw : undefined });
  byId('seed').value = String(state.seed);
  selectedMaterial = null;
  restartTimer();
  render();
}

export function getSpeed() {
  return speed;
}

// ============================================================
// 五、启动
// ============================================================
buildHud();
buildControls();
buildPool();
buildSlots();
buildSeats();
buildInventory();
buildShop();
buildReport();

byId('seed').value = String(state.seed);
document.addEventListener('click', handleClick);
restartTimer();
render();
