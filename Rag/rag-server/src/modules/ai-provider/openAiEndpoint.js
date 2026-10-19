function normalizeOpenAiBaseUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new Error('请填写有效的 Base URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 不能包含账号、查询参数或锚点')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '')
  url.pathname = path || '/v1'
  return url.toString().replace(/\/$/, '')
}
module.exports = { normalizeOpenAiBaseUrl }
