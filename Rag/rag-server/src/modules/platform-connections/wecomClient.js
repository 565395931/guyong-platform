const axios = require('axios')

function assertSuccess(data, operation) {
  const code = Number(data?.errcode || 0)
  if (code !== 0) {
    const message = String(data?.errmsg || 'unknown error').slice(0, 200)
    throw new Error(`WeCom ${operation} failed (${code}): ${message}`)
  }
}

function createWecomClient({
  httpClient = axios.create({ baseURL: 'https://qyapi.weixin.qq.com', timeout: 15000 })
} = {}) {
  return {
    async getAccessToken({ corpId, secret }) {
      const response = await httpClient.get('/cgi-bin/gettoken', {
        params: { corpid: corpId, corpsecret: secret }
      })
      assertSuccess(response.data, 'access token request')
      if (!response.data?.access_token) throw new Error('WeCom access token response is missing access_token')
      return {
        accessToken: response.data.access_token,
        expiresIn: Number(response.data.expires_in || 0)
      }
    },

    async listCustomerServiceAccounts({ accessToken }) {
      const response = await httpClient.get('/cgi-bin/kf/account/list', {
        params: { access_token: accessToken }
      })
      assertSuccess(response.data, 'customer service account list')
      if (!Array.isArray(response.data?.account_list)) {
        throw new Error('WeCom customer service response is missing account_list')
      }
      return response.data.account_list.map(account => ({
        externalAccountId: String(account.open_kfid || '').trim(),
        name: String(account.name || '').trim(),
        avatar: account.avatar || null
      })).filter(account => account.externalAccountId && account.name)
    },

    async verifyAndListAccounts({ corpId, secret }) {
      const token = await this.getAccessToken({ corpId, secret })
      const accounts = await this.listCustomerServiceAccounts({ accessToken: token.accessToken })
      return { accounts, expiresIn: token.expiresIn }
    }
  }
}

module.exports = { createWecomClient }
