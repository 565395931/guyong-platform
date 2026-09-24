const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const { createAuthRouter, createCaptchaChallenge } = require('./auth')

async function withServer(router, callback) {
  const app = express()
  app.use(express.json())
  app.use(router)
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  try {
    const { port } = server.address()
    await callback(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('allows login without a captcha when captcha protection is disabled', async () => {
  const admin = {
    id: 1,
    username: 'admin',
    email: 'admin@test.local',
    role: 'admin',
    status: 'active',
    password: bcrypt.hashSync('secret-pass', 10)
  }
  const router = createAuthRouter({
    jwtSecret: 'auth-test-secret',
    User: {
      findOne: async ({ where }) => (where.username === admin.username ? admin : null)
    }
  })

  await withServer(router, async base => {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret-pass' })
    })

    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.success, true)
    assert.equal(body.data.user.username, 'admin')
    assert.ok(body.data.token)
  })
})

test('issues a captcha challenge and requires it for login', async () => {
  const secret = 'auth-test-secret'
  const admin = {
    id: 1,
    username: 'admin',
    email: 'admin@test.local',
    role: 'admin',
    status: 'active',
    password: bcrypt.hashSync('secret-pass', 10)
  }
  const captchaToken = jwt.sign({ code: 'AB12' }, secret, { expiresIn: '5m' })
  const router = createAuthRouter({
    jwtSecret: secret,
    captchaEnabled: true,
    User: {
      findOne: async ({ where }) => (where.username === admin.username ? admin : null)
    },
    createCaptchaChallenge: () => ({
      captchaToken,
      captchaCode: 'AB12',
      captchaImage: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    })
  })

  await withServer(router, async base => {
    const captchaResponse = await fetch(`${base}/captcha`)
    assert.equal(captchaResponse.status, 200)
    const captchaBody = await captchaResponse.json()
    assert.equal(captchaBody.success, true)
    assert.equal(captchaBody.data.captchaToken, captchaToken)
    assert.match(captchaBody.data.captchaImage, /^data:image\/svg\+xml;base64,/)

    const missingCaptcha = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'secret-pass' })
    })
    assert.equal(missingCaptcha.status, 400)

    const wrongCaptcha = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'secret-pass',
        captchaToken,
        captchaCode: 'ZZZZ'
      })
    })
    assert.equal(wrongCaptcha.status, 400)

    const success = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'admin',
        password: 'secret-pass',
        captchaToken,
        captchaCode: 'AB12'
      })
    })
    assert.equal(success.status, 200)
    const body = await success.json()
    assert.equal(body.success, true)
    assert.equal(body.data.user.username, 'admin')
    assert.ok(body.data.token)
  })
})

test('captcha SVG keeps text inside the visible canvas with safe margins', () => {
  const challenge = createCaptchaChallenge({ jwtSecret: 'captcha-layout-secret' })
  const svg = Buffer.from(challenge.captchaImage.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8')
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  assert.ok(viewBox, 'captcha SVG should define a numeric viewBox')
  const width = Number(viewBox[1])
  const height = Number(viewBox[2])
  const xValues = [...svg.matchAll(/<text x="(\d+)"/g)].map(match => Number(match[1]))

  assert.equal(height, 48)
  assert.equal(xValues.length, 4)
  assert.ok(width >= 156, 'captcha canvas should be wide enough for rotated glyphs')
  assert.ok(Math.max(...xValues) <= width - 34, 'last glyph should not be placed on the right edge')
})

test('disabled users cannot use existing tokens for profile or password changes', async () => {
  const secret = 'disabled-user-secret'
  const disabledUser = {
    id: 8,
    username: 'disabled-seat',
    role: 'agent',
    status: 'disabled',
    password: bcrypt.hashSync('old-password', 10)
  }
  const token = jwt.sign(
    { id: disabledUser.id, username: disabledUser.username, role: disabledUser.role },
    secret,
    { algorithm: 'HS256', issuer: 'rag-server', audience: 'platform-web' }
  )
  const router = createAuthRouter({
    jwtSecret: secret,
    User: { findByPk: async () => disabledUser }
  })

  await withServer(router, async base => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const profile = await fetch(`${base}/me`, { headers })
    assert.equal(profile.status, 401)

    const password = await fetch(`${base}/change-password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ oldPassword: 'old-password', newPassword: 'new-password' })
    })
    assert.equal(password.status, 401)
  })
})

test('public registration is disabled by default', async () => {
  const router = createAuthRouter({
    jwtSecret: 'registration-disabled-secret',
    User: { findOne: async () => null }
  })
  await withServer(router, async base => {
    const response = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'new-user', password: 'safe-password' })
    })
    assert.equal(response.status, 403)
  })
})

test('first-run setup creates the only owner and then locks itself', async () => {
  const users = []
  const router = createAuthRouter({
    jwtSecret: 'setup-secret',
    User: {
      count: async () => users.length,
      create: async input => { const user = { id: users.length + 1, ...input }; users.push(user); return user }
    }
  })
  await withServer(router, async base => {
    assert.equal((await (await fetch(`${base}/setup-status`)).json()).data.needsSetup, true)
    const created = await fetch(`${base}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'owner-pass-123' })
    })
    assert.equal(created.status, 201)
    assert.equal(users[0].role, 'admin')
    assert.equal(await bcrypt.compare('owner-pass-123', users[0].password), true)
    assert.equal((await (await fetch(`${base}/setup-status`)).json()).data.needsSetup, false)
    assert.equal((await fetch(`${base}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'second', password: 'another-pass-123' })
    })).status, 409)
  })
})

test('explicitly enabled public registration cannot self-select a privileged role', async () => {
  let createdInput = null
  const router = createAuthRouter({
    jwtSecret: 'registration-role-secret',
    publicRegistrationEnabled: true,
    User: {
      findOne: async () => null,
      create: async input => {
        createdInput = input
        return { id: 21, ...input }
      }
    }
  })

  await withServer(router, async base => {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'new-user', password: 'safe-password', role: 'admin' })
    })
    assert.equal(response.status, 200)
    assert.equal(createdInput.role, 'agent')
    assert.equal((await response.json()).data.user.role, 'agent')
  })
})
