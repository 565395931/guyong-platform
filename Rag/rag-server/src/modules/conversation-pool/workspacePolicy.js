function serviceDay(now = new Date()) {
  // China time 19:00 starts the next support day (UTC 11:00).
  return new Date(new Date(now).getTime() - 11 * 3600000).toISOString().slice(0, 10)
}
function agentVisibility(alias = 'c', parameter = 'visibilityUserId') {
  return `(${alias}.account_id IN (SELECT account_id FROM seat_account_bindings WHERE seat_id = :${parameter} AND status = 'active')
    AND ((${alias}.pool_type = 'ai_self' AND ${alias}.conv_status = 'ai_serving' AND ${alias}.status != 'closed')
      OR ${alias}.claimed_by = :${parameter} OR ${alias}.agent_id = :${parameter}
      OR EXISTS (SELECT 1 FROM conversation_seat_history h WHERE h.conversation_id = ${alias}.id AND h.user_id = :${parameter})))`
}
function minePredicate(alias = 'c', parameter = 'visibilityUserId') {
  return `(${alias}.claimed_by = :${parameter} OR EXISTS
    (SELECT 1 FROM conversation_seat_history h WHERE h.conversation_id = ${alias}.id AND h.user_id = :${parameter}))`
}
function nextPresence(status) { return ({ online: 'busy', busy: 'offline', offline: 'online' })[status] || 'online' }
module.exports = { serviceDay, agentVisibility, minePredicate, nextPresence }
