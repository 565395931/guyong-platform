const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'authorization-http-test-secret'

const User = require('../models/User')
const { sequelize } = require('../config/database')
const customerRoutes = require('./customers')
const conversationRoutes = require('./conversations')
const { aiReplyQueue, aiReplyQueueEvents } = require('../queues')
const { redisClient, pubClient, subClient } = require('../config/redis')

const TEST_SECRET = process.env.JWT_SECRET
const users = new Map([
  [10, { id: 10, username: 'legacy-user', role: 'user', status: 'active' }],
  [11, { id: 11, username: 'agent', role: 'agent', status: 'active' }],
  [12, { id: 12, username: 'supervisor', role: 'supervisor', status: 'active' }],
  [13, { id: 13, username: 'admin', role: 'admin', status: 'active' }]
])

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    TEST_SECRET,
    { algorithm: 'HS256', issuer: 'rag-server', audience: 'platform-web' }
  )
}

function affected(count) {
  return [{ affectedRows: count }, { affectedRows: count }]
}

function isOwnObject(id, viewerId) {
  return String(id) === `own-${viewerId}`
}

async function queryDouble(sql, options = {}) {
  const replacements = options.replacements || {}
  const compact = String(sql).replace(/\s+/g, ' ').trim()

  if (/UPDATE customers c SET/.test(compact)) {
    const allowed = replacements.viewerId === undefined
      || isOwnObject(replacements.id, replacements.viewerId)
    return affected(allowed ? 1 : 0)
  }
  if (/SELECT c\.id FROM conversations c WHERE/.test(compact)) {
    return [isOwnObject(replacements.conversationId, replacements.visibilityUserId)
      ? [{ id: replacements.conversationId }]
      : []]
  }
  if (/SELECT id FROM conversations WHERE id = :conversationId/.test(compact)) {
    return [[{ id: replacements.conversationId }]]
  }
  if (/FROM users/.test(compact) && /seat_account_bindings/.test(compact)) {
    const assignable = Number(replacements.id) === 20
      && !String(replacements.conversationId).includes('unbound')
    return [assignable ? [{ id: 20, username: 'target-agent' }] : []]
  }
  if (/UPDATE conversations SET/.test(compact)) return affected(1)
  throw new Error(`Unexpected authorization test query: ${compact.slice(0, 160)}`)
}

async function withServer(callback) {
  const app = express()
  app.use(express.json())
  app.use('/customers', customerRoutes)
  app.use('/conversations', conversationRoutes)
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function request(base, userId, path, body) {
  return fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${createToken(users.get(userId))}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

test('HTTP authorization matrix scopes customers and conversations for all four roles', async t => {
  const originalFindByPk = User.findByPk
  const originalQuery = sequelize.query
  User.findByPk = async id => users.get(Number(id)) || null
  sequelize.query = queryDouble
  t.after(() => {
    User.findByPk = originalFindByPk
    sequelize.query = originalQuery
  })

  await withServer(async base => {
    for (const userId of [10, 11]) {
      const ownCustomer = await fetch(`${base}/customers/own-${userId}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${createToken(users.get(userId))}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ phone: '10086' })
      })
      assert.equal(ownCustomer.status, 200)

      const foreignCustomer = await fetch(`${base}/customers/foreign`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${createToken(users.get(userId))}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ phone: '10086' })
      })
      assert.equal(foreignCustomer.status, 404)

      const foreignConversation = await request(base, userId, '/conversations/foreign', { status: 'open' })
      assert.equal(foreignConversation.status, 404)

      const reassign = await request(base, userId, `/conversations/own-${userId}`, { agent_id: 20 })
      assert.equal(reassign.status, 403)
    }

    for (const userId of [12, 13]) {
      const customer = await fetch(`${base}/customers/foreign`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${createToken(users.get(userId))}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ phone: '10086' })
      })
      assert.equal(customer.status, 200)

      const conversation = await request(base, userId, '/conversations/foreign', { status: 'open' })
      assert.equal(conversation.status, 200)
    }

    const validAssignment = await request(base, 12, '/conversations/foreign', { agent_id: 20 })
    assert.equal(validAssignment.status, 200)

    const unboundAssignment = await request(base, 12, '/conversations/unbound', { agent_id: 20 })
    assert.equal(unboundAssignment.status, 400)

    const syncHeaders = {
      authorization: `Bearer ${createToken(users.get(13))}`,
      'content-type': 'application/json'
    }
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      const firstAuditFailure = await fetch(`${base}/conversations/sync-all-history`, {
        method: 'POST', headers: syncHeaders, body: '{}'
      })
      assert.equal(firstAuditFailure.status, 500)
      const secondAuditFailure = await fetch(`${base}/conversations/sync-all-history`, {
        method: 'POST', headers: syncHeaders, body: '{}'
      })
      assert.equal(secondAuditFailure.status, 500, 'failed audit must not leave a pending sync job')
    } finally {
      console.error = originalConsoleError
    }
  })
})

test.after(async () => {
  await Promise.allSettled([
    aiReplyQueue.close(),
    aiReplyQueueEvents.close(),
    redisClient.quit(),
    pubClient.quit(),
    subClient.quit()
  ])
})
