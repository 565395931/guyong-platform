const test = require('node:test')
const assert = require('node:assert/strict')
const { isManaged, state, recordReply, health, observeBalance } = require('./serviceMonitor')
test('external keys do not query or display balance, even if their API provides one', async () => {
  const config = { baseURL: 'https://api.deepseek.com/v1', apiKey: 'external-test' }
  let queries = 0
  const status = await health({ getRuntimeConfig: async () => config, getBalance: async () => { queries++; return { supported: true, amount: 1 } } })
  assert.equal(queries, 0)
  assert.equal(status.managed, false)
  assert.equal(status.balance, null)
  assert.equal(isManaged('http://provider.thelonelybrave.cn/v1'), false)
  assert.equal(isManaged('https://provider.thelonelybrave.cn.fake/v1'), false)
})
test('three failures share an episode; successful response resets; connection keys isolate state', async () => {
  const config = { baseURL: 'https://api.deepseek.com/v1', apiKey: 'failure-test' }
  const episode = state(config).failureEpisode
  for (let i=0;i<3;i++) await recordReply(false, config)
  assert.equal(state(config).consecutiveReplyFailures, 3)
  assert.equal(state(config).failureEpisode, episode)
  await recordReply(true, config)
  assert.equal(state(config).consecutiveReplyFailures, 0)
  assert.notEqual(state(config).failureEpisode, episode)
  assert.equal(state({ ...config, apiKey:'other-test' }).consecutiveReplyFailures, 0)
})
test('managed response headers and polling reflect balance edits; unknown balance stays null', async () => {
  const config = { baseURL: 'https://provider.thelonelybrave.cn/v1', apiKey:'wallet-test' }
  observeBalance(config, { headers:new Headers({ 'x-model-balance':'9000000000', 'x-model-balance-unit':'1000000000' }) })
  assert.equal(state(config).balance, 9)
  const result = await health({ getRuntimeConfig: async () => config, getBalance: async () => ({ supported:true, amount: '100.000000' }) })
  assert.equal(result.balance, 100)
  const missing = await health({ getRuntimeConfig: async () => config, getBalance: async () => { throw Error('offline') } })
  assert.equal(missing.balance, null)
})

test('unrecognized credential at managed endpoint is treated as an external configuration', async () => {
  const config = { baseURL: 'https://provider.thelonelybrave.cn/v1', apiKey:'invalid-key-test' }
  const result = await health({ getRuntimeConfig: async () => config, getBalance: async () => ({ supported:false, managed:false }) })
  assert.equal(result.managed, false)
  assert.equal(result.balance, null)
})
