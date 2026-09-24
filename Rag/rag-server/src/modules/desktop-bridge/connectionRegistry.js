class ConnectionRegistry {
  constructor() {
    this.connections = new Map()
  }

  register(nodeId, connection) {
    const previous = this.connections.get(nodeId)
    if (previous && previous.socket !== connection.socket) {
      previous.socket.close(4001, 'Replaced by a newer node connection')
    }
    this.connections.set(nodeId, connection)
    return previous || null
  }

  get(nodeId) {
    return this.connections.get(nodeId) || null
  }

  remove(nodeId, socket) {
    const current = this.connections.get(nodeId)
    if (current?.socket === socket) this.connections.delete(nodeId)
  }

  values() {
    return [...this.connections.values()]
  }

  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const connection of this.connections.values()) {
      connection.socket.close(code, reason)
    }
    this.connections.clear()
  }
}

module.exports = { ConnectionRegistry }
