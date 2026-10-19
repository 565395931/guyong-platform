const express = require('express')
const { createAuthenticate } = require('../middleware/authenticate')
const router = express.Router()
router.use(createAuthenticate())
router.use((req, res, next) => ['admin'].includes(req.user.role) || (req.method === 'GET' && req.path.startsWith('/media/') && req.user.role === 'agent') ? next() : res.status(403).json({ success: false, message: '仅管理员可管理远端连接' }))
router.get('/', (req, res) => res.json({ success: true, data: req.app.get('localShopConnection').status() }))
router.post('/pair', async (req, res) => {
  try { res.json({ success: true, data: await req.app.get('localShopConnection').pair(req.body.code) }) }
  catch (error) { res.status(400).json({ success: false, message: error.message }) }
})
router.post('/:id/disconnect', async (req, res) => {
  try { await req.app.get('localShopConnection').disconnect(req.params.id); res.json({ success: true }) }
  catch (error) { res.status(400).json({ success: false, message: error.message }) }
})
router.get('/media/:accountId/:messageId', async (req, res) => {
  try {
    const { sequelize } = require('../config/database')
    // Require a stored message and the same seat/account boundary as the inbox.
    const access = req.user.role === 'agent' ? `AND c.account_id IN (SELECT account_id FROM seat_account_bindings WHERE seat_id = :seatId AND status = 'active')
      AND (c.claimed_by = :seatId OR c.agent_id = :seatId)` : ''
    const [rows] = await sequelize.query(`SELECT m.id FROM plat_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.account_id = :accountId AND m.direction = 'inbound'
      AND JSON_UNQUOTE(JSON_EXTRACT(m.content, '$.shopContext.cloudMessageId')) = :messageId ${access} LIMIT 1`,
    { replacements: { accountId: Number(req.params.accountId), messageId: req.params.messageId, seatId: req.user.id || req.user.userId } })
    if (!rows.length) return res.status(404).end()
    const image = await req.app.get('localShopConnection').image(Number(req.params.accountId), req.params.messageId)
    res.set({ 'Content-Type': image.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(image.buffer)
  } catch { res.status(404).json({ success: false, message: '图片暂时无法读取' }) }
})
module.exports = router
