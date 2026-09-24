const TERMINAL_TASK_STATUSES = new Set(['completed', 'terminated'])
const UPDATABLE_TASK_STATUSES = new Set(['running', 'paused', 'terminated'])

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function affectedRows(result) {
  const metadata = Array.isArray(result) ? result[1] || result[0] : result
  if (Array.isArray(metadata)) return Number(metadata[0]?.affectedRows || 0)
  return Number(metadata?.affectedRows || metadata?.changedRows || 0)
}

function truncateError(message) {
  return String(message || 'Unknown delivery error').slice(0, 500)
}

function toIso(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

function presentTask(row = {}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    targetTags: parseJson(row.target_tags, []),
    targetChannels: parseJson(row.target_channels, []),
    targetUserIds: parseJson(row.target_user_ids, []),
    accountIds: parseJson(row.account_ids, []),
    scripts: parseJson(row.scripts, []),
    dailyLimit: Number(row.daily_limit || row.dailyLimit || 0),
    intervalSeconds: Number(row.interval_seconds || row.intervalSeconds || 0),
    sendTimeStart: row.send_time_start || null,
    sendTimeEnd: row.send_time_end || null,
    status: row.status,
    totalCount: Number(row.total_count ?? row.totalCount ?? 0),
    pendingCount: Number(row.pending_count ?? row.pendingCount ?? 0),
    successCount: Number(row.success_count ?? row.successCount ?? 0),
    failedCount: Number(row.failed_count ?? row.failedCount ?? 0),
    failCount: Number(row.failed_count ?? row.failedCount ?? 0),
    createdBy: row.created_by ?? row.createdBy ?? null,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null
  }
}

function presentDelivery(row = {}) {
  return {
    id: row.id,
    taskId: row.task_id || row.taskId,
    accountId: Number(row.account_id ?? row.accountId),
    channel: row.channel,
    adapterType: row.adapter_type || row.adapterType || null,
    userId: row.user_id || row.userId,
    scheduledAt: row.scheduled_at || row.scheduledAt,
    status: row.status,
    attemptCount: Number(row.attempt_count || row.attemptCount || 0),
    message: parseJson(row.message_json || row.message, row.message || {}),
    mediaFileIds: parseJson(row.media_file_ids, []),
    channelMessageId: row.channel_message_id || row.channelMessageId || null,
    errorMessage: row.error_message || row.errorMessage || null,
    startedAt: row.started_at || row.startedAt || null,
    sentAt: row.sent_at || row.sentAt || null,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null
  }
}

function taskAccessScope(user = {}) {
  if (['admin', 'supervisor'].includes(user.role)) return { clause: '1=1', replacements: {} }
  const userId = Number(user.id || user.userId)
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return { clause: '1=0', replacements: {} }
  }
  return { clause: 'created_by = :accessUserId', replacements: { accessUserId: userId } }
}

function cleanStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))]
}

function cleanPositiveInts(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value) && value > 0))]
}

function addUniqueTarget(targets, seen, target) {
  const channel = String(target.channel || '').trim().toLowerCase()
  const userId = String(target.userId || target.user_id || '').trim()
  if (!channel || !userId) return targets
  const key = `${channel}:${userId}`
  if (seen.has(key)) return targets
  seen.add(key)
  return [
    ...targets,
    {
      channel,
      userId,
      name: target.name || target.displayName || target.display_name || '',
      customerId: target.customerId || target.customer_id || null,
      variables: { ...(target.variables || {}) }
    }
  ]
}

function createCampaignRepository(sequelize) {
  if (!sequelize || typeof sequelize.query !== 'function') {
    throw new TypeError('sequelize query dependency is required')
  }

  async function getTaskById(id, user, transaction) {
    const scope = taskAccessScope(user)
    const [rows] = await sequelize.query(
      `SELECT *
         FROM campaign_tasks
        WHERE id = :id AND ${scope.clause}
        LIMIT 1`,
      { replacements: { id, ...scope.replacements }, transaction }
    )
    return rows[0] ? presentTask(rows[0]) : null
  }

  return {
    async resolveTargets(config = {}) {
      const channels = cleanStrings(config.targetChannels)
      const targetUserIds = cleanStrings(config.targetUserIds)
      const targetTags = cleanStrings(config.targetTags)
      const seen = new Set()
      let targets = []

      for (const channel of channels) {
        for (const userId of targetUserIds) {
          targets = addUniqueTarget(targets, seen, { channel, userId, name: userId })
        }
      }

      if (targetTags.length > 0 && channels.length > 0) {
        const [rows] = await sequelize.query(
          `SELECT DISTINCT
                  identities.channel AS channel,
                  identities.external_user_id AS user_id,
                  COALESCE(identities.display_name, customers.display_name, customers.phone) AS name,
                  customers.id AS customer_id
             FROM customer_tags AS tags
             JOIN customers ON customers.id = tags.customer_id
             JOIN customer_identities AS identities ON identities.customer_id = customers.id
            WHERE identities.channel IN (:channels)
              AND (tags.tag_key IN (:tags) OR tags.tag_value IN (:tags))
            ORDER BY customers.updated_at DESC, identities.updated_at DESC`,
          { replacements: { channels, tags: targetTags } }
        )
        targets = rows.reduce((items, row) => addUniqueTarget(items, seen, row), targets)
      }

      return targets
    },

    async listActiveAccounts(config = {}) {
      const channels = cleanStrings(config.targetChannels)
      const accountIds = cleanPositiveInts(config.accountIds)
      const conditions = ["status = 'active'"]
      const replacements = {}

      if (channels.length) {
        conditions.push('channel IN (:channels)')
        replacements.channels = channels
      }
      if (accountIds.length) {
        conditions.push('id IN (:accountIds)')
        replacements.accountIds = accountIds
      }

      const [rows] = await sequelize.query(
        `SELECT id, channel, account_name, status, daily_quota, max_daily_quota, adapter_type
           FROM channel_accounts
          WHERE ${conditions.join(' AND ')}
          ORDER BY channel ASC, daily_quota ASC, id ASC`,
        { replacements }
      )

      return rows.map(row => ({
        id: Number(row.id),
        channel: String(row.channel || '').toLowerCase(),
        accountName: row.account_name || null,
        status: row.status,
        dailyQuota: Number(row.daily_quota || 0),
        maxDailyQuota: Number(row.max_daily_quota || 0),
        adapterType: row.adapter_type || null
      }))
    },

    async createTaskWithDeliveries({ task, deliveries }) {
      return sequelize.transaction(async transaction => {
        await sequelize.query(
          `INSERT INTO campaign_tasks
             (id, name, type, target_tags, target_channels, target_user_ids, account_ids, scripts,
              daily_limit, interval_seconds, send_time_start, send_time_end, status, total_count,
              pending_count, success_count, failed_count, created_by, created_at, updated_at)
           VALUES
             (:id, :name, :type, CAST(:targetTags AS JSON), CAST(:targetChannels AS JSON),
              CAST(:targetUserIds AS JSON), CAST(:accountIds AS JSON), CAST(:scripts AS JSON),
              :dailyLimit, :intervalSeconds, :sendTimeStart, :sendTimeEnd, :status, :totalCount,
              :pendingCount, :successCount, :failedCount, :createdBy, NOW(), NOW())`,
          {
            replacements: {
              id: task.id,
              name: task.name,
              type: task.type,
              targetTags: JSON.stringify(task.targetTags || []),
              targetChannels: JSON.stringify(task.targetChannels || []),
              targetUserIds: JSON.stringify(task.targetUserIds || []),
              accountIds: JSON.stringify(task.accountIds || []),
              scripts: JSON.stringify(task.scripts || []),
              dailyLimit: task.dailyLimit,
              intervalSeconds: task.intervalSeconds,
              sendTimeStart: task.sendTimeStart,
              sendTimeEnd: task.sendTimeEnd,
              status: task.status,
              totalCount: task.totalCount,
              pendingCount: task.pendingCount,
              successCount: task.successCount,
              failedCount: task.failedCount,
              createdBy: task.createdBy
            },
            transaction
          }
        )

        for (const delivery of deliveries) {
          await sequelize.query(
            `INSERT INTO campaign_deliveries
               (id, task_id, account_id, channel, user_id, scheduled_at, status, attempt_count,
                message_json, media_file_ids, created_at, updated_at)
             VALUES
               (:id, :taskId, :accountId, :channel, :userId, :scheduledAt, :status, 0,
                CAST(:messageJson AS JSON), CAST(:mediaFileIds AS JSON), NOW(), NOW())`,
            {
              replacements: {
                id: delivery.id,
                taskId: delivery.taskId,
                accountId: delivery.accountId,
                channel: delivery.channel,
                userId: delivery.userId,
                scheduledAt: delivery.scheduledAt,
                status: delivery.status,
                messageJson: JSON.stringify(delivery.message || {}),
                mediaFileIds: JSON.stringify(delivery.mediaFileIds || [])
              },
              transaction
            }
          )
        }

        const [taskRows] = await sequelize.query(
          'SELECT * FROM campaign_tasks WHERE id = :id LIMIT 1',
          { replacements: { id: task.id }, transaction }
        )
        const [deliveryRows] = await sequelize.query(
          `SELECT *
             FROM campaign_deliveries
            WHERE task_id = :id
            ORDER BY scheduled_at ASC, created_at ASC`,
          { replacements: { id: task.id }, transaction }
        )

        return {
          ...presentTask(taskRows[0] || task),
          deliveries: deliveryRows.map(presentDelivery)
        }
      })
    },

    async listTasks({ user = {}, filters = {} } = {}) {
      const page = Math.max(Number(filters.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(filters.pageSize || filters.perPage || 20), 1), 100)
      const replacements = { limit: pageSize, offset: (page - 1) * pageSize }
      const conditions = []
      const access = taskAccessScope(user)
      conditions.push(access.clause)
      Object.assign(replacements, access.replacements)

      if (filters.status) {
        conditions.push('status = :status')
        replacements.status = String(filters.status).trim().toLowerCase()
      }
      if (filters.type) {
        conditions.push('type = :type')
        replacements.type = String(filters.type).trim().toLowerCase()
      }

      const where = `WHERE ${conditions.join(' AND ')}`
      const [rows] = await sequelize.query(
        `SELECT *
           FROM campaign_tasks
          ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT :limit OFFSET :offset`,
        { replacements }
      )
      const [countRows] = await sequelize.query(
        `SELECT COUNT(*) AS total
           FROM campaign_tasks
          ${where}`,
        { replacements }
      )

      return {
        list: rows.map(presentTask),
        total: Number(countRows[0]?.total || 0),
        page,
        pageSize
      }
    },

    async getTask(id, user = {}) {
      const task = await getTaskById(id, user)
      if (!task) return null
      const [deliveryRows] = await sequelize.query(
        `SELECT deliveries.*, accounts.adapter_type
           FROM campaign_deliveries AS deliveries
           LEFT JOIN channel_accounts AS accounts ON accounts.id = deliveries.account_id
          WHERE deliveries.task_id = :id
          ORDER BY deliveries.scheduled_at ASC, deliveries.created_at ASC
          LIMIT 200`,
        { replacements: { id } }
      )
      return {
        ...task,
        deliveries: deliveryRows.map(presentDelivery)
      }
    },

    async updateTaskStatus(id, nextStatus, user = {}) {
      if (!UPDATABLE_TASK_STATUSES.has(nextStatus)) {
        const error = new Error('不支持的任务状态')
        error.statusCode = 400
        throw error
      }

      return sequelize.transaction(async transaction => {
        const current = await getTaskById(id, user, transaction)
        if (!current) {
          const error = new Error('任务不存在或无权访问')
          error.statusCode = 404
          throw error
        }
        if (TERMINAL_TASK_STATUSES.has(current.status)) {
          const error = new Error('任务已结束，不能再修改状态')
          error.statusCode = 409
          throw error
        }
        if (current.status === nextStatus) return current
        if (current.status === 'running' && nextStatus === 'running') return current
        if (current.status === 'paused' && nextStatus === 'paused') return current

        if (nextStatus === 'paused' && current.status !== 'running') {
          const error = new Error('只有运行中的任务可以暂停')
          error.statusCode = 409
          throw error
        }
        if (nextStatus === 'running' && !['draft', 'paused'].includes(current.status)) {
          const error = new Error('只有草稿或暂停任务可以继续')
          error.statusCode = 409
          throw error
        }

        await sequelize.query(
          `UPDATE campaign_tasks
              SET status = :nextStatus,
                  updated_at = NOW()
            WHERE id = :id`,
          { replacements: { id, nextStatus }, transaction }
        )

        if (nextStatus === 'terminated') {
          await sequelize.query(
            `UPDATE campaign_deliveries
                SET status = 'cancelled',
                    error_message = 'task terminated',
                    updated_at = NOW()
              WHERE task_id = :id AND status IN ('scheduled','sending')`,
            { replacements: { id }, transaction }
          )
        }

        return getTaskById(id, user, transaction)
      })
    },

    async claimNextDelivery(now = new Date()) {
      const [rows] = await sequelize.query(
        `SELECT deliveries.*, accounts.adapter_type
           FROM campaign_deliveries AS deliveries
           JOIN campaign_tasks AS tasks ON tasks.id = deliveries.task_id
           LEFT JOIN channel_accounts AS accounts ON accounts.id = deliveries.account_id
          WHERE deliveries.status = 'scheduled'
            AND tasks.status = 'running'
            AND deliveries.scheduled_at <= :now
          ORDER BY deliveries.scheduled_at ASC, deliveries.created_at ASC
          LIMIT 1`,
        { replacements: { now } }
      )
      if (!rows[0]) return null

      const result = await sequelize.query(
        `UPDATE campaign_deliveries
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                started_at = NOW(),
                updated_at = NOW()
          WHERE id = :id AND status = 'scheduled'`,
        { replacements: { id: rows[0].id } }
      )
      if (affectedRows(result) !== 1) return null

      const [claimedRows] = await sequelize.query(
        `SELECT deliveries.*, accounts.adapter_type
           FROM campaign_deliveries AS deliveries
           LEFT JOIN channel_accounts AS accounts ON accounts.id = deliveries.account_id
          WHERE deliveries.id = :id
          LIMIT 1`,
        { replacements: { id: rows[0].id } }
      )
      return claimedRows[0] ? presentDelivery(claimedRows[0]) : presentDelivery(rows[0])
    },

    async reserveAccountQuota(accountId) {
      const result = await sequelize.query(
        `UPDATE channel_accounts
            SET daily_quota = daily_quota + 1,
                updated_at = NOW()
          WHERE id = :accountId
            AND status = 'active'
            AND daily_quota < max_daily_quota`,
        { replacements: { accountId } }
      )
      return affectedRows(result) === 1
    },

    async completeDelivery(id, result = {}) {
      await sequelize.query(
        `UPDATE campaign_deliveries
            SET status = 'sent',
                channel_message_id = :channelMessageId,
                sent_at = NOW(),
                error_message = NULL,
                updated_at = NOW()
          WHERE id = :id`,
        { replacements: { id, channelMessageId: result.channelMessageId || null } }
      )
    },

    async failDelivery(id, errorMessage) {
      await sequelize.query(
        `UPDATE campaign_deliveries
            SET status = 'failed',
                error_message = :errorMessage,
                updated_at = NOW()
          WHERE id = :id`,
        { replacements: { id, errorMessage: truncateError(errorMessage) } }
      )
    },

    async deferDelivery(id, errorMessage, delayMinutes = 5) {
      await sequelize.query(
        `UPDATE campaign_deliveries
            SET status = 'scheduled',
                error_message = :errorMessage,
                scheduled_at = DATE_ADD(NOW(), INTERVAL :delayMinutes MINUTE),
                updated_at = NOW()
          WHERE id = :id`,
        {
          replacements: {
            id,
            errorMessage: truncateError(errorMessage),
            delayMinutes: Math.min(Math.max(Number(delayMinutes) || 5, 1), 1440)
          }
        }
      )
    },

    async refreshTaskCounts(taskId) {
      const [rows] = await sequelize.query(
        `SELECT COUNT(*) AS total_count,
                SUM(CASE WHEN status IN ('scheduled','sending') THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS success_count,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
           FROM campaign_deliveries
          WHERE task_id = :taskId`,
        { replacements: { taskId } }
      )
      const summary = {
        totalCount: Number(rows[0]?.total_count || 0),
        pendingCount: Number(rows[0]?.pending_count || 0),
        successCount: Number(rows[0]?.success_count || 0),
        failedCount: Number(rows[0]?.failed_count || 0)
      }
      const [taskRows] = await sequelize.query(
        'SELECT status FROM campaign_tasks WHERE id = :taskId LIMIT 1',
        { replacements: { taskId } }
      )
      const currentStatus = taskRows[0]?.status || 'running'
      const shouldComplete = !TERMINAL_TASK_STATUSES.has(currentStatus) &&
        currentStatus !== 'paused' &&
        summary.totalCount > 0 &&
        summary.pendingCount === 0
      const nextStatus = shouldComplete ? 'completed' : currentStatus

      await sequelize.query(
        `UPDATE campaign_tasks
            SET total_count = :totalCount,
                pending_count = :pendingCount,
                success_count = :successCount,
                failed_count = :failedCount,
                status = :nextStatus,
                updated_at = NOW()
          WHERE id = :taskId`,
        { replacements: { taskId, nextStatus, ...summary } }
      )
      return { ...summary, status: nextStatus }
    }
  }
}

module.exports = {
  createCampaignRepository,
  presentTask,
  presentDelivery
}
