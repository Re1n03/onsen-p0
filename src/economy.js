/**
 * economy.js — 打烊结算：排污税、赊账、日报、次日开盘（P0）
 *
 * 职责：
 *  - 排污税 = N × (100 + 20N)（§7）
 *  - 金币不够交税 → 差额记赊账；次日 +10% 利息
 *  - 赊账 > 500G 且汤池数 ≥2 → 次日关 1 池；只有 1 池时不停业
 *  - 输出日报（客人数、收入、税、净收益）
 *  - 次日开盘：重置每日状态、声望自然回升 +10（§6）
 *
 * 不读写 DOM、不推进秒。
 */

import { CREDIT, REPUTATION, TAX, UNITS } from '../config.js';
import { createPool } from './bath.js';
import { processLostBagsOnNextDay } from './lostfound.js';
import { rollVisitors } from './visit.js';
import { createDailyCounters, grantDailyVoucher, rollArrivalInterval } from './state.js';

/** 排污税（整数 G）：N 为已激活汤池数（§7） */
export function taxGold(state) {
  return state.poolCount * (TAX.POOL_BASE + TAX.POOL_STEP * state.poolCount);
}

/**
 * 打烊结算：
 *   ① 先扣排污税；金币不足的差额记入赊账
 *   ② 用剩余金币偿还赊账，还到 0 为止，不足部分继续留存
 *   ③ 生成并返回当日日报
 * 调用前应当已由 clock.closeDay 把池内客人按正常离场结算完。
 */
export function settleDay(state) {
  const tax = taxGold(state);
  const { guestsSeated, ticketIncome, tipIncome, snackIncome } = state.daily;
  const totalIncome = ticketIncome + tipIncome + snackIncome;
  const net = totalIncome - tax;

  state.gold -= tax;
  if (state.gold < 0) {
    state.credit += -state.gold;
    state.gold = 0;
  }

  const repayment = Math.min(state.gold, state.credit);
  state.gold -= repayment;
  state.credit -= repayment;

  const report = {
    day: state.day,
    guests: guestsSeated,
    ticketIncome,
    tipIncome,
    snackIncome,
    totalIncome,
    tax,
    net,
  };
  state.lastReport = report;
  return report;
}

/** 赊账计息：+10%，整数四舍五入、.5 向上（例如 20 → 22、25 → 28） */
export function applyCreditInterest(state) {
  const percent = UNITS.PERCENT;
  state.credit = Math.floor(
    (state.credit * (percent + CREDIT.INTEREST_PCT) + Math.floor(percent / 2)) / percent,
  );
  return state.credit;
}

/**
 * 次日开盘：
 *  1. 赊账 +10% 利息
 *  2. 赊账 >500G 且汤池数 ≥2 → 关 1 池（P0 只有 1 池，不会触发）
 *  3. 各阵营声望自然回升 +10（§6）
 *  4. 重置营业日状态（时间、到客、座位、候位、托盘、水温、洁净度、好感日上限）
 *
 * @returns {Array<object>} 开盘事件（例如 poolClosed）
 */
export function startNextDay(state) {
  const events = [];

  applyCreditInterest(state);

  if (state.credit > CREDIT.CLOSE_POOL_THRESHOLD && state.poolCount >= CREDIT.CLOSE_POOL_MIN_POOLS) {
    state.poolCount -= 1;
    events.push({ type: 'poolClosed', day: state.day + 1, credit: state.credit });
  }

  // 声望自然回升：只对负声望生效，每天 +10，最多回到 0；非负声望不动（§6 + 第 4 步答复）
  for (const faction of Object.keys(state.reputation)) {
    const current = state.reputation[faction];
    if (current < 0) {
      state.reputation[faction] = Math.min(0, current + REPUTATION.DAILY_REGEN);
    }
  }

  state.day += 1;
  state.time = 0;
  state.closed = false;
  state.explore = null; // 新的一天可以再次 startExplore
  state.arrivals = [];
  state.daily = createDailyCounters();
  state.dailyAffinityExp = {};
  state.seats = state.seats.map(() => null);
  state.slots = state.slots.map(() => null);
  state.queue = [];
  state.tray = [];
  state.waterChange = null;
  state.drinking = null;   // 新的一天不必继续昨天的喝水计时；感冒若未治愈仍然保留
  state.pool = createPool(); // 水温 25.0℃、洁净度 100.0
  state.nextArrivalAt = rollArrivalInterval(state);

  // 倒地次日感冒：当天倒地标记在新的一天生效；同一天多次倒地也只算一次
  if (state.coldPending) {
    state.cold = true;
    state.coldPending = false;
    events.push({ type: 'coldStarted', day: state.day });
  }

  // 失物包计时：第 8 天（N≥8）被出售，永久消失（熟客/地精同样 7 天保管）
  const soldBags = processLostBagsOnNextDay(state);
  if (soldBags.length > 0) {
    events.push({ type: 'lostBagsSold', day: state.day, bags: soldBags });
  }

  // 次日开盘：清空 pendingVisitors，掷邀请 + 自然到访 + 首次保底（A.20）
  events.push(...rollVisitors(state));

  grantDailyVoucher(state); // 每天开盘赠送 1 张，上限 3 张（§4.4）

  return events;
}
