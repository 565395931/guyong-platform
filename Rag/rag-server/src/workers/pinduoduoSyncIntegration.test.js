const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const databaseSource = fs.readFileSync(
  path.join(__dirname, '..', 'config', 'database.js'),
  'utf8'
)
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')

test('database bootstrap creates channel sync state after connecting', () => {
  assert.match(databaseSource, /require\(['"]\.\.\/modules\/channel-sync\/channelSyncState\.schema['"]\)/)
  assert.match(databaseSource, /await ensureChannelSyncStateSchema\(sequelize\)/)
})

test('application starts the Pinduoduo worker only after connectDB resolves', () => {
  assert.match(appSource, /require\(['"]\.\/workers\/pinduoduoSyncWorker['"]\)/)
  const connectStart = appSource.indexOf('connectDB().then')
  const workerStart = appSource.lastIndexOf('initPinduoduoSyncWorker({')
  assert.notEqual(connectStart, -1)
  assert.equal(workerStart > connectStart, true)
  assert.match(appSource, /process\.env\.NODE_ENV\s*!==\s*['"]test['"]/)
})
