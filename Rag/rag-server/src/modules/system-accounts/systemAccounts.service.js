const ROLES = Object.freeze(['admin', 'supervisor', 'agent'])
const STATUSES = Object.freeze(['active', 'disabled'])
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function serviceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function safeUser(user) {
  if (!user) return null
  const source = typeof user.toJSON === 'function' ? user.toJSON() : user
  const { password, ...safe } = source
  return safe
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (email && !EMAIL_PATTERN.test(email)) throw serviceError('邮箱格式不正确')
  return email || null
}

function validateRole(role) {
  if (!ROLES.includes(role)) throw serviceError('角色无效')
  return role
}

function validateStatus(status) {
  if (!STATUSES.includes(status)) throw serviceError('账号状态无效')
  return status
}

function validatePassword(password) {
  const value = String(password || '')
  if (value.length < 6) throw serviceError('密码至少 6 个字符')
  if (value.length > 72) throw serviceError('密码不能超过 72 个字符')
  return value
}

async function ensureLastActiveAdmin(repository, user, next = null) {
  const removesActiveAdmin = user.role === 'admin' && user.status === 'active' && (
    next === null || next.role !== 'admin' || next.status !== 'active'
  )
  if (!removesActiveAdmin) return
  if (await repository.countActiveAdmins() <= 1) {
    throw serviceError('系统必须至少保留一个启用状态的管理员', 409)
  }
}

function createSystemAccountsService({ repository, hashPassword }) {
  if (!repository || typeof hashPassword !== 'function') throw new Error('system account service dependencies are required')

  return {
    async list(filters = {}) {
      return (await repository.list(filters)).map(safeUser)
    },

    async create(input = {}) {
      const username = String(input.username || '').trim()
      if (username.length < 2 || username.length > 50) throw serviceError('用户名长度必须为 2-50 个字符')
      if (!/^[\w.-]+$/.test(username)) throw serviceError('用户名只能包含字母、数字、下划线、点和短横线')
      if (await repository.findByUsername(username)) throw serviceError('用户名已存在', 409)
      const email = normalizeEmail(input.email)
      if (email && await repository.findByEmail(email)) throw serviceError('邮箱已存在', 409)
      const password = await hashPassword(validatePassword(input.password))
      const created = await repository.create({
        username,
        password,
        email,
        role: validateRole(input.role || 'agent'),
        status: validateStatus(input.status || 'active')
      })
      return safeUser(created)
    },

    async update(id, input = {}, context = {}) {
      const user = await repository.findById(id)
      if (!user) throw serviceError('账号不存在', 404)
      const updates = {}
      if (input.email !== undefined) {
        updates.email = normalizeEmail(input.email)
        const duplicate = updates.email ? await repository.findByEmail(updates.email) : null
        if (duplicate && Number(duplicate.id) !== Number(user.id)) throw serviceError('邮箱已存在', 409)
      }
      if (input.role !== undefined) updates.role = validateRole(input.role)
      if (input.status !== undefined) updates.status = validateStatus(input.status)
      const next = { ...safeUser(user), ...updates }
      if (Number(context.actorId) === Number(user.id)) {
        if (updates.status === 'disabled') throw serviceError('不能禁用当前登录账号', 409)
        if (updates.role && updates.role !== user.role) throw serviceError('不能修改当前登录账号的角色', 409)
      }
      await ensureLastActiveAdmin(repository, user, next)
      return safeUser(await repository.update(id, updates))
    },

    async resetPassword(id, input = {}) {
      const user = await repository.findById(id)
      if (!user) throw serviceError('账号不存在', 404)
      const password = await hashPassword(validatePassword(input.password))
      return safeUser(await repository.update(id, { password }))
    },

    async remove(id, context = {}) {
      const user = await repository.findById(id)
      if (!user) throw serviceError('账号不存在', 404)
      if (Number(context.actorId) === Number(user.id)) throw serviceError('不能删除当前登录账号', 409)
      await ensureLastActiveAdmin(repository, user, null)
      try {
        await repository.remove(id)
      } catch (error) {
        throw serviceError('账号已关联业务数据，无法删除；请改为禁用账号', 409)
      }
      return { id: Number(id) }
    }
  }
}

module.exports = { ROLES, STATUSES, safeUser, createSystemAccountsService }
