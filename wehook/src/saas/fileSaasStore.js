const fs = require('fs')
const path = require('path')

function emptyData() {
  return {
    version: 2,
    tenants: [],
    users: [],
    devices: [],
    modelKeys: [],
    localPairings: [],
    localClients: [],
    plans: [],
    subscriptions: [],
    creditEntries: [],
    reservations: [],
    moneyEntries: [],
    packageOrders: [],
    modelCalls: [],
    modelCallTotals: [],
    pendingModelCalls: [],
    billingConfigs: [],
    wecomInstallations: [],
    shopInstallations: [],
    shopDrafts: [],
    shopSends: [],
    modelConfigs: [],
    conversations: [],
    customerProfiles: [],
    messages: [],
    wecomProviderState: {},
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
    require('./modelCallRetention').compactModelCalls(data)
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
