const crypto = require('crypto')

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex'), minimumLength = 12) {
  if (String(password || '').length < minimumLength) throw Object.assign(new Error(`password must contain at least ${minimumLength} characters`), { code: 'weak_password' })
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `scrypt:${salt}:${hash}`
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded || '').split(':')
  if (algorithm !== 'scrypt' || !salt || !expected) return false
  const actual = crypto.scryptSync(String(password || ''), salt, 64)
  const target = Buffer.from(expected, 'hex')
  return actual.length === target.length && crypto.timingSafeEqual(actual, target)
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function createOpaqueToken(prefix = 'lw') {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`
}

function signSession(payload, secret, ttlSeconds = 8 * 60 * 60) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

function verifySession(value, secret) {
  const [body, signature] = String(value || '').split('.')
  if (!body || !signature) return null
  const expected = crypto.createHmac('sha256', secret).update(body).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return Number(payload.exp) > Math.floor(Date.now() / 1000) ? payload : null
  } catch {
    return null
  }
}

module.exports = { hashPassword, verifyPassword, hashToken, createOpaqueToken, signSession, verifySession }
