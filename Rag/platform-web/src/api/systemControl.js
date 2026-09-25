import { resolveApiUrl } from '../utils/runtimeConfig.js'

function authorizationHeaders() {
  const token = localStorage.getItem('platform_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function restartBackend(fetchImpl = fetch) {
  const response = await fetchImpl(resolveApiUrl('/v1/system-control/restart-backend'), {
    method: 'POST',
    headers: authorizationHeaders()
  })
  const body = await readJson(response)
  if (!response.ok || body?.success === false) {
    throw new Error(body?.message || `重启请求失败 (${response.status})`)
  }
  return body?.data
}

export async function getBackendStatus(fetchImpl = fetch) {
  const response = await fetchImpl(resolveApiUrl('/v1/system-control/status'), {
    headers: authorizationHeaders(),
    cache: 'no-store'
  })
  const body = await readJson(response)
  if (!response.ok || body?.success === false) {
    throw new Error(body?.message || `后端状态检查失败 (${response.status})`)
  }
  return body?.data
}

const sleep = delay => new Promise(resolve => setTimeout(resolve, delay))

export async function waitForBackendRestart(previousPid, {
  getStatus = getBackendStatus,
  wait = sleep,
  timeoutMs = 90000,
  intervalMs = 1000,
  now = Date.now
} = {}) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      const status = await getStatus()
      if (status?.pid && status.pid !== previousPid) return status
    } catch {
      // A short connection failure is expected while the old process exits.
    }
    await wait(intervalMs)
  }
  throw new Error('后端未在 90 秒内恢复，请查看 Rag/logs/backend.restart.log 后重试')
}
