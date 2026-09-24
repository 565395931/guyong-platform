/**
 * WAHA 自动健康检查脚本
 *
 * 功能：
 *  - 每 60 秒检测所有 WAHA 实例的 session 状态
 *  - 当 session 状态非 WORKING/CONNECTED 或 API 不可达时，自动 docker restart 容器
 *  - docker restart 不会清除 session 数据，无需重新扫码
 *  - 连续 3 次重启失败后停止自动恢复，避免死循环
 *  - 所有事件输出到控制台 + 可选写入日志文件
 *
 * 使用方式：
 *  node scripts/waha-health-check.js                    # 前台运行
 *  node scripts/waha-health-check.js --interval=120     # 自定义检测间隔(秒)
 *  node scripts/waha-health-check.js --log              同时写入日志文件
 *
 * 可配合 pm2 守护运行：
 *  pm2 start scripts/waha-health-check.js --name waha-health
 */

const http = require('http')
const { execSync, exec } = require('child_process')
const fs = require('fs')
const path = require('path')

// ========== 配置 ==========
const CHECK_INTERVAL_SEC = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '60', 10)
const ENABLE_LOG_FILE = process.argv.includes('--log')
const MAX_RESTART_RETRIES = 3  // 连续重启失败上限
const RESTART_COOLDOWN_MS = 5 * 60 * 1000  // 同一容器重启冷却时间 5 分钟

// 从环境变量或 .env 加载 WAHA 实例配置
function loadWahaInstances() {
  // 直接读取 .env 文件
  const envPath = path.join(__dirname, '..', '.env')
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : ''

  const getEnv = (key) => {
    const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : process.env[key] || ''
  }

  // 优先解析 WAHA_INSTANCES
  const instancesJson = getEnv('WAHA_INSTANCES')
  if (instancesJson) {
    try {
      const parsed = JSON.parse(instancesJson)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((inst, i) => ({
          port: inst.port || 3005 + i,
          apiKey: inst.apiKey || '',
          host: inst.host || `http://localhost:${inst.port || 3005 + i}`,
          containerName: `waha-${i + 1}`
        }))
      }
    } catch (e) {
      console.error('[HealthCheck] 解析 WAHA_INSTANCES 失败:', e.message)
    }
  }

  // 降级：根据 WAHA_POOL_SIZE 生成
  const poolSize = parseInt(getEnv('WAHA_POOL_SIZE') || '1', 10)
  const apiKey = getEnv('WAHA_API_KEY') || ''
  const instances = []
  for (let i = 0; i < poolSize; i++) {
    instances.push({
      port: 3005 + i,
      apiKey,
      host: `http://localhost:${3005 + i}`,
      containerName: `waha-${i + 1}`
    })
  }
  return instances
}

const INSTANCES = loadWahaInstances()

// 每个实例的重启状态跟踪
const restartTracker = new Map() // containerName -> { retries, lastRestartTime }

// ========== 日志 ==========
function log(level, message) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${level}] ${message}`

  console.log(line)

  if (ENABLE_LOG_FILE) {
    const logDir = path.join(__dirname, '..', 'logs')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    const logFile = path.join(logDir, 'waha-health-check.log')
    fs.appendFileSync(logFile, line + '\n')
  }
}

// ========== 检测 WAHA session 状态 ==========
function checkInstance(instance) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'localhost',
      port: instance.port,
      path: '/api/sessions',
      method: 'GET',
      headers: instance.apiKey ? { 'X-Api-Key': instance.apiKey } : {},
      timeout: 8000
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 401/403 表示健康检查脚本使用的 API Key 与 WAHA 容器不一致。
          // 这是配置问题，重启容器无法修复；反复 docker restart 反而会打断扫码/连接流程。
          if (res.statusCode === 401 || res.statusCode === 403) {
            return resolve({
              healthy: false,
              reason: `HTTP ${res.statusCode}：WAHA API Key 不匹配，请检查 rag-server/.env 的 WAHA_INSTANCES 与 docker/waha/docker-compose.yml 是否一致，并重启健康检查服务`,
              sessions: [],
              needsRecovery: false,
              configError: true
            })
          }
          return resolve({ healthy: false, reason: `HTTP ${res.statusCode}`, sessions: [] })
        }
        try {
          const sessions = JSON.parse(data)
          const sessionList = Array.isArray(sessions) ? sessions : [sessions]
          const sessionInfo = sessionList.map(s => ({
            name: s.name || 'default',
            status: s.status || 'UNKNOWN'
          }))

          // 只有已连接 session 才需要自动恢复；扫码前的 STARTING/SCAN_QR/STOPPED 等状态不应自动重启，
          // 否则会打断二维码生成流程，导致后台一直看到 STARTING、QR 无法稳定生成。
          const connected = sessionList.some(s =>
            s.status === 'WORKING' || s.status === 'CONNECTED'
          )
          const hasSession = sessionList.length > 0
          const needsRecovery = sessionList.some(s =>
            s.me && !['WORKING', 'CONNECTED'].includes(s.status)
          )

          resolve({
            healthy: connected || (hasSession && !needsRecovery),
            reason: connected ? 'OK' : (needsRecovery ? `session状态: ${sessionInfo.map(s => `${s.name}=${s.status}`).join(', ')}` : `等待扫码/登录: ${sessionInfo.map(s => `${s.name}=${s.status}`).join(', ')}`),
            sessions: sessionInfo,
            needsRecovery
          })
        } catch (e) {
          resolve({ healthy: false, reason: `JSON解析失败: ${e.message}`, sessions: [] })
        }
      })
    })

    req.on('error', (e) => {
      resolve({ healthy: false, reason: `连接失败: ${e.code || e.message}`, sessions: [] })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ healthy: false, reason: '请求超时', sessions: [] })
    })

    req.end()
  })
}

// ========== Docker 容器重启 ==========
function restartContainer(containerName) {
  return new Promise((resolve) => {
    log('WARN', `正在重启 Docker 容器: ${containerName} ...`)
    exec(`docker restart ${containerName}`, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        log('ERROR', `容器 ${containerName} 重启失败: ${error.message}`)
        return resolve(false)
      }
      log('INFO', `容器 ${containerName} 重启成功: ${(stdout || '').trim()}`)
      resolve(true)
    })
  })
}

// ========== 等待 session 恢复 ==========
function waitForRecovery(instance, maxWaitMs = 60000) {
  return new Promise((resolve) => {
    const startTime = Date.now()
    const checkRecovery = async () => {
      const result = await checkInstance(instance)
      if (result.healthy) {
        log('INFO', `${instance.containerName} (${instance.host}) 已恢复连接 ✓`)
        return resolve(true)
      }
      if (Date.now() - startTime > maxWaitMs) {
        log('WARN', `${instance.containerName} 等待 ${maxWaitMs / 1000}s 后仍未恢复`)
        return resolve(false)
      }
      setTimeout(checkRecovery, 5000)
    }
    setTimeout(checkRecovery, 10000) // 重启后等 10s 再开始检测
  })
}

// ========== 主检测循环 ==========
async function runHealthCheck() {
  for (const instance of INSTANCES) {
    const result = await checkInstance(instance)
    const tracker = restartTracker.get(instance.containerName) || { retries: 0, lastRestartTime: 0 }

    if (result.healthy) {
      // 健康状态 — 重置重试计数
      if (tracker.retries > 0) {
        log('INFO', `${instance.containerName} (${instance.host}) 状态正常，重置重试计数`)
      }
      restartTracker.set(instance.containerName, { retries: 0, lastRestartTime: tracker.lastRestartTime })
      continue
    }

    // ===== 不健康 =====
    log('WARN', `${instance.containerName} (${instance.host}) 异常: ${result.reason}`)

    if (result.configError) {
      log('ERROR', `${instance.containerName} 配置错误，跳过自动重启。请同步 API Key 后重启 waha-health-check。`)
      continue
    }

    if (result.needsRecovery === false) {
      log('INFO', `${instance.containerName} 当前处于扫码/登录准备阶段，跳过自动重启`)
      continue
    }

    // 检查重试次数
    if (tracker.retries >= MAX_RESTART_RETRIES) {
      log('ERROR', `${instance.containerName} 已达最大重试次数(${MAX_RESTART_RETRIES})，停止自动重启。请手动检查！`)
      continue
    }

    // 检查冷却时间
    const elapsed = Date.now() - tracker.lastRestartTime
    if (elapsed < RESTART_COOLDOWN_MS) {
      const remaining = Math.ceil((RESTART_COOLDOWN_MS - elapsed) / 1000)
      log('INFO', `${instance.containerName} 冷却中，${remaining}s 后才可再次重启`)
      continue
    }

    // 执行重启
    tracker.retries++
    tracker.lastRestartTime = Date.now()
    restartTracker.set(instance.containerName, tracker)

    log('INFO', `准备重启 ${instance.containerName} (第 ${tracker.retries}/${MAX_RESTART_RETRIES} 次)`)

    const restartSuccess = await restartContainer(instance.containerName)
    if (restartSuccess) {
      // 等待恢复
      const recovered = await waitForRecovery(instance, 60000)
      if (!recovered) {
        log('WARN', `${instance.containerName} 重启后仍未恢复，可能需要手动扫码`)
      }
    }
  }
}

// ========== 启动 ==========
console.log('=========================================================')
console.log('  WAHA 自动健康检查脚本已启动')
console.log(`  检测间隔: ${CHECK_INTERVAL_SEC}s`)
console.log(`  监控实例: ${INSTANCES.length} 个`)
console.log(`  实例列表: ${INSTANCES.map(i => `${i.containerName}(:${i.port})`).join(', ')}`)
console.log(`  最大重试: ${MAX_RESTART_RETRIES} 次`)
console.log(`  冷却时间: ${RESTART_COOLDOWN_MS / 1000}s`)
console.log(`  日志文件: ${ENABLE_LOG_FILE ? '是' : '否'}`)
console.log('=========================================================')

// 立即执行一次
runHealthCheck()

// 定时循环
setInterval(runHealthCheck, CHECK_INTERVAL_SEC * 1000)

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n[HealthCheck] 收到 SIGINT，正在退出...')
  process.exit(0)
})
process.on('SIGTERM', () => {
  console.log('\n[HealthCheck] 收到 SIGTERM，正在退出...')
  process.exit(0)
})
