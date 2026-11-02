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
  throw new Error(`无法解析回店策略：${text}`);
}

function buildCombinations() {
  const explicit = cfg.loadout !== null || cfg.snacks !== null || cfg.eatBelow !== null
    || cfg.returnSpec !== null || cfg.policy !== null;

  const levels = cfg.level === 'grid' ? [0, 1, 2, 3, 4] : [Number(cfg.level)];
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
  const returnSpecs = [
    { type: 'm', value: 4, label: 'm4' },   // 对照组：不吃小食
    { type: 'EAT', value: 2, label: 'E2' }, // 续航型 m2
    { type: 'EAT', value: 4, label: 'E4' }, // 续航型 m4
    { type: 'D', value: 5, label: 'D5' },   // 固定深度对照
  ];
  for (const level of levels) {
    for (const loadout of ['L1']) {
      for (const snacks of [0, 2, 4]) {
        for (const eatBelow of [2]) {
          for (const returnSpec of returnSpecs) {
            for (const policy of ['NEG_SNK1', 'FIGHT']) {
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
  state.gold = 1_000_000; // 仅用于支付升级费，升级后立即还原
  for (let index = 0; index < level; index += 1) {
    const result = upgradeMood(state);
    if (!result.ok) throw new Error(`upgradeMood 失败：${result.reason}`);
  }
  state.gold = startingGold;
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
    fallDepth: 0,
    maxDepth: 0,
    returnDepth: null,
    fleeDepth: null,
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
    const want = policy === 'NEG_SNK1' ? 1 : 3;
    const available = state.explore.lunchbox.SNK_001 ?? 0;
    const count = Math.min(want, available);
    return Array(count).fill('SNK_001');
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
      tracker.consumesCost += MATERIALS[materialId].buyPrice;
      if (result.fell) {
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
    const marginReached = () => Boolean(state.explore)
      && state.explore.mood - returnCost(state) <= combo.returnSpec.value;

    let shouldReturn;
    if (combo.returnSpec.type === 'EAT') {
      // 续航型：先按边距条件吃小食，吃到安全为止；没小食了才回店
      let guard = 0;
      while (marginReached() && (state.explore.lunchbox.SNK_001 ?? 0) > 0 && guard < 30) {
        const eaten = eat(state);
        if (!eaten.ok) break;
        tracker.eats += 1;
        consumeSnack();
        guard += 1;
      }
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
      row.pendingDiscards,
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
console.log(`  - 雅兴等级：${levelLabels.join(' / ')}；装填只用 L1；小食 0/2/4 份；吃小食阈值 X=2；`);
console.log('  - 回店策略：m4 = 边距（不吃小食对照组）；E2/E4 = 续航型 EAT_MARGIN（先按边距吃小食，吃不到才回店）；D5 = 固定深度对照。');
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
    combo.returnSpec.type === 'D' ? '深度' : combo.returnSpec.type === 'EAT' ? '续航' : '边距',
    combo.returnSpec.value === Infinity ? '∞' : String(combo.returnSpec.value),
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

console.log('=== 表 1：策略汇总 ===');
printTable(TABLE1_HEADERS, results.map(summaryRow));
console.log('');

// ---------- 表 2：倒地率 15%~30% ----------
const target = results.filter(({ agg }) => {
  const rate = agg.falls / agg.runs;
  return rate >= 0.15 && rate <= 0.30;
});
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

// ---------- 表 3：生存率曲线 ----------
const survivalHeaders = ['ID', ...Array.from({ length: 12 }, (_, index) => `d${index + 1}`)];
const survivalRows = results.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 12 }, (_, index) => pct(agg.survival[index + 1] / agg.runs)),
]);
console.log('=== 表 3：到达各深度的生存率（S(d) = 曾到达深度 ≥ d 的趟数占比） ===');
printTable(survivalHeaders, survivalRows);
console.log('');

// ---------- 表 4：倒地趟的最大深度分布（表 2 策略） ----------
const depthDistHeaders = ['ID', ...Array.from({ length: 12 }, (_, index) => `第${index + 1}层`), '>12层'];
const maxDepthRows = target.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 13 }, (_, index) => {
    if (agg.falls === 0) return '—';
    return pct(agg.maxDepthDist[index + 1] / agg.falls);
  }),
]);
console.log('=== 表 4：倒地趟的最大深度分布（占该策略倒地总趟数的比例；口径同表 3 的 maxDepth） ===');
if (maxDepthRows.length === 0) {
  console.log('（无）');
} else {
  printTable(depthDistHeaders, maxDepthRows);
}
console.log('');

// ---------- 表 5：倒地发生层分布（表 2 策略） ----------
const fallRows = target.map(({ combo, agg }) => [
  comboId(combo),
  ...Array.from({ length: 13 }, (_, index) => {
    if (agg.falls === 0) return '—';
    return pct(agg.fallDist[index + 1] / agg.falls);
  }),
]);
console.log('=== 表 5：倒地发生层分布（占该策略倒地总趟数的比例） ===');
console.log('    注：返程不足时倒地位置 = 深度 − 剩余雅兴，不是最大深度。');
if (fallRows.length === 0) {
  console.log('（无）');
} else {
  printTable(depthDistHeaders, fallRows);
}
console.log('');

// ---------- 表 6：按等级的推荐区间 ----------
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

const errors = results.reduce((sum, entry) => sum + entry.agg.errors, 0);
console.log(`校验：总趟数=${combos.length * cfg.runs} 异常趟数=${errors} 运行时间=${elapsedSeconds.toFixed(2)}s`);
