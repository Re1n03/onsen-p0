/**
 * tests/actions.test.js — 前台动作验收（E1~E9，E7 见回复里的口径说明，暂不写测试）
 *
 * 运行：在 E:\Project\onsen 目录执行
 *   node --test tests/actions.test.js
 *
 * 所有期望值都是字面数字。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buy, closeDay, dropMaterial, dropSnack } from '../src/actions.js';
import { createGuest, createInitialState } from '../src/state.js';
import { startNextDay } from '../src/economy.js';
import { tick } from '../src/clock.js';

function run(state, seconds) {
  for (let i = 0; i < seconds; i++) tick(state);
}

// ============================================================
// E1 购买成功
// ============================================================
test('E1 开局 300G，买 MAT_002 → 金币 280，库存 +1', () => {
  const state = createInitialState({ seed: 1 });

  const result = buy(state, 'MAT_002');

  assert.equal(result.ok, true);
  assert.equal(result.price, 20);
  assert.equal(state.gold, 280);
  assert.equal(state.inventory.MAT_002, 5);
});

// ============================================================
// E2 金币不足
// ============================================================
test('E2 金币 10 时买 MAT_003（35G）→ NOT_ENOUGH_GOLD，状态不变', () => {
  const state = createInitialState({ seed: 1 });
  state.gold = 10;

  const result = buy(state, 'MAT_003');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NOT_ENOUGH_GOLD');
  assert.equal(state.gold, 10);
  assert.equal(state.inventory.MAT_003, 2);
});

// ============================================================
// E3 投料槽被占
// ============================================================
test('E3 槽位 1、2、3 依次投入后，再投第 4 次 → SLOT_OCCUPIED', () => {
  const state = createInitialState({ seed: 1 });

  assert.equal(dropMaterial(state, 1, 'MAT_002').ok, true);
  assert.equal(dropMaterial(state, 2, 'MAT_002').ok, true);
  assert.equal(dropMaterial(state, 3, 'MAT_002').ok, true);
  assert.equal(state.inventory.MAT_002, 1);

  const fourth = dropMaterial(state, 1, 'MAT_002');
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'SLOT_OCCUPIED');
  assert.equal(state.inventory.MAT_002, 1);
  assert.equal(state.pool.temp, 850); // 三次 +20℃，25.0 → 85.0
});

// ============================================================
// E4 背包没有材料
// ============================================================
test('E4 背包里没有 MAT_001 时投入 → NO_ITEM，库存与水温不变', () => {
  const state = createInitialState({ seed: 1 });
  delete state.inventory.MAT_001;

  const result = dropMaterial(state, 1, 'MAT_001');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_ITEM');
  assert.equal(state.inventory.MAT_001, undefined);
  assert.equal(state.pool.temp, 250);
  assert.equal(state.slots[0], null);
});

// ============================================================
// E5 投入 MAT_002
// ============================================================
test('E5 投入 MAT_002 → 库存 −1，水温 25.0℃ → 45.0℃', () => {
  const state = createInitialState({ seed: 1 });

  const result = dropMaterial(state, 1, 'MAT_002');

  assert.equal(result.ok, true);
  assert.equal(state.inventory.MAT_002, 3);
  assert.equal(state.pool.temp, 450);
});

// ============================================================
// E6 投放小食
// ============================================================
test('E6 没人点单时拒绝；点单后成功；托盘已有 1 份时再放拒绝', () => {
  const state = createInitialState({ seed: 1 });
  const guest = createGuest(state, 'GUEST_BONE_KING_GUARD');
  state.seats[0] = guest;

  const noOrder = dropSnack(state, 'GUEST_BONE_KING_GUARD');
  assert.equal(noOrder.ok, false);
  assert.equal(noOrder.reason, 'NO_ORDERING_GUEST');
  assert.equal(state.tray.length, 0);
  assert.equal(state.inventory.SNK_001, 3);

  guest.orderOpen = true;
  const first = dropSnack(state, 'GUEST_BONE_KING_GUARD');
  assert.equal(first.ok, true);
  assert.equal(state.tray.length, 1);
  assert.equal(state.inventory.SNK_001, 2);

  const second = dropSnack(state, 'GUEST_BONE_KING_GUARD');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'TRAY_FULL');
  assert.equal(state.tray.length, 1);
  assert.equal(state.inventory.SNK_001, 2);
});

// ============================================================
// E7 体验券：第 1 天 1 张，第 2 天 2 张，第 3 天 3 张，第 4 天仍 3 张
// ============================================================
test('E7 体验券第1天1张、第2天2张、第3天3张、第4天仍3张', () => {
  const state = createInitialState({ seed: 1 });

  assert.equal(state.vouchers, 1);
  startNextDay(state);
  assert.equal(state.vouchers, 2);
  startNextDay(state);
  assert.equal(state.vouchers, 3);
  startNextDay(state);
  assert.equal(state.vouchers, 3);
});

// ============================================================
// E8 体验券上限
// ============================================================
test('E8 体验券持有 3 张时开盘 → 仍为 3 张', () => {
  const state = createInitialState({ seed: 1 });
  state.vouchers = 3;

  startNextDay(state);

  assert.equal(state.vouchers, 3);
});

// ============================================================
// E9 打烊只能一次；打烊后动作全部拒绝
// ============================================================
test('E9 closeDay 第二次拒绝；打烊后 buy / dropMaterial 拒绝', () => {
  const state = createInitialState({ seed: 1 });

  const first = closeDay(state);
  assert.equal(first.ok, true);

  const second = closeDay(state);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'ALREADY_CLOSED');

  const goldBefore = state.gold;
  assert.equal(buy(state, 'MAT_001').ok, false);
  assert.equal(buy(state, 'MAT_001').reason, 'DAY_CLOSED');
  assert.equal(dropMaterial(state, 1, 'MAT_002').ok, false);
  assert.equal(dropMaterial(state, 1, 'MAT_002').reason, 'DAY_CLOSED');
  assert.equal(dropSnack(state, 'GUEST_BONE_KING_GUARD').reason, 'DAY_CLOSED');
  assert.equal(state.gold, goldBefore);
  assert.equal(state.inventory.MAT_002, 4);
});

// ============================================================
// E10 槽位在词条时长结束后释放（MAT_002 = 60 秒）
// ============================================================
test('E10 槽 1 投 MAT_002：第 59 秒仍占用，第 60 秒释放后可再投', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  assert.equal(dropMaterial(state, 1, 'MAT_002').ok, true);

  run(state, 59);
  assert.notEqual(state.slots[0], null);
  assert.equal(dropMaterial(state, 1, 'MAT_002').reason, 'SLOT_OCCUPIED');

  tick(state); // 第 60 秒
  assert.equal(state.slots[0], null);
  assert.equal(dropMaterial(state, 1, 'MAT_002').ok, true);
});

// ============================================================
// E11 三个槽各按自己的词条时长释放：45 / 60 / 90 秒
// ============================================================
test('E11 槽1 MAT_001(45s)、槽2 MAT_002(60s)、槽3 MAT_003(90s) 分别释放', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  assert.equal(dropMaterial(state, 1, 'MAT_001').ok, true);
  assert.equal(dropMaterial(state, 2, 'MAT_002').ok, true);
  assert.equal(dropMaterial(state, 3, 'MAT_003').ok, true);

  run(state, 44);
  assert.notEqual(state.slots[0], null);
  assert.notEqual(state.slots[1], null);
  assert.notEqual(state.slots[2], null);

  tick(state); // 第 45 秒
  assert.equal(state.slots[0], null);
  assert.notEqual(state.slots[1], null);
  assert.notEqual(state.slots[2], null);

  run(state, 15); // 第 60 秒
  assert.equal(state.slots[1], null);
  assert.notEqual(state.slots[2], null);

  run(state, 30); // 第 90 秒
  assert.equal(state.slots[2], null);
});

// ============================================================
// E12 释放前再投同一槽 → 拒绝且不改水温/库存
// ============================================================
test('E12 槽位释放前再投 → SLOT_OCCUPIED，水温与库存不变', () => {
  const state = createInitialState({ seed: 1 });
  state.nextArrivalAt = 480;

  assert.equal(dropMaterial(state, 1, 'MAT_002').ok, true);
  run(state, 10);

  const tempBefore = state.pool.temp;
  const countBefore = state.inventory.MAT_002;

  const result = dropMaterial(state, 1, 'MAT_002');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SLOT_OCCUPIED');
  assert.equal(state.pool.temp, tempBefore);
  assert.equal(state.inventory.MAT_002, countBefore);
});
