'use strict'

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3001'

function normalizeServerUrl(value, fallback = DEFAULT_SERVER_URL) {
  const candidate = String(value || fallback).trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('服务器地址必须是完整的 http(s) URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('服务器地址仅支持 http 或 https')
  }
  if (parsed.username || parsed.password) {
    throw new Error('服务器地址不能包含账号或密码')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('服务器地址不能包含路径、查询参数或片段')
  }
  return parsed.origin
}

function buildRuntimeConfig(serverUrl, { isDevelopment = false } = {}) {
  if (isDevelopment && !serverUrl) {
    return Object.freeze({
      serverUrl: '',
      apiBaseUrl: '/api',
      wsUrl: '',
      mode: 'vite-proxy'
    })
  }

  const normalized = normalizeServerUrl(serverUrl)
  return Object.freeze({
    serverUrl: normalized,
    apiBaseUrl: `${normalized}/api`,
    wsUrl: normalized,
    mode: 'remote-server'
  })
}

module.exports = {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  buildRuntimeConfig
}
