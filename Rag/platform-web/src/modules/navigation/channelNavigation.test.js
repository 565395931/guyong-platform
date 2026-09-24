import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSidebarMenu,
  hasRequiredRole,
  resolveAccountChannel
} from './channelNavigation.js'

test('single-owner admin sees system settings without team account management', () => {
  const menu = buildSidebarMenu('admin')
  assert.deepEqual(menu.map(item => item.label), ['客服工作', '业务运营', '系统设置'])
  assert.deepEqual(menu[0].children.map(item => item.path), [
    '/platform-messages', '/customer-service-accounts', '/message-reviews'
  ])
  assert.deepEqual(menu[1].children.map(item => item.path), [
    '/statistics', '/statistics/after-sales', '/campaigns', '/video', '/orders', '/catalog', '/warehouses', '/customers'
  ])
  assert.deepEqual(menu[2].children.map(item => item.path), ['/settings/ai', '/modules', '/settings/video-data'])
  assert.deepEqual(menu[0].children[0].children.map(item => item.label), [
    '全部', '微信客服', '微信小程序', 'WhatsApp', '抖店', '拼多多', '淘宝 / 千牛', '1688',
    '小红书', '微信小店', '快手小店'
  ])
  assert.deepEqual(menu[0].children[1].children.map(item => item.path), [
    '/customer-service-accounts?channel=all',
    '/customer-service-accounts?channel=wecom_kf',
    '/customer-service-accounts?channel=wechat',
    '/customer-service-accounts?channel=whatsapp',
    '/customer-service-accounts?channel=douyin',
    '/customer-service-accounts?channel=pinduoduo',
    '/customer-service-accounts?channel=taobao',
    '/customer-service-accounts?channel=alibaba1688',
    '/customer-service-accounts?channel=xiaohongshu',
    '/customer-service-accounts?channel=wechat_shop',
    '/customer-service-accounts?channel=kuaishou'
  ])
})

test('agent sees customer work and business operations but no system settings', () => {
  const menu = buildSidebarMenu('agent')
  assert.deepEqual(menu.map(item => item.label), ['客服工作', '业务运营'])
  assert.deepEqual(menu.flatMap(item => item.children.map(child => child.path)), [
    '/platform-messages', '/message-reviews', '/statistics', '/statistics/after-sales',
    '/campaigns', '/video', '/orders', '/catalog', '/customers'
  ])
})

test('supervisor gets customer account management without admin settings', () => {
  const menu = buildSidebarMenu('supervisor')
  assert.equal(menu[0].children.some(item => item.path === '/customer-service-accounts'), true)
  assert.equal(menu[1].children.some(item => item.path === '/warehouses'), true)
  assert.equal(menu.some(item => item.key === 'system-settings'), false)
})

test('route roles are enforced explicitly', () => {
  assert.equal(hasRequiredRole(['admin', 'supervisor'], 'admin'), true)
  assert.equal(hasRequiredRole(['admin', 'supervisor'], 'agent'), false)
  assert.equal(hasRequiredRole(undefined, 'agent'), true)
})

test('account channel query overrides the route default', () => {
  assert.equal(resolveAccountChannel(undefined, 'douyin'), 'douyin')
  assert.equal(resolveAccountChannel('whatsapp', 'douyin'), 'whatsapp')
  assert.equal(resolveAccountChannel('all', 'douyin'), 'all')
  assert.equal(resolveAccountChannel(undefined, undefined), 'all')
})
