import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.E2E_BASE_URL || 'https://127.0.0.1:3003'
const artifactDir = path.resolve(process.cwd(), '..', 'artifacts', 'e2e', 'warehouse-commercial')
await mkdir(artifactDir, { recursive: true })

function responseFor(url) {
  const parsed = new URL(url)
  if (parsed.pathname === '/api/v1/warehouses') return [{ id: 'w-1', code: 'WH-SH', name: '上海仓', status: 'active' }]
  if (parsed.pathname.endsWith('/inventory')) return [{ skuCode: 'SKU-001', onHand: '10', reserved: '2', available: '8' }]
  if (parsed.pathname.endsWith('/reservations')) return [{ reservationKey: 'order:SO-1', orderRef: 'SO-1', status: 'reserved', lines: [{ skuCode: 'SKU-001', quantity: '2' }] }]
  if (parsed.pathname.endsWith('/ledger')) return { items: [{ id: 'l-1', skuCode: 'SKU-001', operationType: 'reserve', onHandDelta: '0', reservedDelta: '2', referenceKey: 'order:SO-1', createdBy: 1, createdAt: '2026-08-14T05:00:00.000Z' }], total: 1, page: 1, pageSize: 20 }
  if (parsed.pathname === '/api/v1/platform-sku-mappings') return [{ id: 'm-1', channel: 'taobao', accountId: 7, externalSku: 'TB-001', internalSkuCode: 'SKU-001', status: 'active' }]
  return []
}

const launchOptions = { headless: true }
if (process.env.E2E_BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.E2E_BROWSER_EXECUTABLE
const browser = await chromium.launch(launchOptions)
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport })
    const page = await context.newPage()
    page.on('pageerror', error => console.log(`E2E_PAGE_ERROR ${error.message}`))
    page.on('console', message => { if (message.type() === 'error') console.log(`E2E_CONSOLE_ERROR ${message.text()}`) })
    page.on('requestfailed', request => console.log(`E2E_REQUEST_FAILED ${request.url()} ${request.failure()?.errorText || ''}`))
    await page.addInitScript(() => {
      localStorage.setItem('platform_token', 'e2e-token')
      localStorage.setItem('platform_user', JSON.stringify({ id: 1, username: 'e2e-admin', role: 'admin' }))
    })
    const mockApi = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: responseFor(route.request().url()) }) })
    await page.route('**/api/v1/**', mockApi)
    await page.route('**/api/auth/**', mockApi)
    await page.goto(`${baseUrl}/warehouses`, { waitUntil: 'networkidle' })
    console.log(`E2E_PAGE viewport=${viewport.name} url=${page.url()} title=${await page.title()}`)
    console.log((await page.locator('body').innerText()).slice(0, 500))
    await page.getByText('平台 SKU 映射', { exact: true }).waitFor({ state: 'visible' })
    await page.getByText('TB-001', { exact: true }).waitFor({ state: 'visible' })
    await page.getByText('SKU-001', { exact: true }).first().waitFor({ state: 'visible' })
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(pageOverflow, false, `${viewport.name} viewport has horizontal page overflow`)
    const bodyText = await page.locator('body').innerText()
    assert.match(bodyText, /WH-SH/)
    assert.match(bodyText, /TB-001/)
    await page.screenshot({ path: path.join(artifactDir, `${viewport.name}.png`), fullPage: true })
    console.log(`E2E_PASS viewport=${viewport.name} url=${page.url()}`)
    await context.close()
  }
} finally {
  await browser.close()
}
