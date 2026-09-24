const { createEnvelope } = require('../protocol')
const { isDeepStrictEqual } = require('util')

class CommandService {
  constructor({ store, provider, publish }) {
    this.store = store
    this.provider = provider
    this.publish = publish || (() => {})
  }

  async handle(command) {
    const existing = await this.store.getCommand(command.commandId)
    if (existing) {
      if (!isDeepStrictEqual(existing.payload, command.payload)) {
        const error = new Error('commandId already exists with a different payload')
        error.code = 'command_id_conflict'
        throw error
      }
      await this.publishResult(existing.result, true)
      return existing.result
    }
    const accepted = {
      commandId: command.commandId,
      conversationId: command.payload.conversationId,
      localMessageId: command.payload.localMessageId,
      status: 'accepted'
    }
    // accepted 先落盘；同 commandId 的并发或重连重发只回放已有状态。
    await this.store.putCommand(command.commandId, { payload: command.payload, result: accepted })
    await this.publishResult(accepted)
    let result
    try {
      result = await this.provider.send(command)
    } catch (error) {
      result = {
        success: false,
        status: 'failed',
        errorCode: error.code || 'PROVIDER_ERROR',
        errorMessage: error.message || 'Provider send failed'
      }
    }
    const status = {
      commandId: command.commandId,
      conversationId: command.payload.conversationId,
      localMessageId: command.payload.localMessageId,
      status: result.status,
      channelMessageId: result.channelMessageId || null,
      errorCode: result.errorCode || null,
      errorMessage: result.errorMessage || null,
      occurredAt: new Date().toISOString()
    }
    await this.store.updateCommand(command.commandId, { payload: command.payload, result: status })
    await this.publishResult(status)
    return status
  }

  async publishResult(result, replayed = false) {
    if (!result) return
    const type = result.status === 'accepted' ? 'channel.message.accepted' : 'channel.message.status'
    const prefix = type === 'channel.message.accepted' ? 'accepted' : 'status'
    await this.publish({
      ...createEnvelope(type, result, { eventId: `${prefix}-${result.commandId}-${result.status}` }),
      replayed
    })
  }
}

module.exports = CommandService
