/**
 * tools/sim.js — 营业日策略模拟（纯 Node，无界面）
 *
 * 运行：node tools/sim.js
 *
 * 规则来源：全部通过 src/actions.js 的动作 + src/clock.js 的 tick 推进，
 * 和页面使用同一套规则；本脚本不修改任何规则逻辑文件，也不修改 config.js 文件。
 *
 * 方案对比：config 的对象是普通 JS 对象，这里在内存里临时改值（跑完恢复），
 * 不写磁盘上的 config.js。
 *
 * 成本口径：材料/小食按「被消耗时」的补给箱购买价计入成本（开局库存也按购买价计入，
 * 不免费）；未使用的库存不计。换水费用 = 成功换水次数 × 换水单价。
 * 净收益 = 总收入 − 材料与小食成本 − 换水费用 − 排污税。
 *
 * 平均满意度口径：每位入池客人离场时满意度（怒离记 0，含打烊时仍在池的客人）。
 */

import * as CONFIG from '../config.js';
import { createInitialState, getHeart } from '../src/state.js';
import { tick } from '../src/clock.js';
import { buy, changeWater, closeDay, dropMaterial, dropSnack } from '../src/actions.js';
import { settleBreakdown, tipMultPctFor } from '../src/bath.js';

// ---------- 任务参数（不是游戏规则数值；游戏数值全部从 config 读） ----------
const TASK = {
  seedFrom: 1,
  seedCount: 200,
  // 策略阈值：洁净度 < 60.0（直接取洁癖第一档的下界）
  cleanBelow: CONFIG.COMFORT_TICK.CLEAN_TIERS[0].minClean,
};

const GUEST_SWORDSMAN = 'GUEST_APPRENTICE_SWORDSMAN';
const RACE_UNDEAD = 'UNDEAD';
const RACE_HUMAN = 'HUMAN';
const SNACK_ID = 'SNK_001';

// ---------- config 内存覆盖：先备份，再按方案打补丁 ----------
const ORIGINAL = {
  baseTip: CONFIG.SETTLEMENT.BASE_TIP,
  undeadFavorite: [...CONFIG.RACES.UNDEAD.tempZone.favorite],
  buyPrices: {
    materials: Object.fromEntries(Object.keys(CONFIG.MATERIALS).map((id) => [id, CONFIG.MATERIALS[id].buyPrice])),
    snacks: Object.fromEntries(Object.keys(CONFIG.SNACKS).map((id) => [id, CONFIG.SNACKS[id].buyPrice])),
  },
};

function restoreConfig() {
  CONFIG.SETTLEMENT.BASE_TIP = ORIGINAL.baseTip;

  const favorite = CONFIG.RACES.UNDEAD.tempZone.favorite;
  favorite[0] = ORIGINAL.undeadFavorite[0];
  favorite[1] = ORIGINAL.undeadFavorite[1];

  for (const [id, price] of Object.entries(ORIGINAL.buyPrices.materials)) {
    CONFIG.MATERIALS[id].buyPrice = price;
  }
  for (const [id, price] of Object.entries(ORIGINAL.buyPrices.snacks)) {
    CONFIG.SNACKS[id].buyPrice = price;
  }
}

// 先确认 config 对象可写；如果不可写，直接说明并退出（不去改 config.js 文件）
try {
  const before = CONFIG.SETTLEMENT.BASE_TIP;
  CONFIG.SETTLEMENT.BASE_TIP = before;
} catch (error) {
  console.error('config 对象是只读的，无法在内存里覆盖数值。');
  console.error('需要你决定：要么允许我在 config.js 里加一个运行时可覆盖的入口，要么用别的方案。');
  process.exit(1);
}

// ---------- 四个方案 ----------
// 方案里的 60 / 5 / 20 / 50% 是任务给定的方案参数，不是游戏规则的默认值。
const SCENARIOS = [
  {
    name: '方案 0 · 当前规则',
    patch: () => {},
  },
  {
    name: '方案 1 · BASE_TIP 30 → 60',
    patch: () => {
      CONFIG.SETTLEMENT.BASE_TIP = 60;
    },
  },
  {
    name: '方案 2 · 方案1 + 亡灵喜爱区 15~25℃ → 5~20℃',
    patch: () => {
      CONFIG.SETTLEMENT.BASE_TIP = 60;
      const favorite = CONFIG.RACES.UNDEAD.tempZone.favorite;
      favorite[0] = 50;  // 5.0℃
      favorite[1] = 200; // 20.0℃
    },
  },
  {
    name: '方案 3 · 方案0 + 补给箱购买价 ×50%',
    patch: () => {
      for (const id of Object.keys(CONFIG.MATERIALS)) {
        CONFIG.MATERIALS[id].buyPrice = Math.round((CONFIG.MATERIALS[id].buyPrice * 50) / 100);
      }
      for (const id of Object.keys(CONFIG.SNACKS)) {
        CONFIG.SNACKS[id].buyPrice = Math.round((CONFIG.SNACKS[id].buyPrice * 50) / 100);
      }
    },
  },
];

// ---------- 小工具 ----------
function firstFreeSlot(state) {
  const index = state.slots.indexOf(null);
  return index < 0 ? 0 : index + 1;
}

/** 该材料/小食在托盘/池水里的「词条」是否仍在生效 */
function buffActive(state, itemId) {
  return Boolean(state.pool.buffs[itemId]);
}

/** 库存不足时按当前补给箱价格买 1 件；买不起返回 false */
function ensureItem(state, itemId) {
  if ((state.inventory[itemId] ?? 0) > 0) return true;
  return buy(state, itemId).ok;
}

function tryDropMaterial(state, run, itemId) {
  const slot = firstFreeSlot(state);
  if (!slot) return false;
  if (!ensureItem(state, itemId)) return false;

  const result = dropMaterial(state, slot, itemId);
  if (!result.ok) return false;

  run.materialCost += CONFIG.MATERIALS[itemId].buyPrice;
  run.consumption[itemId] += 1;
  return true;
}

function tryServeSnack(state, run, guestId) {
  if (!ensureItem(state, SNACK_ID)) return false;

  const result = dropSnack(state, guestId);
  if (!result.ok) return false;

  run.snackCost += CONFIG.SNACKS[SNACK_ID].buyPrice;
  run.consumption[SNACK_ID] += 1;
  return true;
}

function applyWaterRule(state, run) {
  if (state.pool.clean < TASK.cleanBelow && !state.waterChange) {
    const result = changeWater(state);
    if (result.ok) run.waterChanges += 1;
  }
}

// ---------- 三种策略 ----------
function policyA() {
  // 完全不操作
}

function policyB(state, run) {
  // B1：池内有见习剑士、水温低于人族耐受区下界、有空槽、MAT_002 词条未生效 → 投 1 份 MAT_002
  const hasHuman = state.seats.some((guest) => guest && guest.guestId === GUEST_SWORDSMAN);
  if (
    hasHuman
    && state.pool.temp < CONFIG.RACES.HUMAN.tempZone.tolerant[0]
    && !buffActive(state, 'MAT_002')
  ) {
    tryDropMaterial(state, run, 'MAT_002');
  }

  // B2：洁净度 < 60.0 且没在换水 → 换水
  applyWaterRule(state, run);
}

function policyC(state, run) {
  const seated = state.seats.filter(Boolean);
  const hasHuman = seated.some((guest) => guest.guestId === GUEST_SWORDSMAN);
  const hasUndead = seated.some((guest) => guest.race === RACE_UNDEAD);
  const allUndead = seated.length > 0 && seated.every((guest) => guest.race === RACE_UNDEAD);

  // C1：有见习剑士、池内无亡灵、水温低于人族耐受区下界、MAT_002 未生效 → MAT_002
  if (
    hasHuman
    && !hasUndead
    && state.pool.temp < CONFIG.RACES.HUMAN.tempZone.tolerant[0]
    && !buffActive(state, 'MAT_002')
  ) {
    tryDropMaterial(state, run, 'MAT_002');
  }

  // C2：池内只有亡灵、水温高于亡灵喜爱区上界、MAT_001 未生效 → MAT_001
  if (
    allUndead
    && state.pool.temp > CONFIG.RACES.UNDEAD.tempZone.favorite[1]
    && !buffActive(state, 'MAT_001')
  ) {
    tryDropMaterial(state, run, 'MAT_001');
  }

  // C3：池内两位亡灵、MAT_003 未生效 → MAT_003
  if (
    allUndead
    && seated.length === CONFIG.POOL.SEATS
    && !buffActive(state, 'MAT_003')
  ) {
    tryDropMaterial(state, run, 'MAT_003');
  }

  // C4：有客人点单且托盘为空 → SNK_001
  if (state.tray.length === 0) {
    const orderer = state.seats.find((guest) => guest && guest.orderOpen);
    if (orderer) tryServeSnack(state, run, orderer.guestId);
  }

  // C5：洁净度 < 60.0 且没在换水 → 换水
  applyWaterRule(state, run);
}

const STRATEGIES = [
  { key: 'A', label: 'A 完全不操作', policy: policyA },
  { key: 'B', label: 'B 简单规则', policy: policyB },
  { key: 'C', label: 'C 较优规则', policy: policyC },
];

// ---------- 跑一个种子的一天 ----------
function runDay(seed, policy) {
  const state = createInitialState({ seed });
  const run = {
    materialCost: 0,
    snackCost: 0,
    waterChanges: 0,
    angry: 0,
    comfortSum: 0,
    comfortCount: 0,
    consumption: Object.fromEntries(
      [...Object.keys(CONFIG.MATERIALS), SNACK_ID].map((id) => [id, 0]),
    ),
    race: Object.fromEntries(
      Object.keys(CONFIG.RACES).map((race) => [race, { visits: 0, angry: 0, ticketTip: 0, snack: 0 }]),
    ),
  };

  for (let second = 0; second < CONFIG.TIME.BUSINESS_DAY_SECONDS; second += 1) {
    policy(state, run);
    const events = tick(state);

    for (const event of events) {
      if (event.type === 'guestAngryLeft') {
        run.angry += 1;
        run.comfortCount += 1; // 怒离记 0 分
        const bucket = run.race[CONFIG.GUESTS[event.guestId].race];
        bucket.visits += 1;
        bucket.angry += 1;
        bucket.ticketTip += event.gold;
      } else if (event.type === 'guestLeft') {
        run.comfortSum += event.comfort;
        run.comfortCount += 1;
        const bucket = run.race[CONFIG.GUESTS[event.guestId].race];
        bucket.visits += 1;
        bucket.ticketTip += event.gold;
      } else if (event.type === 'snackEaten') {
        run.race[CONFIG.GUESTS[event.guestId].race].snack += event.gold;
      }
    }
  }

  // 打烊时还在池里的客人：先记录满意度/预计收入，再交给 closeDay 正常结算
  for (const guest of state.seats) {
    if (!guest) continue;
    run.comfortSum += guest.comfort;
    run.comfortCount += 1;

    const faction = CONFIG.RACES[guest.race].faction;
    const heart = getHeart(state.affectionExp[guest.guestId] ?? 0);
    const repMultPct = state.reputation[faction] >= CONFIG.REPUTATION.TICKET_BONUS_THRESHOLD
      ? CONFIG.SETTLEMENT.REP_MULT_PCT
      : CONFIG.SETTLEMENT.REP_MULT_DEFAULT_PCT;
    const breakdown = settleBreakdown({
      comfort: guest.comfort,
      heart,
      repMultPct,
      tipMultPct: tipMultPctFor(state.pool, guest.race),
    });

    const bucket = run.race[guest.race];
    bucket.visits += 1;
    bucket.ticketTip += breakdown.ticketGold + breakdown.tipGold;
  }

  const closeResult = closeDay(state);
  if (!closeResult.ok) throw new Error(`closeDay 失败：${closeResult.reason}`);
  const report = closeResult.report;

  // 口径自检：按种族汇总的收入应与日报总收入一致
  let attributed = 0;
  for (const bucket of Object.values(run.race)) attributed += bucket.ticketTip + bucket.snack;
  if (attributed !== report.totalIncome) {
    throw new Error(`按种族拆分与日报不一致：${attributed} vs ${report.totalIncome}`);
  }

  const materialAndSnackCost = run.materialCost + run.snackCost;
  const waterCost = run.waterChanges * CONFIG.POOL.CHANGE_WATER_COST_GOLD;
  const net = report.totalIncome - materialAndSnackCost - waterCost - report.tax;

  return {
    seed,
    guests: report.guests,
    angry: run.angry,
    ticketIncome: report.ticketIncome,
    tipIncome: report.tipIncome,
    snackIncome: report.snackIncome,
    totalIncome: report.totalIncome,
    materialAndSnackCost,
    waterCost,
    tax: report.tax,
    net,
    avgComfort: run.comfortCount > 0
      ? run.comfortSum / run.comfortCount / CONFIG.UNITS.COMFORT_PER_POINT
      : 0,
    endClean: state.pool.clean / CONFIG.UNITS.CLEAN_PER_POINT,
    waterChanges: run.waterChanges,
    consumption: run.consumption,
    race: run.race,
  };
}

// ---------- 汇总与打印 ----------
const average = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += char.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return width;
}

function pad(text, width) {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`;
}

function printTable(rows) {
  const headers = [
    '策略', '接待人数', '怒离人数', '门票收入', '小费收入', '小食收入', '总收入',
    '材料与小食成本', '换水费用', '排污税', '净收益', '平均满意度', '日末洁净度', '换水次数',
  ];
  const body = rows.map((row) => [
    row.label,
    row.avg.guests.toFixed(2),
    row.avg.angry.toFixed(2),
    row.avg.ticketIncome.toFixed(2),
    row.avg.tipIncome.toFixed(2),
    row.avg.snackIncome.toFixed(2),
    row.avg.totalIncome.toFixed(2),
    row.avg.materialAndSnackCost.toFixed(2),
    row.avg.waterCost.toFixed(2),
    row.avg.tax.toFixed(2),
    row.avg.net.toFixed(2),
    row.avg.avgComfort.toFixed(2),
    row.avg.endClean.toFixed(2),
    row.avg.waterChanges.toFixed(2),
  ]);

  const all = [headers, ...body];
  const widths = headers.map((_, column) => Math.max(...all.map((line) => displayWidth(line[column]))));
  const line = (cells) => cells.map((cell, column) => pad(cell, widths[column])).join(' | ');

  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
  for (const cells of body) console.log(line(cells));
}

function diffSummary(rowsA, rowsB) {
  const diffs = rowsB.map((row, index) => row.net - rowsA[index].net);
  const mean = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  return { mean, min: Math.min(...diffs), max: Math.max(...diffs) };
}

function raceSummary(results) {
  const output = {};
  for (const race of Object.keys(CONFIG.RACES)) {
    let visits = 0;
    let angry = 0;
    let ticketTip = 0;
    let snack = 0;
    for (const result of results) {
      const bucket = result.race[race];
      visits += bucket.visits;
      angry += bucket.angry;
      ticketTip += bucket.ticketTip;
      snack += bucket.snack;
    }
    output[race] = {
      avgIncome: visits > 0 ? (ticketTip + snack) / visits : 0,
      angryRate: visits > 0 ? (angry / visits) * CONFIG.UNITS.PERCENT : 0,
    };
  }
  return output;
}

function consumptionSummary(results) {
  const ids = [...Object.keys(CONFIG.MATERIALS), SNACK_ID];
  const output = {};
  for (const id of ids) {
    let total = 0;
    for (const result of results) total += result.consumption[id];
    output[id] = total / results.length;
  }
  return output;
}

function raceLabel(race) {
  return CONFIG.RACES[race].name.split('（')[0];
}

// ---------- 主流程 ----------
const runs = [];

for (const scenario of SCENARIOS) {
  restoreConfig();
  scenario.patch();

  const perStrategy = STRATEGIES.map(() => []);
  for (let index = 0; index < STRATEGIES.length; index += 1) {
    for (let offset = 0; offset < TASK.seedCount; offset += 1) {
      const seed = TASK.seedFrom + offset;
      perStrategy[index].push(runDay(seed, STRATEGIES[index].policy));
    }
  }
  runs.push(perStrategy);
}

restoreConfig();

console.log('\n口径：');
console.log('  - 种子 1~200，每个种子跑 1 个营业日（480 秒），每次从第 1 天开局状态开始。');
console.log('  - 成本：材料/小食按补给箱购买价、按被消耗时计入；开局库存按购买价计入，不免费；未使用的库存不计。');
console.log('  - 换水费用 = 成功换水次数 × ' + CONFIG.POOL.CHANGE_WATER_COST_GOLD + 'G。');
console.log('  - 净收益 = 总收入 − 材料与小食成本 − 换水费用 − 排污税。');
console.log('  - 平均满意度 = 每位入池客人离场时的满意度（怒离记 0，含打烊时仍在池的客人）。');
console.log('  - 同一种材料/小食的词条生效期间不重复投；买不起时跳过本秒动作。');
console.log('  - 方案 3 的购买价按 ×50% 后四舍五入到整数 G（15→8、20→10、35→18、5→3）。');
console.log('  - config 覆盖只在内存里发生，脚本结束前恢复原值，不修改 config.js 文件。');

for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex += 1) {
  const scenario = SCENARIOS[scenarioIndex];
  const perStrategy = runs[scenarioIndex];

  console.log(`\n=== ${scenario.name} · 200 个种子平均 ===`);
  const rows = perStrategy.map((results, strategyIndex) => ({
    label: STRATEGIES[strategyIndex].label,
    avg: {
      guests: average(results, 'guests'),
      angry: average(results, 'angry'),
      ticketIncome: average(results, 'ticketIncome'),
      tipIncome: average(results, 'tipIncome'),
      snackIncome: average(results, 'snackIncome'),
      totalIncome: average(results, 'totalIncome'),
      materialAndSnackCost: average(results, 'materialAndSnackCost'),
      waterCost: average(results, 'waterCost'),
      tax: average(results, 'tax'),
      net: average(results, 'net'),
      avgComfort: average(results, 'avgComfort'),
      endClean: average(results, 'endClean'),
      waterChanges: average(results, 'waterChanges'),
    },
  }));
  printTable(rows);

  // 按种族拆分 + 材料/小食平均消耗
  console.log('--- 按种族拆分（平均每位客人收入 = 门票+小费+小食；怒离率）与平均消耗 ---');
  for (let strategyIndex = 0; strategyIndex < STRATEGIES.length; strategyIndex += 1) {
    const results = perStrategy[strategyIndex];
    const races = raceSummary(results);
    const consumption = consumptionSummary(results);

    const raceText = Object.keys(CONFIG.RACES)
      .map((race) => `${raceLabel(race)}：${races[race].avgIncome.toFixed(2)}G/人、怒离 ${races[race].angryRate.toFixed(2)}%`)
      .join(' ｜ ');

    const consumptionText = Object.keys(consumption)
      .map((id) => `${id} ${consumption[id].toFixed(2)}`)
      .join('，');

    console.log(`${STRATEGIES[strategyIndex].label}：${raceText} ｜ 消耗 ${consumptionText}`);
  }

  const bMinusA = diffSummary(perStrategy[0], perStrategy[1]);
  const cMinusA = diffSummary(perStrategy[0], perStrategy[2]);
  console.log(`B−A 净收益：平均 ${bMinusA.mean.toFixed(2)}，最小 ${bMinusA.min.toFixed(2)}，最大 ${bMinusA.max.toFixed(2)}`);
  console.log(`C−A 净收益：平均 ${cMinusA.mean.toFixed(2)}，最小 ${cMinusA.min.toFixed(2)}，最大 ${cMinusA.max.toFixed(2)}`);
}

console.log('\n=== 方案汇总：平均净收益（200 个种子） ===');
const summaryHeaders = ['方案', 'A', 'B', 'C', 'B−A', 'C−A'];
const summaryRows = SCENARIOS.map((scenario, scenarioIndex) => {
  const perStrategy = runs[scenarioIndex];
  const a = average(perStrategy[0], 'net');
  const b = average(perStrategy[1], 'net');
  const c = average(perStrategy[2], 'net');
  const bMinusA = diffSummary(perStrategy[0], perStrategy[1]).mean;
  const cMinusA = diffSummary(perStrategy[0], perStrategy[2]).mean;
  return [
    scenario.name,
    a.toFixed(2),
    b.toFixed(2),
    c.toFixed(2),
    bMinusA.toFixed(2),
    cMinusA.toFixed(2),
  ];
});
const summaryAll = [summaryHeaders, ...summaryRows];
const summaryWidths = summaryHeaders.map((_, column) => Math.max(...summaryAll.map((line) => displayWidth(line[column]))));
const summaryLine = (cells) => cells.map((cell, column) => pad(cell, summaryWidths[column])).join(' | ');
console.log(summaryLine(summaryHeaders));
console.log(summaryWidths.map((width) => '-'.repeat(width)).join('-+-'));
for (const cells of summaryRows) console.log(summaryLine(cells));
