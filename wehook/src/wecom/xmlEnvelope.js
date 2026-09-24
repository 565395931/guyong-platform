function assertXmlSize(xml, maxBytes) {
  const text = String(xml || '')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('XML envelope is too large')
  if (!/^\s*<xml(?:\s[^>]*)?>[\s\S]*<\/xml>\s*$/.test(text)) throw new Error('XML envelope is malformed')
  return text
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function readXmlTag(xml, tag, { required = true, maxBytes = 1024 * 1024 } = {}) {
  const text = assertXmlSize(xml, maxBytes)
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tag)) throw new Error('XML tag name is invalid')
  const openingTags = text.match(new RegExp(`<${tag}(?=[\\s>])`, 'g')) || []
  const pattern = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))\\s*</${tag}>`, 'g')
  const matches = [...text.matchAll(pattern)]
  if (!matches.length && !required && !openingTags.length) return null
  if (matches.length !== 1 || openingTags.length !== 1) {
    throw new Error(`${tag} must appear exactly once in XML envelope`)
  }
  return matches[0][1] !== undefined ? matches[0][1] : decodeXmlEntities(matches[0][2])
}

function parseEncryptedEnvelope(xml, options = {}) {
  return { encrypted: readXmlTag(xml, 'Encrypt', options) }
}

function parseCallbackNotification(xml, options = {}) {
  return {
    event: readXmlTag(xml, 'Event', options),
    token: readXmlTag(xml, 'Token', options),
    openKfId: readXmlTag(xml, 'OpenKfId', { ...options, required: false })
  }
}

module.exports = {
  decodeXmlEntities,
  parseCallbackNotification,
  parseEncryptedEnvelope,
  readXmlTag
}

