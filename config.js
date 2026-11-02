/**
 * config.js — 《迷宫尽头的解忧温泉馆》v0.5.0 · P0 数值表（唯一数字来源）
 *
 * 用途：只放「数值 / 概率 / 表」，不含任何逻辑。
 *       逻辑模块（src/*.js）里不允许再出现写死的数字，一律从这里取。
 *
 * 单位总表（全部用整数，避免浮点误差）：
 *   温度      0.1℃           250 = 25.0℃、−150 = −15.0℃
 *   满意度    0.01            2000 = 20.00 点、10000 = 100.00 点
 *   洁净度    0.1             1000 = 100.0、每秒 −1 = −0.1
 *   乘数      百分比整数      150 = 1.50×、120 = 1.20×、60 = 0.60×
 *   概率      百分比整数      65 = 65%
 *   金币      内部 1/1000 G   75500 = 75.5G，最终四舍五入、.5 向上
 *
 * 注释约定：
 *   §x.y      = 策划案《系统策划规格说明书 v0.5.0》章节号
 *   P0补①~④  = 策划针对 P0 疑问的补充口径（以此为准）
 *
 * 范围：只收录 P0 用得到的数据。
 *       P1/P2 内容（MAT_004/005、SNK_002~004、员工、苗圃/工坊、勘探夜场、
 *       碎片拼线索、石巨人遭遇等）一律不收录。
 */

// ============================================================
// 0. 单位与取整
// ============================================================
export const UNITS = {
  TEMP_PER_C: 10,            // 温度：1℃ = 10 个单位（§2.2、需求6）
  COMFORT_PER_POINT: 100,    // 满意度：1.00 点 = 100 个单位（§3.6）
  CLEAN_PER_POINT: 10,       // 洁净度：1.0 点 = 10 个单位（§3.6）
  PERCENT: 100,              // 乘数/概率：百分比基准（100 = 1.00× = 100%）
  GOLD_MILLI: 1000,          // 金币：1G = 1000 个内部单位（§2.2）
  GOLD_DIGITS: 0,            // 最终金币取整到 0 位小数（§2.2）
  GOLD_ROUNDING: 'HALF_UP',  // 最终金币 .5 向上（§2.2 四舍五入）
};

// ============================================================
// 1. 时间基准（§2.2）
// ============================================================
export const TIME = {
  TICK_SECONDS: 1,              // 每 1.0 秒结算一次（§2.2 TICK_INTERVAL）
  FLOAT_TEXT_SECONDS: 3,        // 前台每 3 秒聚合刷新一次浮字（§2.2）
  BUSINESS_DAY_SECONDS: 480,    // 一个营业日 = 真实 480 秒（§2.2）
  GAME_SECONDS_PER_TICK: 105,   // 1 真实秒 ≈ 1.75 游戏分钟 = 105 游戏秒（§2.2，仅界面换算用）
  OPEN_HOUR: 8,                 // 游戏内 08:00 开门（§2.2）
  CLOSE_HOUR: 22,               // 游戏内 22:00 打烊，进入结算（§2.2、§7）
};

// ============================================================
// 1.5 纯界面参数（不是游戏规则；页面从 config 读取，避免写死）
// ============================================================
export const UI = {
  SPEEDS: [1, 5, 20],   // 试玩倍速：1× / 5× / 20×
  TOAST_MS: 2000,       // 被拒绝时提示条停留 2 秒后自动消失
  PORT: 8080,           // 本地服务器端口（serve.js 读取）
};

// ============================================================
// 2. 水温模型（§2.2、§3.2）—— 单位 0.1℃
// ============================================================
export const TEMP = {
  AMBIENT: 250,             // 室温 25.0℃，水温向它逼近（§2.2 BASE_TEMP_AMBIENT）
  COOL_RATE_PER_SEC: 2,     // 自然回落 0.2℃/秒 = 每秒 2 个单位（§2.2）
  MIN: 0,                   // 水温夹紧下限 0.0℃（§2.2）
  MAX: 1000,                // 水温夹紧上限 100.0℃（§2.2）
  INITIAL: 250,             // 池水初始温度 25.0℃（§3.2）
};

// ============================================================
// 3. 汤池与客流（§3.1、§3.6、§5.1、§8）
//    时间单位：秒；金币单位：G；洁净度单位：0.1
// ============================================================
export const POOL = {
  COUNT: 1,                          // P0 只有 1 个汤池（§11）
  SEATS: 2,                          // 每池 2 个席位（§3.1）
  SHARED_TEMP: true,                 // 全池共享唯一水温，每位客人独立评价（§3.1）
  INGREDIENT_SLOTS: 3,               // 3 个投料槽（§8）
  TRAY_SLOTS: 1,                     // 1 个托盘槽（§8）
  ARRIVAL_INTERVAL_MIN_SECONDS: 25,  // 到客间隔 25~40 秒随机（§3.1）
  ARRIVAL_INTERVAL_MAX_SECONDS: 40,
  QUEUE_LIMIT: 3,                    // 候位上限 3 位（§3.1）
  PATIENCE_SECONDS: 45,              // 候位耐心 45 秒，超时离开、不计收益不扣声望（§3.1）
  BASE_STAY_SECONDS: 60,             // 基础停留 60 秒（§3.1）
  CHANGE_WATER_COST_GOLD: 20,        // 换水清池消耗 20G（§3.6）
  CHANGE_WATER_SECONDS: 8,           // 换水耗时 8 秒（§3.6）
  CHANGE_WATER_RESTORE_CLEAN: 1000,  // 换水后洁净度恢复 100.0（§3.6）
};

// ============================================================
// 4. 客人状态（§3.6）
//    满意度单位 0.01、洁净度单位 0.1、饱腹单位 1 点
// ============================================================
export const GUEST = {
  COMFORT_MIN: 0,                        // 满意度下限 0.00（§3.6）
  COMFORT_MAX: 10000,                    // 满意度上限 100.00（§3.6）
  COMFORT_INITIAL: 2000,                 // 满意度初始 20.00（§3.6）
  ANGRY_AT_OR_BELOW: 0,                  // 满意度 ≤0 即怒离（§3.6）
  HIGH_COMFORT_LINE: 8000,               // 满意度 ≥80.00 视为「高满意离场」（§6）

  SATIETY_MIN: 0,                        // 饱腹 0~100 点（§3.6）
  SATIETY_MAX: 100,
  SATIETY_INITIAL_MIN: 20,               // 饱腹初始随机 20~80 点（§3.6）
  SATIETY_INITIAL_MAX: 80,
  SATIETY_DROP: 3,                       // 每 10 秒 −3 点（§3.6）
  SATIETY_DROP_INTERVAL_SECONDS: 10,

  CLEAN_MIN: 0,                          // 洁净度下限 0.0（§3.6）
  CLEAN_MAX: 1000,                       // 洁净度上限 100.0（§3.6）
  CLEAN_INITIAL: 1000,                   // 洁净度初始 100.0（§3.6）
  CLEAN_DROP_PER_GUEST_SEC: 1,           // 每位在池客人每秒 −0.1（§3.6）
  CLEAN_DROP_ON_LEAVE: 30,               // 客人离场 −3.0（§3.6）
};

// ============================================================
// 5. 种族温度区间（§3.3）—— 单位 0.1℃
//    favorite / tolerant 的区间【含端点】；
//    extreme 表示「严格低于 extremeBelow」或「严格高于 extremeAbove」。
//    判定顺序：极限区 → 喜爱区 → 耐受区 → 不适区。
// ============================================================
export const RACES = {
  UNDEAD: {
    name: '亡灵（骷髅/死灵）',
    faction: 'MONSTER',        // 魔物（§3.3、§2.1）
    tempZone: {
      favorite: [150, 250],    // 喜爱区 15.0~25.0℃（§3.3）
      tolerant: [100, 350],    // 耐受区 10.0~35.0℃（§3.3）
      extremeBelow: 50,        // 极限区 <5.0℃（§3.3）
      extremeAbove: 400,       // 极限区 >40.0℃（§3.3）
    },
  },
  HUMAN: {
    name: '人族（见习剑士）',
    faction: 'ORDER',          // 秩序（§3.3、§2.1）
    tempZone: {
      favorite: [380, 450],    // 喜爱区 38.0~45.0℃（§3.3）
      tolerant: [320, 480],    // 耐受区 32.0~48.0℃（§3.3）
      extremeBelow: 200,       // 极限区 <20.0℃（§3.3）
      extremeAbove: 550,       // 极限区 >55.0℃（§3.3）
    },
  },
};

// ============================================================
// 6. 每秒满意度结算（§3.3、§3.7）
//    满意度单位 0.01/秒；乘数单位：百分比整数
// ============================================================
export const COMFORT_TICK = {
  TEMP_MATCH_PCT: {
    FAVORITE: 150,                  // 喜爱区 Temp_Match 1.50×（§3.3）
    TOLERANT: 50,                   // 耐受区 Temp_Match 0.50×（§3.3）
    UNCOMFORTABLE: 0,               // 不适区：Gain 为 0，另按下方「不适扣分」计入 Loss（§3.3 新规则）
    EXTREME: 0,                     // 极限区：不增长，另触发 Extreme_Temp_Penalty（§3.3）
  },
  BASE_RATE: 100,                   // 1.00 满意度/秒 = 100 个 0.01（§3.7）
  EXTREME_PENALTY_PER_SEC: 200,     // 极限区每秒额外 −2.00（§3.7）
  UNCOMFORTABLE_PENALTY_PER_SEC: 50, // 不适区每秒 −0.50，计入 Loss、会被 Dirty_Mult 放大（§3.3/§3.7 新规则）
  CONFLICT_PENALTY_PER_SEC: 100,    // 圣职与魔物同池每秒 −1.00（§3.7）
                                    // P0 没有圣职客人，此值不会触发，仅为公式项保留
  CLEAN_TIERS: [                    // 洁净度分档，从上到下取第一条 clean ≥ minClean（§3.7 表）
    { minClean: 600, cleanFactorPct: 100, dirtyMultPct: 100 },  // ≥60.0：1.00× / 1.00×
    { minClean: 300, cleanFactorPct: 60,  dirtyMultPct: 150 },  // 30.0~59.9：0.60× / 1.50×
    { minClean: 0,   cleanFactorPct: 20,  dirtyMultPct: 250 },  // <30.0：0.20× / 2.50×
  ],
};

// ============================================================
// 7. 离店结算（§3.7 + 补充口径）
//    BASE_FEE / BASE_TIP 单位 G；乘数单位：百分比整数
// ============================================================
export const SETTLEMENT = {
  BASE_FEE: 50,                    // 门票 50G（§3.7）
  BASE_TIP: 30,                    // 基础小费 30G（§3.7）
  REP_MULT_PCT: 120,               // 该阵营声望 ≥+30 时门票 1.20×（§3.7、§6）
  REP_MULT_DEFAULT_PCT: 100,       // 声望不足时 1.00×（§3.7）
  AFFINITY_MULT_BASE_PCT: 100,     // 好感乘区基数 1.00×（§3.7）
  AFFINITY_MULT_PER_HEART_PCT: 10, // 每 1 心 +0.10×（§3.7）
  TIP_MULT_DEFAULT_PCT: 100,       // 小费乘区默认 1.00×（§3.7）
  ANGRY_FEE_PCT: 50,               // 怒离只收一半门票 = 25G，无小费无小食（§3.7 + P0 补充）
  VIP_TICKET_PCT: 150,             // 体验券奖励：次日 1 位客人门票 1.50×，仅一次（§4.4）
};

// ============================================================
// 8. 阵营 / 好感 / 声望 / P0 熟客（§2.1、§6、P0补③④）
// ============================================================
export const FACTIONS = {
  ORDER: '秩序',     // 人族、圣职人员（§2.1）
  MONSTER: '魔物',   // 亡灵等（§2.1）
  NEUTRAL: '中立',   // 蚁群等（§2.1）
};

export const AFFINITY = {
  EXP_PER_HEART: 100,             // 1 心 = 100 好感经验（§2.1）
  HEART_MIN: 0,                   // 心数下限 0（§2.1）
  HEART_MAX: 10,                  // 心数 0~10（§2.1）
  DAILY_EXP_CAP: 60,              // 每位 NPC 每日好感经验合计上限 60（§6）
  GAIN_VISIT: 10,                 // 到店光顾 +10（§6）
  GAIN_HIGH_COMFORT_LEAVE: 20,    // 满意度 ≥80 离场 +20（§6）
  GAIN_FEED_PREFERRED_SNACK: 30,  // 投喂偏好小食 +30（§6；P0 偏好对应未定，见清单）
  RANSOM_AFFINITY_COST: 30,       // 赎回失物 −30，只扣一次、最低到 0（§5.2/§6 + P0补④）
  INITIAL_EXP: {
    GUEST_BONE_KING_GUARD: 0,     // 开局好感 0 经验（P0补④）
    GUEST_WANDERING_SKELETON: 0,  // 开局 0（P0补④）
    GUEST_APPRENTICE_SWORDSMAN: 0,// 开局 0（P0补④）
    PALADIN_APPRENTICE: 100,      // 见习圣骑士不在汤池，开局 1 心（P0补④）
    APPRENTICE_PALADIN: 100,      // 遭遇系统 v2 NPC id（与旧 id 同步开局 1 心）
  },
};

export const REPUTATION = {
  MIN: -100,                      // 声望范围 −100~+100（§2.1、§6）
  MAX: 100,
  TICKET_BONUS_THRESHOLD: 30,     // ≥+30：该阵营客人门票 1.20×（§6）
  REFUSE_THRESHOLD: -50,          // ≤−50：拒访，当日该阵营客人不再到访（§6）
  DAILY_REGEN: 10,                // 每日自然回升 +10（§6）
  GAIN_HIGH_COMFORT_LEAVE: 1,     // 每位满意度 ≥80 离场 +1（§6）
  INITIAL: {
    ORDER: 0,                     // 开局各阵营声望：文档未给，暂定 0（已确认）
    MONSTER: 0,
    NEUTRAL: 0,
  },
};

// P0 熟客：三位具名客人，各自独立好感与心数（P0补④）
// 到客权重单位：百分比整数，合计 100（P0补③）
export const GUESTS = {
  GUEST_BONE_KING_GUARD: {
    name: '骨王近卫',
    race: 'UNDEAD',
    arrivalWeightPct: 25,         // P0补③：25%
  },
  GUEST_WANDERING_SKELETON: {
    name: '游荡骷髅',
    race: 'UNDEAD',
    arrivalWeightPct: 25,         // P0补③：25%
  },
  GUEST_APPRENTICE_SWORDSMAN: {
    name: '见习剑士',
    race: 'HUMAN',
    arrivalWeightPct: 50,         // P0补③：50%
  },
};

// ============================================================
// 9. 物品：材料 / 小食 / 估值（§2.3、§3.4、§3.5 + P0补①）
//    温度单位 0.1℃；价格单位 G；满意度单位 0.01；乘数单位 %
// ============================================================
export const MATERIALS = {
  MAT_001: {
    name: '极寒薄荷晶',
    buyPrice: 15,             // P0补①：前台补给箱按 §2.3 估值购买（单位 G）
    deltaTemp: -150,          // 投入后水温立即 −15.0℃（§3.4）
    buffSeconds: 45,          // 词条持续 45 秒，只作用词条、不影响水温（§3.2、§3.4）
    // 词条：史莱姆/雪怪 Speed_Bonus +0.5（P1，P0 不实装；实现时写成 +50）
  },
  MAT_002: {
    name: '地热爆燃石',
    buyPrice: 20,             // P0补①（单位 G）
    deltaTemp: 200,           // 投入后水温立即 +20.0℃（§3.4）
    buffSeconds: 60,          // 词条持续 60 秒（§3.4）
    // 词条：龙族/矮人 Speed_Bonus +0.4（P1，P0 不实装；实现时写成 +40）
  },
  MAT_003: {
    name: '高钙白骨粉',
    buyPrice: 35,             // P0补①（单位 G）
    deltaTemp: 0,             // 投入后水温不变（§3.4）
    buffSeconds: 90,          // 词条持续 90 秒（§3.4）
    tipMult: {                // 词条：亡灵 小费 2.00×（§3.4），百分比整数
      pct: 200,
      race: 'UNDEAD',
    },
    // 圣职人员入池每秒额外 Loss +1.0（P1，不实装）
  },
};

export const SNACKS = {
  SNK_001: {
    name: '流心熟成蛋',
    buyPrice: 5,              // P0补①：补给箱按 §2.3 估值购买（单位 G）
    salePrice: 18,            // 售价 18G（§3.5），离店时计入小食收入
    trigger: {                // 点单气泡触发条件（§3.5）
      staySeconds: 30,        // 入池满 30 秒
      satietyBelow: 50,       // 且饱腹 <50 点
    },
    effect: {
      comfortInstant: 2000,   // 瞬时 +20.00 满意度（§3.5），单位 0.01
    },
    moodRestore: 3,           // 采风途中食用恢复雅兴 +3（§3.5）
  },
};

export const SNACK_SERVICE = {
  EAT_WINDOW_SECONDS: 5,      // 投放后 5 秒内食用，不存在误食（§3.5）
  TRAY_RECYCLE_SECONDS: 120,  // 托盘 120 秒无人食用回收为堆肥，无惩罚（§3.5）
};

// 遭遇奖励道具（§4.4）。文档没有给 ID，这里用英文键名，仅作 P0 掉落物。
export const REWARD_ITEMS = {
  PURE_ANT_ACID: { name: '纯净蚁酸' },       // 红魔蚁工头·投喂奖励（§4.4）
  GEOTHERMAL_SHARD: { name: '地热碎晶' },    // 红魔蚁工头·嘴炮奖励（§4.4）
  HOLY_WATER_SAMPLE: { name: '圣水样品' },   // 见习圣骑士·嘴炮奖励（§4.4）
};

// 物品标准估值（单位 G）：赎金 = round(估值合计 × Rate‰ / 1000)（§2.3、§5.2）
// 只收录 P0 能实际拿到手的物品。
export const ITEM_VALUES = {
  MAT_001: 15,             // §2.3
  MAT_002: 20,             // §2.3
  MAT_003: 35,             // §2.3
  SNK_001: 5,              // §2.3
  PURE_ANT_ACID: 25,       // §2.3
  GEOTHERMAL_SHARD: 40,    // §2.3
  HOLY_WATER_SAMPLE: 60,   // §2.3
};

// ============================================================
// 10. 采风（§4.1 + P0补③）
//     概率单位：百分比整数
// ============================================================
export const EXPLORE = {
  MOOD_MAX: 12,                 // 雅兴上限 12 点（§4.1）
  MOOD_INITIAL: 12,             // 开局雅兴 = 满（已确认）
  MOOD_LOW_WARN: 2,             // 余量 ≤2 时界面变红（§4.1）
  MOOD_COST_PER_NODE: 1,        // 每前进一个节点，雅兴 −1（§4.1）
  DEPTH_PER_NODE: 1,            // 每前进一个节点，深度 +1（§4.1）
  START_DEPTH: 0,               // 出发时深度为 0（已确认）
  RETURN_COST_PER_DEPTH: 1,     // 回店一次性支付 = 当前深度 点雅兴（§4.1 + P0 补充）

  BACKPACK_SLOTS: 8,            // 背包 8 格（§4.1）
  BACKPACK_STACK: 5,            // 每格堆叠 5 件（§4.1）

  NODE_CHANCE_PCT: {            // P0补③：只保留资源点与遭遇，合计 100
    RESOURCE: 65,               // 资源点 65%
    ENCOUNTER: 35,              // 遭遇 35%
  },
  ENCOUNTER_CHANCE_PCT: {       // 两种遭遇各 50%
    ANT_FOREMAN: 50,
    APPRENTICE_PALADIN: 50,
  },
  RESOURCE_YIELD: [             // P0补③：资源点产出 1~2 件，各 50%
    { count: 1, chancePct: 50 },
    { count: 2, chancePct: 50 },
  ],
  RESOURCE_POOL: ['MAT_001', 'MAT_002', 'MAT_003'], // P0补③：等概率抽取

  // ---- 体力系统（§4.1 v2）----
  MOOD_LEVELS: [16, 19, 22, 25, 28],   // 等级 0~4 的雅兴上限
  UPGRADE_COSTS: [2500, 6000, 11000, 18000], // 0→1、1→2、2→3、3→4
  LUNCHBOX_CAPACITY: 4,                // 野餐盒最多 4 份小食

  STEP_COST_BY_DEPTH: [                // 赶路：抵达第 d 层扣
    { maxDepth: 3, cost: 1 },
    { maxDepth: 6, cost: 2 },
    { maxDepth: 9, cost: 3 },
    { maxDepth: null, cost: 4 },
  ],
  GATHER_COST_BY_DEPTH: [              // 采集：资源点结算扣
    { maxDepth: 5, cost: 1 },
    { maxDepth: null, cost: 2 },
  ],
  ENCOUNTER_COST_BY_DEPTH: [           // 进入遭遇扣
    { maxDepth: 5, cost: 2 },
    { maxDepth: null, cost: 3 },
  ],
  RETURN_COST_PER_DEPTH: 1,            // 返程 = 1 × 当前深度

  CAMPFIRE: {                          // 篝火
    FIRST_MIN_DEPTH: 3,
    FIRST_MAX_DEPTH: 6,
    SECOND_CHANCE_PCT: 50,
    SECOND_MIN_DEPTH: 7,
    SECOND_MAX_DEPTH: 10,
    RESTORE_MOOD: 4,
  },
  MUD: { EXTRA_STEP_COST: 1, DURATION_STEPS: 3 }, // 泥泞

  NODE_CHANCE_PCT: {                   // 非篝火层节点构成
    RESOURCE: 55,
    ENCOUNTER: 28,
    EVENT: 17,
  },
  EVENT_WEIGHT: {                      // 事件类型权重（偷食暂为 0）
    MUD: 50,
    PICNIC_BASKET: 50,
    BEAST_STEAL: 0,
  },

  RARE_DROP_PCT_BY_DEPTH: [0, 0, 10, 20, 30, 40, 50, 60, 70], // 下标=深度；≥8 用最后一项
  RARE_DEPTH_THRESHOLD: 5,             // d≤5 用低层稀有池，d≥6 用高层
  RARE_POOL_LOW: {
    PURE_ANT_ACID: 60,
    GEOTHERMAL_SHARD: 30,
    HOLY_WATER_SAMPLE: 10,
  },
  RARE_POOL_HIGH: {
    PURE_ANT_ACID: 20,
    GEOTHERMAL_SHARD: 40,
    HOLY_WATER_SAMPLE: 40,
  },

  SELL_RATE_PCT: { MATERIAL: 50, RARE: 70 }, // 盈余出售收购比例
};

// ============================================================
// 11. 遭遇（§4.3、§4.4 v2：谈判/战斗/逃跑/邀请）
//     概率单位：百分比整数；雅兴单位：点
// ============================================================

export const VOUCHERS = {
  DAILY_GRANT: 1,             // 前台每日赠送 1 张（§4.4）
  HOLD_LIMIT: 3,              // 持有上限 3 张（§4.4）
  INITIAL: 1,                 // 开局持有 1 张（P0补①）
};

export const FRAGMENTS = {
  DROP_PCT: 30,               // P0补②：P0 不分阵营，任意客人离场 30% 掉 1 张
};

export const ENCOUNTERS = {
  ANT_FOREMAN: {
    name: '红魔蚁工头',
    rank: 2,                  // 阶位
    startAffinityExp: 0,      // 起始好感经验
    gift: 'PURE_ANT_ACID',    // 谈判成功回礼
    fightLoot: 'GEOTHERMAL_SHARD', // 战斗战利品
    attraction: {             // 物品吸引力（百分点）
      SNK_001: 24,
      FRAGMENT: 16,
      MAT_002: 10,
      MAT_001: 5,
      MAT_003: 0,
    },
  },
  APPRENTICE_PALADIN: {
    name: '见习圣骑士',
    rank: 1,
    startAffinityExp: 100,
    gift: 'HOLY_WATER_SAMPLE',
    fightLoot: 'HOLY_WATER_SAMPLE',
    attraction: {
      SNK_001: 20,
      HOLY_WATER_SAMPLE: 35,
      FRAGMENT: 16,
      MAT_001: 5,
      MAT_002: 5,
      MAT_003: -25,
    },
  },
};

export const NEGOTIATION = {
  BASE_CHANCE_PCT: 10,        // 基础 10%
  PER_HEART_PCT: 8,           // 每颗心 +8%
  MAX_CHANCE_PCT: 95,         // 封顶 95%
  AFFINITY_GAIN: 10,          // 成功好感 +10（受每日上限）
  AFFINITY_LOSS: 20,          // 战斗胜利好感 −20（最低 0）
  FRAGMENT_KEY: 'FRAGMENT',   // 吸引力/消耗里的「心事碎片」虚拟 key
};

export const FIGHT = {
  COST_MULTIPLIER: 2,         // 战斗支付 2 × ENCOUNTER(深度)
};

export const INVITATION = {
  BASE_CHANCE_PCT: 20,        // P0 占位：基础 20%
  BONUS_CHANCE_PCT: 5,        // P0 占位：加成 5%
};

// ============================================================
// 12. 倒地、失物与赎金（§5.1、§5.2）
//     概率单位：百分比整数；赎金比例单位：千分比（‰）
// ============================================================
export const LOST_FOUND = {
  LOSS_PCT: 80,                       // 丢失件数 = floor(背包总件数 × 80 / 100)，优先丢高估值（§5.1）
  FAMILIAR_BAG_PCT: 60,               // 60% 由熟客代管（§5.1）
  GOBLIN_BAG_PCT: 40,                 // 40% 流落到黑市地精（§5.1）
  FAMILIAR_LOOKBACK_DAYS: 3,          // 熟客 = 近 3 个营业日到访过（§5.1）
  FAMILIAR_MIN_HEART: 1,              // 且好感 ≥1 心（§5.1）
  FAMILIAR_PICK_BY_HEART_WEIGHT: true,// 按心数加权随机选一位（§5.1）

  RATE_BASE_PERMILLE: 1000,           // 基础赎金比例 1000‰（§5.2）
  FAMILIAR_RATE_STEP_PERMILLE: 90,    // 熟客：Rate‰ = 1000 − 90 × Heart（§5.2）
  FAMILIAR_MIN_RATE_PERMILLE: 100,    // 10 心 = 100‰（§5.2）
  // 赎回扣的好感经验只有一处：AFFINITY.RANSOM_AFFINITY_COST（§5.2 与 §6 是同一条规则）

  GOBLIN_GRACE_DAYS: 2,               // 地精宽限 2 天（§5.2）
  GOBLIN_DAILY_SURCHARGE_PERMILLE: 100, // 第 3 天起每天 +100‰（§5.2）
  GOBLIN_MAX_RATE_PERMILLE: 1500,     // 上限 1500‰（§5.2）
  GOBLIN_MAX_RATE_DAY: 7,             // 第 7 天到上限（§5.2）
  GOBLIN_SELL_DAY: 8,                 // 第 8 天被地精出售，永久丢失（§5.2）

  COLD_NEXT_DAY_SLOT_PENALTY: 1,      // 倒地次日感冒：投料槽 3 → 2（§5.1）
  COLD_CURE_SECONDS: 20,              // 后院饮热泉水 20 秒解除（§5.1）
};

// ============================================================
// 13. 打烊结算：排污税与赊账（§7）
//     金币单位 G；概率/利率单位：百分比整数
// ============================================================
export const TAX = {
  POOL_BASE: 100,           // 排污税 = N × (100 + 20 × N)，N = 已激活汤池数（§7）
  POOL_STEP: 20,            // 1 池 = 120G、2 池 = 280G、3 池 = 480G（§7）
};

export const CREDIT = {
  INTEREST_PCT: 10,         // 赊账次日 +10% 利息（§7）
  CLOSE_POOL_THRESHOLD: 500,// 赊账 >500G 次日强制关闭 1 池（§7）
  CLOSE_POOL_MIN_POOLS: 2,  // 仅汤池数 ≥2 时触发；P0 只有 1 池不会触发（已确认）
};

// ============================================================
// 14. 开局资源（P0补①）
// ============================================================
export const STARTING = {
  GOLD: 300,                // 开局金币 300G（P0补①）
  ITEMS: {                  // 开局库存（P0补①，单位：件）
    MAT_001: 2,
    MAT_002: 4,
    MAT_003: 2,
    SNK_001: 3,
  },
  VOUCHERS: 1,              // 开局体验券 1 张（P0补①）
  DAY: 1,                   // 从第 1 个营业日开始（已确认）
};
