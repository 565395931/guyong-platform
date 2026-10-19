// Operator deployment helper. Emits a one-use code to a private pipe only.
// Run with the control-plane environment and an explicitly authorized shop ID.
const { FileSaasStore } = require('../src/saas/fileSaasStore')
const { signSession } = require('../src/saas/security')
async function main() {
  const id = process.argv[2]
  if (!/^[0-9a-f-]{36}$/i.test(id || '') || !process.env.CONTROL_PLANE_STORE_PATH) throw new Error('explicit shop ID and store path required')
  const store = new FileSaasStore(process.env.CONTROL_PLANE_STORE_PATH)
  const data = await store.snapshot()
  const shop = data.shopInstallations.find(row => row.id === id)
  if (!shop) throw new Error('shop not found')
  const operator = data.users.find(row => row.role === 'operator' && row.status === 'active' && !row.mustChangePassword)
  if (!operator || !process.env.CONTROL_PLANE_SESSION_SECRET) throw new Error('operator unavailable')
  const session = signSession({ id: operator.id, username: operator.username, role: 'operator', mustChangePassword: false }, process.env.CONTROL_PLANE_SESSION_SECRET, 60)
  // The running service owns all writes; a second process must never rewrite its JSON store.
  const response = await fetch('http://127.0.0.1:8790/v1/admin/local-pairings', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `lw_session=${session}` },
    body: JSON.stringify({ tenantId: shop.tenantId, installationIds: [id] }), signal: AbortSignal.timeout(5000) })
  const body = await response.json()
  if (!response.ok || !body.success) throw new Error('pairing rejected')
  const result = body.data
  process.stdout.write(JSON.stringify({ code: result.code, shopName: shop.name }))
}
main().catch(() => { process.stderr.write('pairing could not be issued\n'); process.exitCode = 1 })
