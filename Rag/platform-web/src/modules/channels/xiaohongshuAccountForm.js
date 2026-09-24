import { createOfficialCommerceAccountForm } from './officialCommerceAccountForm.js'

const form = createOfficialCommerceAccountForm({
  channel: 'xiaohongshu',
  adapterType: 'xiaohongshu_commerce',
  fields: [
    { name: 'appKey', label: 'App Key' },
    { name: 'appSecret', label: 'App Secret' },
    { name: 'accessToken', label: 'Access Token' },
    { name: 'shopId', label: 'Shop ID' }
  ]
})

export const normalizeXiaohongshuAccountForm = form.normalize
export const validateXiaohongshuAccountForm = form.validate
export const buildXiaohongshuAccountCreateRequest = form.buildRequest
