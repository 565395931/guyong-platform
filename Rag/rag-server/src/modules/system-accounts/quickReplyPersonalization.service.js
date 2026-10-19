const crypto = require('crypto')

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }
function parsePayload(value) { return typeof value === 'string' ? JSON.parse(value) : value || {} }
function visibleReplies(base, personal, overrides, userId) {
  const preferences = new Map(overrides.map(row => [row.reply_id, row]))
  const shared = base.filter(row => row.createdBy == null || Number(row.createdBy) === Number(userId))
    .filter(row => !preferences.get(row.id)?.hidden)
    .map(row => ({ ...row, ...parsePayload(preferences.get(row.id)?.payload),
      id: row.id, createdBy: row.createdBy, isPersonalized: Boolean(preferences.get(row.id)?.payload) }))
  return [...shared, ...personal.map(row => ({ ...parsePayload(row.payload), id: row.id,
    createdBy: Number(userId), createdAt: row.created_at, updatedAt: row.updated_at, isPersonalized: true }))]
}

function createQuickReplyPersonalizationService(repository) {
  async function listAll(actor) {
    const [base, personal, overrides] = await Promise.all([
      repository.base(actor.id), repository.personal(actor.id), repository.overrides(actor.id)
    ])
    return visibleReplies(base, personal, overrides, actor.id)
  }
  async function find(actor, id) {
    return (await listAll(actor)).find(row => row.id === id) || fail('话术不存在', 404)
  }
  return {
    async list(actor, query = {}) {
      let rows = await listAll(actor)
      const keyword = String(query.keyword || '').trim().toLowerCase()
      if (keyword) rows = rows.filter(row => [row.title, row.shortcut, row.content, row.category]
        .some(value => String(value || '').toLowerCase().includes(keyword)))
      if (query.category) rows = rows.filter(row => row.category === query.category)
      if (['true', '1'].includes(query.enabledOnly)) rows = rows.filter(row => row.isEnabled)
      rows.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
        || String(a.shortcut).localeCompare(String(b.shortcut)))
      const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 100)
      const offset = (Math.max(Number(query.page) || 1, 1) - 1) * pageSize
      return { list: rows.slice(offset, offset + pageSize), total: rows.length }
    },
    async create(actor, payload, shared = false) {
      if (shared && actor.role !== 'admin') fail('仅管理员可修改公共库', 403)
      if ((await listAll(actor)).some(row => row.shortcut === payload.shortcut)) fail('触发词已存在', 409)
      const id = crypto.randomUUID()
      if (shared) await repository.createShared(id, payload, actor.id)
      else await repository.createPersonal(id, payload, actor.id)
      return find(actor, id)
    },
    async update(actor, id, payload, shared = false) {
      const existing = await find(actor, id)
      if (shared && actor.role !== 'admin') fail('仅管理员可修改公共库', 403)
      if ((await listAll(actor)).some(row => row.id !== id && row.shortcut === payload.shortcut)) fail('触发词已存在', 409)
      if (await repository.isPersonal(id, actor.id)) await repository.updatePersonal(id, payload, actor.id)
      else if (shared && existing.createdBy == null) await repository.updateShared(id, payload, actor.id)
      else await repository.saveOverride(id, payload, false, actor.id)
      return find(actor, id)
    },
    async remove(actor, id) {
      await find(actor, id)
      if (await repository.isPersonal(id, actor.id)) await repository.removePersonal(id, actor.id)
      else await repository.saveOverride(id, null, true, actor.id)
      return { id }
    },
    async reset(actor) { await repository.resetOverrides(actor.id); return { restored: true } },
    async use(actor, id) { await find(actor, id); return { id } },
    async status(actor, id, isEnabled) {
      const existing = await find(actor, id)
      return this.update(actor, id, { ...existing, isEnabled })
    }
  }
}

module.exports = { visibleReplies, createQuickReplyPersonalizationService }
