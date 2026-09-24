import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const baseUrl = process.env.E2E_BASE_URL || 'https://127.0.0.1:3003'
const token = process.env.E2E_AUTH_TOKEN
if (!token) throw new Error('E2E_AUTH_TOKEN is required')

const artifactDir = path.resolve(process.cwd(), '..', 'artifacts', 'e2e', 'catalog-quotation')
await mkdir(artifactDir, { recursive: true })
const launchOptions = { headless: true }
if (process.env.E2E_BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.E2E_BROWSER_EXECUTABLE

const browser = await chromium.launch(launchOptions)
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ authToken }) => {
    localStorage.setItem('platform_token', authToken)
    localStorage.setItem('platform_user', JSON.stringify({ id: 1, username: 'catalog-e2e', role: 'admin' }))
  }, { authToken: token })

  await page.goto(`${baseUrl}/catalog`, { waitUntil: 'networkidle' })
  await page.getByText('前档疏水涂层（不隔热）', { exact: true }).waitFor({ state: 'visible' })
  const image = page.locator('.product-thumbnail img').first()
  await image.waitFor({ state: 'visible' })
  const imageState = await image.evaluate(element => ({ complete: element.complete, width: element.naturalWidth, height: element.naturalHeight }))
  assert.equal(imageState.complete, true)
  assert.ok(imageState.width > 0 && imageState.height > 0, 'catalog image did not render')
  assert.equal(errors.length, 0, `page errors: ${errors.join('; ')}`)
  await page.screenshot({ path: path.join(artifactDir, 'catalog-products.png'), fullPage: true })
  console.log(JSON.stringify({ status: 'pass', product: '前档疏水涂层（不隔热）', image: imageState }))
  await context.close()
} finally {
  await browser.close()
}
