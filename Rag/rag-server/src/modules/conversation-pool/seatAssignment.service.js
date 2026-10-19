const { INTERNAL_EVENTS } = require('../websocket/events')

function effectiveSeatStatus(availability, load) {
  return ['online', 'busy', 'offline'].includes(availability) ? availability : 'offline'
}

function orderSeats(seats, connectedIds = null) {
  const sole = seats.length === 1
  return seats.filter(s => sole || (['online', 'busy'].includes(s.status)
    && (!connectedIds || connectedIds.includes(Number(s.id)))))
    .sort((a, b) => Number(a.current) + Number(a.reserved || 0) - Number(b.current) - Number(b.reserved || 0)
      || new Date(a.lastAssignedAt || 0) - new Date(b.lastAssignedAt || 0)
      || Number(a.id) - Number(b.id))
}

function createSeatAssignmentService({ sequelize, eventEmitter, poolService, connectedSeatIds, removePendingJobs }) {
  let running = null
  async function dispatch() {
    // A dedicated row serializes automatic assignment across server processes.
    const assigned = await sequelize.transaction(async transaction => {
      const options = { transaction }
      await sequelize.query('SELECT id FROM workspace_dispatch_lock WHERE id = 1 FOR UPDATE', options)
      const liveIds = connectedSeatIds()
      await sequelize.query('SELECT user_id FROM seat_status ORDER BY user_id FOR UPDATE', options)
      const [waiting] = await sequelize.query(`SELECT id, account_id FROM conversations
        WHERE pool_type = 'pending_human' AND conv_status = 'pending_claim' AND claimed_by IS NULL AND agent_id IS NULL
          AND COALESCE(pending_since, created_at) <= DATE_SUB(NOW(), INTERVAL 10 SECOND)
          AND status != 'closed'
          AND EXISTS (SELECT 1 FROM channel_accounts a WHERE a.id = conversations.account_id AND a.status = 'active')
        ORDER BY priority DESC, created_at ASC, id ASC LIMIT 100 FOR UPDATE`, options)
      const results = []
      for (const conversation of waiting) {
        const [seats] = await sequelize.query(`SELECT u.id, u.username, COALESCE(ss.status,'offline') AS status,
          (SELECT COUNT(*) FROM conversation_seat_daily d WHERE d.user_id=u.id AND d.service_day=:serviceDay) AS current,
          (SELECT COUNT(*) FROM conversations c WHERE c.agent_id=u.id AND c.pool_type='pending_human' AND c.status!='closed') AS reserved,
          (SELECT MAX(c.claimed_at) FROM conversations c WHERE c.agent_id=u.id) AS lastAssignedAt
          FROM users u LEFT JOIN seat_status ss ON ss.user_id=u.id
          WHERE u.role='agent' AND u.status='active' AND EXISTS
            (SELECT 1 FROM seat_account_bindings b WHERE b.seat_id=u.id AND b.account_id=:accountId AND b.status='active')
          ORDER BY u.id`, { ...options, replacements: { serviceDay: require('./workspacePolicy').serviceDay(), accountId: conversation.account_id } })
        const seat = orderSeats(seats, liveIds)[0]
        if (!seat) continue
        const [updated] = await sequelize.query(`UPDATE conversations SET agent_id = :seatId, claimed_by = NULL,
          claimed_at = NOW(), updated_at = NOW()
          WHERE id = :id AND agent_id IS NULL AND claimed_by IS NULL AND pool_type = 'pending_human'
            AND conv_status = 'pending_claim' AND status != 'closed'`,
        { ...options, replacements: { seatId: seat.id, id: conversation.id } })
        if (!updated.affectedRows) continue
        await sequelize.query(`INSERT INTO conversation_pool_logs
          (conversation_id, action, from_pool, to_pool, operator_id, operator_name, operator_type, reason, created_at)
          VALUES (:id, 'assign', 'pending_human', 'pending_human', NULL, '系统', 'system', :reason, NOW())`,
        { ...options, replacements: { id: conversation.id, reason: `自动分配给 ${seat.username}（接待数 ${seat.current}）` } })
        results.push({ id: conversation.id, seatId: seat.id })
      }
      return results
    })
    for (const item of assigned) {
      const [rows] = await sequelize.query('SELECT * FROM conversations WHERE id = :id', { replacements: { id: item.id } })
      eventEmitter?.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, {
        id: item.id, conversationId: item.id, type: 'pool_change', fromPool: 'pending_human',
        toPool: 'pending_human', operatorType: 'system', conversation: rows[0]
      })
    }
    if (assigned.length) poolService.clearPoolStatsCache()
    return assigned.length
  }
  function kick() {
    if (!running) running = dispatch().catch(error => {
      console.error('[SeatAssignment] 自动分配失败:', error.message)
      return 0
    }).finally(() => { running = null })
    return running
  }
  async function presence(userId) {
    const current = await require('./workspace.service').createWorkspaceService({ sequelize }).dailyCount(userId)
    const [rows] = await sequelize.query('SELECT status FROM seat_status WHERE user_id = :userId', { replacements: { userId } })
    return { current, status: effectiveSeatStatus(rows[0]?.status || 'offline', current) }
  }
  function start() {
    eventEmitter.on(INTERNAL_EVENTS.CONVERSATION_UPDATE, kick)
    eventEmitter.on(INTERNAL_EVENTS.NEW_MESSAGE, kick)
    eventEmitter.on(INTERNAL_EVENTS.SEAT_STATUS_CHANGE, kick)
    const timer = setInterval(kick, 2000)
    timer.unref()
    return () => clearInterval(timer)
  }
  return { kick, presence, start }
}

module.exports = { effectiveSeatStatus, orderSeats, createSeatAssignmentService }
