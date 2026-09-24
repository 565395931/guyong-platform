import request from './index'

export function getLoginCaptcha() {
  return request.get('/auth/captcha')
}

export function login(data) {
  return request.post('/auth/login', data)
}

export function getSetupStatus() {
  return request.get('/auth/setup-status')
}

export function setupOwner(data) {
  return request.post('/auth/setup', data)
}

export function getMe() {
  return request.get('/auth/me')
}
