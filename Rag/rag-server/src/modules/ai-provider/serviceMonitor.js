const crypto = require('crypto')
const states = new Map()
function isManaged(baseURL) {
  try { const url = new URL(baseURL); return url.protocol === 'https:' && url.hostname === 'provider.thelonelybrave.cn' && url.pathname.replace(/\/$/, '') === '/v1' } catch { return false }
}
function connectionId(config) { return crypto.createHash('sha256').update(config.baseURL + '\0' + config.apiKey).digest('hex').slice(0, 24) }
function state(config) {
  const id = connectionId(config)
  if (!states.has(id)) states.set(id, { connectionId: id, consecutiveReplyFailures: 0, failureEpisode: crypto.randomUUID(), balance: null, updatedAt: null })
  return states.get(id)
}
function observeBalance(config, response) {
  if (!isManaged(config.baseURL)) return
  const raw = response.headers.get('x-model-balance'), unit = response.headers.get('x-model-balance-unit')
  if (raw !== null && Number.isSafeInteger(Number(raw)) && Number(unit) === 1e9) {
    Object.assign(state(config), { balance: Number(raw) / 1e9, updatedAt: new Date().toISOString() })
  }
}
async function currentConfiguration(service) {
  try { return await service.getRuntimeConfig() }
  catch {
    try { const status = await service.getStatus(); return { baseURL: status.provider.baseURL, apiKey: '' } }
    catch { return { baseURL: 'unconfigured', apiKey: '' } }
  }
}
async function recordReply(success, configuration) {
  try {
    const config = configuration || await currentConfiguration(require('./providerService').getProviderService())
    const current = state(config)
    if (success) { current.consecutiveReplyFailures = 0; current.failureEpisode = crypto.randomUUID() }
    else current.consecutiveReplyFailures++
  } catch {}
}
async function health(service) {
  const config = await currentConfiguration(service)
  const current = state(config)
  let managed = Boolean(config.apiKey) && isManaged(config.baseURL)
  if (managed) {
    try {
      const wallet = await service.getBalance()
      managed = wallet.managed !== false
      current.balance = wallet.supported ? Number(wallet.amount) : null
      current.updatedAt = new Date().toISOString()
    } catch { current.balance = null }
  }
  return { ...current, managed, balance: managed ? current.balance : null }
}
module.exports = { isManaged, connectionId, state, observeBalance, recordReply, health }
