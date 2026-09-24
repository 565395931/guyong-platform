const test = require('node:test')
const assert = require('node:assert/strict')

const { shouldEnableCloudGateway } = require('./startup')

test('enables the local cloud gateway automatically when a development token is available', () => {
  assert.equal(shouldEnableCloudGateway({
    env: { NODE_ENV: 'development' },
    credential: { configured: true, source: 'local_gateway_file' }
  }), true)
})

test('keeps the local cloud gateway disabled when development credentials are missing', () => {
  assert.equal(shouldEnableCloudGateway({
    env: { NODE_ENV: 'development' },
    credential: { configured: false, source: 'local_gateway_file_missing' }
  }), false)
})

test('does not auto-enable the cloud gateway in production', () => {
  assert.equal(shouldEnableCloudGateway({
    env: { NODE_ENV: 'production' },
    credential: { configured: true, source: 'environment' }
  }), false)
})

test('honors an explicit cloud gateway switch before local auto-detection', () => {
  assert.equal(shouldEnableCloudGateway({
    env: { NODE_ENV: 'development', CLOUD_GATEWAY_ENABLED: 'false' },
    credential: { configured: true, source: 'local_gateway_file' }
  }), false)

  assert.equal(shouldEnableCloudGateway({
    env: { NODE_ENV: 'production', CLOUD_GATEWAY_ENABLED: 'true' },
    credential: { configured: false, source: 'unconfigured' }
  }), true)
})
