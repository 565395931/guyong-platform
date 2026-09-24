const crypto = require('crypto')
const { createRuntimeConfigApply } = require('../cloud-gateway/gatewayProtocol')

function createRuntimeConfigPublisher({
  getLink,
  cipher,
  timeoutMs = 5000,
  randomUUID = crypto.randomUUID
}) {
  if (typeof getLink !== 'function' || !cipher) {
    throw new Error('runtime config publisher dependencies are required')
  }

  return {
    publish(snapshot, { status = 'active' } = {}) {
      const link = getLink()
      if (!link?.ready || typeof link.send !== 'function') {
        return Promise.reject(new Error('cloud gateway is not connected'))
      }
      const connectionId = Number(snapshot?.connectionId)
      const configVersion = Number(snapshot?.configVersion)
      if (!Number.isInteger(connectionId) || connectionId <= 0 || !Number.isInteger(configVersion) || configVersion <= 0) {
        return Promise.reject(new Error('runtime snapshot connectionId and configVersion are required'))
      }
      if (!['active', 'disabled'].includes(status)) {
        return Promise.reject(new Error('runtime snapshot status is invalid'))
      }
      const requestId = String(randomUUID())
      const envelope = createRuntimeConfigApply({
        requestId,
        connectionId,
        configVersion,
        channel: 'wecom_kf',
        status,
        ciphertext: cipher.encrypt(snapshot)
      })
      return new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          clearTimeout(timeout)
          link.off?.('config_applied', onApplied)
          link.removeListener?.('config_applied', onApplied)
        }
        const finish = (handler, value) => {
          if (settled) return
          settled = true
          cleanup()
          handler(value)
        }
        const onApplied = confirmation => {
          const payload = confirmation?.payload || {}
          if (
            payload.requestId !== requestId ||
            Number(payload.connectionId) !== connectionId ||
            Number(payload.configVersion) !== configVersion
          ) return
          if (payload.status !== 'applied') {
            const error = new Error('cloud gateway rejected runtime config')
            error.code = payload.errorCode || 'runtime_config_rejected'
            return finish(reject, error)
          }
          finish(resolve, { connectionId, configVersion, status: 'applied' })
        }
        const timeout = setTimeout(() => {
          const error = new Error('cloud gateway runtime config confirmation timed out')
          error.code = 'runtime_config_timeout'
          finish(reject, error)
        }, timeoutMs)
        timeout.unref?.()
        link.on('config_applied', onApplied)
        try {
          link.send(envelope)
        } catch (error) {
          finish(reject, error)
        }
      })
    }
  }
}

module.exports = { createRuntimeConfigPublisher }
