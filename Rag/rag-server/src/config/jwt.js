const JWT_EXPIRE = '7d'
const JWT_ISSUER = 'rag-server'
const JWT_AUDIENCE = 'platform-web'
const JWT_ALGORITHMS = Object.freeze(['HS256'])

function resolveJwtConfig(environment = process.env) {
  const secret = String(environment.JWT_SECRET || '').trim()
  if (!secret) throw new Error('JWT_SECRET is required')
  return {
    secret,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: [...JWT_ALGORITHMS],
    expiresIn: JWT_EXPIRE
  }
}

function resolveJwtSecret(environment = process.env) {
  return resolveJwtConfig(environment).secret
}

// Route factories may inject a test secret; production has no fallback secret.
const JWT_SECRET = String(process.env.JWT_SECRET || '').trim() || undefined

module.exports = {
  JWT_SECRET,
  JWT_EXPIRE,
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_ALGORITHMS,
  resolveJwtConfig,
  resolveJwtSecret
}
