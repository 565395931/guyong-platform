const { createCredentialCipher } = require('./credentialCipher')
const { maskCredential } = require('./providerRegistry')

const CREDENTIAL_KEY = 'bailian_credential_ciphertext'

/**
 * 百炼（阿里云 DashScope）应用凭据：AccessKeyId + AccessKeySecret。
 *
 * 为什么要单独存：这两个值原先**只能写在 .env 里**，而 .env 里是空的，页面上又填不了；
 * 知识库上传/解析（localParserService）依赖它们。
 *
 * 与 ai-provider 的密钥一致：**密文存配置表**（AES-256-GCM），页面上只回显掩码，
 * 不把明文写进配置表、日志或接口响应。
 *
 * 读取顺序：数据库密文 → .env → 都没有则返回 source='none'。
 */
function createBailianCredentialService({
  getConfig,
  updateConfig,
  cipher = createCredentialCipher(),
  env = process.env
} = {}) {
  const environmentFallback = {
    accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
    accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || ''
  }

  function normalize(payload = {}) {
    return {
      accessKeyId: String(payload.accessKeyId || '').trim(),
      accessKeySecret: String(payload.accessKeySecret || '').trim()
    }
  }

  async function getCredential() {
    const encrypted = await getConfig(CREDENTIAL_KEY)
    if (encrypted) {
      try {
        const parsed = normalize(JSON.parse(cipher.decrypt(encrypted)))
        return { ...parsed, source: 'database' }
      } catch (err) {
        console.error('[Bailian] 凭据解密失败，回退环境变量:', err.message)
      }
    }
    const hasEnv = Boolean(environmentFallback.accessKeyId && environmentFallback.accessKeySecret)
    return { ...environmentFallback, source: hasEnv ? 'environment' : 'none' }
  }

  /** 给页面看的状态：只回掩码，绝不回明文。 */
  async function getStatus() {
    const credential = await getCredential()
    return {
      credential: {
        configured: Boolean(credential.accessKeyId && credential.accessKeySecret),
        accessKeyIdMasked: credential.accessKeyId
          ? `${credential.accessKeyId.slice(0, 4)}······${credential.accessKeyId.slice(-4)}`
          : '',
        secret: maskCredential(credential.accessKeySecret, credential.source),
        source: credential.source
      }
    }
  }

  async function saveCredential(payload, updatedBy = null) {
    const normalized = normalize(payload)
    if (!normalized.accessKeyId || !normalized.accessKeySecret) {
      throw new Error('AccessKeyId 与 AccessKeySecret 都要填')
    }
    if (normalized.accessKeyId.length > 128 || normalized.accessKeySecret.length > 256) {
      throw new Error('凭据长度超出预期，请检查是否粘贴了多余内容')
    }
    const result = await updateConfig(CREDENTIAL_KEY, cipher.encrypt(JSON.stringify(normalized)), updatedBy)
    // 同步到 process.env：少数模块在加载时读取环境变量，重启后能拿到同一份值
    if (result.success && env === process.env) {
      process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = normalized.accessKeyId
      process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = normalized.accessKeySecret
    }
    return result
  }

  async function clearCredential(updatedBy = null) {
    const result = await updateConfig(CREDENTIAL_KEY, null, updatedBy)
    if (result.success && env === process.env) {
      process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = environmentFallback.accessKeyId
      process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = environmentFallback.accessKeySecret
    }
    return result
  }

  return { getCredential, getStatus, saveCredential, clearCredential, CREDENTIAL_KEY }
}

// 懒加载单例：与 providerService 一致——加密密钥可能没配，
// 这种情况要等到真正保存/读取时才报错，而不是在 require 阶段就把整个后端拖垮。
let singleton = null
function getBailianCredentialService() {
  if (!singleton) {
    const configService = require('../../services/configService')
    const encryptionKey = process.env.AI_PROVIDER_CREDENTIAL_KEY || process.env.PLATFORM_CREDENTIAL_KEY
    const cipher = encryptionKey ? createCredentialCipher({ key: encryptionKey }) : {
      encrypt() { throw new Error('AI_PROVIDER_CREDENTIAL_KEY is required to save API keys') },
      decrypt() { throw new Error('AI_PROVIDER_CREDENTIAL_KEY is required to read saved API keys') }
    }
    singleton = createBailianCredentialService({
      getConfig: configService.getConfig,
      updateConfig: configService.updateConfig,
      cipher
    })
  }
  return singleton
}

module.exports = {
  createBailianCredentialService,
  getBailianCredentialService,
  BAILIAN_CREDENTIAL_KEY: CREDENTIAL_KEY
}
