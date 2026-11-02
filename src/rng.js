/**
 * rng.js — 可设置种子的随机数生成器（mulberry32）
 *
 * 规则：
 *  - 不读写 DOM；
 *  - 同一个种子 → 完全相同的随机序列，测试可以复现；
 *  - 后续所有随机（到客、采风节点、遭遇、失物包）都从 createRng(seed) 取。
 */

import { UNITS } from '../config.js';

const UINT32_RANGE = 4294967296; // 2^32：把 uint32 归一化到 [0,1) 的算法常数

/**
 * @param {number} seed 任意整数种子；0 会被替换为 1，避免退化序列
 * @returns {{
 *   getSeed: () => number,
 *   nextUint32: () => number,
 *   next: () => number,
 *   nextInt: (minInclusive: number, maxInclusive: number) => number,
 *   chancePercent: (pct: number) => boolean,
 *   pick: <T>(items: T[]) => T,
 *   pickWeighted: <T>(items: T[], weightOf: (item: T) => number) => T
 * }}
 */
export function createRng(seed = 1) {
  let state = (seed >>> 0) || 1;

  function nextUint32() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  // [0, 1) 的浮点只用于“把 32 位整数映射成区间里的整数”，不再往下传播
  function next() {
    return nextUint32() / UINT32_RANGE;
  }

  // [minInclusive, maxInclusive] 闭区间整数
  function nextInt(minInclusive, maxInclusive) {
    return minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
  }

  // 百分比整数判定：pct = 30 表示 30% 概率命中
  function chancePercent(pct) {
    return nextInt(1, UNITS.PERCENT) <= pct;
  }

  function pick(items) {
    return items[nextInt(0, items.length - 1)];
  }

  // 按整数权重抽取（权重可以是到客权重、遭遇权重等百分比整数）
  function pickWeighted(items, weightOf) {
    let total = 0;
    for (const item of items) total += weightOf(item);
    let roll = nextInt(1, total);
    for (const item of items) {
      roll -= weightOf(item);
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  return {
    getSeed: () => state,
    nextUint32,
    next,
    nextInt,
    chancePercent,
    pick,
    pickWeighted,
  };
}
