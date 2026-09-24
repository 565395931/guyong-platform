const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

const { createVideoRouter } = require('./video')

test('video router serves templates and generates a structured plan', async (t) => {
  const sequelize = {
    query: async (sql) => {
      if (/FROM media_files/i.test(sql)) {
        return [[
          {
            id: 'media-1',
            original_name: 'hero.jpg',
            display_name: 'Hero image',
            description: '',
            filename: 'hero.jpg',
            media_type: 'image',
            mime_type: 'image/jpeg',
            size: 1024,
            url: '/api/media-files/static/hero.jpg',
            uploader_id: 1,
            created_at: '2026-08-05T08:00:00.000Z',
            updated_at: '2026-08-05T08:00:00.000Z'
          }
        ]]
      }
      return [[]]
    }
  }

  const app = express()
  app.use(express.json())
  app.use('/api/v1/video', createVideoRouter({
    sequelize,
    authenticate: (req, res, next) => {
      req.user = { id: 1, role: 'supervisor' }
      next()
    }
  }))

  const server = app.listen(0)
  t.after(() => server.close())

  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const templatesResponse = await fetch(`${baseUrl}/api/v1/video/templates`)
  assert.equal(templatesResponse.status, 200)
  const templatesBody = await templatesResponse.json()
  assert.ok(templatesBody.data.list.some(item => item.id === 'product_showcase'))

  const generateResponse = await fetch(`${baseUrl}/api/v1/video/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: 'product_showcase',
      title: '新品上架',
      productName: '智能杯',
      keyPoints: ['保温', '轻便'],
      mediaFileIds: ['media-1'],
      callToAction: '立即咨询'
    })
  })

  assert.equal(generateResponse.status, 200)
  const generateBody = await generateResponse.json()

  assert.equal(generateBody.data.mediaAssets[0].id, 'media-1')
  assert.ok(generateBody.data.scenes.length > 0)
  assert.match(generateBody.data.caption, /立即咨询/)
})
