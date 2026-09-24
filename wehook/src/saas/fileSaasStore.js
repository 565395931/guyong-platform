const fs = require('fs')
const path = require('path')

function emptyData() {
  return {
    version: 1,
    tenants: [],
    users: [],
    devices: [],
    plans: [],
    subscriptions: [],
    creditEntries: [],
    reservations: [],
    wecomInstallations: [],
    auditEntries: []
  }
}

class FileSaasStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath)
    this.queue = Promise.resolve()
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    if (!fs.existsSync(this.filePath)) this._write(emptyData())
  }

  _read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    return { ...emptyData(), ...parsed }
  }

  _write(data) {
    const temporary = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, this.filePath)
  }

  snapshot() {
    return Promise.resolve(this._read())
  }

  transaction(mutator) {
    const run = async () => {
      const data = this._read()
      const result = await mutator(data)
      this._write(data)
      return result
    }
    const operation = this.queue.then(run, run)
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

module.exports = { FileSaasStore, emptyData }
