const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

const { createVideoDataRouter } = require('./videoData')

test('video data router lists rows with aggregated summary', async (t) => {
  const queries = []
  const sequelize = {
    query: async (sql, options = {}) => {
      queries.push({ sql, replacements: options.replacements })
      if (/SUM\(play_count\)/i.test(sql)) {
        return [[{
          totalRecords: 2,
          playCount: 2341,
          likeCount: 2,
          commentCount: 1,
          inquiryCount: 2,
          intentCustomerCount: 1,
          dealCount: 0
        }]]
      }
      if (/COUNT\(\*\) AS total/i.test(sql)) {
        return [[{ total: 2 }]]
      }
      if (/FROM video_account_data/i.test(sql)) {
        return [[
          {
            id: 3,
            data_date: '2026-08-05',
            account_no: '15295155085',
            platform: 'xiaohongshu',
            play_count: 65,
            like_count: 0,
            comment_count: 0,
            inquiry_count: 0,
            intent_customer_count: 0,
            deal_count: 0,
            remark: '首发'
          },
          {
            id: 4,
            data_date: '2026-08-05',
            account_no: '2188',
            platform: 'douyin',
            play_count: 2276,
            like_count: 2,
            comment_count: 1,
            inquiry_count: 2,
            intent_customer_count: 1,
            deal_count: 0,
            remark: '主推'
          }
        ]]
      }
      return [[]]
    }
  }

  const app = express()
  app.use(express.json())
  app.use('/api/v1/video-data', createVideoDataRouter({
    sequelize,
    authenticate: (req, res, next) => {
      req.user = { id: 1, role: 'admin' }
      next()
    }
  }))

  const server = app.listen(0)
  t.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/video-data?startDate=2026-08-05&endDate=2026-08-05`)
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.data.list.length, 2)
  assert.equal(body.data.summary.playCount, 2341)
  assert.ok(queries.some(item => /COUNT\(\*\) AS total/i.test(item.sql)))
  assert.ok(queries.some(item => /SUM\(play_count\)/i.test(item.sql)))
})

test('video data router creates records and exports csv', async (t) => {
  const calls = []
  const sequelize = {
    query: async (sql, options = {}) => {
      calls.push({ sql, replacements: options.replacements })
      if (/INSERT INTO video_account_data/i.test(sql)) {
        return [[{ affectedRows: 1 }], { affectedRows: 1 }]
      }
      if (/WHERE id = :id LIMIT 1/i.test(sql)) {
        return [[{
          id: 9,
          data_date: '2026-08-05',
          account_no: '17715331145',
          platform: 'wechat_channel',
          play_count: 48,
          like_count: 0,
          comment_count: 1,
          inquiry_count: 2,
          intent_customer_count: 0,
          deal_count: 0,
          remark: '待观察'
        }]]
      }
      if (/FROM video_account_data/i.test(sql)) {
        return [[{
          id: 9,
          data_date: '2026-08-05',
          account_no: '17715331145',
          platform: 'wechat_channel',
          play_count: 48,
          like_count: 0,
          comment_count: 1,
          inquiry_count: 2,
          intent_customer_count: 0,
          deal_count: 0,
          remark: '待观察'
        }]]
      }
      return [[]]
    }
  }

  const app = express()
  app.use(express.json())
  app.use('/api/v1/video-data', createVideoDataRouter({
    sequelize,
    authenticate: (req, res, next) => {
      req.user = { id: 1, role: 'supervisor' }
      next()
    }
  }))

  const server = app.listen(0)
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const createResponse = await fetch(`${baseUrl}/api/v1/video-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataDate: '2026-08-05',
      accountNo: '17715331145',
      platform: 'wechat_channel',
      playCount: 48,
      likeCount: 0,
      commentCount: 1,
      inquiryCount: 2,
      intentCustomerCount: 0,
      dealCount: 0,
      remark: '待观察'
    })
  })

  assert.equal(createResponse.status, 201)
  const createBody = await createResponse.json()
  assert.equal(createBody.data.accountNo, '17715331145')
  assert.equal(calls[0].replacements.accountNo, '17715331145')

  const exportResponse = await fetch(`${baseUrl}/api/v1/video-data/export?startDate=2026-08-05&endDate=2026-08-05`)
  assert.equal(exportResponse.status, 200)
  assert.match(exportResponse.headers.get('content-disposition') || '', /video-data-2026-08-05-2026-08-05\.csv/)
  const csv = await exportResponse.text()
  assert.match(csv, /17715331145/)
})

