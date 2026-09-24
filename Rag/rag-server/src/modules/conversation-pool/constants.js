/**
 * 会话池常量定义
 *
 * 池类型与状态流转规则：
 *
 * 池类型 (pool_type):
 *   ai_self        - AI 自助池：新客户的智能接待缓冲层（AI 身份保密），仅用于全新客户+简单/标准化问题
 *   pending_human  - 待人工池：紧急+人工需求的直通车，老客户任何问题、新客户复杂/紧急问题直接进入
 *   public         - 公共池：不活跃会话的暂存区，存放坐席释放后或超时流转的会话
 *   private        - 私有池：坐席已认领、正在处理中
 *   long_term      - 长期跟进池：需持续跟进的客户
 *
 * 会话状态 (conv_status):
 *   ai_serving     - AI 服务中（对应 ai_self 池，客户不知对方是AI）
 *   pending_claim  - 待认领（对应 pending_human / public 池）
 *   handling       - 处理中（对应 private 池）
 *   following      - 跟进中（对应 long_term 池）
 *   archived       - 已归档
 */

const POOL_TYPE = {
  AI_SELF: 'ai_self',
  PENDING_HUMAN: 'pending_human',
  PUBLIC: 'public',
  PRIVATE: 'private',
  LONG_TERM: 'long_term'
}

const CONV_STATUS = {
  AI_SERVING: 'ai_serving',
  PENDING_CLAIM: 'pending_claim',
  HANDLING: 'handling',
  FOLLOWING: 'following',
  ARCHIVED: 'archived'
}

/**
 * 池类型 → 默认会话状态 映射
 */
const POOL_STATUS_MAP = {
  [POOL_TYPE.AI_SELF]: CONV_STATUS.AI_SERVING,
  [POOL_TYPE.PENDING_HUMAN]: CONV_STATUS.PENDING_CLAIM,
  [POOL_TYPE.PUBLIC]: CONV_STATUS.PENDING_CLAIM,
  [POOL_TYPE.PRIVATE]: CONV_STATUS.HANDLING,
  [POOL_TYPE.LONG_TERM]: CONV_STATUS.FOLLOWING
}

/**
 * 池操作类型（用于日志记录）
 */
const POOL_ACTION = {
  POOL_CHANGE: 'pool_change',
  CLAIM: 'claim',
  RELEASE: 'release',
  MARK_LONG_TERM: 'mark_long_term',
  ARCHIVE: 'archive',
  TRANSFER: 'transfer',
  AI_TO_HUMAN: 'ai_to_human',
  SEAT_OFFLINE_RELEASE: 'seat_offline_release',
  PRIVATE_STALE_RELEASE: 'private_stale_release',
  TIMEOUT_TRANSFER: 'timeout_transfer',     // 超时转人工
  AGING_TRANSFER: 'aging_transfer',          // 超龄转池
  AUTO_ARCHIVE: 'auto_archive'               // 自动归档
}

/**
 * 池类型中文标签
 */
const POOL_LABELS = {
  [POOL_TYPE.AI_SELF]: 'AI自助池',
  [POOL_TYPE.PENDING_HUMAN]: '待人工池',
  [POOL_TYPE.PUBLIC]: '公共池',
  [POOL_TYPE.PRIVATE]: '私有池',
  [POOL_TYPE.LONG_TERM]: '长期跟进池'
}

/**
 * 会话状态中文标签
 */
const STATUS_LABELS = {
  [CONV_STATUS.AI_SERVING]: 'AI服务中',
  [CONV_STATUS.PENDING_CLAIM]: '待认领',
  [CONV_STATUS.HANDLING]: '处理中',
  [CONV_STATUS.FOLLOWING]: '跟进中',
  [CONV_STATUS.ARCHIVED]: '已归档'
}

/**
 * 最后回复方
 */
const LAST_REPLY_BY = {
  AI: 'ai',
  CUSTOMER: 'customer',
  AGENT: 'agent'
}

/**
 * 坐席在线状态
 */
const SEAT_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  AWAY: 'away',
  BUSY: 'busy'
}

/**
 * 前端 Tab 顺序（用于池统计）
 * 待人工池置顶（最高优先级），AI自助池第二，公共池第三
 */
const POOL_TAB_ORDER = [
  POOL_TYPE.PENDING_HUMAN,
  POOL_TYPE.AI_SELF,
  POOL_TYPE.PUBLIC,
  POOL_TYPE.LONG_TERM,
  POOL_TYPE.PRIVATE,
  'all'
]

module.exports = {
  POOL_TYPE,
  CONV_STATUS,
  POOL_STATUS_MAP,
  POOL_ACTION,
  POOL_LABELS,
  STATUS_LABELS,
  LAST_REPLY_BY,
  SEAT_STATUS,
  POOL_TAB_ORDER
}
