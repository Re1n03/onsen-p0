/**
 * clock.js — 营业日主循环（P0）
 *
 * 每秒 tick 的固定顺序：
 *   1. 换水倒计时（8 秒）
 *   2. 到客判定（间隔 25~40 秒；按权重抽熟客；抽到的熟客若已在池/已在候位则跳过）
 *   3. 水温回落 → 满意度 → 洁净度（bath.stepSecond）
 *   4. 饱腹衰减；满足条件亮「点单气泡」
 *   5. 托盘小食：认领 → 5 秒后食用 → 120 秒无人认领回收
 *   6. 候位耐心 45 秒
 *   7. 离场：怒离（满意度 ≤0）/ 正常离场（停留满 60 秒）
 *   8. 候位补位
 *
 * 打烊由 closeDay 触发：停止到客 → 池内客人按正常离场结算（含小费）→ 交给 economy 结算税费。
 * 不读写 DOM。
 */

import {
  AFFINITY,
  ENCOUNTERS,
  GUEST,
  GUESTS,
  PLAYER_EXP,
  POOL,
  RACES,
  REPUTATION,
  SETTLEMENT,
  SNACKS,
  SNACK_SERVICE,
  TIME,
  UNITS,
} from '../config.js';
import {
  addFragment,
  addGold,
  createGuest,
  gainAffinity,
  gainReputation,
  getHeart,
  removeInventory,
  rollFragmentDrop,
} from './state.js';
import { isAngry, onGuestLeave, settleAngryGold, settleBreakdown, stepSecond, tipMultPctFor } from './bath.js';
import { grantExp, guestExpOf, visitorBonusOf } from './player.js';
import { settleDay } from './economy.js';

// ============================================================
// 到客 / 候位
// ============================================================

/** 当前不在池也不在候位的熟客；为空表示这一拍到客无人可来 */
function eligibleGuestIds(state) {
  const busy = new Set();
  for (const guest of state.seats) if (guest) busy.add(guest.guestId);
  for (const entry of state.queue) busy.add(entry.guestId);
  return Object.keys(GUESTS).filter((guestId) => !busy.has(guestId));
}

function pickGuestId(state) {
  const ids = eligibleGuestIds(state);
  if (ids.length === 0) return null;
  return state.rng.pickWeighted(ids, (guestId) => GUESTS[guestId].arrivalWeightPct);
}

function seatGuest(state, seatIndex, guestId, now) {
  const guest = createGuest(state, guestId);
  guest.seatedAt = now;
  // 体验券奖励：指定营业日的第一位入座客人门票 ×1.5（仅一次）
  if (state.vipTicketDay === state.day) {
    guest.vipTicket = true;
    state.vipTicketDay = null;
  }
  state.seats[seatIndex] = guest;
  state.daily.guestsSeated += 1;
  state.guestLastVisitDay[guestId] = state.day; // 熟客代管失物判定用（§5.1）
  gainAffinity(state, guestId, AFFINITY.GAIN_VISIT); // 到店光顾 +10（§6）
  return { type: 'guestSeated', at: now, guestId, seat: seatIndex };
}

/**
 * 入候位；候位已满 3 人时直接拒绝（= 第 4 位离开，无收益、无声望变化）。
 * 导出是为了让测试能直接验证「候位满」这条规则。
 */
export function enqueueGuest(state, guestId, now = state.time) {
  if (state.queue.length >= POOL.QUEUE_LIMIT) {
    return { type: 'guestRejected', reason: 'QUEUE_FULL', at: now, guestId };
  }
  state.queue.push({ guestId, enqueuedAt: now });
  return { type: 'guestQueued', at: now, guestId };
}

/** 到访者队首（只读，不抽随机数）；没有则返回 null */
function pendingVisitorHead(state) {
  return state.pendingVisitors.length > 0 ? state.pendingVisitors[0] : null;
}

/** 入场成功（入座或入队）后按 npcId 删除该条到访者 */
function removePendingVisitor(state, npcId) {
  const index = state.pendingVisitors.findIndex((entry) => entry.npcId === npcId);
  if (index >= 0) state.pendingVisitors.splice(index, 1);
}

/**
 * 到访者占用本拍到客名额：判定全部先于随机数（本函数不抽任何随机数）。
 * 有座 → seatGuest；无座但候位未满 → enqueueGuest；否则推迟、保留队首。
 * 入座/入队成功后才会从 pendingVisitors 删除该条。
 */
function enterVisitor(state, entry, now, frozen) {
  const seatIndex = frozen ? -1 : state.seats.indexOf(null);

  if (seatIndex >= 0) {
    const seated = seatGuest(state, seatIndex, entry.npcId, now);
    removePendingVisitor(state, entry.npcId);
    return [seated, {
      type: 'visitorSeated', at: now, npcId: entry.npcId, seat: seatIndex, source: entry.source,
    }];
  }

  if (state.queue.length < POOL.QUEUE_LIMIT) {
    const queued = enqueueGuest(state, entry.npcId, now);
    removePendingVisitor(state, entry.npcId);
    return [queued, {
      type: 'visitorQueued', at: now, npcId: entry.npcId, source: entry.source,
    }];
  }

  return [{
    type: 'visitorDeferred', at: now, npcId: entry.npcId, source: entry.source, reason: 'QUEUE_FULL',
  }];
}

/** 本拍到客：到访者优先占名额；没有到访者时才走普通随机客人 */
function arrive(state, now, frozen) {
  const visitor = pendingVisitorHead(state);
  if (visitor) return enterVisitor(state, visitor, now, frozen);

  const guestId = pickGuestId(state);
  if (!guestId) return [{ type: 'arrivalSkipped', at: now }];

  const seatIndex = frozen ? -1 : state.seats.indexOf(null);
  if (seatIndex >= 0) return [seatGuest(state, seatIndex, guestId, now)];
  return [enqueueGuest(state, guestId, now)];
}

// ============================================================
// 小食
// ============================================================

/** 把托盘上的一份小食绑定给正在点单的客人：5 秒后食用 */
function claimSnack(state, item, guest, now) {
  guest.orderOpen = false;
  guest.snackDone = true;
  item.guestId = guest.guestId;
  item.eatAt = now + SNACK_SERVICE.EAT_WINDOW_SECONDS;
}

/**
 * 投放一份 SNK_001 到托盘（消耗库存）。
 * - 指定 targetGuestId：只服务这位「正在点单」的客人，否则拒绝；
 * - 不指定：若有客人亮着点单气泡，自动认领；没有则先放托盘等人认领。
 * 认领后 5 秒食用。
 * @returns {{ ok: boolean, reason?: string, claimedBy?: string|null }}
 */
export function putSnackOnTray(state, targetGuestId = null) {
  if (state.tray.length >= POOL.TRAY_SLOTS) return { ok: false, reason: 'TRAY_FULL' };

  let orderer = null;
  if (targetGuestId) {
    orderer = state.seats.find((guest) => guest && guest.guestId === targetGuestId) ?? null;
    if (!orderer) return { ok: false, reason: 'GUEST_NOT_FOUND' };
    if (!orderer.orderOpen) return { ok: false, reason: 'NO_ORDERING_GUEST' };
  } else {
    orderer = state.seats.find((guest) => guest && guest.orderOpen) ?? null;
  }

  if (!removeInventory(state, 'SNK_001', 1)) return { ok: false, reason: 'NO_ITEM' };

  const now = state.time;
  const item = {
    placedAt: now,
    guestId: null,
    eatAt: null,
    recycleAt: now + SNACK_SERVICE.TRAY_RECYCLE_SECONDS,
  };
  state.tray.push(item);

  if (orderer) claimSnack(state, item, orderer, now);

  return { ok: true, claimedBy: item.guestId };
}

/** 托盘小食每秒处理：认领 → 食用 → 未认领且满 120 秒回收 */
function tickTray(state, now) {
  const events = [];

  for (const item of state.tray) {
    if (item.guestId) continue;
    const orderer = state.seats.find((guest) => guest && guest.orderOpen);
    if (!orderer) continue;
    claimSnack(state, item, orderer, now);
    events.push({ type: 'snackClaimed', at: now, guestId: orderer.guestId });
  }

  for (let i = state.tray.length - 1; i >= 0; i--) {
    const item = state.tray[i];
    if (!item.guestId || now < item.eatAt) continue;

    const seatIndex = state.seats.findIndex((guest) => guest && guest.guestId === item.guestId);
    if (seatIndex < 0) {
      item.guestId = null;
      item.eatAt = null;
      continue;
    }

    const guest = state.seats[seatIndex];
    guest.comfort = Math.min(
      GUEST.COMFORT_MAX,
      guest.comfort + SNACKS.SNK_001.effect.comfortInstant,
    );
    addGold(state, SNACKS.SNK_001.salePrice);
    state.daily.snackIncome += SNACKS.SNK_001.salePrice;
    state.tray.splice(i, 1);
    events.push({
      type: 'snackEaten',
      at: now,
      guestId: guest.guestId,
      comfortGain: SNACKS.SNK_001.effect.comfortInstant,
      gold: SNACKS.SNK_001.salePrice,
    });
  }

  for (let i = state.tray.length - 1; i >= 0; i--) {
    const item = state.tray[i];
    if (!item.guestId && now >= item.recycleAt) {
      state.tray.splice(i, 1);
      events.push({ type: 'snackRecycled', at: now });
    }
  }

  return events;
}

/** 换水冻结期间：托盘小食的「食用 / 回收」倒计时整体后移 1 秒，等于暂停 */
function freezeTrayTimers(state) {
  for (const item of state.tray) {
    if (item.eatAt !== null) item.eatAt += 1;
    item.recycleAt += 1;
  }
}

// ============================================================
// 换水
// ============================================================

/**
 * 换水清池：20G、8 秒，随时可用（池里有客人也可以），第 8 秒结束时洁净度恢复到 100.0。
 * 换水期间客人状态冻结（满意度/停留/饱腹），洁净度不因客人下降，新到的客人只排队。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function tryChangeWater(state) {
  if (state.waterChange) return { ok: false, reason: 'ALREADY_CHANGING' };
  if (state.gold < POOL.CHANGE_WATER_COST_GOLD) return { ok: false, reason: 'NOT_ENOUGH_GOLD' };

  state.gold -= POOL.CHANGE_WATER_COST_GOLD;
  state.waterChange = { remainingSeconds: POOL.CHANGE_WATER_SECONDS };
  return { ok: true, remainingSeconds: POOL.CHANGE_WATER_SECONDS, gold: state.gold };
}

// ============================================================
// 离场结算
// ============================================================

function departGuest(state, seatIndex, mode, now) {
  const guest = state.seats[seatIndex];
  state.seats[seatIndex] = null;
  const events = [];

  // 离场扣洁净度 −3.0（§3.6；SNK_003 [饱腹入定] 免除，P0 暂无该小食）
  // 正常离场、怒离、打烊结算都走这里；候位超时/被拒的客人没入过池，不走这里
  state.pool = onGuestLeave(state.pool);

  // 绑定在这位客人身上的托盘小食解绑，继续走 120 秒回收
  for (const item of state.tray) {
    if (item.guestId === guest.guestId) {
      item.guestId = null;
      item.eatAt = null;
    }
  }

  // 30% 掉 1 张心事碎片（任何入池客人离场都掷）
  if (rollFragmentDrop(state.rng)) {
    addFragment(state);
    state.daily.fragmentDrops += 1;
    events.push({ type: 'fragmentDropped', at: now, guestId: guest.guestId });
  }

  if (mode === 'angry') {
    const gold = settleAngryGold(); // 25G，无小费无小食
    addGold(state, gold);
    state.daily.ticketIncome += gold;
    events.push({ type: 'guestAngryLeft', at: now, guestId: guest.guestId, gold });
    // 怒离不给经验（ANGRY = 0；amount 0 不产生事件、不消耗随机数）
    grantExp(state, PLAYER_EXP.ANGRY, 'guest', now);
    return events;
  }

  const faction = RACES[guest.race].faction;
  const heart = getHeart(state.affectionExp[guest.guestId] ?? 0);
  let repMultPct = state.reputation[faction] >= REPUTATION.TICKET_BONUS_THRESHOLD
    ? SETTLEMENT.REP_MULT_PCT
    : SETTLEMENT.REP_MULT_DEFAULT_PCT;
  // 体验券奖励：门票 ×1.5（与声望乘区叠乘）
  if (guest.vipTicket) {
    repMultPct = Math.floor((repMultPct * SETTLEMENT.VIP_TICKET_PCT) / UNITS.PERCENT);
  }
  const breakdown = settleBreakdown({
    comfort: guest.comfort,
    heart,
    repMultPct,
    tipMultPct: tipMultPctFor(state.pool, guest.race),
  });

  addGold(state, breakdown.totalGold);
  state.daily.ticketIncome += breakdown.ticketGold;
  state.daily.tipIncome += breakdown.tipGold;
  events.push({
    type: 'guestLeft',
    at: now,
    guestId: guest.guestId,
    mode,
    comfort: guest.comfort,
    gold: breakdown.totalGold,
    ticket: breakdown.ticketGold,
    tip: breakdown.tipGold,
  });

  // 满意度 ≥80.00 离场：好感 +20、该阵营声望 +1（§6）
  if (guest.comfort >= GUEST.HIGH_COMFORT_LINE) {
    gainAffinity(state, guest.guestId, AFFINITY.GAIN_HIGH_COMFORT_LEAVE);
    gainReputation(state, faction, REPUTATION.GAIN_HIGH_COMFORT_LEAVE);
  }

  // 玩家经验：满意度分档 + 到访者加成（只写 state.playerExp/expLog，不进日报）
  grantExp(
    state,
    guestExpOf(guest.comfort) + visitorBonusOf(guest.guestId),
    'guest',
    now,
  );

  return events;
}

// ============================================================
// 每秒推进
// ============================================================

/**
 * 推进 1 秒，返回本秒发生的事件数组。
 * 打烊后（closed）或到 480 秒后不再推进。
 */
export function tick(state) {
  const events = [];
  if (state.closed) return events;
  if (state.explore) return events; // 采风期间营业日还没开始（§4.1）
  if (state.time >= TIME.BUSINESS_DAY_SECONDS) return events;

  state.time += 1;
  const now = state.time;
  // 本秒是否处于「换水冻结」：开始 tick 时正在换水就算（含第 8 秒）
  const frozen = Boolean(state.waterChange);

  // 0) 喝热泉水倒计时：营业 tick 照常，20 秒后感冒解除、投料槽恢复 3 个
  if (state.drinking) {
    state.drinking.remainingSeconds -= 1;
    if (state.drinking.remainingSeconds <= 0) {
      state.drinking = null;
      state.cold = false;
      events.push({ type: 'coldCured', at: now });
    }
  }

  // 1) 换水倒计时；第 8 秒结束时恢复洁净度
  if (state.waterChange) {
    state.waterChange.remainingSeconds -= 1;
    if (state.waterChange.remainingSeconds <= 0) {
      state.pool = { ...state.pool, clean: POOL.CHANGE_WATER_RESTORE_CLEAN };
      state.waterChange = null;
      events.push({ type: 'waterChanged', at: now });
    }
  }

  // 1.5) 投料槽倒计时：到词条持续时间结束就释放该槽（各槽独立计时；换水期间照常）
  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i];
    if (!slot) continue;
    slot.remainingSeconds -= 1;
    if (slot.remainingSeconds <= 0) {
      state.slots[i] = null;
      events.push({ type: 'slotReleased', at: now, slot: i + 1, itemId: slot.itemId });
    }
  }

  // 2) 到客（换水期间只进候位，不占座）
  if (now >= state.nextArrivalAt) {
    state.arrivals.push(now);
    events.push(...arrive(state, now, frozen));
    state.nextArrivalAt = now + state.rng.nextInt(
      POOL.ARRIVAL_INTERVAL_MIN_SECONDS,
      POOL.ARRIVAL_INTERVAL_MAX_SECONDS,
    );
  }

  if (frozen) {
    // 3) 换水冻结：水温照常回落、词条照常倒计时，但客人状态与洁净度不动
    state.pool = stepSecond(state.pool, []).pool;
    freezeTrayTimers(state);
  } else {
    // 3) 水温 → 满意度 → 洁净度
    const seated = state.seats.filter(Boolean);
    const result = stepSecond(state.pool, seated);
    state.pool = result.pool;
    let guestIndex = 0;
    for (let i = 0; i < state.seats.length; i++) {
      if (state.seats[i]) state.seats[i] = result.guests[guestIndex++];
    }

    // 4) 饱腹衰减 + 点单气泡
    for (const guest of state.seats) {
      if (!guest) continue;
      guest.secondsInPool += 1;

      if (guest.secondsInPool % GUEST.SATIETY_DROP_INTERVAL_SECONDS === 0) {
        guest.satiety = Math.max(GUEST.SATIETY_MIN, guest.satiety - GUEST.SATIETY_DROP);
      }

      if (
        !guest.orderOpen
        && !guest.snackDone
        && guest.secondsInPool >= SNACKS.SNK_001.trigger.staySeconds
        && guest.satiety < SNACKS.SNK_001.trigger.satietyBelow
      ) {
        guest.orderOpen = true;
        events.push({ type: 'snackOrdered', at: now, guestId: guest.guestId });
      }
    }

    // 5) 托盘小食
    events.push(...tickTray(state, now));
  }

  // 6) 候位耐心（换水期间照常倒计时）
  for (let i = state.queue.length - 1; i >= 0; i--) {
    const entry = state.queue[i];
    if (now - entry.enqueuedAt >= POOL.PATIENCE_SECONDS) {
      state.queue.splice(i, 1);
      events.push({ type: 'queueTimeout', at: now, guestId: entry.guestId });
      // 到访者白来：只额外发事件，不改好感/声望/金币（与普通客人同规则）
      if (ENCOUNTERS[entry.guestId]) {
        events.push({
          type: 'visitorLost', at: now, npcId: entry.guestId, reason: 'QUEUE_TIMEOUT',
        });
      }
    }
  }

  // 7) 离场 + 8) 候位补位：换水期间暂停（停留计时也是暂停的）
  if (!frozen) {
    for (let i = 0; i < state.seats.length; i++) {
      const guest = state.seats[i];
      if (!guest) continue;

      if (isAngry(guest)) {
        events.push(...departGuest(state, i, 'angry', now));
      } else if (guest.secondsInPool >= POOL.BASE_STAY_SECONDS) {
        events.push(...departGuest(state, i, 'normal', now));
      }
    }

    while (state.queue.length > 0) {
      const freeSeat = state.seats.indexOf(null);
      if (freeSeat < 0) break;
      const entry = state.queue.shift();
      events.push(seatGuest(state, freeSeat, entry.guestId, now));
    }
  }

  return events;
}

// ============================================================
// 打烊
// ============================================================

/**
 * 打烊：停止到客；池内客人按正常离场结算（含小费）；清空候位与托盘；交税并生成日报。
 * @returns {object} 当日日报（同 economy.settleDay）
 */
export function closeDay(state) {
  if (state.closed && state.lastReport) return state.lastReport;

  state.closed = true;

  for (let i = 0; i < state.seats.length; i++) {
    if (state.seats[i]) departGuest(state, i, 'normal', state.time);
  }

  state.queue = [];
  state.tray = [];
  state.waterChange = null;

  return settleDay(state);
}
