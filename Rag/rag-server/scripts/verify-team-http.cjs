// Local HTTP verification. The initial password is supplied only through the environment.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const { sequelize } = require('../src/config/database')
const jwt = require('jsonwebtoken')
const { JWT_SECRET, JWT_ISSUER, JWT_AUDIENCE, JWT_ALGORITHMS } = require('../src/config/jwt')
const { io } = require('../../platform-web/node_modules/socket.io-client')

async function main() {
  const origin = process.env.TEAM_TEST_ORIGIN || 'http://127.0.0.1:3001'
  const password = process.env.TEAM_TEST_PASSWORD
  if (!password) throw new Error('TEAM_TEST_PASSWORD is required')
  const sockets = [], sessions = []
  let createdId, originalPreference, chosenShared
  async function call(path, session, method = 'GET', body) {
    const response = await fetch(`${origin}${path}`, { method, headers: {
      'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.token}` } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    for (const username of ['kefu01', 'kefu02', 'kefu03']) {
      const login = await call('/api/auth/login', null, 'POST', { username, password })
      assert.equal(login.status, 200)
      assert.equal(login.body.data.user.role, 'agent')
      sessions.push(login.body.data)
    }
    // Connection-only checks: no customer messages and no conversation ownership changes.
    for (const session of sessions.slice(1)) {
      const socket = io(origin, { transports: ['websocket'], auth: { token: session.token }, reconnection: false })
      sockets.push(socket)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket connect timed out')), 5000)
        socket.once('connect', () => { clearTimeout(timer); resolve() })
        socket.once('connect_error', error => { clearTimeout(timer); reject(error) })
      })
    }
    const [admins] = await sequelize.query("SELECT id, username FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1")
    assert.ok(admins[0])
    const admin = { token: jwt.sign({ id: admins[0].id, username: admins[0].username, role: 'admin' }, JWT_SECRET,
      { expiresIn: '5m', algorithm: JWT_ALGORITHMS[0], issuer: JWT_ISSUER, audience: JWT_AUDIENCE }) }
    const adminAccounts = await call('/api/v1/system-accounts', admin)
    assert.equal(adminAccounts.status, 200)
    assert.ok(adminAccounts.body.data.every(row => !Object.hasOwn(row, 'password')))
    assert.equal((await call('/api/v1/conversations/ai-config', admin)).status, 200)
    const general=await call('/api/v1/conversations/general-settings',admin)
    assert.equal(general.status,200);assert.equal(typeof general.body.data.handoffNoticeEnabled,'boolean')
    assert.equal((await call('/api/v1/conversations/general-settings',sessions[1])).status,403)
    assert.deepEqual((await call('/api/v1/conversations/assignable-seats?account_id=2147483647',admin)).body.data,[])
    const a = sessions[1], b = sessions[2]
    assert.equal((await call('/api/v1/conversations/ai-config', a)).status, 403)
    assert.equal((await call('/api/v1/system-accounts', a)).status, 403)
    const channels = await call('/api/v1/channel-accounts', a)
    assert.equal(channels.status, 200)
    assert.ok(channels.body.data.every(row => !Object.hasOwn(row, 'config')))
    for(const pool of ['ai_self','pending_human','private']) {
      const list=await call('/api/v1/conversations?pool_type='+pool,a)
      assert.equal(list.status,200)
      assert.ok(list.body.data.list.every(row=>row.status !== 'closed' && row.conv_status !== 'archived'))
      if(pool === 'pending_human') assert.ok(list.body.data.list.every(row=>Number(row.agent_id)===a.user.id))
    }
    const availability = await call('/api/v1/conversations/seat-status', a)
    assert.equal(availability.status, 200)
    assert.equal(availability.body.data.status, 'online')
    assert.equal((await call('/api/v1/conversations/seat-status', a, 'POST', { status: 'away' })).status, 400)
    assert.equal((await call('/api/v1/conversations/seat-status', a, 'POST', { status: 'offline' })).status, 200)
    sockets[0].disconnect()
    const reconnected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Reconnect timed out')), 5000)
      sockets[0].once('connect', () => { clearTimeout(timer); resolve() })
    })
    sockets[0].connect(); await reconnected
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal((await call('/api/v1/conversations/seat-status', a)).body.data.status, 'offline')
    assert.equal((await call('/api/v1/conversations/seat-status', a, 'POST', { status: 'online' })).status, 200)
    const payload = { title: '内部验证', shortcut: `/qa_${Date.now()}`, content: '测试话术，不发送客户', isEnabled: true }
    const created = await call('/api/v1/quick-replies', a, 'POST', payload)
    assert.equal(created.status, 200)
    createdId = created.body.data.id
    const own = await call('/api/v1/quick-replies?pageSize=100', a)
    const foreign = await call('/api/v1/quick-replies?pageSize=100', b)
    assert.ok(own.body.data.list.some(row => row.id === createdId))
    assert.ok(!foreign.body.data.list.some(row => row.id === createdId))
    assert.equal((await call(`/api/v1/quick-replies/${createdId}`, b, 'PUT', payload)).status, 404)
    chosenShared = own.body.data.list.find(row => row.createdBy == null)
    if (chosenShared) {
      const [preferences] = await sequelize.query('SELECT * FROM quick_reply_overrides WHERE user_id = :userId AND reply_id = :replyId', { replacements: { userId: a.user.id, replyId: chosenShared.id } })
      originalPreference = preferences[0] || null
      assert.equal((await call(`/api/v1/quick-replies/${chosenShared.id}`, a, 'PUT', { ...chosenShared, content: '仅自己可见的测试修改', shared: false })).status, 200)
      const unchanged = await call('/api/v1/quick-replies?pageSize=100', b)
      assert.notEqual(unchanged.body.data.list.find(row => row.id === chosenShared.id)?.content, '仅自己可见的测试修改')
      assert.equal((await call(`/api/v1/quick-replies/${chosenShared.id}`, a, 'DELETE')).status, 200)
      const stillVisible = await call('/api/v1/quick-replies?pageSize=100', b)
      assert.ok(stillVisible.body.data.list.some(row => row.id === chosenShared.id))
    }
    console.log(JSON.stringify({ passed: true, accountsLoggedIn: 3, socketsConnected: 2, aiAndAccountsDenied: true, channelCredentialsHidden: true, personalRepliesIsolated: true, explicitOfflineSurvivesReconnect: true, adminManagementAllowed: true, generalSettingsRestricted: true, pendingStatesConsistent: true, realMessagesSent: 0 }))
  } finally {
    if (createdId) await call(`/api/v1/quick-replies/${createdId}`, sessions[1], 'DELETE')
    if (chosenShared) {
      const replacements = { userId: sessions[1].user.id, replyId: chosenShared.id }
      await sequelize.query('DELETE FROM quick_reply_overrides WHERE user_id = :userId AND reply_id = :replyId', { replacements })
      if (originalPreference) await sequelize.query('INSERT INTO quick_reply_overrides (user_id, reply_id, hidden, payload, updated_at) VALUES (:userId, :replyId, :hidden, :payload, :updatedAt)', {
        replacements: { ...replacements, hidden: originalPreference.hidden, payload: originalPreference.payload == null ? null : JSON.stringify(originalPreference.payload), updatedAt: originalPreference.updated_at }
      })
    }
    for (const socket of sockets) socket.disconnect()
    await sequelize.close()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
