/**
 * messages.js — 前台动作/采风错误码中文提示映射表（P0）
 *
 * 纯静态字典模块：不依赖 DOM、不启动定时器、不导入任何模块。
 */

export const REASON_TEXT = {
  // 既有文案（逐字保留）
  DAY_CLOSED: '今天已经打烊了',
  ALREADY_CLOSED: '今天已经打过烊了',
  NOT_ENOUGH_GOLD: '金币不够',
  UNKNOWN_ITEM: '没有这种物品',
  INVALID_SLOT: '没有这个投料槽',
  SLOT_OCCUPIED: '这个槽位还在生效中',
  NO_ITEM: '背包里没有这件东西',
  GUEST_NOT_FOUND: '这位客人不在池里',
  NO_ORDERING_GUEST: '这位客人现在没有点单',
  TRAY_FULL: '托盘已经有一份小食了',
  ALREADY_CHANGING: '正在换水',

  // 批 A 补全（覆盖 actions.js 与 explore.js 全部 fail 错误码）
  ALREADY_DRINKING: '正在喝热水，不用重复喝',
  ALREADY_EXPLORED: '今天已经采风过了',
  ALREADY_EXPLORING: '已经在采风中了',
  ALREADY_INVITED: '已经邀请过这位了',
  ALREADY_TRIED: '这次已经谈判过了',
  BACKPACK_FULL: '背包放不下了',
  BAG_NOT_FOUND: '没有找到这个失物包',
  BUSINESS_STARTED: '营业已经开始，现在不能这样做',
  COLD_SLOT_LOCKED: '感冒中，这个投料槽暂时不能用',
  DRINKING: '正在喝热水，现在不能操作',
  ENCOUNTER_PENDING: '还有一场遭遇没处理完',
  EXPLORING: '正在采风，现在不能这样做',
  INVALID_COUNT: '数量不对',
  LUNCHBOX_FULL: '野餐盒装不下了',
  MAX_LEVEL: '已经是最高等级了',
  NEED_SWAP: '背包满了，先决定换掉哪一格',
  NO_ENCOUNTER: '现在没有遭遇',
  NO_MATERIAL: '没有可用的材料',
  NO_PENDING: '没有待处理的拾取',
  NO_VOUCHER: '体验券不够',
  NOT_ACQUAINTED: '还不认识这位，不能这样做',
  NOT_CLOSED: '还没打烊，不能进入次日',
  NOT_COLD: '没有感冒，不用喝热水',
  NOT_ENOUGH_MATERIALS: '材料不够',
  NOT_EXPLORING: '现在没有在采风',
  NOT_SELLABLE: '这件东西不能出售',
  PLAYER_LEVEL_TOO_LOW: '玩家等级不够',
  STACK_LIMIT: '这一格放不下这么多',
  TOO_MANY_ITEMS: '拿出的物品太多了',
  UNKNOWN_NODE: '没有这种节点',
};
