const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const GatewayServer = require('../gateway/gatewayServer')
const FileEventStore = require('../gateway/fileEventStore')
const { ShopGatewayAdapter } = require('./shopGatewayAdapter')

// Each paired workstation owns a separate durable outbox. Never broadcast a
// tenant's messages over another tenant's gateway, even if local IDs coincide.
class LocalShopTransport {
  constructor({ server, pairing, store, messaging, directory, intervalMs = 1000 }) {
    Object.assign(this, { pairing, store, messaging, directory })
    this.bridges = new Map()
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
    this.upgrade = (req, socket, head) => {
      if (req.url !== '/v1/local-shop/socket') return
      // Native backend clients don't send Origin. Browser connections are not
      // supported: credentials must stay in the local backend, not JavaScript.
      if (req.headers.origin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws))
    }
    server.on('upgrade', this.upgrade)
    server.once('close', () => this.close())
    this.timer = setInterval(() => this.pump().catch(() => {}), intervalMs)
    this.timer.unref?.()
    this.server = server
  }

  accept(socket) {
    const timeout = setTimeout(() => socket.close(1008, 'authentication timeout'), 5000)
    timeout.unref?.()
    socket.once('close', () => clearTimeout(timeout))
    socket.once('message', async raw => {
      clearTimeout(timeout)
      try {
        const hello = JSON.parse(String(raw))
        if (hello.type !== 'connection.hello' || hello.protocolVersion !== '0.1') throw new Error('invalid hello')
        const token = hello.payload?.authToken
        const client = await this.pairing.bind(token, hello.payload?.accountBindings)
        let bridge = this.bridges.get(client.id)
        if (bridge && JSON.stringify(bridge.client.bindings) !== JSON.stringify(client.bindings)) {
          for (const connection of bridge.gateway.clients) connection.socket.close(1008, 'bindings changed')
          bridge.gateway.stop(); this.bridges.delete(client.id); bridge = null
        }
        if (!bridge) {
          const bindings = client.bindings.map(row => ({ tenantId: client.tenantId, installationId: row.gatewayAccountId, accountId: row.accountId }))
          const outbox = new FileEventStore(path.join(this.directory, `${client.id}.json`))
          for (const accountId of new Set(outbox.state.events.map(row => row.payload?.accountId).filter(id => id != null))) {
            if (!bindings.some(row => row.accountId === accountId)) outbox.purgeAccount(accountId)
          }
          const gateway = new GatewayServer({
            config: { authToken: token, heartbeatMs: 15000, ackTimeoutMs: 10000, retryMaxMs: 30000, maxRetries: 100 }, store: outbox,
            provider: { send: command => bridge.adapter.send(command) },
            accountResolver: (id, payload) => bindings.some(row => row.accountId === id && row.installationId === payload.gatewayAccountId)
          })
          bridge = { gateway, token, client, bindings, ingested: new Set() }
          bridge.adapter = new ShopGatewayAdapter({ store: this.store, messaging: this.messaging, gateway, bindings,
            imageReference: message => ({ url: `/v1/local-shop/media/${message.id}` }) })
          const handle = gateway.handleMessage.bind(gateway)
          gateway.handleMessage = async (connection, envelope) => {
            const current = await this.pairing.authenticate(bridge.token)
            if (!current || JSON.stringify(current.bindings) !== JSON.stringify(bridge.client.bindings)) { connection.socket.close(1008, 'credential or bindings changed'); return }
            if (envelope.type === 'connection.hello') envelope = { ...envelope, payload: { ...envelope.payload, clientId: client.id } }
            return handle(connection, envelope)
          }
          this.bridges.set(client.id, bridge)
        }
        // Replace all earlier consumers, irrespective of the name they supplied.
        for (const old of bridge.gateway.clients) { old.authenticated = false; old.socket.close(1008, 'workstation replaced') }
        const connection = bridge.gateway.attachSocket(socket)
        await bridge.gateway.handleMessage(connection, hello)
        await this.pump()
      } catch { socket.close(1008, 'pairing or shop binding rejected') }
    })
  }

  async publishStatus(client, payload) {
    const { createEnvelope } = require('../protocol')
    const envelope = createEnvelope('channel.message.status', payload, { eventId: 'image-status-' + payload.commandId + '-' + payload.status })
    const bridge = this.bridges.get(client.id)
    if (bridge) return bridge.gateway.publishEvent(envelope)
    if (!/^[a-zA-Z0-9-]+$/.test(client.id)) throw Error('invalid client identifier')
    return new FileEventStore(path.join(this.directory, client.id + '.json')).appendEvent(envelope)
  }

  async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      const data = await this.store.snapshot()
      for (const bridge of this.bridges.values()) {
        const current = await this.pairing.authenticate(bridge.token)
        if (!current || JSON.stringify(current.bindings) !== JSON.stringify(bridge.client.bindings)) {
          for (const connection of bridge.gateway.clients) connection.socket.close(1008, 'credential revoked')
          continue
        }
        for (const connection of bridge.gateway.clients) {
          if (connection.authenticated && connection.lastPongAt < Date.now() - 45000) connection.socket.close(1001, 'heartbeat timeout')
        }
        for (const message of data.messages) {
          if (message.direction !== 'inbound' || message.channel !== 'wechat_shop' || bridge.ingested.has(message.id) ||
            !bridge.bindings.some(row => row.tenantId === message.tenantId && row.installationId === message.installationId)) continue
          try { await bridge.adapter.ingest(message.id); bridge.ingested.add(message.id) }
          catch { /* Keep original message in the control store; next tick retries. */ }
        }
      }
    } finally { this.pumping = false }
  }

  close() {
    clearInterval(this.timer)
    this.server.removeListener('upgrade', this.upgrade)
    for (const bridge of this.bridges.values()) bridge.gateway.stop()
    for (const socket of this.wss.clients) socket.terminate()
    this.wss.close()
  }

  async purgeShop(installationId, clients) {
    if (this.pumping) throw Object.assign(new Error('消息正在同步，请稍后删除'), { code: 'shop_conflict' })
    for (const client of clients) {
      if (!/^[a-zA-Z0-9-]+$/.test(client.id)) throw new Error('invalid client identifier')
      const bridge = this.bridges.get(client.id)
      if (bridge) {
        for (const connection of bridge.gateway.clients) connection.socket.close(1008, 'shop deleted')
        bridge.gateway.stop(); this.bridges.delete(client.id)
      }
      const store = new FileEventStore(path.join(this.directory, `${client.id}.json`))
      for (const binding of client.bindings.filter(row => row.gatewayAccountId === installationId)) store.purgeAccount(binding.accountId)
    }
  }
}
module.exports = { LocalShopTransport }
