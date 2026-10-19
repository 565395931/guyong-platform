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

  assert.equal(Object.hasOwn(result, 'review'), false)
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

test('retired supervisor receives no commands', async () => {
  const build = await loadNavigation()
  assert.deepEqual(build('supervisor'), { business: [], settings: [] })
})

test('admin gets AI configuration and functional modules', async () => {
  const buildHeaderNavigation = await loadNavigation()
  const result = buildHeaderNavigation('admin')

  assert.deepEqual(result.settings.map(item => item.path), [
    '/settings/general', '/settings/accounts', '/settings/ai', '/settings/model-test',
    '/modules',
    '/settings/video-data'
  ])
})

test('unknown roles receive no header commands', async () => {
  const buildHeaderNavigation = await loadNavigation()
  assert.deepEqual(buildHeaderNavigation(''), {
    business: [],
    settings: []
  })
})
