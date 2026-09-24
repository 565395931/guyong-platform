import { createOfficialCommerceAccountForm } from './officialCommerceAccountForm.js'

const form = createOfficialCommerceAccountForm({
  channel: 'wechat_shop',
  adapterType: 'wechat_shop_commerce',
  fields: [
    { name: 'appId', label: 'App ID' },
    { name: 'appSecret', label: 'App Secret' },
    { name: 'shopId', label: 'Shop ID' }
  ]
})

export const normalizeWechatShopAccountForm = form.normalize
export const validateWechatShopAccountForm = form.validate
export const buildWechatShopAccountCreateRequest = form.buildRequest
