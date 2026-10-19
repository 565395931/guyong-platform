// Deployment smoke test: credential arrives on stdin and is saved by the authorized API.
require('dotenv').config({ quiet: true })
const jwt = require('jsonwebtoken')
const { sequelize } = require('../src/config/database')
const { JWT_ISSUER, JWT_AUDIENCE } = require('../src/config/jwt')
async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const settings = JSON.parse(input)
  const [users] = await sequelize.query("SELECT id,username FROM users WHERE role='admin' AND status='active' ORDER BY id LIMIT 1")
  if (!users.length) throw new Error('没有可用的本地管理员')
  const token = jwt.sign({ id: users[0].id, username: users[0].username, role: 'admin' }, process.env.JWT_SECRET, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '10m' })
  async function api(path, method = 'GET', body) {
    const response = await fetch('http://127.0.0.1:3001/api/v1/' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) })
    const result = await response.json()
    if (!response.ok || result.success === false) throw new Error(result.message || '本地接口失败')
    return result.data
  }
  if (process.argv.includes('--restart')) {
    const old = await api('system-control/status')
    await api('system-control/restart-backend', 'POST', {})
    let restarted = false
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try { const status = await api('system-control/status'); if (status.pid !== old.pid) { restarted = true; break } } catch {}
    }
    if (!restarted) throw new Error('本地后端尚未恢复')
  }
  const status = await api('conversations/ai-provider', 'PUT', { baseUrl: settings.baseUrl, model: 'customer-auto', apiKey: settings.apiKey })
  if (status.provider?.model !== 'customer-auto') throw new Error('本地连接配置尚未生效')
  const models = await api('conversations/ai-provider/models/sync', 'POST', {})
  const probe = await api('conversations/ai-provider/test', 'POST', {})
  let streamVerified = false
  if (process.argv.includes('--stream-smoke')) {
    const { createChatModel } = require('../src/modules/rag/langchainService')
    const { HumanMessage } = require('@langchain/core/messages')
    const chat = await createChatModel({ model: 'legacy-task-model', maxTokens: 128, temperature: 0, streaming: true })
    let text = ''
    for await (const chunk of await chat.stream([new HumanMessage('这是本地流式接口测试，只回复：本地连接成功。')])) text += typeof chunk.content === 'string' ? chunk.content : ''
    if (!text.trim()) throw new Error('本地流式模型返回为空')
    streamVerified = true
  }
  const wallet = await api('conversations/ai-provider/balance')
  console.log(JSON.stringify({ configured: status.credential?.configured, baseUrl: status.provider?.baseURL, model: status.provider?.model, models: models.models, connection: probe.ok, streamVerified, balance: wallet.amount, currency: wallet.currency }))
}
main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 }).finally(async () => { await sequelize.close(); process.exit(process.exitCode || 0) })
