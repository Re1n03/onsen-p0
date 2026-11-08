/**
 * visit.js — 温泉馆吸引力与到访判定（A.20，㉒a）
 *
 * 职责：
 *  - 计算馆等级吸引力 A（设施吸引力本步固定 0，预留）
 *  - 计算到访概率（自然态 / 邀请态）、门槛判定
 *  - 次日开盘掷到访：被邀请的 NPC 用 state.rng（保持旧随机序列），
 *    自然到访与首次保底用独立随机流 state.visitRng（不消耗 state.rng）
 *  - 只写 pendingVisitors / firstVisit，不做入场（㉒b 再做）
 *
 * 本文件不 import explore/economy，避免循环引用。
 */

import { AFFINITY, ENCOUNTERS, VISIT } from '../config.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function heartOf(state, npcId) {
  const exp = state.affectionExp[npcId] ?? 0;
  return Math.min(AFFINITY.HEART_MAX, Math.floor(exp / AFFINITY.EXP_PER_HEART));
}

/** 馆等级吸引力 + 设施吸引力（本步设施为 0） */
export function attractionOf(state) {
  const level = clamp(
    state.houseLevel ?? VISIT.HOUSE_LEVEL_MIN,
    VISIT.HOUSE_LEVEL_MIN,
    VISIT.HOUSE_LEVEL_MAX,
  );
  const house = VISIT.HOUSE_ATTRACTION_BY_LEVEL[level] ?? 0;
  const facility = (state.facilities ?? []).reduce(
    (sum, facilityId) => sum + (VISIT.FACILITY_ATTRACTION[facilityId] ?? 0),
    0,
  );
  return house + facility;
}

/** 好感权重：每颗心 +2，上限 +20 */
export function affinityWeightOf(state, npcId) {
  return Math.min(VISIT.AFFINITY_CAP_PCT, heartOf(state, npcId) * VISIT.AFFINITY_PER_HEART_PCT);
}

/** 抗性 =（阶位 − 1）× 10 */
export function resistanceOf(npcId) {
  const npc = ENCOUNTERS[npcId];
  if (!npc) return 0;
  return (npc.rank - 1) * VISIT.RESISTANCE_PER_RANK_PCT;
}

/** 邀请加成 = clamp(1 + floor(A/10), 1, 10) */
export function inviteBonusOf(state) {
  const raw = VISIT.INVITE_BONUS_BASE
    + Math.floor(attractionOf(state) / VISIT.INVITE_BONUS_PER_ATTRACTION);
  return clamp(raw, VISIT.INVITE_BONUS_MIN, VISIT.INVITE_BONUS_MAX);
}

/**
 * 到访概率（整数百分比）。
 * p = clamp(20 + A − 抗性 + 好感权重 + (邀请 ? 邀请加成 : 0), 0, 95)
 */
export function visitChance(state, npcId, { invited = false } = {}) {
  const npc = ENCOUNTERS[npcId];
  if (!npc) return 0;
  const raw = VISIT.BASE_CHANCE_PCT
    + attractionOf(state)
    - resistanceOf(npcId)
    + affinityWeightOf(state, npcId)
    + (invited ? inviteBonusOf(state) : 0);
  return clamp(raw, 0, VISIT.MAX_CHANCE_PCT);
}

/** 自然到访概率（不带邀请加成） */
export function naturalVisitChance(state, npcId) {
  return visitChance(state, npcId, { invited: false });
}

/** 被邀请时的到访概率（带邀请加成） */
export function invitedVisitChance(state, npcId) {
  return visitChance(state, npcId, { invited: true });
}

/** 门槛：馆等级 ≥ minHouseLevel，且 requiredFacility 为空或已拥有 */
export function meetsGate(state, npcId) {
  const npc = ENCOUNTERS[npcId];
  if (!npc) return false;
  if ((state.houseLevel ?? VISIT.HOUSE_LEVEL_MIN) < (npc.minHouseLevel ?? 1)) return false;
  if (npc.requiredFacility && !(state.facilities ?? []).includes(npc.requiredFacility)) return false;
  return true;
}

function recordArrival(state, npcId, source, events) {
  if (!state.pendingVisitors.some((entry) => entry.npcId === npcId)) {
    state.pendingVisitors.push({ npcId, source, day: state.day });
  }
  if (state.firstVisit[npcId] === undefined) state.firstVisit[npcId] = state.day;
  events.push({ type: 'visitorArrives', npcId, day: state.day, source });
}

/**
 * 只处理邀请（供 rollVisitors 与旧 explore.rollInvitations 复用）。
 * 使用传入 rng（默认 state.rng），保持旧用例的随机序列不变。
 * 不负责清空 pendingVisitors。
 */
export function rollInvitedVisitors(state, rng = state.rng) {
  const events = [];
  for (const invitation of state.invites) {
    const { npcId } = invitation;
    if (state.pendingVisitors.some((entry) => entry.npcId === npcId)) continue;
    if (!meetsGate(state, npcId)) continue;
    if (rng.chancePercent(invitedVisitChance(state, npcId))) {
      recordArrival(state, npcId, 'invite', events);
    }
  }
  state.invites = [];
  return events;
}

/**
 * 次日开盘统一入口：清空 pendingVisitors → 邀请掷点 → 自然/首次保底。
 * 自然到访与保底使用 state.visitRng（独立流），不消耗 state.rng。
 */
export function rollVisitors(state) {
  const events = [];
  state.pendingVisitors = [];
  if (state.day < 2) return events; // 第 1 天不掷点（防御式守卫）

  const invitedIds = new Set(state.invites.map((invitation) => invitation.npcId));
  events.push(...rollInvitedVisitors(state, state.rng));

  if (!VISIT.NATURAL_ENABLED) return events;

  for (const npcId of Object.keys(ENCOUNTERS)) {
    if (state.pendingVisitors.some((entry) => entry.npcId === npcId)) continue;
    const npc = ENCOUNTERS[npcId];
    const guaranteeDay = npc.guaranteeDay;
    const guaranteeDue = guaranteeDay !== null
      && guaranteeDay !== undefined
      && state.day >= guaranteeDay
      && state.firstVisit[npcId] === undefined;
    if (guaranteeDue) {
      // 保底忽略门槛（A.20 裁定）；同一 NPC 当天只一条
      recordArrival(state, npcId, 'guaranteed', events);
      continue;
    }
    if (invitedIds.has(npcId)) continue; // 被邀请只掷一次，不重复自然掷点
    if (!meetsGate(state, npcId)) continue;
    if (state.visitRng.chancePercent(naturalVisitChance(state, npcId))) {
      recordArrival(state, npcId, 'natural', events);
    }
  }
  return events;
}
