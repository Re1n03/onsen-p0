/**
 * bath.js — 汤池规则（P0）
 *
 * 职责：
 *  - 水温：投入材料的一次性 ΔT、向室温的自然回落（0.1℃ 整数）
 *  - 满意度：每秒结算（0.01 整数）
 *  - 洁净度：每位在池客人每秒消耗、离场扣除（0.1 整数）
 *  - 离店金币：全程整数运算，最后四舍五入、.5 向上
 *
 * 不读写 DOM；不调用 Math.random。
 * 单位见 config.js 顶部「单位总表」。
 */

import {
  UNITS,
  TEMP,
  GUEST,
  RACES,
  ENCOUNTERS,
  TEMP_ZONE_WIDTH_LIMIT_BP_BY_RANK,
  COMFORT_TICK,
  SETTLEMENT,
  MATERIALS,
  AFFINITY,
} from '../config.js';

// ---------- 小工具（整数用） ----------
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 全部是正数，用 floor 保持“中间计算全程整数”
function divFloor(a, b) {
  return Math.floor(a / b);
}

// ============================================================
// 水温
// ============================================================

/** 把水温夹紧到 0~100℃ */
export function clampTemp(temp) {
  return clamp(temp, TEMP.MIN, TEMP.MAX);
}

/** 水温向室温逼近 1 秒：高于室温下降、低于室温回升，不越过室温（§2.2） */
export function coolTempOneSecond(temp) {
  if (temp > TEMP.AMBIENT) return Math.max(TEMP.AMBIENT, temp - TEMP.COOL_RATE_PER_SEC);
  if (temp < TEMP.AMBIENT) return Math.min(TEMP.AMBIENT, temp + TEMP.COOL_RATE_PER_SEC);
  return temp;
}

/** 新建一个空池：初始水温 25.0℃、洁净度 100.0、无词条 */
export function createPool() {
  return {
    temp: TEMP.INITIAL,
    clean: GUEST.CLEAN_INITIAL,
    buffs: {},
  };
}

/**
 * 投入一份材料：水温立即加上 ΔT（夹紧 0~100℃），并刷新该材料的词条倒计时。
 * 叠加规则（§3.2）：ΔT 线性累加；词条持续时间不累加，只刷新为「当前剩余」与「新时长」中的较大值。
 */
export function injectMaterial(pool, materialId) {
  const material = MATERIALS[materialId];
  if (!material) throw new Error(`未知材料：${materialId}`);

  const existing = pool.buffs[materialId];
  const existingRemaining = existing ? existing.remainingSeconds : 0;

  const buffs = {
    ...pool.buffs,
    [materialId]: {
      remainingSeconds: Math.max(existingRemaining, material.buffSeconds),
    },
  };

  return {
    ...pool,
    temp: clampTemp(pool.temp + material.deltaTemp),
    buffs,
  };
}

/** 推进 1 秒：水温回落一次，所有词条倒计时 −1 秒，到 0 的词条消失 */
export function tickPool(pool) {
  const buffs = {};
  for (const [materialId, buff] of Object.entries(pool.buffs)) {
    const remainingSeconds = buff.remainingSeconds - 1;
    if (remainingSeconds > 0) buffs[materialId] = { remainingSeconds };
  }
  return {
    ...pool,
    temp: coolTempOneSecond(pool.temp),
    buffs,
  };
}

// ============================================================
// 温度区间与每秒满意度
// ============================================================

/** 该 NPC 的个人区间（只覆盖喜爱/耐受）；没有个人区间时返回 null */
function personalTempZoneOf(npcId) {
  if (!npcId) return null;
  return ENCOUNTERS[npcId]?.tempZone ?? null;
}

/**
 * 返回该客人（可选 npcId）在该水温下的区间：FAVORITE / TOLERANT / UNCOMFORTABLE / EXTREME（§3.3）
 * 判定顺序不变：极限（永远按种族）→ 喜爱 → 耐受 → 不适。
 * 传入 npcId 且该 NPC 有个人区间时，喜爱与耐受改用个人区间；极限区不受个人区间影响。
 */
export function getTempZone(race, temp, npcId = null) {
  const zone = RACES[race].tempZone;
  if (temp < zone.extremeBelow || temp > zone.extremeAbove) return 'EXTREME';

  const personal = personalTempZoneOf(npcId);
  const favorite = personal ? personal.favorite : zone.favorite;
  const tolerant = personal ? personal.tolerant : zone.tolerant;

  if (temp >= favorite[0] && temp <= favorite[1]) return 'FAVORITE';
  if (temp >= tolerant[0] && temp <= tolerant[1]) return 'TOLERANT';
  return 'UNCOMFORTABLE';
}

/** 温度对应的 Temp_Match，百分比整数（150 = 1.50×） */
export function tempMatchPct(race, temp, npcId = null) {
  return COMFORT_TICK.TEMP_MATCH_PCT[getTempZone(race, temp, npcId)];
}

/**
 * 温度色带的分段（纯数据，供界面画色块用；单位 0.1℃）。
 * 每段 { zone, from, to }：from 包含、to 不包含（最后一段除外）。
 * 传入 npcId 时喜爱/耐受按个人区间画，极限区仍按种族。
 */
export function tempBandSegments(race, npcId = null) {
  const z = RACES[race].tempZone;
  const personal = personalTempZoneOf(npcId);
  const favorite = personal ? personal.favorite : z.favorite;
  const tolerant = personal ? personal.tolerant : z.tolerant;
  return [
    { zone: 'EXTREME', from: TEMP.MIN, to: z.extremeBelow },
    { zone: 'UNCOMFORTABLE', from: z.extremeBelow, to: tolerant[0] },
    { zone: 'TOLERANT', from: tolerant[0], to: favorite[0] },
    { zone: 'FAVORITE', from: favorite[0], to: favorite[1] },
    { zone: 'TOLERANT', from: favorite[1], to: tolerant[1] },
    { zone: 'UNCOMFORTABLE', from: tolerant[1], to: z.extremeAbove },
    { zone: 'EXTREME', from: z.extremeAbove, to: TEMP.MAX },
  ];
}

/**
 * 冲突判定：一位带「圣职」标记的客人（RACES[race].clergy）与一位魔物阵营客人同池时，
 * 双方各自每秒承受 Conflict_Penalty（§3.7）。只看种族/阵营，不看随机数。
 * 注意：人族（ORDER）不是圣职，不触发冲突。
 */
export function hasFactionConflict(guestA, guestB) {
  if (!guestA || !guestB) return false;
  const raceA = RACES[guestA.race];
  const raceB = RACES[guestB.race];
  if (!raceA || !raceB) return false;
  const aIsClergy = raceA.clergy === true;
  const bIsClergy = raceB.clergy === true;
  return (aIsClergy && raceB.faction === 'MONSTER')
    || (bIsClergy && raceA.faction === 'MONSTER');
}

/**
 * 个人区间宽度占种族区间宽度的万分比（10000 = 100%），整数向下取整。
 * 宽度 = 上界 − 下界（含端点，不额外 +1）；NPC 没有个人区间时返回 null。
 */
export function tempZoneWidthBp(race, npcId, zoneKind) {
  const personal = personalTempZoneOf(npcId)?.[zoneKind];
  const racial = RACES[race]?.tempZone?.[zoneKind];
  if (!personal || !racial) return null;
  const personalWidth = personal[1] - personal[0];
  const raceWidth = racial[1] - racial[0];
  if (raceWidth <= 0) return null;
  return divFloor(personalWidth * UNITS.PERCENT * UNITS.PERCENT, raceWidth);
}

/**
 * 配置校验（纯函数，只在测试里调用，运行期不抛错）：
 *  - 个人区间必须是种族区间的子区间（下界 ≥ 种族下界、上界 ≤ 种族上界）→ NOT_SUBSET
 *  - 个人区间宽度不得超过该阶位的上限（万分比，交叉相乘，不做除法）→ OVER_WIDTH
 * 返回 [{ npcId, zone, code }]，zone 取 favorite / tolerant。
 * @param {object} [encounters] 默认取 config.ENCOUNTERS（测试可传深拷贝）
 * @param {object} [races] 默认取 config.RACES
 */
export function validateTempZones(encounters = ENCOUNTERS, races = RACES) {
  const issues = [];
  const rankKeys = Object.keys(TEMP_ZONE_WIDTH_LIMIT_BP_BY_RANK).map(Number);
  const minRankKey = Math.min(...rankKeys);
  const maxRankKey = Math.max(...rankKeys);

  for (const [npcId, npc] of Object.entries(encounters)) {
    if (!npc.tempZone) continue;
    const racial = races[npc.race]?.tempZone;
    if (!racial) continue;

    const rankKey = Math.min(npc.rank ?? minRankKey, maxRankKey);
    const limitBp = TEMP_ZONE_WIDTH_LIMIT_BP_BY_RANK[rankKey]
      ?? TEMP_ZONE_WIDTH_LIMIT_BP_BY_RANK[maxRankKey];

    for (const zoneKind of ['favorite', 'tolerant']) {
      const personal = npc.tempZone[zoneKind];
      const racialZone = racial[zoneKind];
      if (!personal || !racialZone) continue;

      if (personal[0] < racialZone[0] || personal[1] > racialZone[1]) {
        issues.push({ npcId, zone: zoneKind, code: 'NOT_SUBSET' });
        continue;
      }

      const personalWidth = personal[1] - personal[0];
      const raceWidth = racialZone[1] - racialZone[0];
      if (personalWidth * UNITS.PERCENT * UNITS.PERCENT > raceWidth * limitBp) {
        issues.push({ npcId, zone: zoneKind, code: 'OVER_WIDTH' });
      }
    }
  }

  return issues;
}

/** 按当前洁净度取档位（§3.7 表） */
export function cleanTier(clean) {
  for (const tier of COMFORT_TICK.CLEAN_TIERS) {
    if (clean >= tier.minClean) return tier;
  }
  return COMFORT_TICK.CLEAN_TIERS[COMFORT_TICK.CLEAN_TIERS.length - 1];
}

/**
 * 客人这一秒的满意度变化（单位 0.01，可正可负）：
 *   Gain = BASE_RATE × Temp_Match × (1 + ΣSpeed_Bonus)      ← P0 没有 Speed_Bonus，当作 1.00×
 *   Loss = Conflict_Penalty + 温度区惩罚
 *          极限区 → Extreme_Temp_Penalty（不叠加不适扣分）
 *          不适区 → Uncomfortable_Penalty（新规则，每秒 0.50）
 *          喜爱/耐受区 → 0
 *   ΔComfort = Gain × Clean_Factor − Loss × Dirty_Mult
 * Loss 里的 Conflict_Penalty 只在「圣职 × 魔物」同池时由 stepSecond 传入 conflict=true 才计入，
 * 并且与温度区惩罚一起被 Dirty_Mult 放大（§3.7）。
 */
export function comfortDeltaPerSecond({ race, temp, clean, npcId = null, conflict = false }) {
  const tier = cleanTier(clean);
  const matchPct = tempMatchPct(race, temp, npcId);

  // Gain：100 × 150 / 100 = 150 → 1.50 满意度/秒
  const gain = divFloor(COMFORT_TICK.BASE_RATE * matchPct, UNITS.PERCENT);
  const gainAfterClean = divFloor(gain * tier.cleanFactorPct, UNITS.PERCENT);

  // Loss：极限区只扣极限惩罚（不叠加不适扣分）；不适区扣「不适扣分」；两者都会被 Dirty_Mult 放大
  const zone = getTempZone(race, temp, npcId);
  let lossUnits = 0;
  if (zone === 'EXTREME') lossUnits = COMFORT_TICK.EXTREME_PENALTY_PER_SEC;
  else if (zone === 'UNCOMFORTABLE') lossUnits = COMFORT_TICK.UNCOMFORTABLE_PENALTY_PER_SEC;
  if (conflict) lossUnits += COMFORT_TICK.CONFLICT_PENALTY_PER_SEC;
  const lossAfterDirty = divFloor(lossUnits * tier.dirtyMultPct, UNITS.PERCENT);

  return gainAfterClean - lossAfterDirty;
}

/**
 * 推进 1 秒（顺序按补充口径：先水温回落，再满意度）：
 *   1. 水温向室温逼近 1 秒，词条倒计时 −1
 *   2. 每位客人按「本秒开始时的水温/洁净度」结算满意度（夹紧 0~100.00），
 *      同池存在「圣职 × 魔物」时双方各自 conflict = true
 *   3. 每位在池客人让洁净度 −0.1
 * 返回新的 pool / guests，不修改入参。
 */
export function stepSecond(pool, guests) {
  const nextPool = tickPool(pool);

  const nextGuests = guests.map((guest, index) => {
    const conflict = guests.some(
      (other, otherIndex) => otherIndex !== index && hasFactionConflict(guest, other),
    );
    const delta = comfortDeltaPerSecond({
      // 熟客用 guestId；遭遇 NPC 档案的 guestId 就是 npcId，个人区间按它查
      npcId: guest.npcId ?? guest.guestId ?? null,
      race: guest.race,
      temp: nextPool.temp,
      clean: nextPool.clean,
      conflict,
    });
    return {
      ...guest,
      comfort: clamp(guest.comfort + delta, GUEST.COMFORT_MIN, GUEST.COMFORT_MAX),
    };
  });

  const cleanDrop = nextGuests.length * GUEST.CLEAN_DROP_PER_GUEST_SEC;
  const clean = clamp(nextPool.clean - cleanDrop, GUEST.CLEAN_MIN, GUEST.CLEAN_MAX);

  return { pool: { ...nextPool, clean }, guests: nextGuests };
}

/** 满意度 ≤0：怒离（§3.6） */
export function isAngry(guest) {
  return guest.comfort <= GUEST.ANGRY_AT_OR_BELOW;
}

/** 客人离场：洁净度 −3.0（§3.6；P1 的「饱腹入定」不实装） */
export function onGuestLeave(pool) {
  return {
    ...pool,
    clean: clamp(pool.clean - GUEST.CLEAN_DROP_ON_LEAVE, GUEST.CLEAN_MIN, GUEST.CLEAN_MAX),
  };
}

// ============================================================
// 离店金币（§3.7 + 补充口径）
// ============================================================

/** 当前池子里生效的小费乘区（百分比整数）：默认 1.00×，MAT_003 让亡灵变 2.00× */
export function tipMultPctFor(pool, race) {
  let pct = SETTLEMENT.TIP_MULT_DEFAULT_PCT;
  for (const [materialId] of Object.entries(pool.buffs)) {
    const material = MATERIALS[materialId];
    if (material.tipMult && material.tipMult.race === race) {
      pct = Math.max(pct, material.tipMult.pct);
    }
  }
  return pct;
}

/**
 * 正常离店的收入拆分（整数 G）。这是营业日流程实际使用的入口，门票和小费分开记账：
 *   Total_Gold = BASE_FEE × Rep_Mult + Snack_Price
 *              + BASE_TIP × (Final_Comfort / 100) × Affinity_Mult × Tip_Mult
 * 内部 1/1000 G 计算；门票本身是整数，小费单独四舍五入、.5 向上。
 *
 * @param {object} params
 * @param {number} params.comfort      离店满意度，单位 0.01（0~10000）
 * @param {number} [params.heart]      该客人的心数 0~10，默认 0
 * @param {number} [params.repMultPct] 声望乘区，百分比整数，默认 100（1.00×）
 * @param {number} [params.tipMultPct] 小费乘区，百分比整数，默认 100（1.00×）
 * @param {number} [params.snackPrice] 小食售价，单位 G，默认 0
 * @returns {{ ticketGold: number, tipGold: number, snackGold: number, totalGold: number }}
 */
export function settleBreakdown({
  comfort,
  heart = 0,
  repMultPct = SETTLEMENT.REP_MULT_DEFAULT_PCT,
  tipMultPct = SETTLEMENT.TIP_MULT_DEFAULT_PCT,
  snackPrice = 0,
}) {
  const heartClamped = clamp(heart, AFFINITY.HEART_MIN, AFFINITY.HEART_MAX);
  const affinityMultPct = SETTLEMENT.AFFINITY_MULT_BASE_PCT + heartClamped * SETTLEMENT.AFFINITY_MULT_PER_HEART_PCT;

  const baseFeeMilli = divFloor(SETTLEMENT.BASE_FEE * UNITS.GOLD_MILLI * repMultPct, UNITS.PERCENT);

  // BASE_TIP × (comfort / 10000) × (affinity / 100) × (tip / 100)
  const tipMilli = divFloor(
    SETTLEMENT.BASE_TIP * UNITS.GOLD_MILLI * comfort * affinityMultPct * tipMultPct,
    GUEST.COMFORT_MAX * UNITS.PERCENT * UNITS.PERCENT,
  );

  const ticketGold = divFloor(baseFeeMilli, UNITS.GOLD_MILLI);
  const tipGold = divFloor(tipMilli + divFloor(UNITS.GOLD_MILLI, 2), UNITS.GOLD_MILLI);

  return {
    ticketGold,
    tipGold,
    snackGold: snackPrice,
    totalGold: ticketGold + tipGold + snackPrice,
  };
}

/** 怒离实收：只收一半门票（50 × 50% = 25G），无小费无小食（§3.7 + P0 补充） */
export function settleAngryGold() {
  return divFloor(SETTLEMENT.BASE_FEE * SETTLEMENT.ANGRY_FEE_PCT, UNITS.PERCENT);
}
