const fs = require('fs')
const path = require('path')

function sanitizeError(value) {
  return String(value?.message || value || 'unknown sync error')
    .replace(/\b(?:corpsecret|secret|access_token|token)\s*[:=]\s*[^,;\s]+/gi, match => {
      const separator = match.includes(':') ? ':' : '='
      return `${match.split(separator)[0]}${separator}******`
    })
    .slice(0, 400)
}

class WecomSyncStateStore {
  constructor(filePath) {
    if (!filePath) throw new Error('WeCom sync state store path is required')
    this.filePath = path.resolve(filePath)
    this.state = { version: 1, connections: {} }
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (!parsed || parsed.version !== 1 || typeof parsed.connections !== 'object') {
        throw new Error('WeCom sync state store is invalid')
      }
      this.state = parsed
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.renameSync(temporaryPath, this.filePath)
  }

  async get(connectionId) {
    return this.state.connections[String(Number(connectionId))] || {
      cursor: '',
      lastSuccessAt: null,
      lastError: null,
      retryCount: 0
    }
  }

  async markSuccess(connectionId, { cursor }) {
    const key = String(Number(connectionId))
    this.state.connections[key] = {
      ...(await this.get(connectionId)),
      cursor: String(cursor || ''),
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      retryCount: 0
    }
    this.persist()
    return this.state.connections[key]
  }

  async markFailure(connectionId, error) {
    const key = String(Number(connectionId))
    const current = await this.get(connectionId)
    this.state.connections[key] = {
      ...current,
      lastError: sanitizeError(error),
      retryCount: Number(current.retryCount || 0) + 1
    }
    this.persist()
    return this.state.connections[key]
  }
}

module.exports = WecomSyncStateStore

