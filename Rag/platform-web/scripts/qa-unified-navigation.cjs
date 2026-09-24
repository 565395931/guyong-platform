const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const targetUrl = process.env.QA_TARGET_URL || 'http://127.0.0.1:3004'
const outputDir = path.resolve(__dirname, '../../artifacts/ui-unification')
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const accountRows = [
  { id: 1, channel: 'whatsapp', account_name: 'WhatsApp 销售一组', status: 'active', daily_quota: 12, max_daily_quota: 1000 },
  { id: 2, channel: 'whatsapp', account_name: 'WhatsApp 售后二组', status: 'active', daily_quota: 8, max_daily_quota: 1000 },
  { id: 3, channel: 'taobao', account_name: '淘宝旗舰店', status: 'active', credentialStatus: 'configured', daily_quota: 20, max_daily_quota: 1000 }
]

function fulfill(route, data) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ success: true, data })
  })
}

async function preparePage(context) {
  const systemAccountState = {
    nextId: 11,
    rows: [
      {
        id: 7,
        username: 'qa-admin',
        email: 'admin@example.com',
        role: 'admin',
        status: 'active',
        createdAt: '2026-08-01T06:00:00.000Z',
        updatedAt: '2026-08-01T06:00:00.000Z'
      },
      {
        id: 8,
        username: 'ops-admin',
        email: 'ops@example.com',
        role: 'admin',
        status: 'active',
        createdAt: '2026-08-01T06:05:00.000Z',
        updatedAt: '2026-08-01T06:05:00.000Z'
      },
      {
        id: 9,
        username: 'ops-supervisor',
        email: 'supervisor@example.com',
        role: 'supervisor',
        status: 'active',
        createdAt: '2026-08-01T06:10:00.000Z',
        updatedAt: '2026-08-01T06:10:00.000Z'
      },
      {
        id: 10,
        username: 'ops-agent',
        email: 'agent@example.com',
        role: 'agent',
        status: 'active',
        createdAt: '2026-08-01T06:15:00.000Z',
        updatedAt: '2026-08-01T06:15:00.000Z'
      }
    ]
  }
  const systemAccountRequests = []
  await context.addInitScript(() => {
    localStorage.setItem('platform_token', 'qa-token')
    localStorage.setItem('platform_user', JSON.stringify({ id: 7, username: 'qa-admin', role: 'admin' }))
  })
  const page = await context.newPage()
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/v1/system-accounts')) {
      systemAccountRequests.push({
        method: request.method(),
        url: request.url(),
        postData: request.postData()
      })
    }
  })
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/v1/channels/status') {
      return fulfill(route, { overall: 'HEALTHY', channels: [] })
    }
    if (url.pathname === '/api/v1/message-reviews/stats') {
      return fulfill(route, { mine: 1, public: 1, all: 2, high: 1 })
    }
    if (url.pathname === '/api/v1/channel-accounts/channels') {
      return fulfill(route, [
        { code: 'wecom_kf', label: '微信客服' },
        { code: 'whatsapp', label: 'WhatsApp' },
        { code: 'douyin', label: '抖店' },
        { code: 'pinduoduo', label: '拼多多' },
        { code: 'taobao', label: '淘宝 / 千牛' },
        { code: 'alibaba1688', label: '1688' }
      ])
    }
    if (url.pathname === '/api/v1/channel-accounts') {
      const channel = url.searchParams.get('channel')
      return fulfill(route, channel ? accountRows.filter(row => row.channel === channel) : accountRows)
    }
    if (url.pathname === '/api/v1/conversations') return fulfill(route, [])
    if (url.pathname === '/api/v1/conversations/pool-stats') {
      return fulfill(route, { ai_self: 0, pending_human: 0, private: 0, archived: 0 })
    }
    if (url.pathname === '/api/v1/channel-events') return fulfill(route, { items: [], total: 0 })
    if (url.pathname === '/api/v1/system-accounts' && route.request().method() === 'GET') {
      const keyword = String(url.searchParams.get('keyword') || '').trim().toLowerCase()
      const role = String(url.searchParams.get('role') || '').trim().toLowerCase()
      const status = String(url.searchParams.get('status') || '').trim().toLowerCase()
      const data = systemAccountState.rows.filter(row => {
        if (keyword) {
          const haystack = `${row.username} ${row.email || ''}`.toLowerCase()
          if (!haystack.includes(keyword)) return false
        }
        if (role && row.role !== role) return false
        if (status && row.status !== status) return false
        return true
      })
      return fulfill(route, data)
    }
    if (url.pathname === '/api/v1/system-accounts' && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}')
      const now = new Date().toISOString()
      const created = {
        id: systemAccountState.nextId++,
        username: body.username,
        email: body.email || null,
        role: body.role || 'agent',
        status: body.status || 'active',
        createdAt: now,
        updatedAt: now
      }
      systemAccountState.rows = [created, ...systemAccountState.rows]
      return fulfill(route, created)
    }
    const systemAccountMatch = url.pathname.match(/^\/api\/v1\/system-accounts\/(\d+)(?:\/reset-password)?$/)
    if (systemAccountMatch) {
      const id = Number(systemAccountMatch[1])
      const account = systemAccountState.rows.find(row => row.id === id)
      if (!account) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ success: false, message: '账号不存在' })
        })
      }

      if (url.pathname.endsWith('/reset-password')) {
        const body = JSON.parse(route.request().postData() || '{}')
        return fulfill(route, { id, username: account.username, password: body.password })
      }

      if (route.request().method() === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}')
        const updated = {
          ...account,
          ...body,
          updatedAt: new Date().toISOString()
        }
        systemAccountState.rows = systemAccountState.rows.map(row => row.id === id ? updated : row)
        return fulfill(route, updated)
      }

      if (route.request().method() === 'DELETE') {
        systemAccountState.rows = systemAccountState.rows.filter(row => row.id !== id)
        return fulfill(route, { id })
      }
    }
    return fulfill(route, {})
  })
  page.__systemAccountRequests = systemAccountRequests
  page.__systemAccountState = systemAccountState
  return page
}

async function fillDialogInput(dialog, label, value) {
  await dialog.locator('.el-form-item').filter({ hasText: label }).locator('input').first().fill(value)
}

async function confirmMessageBox(page, action) {
  await page.locator('.el-message-box').getByRole('button', { name: action }).click()
}

async function assertShell(page, expectedMobile) {
  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector('.app-sidebar')
    const menuItems = [...sidebar.querySelectorAll('.el-menu-item')]
    const sectionLabels = [...sidebar.querySelectorAll('.app-sidebar__section-label')]
    const nestedToggles = [...sidebar.querySelectorAll('.app-sidebar__nested-toggle')]
    const header = document.querySelector('.app-header')
    return {
      sectionLabels: sectionLabels.map(item => item.textContent.trim()),
      menuLabels: menuItems.map(item => (item.querySelector('.app-sidebar__item-label') || item).textContent.trim()),
      nestedLabels: nestedToggles.map(item => item.querySelector('.app-sidebar__item-label')?.textContent.trim()),
      menuBackgrounds: menuItems.map(item => getComputedStyle(item).backgroundColor),
      sidebarBackground: getComputedStyle(sidebar).backgroundColor,
      headerBottom: Math.round(header.getBoundingClientRect().bottom),
      contentTop: Math.round(document.querySelector('.app-layout__content').getBoundingClientRect().top),
      menuButtonVisible: getComputedStyle(document.querySelector('.app-header__menu-btn')).display !== 'none',
      headerToolsPresent: Boolean(document.querySelector('.app-header__tools')),
      reviewBadge: document.querySelector('.app-sidebar__review-badge')?.textContent.trim() || '',
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }
  })
  assert.deepEqual(shell.sectionLabels, ['客服工作', '业务运营', '系统设置'])
  assert.deepEqual(shell.nestedLabels, ['平台消息', '客服账号管理'])
  assert.deepEqual(shell.menuLabels, ['全部', '微信客服', '微信小程序', 'WhatsApp', '抖店', '拼多多', '淘宝 / 千牛', '1688', '消息审核'])
  assert.equal(shell.headerBottom, shell.contentTop)
  assert.equal(shell.menuButtonVisible, expectedMobile)
  assert.equal(shell.headerToolsPresent, false)
  assert.equal(shell.reviewBadge, '2')
  assert.equal(shell.canScrollX, false)
  assert.notEqual(shell.menuBackgrounds[0], shell.sidebarBackground)
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({ executablePath: edgePath, headless: true })
  const errors = []
  try {
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true
    })
    const desktopPage = await preparePage(desktopContext)
    desktopPage.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await desktopPage.goto(`${targetUrl}/platform-messages`, { waitUntil: 'networkidle' })
    await desktopPage.getByRole('main').waitFor()
    await assertShell(desktopPage, false)
    assert.equal(await desktopPage.locator('.message-toolbar__platforms').count(), 0)
    assert.equal(await desktopPage.locator('.app-sidebar .el-menu-item').filter({ hasText: 'WhatsApp' }).count(), 1)
    await desktopPage.screenshot({ path: path.join(outputDir, 'desktop-platform-messages.png') })

    await desktopPage.goto(`${targetUrl}/whatsapp/conversations`, { waitUntil: 'networkidle' })
    let redirectedUrl = new URL(desktopPage.url())
    assert.equal(redirectedUrl.pathname, '/platform-messages')
    assert.equal(redirectedUrl.searchParams.get('channel'), 'whatsapp')
    assert.equal(await desktopPage.locator('.app-sidebar .el-menu-item').filter({ hasText: 'WhatsApp' }).evaluate(item => item.classList.contains('is-active')), true)
    await desktopPage.reload({ waitUntil: 'networkidle' })
    redirectedUrl = new URL(desktopPage.url())
    assert.equal(redirectedUrl.searchParams.get('channel'), 'whatsapp')

    await desktopPage.locator('.app-sidebar').getByText('消息审核', { exact: true }).click()
    await desktopPage.waitForURL('**/message-reviews')
    await desktopPage.goto(`${targetUrl}/platform-messages`, { waitUntil: 'networkidle' })
    await desktopPage.locator('.app-sidebar__btn[title="收起菜单"]').click()
    await desktopPage.waitForFunction(() => Math.round(document.querySelector('.app-sidebar').getBoundingClientRect().width) === 64)
    await desktopPage.locator('.app-sidebar__btn[title="展开菜单"]').click()
    await desktopPage.waitForFunction(() => Math.round(document.querySelector('.app-sidebar').getBoundingClientRect().width) === 200)

    await desktopPage.locator('.app-sidebar__nested-toggle').getByText('客服账号管理', { exact: true }).click()
    await desktopPage.locator('.app-sidebar').getByText('淘宝 / 千牛', { exact: true }).last().click()
    await desktopPage.waitForURL('**/customer-service-accounts?channel=taobao')
    await desktopPage.getByText('淘宝旗舰店', { exact: true }).waitFor()
    await desktopPage.waitForTimeout(500)
    assert.equal(await desktopPage.getByText('对话接入', { exact: true }).count(), 1)
    assert.equal(await desktopPage.getByText('桌面节点', { exact: true }).count(), 2)
    assert.equal(await desktopPage.getByText('待配置', { exact: true }).count(), 1)
    const accountTagFit = await desktopPage.evaluate(() => [...document.querySelectorAll('.account-manage-view__table .el-tag')].map(tag => {
      const rect = tag.getBoundingClientRect()
      const style = getComputedStyle(tag)
      return {
        text: tag.textContent.trim(),
        width: Math.round(rect.width),
        display: style.display,
        padding: style.padding,
        fontSize: style.fontSize,
        color: style.color,
        cellWidth: Math.round(tag.closest('.cell').getBoundingClientRect().width),
        tableCellWidth: Math.round(tag.closest('td').getBoundingClientRect().width),
        flexShrink: style.flexShrink,
        minWidth: style.minWidth
      }
    }))
    assert.ok(accountTagFit.every(tag => tag.text.length > 0 && tag.width >= 40))
    await desktopPage.screenshot({ path: path.join(outputDir, 'desktop-account-management.png') })

    await desktopPage.goto(`${targetUrl}/settings/accounts`, { waitUntil: 'networkidle' })
    await desktopPage.getByRole('heading', { name: '系统账号管理' }).waitFor()
    assert.equal(await desktopPage.locator('.app-sidebar .el-menu-item').filter({ hasText: '系统账号管理' }).count(), 1)
    assert.equal(await desktopPage.getByText('当前账号', { exact: true }).count(), 1)

    const selfRow = desktopPage.locator('.system-accounts-view .el-table__body-wrapper tbody tr').filter({ hasText: 'qa-admin' })
    assert.equal(await selfRow.getByRole('button', { name: '停用' }).isDisabled(), true)
    assert.equal(await selfRow.getByRole('button', { name: '删除' }).isDisabled(), true)

    await desktopPage.getByRole('button', { name: '新增账号' }).click()
    const createDialog = desktopPage.locator('.el-dialog').filter({ hasText: '新增系统账号' })
    await fillDialogInput(createDialog, '用户名', 'qa-operator')
    await fillDialogInput(createDialog, '邮箱', 'operator@example.com')
    await fillDialogInput(createDialog, '初始密码', 'qa-pass-123')
    await createDialog.getByRole('button', { name: '创建账号' }).click()
    await desktopPage.getByText('qa-operator', { exact: true }).waitFor()

    await desktopPage.locator('.account-toolbar .keyword-input input').fill('qa-operator')
    await desktopPage.getByRole('button', { name: '查询' }).click()
    const operatorRow = desktopPage.locator('.system-accounts-view .el-table__body-wrapper tbody tr').filter({ hasText: 'qa-operator' })
    await operatorRow.waitFor()
    assert.equal(await desktopPage.locator('.system-accounts-view .el-table__body-wrapper tbody tr').count(), 1)

    await operatorRow.getByRole('button', { name: '编辑' }).click()
    const editDialog = desktopPage.locator('.el-dialog').filter({ hasText: '编辑系统账号' })
    await fillDialogInput(editDialog, '邮箱', 'operator+updated@example.com')
    await editDialog.getByRole('button', { name: '保存修改' }).click()
    await desktopPage.getByText('operator+updated@example.com', { exact: true }).waitFor()

    await operatorRow.getByRole('button', { name: '重置密码' }).click()
    const resetDialog = desktopPage.locator('.el-dialog').filter({ hasText: '重置密码' })
    await fillDialogInput(resetDialog, '新密码', 'qa-pass-456')
    await resetDialog.getByRole('button', { name: '确认重置' }).click()
    await desktopPage.waitForFunction(() =>
      document.querySelector('.el-message--success')?.textContent?.includes('密码已重置')
    )

    const resetRequest = [...desktopPage.__systemAccountRequests].reverse().find(item => item.url.includes('/reset-password'))
    assert.ok(resetRequest)
    assert.equal(JSON.parse(resetRequest.postData).password, 'qa-pass-456')

    const statusCell = operatorRow.locator('td').nth(3)
    await operatorRow.getByRole('button', { name: '停用' }).click()
    await confirmMessageBox(desktopPage, '停用')
    await statusCell.getByText('停用', { exact: true }).waitFor()

    await operatorRow.getByRole('button', { name: '启用' }).click()
    await confirmMessageBox(desktopPage, '启用')
    await statusCell.getByText('启用', { exact: true }).waitFor()

    await operatorRow.getByRole('button', { name: '删除' }).click()
    await confirmMessageBox(desktopPage, '删除')
    await desktopPage.getByText('暂无系统账号', { exact: true }).waitFor()

    const mutationPaths = desktopPage.__systemAccountRequests
      .filter(item => item.method !== 'GET')
      .map(item => `${item.method} ${new URL(item.url).pathname}`)
    assert.ok(mutationPaths.includes('POST /api/v1/system-accounts'))
    assert.ok(mutationPaths.includes('PATCH /api/v1/system-accounts/11'))
    assert.ok(mutationPaths.includes('POST /api/v1/system-accounts/11/reset-password'))
    assert.ok(mutationPaths.includes('DELETE /api/v1/system-accounts/11'))
    await desktopPage.screenshot({ path: path.join(outputDir, 'desktop-system-accounts.png') })

    const mediumContext = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      ignoreHTTPSErrors: true
    })
    const mediumPage = await preparePage(mediumContext)
    mediumPage.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await mediumPage.goto(`${targetUrl}/platform-messages`, { waitUntil: 'networkidle' })
    await assertShell(mediumPage, false)
    const headerFit = await mediumPage.evaluate(() => {
      const left = document.querySelector('.app-header__left').getBoundingClientRect()
      const right = document.querySelector('.app-header__right').getBoundingClientRect()
      const center = document.querySelector('.workbench-view__center').getBoundingClientRect()
      return {
        leftRight: Math.round(left.right),
        rightLeft: Math.round(right.left),
        centerWidth: Math.round(center.width)
      }
    })
    assert.ok(headerFit.leftRight <= headerFit.rightLeft)
    assert.ok(headerFit.centerWidth >= 240, `center conversation area is only ${headerFit.centerWidth}px wide`)
    await mediumPage.screenshot({ path: path.join(outputDir, 'medium-platform-messages.png') })

    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true
    })
    const mobilePage = await preparePage(mobileContext)
    mobilePage.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await mobilePage.goto(`${targetUrl}/platform-messages`, { waitUntil: 'networkidle' })
    await assertShell(mobilePage, true)
    await mobilePage.getByRole('button', { name: '打开导航' }).click()
    await mobilePage.waitForFunction(() => Math.abs(document.querySelector('.app-sidebar').getBoundingClientRect().left) < 1)
    const mobileSidebar = mobilePage.locator('.app-sidebar')
    assert.equal(await mobileSidebar.getByText('平台消息', { exact: true }).count(), 1)
    assert.equal(await mobileSidebar.getByText('客服账号管理', { exact: true }).count(), 1)
    const mobileSidebarFit = await mobilePage.evaluate(() => {
      const sidebar = document.querySelector('.app-sidebar')
      const rect = sidebar.getBoundingClientRect()
      return {
        className: sidebar.className,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        transform: getComputedStyle(sidebar).transform
      }
    })
    assert.ok(Math.abs(mobileSidebarFit.left) <= 1)
    assert.ok(mobileSidebarFit.right >= 220)
    await mobilePage.screenshot({ path: path.join(outputDir, 'mobile-navigation-open.png') })

    const relevantErrors = errors.filter(message =>
      !message.includes('favicon') &&
      !message.includes('[WS] 连接失败: 认证失败: jwt malformed')
    )
    assert.deepEqual(relevantErrors, [])
    console.log(JSON.stringify({ ok: true, targetUrl, outputDir }, null, 2))
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
