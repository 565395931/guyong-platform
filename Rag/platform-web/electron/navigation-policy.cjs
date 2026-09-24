'use strict'

function isAllowedNavigation(value, entryUrl, isDevelopment = false) {
  try {
    const url = new URL(value)
    const entry = new URL(entryUrl)
    if (isDevelopment) return url.origin === entry.origin && ['http:', 'https:'].includes(url.protocol)
    url.hash = ''
    entry.hash = ''
    return url.href === entry.href
  } catch {
    return false
  }
}

module.exports = { isAllowedNavigation }
