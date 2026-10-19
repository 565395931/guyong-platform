const { POOL_TYPE, CONV_STATUS } = require('./constants')
function isAiReplyEligible(state = {}) {
  const pool = state.pool_type ?? state.poolType
  const status = state.conv_status ?? state.convStatus
  const claimed = state.claimed_by ?? state.claimedBy
  if (state.status === 'closed') return false
  if (claimed != null) return false
  return (pool === POOL_TYPE.AI_SELF && status === CONV_STATUS.AI_SERVING)
}
module.exports = { isAiReplyEligible }
