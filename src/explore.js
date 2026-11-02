/**
 * explore.js — 迷宫采风（体力/野餐盒/篝火/事件 v2）
 *
 * 规则：§4.1 + P0 补③ + 本轮体力系统。
 * 不读写 DOM；随机数只用 rng.js 的 rng。
 */

import {
  ENCOUNTERS,
  EXPLORE,
  FIGHT,
  INVITATION,
  ITEM_VALUES,
  LOST_FOUND,
  MATERIALS,
  NEGOTIATION,
  SNACKS,
} from '../config.js';
import {
  addInventory,
  gainAffinity,
  getHeart,
  inventoryCount,
  removeInventory,
} from './state.js';

function fail(reason) {
  return { ok: false, reason };
}

// ============================================================
// 数值读取
// ============================================================

function costForDepth(table, depth) {
  for (const row of table) {
    if (row.maxDepth === null || depth <= row.maxDepth) return row.cost;
  }
  return table[table.length - 1].cost;
}

export function returnCost(state) {
  if (!state.explore) return 0;
  return state.explore.depth * EXPLORE.RETURN_COST_PER_DEPTH;
}

function moodMaxForLevel(level) {
  return EXPLORE.MOOD_LEVELS[Math.min(level, EXPLORE.MOOD_LEVELS.length - 1)];
}

function rarePercentForDepth(depth) {
  const table = EXPLORE.RARE_DROP_PCT_BY_DEPTH;
  return table[Math.min(depth, table.length - 1)];
}

// ============================================================
// 开局装填
// ============================================================

function normalizeLoadout(loadout = {}) {
  return {
    lunchbox: { ...(loadout.lunchbox ?? {}) },
    backpack: { ...(loadout.backpack ?? {}) },
  };
}

function loadoutBackpackSlots(backpackCounts) {
  let slots = 0;
  for (const count of Object.values(backpackCounts)) {
    slots += Math.ceil(count / EXPLORE.BACKPACK_STACK);
  }
  return slots;
}

function makeBackpackSlots(backpackCounts) {
  const backlog = [];
  for (const [itemId, count] of Object.entries(backpackCounts)) {
    let remaining = count;
    while (remaining > 0) {
      const placed = Math.min(EXPLORE.BACKPACK_STACK, remaining);
      backlog.push({ itemId, count: placed });
      remaining -= placed;
    }
  }
  return backlog;
}

/** 出发：把 loadout 从旅馆库存装进随身；loadout 默认为空 */
export function startExplore(state, loadout = {}) {
  if (state.explore) return fail('ALREADY_EXPLORING');
  if (state.closed) return fail('DAY_CLOSED');
  if (state.time !== 0) return fail('BUSINESS_STARTED');

  const normalized = normalizeLoadout(loadout);
  let lunchboxTotal = 0;

  for (const [itemId, count] of Object.entries(normalized.lunchbox)) {
    if (!SNACKS[itemId]) return fail('UNKNOWN_ITEM');
    if (!Number.isInteger(count) || count < 0) return fail('INVALID_COUNT');
    lunchboxTotal += count;
  }
  if (lunchboxTotal > EXPLORE.LUNCHBOX_CAPACITY) return fail('LUNCHBOX_FULL');

  for (const [itemId, count] of Object.entries(normalized.backpack)) {
    if (!MATERIALS[itemId]) return fail('UNKNOWN_ITEM');
    if (!Number.isInteger(count) || count < 0) return fail('INVALID_COUNT');
  }
  if (loadoutBackpackSlots(normalized.backpack) > EXPLORE.BACKPACK_SLOTS) {
    return fail('BACKPACK_FULL');
  }

  // 校验库存（全部通过后才扣）
  for (const [itemId, count] of [...Object.entries(normalized.lunchbox), ...Object.entries(normalized.backpack)]) {
    if (inventoryCount(state, itemId) < count) return fail('NO_ITEM');
  }

  for (const [itemId, count] of [...Object.entries(normalized.lunchbox), ...Object.entries(normalized.backpack)]) {
    if (count > 0) removeInventory(state, itemId, count);
  }

  const firstCampfire = state.rng.nextInt(
    EXPLORE.CAMPFIRE.FIRST_MIN_DEPTH,
    EXPLORE.CAMPFIRE.FIRST_MAX_DEPTH,
  );
  const campfireDepths = [firstCampfire];
  if (state.rng.chancePercent(EXPLORE.CAMPFIRE.SECOND_CHANCE_PCT)) {
    campfireDepths.push(state.rng.nextInt(
      EXPLORE.CAMPFIRE.SECOND_MIN_DEPTH,
      EXPLORE.CAMPFIRE.SECOND_MAX_DEPTH,
    ));
  }

  const moodMax = moodMaxForLevel(state.moodLevel ?? 0);
  state.explore = {
    mood: moodMax,
    moodMax,
    depth: EXPLORE.START_DEPTH,
    lunchbox: normalized.lunchbox,
    backpack: makeBackpackSlots(normalized.backpack),
    campfireDepths,
    mudRemaining: 0,
    pendingEncounter: null,
    encounterTried: {},       // 兼容旧字段（新规则用 negotiationTried）
    negotiationTried: false,
    invitedNpcs: [],
    pendingPickup: null,
  };

  return { ok: true, mood: moodMax, depth: 0, campfireDepths: [...campfireDepths] };
}

// ============================================================
// 随机抽取
// ============================================================

export function drawNodeType(rng) {
  const weights = EXPLORE.NODE_CHANCE_PCT;
  return rng.pickWeighted(
    Object.keys(weights),
    (id) => weights[id],
  );
}

export function drawEventType(rng) {
  const weights = EXPLORE.EVENT_WEIGHT;
  return rng.pickWeighted(
    Object.keys(weights),
    (id) => weights[id],
  );
}

export function drawEncounter(rng) {
  const weights = EXPLORE.ENCOUNTER_CHANCE_PCT;
  return rng.pickWeighted(Object.keys(weights), (id) => weights[id]);
}

/** 资源点整次掉落：1~2 件，每件独立判定稀有 */
export function drawLoot(rng, depth) {
  const count = rng.pickWeighted(EXPLORE.RESOURCE_YIELD, (entry) => entry.chancePct).count;
  const drops = [];
  for (let index = 0; index < count; index += 1) {
    const rare = rng.chancePercent(rarePercentForDepth(depth));
    const pool = rare
      ? (depth <= EXPLORE.RARE_DEPTH_THRESHOLD ? EXPLORE.RARE_POOL_LOW : EXPLORE.RARE_POOL_HIGH)
      : Object.fromEntries(Object.keys(MATERIALS).map((id) => [id, 1]));
    const itemId = rng.pickWeighted(Object.keys(pool), (id) => pool[id]);
    drops.push(itemId);
  }
  return drops;
}

// ============================================================
// 背包
// ============================================================

function backpackPieces(backpack) {
  return backpack.reduce((sum, slot) => sum + slot.count, 0);
}

function backpackCapacity(backpack, itemId) {
  let capacity = (EXPLORE.BACKPACK_SLOTS - backpack.length) * EXPLORE.BACKPACK_STACK;
  for (const slot of backpack) {
    if (slot.itemId === itemId) capacity += EXPLORE.BACKPACK_STACK - slot.count;
  }
  return capacity;
}

export function pickup(state, itemId, count = 1) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');
  if (explore.pendingPickup) return fail('NEED_SWAP');
  if (!Number.isInteger(count) || count <= 0) return fail('INVALID_COUNT');
  if (!(itemId in ITEM_VALUES)) return fail('UNKNOWN_ITEM');

  if (backpackCapacity(explore.backpack, itemId) < count) {
    explore.pendingPickup = { itemId, count };
    return { ok: false, reason: 'NEED_SWAP', pending: { itemId, count } };
  }

  let remaining = count;
  for (const slot of explore.backpack) {
    if (remaining <= 0) break;
    if (slot.itemId !== itemId || slot.count >= EXPLORE.BACKPACK_STACK) continue;
    const room = EXPLORE.BACKPACK_STACK - slot.count;
    const placed = Math.min(room, remaining);
    slot.count += placed;
    remaining -= placed;
  }
  while (remaining > 0) {
    const placed = Math.min(EXPLORE.BACKPACK_STACK, remaining);
    explore.backpack.push({ itemId, count: placed });
    remaining -= placed;
  }
  return { ok: true, itemId, count };
}

function backpackCount(backpack, itemId) {
  return backpack.reduce((sum, slot) => (slot.itemId === itemId ? sum + slot.count : sum), 0);
}

function removeBackpackItem(backpack, itemId, count) {
  let remaining = count;
  for (let index = 0; index < backpack.length && remaining > 0; index += 1) {
    const slot = backpack[index];
    if (slot.itemId !== itemId) continue;
    const removed = Math.min(slot.count, remaining);
    slot.count -= removed;
    remaining -= removed;
    if (slot.count === 0) backpack.splice(index, 1), (index -= 1);
  }
}

export function discardPending(state) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');
  if (!explore.pendingPickup) return fail('NO_PENDING');
  explore.pendingPickup = null;
  return { ok: true };
}

export function swapPending(state, slot) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');
  if (!explore.pendingPickup) return fail('NO_PENDING');
  if (!Number.isInteger(slot) || slot < 1 || slot > explore.backpack.length) {
    return fail('INVALID_SLOT');
  }
  const { itemId, count } = explore.pendingPickup;
  if (count > EXPLORE.BACKPACK_STACK) return fail('STACK_LIMIT');
  const removed = explore.backpack[slot - 1];
  explore.backpack[slot - 1] = { itemId, count };
  explore.pendingPickup = null;
  return { ok: true, removed, itemId, count };
}

// ============================================================
// 结算节点 / 推进
// ============================================================

function stepCostFor(explore) {
  let cost = costForDepth(EXPLORE.STEP_COST_BY_DEPTH, explore.depth);
  if (explore.mudRemaining > 0) {
    cost += EXPLORE.MUD.EXTRA_STEP_COST;
    explore.mudRemaining -= 1;
  }
  return cost;
}

/** 结算一个节点：本身负责「深度 +1、扣赶路、节点代价与效果」 */
export function settleNode(state, nodeType, eventType) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');
  if (explore.pendingEncounter) return fail('ENCOUNTER_PENDING');
  if (explore.pendingPickup) return fail('NEED_SWAP');

  explore.depth += EXPLORE.DEPTH_PER_NODE;
  explore.mood -= stepCostFor(explore);

  if (explore.mood <= 0) {
    const fall = fallDown(state, 'MOOD_ZERO');
    return { ok: true, nodeType, fell: true, fall };
  }

  if (nodeType === 'CAMPFIRE') {
    explore.mood = Math.min(explore.moodMax, explore.mood + EXPLORE.CAMPFIRE.RESTORE_MOOD);
    return { ok: true, nodeType, mood: explore.mood, depth: explore.depth };
  }

  if (nodeType === 'RESOURCE') {
    explore.mood -= costForDepth(EXPLORE.GATHER_COST_BY_DEPTH, explore.depth);
    if (explore.mood <= 0) {
      const fall = fallDown(state, 'MOOD_ZERO');
      return { ok: true, nodeType, fell: true, fall };
    }

    const drops = drawLoot(state.rng, explore.depth);
    let needSwap = false;
    for (const itemId of drops) {
      const result = pickup(state, itemId, 1);
      if (!result.ok && result.reason === 'NEED_SWAP') needSwap = true;
    }
    return { ok: true, nodeType, drops, needSwap, mood: explore.mood, depth: explore.depth };
  }

  if (nodeType === 'ENCOUNTER') {
    explore.mood -= costForDepth(EXPLORE.ENCOUNTER_COST_BY_DEPTH, explore.depth);
    if (explore.mood <= 0) {
      const fall = fallDown(state, 'MOOD_ZERO');
      return { ok: true, nodeType, fell: true, fall };
    }
    const encounterId = drawEncounter(state.rng);
    const npc = ENCOUNTERS[encounterId];
    state.affectionExp[encounterId] = Math.max(
      state.affectionExp[encounterId] ?? 0,
      npc.startAffinityExp,
    );
    explore.pendingEncounter = encounterId;
    explore.encounterTried = {};
    explore.negotiationTried = false;
    explore.invitedNpcs = [];
    return { ok: true, nodeType, encounterId, mood: explore.mood, depth: explore.depth };
  }

  if (nodeType === 'EVENT') {
    const type = eventType ?? drawEventType(state.rng);
    if (type === 'MUD') {
      explore.mudRemaining = EXPLORE.MUD.DURATION_STEPS;
    } else if (type === 'PICNIC_BASKET') {
      const count = explore.lunchbox.SNK_001 ?? 0;
      if (count < EXPLORE.LUNCHBOX_CAPACITY) {
        explore.lunchbox.SNK_001 = count + 1;
      }
    } else if (type === 'BEAST_STEAL') {
      const count = explore.lunchbox.SNK_001 ?? 0;
      if (count > 0) {
        explore.lunchbox.SNK_001 = count - 1;
      } else {
        explore.mood -= 1;
        if (explore.mood <= 0) {
          const fall = fallDown(state, 'MOOD_ZERO');
          return { ok: true, nodeType, eventType: type, fell: true, fall };
        }
      }
    }
    return { ok: true, nodeType, eventType: type, mood: explore.mood, depth: explore.depth };
  }

  return fail('UNKNOWN_NODE');
}

export function advance(state) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');
  if (explore.pendingEncounter) return fail('ENCOUNTER_PENDING');
  if (explore.pendingPickup) return fail('NEED_SWAP');

  const nextDepth = explore.depth + EXPLORE.DEPTH_PER_NODE;
  if (explore.campfireDepths.includes(nextDepth)) {
    return settleNode(state, 'CAMPFIRE');
  }

  const nodeType = drawNodeType(state.rng);
  const eventType = nodeType === 'EVENT' ? drawEventType(state.rng) : undefined;
  return settleNode(state, nodeType, eventType);
}

/** 吃小食：从野餐盒扣；雅兴 +3，不超上限 */
export function eat(state, snackId = 'SNK_001') {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');

  const snack = SNACKS[snackId];
  if (!snack) return fail('UNKNOWN_ITEM');
  if ((explore.lunchbox[snackId] ?? 0) < 1) return fail('NO_ITEM');

  explore.lunchbox[snackId] -= 1;
  explore.mood = Math.min(explore.moodMax, explore.mood + snack.moodRestore);
  return { ok: true, mood: explore.mood, lunchbox: explore.lunchbox[snackId] };
}

/** 回店：支付 1 × 当前深度；成功则背包 + 野餐盒剩余全部并回库存 */
export function returnHome(state) {
  if (!state.explore) return fail('NOT_EXPLORING');
  return finishAdventureReturn(state);
}

/** 返程统一处理：成功并回库存；不足则在「雅兴耗尽的那一层」倒地 */
function finishAdventureReturn(state) {
  const explore = state.explore;
  const depth = explore.depth;
  const mood = explore.mood;

  if (mood >= depth) {
    explore.mood -= depth;
    for (const slot of explore.backpack) addInventory(state, slot.itemId, slot.count);
    for (const [itemId, count] of Object.entries(explore.lunchbox)) {
      if (count > 0) addInventory(state, itemId, count);
    }
    const mergedSlots = explore.backpack.length;
    state.explore = null;
    return { ok: true, fell: false, cost: depth, mergedSlots };
  }

  // 每走一层扣 1 点：深度 D、雅兴 M → 在 D − M 层倒地
  explore.depth = depth - mood;
  explore.mood = 0;
  const fall = fallDown(state, 'RETURN_TOO_EXPENSIVE');
  return { ok: true, fell: true, fall };
}

// ============================================================
// 遭遇（谈判 / 战斗 / 逃跑 / 邀请）
// ============================================================

function endEncounter(explore) {
  explore.pendingEncounter = null;
  explore.encounterTried = {};
  explore.negotiationTried = false;
  explore.invitedNpcs = [];
}

function itemCountInAdventure(explore, itemId) {
  if (itemId === NEGOTIATION.FRAGMENT_KEY) return null; // 由碎片库单独处理
  if (SNACKS[itemId]) return explore.lunchbox[itemId] ?? 0;
  return backpackCount(explore.backpack, itemId);
}

function attractionFor(npc, itemId, occurrence) {
  const key = itemId === NEGOTIATION.FRAGMENT_KEY ? NEGOTIATION.FRAGMENT_KEY : itemId;
  const base = npc.attraction[key] ?? 0;
  if (occurrence === 0) return base;
  return base >= 0 ? Math.ceil(base / 2) : Math.trunc(base / 2);
}

/** 只读：谈判成功率（整数百分比） */
export function negotiationChance(state, npcId, offer) {
  const npc = ENCOUNTERS[npcId];
  if (!npc) return 0;
  const heart = getHeart(state.affectionExp[npcId] ?? 0);
  let sum = NEGOTIATION.BASE_CHANCE_PCT + NEGOTIATION.PER_HEART_PCT * heart;

  const seen = new Map();
  for (const itemId of offer ?? []) {
    const occurrence = seen.get(itemId) ?? 0;
    seen.set(itemId, occurrence + 1);
    sum += attractionFor(npc, itemId, occurrence);
  }

  return Math.max(0, Math.min(NEGOTIATION.MAX_CHANCE_PCT, sum));
}

/** 谈判：最多 3 件物品，成败都消耗；成功回礼 + 好感 +10 */
export function negotiate(state, offer) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');

  const npcId = explore.pendingEncounter;
  if (!npcId) return fail('NO_ENCOUNTER');

  const affinityExp = state.affectionExp[npcId] ?? 0;
  if (affinityExp <= 0) return fail('NOT_ACQUAINTED');
  if (explore.negotiationTried) return fail('ALREADY_TRIED');
  if (!Array.isArray(offer) || offer.length > 3) return fail('TOO_MANY_ITEMS');

  const need = new Map();
  for (const itemId of offer) {
    if (itemId === NEGOTIATION.FRAGMENT_KEY) {
      if (state.fragments < (need.get(itemId) ?? 0) + 1) return fail('NO_ITEM');
    } else {
      const available = itemCountInAdventure(explore, itemId);
      if (available === null || available < (need.get(itemId) ?? 0) + 1) return fail('NO_ITEM');
    }
    need.set(itemId, (need.get(itemId) ?? 0) + 1);
  }

  // 提供即消耗
  for (const [itemId, count] of need) {
    if (itemId === NEGOTIATION.FRAGMENT_KEY) state.fragments -= count;
    else if (SNACKS[itemId]) explore.lunchbox[itemId] -= count;
    else removeBackpackItem(explore.backpack, itemId, count);
  }

  const chance = negotiationChance(state, npcId, offer);
  const success = state.rng.chancePercent(chance);
  const npc = ENCOUNTERS[npcId];

  if (!success) {
    explore.negotiationTried = true;
    return { ok: true, success: false, chance, mood: explore.mood, depth: explore.depth };
  }

  let needSwap = false;
  if (npc.gift) {
    const picked = pickup(state, npc.gift, 1);
    needSwap = !picked.ok && picked.reason === 'NEED_SWAP';
  }
  gainAffinity(state, npcId, NEGOTIATION.AFFINITY_GAIN);
  endEncounter(explore);

  return {
    ok: true, success: true, chance, gift: npc.gift, needSwap,
    mood: explore.mood, depth: explore.depth,
  };
}

/** 战斗：支付 2 × ENCOUNTER(深度)；一定通过 */
export function fight(state) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');

  const npcId = explore.pendingEncounter;
  if (!npcId) return fail('NO_ENCOUNTER');

  const cost = FIGHT.COST_MULTIPLIER
    * costForDepth(EXPLORE.ENCOUNTER_COST_BY_DEPTH, explore.depth);
  explore.mood -= cost;

  if (explore.mood <= 0) {
    explore.mood = 0;
    const fall = fallDown(state, 'MOOD_ZERO');
    return { ok: true, fell: true, fall, cost };
  }

  const npc = ENCOUNTERS[npcId];
  let needSwap = false;
  if (npc.fightLoot) {
    const picked = pickup(state, npc.fightLoot, 1);
    needSwap = !picked.ok && picked.reason === 'NEED_SWAP';
  }
  state.affectionExp[npcId] = Math.max(
    0,
    (state.affectionExp[npcId] ?? 0) - NEGOTIATION.AFFINITY_LOSS,
  );
  endEncounter(explore);

  return {
    ok: true, success: true, loot: npc.fightLoot, needSwap, cost,
    mood: explore.mood, depth: explore.depth,
  };
}

/** 逃跑：消耗背包 1 件指定材料，然后强制返程 */
export function flee(state, materialId) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');
  if (!explore.pendingEncounter) return fail('NO_ENCOUNTER');

  if (!MATERIALS[materialId] || backpackCount(explore.backpack, materialId) < 1) {
    return fail('NO_MATERIAL');
  }

  removeBackpackItem(explore.backpack, materialId, 1);
  const result = finishAdventureReturn(state);
  return { ...result, fled: true };
}

/** 机会邀请：消耗 1 张体验券，不结束遭遇、不改好感 */
export function invite(state) {
  const explore = state.explore;
  if (!explore) return fail('NOT_EXPLORING');

  const npcId = explore.pendingEncounter;
  if (!npcId) return fail('NO_ENCOUNTER');
  if (state.vouchers < 1) return fail('NO_VOUCHER');
  if (explore.invitedNpcs.includes(npcId)) return fail('ALREADY_INVITED');

  state.vouchers -= 1;
  explore.invitedNpcs.push(npcId);
  state.invites.push({ npcId, day: state.day });

  return {
    ok: true,
    chance: inviteChance(state, npcId),
    npcId,
    mood: explore.mood,
    depth: explore.depth,
  };
}

/** 只读：光临概率（P0 占位 = 基础 20 + 加成 5） */
export function inviteChance(state, npcId) {
  return INVITATION.BASE_CHANCE_PCT + INVITATION.BONUS_CHANCE_PCT;
}

/** 次日开盘：对每条邀请掷一次；成功记入 pendingVisitors */
export function rollInvitations(state, rng) {
  const events = [];
  for (const invitation of state.invites) {
    if (rng.chancePercent(inviteChance(state, invitation.npcId))) {
      state.pendingVisitors.push(invitation.npcId);
      events.push({ type: 'visitorInvited', npcId: invitation.npcId, day: state.day });
    }
  }
  state.invites = [];
  return events;
}

/** 旧选项已被移除；保留入口，统一返回 UNKNOWN_OPTION */
export function resolveEncounter() {
  return fail('UNKNOWN_OPTION');
}

// ============================================================
// 倒地丢损与失物包
// ============================================================

export function computeLossCount(totalPieces) {
  return Math.floor((totalPieces * LOST_FOUND.LOSS_PCT) / 100);
}

export function splitLostItems(backpack) {
  const items = [];
  for (const slot of backpack) {
    for (let index = 0; index < slot.count; index += 1) {
      items.push({ itemId: slot.itemId, value: ITEM_VALUES[slot.itemId] ?? 0 });
    }
  }
  items.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (a.itemId < b.itemId) return -1;
    if (a.itemId > b.itemId) return 1;
    return 0;
  });
  const loseCount = computeLossCount(items.length);
  const lost = items.slice(0, loseCount);
  const kept = items.slice(loseCount);
  return { lost, kept, lostValue: lost.reduce((sum, item) => sum + item.value, 0) };
}

function aggregateItems(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([itemId, count]) => ({ itemId, count }));
}

function fallDown(state, cause) {
  const explore = state.explore;
  const backpack = explore.backpack;
  explore.mood = Math.max(0, explore.mood); // 雅兴夹紧为 0，不出现负数

  const split = splitLostItems(backpack);
  for (const item of split.kept) addInventory(state, item.itemId, 1);
  // 野餐盒剩余不丢，全部并回库存
  for (const [itemId, count] of Object.entries(explore.lunchbox)) {
    if (count > 0) addInventory(state, itemId, count);
  }

  const owner = pickLostBagOwner(state, state.rng);
  state.lostBagSeq += 1;
  const lostBag = {
    id: `BAG_${state.day}_${state.lostBagSeq}`,
    items: aggregateItems(split.lost),
    totalValue: split.lostValue,
    day: state.day,
    fallDepth: explore.depth,
    owner: owner.owner,
  };
  if (owner.caretakerGuestId) lostBag.caretakerGuestId = owner.caretakerGuestId;

  const result = {
    cause,
    mood: explore.mood,
    depth: explore.depth,
    totalPieces: backpackPieces(backpack),
    lostCount: split.lost.length,
    keptCount: split.kept.length,
    lostBag,
  };

  state.lostBags.push(lostBag);
  state.coldPending = true;
  state.explore = null;
  return result;
}

// ============================================================
// 失物包归属
// ============================================================

function familiarCandidates(state) {
  const candidates = [];
  for (const [guestId, lastDay] of Object.entries(state.guestLastVisitDay ?? {})) {
    if (!Number.isInteger(lastDay)) continue;
    const gap = state.day - lastDay;
    if (gap < 1 || gap > LOST_FOUND.FAMILIAR_LOOKBACK_DAYS) continue;
    const heart = getHeart(state.affectionExp[guestId] ?? 0);
    if (heart < LOST_FOUND.FAMILIAR_MIN_HEART) continue;
    candidates.push({ guestId, heart });
  }
  return candidates;
}

export function pickFamiliarCaretaker(state, rng) {
  const candidates = familiarCandidates(state);
  if (candidates.length === 0) return null;
  return rng.pickWeighted(candidates, (candidate) => candidate.heart).guestId;
}

export function pickLostBagOwner(state, rng) {
  const candidates = familiarCandidates(state);
  if (candidates.length === 0) return { owner: 'GOBLIN' };
  if (!rng.chancePercent(LOST_FOUND.FAMILIAR_BAG_PCT)) return { owner: 'GOBLIN' };
  return { owner: 'GUEST', caretakerGuestId: pickFamiliarCaretaker(state, rng) };
}
