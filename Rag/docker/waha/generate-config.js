#!/usr/bin/env node
/**
 * WAHA 实例池配置生成器（全自动版）
 *
 * 一条命令同时更新 docker-compose.yml 和 rag-server/.env，无需手动复制。
 * 支持扩容和缩减，缩减时自动检测并警告受影响的实例。
 * 可从项目任意目录运行，路径自动解析。
 *
 * 用法：
 *   node docker/waha/generate-config.js --count 5 --apply
 *
 * 参数：
 *   --count, -c <N>   实例数量（1-50，默认 2）
 *   --engine <name>   WAHA engine：webjs 或 gows
 *   --apply           全自动写入 docker-compose.yml + rag-server/.env
 *   --force           缩减时跳过确认提示
 *   --help, -h        显示帮助
 *
 * 端口规则：实例 i 的宿主机端口 = 3004 + i（从 1 开始）
 *   实例 1 → 3005, 实例 2 → 3006, ... 实例 N → 3004+N
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')

// ========== 路径解析（基于脚本自身位置，不依赖 cwd） ==========
const SCRIPT_DIR = __dirname                    // docker/waha/
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..')  // 项目根目录
const COMPOSE_PATH = path.join(SCRIPT_DIR, 'docker-compose.yml')
const ENV_PATH = path.join(PROJECT_ROOT, 'rag-server', '.env')

// ========== WAHA 镜像版本锁定 ==========
// 优先从 .env 读取 WAHA_IMAGE_TAG，其次从环境变量，最后用默认值
// 修改此值来升级 WAHA 版本，升级前请先验证补丁兼容性
// 查看可用版本：node rag-server/scripts/waha-version-check.js
function readEnvValue(name) {
  try {
    if (fs.existsSync(ENV_PATH)) {
      const content = fs.readFileSync(ENV_PATH, 'utf8')
      const match = content.match(new RegExp(`^${name}=(.+)$`, 'm'))
      if (match) return match[1].trim()
    }
  } catch {}
  return null
}

function readImageTagFromEnv() {
  return readEnvValue('WAHA_IMAGE_TAG')
}

function readImageRefFromEnv() {
  return readEnvValue('WAHA_IMAGE_REF')
}

function readArgValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : null
}

function normalizeWahaEngine(value) {
  const normalized = String(value || 'gows').trim().toLowerCase()
  return normalized === 'gows' ? 'gows' : 'webjs'
}

const WAHA_ENGINE = normalizeWahaEngine(readArgValue('--engine') || process.env.WAHA_ENGINE || readEnvValue('WAHA_ENGINE'))
const WAHA_IS_GOWS = WAHA_ENGINE === 'gows'
const DEFAULT_GOWS_IMAGE_REF = 'devlikeapro/waha@sha256:abbdd0dd969f06801904e902a9daa853b2e82667ba747eec266abcbeffce5e00'
const WAHA_IMAGE_REF = process.env.WAHA_IMAGE_REF || readImageRefFromEnv() || (WAHA_IS_GOWS ? DEFAULT_GOWS_IMAGE_REF : null)
const WAHA_IMAGE_TAG = process.env.WAHA_IMAGE_TAG || readImageTagFromEnv() || (WAHA_IS_GOWS ? 'gows' : '2026.6.2')
const WAHA_IMAGE = WAHA_IMAGE_REF || `devlikeapro/waha:${WAHA_IMAGE_TAG}`
const WAHA_WEB_VERSION = '2.3000.1043180520-alpha'
const WAHA_VOLUME_PREFIX = WAHA_IS_GOWS ? 'waha-gows-data' : 'waha-data'
const GOWS_HISTORY_DEFAULTS = {
  WAHA_GOWS_DEVICE_REQUIRE_FULL_SYNC: 'false',
  WAHA_GOWS_DEVICE_HISTORY_SYNC_FULL_SYNC_DAYS_LIMIT: '365',
  WAHA_GOWS_DEVICE_HISTORY_SYNC_RECENT_SYNC_DAYS_LIMIT: '30',
  WAHA_GOWS_DEVICE_HISTORY_SYNC_INITIAL_SYNC_MAX_MESSAGES_PER_CHAT: '100',
  WAHA_GOWS_DEVICE_HISTORY_SYNC_FULL_SYNC_SIZE_MB_LIMIT: '512',
  WAHA_GOWS_DEVICE_HISTORY_SYNC_STORAGE_QUOTA_MB: '1024'
}

// ========== 参数解析 ==========
const args = process.argv.slice(2)
let count = 2
let apply = false
let force = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (/^--count\d+/.test(arg) || /^-c\d+/.test(arg)) {
    console.error('❌ 错误：--count/-c 与数字之间必须有空格，例如：--count 2 --apply')
    process.exit(1)
  }
  if (/^\d+--/.test(arg)) {
    console.error('❌ 错误：数字参数与后续选项之间必须有空格，例如：--count 2 --apply')
    process.exit(1)
  }

  if (args[i] === '--count' || args[i] === '-c') {
    const rawCount = args[i + 1]
    if (!rawCount || !/^\d+$/.test(rawCount)) {
      console.error('❌ 错误：--count 后必须是独立的整数参数，例如：--count 2 --apply')
      if (rawCount && rawCount.includes('--apply')) {
        console.error('   检测到疑似少了空格：请使用 "--count 2 --apply"，不要写成 "--count 2--apply"')
      }
      process.exit(1)
    }
    count = Number(rawCount)
    if (count < 1 || count > 50) {
      console.error('❌ 错误：--count 必须是 1-50 之间的整数')
      process.exit(1)
    }
    i++
  } else if (args[i] === '--apply') {
    apply = true
  } else if (args[i] === '--force') {
    force = true
  } else if (args[i] === '--engine') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) {
      console.error('ERROR: --engine must be followed by webjs or gows')
      process.exit(1)
    }
    i++
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
WAHA 实例池配置生成器（全自动版）

用法（从项目根目录运行）：
  node docker/waha/generate-config.js --count 5 --apply

参数：
  --count, -c <N>    实例数量（1-50，默认 2）
  --engine <name>    WAHA engine：webjs 或 gows
  --apply            全自动写入 docker-compose.yml + rag-server/.env
  --force            缩减时跳过确认提示
  --help, -h         显示帮助

示例：
  # 预览 5 个实例的配置（不写入文件）
  node docker/waha/generate-config.js --count 5

  # 扩容到 5 个实例
  node docker/waha/generate-config.js --count 5 --apply

  # 预览 GOWS 配置
  node docker/waha/generate-config.js --count 2 --engine gows

  # 缩减到 2 个实例（会提示确认）
  node docker/waha/generate-config.js --count 2 --apply

  # 缩减到 2 个实例（跳过确认）
  node docker/waha/generate-config.js --count 2 --apply --force
`)
    process.exit(0)
  }
}

// ========== 读取当前实例数量 ==========
function getCurrentCount() {
  try {
    if (!fs.existsSync(COMPOSE_PATH)) return 0
    const content = fs.readFileSync(COMPOSE_PATH, 'utf8')
    // 匹配 "waha-N:" 格式的服务名，统计数量
    const matches = content.match(/^  waha-(\d+):/gm)
    if (!matches) return 0
    return matches.length
  } catch {
    return 0
  }
}

// ========== 生成 API Key ==========
function generateApiKey(index) {
  return `waha-key-${crypto.randomBytes(8).toString('hex')}`
}

// ========== 读取已有实例 API Key，避免扩容时轮换旧实例密钥 ==========
function readExistingInstances() {
  const byPort = new Map()

  // 1. 优先读取 docker-compose.yml 中当前容器实际配置
  if (fs.existsSync(COMPOSE_PATH)) {
    const content = fs.readFileSync(COMPOSE_PATH, 'utf8')
    const blockRegex = /waha-(\d+):[\s\S]*?ports:\s*\n\s*- "(\d+):3000"[\s\S]*?WHATSAPP_API_KEY=([^\s\n]+)/g
    let match
    while ((match = blockRegex.exec(content)) !== null) {
      const port = Number(match[2])
      const apiKey = match[3].trim()
      if (port && apiKey) {
        byPort.set(port, { port, apiKey, host: `http://localhost:${port}` })
      }
    }

    // 读取已有的 per-instance WHATSAPP_HOOK_URL（保留 account_id 映射，避免扩容时丢失）
    const hookUrlRegex = /waha-(\d+):[\s\S]*?WHATSAPP_API_KEY=[^\n]+\n[\s\S]*?WHATSAPP_HOOK_URL=([^\s\n]+)/g
    let hookMatch
    while ((hookMatch = hookUrlRegex.exec(content)) !== null) {
      // 通过容器名找到对应端口（waha-N → port 3004+N）
      const idx = Number(hookMatch[1])
      const port = 3004 + idx
      const existing = byPort.get(port)
      if (existing) {
        existing.hookUrl = hookMatch[2].trim()
      }
    }
  }

  // 2. 若 compose 没有，再读取 .env 的 WAHA_INSTANCES
  if (byPort.size === 0 && fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf8')
    const instancesMatch = content.match(/^WAHA_INSTANCES=(.+)$/m)
    if (instancesMatch) {
      try {
        const parsed = JSON.parse(instancesMatch[1].trim())
        if (Array.isArray(parsed)) {
          for (const inst of parsed) {
            if (inst.port && inst.apiKey) {
              byPort.set(inst.port, {
                port: inst.port,
                apiKey: inst.apiKey,
                host: inst.host || `http://localhost:${inst.port}`,
                engine: normalizeWahaEngine(inst.engine)
              })
            }
          }
        }
      } catch {
        // 忽略旧配置解析失败，后续生成新 key
      }
    }
  }

  return byPort
}

// ========== 生成实例配置 ==========
function generateInstances(n) {
  const existingByPort = readExistingInstances()
  const instances = []
  for (let i = 1; i <= n; i++) {
    const port = 3004 + i
    const existing = existingByPort.get(port)
    instances.push({
      port,
      apiKey: existing?.apiKey || generateApiKey(i),
      host: existing?.host || `http://localhost:${port}`,
      hookUrl: existing?.hookUrl || null,
      engine: WAHA_ENGINE
    })
  }
  return instances
}

// ========== 读取已有 .env 中的配置 ==========
function readEnvConfig() {
  if (!fs.existsSync(ENV_PATH)) return {}
  const content = fs.readFileSync(ENV_PATH, 'utf8')
  const config = {}

  // 代理配置
  const proxy = {}
  const serverMatch = content.match(/^WHATSAPP_PROXY_SERVER=(.+)$/m)
  if (serverMatch) proxy.server = serverMatch[1].trim()
  const userMatch = content.match(/^WHATSAPP_PROXY_SERVER_USERNAME=(.+)$/m)
  if (userMatch) proxy.username = userMatch[1].trim()
  const passMatch = content.match(/^WHATSAPP_PROXY_SERVER_PASSWORD=(.+)$/m)
  if (passMatch) proxy.password = passMatch[1].trim()
  if (proxy.server) config.proxy = proxy

  // Webhook 配置（全局 fallback）
  const hookUrlMatch = content.match(/^WHATSAPP_HOOK_URL=(.+)$/m)
  if (hookUrlMatch) config.hookUrl = hookUrlMatch[1].trim()
  const hookEventsMatch = content.match(/^WHATSAPP_HOOK_EVENTS=(.+)$/m)
  if (hookEventsMatch) config.hookEvents = hookEventsMatch[1].trim()

  config.engine = WAHA_ENGINE
  config.gowsHistory = {}
  for (const [key, defaultValue] of Object.entries(GOWS_HISTORY_DEFAULTS)) {
    config.gowsHistory[key] = process.env[key] || readEnvValue(key) || defaultValue
  }

  return config
}

// ========== 生成 docker-compose.yml ==========
function generateDockerCompose(instances, envConfig) {
  const proxyConfig = envConfig.proxy || null

  // 注意：WHATSAPP_HOOK_URL 按 per-instance 保留（每个容器有独立的 account_id）。
  // 扩容时从已有 docker-compose.yml 中读取并保留 per-instance webhook。
  // 这确保容器重建后 account_id 映射不丢失，同时不会串号。

  const services = instances.map((inst, i) => {
    const idx = i + 1
    const port = inst.port
    const apiKey = inst.apiKey

    // 构建环境变量列表
    const envLines = [`      - WHATSAPP_API_KEY=${apiKey}`]
    if (WAHA_IS_GOWS) {
      envLines.push('      - WHATSAPP_DEFAULT_ENGINE=GOWS')
      for (const [key, value] of Object.entries(envConfig.gowsHistory || GOWS_HISTORY_DEFAULTS)) {
        envLines.push(`      - ${key}=${value}`)
      }
    }
    if (proxyConfig) {
      envLines.push(`      - WHATSAPP_PROXY_SERVER=${proxyConfig.server}`)
      if (proxyConfig.username) envLines.push(`      - WHATSAPP_PROXY_SERVER_USERNAME=${proxyConfig.username}`)
      if (proxyConfig.password) envLines.push(`      - WHATSAPP_PROXY_SERVER_PASSWORD=${proxyConfig.password}`)
    }
    // Per-instance webhook URL（保留已有映射，新实例留空由扫码流程传入）
    if (inst.hookUrl) {
      envLines.push(`      - WHATSAPP_HOOK_URL=${inst.hookUrl}`)
      envLines.push(`      - WHATSAPP_HOOK_EVENTS=message`)
    } else {
      envLines.push(`      # Webhook: 首次扫码时由 admin UI 传入 account_id`)
    }

    const volumeLines = [`      - ${WAHA_VOLUME_PREFIX}-${idx}:/app/.sessions`]
    if (!WAHA_IS_GOWS) {
      volumeLines.push(
        '      # [HOTFIX] parseMessageIdSerialized null safety + _serialized fallback',
        '      # [HOTFIX] WhatsApp Web version lock + canCheckStatusRankingPosterGating try-catch',
        '      # [HOTFIX] getChats per-chat error handling (skip corrupted IndexedDB entries)',
        '      # HOTFIX date: 2026-07-15 | WAHA 2026.6.2 | verify after image upgrades',
        '      - ./patches/ids.js:/app/dist/core/utils/ids.js:ro',
        '      - ./patches/webjs/session.webjs.core.js:/app/dist/core/engines/webjs/session.webjs.core.js:ro',
        '      - ./patches/webjs/WebjsClientCore.js:/app/dist/core/engines/webjs/WebjsClientCore.js:ro',
        '      - ./patches/webjs/Utils.js:/app/node_modules/whatsapp-web.js/src/util/Injected/Utils.js:ro',
        `      - ./patches/webjs/${WAHA_WEB_VERSION}.html:/app/dist/core/engines/webjs/${WAHA_WEB_VERSION}.html:ro`
      )
    }

    return `  waha-${idx}:
    image: ${WAHA_IMAGE}
    container_name: waha-${idx}
    restart: always
    ports:
      - "${port}:3000"
    environment:
${envLines.join('\n')}
    volumes:
${volumeLines.join('\n')}
    networks:
      - waha-network`
  })

  const volumes = instances.map((_, i) => `  ${WAHA_VOLUME_PREFIX}-${i + 1}:`).join('\n')

  const proxyNote = proxyConfig
    ? `# 代理：${proxyConfig.server}\n`
    : `# 代理：未配置（在中国大陆需配置 WHATSAPP_PROXY_SERVER 才能连接 WhatsApp）\n`
  const note = `# Webhook: 每个容器通过 WHATSAPP_HOOK_URL 固定 account_id，避免 session/env 双 webhook\n`
  const engineNotes = WAHA_IS_GOWS
    ? `#   - Engine 固定为 GOWS，不使用 Chromium、WhatsApp Web HTML 或 WebJS 补丁
#   - 首次切换/扫码后需要验证 history sync、webhook payload 和媒体字段
#   - 升级检查：GOWS 模式下 waha-version-check.js 会跳过 WebJS patch 检查`
    : `#   - WhatsApp Web HTML 版本也已锁定 (via 补丁)
#   - 升级检查：node rag-server/scripts/waha-version-check.js
#   - 升级流程：① 查 release notes ② 改 generate-config.js 中 WAHA_IMAGE_TAG ③ 验证补丁 ④ --apply + docker compose up -d --force-recreate`
  const applyCommand = `node docker/waha/generate-config.js --count <N>${WAHA_IS_GOWS ? ' --engine gows' : ''} --apply`

  return `# ============================================================
# WAHA (WhatsApp HTTP API) 多实例池 - Docker Compose
# ============================================================
# 镜像：${WAHA_IMAGE} (版本锁定，升级前请先验证补丁兼容性)
# 说明：每容器运行一个独立 WAHA 实例
#       每个实例对应一个 WhatsApp 账号
# 版本锁定说明：
#   - 镜像引用固定为 ${WAHA_IMAGE}，GOWS 优先使用 digest 锁定，避免 pull 拉到不兼容的新版本
${engineNotes}
#
# 本文件由 generate-config.js 自动生成（共 ${instances.length} 个实例）
# 扩容/缩减：${applyCommand}
#
${proxyNote}${note}#
# 常用命令（在 docker/waha/ 目录下执行）：
#   启动：    docker compose up -d
#   更新镜像/engine/env：docker compose up -d --force-recreate
#   查看状态：docker compose ps
#   查看日志：docker compose logs -f
#   停止：    docker compose stop
#   启动(已停止)：docker compose start
#   停止并删除容器：docker compose down
#   停止并删除容器+数据(谨慎!)：docker compose down -v
# ============================================================

services:
${services.join('\n\n')}

volumes:
${volumes}

networks:
  waha-network:
    driver: bridge
`
}

// ========== 生成 .env 配置片段 ==========
function generateEnvSection(instances, envConfig) {
  const instancesJson = JSON.stringify(instances)
  const endPort = 3004 + instances.length
  const proxyConfig = envConfig.proxy || null
  const hookUrl = envConfig.hookUrl || null
  const hookEvents = envConfig.hookEvents || 'message'
  const gowsHistory = envConfig.gowsHistory || GOWS_HISTORY_DEFAULTS
  const gowsLines = Object.entries(gowsHistory)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  const applyCommand = `node docker/waha/generate-config.js --count <N>${WAHA_IS_GOWS ? ' --engine gows' : ''} --apply`

  // 代理配置段
  const proxyLines = proxyConfig
    ? `# 代理服务器（中国大陆必须配置，否则无法连接 WhatsApp）
WHATSAPP_PROXY_SERVER=${proxyConfig.server}
${proxyConfig.username ? `WHATSAPP_PROXY_SERVER_USERNAME=${proxyConfig.username}\n` : ''}${proxyConfig.password ? `WHATSAPP_PROXY_SERVER_PASSWORD=${proxyConfig.password}\n` : ''}`
    : `# 代理服务器（中国大陆必须配置，否则无法连接 WhatsApp）
# 格式：host:port（不带 http:// 前缀）
# WHATSAPP_PROXY_SERVER=your-proxy-host:3128
# WHATSAPP_PROXY_SERVER_USERNAME=username
# WHATSAPP_PROXY_SERVER_PASSWORD=password`

  // Webhook 配置段：默认只使用 docker-compose.yml 中每个容器独立的 WHATSAPP_HOOK_URL。
  // 避免 rag-server session 级 webhook 与容器 env webhook 同时生效导致重复推送。
  const legacyHookUrl = (hookUrl || 'http://host.docker.internal:3001/api/channel/whatsapp/webhook').replace(/\?.*$/, '')
  const webhookLines = `# Webhook 全局配置（默认禁用 session 级 webhook，避免和容器 env 双推）
WAHA_SESSION_WEBHOOK_ENABLED=false
# 当前默认来源：docker/waha/docker-compose.yml 内每个容器独立的 WHATSAPP_HOOK_URL
# 如确需恢复 session 级 webhook，先确认不会和容器 env 双推，再改为 true 并配置不带固定 account_id 的 URL
# WHATSAPP_HOOK_URL=${legacyHookUrl}
# WHATSAPP_HOOK_EVENTS=${hookEvents}`

  return `# ========== WAHA (WhatsApp) 多实例池配置 ==========
# ──────────────────────────────────────────────
# 扩容/缩减方式（一键完成）：
#   ${applyCommand}
# ──────────────────────────────────────────────
# 实例池大小（共 ${instances.length} 个实例）
WAHA_POOL_SIZE=${instances.length}

# WAHA Docker image lock
WAHA_IMAGE_TAG=${WAHA_IMAGE_TAG}
${WAHA_IMAGE_REF ? `WAHA_IMAGE_REF=${WAHA_IMAGE_REF}
` : ''}

# WAHA engine: current default is gows; webjs is legacy fallback
WAHA_ENGINE=${WAHA_ENGINE}
${WAHA_IS_GOWS ? `
# GOWS history sync guardrails
${gowsLines}
` : ''}

# 实例池配置：JSON 数组字符串，每个实例对应一个独立 WAHA 容器
# 端口范围：3005 - ${endPort}
WAHA_INSTANCES=${instancesJson}

${proxyLines}

${webhookLines}`
}

// ========== 更新 .env 文件中的 WAHA 配置段 ==========
function updateEnvFile(envPath, newSection) {
  if (!fs.existsSync(envPath)) {
    console.warn(`⚠️  .env 文件不存在: ${envPath}，已跳过自动更新`)
    console.log('    请手动创建 .env 并添加以下内容:\n')
    console.log(newSection)
    return false
  }

  const content = fs.readFileSync(envPath, 'utf8')

  // 匹配 "# ========== WAHA" 到下一个 "# =====" 或 "# 以下为旧" 之间的整段
  const wahaSectionRegex = /# ========== WAHA[\s\S]*?(?=\n# ==========|\n# 以下为旧|$)/

  if (wahaSectionRegex.test(content)) {
    // 替换已有的 WAHA 配置段
    const updated = content.replace(wahaSectionRegex, newSection)
    fs.writeFileSync(envPath, updated, 'utf8')
  } else {
    // 追加到文件末尾
    fs.writeFileSync(envPath, content.trimEnd() + '\n\n' + newSection + '\n', 'utf8')
  }

  return true
}

// ========== 主流程 ==========
const currentCount = getCurrentCount()
const isScaleDown = currentCount > count
const envConfig = readEnvConfig()
const instances = generateInstances(count)
const dockerCompose = generateDockerCompose(instances, envConfig)
const envSection = generateEnvSection(instances, envConfig)

console.log('============================================================')
console.log(`WAHA 实例池配置生成器`)
console.log(`  当前实例数: ${currentCount || '(未检测到)'}  →  目标实例数: ${count}`)
console.log(`  Engine: ${WAHA_ENGINE} | Image: ${WAHA_IMAGE}`)
console.log(`  代理: ${envConfig.proxy ? envConfig.proxy.server : '未配置'}`)
console.log(`  Webhook: docker-compose per-instance WHATSAPP_HOOK_URL`)
console.log('============================================================\n')

// 端口对照表
console.log('--- 端口对照表 ---')
instances.forEach((inst, i) => {
  console.log(`  实例 ${i + 1}: 端口 ${inst.port} | API Key: ${inst.apiKey}`)
})

// ========== 缩减安全检查 ==========
if (isScaleDown && apply) {
  const removedStart = count + 1
  const removedEnd = currentCount
  const removedPorts = []
  for (let i = removedStart; i <= removedEnd; i++) {
    removedPorts.push(`实例 ${i} (端口 ${3004 + i})`)
  }

  console.log('\n' + '='.repeat(60))
  console.log('⚠️  缩减警告')
  console.log('='.repeat(60))
  console.log(`以下 ${removedPorts.length} 个实例将被移除：`)
  removedPorts.forEach(p => console.log(`    • ${p}`))
  console.log('')
  console.log('注意：')
  console.log('  1. 请先在后台管理页面确认这些实例上没有绑定的 WhatsApp 账号')
  console.log('  2. 如果有绑定的账号，请先在后台删除或迁移这些账号')
  console.log('  3. 缩减后需执行 docker compose down 再 docker compose up -d')
  console.log('     才能清除旧容器')
  console.log('='.repeat(60))

  if (!force) {
    console.log('\n如确认无误，请添加 --force 参数重新执行：')
    console.log(`  node docker/waha/generate-config.js --count ${count}${WAHA_IS_GOWS ? ' --engine gows' : ''} --apply --force`)
    process.exit(0)
  }

  console.log('\n已通过 --force 跳过确认，继续执行...\n')
}

if (apply) {
  console.log('\n--- 正在写入配置文件 ---')

  // 1. 写入 docker-compose.yml
  fs.writeFileSync(COMPOSE_PATH, dockerCompose, 'utf8')
  console.log(`✅ docker-compose.yml 已更新: ${COMPOSE_PATH}`)

  // 2. 更新 rag-server/.env
  const envUpdated = updateEnvFile(ENV_PATH, envSection)
  if (envUpdated) {
    console.log(`✅ rag-server/.env 已更新: ${ENV_PATH}`)
  }

  console.log('\n🎉 配置已全部更新！')
  console.log('\n📋 后续步骤：')

  if (isScaleDown) {
    // 缩减时需要先 down 再 up，清除旧容器
    console.log('   1. 停止并移除旧容器（含被缩减的实例）：')
    console.log('      cd docker/waha && docker compose down')
    console.log('   2. 重新启动（只启动保留的实例）：')
    console.log('      docker compose up -d')
    console.log('   3. 重启 rag-server 使 .env 生效')
    console.log('\n   ⚠️  如需保留被缩减实例的会话数据，请勿使用 docker compose down -v')
  } else {
    console.log('   1. 启动/重建 WAHA 容器（确保 API Key 等环境变量生效）：')
    console.log('      cd docker/waha && docker compose up -d --force-recreate')
    console.log('   2. 重启 WAHA 健康检查服务，使其重新读取 rag-server/.env')
    console.log('   3. 如 rag-server 也在运行，重启 rag-server 使 .env 生效')
  }
} else {
  // 预览模式
  console.log('\n--- docker-compose.yml (前 30 行预览) ---')
  const composeLines = dockerCompose.split('\n')
  composeLines.slice(0, 30).forEach(line => console.log(line))
  if (composeLines.length > 30) {
    console.log(`... (共 ${composeLines.length} 行)`)
  }

  console.log('\n--- .env 配置片段 ---')
  console.log(envSection)

  if (isScaleDown) {
    console.log('\n⚠️  检测到缩减操作，添加 --apply --force 确认执行：')
    console.log(`   node docker/waha/generate-config.js --count ${count}${WAHA_IS_GOWS ? ' --engine gows' : ''} --apply --force`)
  } else {
    console.log('\n💡 添加 --apply 可一键写入所有配置文件：')
    console.log(`   node docker/waha/generate-config.js --count ${count}${WAHA_IS_GOWS ? ' --engine gows' : ''} --apply`)
  }
}
