/**
 * AI 推荐回答并发控制器
 *
 * 1. p-limit 信号量：限制同时进行的 LLM 调用数，数量从 configService 动态读取
 * 2. 请求去重 Map：同一 msgId 在 DEDUP_TTL 内重复请求复用结果
 *
 * 数据流：
 *   请求进来 → 检查去重缓存 → 命中则直接返回缓存 → 未命中则排队等信号量 → 执行生成 → 缓存结果
 */

const pLimit = require('p-limit');

// ========== 并发限制器（动态可配置）==========
let currentLimit = 3;
let limiter = pLimit(currentLimit);

/**
 * 从 configService 读取最新并发限制，如果变化则重建 limiter
 * configService 有进程内缓存，调用开销极低
 */
async function syncLimit() {
  try {
    const configService = require('../../services/configService');
    const configured = await configService.getConfig('ai_suggest_concurrency');
    const newLimit = parseInt(configured, 10) || 3;
    if (newLimit < 1) newLimit = 1;
    if (newLimit !== currentLimit) {
      const old = currentLimit;
      currentLimit = newLimit;
      limiter = pLimit(currentLimit);
      console.log(`[SuggestionLimiter] 并发限制已更新: ${old} → ${currentLimit}`);
    }
  } catch (e) {
    // configService 不可用时保持默认值
  }
}

/**
 * 限流执行包装函数
 * 每次调用前检查配置是否变化，然后交给 p-limit 排队
 * @param {Function} fn — 异步函数
 * @returns {Promise} fn 的返回值
 */
async function runWithLimit(fn) {
  await syncLimit();
  return limiter(fn);
}

// ========== 请求去重 ==========
const DEDUP_TTL = 5000; // 5 秒内复用结果
const dedupMap = new Map(); // msgId → { state, result, timestamp }

/**
 * 检查去重缓存
 * @returns {{ state: 'generating'|'done', result: object|null } | null}
 */
function checkDedup(msgId) {
  const entry = dedupMap.get(msgId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > DEDUP_TTL) {
    dedupMap.delete(msgId);
    return null;
  }
  return entry;
}

/**
 * 标记请求开始生成
 */
function startDedup(msgId) {
  dedupMap.set(msgId, {
    state: 'generating',
    result: null,
    timestamp: Date.now()
  });
}

/**
 * 标记请求完成，缓存结果
 */
function completeDedup(msgId, result) {
  const entry = dedupMap.get(msgId);
  if (entry) {
    entry.state = 'done';
    entry.result = result;
    entry.timestamp = Date.now();
  }
}

/**
 * 清除去重缓存（生成失败时调用）
 */
function clearDedup(msgId) {
  dedupMap.delete(msgId);
}

// 定期清理过期条目
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of dedupMap.entries()) {
    if (now - entry.timestamp > DEDUP_TTL * 2) {
      dedupMap.delete(key);
    }
  }
}, 15000);

module.exports = {
  runWithLimit,
  checkDedup,
  startDedup,
  completeDedup,
  clearDedup,
  getCurrentLimit: () => currentLimit
};
