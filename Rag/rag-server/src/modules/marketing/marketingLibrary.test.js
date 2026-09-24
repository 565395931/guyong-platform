const test = require('node:test')
const assert = require('node:assert/strict')

const {
  getCampaignBlueprints,
  buildCampaignBlueprintDraft,
  getVideoTemplates,
  getVideoTemplate,
  normalizeVideoGenerationInput,
  buildVideoGenerationPlan
} = require('./marketingLibrary')

test('campaign blueprints expose reusable drafts and stay immutable', () => {
  const blueprints = getCampaignBlueprints()

  assert.ok(blueprints.length >= 5)

  const launch = blueprints.find(item => item.id === 'new_product_launch')
  assert.ok(launch)
  assert.equal(launch.draft.type, 'dm')
  assert.ok(Array.isArray(launch.draft.targetChannels))

  launch.draft.name = 'mutated'
  const freshLaunch = getCampaignBlueprints().find(item => item.id === 'new_product_launch')
  assert.notEqual(freshLaunch.draft.name, 'mutated')
})

test('blueprint drafts can be expanded into ready-to-use task data', () => {
  const draft = buildCampaignBlueprintDraft('dormant_reactivation', {
    name: '七夕唤醒',
    targetUserIds: ['8613800138000@c.us']
  })

  assert.equal(draft.blueprintId, 'dormant_reactivation')
  assert.equal(draft.draft.name, '七夕唤醒')
  assert.deepEqual(draft.draft.targetUserIds, ['8613800138000@c.us'])
  assert.ok(draft.draft.scripts.length > 0)
})

test('video templates link back to campaign blueprints', () => {
  const templates = getVideoTemplates()
  const template = templates.find(item => item.id === 'product_showcase')

  assert.ok(template)
  assert.ok(template.sceneBlueprints.length >= 4)
  assert.ok(template.recommendedCampaignBlueprintIds.includes('new_product_launch'))
  assert.equal(getVideoTemplate('product_showcase').id, 'product_showcase')
})

test('normalizes video generation input and builds a full marketing plan', () => {
  const normalized = normalizeVideoGenerationInput({
    templateId: 'comparison_explainer',
    title: '为什么选我们',
    productName: '智能保温杯',
    keyPoints: '保温更久, 更轻, 更适合出差',
    mediaFileIds: ['m1', ' m1 ', 'm2'],
    bgm: 'energetic',
    callToAction: '立即咨询'
  })

  assert.equal(normalized.error, undefined)
  assert.deepEqual(normalized.data.mediaFileIds, ['m1', 'm2'])

  const plan = buildVideoGenerationPlan({
    template: getVideoTemplate('comparison_explainer'),
    input: normalized.data,
    mediaFiles: [
      { id: 'm1', mediaType: 'image', displayName: 'hero.jpg', url: '/api/media-files/static/hero.jpg' },
      { id: 'm2', mediaType: 'video', displayName: 'demo.mp4', url: '/api/media-files/static/demo.mp4' }
    ],
    now: new Date('2026-08-05T08:00:00.000Z')
  })

  assert.equal(plan.templateId, 'comparison_explainer')
  assert.equal(plan.scenes.length, getVideoTemplate('comparison_explainer').sceneBlueprints.length)
  assert.equal(plan.mediaAssets[0].displayName, 'hero.jpg')
  assert.match(plan.caption, /立即咨询/)
  assert.ok(plan.bridge.recommendedCampaignBlueprintIds.includes('keyword_capture'))
  assert.equal(plan.generatedAt, '2026-08-05T08:00:00.000Z')
})

