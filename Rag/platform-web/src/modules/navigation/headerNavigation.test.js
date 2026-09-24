import test from 'node:test'
import assert from 'node:assert/strict'

async function loadNavigation() {
  const module = await import('./headerNavigation.js').catch(() => null)
  assert.ok(module, 'headerNavigation.js should exist')
  assert.equal(typeof module.buildHeaderNavigation, 'function')
  return module.buildHeaderNavigation
}

test('agent gets review and daily business tools but no system settings', async () => {
  const buildHeaderNavigation = await loadNavigation()
  const result = buildHeaderNavigation('agent')

  assert.equal(result.review.path, '/message-reviews')
  assert.deepEqual(result.business.map(item => item.path), [
    '/statistics',
    '/statistics/after-sales',
    '/campaigns',
    '/video',
    '/orders',
    '/catalog',
    '/customers'
  ])
  assert.deepEqual(result.settings, [])
})

test('supervisor gets review and business tools but no admin settings', async () => {
  const buildHeaderNavigation = await loadNavigation()
  const result = buildHeaderNavigation('supervisor')

  assert.equal(result.review.path, '/message-reviews')
  assert.equal(result.business.length, 8)
  assert.equal(result.business.some(item => item.path === '/warehouses'), true)
  assert.deepEqual(result.settings, [])
})

test('admin gets AI configuration and functional modules', async () => {
  const buildHeaderNavigation = await loadNavigation()
  const result = buildHeaderNavigation('admin')

  assert.deepEqual(result.settings.map(item => item.path), [
    '/settings/ai',
    '/modules',
    '/settings/video-data'
  ])
})

test('unknown roles receive no header commands', async () => {
  const buildHeaderNavigation = await loadNavigation()
  assert.deepEqual(buildHeaderNavigation(''), {
    review: null,
    business: [],
    settings: []
  })
})

test('normalizes the actionable review count defensively', async () => {
  const { normalizeReviewCount } = await import('./headerNavigation.js')
  assert.equal(typeof normalizeReviewCount, 'function')
  assert.equal(normalizeReviewCount({ mine: 3, public: 4 }), 7)
  assert.equal(normalizeReviewCount({ mine: '2', public: null }), 2)
  assert.equal(normalizeReviewCount({ mine: -1, public: 'bad' }), 0)
})
