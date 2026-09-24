export function apiUrl(path, baseUrl = '/api') {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

// Resolve only at display time; keep the original media path in outgoing payloads.
export function assetUrl(value, serverUrl = '') {
  if (!value || !serverUrl || !String(value).startsWith('/')) return value || ''
  return new URL(value, serverUrl).href
}
