/**
 * state.js — 全局状态与状态变更小工具（P0）
 *
 * 职责：
 *  - 建立开局状态（金币、库存、好感、声望、赊账、汤池、座位、候位、托盘……）
 *  - 提供「加库存 / 扣库存 / 加好感 / 加声望 / 掉碎片」这类纯数据操作
 *  - 不读写 DOM、不推进时间
 *
 * 单位见 config.js 顶部「单位总表」。
 */

import {
  AFFINITY,
  FRAGMENTS,
  GUEST,
  GUESTS,
  POOL,
  REPUTATION,
  STARTING,
  VOUCHERS,
} from '../config.js';
import { createRng } from './rng.js';
import { createPool } from './bath.js';

/** 当日日报累计 */
export function createDailyCounters() {
  return {
    guestsSeated: 0,   // 当日入池过的客人数量
    ticketIncome: 0,   // 门票收入（含怒离的 25G）
    tipIncome: 0,      // 小费收入
    snackIncome: 0,    // 小食收入（食用时入账）
    fragmentDrops: 0,  // 当日掉落的碎片数
  };
}

/**
 * 建立开局状态。
 * @param {{ seed?: number }} [options] 随机数种子：同一种子 → 同一天完全可复现
 */
export function createInitialState({ seed = 1 } = {}) {
  const rng = createRng(seed);
  const seatCount = POOL.COUNT * POOL.SEATS; // P0 = 1 池 × 2 席

  return {
    seed,
    rng,

    day: STARTING.DAY,
    time: 0,            // 本营业日已过秒数（0 = 08:00 开门）
    closed: false,      // 本日是否已打烊

    gold: STARTING.GOLD,
    inventory: { ...STARTING.ITEMS },
    vouchers: STARTING.VOUCHERS,
    fragments: 0,

    affectionExp: { ...AFFINITY.INITIAL_EXP }, // 每位 NPC 的累计好感经验
    dailyAffinityExp: {},                      // 每位 NPC 今日已得好感经验（受日上限约束）
    reputation: { ...REPUTATION.INITIAL },

    credit: 0,          // 赊账（G，整数）
    poolCount: POOL.COUNT,

    pool: createPool(),
    seats: Array.from({ length: seatCount }, () => null),
    slots: Array.from({ length: POOL.INGREDIENT_SLOTS }, () => null), // 3 个投料槽，占用后当天不释放
    queue: [],          // [{ guestId, enqueuedAt }]
    tray: [],           // 托盘小食 [{ placedAt, guestId, eatAt, recycleAt }]
    waterChange: null,  // { remainingSeconds }

    nextArrivalAt: rng.nextInt(POOL.ARRIVAL_INTERVAL_MIN_SECONDS, POOL.ARRIVAL_INTERVAL_MAX_SECONDS),
    arrivals: [],       // 每次「到客判定」发生的秒数（含无人可来/被拒），用于核对节奏

    daily: createDailyCounters(),
    lastReport: null,

    // ---- 采风（§4.1、§5.1）：null 表示当天还没出发 ----
    explore: null,
    moodLevel: 0,                // 雅兴上限等级（0~4）
    lostBags: [],                // 倒地生成的失物包列表（可同时存在多个，各自计时）
    lostBagSeq: 0,               // 失物包唯一 id 的自增序号
    guestLastVisitDay: {},       // 熟客最近一次入池的营业日（失物代管判定用）
    vipTicketDay: null,          // （已停用：体验券不再给门票加成，字段保留待清）

    // ---- 遭遇邀请（§4.4 v2）----
    invites: [],                 // [{ npcId, day }]，次日开盘掷到访
    pendingVisitors: [],         // 次日掷成功的到访 NPC id（本步只记录）

    // ---- 感冒与饮用热水（§5.1）----
    cold: false,                 // 感冒中（投料槽 3→2）
    coldPending: false,          // 当天倒地，次日开盘生效
    drinking: null,              // 饮热水：{ remainingSeconds }
  };
}

/** 好感经验 → 心数（0~10） */
export function getHeart(affectionExp) {
  return Math.min(AFFINITY.HEART_MAX, Math.floor(affectionExp / AFFINITY.EXP_PER_HEART));
}

/**
 * 按配置生成一位要入池的客人。
 * 好感/声望不放在客人身上，按 guestId 存在 state 里。
 */
export function createGuest(state, guestId) {
  const profile = GUESTS[guestId];
  if (!profile) throw new Error(`未知客人：${guestId}`);

  return {
    guestId,
    name: profile.name,
    race: profile.race,
    comfort: GUEST.COMFORT_INITIAL,
    satiety: state.rng.nextInt(GUEST.SATIETY_INITIAL_MIN, GUEST.SATIETY_INITIAL_MAX),
    secondsInPool: 0,
    seatedAt: null,
    orderOpen: false,   // 是否正在亮「点单气泡」
    snackDone: false,   // 本趟是否已经点过/吃过小食
  };
}

// ---------- 库存 ----------

export function addInventory(state, itemId, count) {
  state.inventory[itemId] = (state.inventory[itemId] ?? 0) + count;
  return state.inventory[itemId];
}

export function inventoryCount(state, itemId) {
  return state.inventory[itemId] ?? 0;
}

/** 扣库存；不够则返回 false 且不扣 */
export function removeInventory(state, itemId, count) {
  const held = inventoryCount(state, itemId);
  if (held < count) return false;
  if (held === count) delete state.inventory[itemId];
  else state.inventory[itemId] = held - count;
  return true;
}

/** 背包总件数（倒地丢损用） */
export function totalItemPieces(state) {
  return Object.values(state.inventory).reduce((sum, n) => sum + n, 0);
}

// ---------- 金币 / 好感 / 声望 / 碎片 ----------

export function addGold(state, amount) {
  state.gold += amount;
  return state.gold;
}

/**
 * 加好感经验，受「每位 NPC 每日上限 60」约束（§6）。
 * @returns {number} 实际加进去的经验（可能被日上限截断）
 */
export function gainAffinity(state, npcId, amount) {
  const used = state.dailyAffinityExp[npcId] ?? 0;
  const remaining = Math.max(0, AFFINITY.DAILY_EXP_CAP - used);
  const added = Math.min(amount, remaining);

  state.dailyAffinityExp[npcId] = used + added;
  state.affectionExp[npcId] = (state.affectionExp[npcId] ?? 0) + added;
  return added;
}

/** 加阵营声望，夹紧在 −100~+100（§6） */
export function gainReputation(state, faction, amount) {
  state.reputation[faction] = Math.min(
    REPUTATION.MAX,
    Math.max(REPUTATION.MIN, state.reputation[faction] + amount),
  );
  return state.reputation[faction];
}

export function addFragment(state, count = 1) {
  state.fragments += count;
  return state.fragments;
}

/** 离场碎片判定：30% 掉 1 张（P0 不分阵营，P0补②） */
export function rollFragmentDrop(rng) {
  return rng.chancePercent(FRAGMENTS.DROP_PCT);
}

/**
 * 营业日开盘赠送 1 张体验券，持有上限 3 张（§4.4）。
 * @returns {number} 实际发放数量（已满则为 0）
 */
export function grantDailyVoucher(state) {
  if (state.vouchers >= VOUCHERS.HOLD_LIMIT) return 0;
  state.vouchers += 1;
  return 1;
}
