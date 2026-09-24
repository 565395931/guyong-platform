const bcrypt = require('bcryptjs')
const User = require('../../models/User')
const { createSystemAccountsRepository } = require('./systemAccounts.repository')
const { createSystemAccountsService } = require('./systemAccounts.service')
const { createSystemAccountsRouter } = require('./systemAccounts.routes')

const repository = createSystemAccountsRepository(User)
const service = createSystemAccountsService({
  repository,
  hashPassword: password => bcrypt.hash(password, 10)
})

const accountMode = String(process.env.AUTH_MODE || 'single_owner').trim().toLowerCase() === 'team'
  ? 'team'
  : 'single_owner'

module.exports = { systemAccountsRoutes: createSystemAccountsRouter({ service, accountMode }), repository, service }
