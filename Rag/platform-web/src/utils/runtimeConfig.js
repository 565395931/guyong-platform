import { apiUrl, assetUrl } from './connectionUrls.js'

const desktopConfig = typeof window !== 'undefined' ? window.desktopBridge?.config : null
const viteEnvironment = import.meta.env || {}

export const runtimeConfig = Object.freeze({
  isDesktop: Boolean(typeof window !== 'undefined' && window.desktopBridge?.isDesktop),
  apiBaseUrl: desktopConfig?.apiBaseUrl || viteEnvironment.VITE_API_BASE_URL || '/api',
  wsUrl: desktopConfig?.wsUrl || viteEnvironment.VITE_WS_URL || '',
  serverUrl: desktopConfig?.serverUrl || '',
  mode: desktopConfig?.mode || (viteEnvironment.VITE_API_BASE_URL ? 'configured-server' : 'vite-proxy')
})

export function getDesktopBridge() {
  return typeof window !== 'undefined' ? window.desktopBridge || null : null
}

export const resolveApiUrl = path => apiUrl(path, runtimeConfig.apiBaseUrl)
export const resolveAssetUrl = value => assetUrl(value, runtimeConfig.serverUrl || (/^https?:/.test(runtimeConfig.apiBaseUrl) ? new URL(runtimeConfig.apiBaseUrl).origin : ''))
