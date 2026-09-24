#!/usr/bin/env node
/**
 * WAHA 配置一致性校验脚本
 *
 * 检查 .env(WAHA_INSTANCES) ↔ docker-compose.yml ↔ DB(channel_accounts) 三处配置是否一致。
 * 建议在启动 rag-server 前运行，或在添加/删除 WAHA 实例后运行。
 *
 * 用法：
 *   node scripts/validate-waha-config.js
 *
 * 退出码：
 *   0 = 全部一致
 *   1 = 发现不一致（会列出具体问题）
 */

const fs = require('fs')
const path = require('path')
const mysql = require('mysql2/promise')
const { decrypt } = require('../src/shared/utils/encrypt')

const ENV_PATH = path.join(__dirname, '..', '.env')
const COMPOSE_PATH = path.join(__dirname, '..', '..', 'docker', 'waha', 'docker-compose.yml')

// ========== 读取 .env ==========
function readEnv() {
  const content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : ''
  const get = (key) => {
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  return { get, content }
}

// ========== 读取 docker-compose.yml 中的 WAHA 容器 ==========
function readComposeInstances() {
  if (!fs.existsSync(COMPOSE_PATH)) return []

  const content = fs.readFileSync(COMPOSE_PATH, 'utf-8')
  const blockRegex = /waha-(\d+):[\s\S]*?ports:\s*\n\s*-\s*"(\d+):3000"[\s\S]*?WHATSAPP_API_KEY=([^\s\n]+)/g
  const instances = []
  let match
  while ((match = blockRegex.exec(content)) !== null) {
    instances.push({
      containerName: `waha-${match[1]}`,
      port: Number(match[2]),
      apiKey: match[3].trim()
    })
  }
  return instances
}

// ========== 主流程 ==========
async function main() {
  console.log('=========================================================')
  console.log('  WAHA 配置一致性校验')
  console.log('=========================================================\n')

  const issues = []
  const env = readEnv()

  // 1. 解析 .env 中的 WAHA_INSTANCES
  const instancesJson = env.get('WAHA_INSTANCES')
  let envInstances = []
  if (instancesJson) {
    try {
      envInstances = JSON.parse(instancesJson)
      console.log(`[.env] WAHA_INSTANCES: ${envInstances.length} 个实例`)
      envInstances.forEach((inst, i) => {
        console.log(`  实例 ${i + 1}: port=${inst.port}, apiKey=${inst.apiKey?.substring(0, 12)}..., host=${inst.host}`)
      })
    } catch (e) {
      issues.push(`[.env] WAHA_INSTANCES JSON 解析失败: ${e.message}`)
    }
  } else {
    issues.push('[.env] WAHA_INSTANCES 未配置')
  }

  // 2. 读取 docker-compose.yml 中的容器
  const composeInstances = readComposeInstances()
  console.log(`\n[docker-compose.yml] ${composeInstances.length} 个容器`)
  composeInstances.forEach(inst => {
    console.log(`  ${inst.containerName}: port=${inst.port}, apiKey=${inst.apiKey?.substring(0, 12)}...`)
  })

  // 3. 校验 .env ↔ docker-compose.yml 一致性
  console.log('\n--- 校验 .env ↔ docker-compose.yml ---')
  for (const envInst of envInstances) {
    const composeInst = composeInstances.find(c => c.port === envInst.port)
    if (!composeInst) {
      issues.push(`[.env↔compose] 端口 ${envInst.port} 在 docker-compose.yml 中不存在`)
    } else if (envInst.apiKey !== composeInst.apiKey) {
      issues.push(`[.env↔compose] 端口 ${envInst.port} 的 API Key 不一致 (.env=${envInst.apiKey?.substring(0, 12)}... vs compose=${composeInst.apiKey?.substring(0, 12)}...)`)
    }
  }
  for (const composeInst of composeInstances) {
    if (!envInstances.find(e => e.port === composeInst.port)) {
      issues.push(`[.env↔compose] 端口 ${composeInst.port} 在 .env WAHA_INSTANCES 中不存在`)
    }
  }

  // 4. 读取 DB 中的 channel_accounts
  console.log('\n--- 校验 DB channel_accounts ↔ .env ---')
  const dbHost = env.get('DB_HOST') || 'localhost'
  const dbPort = parseInt(env.get('DB_PORT') || '3306', 10)
  const dbName = env.get('DB_NAME') || 'rag_customer_service'
  const dbUser = env.get('DB_USER') || 'root'
  const dbPass = env.get('DB_PASSWORD') || ''

  let conn
  try {
    conn = await mysql.createConnection({
      host: dbHost, port: dbPort, user: dbUser, password: dbPass, database: dbName
    })

    const [accounts] = await conn.query(
      `SELECT id, account_name, phone_number, config FROM channel_accounts WHERE channel = 'whatsapp' AND status = 'active'`
    )

    console.log(`[DB] ${accounts.length} 个活跃 WhatsApp 账号`)

    for (const account of accounts) {
      let config = {}
      try {
        // 尝试解析 config
        if (typeof account.config === 'string') {
          try {
            config = JSON.parse(account.config)
          } catch {
            config = decrypt(account.config)
          }
        } else if (typeof account.config === 'object') {
          config = account.config
        }
      } catch (e) {
        issues.push(`[DB] 账号 ${account.id}(${account.account_name}) config 解密失败: ${e.message}`)
        continue
      }

      if (!config.port) {
        issues.push(`[DB] 账号 ${account.id}(${account.account_name}) config 中无 port 字段`)
        continue
      }

      const envInst = envInstances.find(e => e.port === config.port)
      if (!envInst) {
        issues.push(`[DB↔.env] 账号 ${account.id}(${account.account_name}) port=${config.port} 在 WAHA_INSTANCES 中不存在`)
        continue
      }

      if (config.apiKey && config.apiKey !== envInst.apiKey) {
        issues.push(`[DB↔.env] 账号 ${account.id}(${account.account_name}) apiKey 与实例 port=${config.port} 不一致`)
      }

      console.log(`  账号 ${account.id}(${account.account_name}): port=${config.port}, phone=${account.phone_number || '-'} ✓`)
    }

    // 检查是否有实例未绑定账号
    const boundPorts = new Set()
    for (const account of accounts) {
      try {
        let config = {}
        if (typeof account.config === 'string') {
          try { config = JSON.parse(account.config) } catch { config = decrypt(account.config) }
        } else if (typeof account.config === 'object') {
          config = account.config
        }
        if (config.port) boundPorts.add(config.port)
      } catch { /* 忽略 */ }
    }
    const unbound = envInstances.filter(e => !boundPorts.has(e.port))
    if (unbound.length > 0) {
      console.log(`\n  未绑定账号的实例: ${unbound.map(e => `port=${e.port}`).join(', ')}（正常，可用于新账号）`)
    }
  } catch (err) {
    issues.push(`[DB] 数据库连接失败: ${err.message}`)
  } finally {
    if (conn) await conn.end()
  }

  // 5. 输出结果
  console.log('\n=========================================================')
  if (issues.length === 0) {
    console.log('  ✅ 全部一致，无问题')
    console.log('=========================================================')
    process.exit(0)
  } else {
    console.log(`  ❌ 发现 ${issues.length} 个问题:`)
    issues.forEach((issue, i) => {
      console.log(`  ${i + 1}. ${issue}`)
    })
    console.log('=========================================================')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('校验脚本异常:', err)
  process.exit(1)
})
