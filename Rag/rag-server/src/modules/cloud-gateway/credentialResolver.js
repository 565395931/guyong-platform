const fs = require('fs')
const path = require('path')

const DEFAULT_LOCAL_TOKEN_FILE = path.resolve(
  __dirname,
  '..', '..', '..', '..', '..',
  'wehook', 'data', 'gateway-auth-token.txt'
)

function cleanToken(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readTokenFile(filePath) {
  const token = cleanToken(fs.readFileSync(filePath, 'utf8'))
  if (!token) throw new Error('token file is empty')
  if (Buffer.byteLength(token, 'utf8') > 4096) throw new Error('token file is too large')
  return token
}

function resolveCloudGatewayCredential(env = process.env, options = {}) {
  const preferMockToken = Boolean(options.preferMockToken)
  const mockToken = preferMockToken ? cleanToken(env.CLOUD_GATEWAY_MOCK_TOKEN) : ''
  if (mockToken) {
    return { token: mockToken, configured: true, source: 'mock_environment' }
  }

  const environmentToken = cleanToken(env.CLOUD_GATEWAY_AUTH_TOKEN)
  if (environmentToken) {
    return { token: environmentToken, configured: true, source: 'environment' }
  }

  const configuredTokenFile = cleanToken(env.CLOUD_GATEWAY_AUTH_TOKEN_FILE)
  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production'
  const tokenFile = configuredTokenFile || (!isProduction ? options.defaultTokenFile || DEFAULT_LOCAL_TOKEN_FILE : '')
  if (!tokenFile) {
    return { token: '', configured: false, source: 'unconfigured' }
  }

  try {
    return {
      token: readTokenFile(path.resolve(tokenFile)),
      configured: true,
      source: configuredTokenFile ? 'configured_file' : 'local_gateway_file'
    }
  } catch (error) {
    return {
      token: '',
      configured: false,
      source: configuredTokenFile ? 'configured_file_error' : 'local_gateway_file_missing',
      error: error.code || error.message
    }
  }
}

module.exports = {
  DEFAULT_LOCAL_TOKEN_FILE,
  resolveCloudGatewayCredential
}
