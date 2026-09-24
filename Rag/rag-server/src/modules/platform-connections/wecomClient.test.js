const test = require('node:test')
const assert = require('node:assert/strict')

const { createWecomClient } = require('./wecomClient')

test('verifies credentials and maps official customer service accounts', async () => {
  const calls = []
  const httpClient = {
    get: async (url, options) => {
      calls.push({ url, options })
      if (url === '/cgi-bin/gettoken') return { data: { errcode: 0, access_token: 'access-token', expires_in: 7200 } }
      return { data: { errcode: 0, account_list: [{ open_kfid: 'wkABC', name: 'AI测试客服', avatar: 'avatar-url' }] } }
    }
  }

  const client = createWecomClient({ httpClient })
  const result = await client.verifyAndListAccounts({ corpId: 'ww123', secret: 'secret-value' })

  assert.equal(calls[0].url, '/cgi-bin/gettoken')
  assert.deepEqual(calls[0].options.params, { corpid: 'ww123', corpsecret: 'secret-value' })
  assert.equal(calls[1].url, '/cgi-bin/kf/account/list')
  assert.deepEqual(calls[1].options.params, { access_token: 'access-token' })
  assert.deepEqual(result.accounts, [{ externalAccountId: 'wkABC', name: 'AI测试客服', avatar: 'avatar-url' }])
  assert.equal(result.expiresIn, 7200)
})

test('throws a sanitized official API error', async () => {
  const httpClient = {
    get: async () => ({ data: { errcode: 40001, errmsg: 'invalid credential' } })
  }
  const client = createWecomClient({ httpClient })

  await assert.rejects(
    () => client.getAccessToken({ corpId: 'ww123', secret: 'do-not-leak' }),
    error => error.message.includes('40001') && !error.message.includes('do-not-leak')
  )
})

test('rejects an account response without an account list', async () => {
  const httpClient = { get: async () => ({ data: { errcode: 0 } }) }
  const client = createWecomClient({ httpClient })

  await assert.rejects(
    () => client.listCustomerServiceAccounts({ accessToken: 'token' }),
    /account_list/
  )
})
