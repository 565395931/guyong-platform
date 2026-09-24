const test = require('node:test')
const assert = require('node:assert/strict')

const { captureRawBody } = require('./captureRawBody')

test('keeps an exact copy of the request bytes for webhook signature checks', () => {
  const req = {}
  const body = Buffer.from('[{"tag":"0"}]', 'utf8')

  captureRawBody(req, null, body)

  assert.notEqual(req.rawBody, body)
  assert.equal(req.rawBody.toString('utf8'), '[{"tag":"0"}]')
})
