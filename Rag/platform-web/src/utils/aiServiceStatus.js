import { reactive } from 'vue'
import request from '@/api'
export const aiServiceStatus = reactive({ managed: false, balance: null, connectionId: null, consecutiveReplyFailures: 0, failureEpisode: null })
let pending
export function refreshAiServiceStatus() {
  if (pending) return pending
  pending = request.get('/v1/conversations/ai-provider/health', { silent: true }).then(payload => {
    Object.assign(aiServiceStatus, payload.data || {})
    return aiServiceStatus
  }).catch(() => { aiServiceStatus.balance = null; return aiServiceStatus }).finally(() => { pending = null })
  return pending
}
