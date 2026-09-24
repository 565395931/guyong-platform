import { createOfficialCommerceAccountForm } from './officialCommerceAccountForm.js'

const form = createOfficialCommerceAccountForm({
  channel: 'kuaishou',
  adapterType: 'kuaishou_commerce',
  fields: [
    { name: 'appKey', label: 'App Key' },
    { name: 'appSecret', label: 'App Secret' },
    { name: 'accessToken', label: 'Access Token' },
    { name: 'shopId', label: 'Shop ID' }
  ]
})

export const normalizeKuaishouAccountForm = form.normalize
export const validateKuaishouAccountForm = form.validate
export const buildKuaishouAccountCreateRequest = form.buildRequest
