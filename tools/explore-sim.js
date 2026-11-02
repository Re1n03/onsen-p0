/**
 * tools/explore-sim.js — 采风收益/风险模拟（纯 Node，无界面）
 *
 * 运行：node tools/explore-sim.js
 *
 * 规则来源：通过 src/explore.js 的公开入口（startExplore / advance /
 * resolveEncounter / returnHome / discardPending / splitLostItems）真实运行，
 * 与页面将来使用同一套规则；本脚本不修改任何规则代码，也不改 config.js。
 *
 * 只模拟一次采风，不模拟营业日。种子 1~500，开局 A 碎片 0 张 / B 碎片 3 张。
 */

import {
  ENCOUNTERS,
  EXPLORE,
  ITEM_VALUES,
  MATERIALS,
} from '../config.js';
import { createInitialState, getHeart } from '../src/state.js';
import {
  advance,
  discardPending,
  resolveEncounter,
  returnHome,
  splitLostItems,
  startExplore,
} from '../src/explore.js';
import { goblinRatePermille, ransomGold } from '../src/lostfound.js';

const TASK = {
  seedFrom: 1,
  seedCount: 500,
};

const MATERIAL_IDS = new Set(Object.keys(MATERIALS));
const ENCOUNTER_PRIORITY = {
  ANTHILL_FOREMAN: ['FEED', 'ESCAPE', 'TALK', 'VOUCHER'],
  PALADIN_APPRENTICE: ['FEED', 'ESCAPE', 'TALK', 'VOUCHER'],
};

// ---------- 推进策略 ----------
function marginAfterAdvance(state) {
  const explore = state.explore;
  const nextMood = explore.mood - EXPLORE.MOOD_COST_PER_NODE;
  const nextDepth = explore.depth + EXPLORE.DEPTH_PER_NODE;
  return nextMood - nextDepth;
}

const STRATEGIES = [
  ...([0, 1, 2, 3].map((m) => ({
    key: `m${m}`,
    label: `安全边距 m=${m}`,
    shouldReturn: (state) => marginAfterAdvance(state) < m,
  }))),
  ...([2, 3, 4, 5, 6].map((depth) => ({
    key: `d${depth}`,
    label: `固定深度 d=${depth}`,
    shouldReturn: (state) => state.explore.depth >= depth,
  }))),
];

const OPENINGS = [
  { key: 'A', label: '开局 A：碎片 0', fragments: 0 },
  { key: 'B', label: '开局 B：碎片 3', fragments: 3 },
];

// ---------- 小工具 ----------
function cloneBackpack(backpack) {
  return backpack.map((slot) => ({ itemId: slot.itemId, count: slot.count }));
}

function backpackValue(backpack) {
  return backpack.reduce((sum, slot) => sum + (ITEM_VALUES[slot.itemId] ?? 0) * slot.count, 0);
}

function inventoryValue(inventory) {
  return Object.entries(inventory).reduce(
    (sum, [itemId, count]) => sum + (ITEM_VALUES[itemId] ?? 0) * count,
    0,
  );
}

function sumPieces(items) {
  return items.reduce((sum, slot) => sum + slot.count, 0);
}

/** splitLostItems 返回的是单件列表（{itemId, value}），这里合并回 {itemId, count} */
function aggregateItems(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + 1);
  return [...counts.entries()].map(([itemId, count]) => ({ itemId, count }));
}

function optionAvailable(state, encounterId, optionId) {
  const option = ENCOUNTERS[encounterId]?.options?.[optionId];
  if (!option) return false;
  if (state.explore.encounterTried?.[optionId]) return false;

  const requires = option.requires ?? {};
  if (requires.item && (state.inventory[requires.item] ?? 0) < requires.count) return false;
  if (requires.voucher && state.vouchers < requires.voucher) return false;
  if (requires.fragment && state.fragments < requires.fragment) return false;
  if (requires.affinityHeart) {
    const { npc, min } = requires.affinityHeart;
    if (getHeart(state.affectionExp[npc] ?? 0) < min) return false;
  }
  return true;
}

/**
 * 处理当前待处理遭遇：按优先级尝试可用选项；失败则继续下一个；
 * 全部不可用 / 全部尝试过 → 返回 'UNRESOLVED'（外层再决定回店/倒地）。
 * @returns {'DONE'|'FALL'|'UNRESOLVED'}
 */
function resolvePendingEncounter(state, tracker) {
  const encounterId = state.explore.pendingEncounter;
  const priority = ENCOUNTER_PRIORITY[encounterId];
  const attempted = new Set();

  while (state.explore && state.explore.pendingEncounter) {
    const optionId = priority.find(
      (id) => !attempted.has(id) && optionAvailable(state, encounterId, id),
    );
    if (!optionId) return 'UNRESOLVED';

    attempted.add(optionId);
    const beforeValue = inventoryValue(state.inventory);
    const result = resolveEncounter(state, optionId);
    tracker.consumedValue += Math.max(0, beforeValue - inventoryValue(state.inventory));

    if (result.fell) {
      tracker.fall = result.fall;
      return 'FALL';
    }
    if (result.needSwap) discardPending(state);
    if (result.encounterEnded) return 'DONE';
    // 失败、遭遇仍在：继续尝试下一个可用选项
  }
  return 'DONE';
}

// ---------- 跑一个种子的一次采风 ----------
function simulateOnce(seed, fragments, strategy) {
  const state = createInitialState({ seed });
  state.fragments = fragments;
  startExplore(state);

  const tracker = { consumedValue: 0, fall: null };
  let lastBackpack = cloneBackpack(state.explore.backpack);

  while (state.explore) {
    if (strategy.shouldReturn(state)) break;

    lastBackpack = cloneBackpack(state.explore.backpack);
    const result = advance(state);

    if (result.fell) {
      tracker.fall = result.fall;
      break;
    }
    if (result.needSwap) discardPending(state);

    if (result.nodeType === 'ENCOUNTER') {
      const outcome = resolvePendingEncounter(state, tracker);
      if (outcome === 'FALL') break;
      if (outcome === 'UNRESOLVED') break; // 外层回店，可能倒地
    }
  }

  let brought = [];
  let lostValue = 0;
  let depth = 0;
  let fell = false;

  if (state.explore) {
    depth = state.explore.depth;
    const backpackBefore = cloneBackpack(state.explore.backpack);
    const result = returnHome(state);
    if (result.fell) {
      fell = true;
      lostValue = result.fall.lostBag.totalValue;
      brought = aggregateItems(splitLostItems(backpackBefore).kept);
    } else {
      brought = backpackBefore;
    }
  } else if (tracker.fall) {
    fell = true;
    depth = tracker.fall.depth;
    lostValue = tracker.fall.lostBag.totalValue;
    brought = aggregateItems(splitLostItems(lastBackpack).kept);
  } else {
    depth = 0;
  }

  const materialPieces = brought
    .filter((slot) => MATERIAL_IDS.has(slot.itemId))
    .reduce((sum, slot) => sum + slot.count, 0);
  const rarePieces = sumPieces(brought) - materialPieces;
  const broughtValue = backpackValue(brought);
  const net = broughtValue - tracker.consumedValue;
  const ransom = fell ? ransomGold(lostValue, goblinRatePermille(1)) : 0;

  return {
    fell,
    depth,
    broughtPieces: sumPieces(brought),
    materialPieces,
    rarePieces,
    broughtValue,
    consumedValue: tracker.consumedValue,
    lostValue,
    net,
    ransom,
    netAfterRansom: net - ransom,
  };
}

// ---------- 汇总 ----------
const average = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
const ratio = (rows, predicate) => rows.filter(predicate).length / rows.length;

function runStrategy(seedCount, fragments, strategy) {
  const rows = [];
  for (let offset = 0; offset < seedCount; offset += 1) {
    rows.push(simulateOnce(TASK.seedFrom + offset, fragments, strategy));
  }
  return rows;
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

console.log('口径：');
console.log('  - 种子 1~500，每次从第 1 天开局状态开始，只跑一次采风，不跑营业日。');
console.log('  - 开局 A：心事碎片 0 张；开局 B：3 张；不吃小食。');
console.log('  - 遭遇按给定优先级尝试，每个选项每场遭遇只尝试一次；失败后换下一优先项。');
console.log('  - 带回物品 = 背包最终保留/并入库存的物品（不含开局库存）；消耗品估值按 ITEM_VALUES。');
console.log('  - 体验券与心事碎片在 ITEM_VALUES 里没有估值，按 0 计（只消耗不记价值）。');
console.log('  - 背包满溢（NEED_SWAP）时直接放弃新物品（不换格），不计入带回。');
console.log('  - 倒地赎金按「地精 100%」、第 1 天 N=1 的 1000‰ 计算，= 丢失估值。');
console.log('  - 净库存价值变化 = 带回物品估值 − 遭遇消耗品估值。');

const all = [];
for (const opening of OPENINGS) {
  console.log(`\n=== ${opening.label} · ${TASK.seedCount} 个种子平均 ===`);
  const rows = STRATEGIES.map((strategy) => {
    const results = runStrategy(TASK.seedCount, opening.fragments, strategy);
    all.push({ opening, strategy, results });
    return [
      strategy.label,
      `${(ratio(results, (r) => r.fell) * 100).toFixed(2)}%`,
      `${(ratio(results, (r) => !r.fell) * 100).toFixed(2)}%`,
      average(results, 'depth').toFixed(2),
      average(results, 'broughtPieces').toFixed(2),
      average(results, 'materialPieces').toFixed(2),
      average(results, 'rarePieces').toFixed(2),
      average(results, 'broughtValue').toFixed(2),
      average(results, 'consumedValue').toFixed(2),
      average(results, 'lostValue').toFixed(2),
      average(results, 'net').toFixed(2),
      `${(ratio(results, (r) => r.materialPieces >= 8) * 100).toFixed(2)}%`,
      average(results, 'ransom').toFixed(2),
      average(results, 'netAfterRansom').toFixed(2),
    ];
  });

  printTable(
    ['策略', '倒地率', '回店成功率', '平均步数', '带回总件数', '材料件数', '稀有件数',
      '带回估值', '遭遇消耗估值', '倒地丢失估值', '净库存变化', '材料≥8比例', '赎金合计', '净−赎金'],
    rows,
  );
}

console.log('\n=== 汇总：各策略（A/B 开局并排） ===');
const summaryRows = STRATEGIES.map((strategy) => {
  const cells = [strategy.label];
  for (const opening of OPENINGS) {
    const entry = all.find((item) => item.opening.key === opening.key && item.strategy.key === strategy.key);
    const results = entry.results;
    cells.push(`${(ratio(results, (r) => r.fell) * 100).toFixed(2)}%`);
    cells.push(average(results, 'net').toFixed(2));
    cells.push(Math.min(...results.map((r) => r.net)).toFixed(2));
    cells.push(`${(ratio(results, (r) => r.materialPieces >= 8) * 100).toFixed(2)}%`);
  }
  return cells;
});

printTable(
  ['策略', 'A 倒地率', 'A 净均值', 'A 净最小', 'A 材料≥8', 'B 倒地率', 'B 净均值', 'B 净最小', 'B 材料≥8'],
  summaryRows,
);
