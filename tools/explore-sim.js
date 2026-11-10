/**
 * tools/explore-sim.js — 采风（v2）策略模拟器 · 调参用
 *
 * 运行：node tools/explore-sim.js
 *       node tools/explore-sim.js --runs=1000 --level=0
 *       node tools/explore-sim.js --ant-affinity=10
 *       node tools/explore-sim.js --loadout=L2 --snacks=3 --eat-below=2 --return=D7 --policy=NEG
 *
 * 约束：
 *  - 只调用 src 的公开函数；不复制任何游戏规则（雅兴、深度、成功率、掉落、售价都来自 src/config）。
 *  - 所有随机数走 state.rng（createInitialState(seed)）；同参数两次运行 DIGEST 相同。
 *  - 单趟模拟：每趟从第 1 天开局状态出发，只跑一次采风，不跑营业日。
 *
 * 净价值口径（不赎回）：
 *   净价值 = 带回战利品的 sellItem 收入 − 离手装填物成本
 *   离手装填物 = 吃掉的小食 / 谈判消耗的物品 / 逃跑消耗的材料 / 倒地时丢失的装填物，按 buyPrice 计。
 *   赎金不计入净价值，只用 lostBagRansom() 另算「若赎回净价值 = 净价值 − 赎金」参考。
 */

import { createHash } from 'node:crypto';
import { MATERIALS, SNACKS, STARTING } from '../config.js';
import { createInitialState } from '../src/state.js';
import {
  advance,
  discardPending,
  eat,
  fight,
  flee,
  negotiate,
  returnCost,
  returnHome,
  settleNode,
  startExplore,
} from '../src/explore.js';
import { lostBagRansom } from '../src/lostfound.js';
import { sellItem, upgradeMood } from '../src/actions.js';

// ============================================================
// 参数
// ============================================================
const DEFAULTS = {
  runs: 2000,
  seed: 20261102,
  level: 'grid',          // grid = [0, 2]；也可 --level=0..4
  antAffinity: 0,
  fragments: 0,
  fallIncome: 1,          // 1 = 倒地趟保留战利品照常计收入；0 = 倒地趟收入记 0
  loadout: null,
  snacks: null,
  eatBelow: null,
  returnSpec: null,
  policy: null,
  digestOnly: false,
  full: false,
};

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) {
      const flag = /^--([^=]+)$/.exec(arg);
      if (flag) { out[flag[1]] = true; continue; }
      throw new Error(`无法解析参数：${arg}`);
    }
    out[match[1]] = match[2];
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
const cfg = {
  runs: cli.runs !== undefined ? Number(cli.runs) : DEFAULTS.runs,
  seed: cli.seed !== undefined ? Number(cli.seed) : DEFAULTS.seed,
  level: cli.level !== undefined ? cli.level : DEFAULTS.level,
  antAffinity: cli['ant-affinity'] !== undefined ? Number(cli['ant-affinity']) : DEFAULTS.antAffinity,
  fragments: cli.fragments !== undefined ? Number(cli.fragments) : DEFAULTS.fragments,
  fallIncome: cli['fall-income'] !== undefined ? Number(cli['fall-income']) : DEFAULTS.fallIncome,
  loadout: cli.loadout ?? null,
  snacks: cli.snacks !== undefined ? Number(cli.snacks) : null,
  eatBelow: cli['eat-below'] !== undefined ? Number(cli['eat-below']) : null,
  returnSpec: cli.return ?? null,
  policy: cli.policy ?? null,
  digestOnly: Boolean(cli['digest-only']),
  full: Boolean(cli.full),
};
if (!Number.isInteger(cfg.runs) || cfg.runs <= 0) throw new Error('--runs 必须是正整数');
if (!Number.isInteger(cfg.seed)) throw new Error('--seed 必须是整数');
if (![0, 1].includes(cfg.fallIncome)) throw new Error('--fall-income 只能是 0 或 1');

// ============================================================
// 固定表（全部是“策略参数”，不是游戏规则）
// ============================================================
const LOADOUTS = {
  L1: { label: 'L1 轻装', backpack: { MAT_002: 1 } },
  L2: { label: 'L2 标准', backpack: { MAT_002: 2, MAT_001: 1 } },
  L3: { label: 'L3 重装', backpack: { MAT_002: 3, MAT_001: 2, MAT_003: 3 } },
};

/** 回店策略：'D5' = 深度≥5 回店；'m4' = 雅兴−returnCost ≤ 4 时回店（不吃小食）；'E2' = 续航型（同条件先吃小食，吃不到才回店） */
function parseReturnSpec(text) {
  if (text === 'D∞' || text === 'Dinf' || text === 'DInfinity') {
    return { type: 'D', value: Infinity, label: 'D∞' };
  }
  const depth = /^D(\d+)$/.exec(text);
  if (depth) return { type: 'D', value: Number(depth[1]), label: `D${depth[1]}` };
  const margin = /^m(\d+)$/.exec(text);
  if (margin) return { type: 'm', value: Number(margin[1]), label: `m${margin[1]}` };
  const eatMargin = /^E(\d+)$/.exec(text);
  if (eatMargin) return { type: 'EAT', value: Number(eatMargin[1]), label: `E${eatMargin[1]}` };
  const cap = /^C(\d+)\/(\d+)$/.exec(text);
  if (cap) {
    return {
      type: 'CAP',
      depth: Number(cap[1]),
      margin: Number(cap[2]),
      label: `C${cap[1]}/${cap[2]}`,
    };
  }
  throw new Error(`无法解析回店策略：${text}`);
}

/**
 * 战斗费用：src 没有单独导出「战斗费用」，但 fight() 的返回值带 cost 字段。
 * 这里用一次性 disposable 状态在每个深度调用真正的 fight()，读 result.cost 作为费用表，
 * 不复制 FIGHT/ENCOUNTER 的规则。
 */
function measureFightCostByDepth() {
  const costs = {};
  for (let depth = 1; depth <= 12; depth += 1) {
    const state = createInitialState({ seed: 1 });
    state.gold = 1_000_000;
    state.inventory = {};
    const started = startExplore(state);
    if (!started.ok) throw new Error(`战斗费用测量 startExplore 失败：${started.reason}`);
    state.explore.depth = depth;
    state.explore.mood = 1000;
    state.explore.pendingEncounter = 'ANT_FOREMAN';
    const result = fight(state);
    if (!result.ok || !Number.isInteger(result.cost)) {
      throw new Error(`战斗费用测量 fight 失败：${result.reason ?? result.cost}`);
    }
    costs[depth] = result.cost;
  }
  return costs;
}
const FIGHT_COST_BY_DEPTH = measureFightCostByDepth();

function buildCombinations() {
  const explicit = cfg.loadout !== null || cfg.snacks !== null || cfg.eatBelow !== null
    || cfg.returnSpec !== null || cfg.policy !== null;

  const levels = cfg.level === 'grid' ? [2, 3, 4] : [Number(cfg.level)];
  for (const level of levels) {
    if (!Number.isInteger(level) || level < 0 || level > 4) throw new Error('--level 必须是 0~4');
  }
  if (explicit) {
    const single = {
      level: levels[0],
      loadout: cfg.loadout ?? 'L1',
      snacks: cfg.snacks ?? 2,
      eatBelow: cfg.eatBelow ?? 2,
      returnSpec: parseReturnSpec(cfg.returnSpec ?? 'D7'),
      policy: cfg.policy ?? 'NEG',
    };
    if (cfg.level === 'grid') single.level = 0;
    return [single];
  }

  const combos = [];
  const returnSpecs = [];
  for (const margin of [2, 4, 6, 8]) {
    returnSpecs.push({ type: 'CAP', depth: 9, margin, label: `C9/${margin}` });
  }
  for (const level of levels) {
    for (const loadout of ['L1', 'L2']) {
      for (const snacks of [2, 4]) {
        for (const eatBelow of [2]) {
          for (const returnSpec of returnSpecs) {
            for (const policy of ['FIGHT', 'NEG_SNK1', 'ADAPT_FIGHT', 'ADAPT_NEG']) {
              combos.push({ level, loadout, snacks, eatBelow, returnSpec, policy });
            }
          }
        }
      }
    }
  }
  return combos;
}

// ============================================================
// 状态准备
// ============================================================
function applyLevel(state, level) {
  if (level <= 0) return;
  const startingGold = state.gold;
  const startingPlayerLevel = state.playerLevel;
  state.gold = 1_000_000; // 仅用于支付升级费，升级后立即还原
  state.playerLevel = 30; // 仅用于通过雅兴升级的玩家等级门槛，升级后立即还原（不动 playerExp）
  for (let index = 0; index < level; index += 1) {
    const result = upgradeMood(state);
    if (!result.ok) throw new Error(`upgradeMood 失败：${result.reason}`);
  }
  state.gold = startingGold;
  state.playerLevel = startingPlayerLevel;
}

function loadoutInventory(loadout, snacks) {
  const inventory = { ...LOADOUTS[loadout].backpack };
  if (snacks > 0) inventory.SNK_001 = snacks;
  return inventory;
}

// ============================================================
// 单趟模拟
// ============================================================
function countMap(backpack) {
  const counts = {};
  for (const slot of backpack) {
    counts[slot.itemId] = (counts[slot.itemId] ?? 0) + slot.count;
  }
  return counts;
}

function positiveDiff(before, after) {
  const additions = {};
  for (const [itemId, count] of Object.entries(after)) {
    const added = count - (before[itemId] ?? 0);
    if (added > 0) additions[itemId] = added;
  }
  return additions;
}

function findFleeMaterial(explore) {
  for (const slot of explore.backpack) {
    if (MATERIALS[slot.itemId] && slot.count > 0) return slot.itemId;
  }
  return null;
}

function simulateOnce(combo, seed) {
  const state = createInitialState({ seed });
  applyLevel(state, combo.level);
  state.fragments = cfg.fragments;
  state.affectionExp.ANT_FOREMAN = cfg.antAffinity;

  const loadout = LOADOUTS[combo.loadout];
  state.inventory = loadoutInventory(combo.loadout, combo.snacks);

  const started = startExplore(state, {
    lunchbox: combo.snacks > 0 ? { SNK_001: combo.snacks } : {},
    backpack: { ...loadout.backpack },
  });
  if (!started.ok) throw new Error(`startExplore 失败：${started.reason}（${combo.loadout} / 小食 ${combo.snacks}）`);

  const tracker = {
    eats: 0,
    encounters: 0,
    negAttempts: 0,
    negSuccess: 0,
    fights: 0,
    flees: 0,
    pendingDiscards: 0,
    consumesCost: 0,      // 离手装填物成本
    loot: {},             // 战利品账本（件数）
    freeSnacks: 0,        // 野餐篮/偷食后“免费”小食的剩余量
    fall: false,
    fallCause: null,
    fallCategory: null,   // 'FIGHT' | 'ADVANCE' | 'RETURN'
    fleeFall: false,      // 倒地是否由逃跑触发
    fallDepth: 0,
    maxDepth: 0,
    returnDepth: null,
    fleeDepth: null,
    adaptEat: 0,          // 因雅兴不足改吃小食次数
    adaptFlee: 0,         // 因雅兴不足改逃跑次数
    forcedFight: 0,       // 被迫战斗次数
    fleeMaterialCount: 0, // 逃跑消耗材料件数
    fleeCost: 0,          // 逃跑消耗材料买价
    revenue: 0,
    ransom: 0,
    lostValue: 0,
    endReason: null,
    error: null,
  };

  function recordFall(fall) {
    tracker.fall = true;
    tracker.fallCause = fall.cause;
    tracker.fallDepth = fall.depth;
    tracker.maxDepth = Math.max(tracker.maxDepth, fall.depth);
    tracker.lostValue = fall.lostBag.totalValue;
    for (const item of fall.lostBag.items) {
      const held = tracker.loot[item.itemId] ?? 0;
      const lootLost = Math.min(held, item.count);
      tracker.loot[item.itemId] = held - lootLost;
      const loadoutLost = item.count - lootLost;
      if (loadoutLost > 0) {
        tracker.consumesCost += (MATERIALS[item.itemId]?.buyPrice ?? 0) * loadoutLost;
      }
    }
  }

  function consumeSnack() {
    if (tracker.freeSnacks > 0) tracker.freeSnacks -= 1;
    else tracker.consumesCost += SNACKS.SNK_001.buyPrice;
  }

  function consumeOfferItem(itemId) {
    if (itemId === 'FRAGMENT') return;
    if (itemId === 'SNK_001') { consumeSnack(); return; }
    if (MATERIALS[itemId]) tracker.consumesCost += MATERIALS[itemId].buyPrice;
  }

  function doFight() {
    const result = fight(state);
    if (!result.ok) {
      tracker.error = result.reason;
      tracker.endReason = 'ERROR';
      return;
    }
    tracker.fights += 1;
    if (result.fell) {
      tracker.fallCategory = 'FIGHT';
      recordFall(result.fall);
      tracker.endReason = 'FALL';
      return;
    }
    if (result.needSwap) {
      discardPending(state);
      tracker.pendingDiscards += 1;
    } else if (result.loot) {
      tracker.loot[result.loot] = (tracker.loot[result.loot] ?? 0) + 1;
    }
  }

  function buildOffer(policy) {
    if (policy === 'NEG') return [];
    const want = policy === 'NEG_SNK1' || policy === 'ADAPT_NEG' ? 1 : 3;
    const available = state.explore.lunchbox.SNK_001 ?? 0;
    const count = Math.min(want, available);
    return Array(count).fill('SNK_001');
  }

  function tryNegotiate() {
    if (state.explore.negotiationTried) return;
    if ((state.affectionExp[state.explore.pendingEncounter] ?? 0) <= 0) return; // 好感 0 直接跳过
    const offer = buildOffer('ADAPT_NEG');
    const result = negotiate(state, offer);
    if (!result.ok) return;
    tracker.negAttempts += 1;
    for (const itemId of offer) consumeOfferItem(itemId);
    if (result.success) {
      tracker.negSuccess += 1;
      if (result.needSwap) {
        discardPending(state);
        tracker.pendingDiscards += 1;
      } else if (result.gift) {
        tracker.loot[result.gift] = (tracker.loot[result.gift] ?? 0) + 1;
      }
    }
  }

  function currentFightCost() {
    const depth = Math.min(state.explore.depth, 12);
    return FIGHT_COST_BY_DEPTH[depth];
  }

  function canFightAndReturn() {
    return state.explore.mood - currentFightCost() >= returnCost(state);
  }

  /** 雅兴不够付战斗时先吃小食，每次重新判断 */
  function eatToAffordFight() {
    let guard = 0;
    while (state.explore
      && !canFightAndReturn()
      && (state.explore.lunchbox.SNK_001 ?? 0) > 0
      && guard < 30) {
      const result = eat(state);
      if (!result.ok) break;
      tracker.adaptEat += 1;
      tracker.eats += 1;
      consumeSnack();
      guard += 1;
    }
  }

  /** 背包里买价最低的材料逃跑；成功即本趟结束（可能倒地） */
  function fleeCheapestMaterial() {
    let bestId = null;
    let bestPrice = Infinity;
    for (const slot of state.explore.backpack) {
      const profile = MATERIALS[slot.itemId];
      if (!profile || slot.count <= 0) continue;
      if (profile.buyPrice < bestPrice) {
        bestPrice = profile.buyPrice;
        bestId = slot.itemId;
      }
    }
    if (!bestId) return false;
    const result = flee(state, bestId);
    if (!result.ok) return false;
    tracker.adaptFlee += 1;
    tracker.flees += 1;
    tracker.fleeMaterialCount += 1;
    tracker.fleeCost += bestPrice;
    tracker.consumesCost += bestPrice;
    if (result.fell) {
      tracker.fallCategory = 'RETURN';
      tracker.fleeFall = true;
      recordFall(result.fall);
      tracker.endReason = 'FALL';
    } else {
      tracker.endReason = 'FLEE_RETURN';
    }
    return true;
  }

  /** 自适应战斗：能安全战斗就战斗；否则吃小食；仍不行且能安全返程就逃跑；都不行就硬打 */
  function adaptFight() {
    if (canFightAndReturn()) { doFight(); return; }
    eatToAffordFight();
    if (canFightAndReturn()) { doFight(); return; }
    if (state.explore.mood >= returnCost(state) && fleeCheapestMaterial()) return;
    tracker.forcedFight += 1;
    doFight();
  }

  function resolveEncounter() {
    tracker.encounters += 1;
    const policy = combo.policy;

    if (policy === 'NEG' || policy === 'NEG_SNK1' || policy === 'NEG_SNK3') {
      if (!state.explore.negotiationTried) {
        const offer = buildOffer(policy);
        const result = negotiate(state, offer);
        if (result.ok) {
          tracker.negAttempts += 1;
          for (const itemId of offer) consumeOfferItem(itemId);
          if (result.success) {
            tracker.negSuccess += 1;
            if (result.needSwap) {
              discardPending(state);
              tracker.pendingDiscards += 1;
            } else if (result.gift) {
              tracker.loot[result.gift] = (tracker.loot[result.gift] ?? 0) + 1;
            }
          }
        }
      }
      if (state.explore && state.explore.pendingEncounter) doFight();
      return;
    }

    if (policy === 'ADAPT_NEG') {
      tryNegotiate();
      if (state.explore && state.explore.pendingEncounter) adaptFight();
      return;
    }

    if (policy === 'ADAPT_FIGHT') {
      adaptFight();
      return;
    }

    if (policy === 'FIGHT') {
      doFight();
      return;
    }

    if (policy === 'FLEE') {
      const materialId = findFleeMaterial(state.explore);
      if (!materialId) { doFight(); return; }
      const result = flee(state, materialId);
      if (!result.ok) { doFight(); return; }
      tracker.flees += 1;
      tracker.fleeMaterialCount += 1;
      tracker.fleeCost += MATERIALS[materialId].buyPrice;
      tracker.consumesCost += MATERIALS[materialId].buyPrice;
      if (result.fell) {
        tracker.fallCategory = 'RETURN';
        tracker.fleeFall = true;
        recordFall(result.fall);
        tracker.endReason = 'FALL';
      } else {
        tracker.endReason = 'FLEE_RETURN';
      }
      return;
    }

    throw new Error(`未知遭遇策略：${policy}`);
  }

  while (state.explore) {
    const explore = state.explore;
    tracker.maxDepth = Math.max(tracker.maxDepth, explore.depth);

    // 1) 回店判断
    const marginLimit = combo.returnSpec.type === 'CAP'
      ? combo.returnSpec.margin
      : combo.returnSpec.value;
    const marginReached = () => Boolean(state.explore)
      && state.explore.mood - returnCost(state) <= marginLimit;
    const eatToSafety = () => {
      let guard = 0;
      while (marginReached() && (state.explore.lunchbox.SNK_001 ?? 0) > 0 && guard < 30) {
        const eaten = eat(state);
        if (!eaten.ok) break;
        tracker.eats += 1;
        consumeSnack();
        guard += 1;
      }
    };

    let shouldReturn;
    if (combo.returnSpec.type === 'CAP') {
      // 先判深度上限；没到上限再按边距吃小食，吃不到小食才回店
      if (explore.depth >= combo.returnSpec.depth) {
        shouldReturn = true;
      } else if (marginReached()) {
        eatToSafety();
        shouldReturn = marginReached();
      } else {
        shouldReturn = false;
      }
    } else if (combo.returnSpec.type === 'EAT') {
      eatToSafety();
      shouldReturn = marginReached();
    } else if (combo.returnSpec.type === 'D') {
      shouldReturn = explore.depth >= combo.returnSpec.value;
    } else {
      shouldReturn = marginReached();
    }
    if (shouldReturn) {
      tracker.returnDepth = explore.depth;
      const result = returnHome(state);
      if (result.fell) {
        tracker.fallCategory = 'RETURN';
        recordFall(result.fall);
        tracker.returnDepth = null;
        tracker.endReason = 'FALL';
      } else {
        tracker.endReason = 'RETURN';
      }
      break;
    }

    // 2) 吃小食（阈值触发）
    while (state.explore
      && (state.explore.lunchbox.SNK_001 ?? 0) > 0
      && state.explore.mood <= combo.eatBelow) {
      const result = eat(state);
      if (!result.ok) break;
      tracker.eats += 1;
      consumeSnack();
    }
    if (!state.explore) break;

    // 3) 推进一个节点
    const backpackBefore = countMap(state.explore.backpack);
    const lunchBefore = state.explore.lunchbox.SNK_001 ?? 0;
    const result = advance(state);

    if (!result.ok) {
      tracker.error = result.reason;
      tracker.endReason = 'ERROR';
      break;
    }

    if (result.fell) {
      tracker.fallCategory = 'ADVANCE';
      recordFall(result.fall);
      tracker.endReason = 'FALL';
      break;
    }

    // 小食数量变化（事件：野餐篮 / 野兽偷食）
    const lunchAfter = state.explore.lunchbox.SNK_001 ?? 0;
    if (lunchAfter > lunchBefore) {
      tracker.freeSnacks += lunchAfter - lunchBefore;
    } else if (lunchAfter < lunchBefore) {
      let stolen = lunchBefore - lunchAfter;
      while (stolen > 0) { consumeSnack(); stolen -= 1; }
    }

    // 资源点战利品：以背包实际增量为准（NEED_SWAP 的 pending 件不计）
    if (result.nodeType === 'RESOURCE') {
      const backpackAfter = countMap(state.explore.backpack);
      for (const [itemId, count] of Object.entries(positiveDiff(backpackBefore, backpackAfter))) {
        tracker.loot[itemId] = (tracker.loot[itemId] ?? 0) + count;
      }
    }

    if (result.needSwap) {
      discardPending(state);
      tracker.pendingDiscards += 1;
    }

    // 4) 遭遇
    if (state.explore && state.explore.pendingEncounter) {
      resolveEncounter();
      if (!state.explore) break;
    }
    if (tracker.endReason === 'ERROR') break;
  }

  if (!tracker.endReason) tracker.endReason = tracker.fall ? 'FALL' : 'UNKNOWN';

  // 野餐篮多出来的小食在回店/倒地后也回到库存，作为战利品出售
  if (tracker.freeSnacks > 0 && state.explore === null) {
    tracker.loot.SNK_001 = (tracker.loot.SNK_001 ?? 0) + tracker.freeSnacks;
    tracker.freeSnacks = 0;
  }

  // 战利品出售（倒地趟可用 --fall-income=0 关闭）
  if (state.explore === null && !(tracker.fall && cfg.fallIncome === 0)) {
    for (const [itemId, count] of Object.entries(tracker.loot)) {
      if (count <= 0) continue;
      const held = state.inventory[itemId] ?? 0;
      const qty = Math.min(count, held);
      if (qty <= 0) continue;
      const result = sellItem(state, itemId, qty);
      if (result.ok) tracker.revenue += result.totalGold;
    }
  }

  // 赎金只做参考列
  if (tracker.fall && state.lostBags.length > 0) {
    const bag = state.lostBags[state.lostBags.length - 1];
    tracker.ransom = lostBagRansom(state, bag).gold;
  }

  const net = tracker.revenue - tracker.consumesCost;
  return {
    endReason: tracker.endReason,
    error: tracker.error,
    fell: tracker.fall,
    fallCause: tracker.fallCause,
    fallCategory: tracker.fallCategory,
    fleeFall: tracker.fleeFall,
    fallDepth: tracker.fallDepth,
    maxDepth: tracker.maxDepth,
    returnDepth: tracker.returnDepth,
    fleeDepth: tracker.fleeDepth,
    revenue: tracker.revenue,
    consumesCost: tracker.consumesCost,
    net,
    netIfRedeemed: net - tracker.ransom,
    ransom: tracker.ransom,
    lostValue: tracker.lostValue,
    encounters: tracker.encounters,
    negAttempts: tracker.negAttempts,
    negSuccess: tracker.negSuccess,
    fights: tracker.fights,
    flees: tracker.flees,
    eats: tracker.eats,
    pendingDiscards: tracker.pendingDiscards,
    adaptEat: tracker.adaptEat,
    adaptFlee: tracker.adaptFlee,
    forcedFight: tracker.forcedFight,
    fleeMaterialCount: tracker.fleeMaterialCount,
    fleeCost: tracker.fleeCost,
  };
}

// ============================================================
// 汇总与输出
// ============================================================
function newAggregate() {
  return {
    runs: 0,
    falls: 0,
    fallDepthSum: 0,
    maxDepthSum: 0,
    returns: 0,
    returnDepthSum: 0,
    netSum: 0,
    netRedeemedSum: 0,
    revenueSum: 0,
    costSum: 0,
    ransomSum: 0,
    fleeReturns: 0,
    errors: 0,
    fallByFight: 0,
    fallByAdvance: 0,
    fallByReturn: 0,
    fleeFallFalls: 0,
    adaptEatSum: 0,
    adaptFleeSum: 0,
    forcedFightSum: 0,
    fleeMaterialSum: 0,
    fleeCostSum: 0,
    encounters: 0,
    negAttempts: 0,
    negSuccess: 0,
    fights: 0,
    flees: 0,
    eats: 0,
    pendingDiscards: 0,
    survival: Array.from({ length: 13 }, () => 0),
    fallDist: Array.from({ length: 14 }, () => 0),
    maxDepthDist: Array.from({ length: 14 }, () => 0),
  };
}

function aggregateRun(agg, row) {
  agg.runs += 1;
  agg.maxDepthSum += row.maxDepth;
  if (row.fell) {
    agg.falls += 1;
    agg.fallDepthSum += row.fallDepth;
    agg.fallDist[Math.min(row.fallDepth, 13)] += 1;
    agg.maxDepthDist[Math.min(row.maxDepth, 13)] += 1;
    if (row.fallCategory === 'FIGHT') agg.fallByFight += 1;
    else if (row.fallCategory === 'ADVANCE') agg.fallByAdvance += 1;
    else if (row.fallCategory === 'RETURN') agg.fallByReturn += 1;
    if (row.fleeFall) agg.fleeFallFalls += 1;
  }
  if (row.endReason === 'RETURN' && row.returnDepth !== null) {
    agg.returns += 1;
    agg.returnDepthSum += row.returnDepth;
  }
  if (row.endReason === 'FLEE_RETURN') agg.fleeReturns += 1;
  if (row.endReason === 'ERROR') agg.errors += 1;
  agg.netSum += row.net;
  agg.netRedeemedSum += row.netIfRedeemed;
  agg.revenueSum += row.revenue;
  agg.costSum += row.consumesCost;
  agg.ransomSum += row.ransom;
  agg.encounters += row.encounters;
  agg.negAttempts += row.negAttempts;
  agg.negSuccess += row.negSuccess;
  agg.fights += row.fights;
  agg.flees += row.flees;
  agg.eats += row.eats;
  agg.pendingDiscards += row.pendingDiscards;
  agg.adaptEatSum += row.adaptEat;
  agg.adaptFleeSum += row.adaptFlee;
  agg.forcedFightSum += row.forcedFight;
  agg.fleeMaterialSum += row.fleeMaterialCount;
  agg.fleeCostSum += row.fleeCost;
  for (let depth = 1; depth <= 12; depth += 1) {
    if (row.maxDepth >= depth) agg.survival[depth] += 1;
  }
}

const average = (sum, count) => (count > 0 ? sum / count : null);
const pct = (value) => (value === null ? '—' : `${(value * 100).toFixed(2)}%`);
const money = (value) => (value === null ? '—' : value.toFixed(2));

function comboId(combo) {
  const returnLabel = combo.returnSpec.label;
  return `V${combo.level}-${combo.loadout}-S${combo.snacks}-X${combo.eatBelow}-${returnLabel}-${combo.policy}`;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += char.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return width;
}

function pad(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function printTable(headers, rows) {
  const widths = headers.map((_, column) => Math.max(
    displayWidth(headers[column]),
    ...rows.map((row) => displayWidth(row[column])),
  ));
  const line = (cells) => cells.map((cell, column) => pad(cell, widths[column])).join(' | ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const row of rows) console.log(line(row));
}

// ============================================================
// 主流程
// ============================================================
const combos = buildCombinations();
const startedAt = process.hrtime.bigint();
const digest = createHash('sha256');

const results = [];
for (const combo of combos) {
  const agg = newAggregate();
  for (let runIndex = 0; runIndex < cfg.runs; runIndex += 1) {
    const seed = cfg.seed + runIndex;
    const row = simulateOnce(combo, seed);
    aggregateRun(agg, row);
    digest.update(JSON.stringify([
      comboId(combo), runIndex, row.endReason, row.fell ? 1 : 0, row.fallDepth, row.maxDepth,
      row.returnDepth, row.revenue, row.consumesCost, row.net, row.ransom,
      row.encounters, row.negAttempts, row.negSuccess, row.fights, row.flees, row.eats,
      row.pendingDiscards, row.fallCategory, row.fleeFall ? 1 : 0,
      row.adaptEat, row.adaptFlee, row.forcedFight, row.fleeMaterialCount, row.fleeCost,
    ]));
    digest.update('\n');
  }
  results.push({ combo, agg });
}

const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
const digestHex = digest.digest('hex');

if (cfg.digestOnly) {
  console.log(`组合数=${combos.length} 每组趟数=${cfg.runs} 总趟数=${combos.length * cfg.runs}`);
  console.log(`运行时间=${elapsedSeconds.toFixed(2)}s`);
  console.log(`DIGEST=${digestHex}`);
  process.exit(0);
}

const levelLabels = [...new Set(combos.map((combo) => combo.level))].sort((a, b) => a - b);

/** 纯资源点安全深度：无小食、无事件、每层强制资源点；返回仍能成功回店（雅兴 ≥ returnCost）的最深深度 */
function measurePureResourceSafeDepth(level) {
  const state = createInitialState({ seed: cfg.seed });
  applyLevel(state, level);
  state.inventory = {};
  const started = startExplore(state);
  if (!started.ok) throw new Error(`安全深度模拟 startExplore 失败：${started.reason}`);
  let safeDepth = 0;
  for (let step = 0; step < 60 && state.explore; step += 1) {
    const result = settleNode(state, 'RESOURCE');
    if (!result.ok || result.fell) break;
    if (state.explore.pendingPickup) discardPending(state);
    if (state.explore.mood >= returnCost(state)) safeDepth = state.explore.depth;
    else break;
  }
  return safeDepth;
}

const safeDepthText = levelLabels
  .map((level) => `等级${level}=${measurePureResourceSafeDepth(level)}`)
  .join(' / ');

console.log('口径：');
console.log('  - 单趟模拟：每趟从第 1 天开局状态出发，只跑一次采风，不跑营业日。');
console.log(`  - 种子 = ${cfg.seed} + 趟序号；每组 ${cfg.runs} 趟；所有策略共用同一组种子。`);
console.log('  - 净价值 = 战利品 sellItem 收入 − 离手装填物成本（买价）；赎金不计入净价值。');
console.log('    「若赎回净价值」= 净价值 − lostBagRansom()，仅供参考。');
console.log(`  - 倒地趟战利品收入：${cfg.fallIncome === 0 ? '记 0（--fall-income=0）' : '照常计入'}` +
  `；碎片=${cfg.fragments}；蚁工头好感经验=${cfg.antAffinity}；背包满固定 discardPending。`);
console.log(`  - 雅兴等级：${levelLabels.join(' / ')}；装填 L1/L2；小食 2/4 份；吃小食阈值 X=2；`);
console.log('  - 回店策略：EAT_CAP，深度上限固定 D9，余量 m=2/4/6/8（先判深度上限，再按雅兴−returnCost≤m 吃小食，吃不到才回店）。');
console.log('  - 遭遇策略：FIGHT / NEG_SNK1（朴素对照），ADAPT_FIGHT / ADAPT_NEG（自适应：能安全战斗就战斗，否则吃小食，仍不行且能安全返程就逃跑，都不行才硬打）。');
console.log(`  - 战斗费用表（调用 src 导出 fight() 读 result.cost 实测，深度1~12）：${JSON.stringify(FIGHT_COST_BY_DEPTH)}`);
console.log('  - 表 7/8 的目标层：等级0=3~4、等级1=4~5、等级2=5~6、等级3=6、等级4=7~8。');
console.log(`  - 各等级纯资源点安全深度（无小食、无事件、每层强制资源点，能成功回店的最深深度）：${safeDepthText}`);
console.log('');
console.log(`组合数=${combos.length} 每组趟数=${cfg.runs} 总趟数=${combos.length * cfg.runs} 运行时间=${elapsedSeconds.toFixed(2)}s`);
console.log(`DIGEST=${digestHex}`);
console.log('');

// ---------- 表 1：策略汇总 ----------
function summaryRow({ combo, agg }) {
  const fallRate = agg.falls / agg.runs;
  const avgFallDepth = average(agg.fallDepthSum, agg.falls);
  const avgReturnDepth = average(agg.returnDepthSum, agg.returns);
  const avgNet = average(agg.netSum, agg.runs);
  const avgNetRedeemed = average(agg.netRedeemedSum, agg.runs);
  const negRate = avgNegRate(agg);
  return [
    comboId(combo),
    String(combo.level),
    combo.loadout,
    String(combo.snacks),
    String(combo.eatBelow),
    combo.returnSpec.type === 'D' ? '深度'
      : combo.returnSpec.type === 'EAT' ? '续航'
        : combo.returnSpec.type === 'CAP' ? '续航上限' : '边距',
    combo.returnSpec.type === 'CAP'
      ? `D${combo.returnSpec.depth}/m${combo.returnSpec.margin}`
      : combo.returnSpec.value === Infinity ? '∞' : String(combo.returnSpec.value),
    combo.policy,
    pct(fallRate),
    avgFallDepth === null ? '—' : avgFallDepth.toFixed(2),
    avgReturnDepth === null ? '—' : avgReturnDepth.toFixed(2),
    money(avgNet),
    money(avgNetRedeemed),
    (agg.negAttempts / agg.runs).toFixed(2),
    negRate,
    (agg.fights / agg.runs).toFixed(2),
    (agg.flees / agg.runs).toFixed(2),
    (agg.encounters / agg.runs).toFixed(2),
    (agg.eats / agg.runs).toFixed(2),
  ];
}

function avgNegRate(agg) {
  return agg.negAttempts > 0 ? `${((agg.negSuccess / agg.negAttempts) * 100).toFixed(2)}%` : '—';
}

const TABLE1_HEADERS = [
  'ID', '等级', '装填', '食', 'X', '回店类型', '回店值', '遭遇',
  '倒地率', '平均倒地深度', '平均回店深度', '平均净价值', '若赎回净价值',
  '谈判尝试/趟', '谈判成功率', '战斗/趟', '逃跑/趟', '遭遇/趟', '吃/趟',
];

if (cfg.full) {
  console.log('=== 表 1：策略汇总 ===');
  printTable(TABLE1_HEADERS, results.map(summaryRow));
  console.log('');
}

// ---------- 表 2：倒地率 15%~30% ----------
const target = results.filter(({ agg }) => {
  const rate = agg.falls / agg.runs;
  return rate >= 0.15 && rate <= 0.30;
});
if (cfg.full) {
  console.log('=== 表 2：倒地率 15%~30% 的策略组合 ===');
  if (target.length === 0) {
    console.log('（无）');
  } else {
    printTable(TABLE1_HEADERS, target
      .slice()
      .sort((a, b) => (a.agg.falls / a.agg.runs) - (b.agg.falls / b.agg.runs))
      .map(summaryRow));
  }
  console.log('');
}

// ---------- 表 3：生存率曲线 ----------
const survivalHeaders = ['ID', ...Array.from({ length: 12 }, (_, index) => `d${index + 1}`)];
const survivalRows = results.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 12 }, (_, index) => pct(agg.survival[index + 1] / agg.runs)),
]);
if (cfg.full) {
  console.log('=== 表 3：到达各深度的生存率（S(d) = 曾到达深度 ≥ d 的趟数占比） ===');
  printTable(survivalHeaders, survivalRows);
  console.log('');
}

// ---------- 表 4：倒地趟的最大深度分布（表 2 策略） ----------
const depthDistHeaders = ['ID', ...Array.from({ length: 12 }, (_, index) => `第${index + 1}层`), '>12层'];
const maxDepthRows = target.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 13 }, (_, index) => {
    if (agg.falls === 0) return '—';
    return pct(agg.maxDepthDist[index + 1] / agg.falls);
  }),
]);
if (cfg.full) {
  console.log('=== 表 4：倒地趟的最大深度分布（占该策略倒地总趟数的比例；口径同表 3 的 maxDepth） ===');
  if (maxDepthRows.length === 0) {
    console.log('（无）');
  } else {
    printTable(depthDistHeaders, maxDepthRows);
  }
  console.log('');
}

// ---------- 表 5：倒地发生层分布（表 2 策略） ----------
const fallRows = target.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 13 }, (_, index) => {
    if (agg.falls === 0) return '—';
    return pct(agg.fallDist[index + 1] / agg.falls);
  }),
]);
if (cfg.full) {
  console.log('=== 表 5：倒地发生层分布（占该策略倒地总趟数的比例） ===');
  console.log('    注：返程不足时倒地位置 = 深度 − 剩余雅兴，不是最大深度。');
  if (fallRows.length === 0) {
    console.log('（无）');
  } else {
    printTable(depthDistHeaders, fallRows);
  }
  console.log('');
}

// ---------- 表 6：按等级的推荐区间 ----------
if (cfg.full) {
  console.log('=== 表 6：按等级的推荐区间（倒地率 15%~30% 中平均最大深度最大的前 3 行） ===');
  for (const level of levelLabels) {
    const rows = target
      .filter(({ combo }) => combo.level === level)
      .slice()
      .sort((a, b) => (b.agg.maxDepthSum / b.agg.runs) - (a.agg.maxDepthSum / a.agg.runs))
      .slice(0, 3)
      .map(({ combo, agg }) => [
        comboId(combo),
        pct(agg.falls / agg.runs),
        (agg.maxDepthSum / agg.runs).toFixed(2),
        money(agg.netSum / agg.runs),
      ]);
    console.log(`等级 ${level}：`);
    if (rows.length === 0) {
      console.log('（无）');
    } else {
      printTable(['ID', '倒地率', '平均最大深度', '平均净价值'], rows);
    }
  }
  console.log('');
}

// ---------- 表 7：条件倒地率 ----------
function conditionalFallRate(agg, depth) {
  const reached = agg.survival[depth];
  if (reached === 0) return null;
  let fallsAtOrBeyond = 0;
  for (let index = depth; index < agg.maxDepthDist.length; index += 1) {
    fallsAtOrBeyond += agg.maxDepthDist[index];
  }
  return fallsAtOrBeyond / reached;
}

const conditionalHeaders = ['ID', ...Array.from({ length: 12 }, (_, index) => `d${index + 1}`)];
const conditionalRows = results.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 12 }, (_, index) => {
    const rate = conditionalFallRate(agg, index + 1);
    return rate === null ? '—' : pct(rate);
  }),
]);
if (cfg.full) {
  console.log('=== 表 7：条件倒地率 P(最终倒地 | 曾到达第 d 层) ===');
  console.log('    定义：分子 = 最大深度恰为 d 的倒地趟数 + 最大深度大于 d 的倒地趟数（即 maxDepth ≥ d 的倒地趟）；');
  console.log('          分母 = 曾到达第 d 层的趟数（maxDepth ≥ d 的趟数，= 表 3 的 S(d) × 总趟数）。');
  printTable(conditionalHeaders, conditionalRows);
  console.log('');
}

// ---------- 表 9~11：朴素 vs 自适应 ----------
const TARGET_DEPTHS = {
  0: [3, 4],
  1: [4, 5],
  2: [5, 6],
  3: [6],
  4: [7, 8],
};

function targetLayerRate(agg, level) {
  const targets = TARGET_DEPTHS[level] ?? [];
  const rates = targets
    .map((depth) => conditionalFallRate(agg, depth))
    .filter((rate) => rate !== null);
  return rates.length === 0 ? null : rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

function findResult(level, loadout, snacks, margin, policy) {
  return results.find(({ combo }) => combo.level === level
    && combo.loadout === loadout
    && combo.snacks === snacks
    && combo.returnSpec.type === 'CAP' && combo.returnSpec.depth === 9
    && combo.returnSpec.margin === margin
    && combo.policy === policy);
}

function compareMetrics(entry) {
  if (!entry) return ['—', '—', '—', '—'];
  const { agg, combo } = entry;
  return [
    pct(agg.falls / agg.runs),
    pct(targetLayerRate(agg, combo.level)),
    (agg.maxDepthSum / agg.runs).toFixed(2),
    money(agg.netSum / agg.runs),
  ];
}

console.log('=== 表 9：朴素 vs 自适应对比（每行同一 等级/装填/小食/余量） ===');
const t9headers = [
  '等级', '装填', '食', 'm',
  'FIGHT 倒地率', 'FIGHT 目标层条件', 'FIGHT 平均最大深度', 'FIGHT 平均净价值',
  'ADAPT_FIGHT 倒地率', 'ADAPT_FIGHT 目标层条件', 'ADAPT_FIGHT 平均最大深度', 'ADAPT_FIGHT 平均净价值',
  'NEG_SNK1 倒地率', 'NEG_SNK1 目标层条件', 'NEG_SNK1 平均最大深度', 'NEG_SNK1 平均净价值',
  'ADAPT_NEG 倒地率', 'ADAPT_NEG 目标层条件', 'ADAPT_NEG 平均最大深度', 'ADAPT_NEG 平均净价值',
];
const t9rows = [];
for (const level of levelLabels) {
  for (const loadout of ['L1', 'L2']) {
    for (const snacks of [2, 4]) {
      for (const margin of [2, 4, 6, 8]) {
        const row = [String(level), loadout, String(snacks), String(margin)];
        for (const policy of ['FIGHT', 'ADAPT_FIGHT', 'NEG_SNK1', 'ADAPT_NEG']) {
          row.push(...compareMetrics(findResult(level, loadout, snacks, margin, policy)));
        }
        t9rows.push(row);
      }
    }
  }
}
printTable(t9headers, t9rows);
console.log('');

// 代表行：等级 2/3/4、装填 L2、小食 4、余量 4/6/8
function representativeEntries(policy) {
  const list = [];
  for (const level of levelLabels) {
    for (const margin of [4, 6, 8]) {
      const entry = findResult(level, 'L2', 4, margin, policy);
      if (entry) list.push(entry);
    }
  }
  return list;
}

const shareOfFalls = (part, agg) => (agg.falls === 0 ? '—' : pct(part / agg.falls));

console.log('=== 表 10：倒地原因分布（a=战斗付费 / b=节点赶路或采集 / c=返程不足；c 中另记逃跑触发） ===');
const t10headers = ['ID', '倒地率', 'a 战斗付费', 'b 节点', 'c 返程不足', 'c 中逃跑触发'];
const t10rows = [];
for (const policy of ['ADAPT_FIGHT', 'FIGHT']) {
  for (const { combo, agg } of representativeEntries(policy)) {
    const fleeShare = agg.fallByReturn === 0 ? '—' : pct(agg.fleeFallFalls / agg.fallByReturn);
    t10rows.push([
      comboId(combo),
      pct(agg.falls / agg.runs),
      shareOfFalls(agg.fallByFight, agg),
      shareOfFalls(agg.fallByAdvance, agg),
      shareOfFalls(agg.fallByReturn, agg),
      fleeShare,
    ]);
  }
}
printTable(t10headers, t10rows);
console.log('');

console.log('=== 表 11：自适应策略的使用情况（代表行同上） ===');
const t11headers = ['ID', '改吃小食/趟', '改逃跑/趟', '被迫战斗/趟', '逃跑材料件数/趟', '逃跑材料买价/趟'];
const t11rows = [];
for (const policy of ['ADAPT_FIGHT', 'ADAPT_NEG']) {
  for (const { combo, agg } of representativeEntries(policy)) {
    t11rows.push([
      comboId(combo),
      (agg.adaptEatSum / agg.runs).toFixed(2),
      (agg.adaptFleeSum / agg.runs).toFixed(2),
      (agg.forcedFightSum / agg.runs).toFixed(2),
      (agg.fleeMaterialSum / agg.runs).toFixed(2),
      (agg.fleeCostSum / agg.runs).toFixed(2),
    ]);
  }
}
printTable(t11headers, t11rows);
console.log('');

// ---------- 表 8：目标层条件倒地率 ----------
console.log('=== 表 8：目标层条件倒地率（15%~30%，按平均净价值降序，各等级前 5） ===');
console.log('    注：目标层条件倒地率 = 目标深度区间内各层条件倒地率的算术平均（等级3只有一层）。');
for (const level of levelLabels) {
  const targets = TARGET_DEPTHS[level] ?? [];
  const rows = results
    .filter(({ combo }) => combo.level === level)
    .map(({ combo, agg }) => ({ combo, agg, targetRate: targetLayerRate(agg, level) }))
    .filter((entry) => entry.targetRate !== null && entry.targetRate >= 0.15 && entry.targetRate <= 0.30)
    .sort((a, b) => (b.agg.netSum / b.agg.runs) - (a.agg.netSum / a.agg.runs))
    .slice(0, 5)
    .map(({ combo, agg, targetRate }) => [
      comboId(combo),
      `${targets.join('~')}层`,
      pct(targetRate),
      money(agg.netSum / agg.runs),
      pct(agg.falls / agg.runs),
      (agg.maxDepthSum / agg.runs).toFixed(2),
    ]);
  console.log(`等级 ${level}（目标层 ${targets.join('~')}）：`);
  if (rows.length === 0) {
    console.log('（无）');
  } else {
    printTable(['ID', '目标层', '目标层条件倒地率', '平均净价值', '总倒地率', '平均最大深度'], rows);
  }
}
console.log('');

const errors = results.reduce((sum, entry) => sum + entry.agg.errors, 0);
console.log(`校验：总趟数=${combos.length * cfg.runs} 异常趟数=${errors} 运行时间=${elapsedSeconds.toFixed(2)}s`);
