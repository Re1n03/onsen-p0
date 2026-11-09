/**
 * player.js — 玩家等级与经验（㉓）
 *
 * 职责：
 *  - 经验曲线（needExp）、馆建造资格（unlockedHouseLevel）、教学日判断
 *  - 经验单价查询（guestExpOf / visitorBonusOf）
 *  - 统一入账入口 grantExp：教学日 0、满级停止、跨级逐级结算
 *
 * 依赖方向：config → player → clock/explore。
 * 本文件只 import config.js，不 import clock.js / explore.js / state.js 的运行时函数；
 * 只对传入的 state 对象读写，不碰 DOM、不抽随机数、不写金币/库存/日报。
 */

import { ENCOUNTERS, PLAYER_EXP, PLAYER_LEVEL } from '../config.js';

/** 从 level 升到 level+1 所需经验；level 越界返回 null */
export function needExp(level) {
  if (!Number.isInteger(level) || level < 1 || level > PLAYER_LEVEL.NEED.length) return null;
  return PLAYER_LEVEL.NEED[level - 1];
}

/** 玩家等级对应的馆建造资格（1~5）；只读，不改 state.houseLevel */
export function unlockedHouseLevel(playerLevel) {
  let houseLevel = 1;
  for (const [level, unlock] of Object.entries(PLAYER_LEVEL.UNLOCK_HOUSE_LEVEL)) {
    if (playerLevel >= Number(level)) houseLevel = unlock;
  }
  return houseLevel;
}

/** 教学日：第 1~TEACHING_DAYS 个营业日（读 state.day） */
export function isTeachingDay(state) {
  return state.day <= PLAYER_LEVEL.TEACHING_DAYS;
}

/** 客人离场按满意度分档经验（内部满意度单位 0.01：8000 = 80.00） */
export function guestExpOf(comfort) {
  for (const band of PLAYER_EXP.GUEST_BANDS) {
    if (comfort >= band.minComfort) return band.exp;
  }
  return 0;
}

/** 到访者（ENCOUNTERS 里的 id）正常离场额外加成 */
export function visitorBonusOf(guestId) {
  return ENCOUNTERS[guestId] ? PLAYER_EXP.VISITOR_BONUS : 0;
}

/**
 * 统一入账。
 *  - amount 必须是非负整数；0 直接返回，不写日志。
 *  - 教学日返回 0，不写 playerExp / expLog。
 *  - 满级返回 { gained:0, levels:0, capped:true }，不写日志。
 *  - 否则先记一条 expGained（记入账前的等级与入账后的经验），再逐级升级，
 *    每升一级记一条 playerLevelUp；余数保留，到 30 级后余数置 0。
 * 全程不抽随机数、不写金币/库存/日报。
 * @returns {{ gained: number, levels: number, capped: boolean }}
 */
export function grantExp(state, amount, source, at = null) {
  if (!Number.isInteger(amount) || amount < 0) return { gained: 0, levels: 0, capped: false };
  if (amount === 0) return { gained: 0, levels: 0, capped: false };
  if (isTeachingDay(state)) return { gained: 0, levels: 0, capped: false };
  if (state.playerLevel >= PLAYER_LEVEL.MAX) return { gained: 0, levels: 0, capped: true };

  state.playerExp += amount;
  state.expLog.push({
    type: 'expGained',
    at,
    amount,
    source,
    playerLevel: state.playerLevel,
    playerExp: state.playerExp,
  });

  let levels = 0;
  while (state.playerLevel < PLAYER_LEVEL.MAX && state.playerExp >= needExp(state.playerLevel)) {
    state.playerExp -= needExp(state.playerLevel);
    state.playerLevel += 1;
    levels += 1;
    state.expLog.push({ type: 'playerLevelUp', at, level: state.playerLevel });
  }

  // 到达满级后余数置 0（避免满级后仍显示"还差几点"）
  if (state.playerLevel >= PLAYER_LEVEL.MAX) state.playerExp = 0;

  return { gained: amount, levels, capped: false };
}
