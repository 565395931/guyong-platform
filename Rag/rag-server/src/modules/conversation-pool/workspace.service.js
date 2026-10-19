const { serviceDay, agentVisibility } = require('./workspacePolicy')
const { INTERNAL_EVENTS } = require('../websocket/events')

async function ensureWorkspaceConversationSchema(sequelize) {
  const [columns] = await sequelize.query('SHOW COLUMNS FROM conversations')
  const names = new Set(columns.map(column => column.Field))
  if (!names.has('ai_epoch')) await sequelize.query('ALTER TABLE conversations ADD COLUMN ai_epoch INT NOT NULL DEFAULT 0')
  if (!names.has('pending_since')) await sequelize.query('ALTER TABLE conversations ADD COLUMN pending_since DATETIME NULL')
  await sequelize.query(`CREATE TABLE IF NOT EXISTS conversation_seat_history (
    user_id INT NOT NULL, conversation_id VARCHAR(36) NOT NULL, first_reply_at DATETIME NOT NULL,
    last_reply_at DATETIME NOT NULL, PRIMARY KEY (user_id, conversation_id), INDEX idx_history_conversation (conversation_id))`)
  await sequelize.query(`CREATE TABLE IF NOT EXISTS conversation_seat_daily (
    user_id INT NOT NULL, conversation_id VARCHAR(36) NOT NULL, service_day DATE NOT NULL,
    first_reply_at DATETIME NOT NULL, PRIMARY KEY (user_id, conversation_id, service_day))`)
  await sequelize.query(`CREATE TABLE IF NOT EXISTS workspace_state_repairs (
    conversation_id VARCHAR(36) PRIMARY KEY, previous_pool VARCHAR(20), previous_status VARCHAR(20),
    previous_conv_status VARCHAR(20), repaired_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
  await sequelize.query(`INSERT IGNORE INTO workspace_state_repairs (conversation_id,previous_pool,previous_status,previous_conv_status)
    SELECT id,pool_type,status,conv_status FROM conversations WHERE status = 'closed' AND conv_status != 'archived'`)
  await sequelize.query("UPDATE conversations SET conv_status = 'archived', ai_epoch = ai_epoch + 1 WHERE status = 'closed' AND conv_status != 'archived'")
  await sequelize.query("UPDATE conversations SET pool_type='pending_human',conv_status='pending_claim',pending_since=NOW(),ai_epoch=ai_epoch+1 WHERE pool_type='public' AND status!='closed' AND conv_status!='archived'")
  // Existing human replies seed permanent membership and the current day's count.
  await sequelize.query(`INSERT IGNORE INTO conversation_seat_history (user_id,conversation_id,first_reply_at,last_reply_at)
    SELECT CAST(m.sender_id AS UNSIGNED),m.conversation_id,MIN(m.created_at),MAX(m.created_at)
    FROM plat_messages m JOIN users u ON u.id = CAST(m.sender_id AS UNSIGNED)
    WHERE m.sender_type = 'agent' AND m.direction = 'outbound' GROUP BY m.sender_id,m.conversation_id`)
  await sequelize.query(`INSERT IGNORE INTO conversation_seat_daily (user_id,conversation_id,service_day,first_reply_at)
    SELECT CAST(m.sender_id AS UNSIGNED),m.conversation_id,DATE(DATE_SUB(m.created_at,INTERVAL 11 HOUR)),MIN(m.created_at)
    FROM plat_messages m JOIN users u ON u.id = CAST(m.sender_id AS UNSIGNED)
    WHERE m.sender_type = 'agent' AND m.direction = 'outbound' AND m.created_at >= DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY)
    GROUP BY m.sender_id,m.conversation_id,DATE(DATE_SUB(m.created_at,INTERVAL 11 HOUR))`)
}

function createWorkspaceService({ sequelize, eventEmitter, invalidateAi = async () => {}, clearPoolStats = () => {} }) {
  async function canView(userId, role, conversationId) {
    const [rows] = await sequelize.query(`SELECT c.id FROM conversations c WHERE c.id = :id ${role === 'admin' ? '' : `AND ${agentVisibility()}`}`,
      { replacements: { id: conversationId, visibilityUserId: userId } })
    return rows.length > 0
  }
  async function takeOver(conversationId, userId, { countReply = false, allowOverride = false } = {}) {
    const result = await sequelize.transaction(async transaction => {
      const [rows] = await sequelize.query('SELECT * FROM conversations WHERE id = :id FOR UPDATE', { replacements: { id: conversationId }, transaction })
      const row = rows[0]
      if (!row || row.status === 'closed' || row.conv_status === 'archived') return { success: false, message: '会话已归档，请先复活' }
      if (!allowOverride && row.claimed_by && Number(row.claimed_by) !== Number(userId)) return { success: false, message: '会话正在由其他客服接待，请先转交' }
      await sequelize.query(`UPDATE conversations SET pool_type='private',conv_status='handling',status='open',
        claimed_by=:userId,agent_id=:userId,claimed_at=NOW(),ai_epoch=ai_epoch+1,updated_at=NOW() WHERE id=:id`,
      { replacements: { id: conversationId, userId }, transaction })
      if (countReply) {
        await sequelize.query(`INSERT INTO conversation_seat_history (user_id,conversation_id,first_reply_at,last_reply_at)
          VALUES (:userId,:id,NOW(),NOW()) ON DUPLICATE KEY UPDATE last_reply_at=NOW()`, { replacements: { userId, id: conversationId }, transaction })
        await sequelize.query(`INSERT IGNORE INTO conversation_seat_daily (user_id,conversation_id,service_day,first_reply_at)
          VALUES (:userId,:id,:day,NOW())`, { replacements: { userId, id: conversationId, day: serviceDay() }, transaction })
      }
      return { success: true, fromPool: row.pool_type }
    })
    if (!result.success) return result
    clearPoolStats()
    await invalidateAi(conversationId)
    const [rows] = await sequelize.query('SELECT * FROM conversations WHERE id=:id', { replacements: { id: conversationId } })
    eventEmitter?.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, { id: conversationId, conversationId, type: 'claimed',
      fromPool: result.fromPool, toPool: 'private', operatorId: userId, conversation: { ...rows[0], participant_seat_ids: countReply ? [Number(userId)] : [] } })
    return result
  }
  async function reserve(conversationId, seatId, actorId) {
    const [result] = await sequelize.query(`UPDATE conversations SET pool_type='pending_human',conv_status='pending_claim',
      status='open',claimed_by=NULL,agent_id=:seatId,claimed_at=NOW(),pending_since=NOW(),ai_epoch=ai_epoch+1,updated_at=NOW()
      WHERE id=:id AND status != 'closed' AND conv_status != 'archived'
        AND EXISTS (SELECT 1 FROM seat_account_bindings b JOIN users u ON u.id=b.seat_id
          WHERE b.account_id=conversations.account_id AND b.seat_id=:seatId AND b.status='active' AND u.role='agent' AND u.status='active')`,
    { replacements: { id: conversationId, seatId } })
    if (!result.affectedRows) return { success: false, message: '会话已归档或该客服未配置到此平台账号' }
    clearPoolStats()
    await invalidateAi(conversationId)
    const [rows] = await sequelize.query('SELECT * FROM conversations WHERE id=:id', { replacements: { id: conversationId } })
    eventEmitter?.emit(INTERNAL_EVENTS.CONVERSATION_UPDATE, { id: conversationId, conversationId, type: 'pool_change',
      fromPool: null, toPool: 'pending_human', operatorId: actorId, conversation: rows[0] })
    return { success: true, message: '已分配到客服的待人工' }
  }
  async function dailyCount(userId) {
    const [rows] = await sequelize.query('SELECT COUNT(*) AS count FROM conversation_seat_daily WHERE user_id=:userId AND service_day=:day', { replacements: { userId, day: serviceDay() } })
    return Number(rows[0]?.count || 0)
  }
  return { canView, takeOver, reserve, dailyCount }
}
module.exports = { ensureWorkspaceConversationSchema, createWorkspaceService }
