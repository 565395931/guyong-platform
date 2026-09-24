export function loginUrl(location) {
  if (location.protocol !== 'file:') return '/login'
  const url = new URL(location.href)
  url.hash = '/login'
  return url.href
}

export function clearSession(storage = localStorage) {
  storage.removeItem('platform_token')
  storage.removeItem('platform_user')
}

export function redirectToLogin({ location = window.location, storage = localStorage } = {}) {
  clearSession(storage)
  location.replace(loginUrl(location))
}
