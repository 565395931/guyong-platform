function hasExplicitSwitch(env = {}) {
  return Object.prototype.hasOwnProperty.call(env, 'CLOUD_GATEWAY_ENABLED')
}

function parseExplicitSwitch(value) {
  return String(value).trim().toLowerCase() === 'true'
}

function isProduction(env = {}) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
}

function shouldEnableCloudGateway({ env = process.env, credential = {} } = {}) {
  if (hasExplicitSwitch(env)) return parseExplicitSwitch(env.CLOUD_GATEWAY_ENABLED)
  return !isProduction(env) && Boolean(credential.configured)
}

module.exports = { shouldEnableCloudGateway }
