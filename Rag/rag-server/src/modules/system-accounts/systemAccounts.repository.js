const { Op, literal } = require('sequelize')

function createSystemAccountsRepository(User) {
  return {
    async list(filters = {}) {
      const where = {}
      const keyword = String(filters.keyword || '').trim()
      if (keyword) {
        where[Op.or] = [
          { username: { [Op.like]: `%${keyword}%` } },
          { email: { [Op.like]: `%${keyword}%` } }
        ]
      }
      if (filters.role) where.role = filters.role
      if (filters.status) where.status = filters.status
      return User.findAll({
        where,
        attributes: ['id', 'username', 'email', 'role', 'status', 'createdAt', 'updatedAt',
          [literal('(SELECT ss.status FROM seat_status ss WHERE ss.user_id = User.id LIMIT 1)'), 'availability'],
          [literal("(SELECT COUNT(*) FROM conversation_seat_daily d WHERE d.user_id=User.id AND d.service_day=DATE(DATE_SUB(UTC_TIMESTAMP(),INTERVAL 11 HOUR)))"), 'currentLoad']],
        order: [['createdAt', 'DESC']]
      })
    },
    findById: id => User.findByPk(id),
    findByUsername: username => User.findOne({ where: { username } }),
    findByEmail: email => User.findOne({ where: { email } }),
    countActiveAdmins: () => User.count({ where: { role: 'admin', status: 'active' } }),
    create: input => User.create(input),
    async update(id, input) {
      const user = await User.findByPk(id)
      if (!user) return null
      await user.update(input)
      return user
    },
    async remove(id) {
      const user = await User.findByPk(id)
      if (user) await user.destroy()
    }
  }
}

module.exports = { createSystemAccountsRepository }
