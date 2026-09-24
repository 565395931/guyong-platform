const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

const { createCampaignsRouter } = require('./campaigns')

test('campaign router serves marketing blueprints', async (t) => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/campaigns', createCampaignsRouter({
    repository: {
      listTasks: async () => ({ list: [], total: 0, page: 1, pageSize: 20 }),
      getTask: async () => null,
      updateTaskStatus: async () => null
    },
    service: {
      create: async () => ({})
    },
    authenticate: (req, res, next) => {
      req.user = { id: 1, role: 'admin' }
      next()
    }
  }))

  const server = app.listen(0)
  t.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/campaigns/blueprints`)
  assert.equal(response.status, 200)

  const body = await response.json()
  const launch = body.data.list.find(item => item.id === 'new_product_launch')

  assert.ok(launch)
  assert.ok(launch.draft.scripts.length > 0)
})
