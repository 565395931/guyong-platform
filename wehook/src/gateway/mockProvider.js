class MockProvider {
  constructor(options = {}) {
    this.calls = []
    this.outcomes = Array.isArray(options.outcomes) ? [...options.outcomes] : []
    this.defaultOutcome = options.defaultOutcome || 'sent'
  }

  async send(command) {
    this.calls.push({ commandId: command.commandId, payload: command.payload, at: new Date().toISOString() })
    const outcome = this.outcomes.length ? this.outcomes.shift() : this.defaultOutcome
    if (outcome === 'failed') return { success: false, status: 'failed', errorCode: 'MOCK_FAILED', errorMessage: 'Mock provider failure' }
    return { success: true, status: outcome === 'accepted' ? 'accepted' : 'sent', channelMessageId: `mock-${this.calls.length}` }
  }
}

module.exports = MockProvider
