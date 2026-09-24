const fs = require('fs')
const path = require('path')

class RuntimeConfigStore {
  constructor(filePath) {
    if (!filePath) throw new Error('runtime config store path is required')
    this.filePath = path.resolve(filePath)
    this.state = { version: 1, connections: {} }
    this.load()
  }

  load() {
    if (!fs.existsSync(this.filePath)) return
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    if (!parsed || parsed.version !== 1 || typeof parsed.connections !== 'object') {
      throw new Error('runtime config store is invalid')
    }
    this.state = parsed
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
    return this.state.connections[String(Number(connectionId))] || null
  }

  async list() {
    return Object.values(this.state.connections)
  }

  async put(record) {
    const stored = {
      connectionId: Number(record.connectionId),
      configVersion: Number(record.configVersion),
      status: record.status,
      ciphertext: record.ciphertext,
      updatedAt: record.updatedAt || new Date().toISOString()
    }
    this.state.connections[String(stored.connectionId)] = stored
    this.persist()
    return stored
  }
}

module.exports = RuntimeConfigStore

