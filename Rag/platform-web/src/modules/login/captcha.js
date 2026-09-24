export function normalizeCaptchaCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase()
}
