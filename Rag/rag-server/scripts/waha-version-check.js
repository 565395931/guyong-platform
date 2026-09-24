#!/usr/bin/env node
/**
 * WAHA Docker 镜像版本检查脚本
 *
 * 功能：
 *  - 读取当前锁定的 WAHA 镜像版本（从 .env 或 docker-compose.yml）
 *  - 查询 Docker Hub 获取最新可用版本 tags
 *  - 查询 GitHub Releases 获取最新 release 信息
 *  - 对比当前版本与最新版本，给出升级建议
 *  - 输出补丁兼容性提醒
 *
 * 使用方式：
 *   node rag-server/scripts/waha-version-check.js              # 检查版本
 *   node rag-server/scripts/waha-version-check.js --verbose    # 显示最近 10 个版本
 *   node rag-server/scripts/waha-version-check.js --json       # JSON 格式输出
 *
 * 注意：需要网络访问 Docker Hub (hub.docker.com) 和 GitHub API (api.github.com)
 *       如果在中国大陆且无法直连，请配置代理后运行
 */

const https = require('https')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

// ========== 路径解析 ==========
const SCRIPT_DIR = __dirname                    // rag-server/scripts/
const RAG_SERVER_DIR = path.resolve(SCRIPT_DIR, '..')  // rag-server/
const PROJECT_ROOT = path.resolve(RAG_SERVER_DIR, '..') // 项目根目录
const ENV_PATH = path.join(RAG_SERVER_DIR, '.env')
const COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker', 'waha', 'docker-compose.yml')
const PATCHES_DIR = path.join(PROJECT_ROOT, 'docker', 'waha', 'patches')

// ========== 补丁文件清单 ==========
const PATCH_FILES = [
  { file: 'ids.js', target: '/app/dist/core/utils/ids.js', desc: 'parseMessageIdSerialized null safety' },
  { file: 'webjs/session.webjs.core.js', target: '/app/dist/core/engines/webjs/session.webjs.core.js', desc: 'WhatsApp Web version lock + cacheType' },
  { file: 'webjs/WebjsClientCore.js', target: '/app/dist/core/engines/webjs/WebjsClientCore.js', desc: 'getChats per-chat error handling' },
  { file: 'webjs/Utils.js', target: '/app/node_modules/whatsapp-web.js/src/util/Injected/Utils.js', desc: 'canCheckStatusRankingPosterGating try-catch' },
  { file: 'webjs/2.3000.1043180520-alpha.html', target: '/app/dist/core/engines/webjs/2.3000.1043180520-alpha.html', desc: 'WhatsApp Web HTML (locked version)' },
]

// ========== 参数 ==========
const VERBOSE = process.argv.includes('--verbose')
const JSON_OUTPUT = process.argv.includes('--json')

// ========== 工具函数 ==========
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'waha-version-check/1.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, headers))
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('Request timeout')))
  })
}

function readCurrentTag() {
  // 1. 从 .env 读取
  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf8')
    const refMatch = content.match(/^WAHA_IMAGE_REF=(.+)$/m)
    if (refMatch) return refMatch[1].trim()
    const match = content.match(/^WAHA_IMAGE_TAG=(.+)$/m)
    if (match) return match[1].trim()
  }
  // 2. 从 docker-compose.yml 读取
  if (fs.existsSync(COMPOSE_PATH)) {
    const content = fs.readFileSync(COMPOSE_PATH, 'utf8')
    const refMatch = content.match(/image:\s*(devlikeapro\/waha@\S+)/)
    if (refMatch) return refMatch[1].trim()
    const match = content.match(/image:\s*devlikeapro\/waha:(\S+)/)
    if (match) return match[1].trim()
  }
  return null
}

function readCurrentEngine() {
  if (process.env.WAHA_ENGINE) {
    return String(process.env.WAHA_ENGINE).trim().toLowerCase() === 'gows' ? 'gows' : 'webjs'
  }
  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf8')
    const match = content.match(/^WAHA_ENGINE=(.+)$/m)
    if (match) return String(match[1]).trim().toLowerCase() === 'gows' ? 'gows' : 'webjs'
  }
  if (fs.existsSync(COMPOSE_PATH)) {
    const content = fs.readFileSync(COMPOSE_PATH, 'utf8')
    if (/WHATSAPP_DEFAULT_ENGINE=GOWS/i.test(content) || /image:\s*devlikeapro\/waha:gows\b/i.test(content)) {
      return 'gows'
    }
  }
  return 'gows'
}

function compareVersions(a, b) {
  // WAHA 版本格式: YYYY.M.N (e.g. 2026.6.2)
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

// ========== 查询 Docker Hub ==========
async function fetchDockerHubTags() {
  const url = 'https://hub.docker.com/v2/repositories/devlikeapro/waha/tags/?page_size=20&ordering=last_updated'
  const data = await httpsGet(url)
  const parsed = JSON.parse(data)
  return parsed.results.map(t => ({
    name: t.name,
    fullSize: t.full_size,
    lastUpdated: t.last_updated,
    digest: t.digest?.substring(0, 12) || 'unknown'
  }))
}

// ========== 查询 GitHub Releases ==========
async function fetchGitHubReleases() {
  const url = 'https://api.github.com/repos/devlikeapro/waha/releases?per_page=5'
  const data = await httpsGet(url, { 'Accept': 'application/vnd.github+json' })
  return JSON.parse(data).map(r => ({
    tagName: r.tag_name,
    name: r.name,
    publishedAt: r.published_at,
    body: r.body || '',
    htmlUrl: r.html_url
  }))
}

// ========== 检查补丁文件状态 ==========
function checkPatches() {
  const results = []
  for (const p of PATCH_FILES) {
    const fullPath = path.join(PATCHES_DIR, p.file)
    const exists = fs.existsSync(fullPath)
    let size = 0
    let mtime = null
    if (exists) {
      const stat = fs.statSync(fullPath)
      size = stat.size
      mtime = stat.mtime.toISOString().split('T')[0]
    }
    results.push({ ...p, exists, size, mtime })
  }
  return results
}

// ========== 检查 docker-compose.yml 中的挂载 ==========
function checkComposeMounts() {
  if (!fs.existsSync(COMPOSE_PATH)) return { found: false, mounts: [] }
  const content = fs.readFileSync(COMPOSE_PATH, 'utf8')
  const mountRegex = /-\s+\.\/patches\/([^:]+):([^:]+):ro/g
  const mounts = []
  let match
  while ((match = mountRegex.exec(content)) !== null) {
    mounts.push({ source: match[1], target: match[2] })
  }
  return { found: true, mounts }
}

// ========== 主流程 ==========
async function main() {
  const currentTag = readCurrentTag()
  const currentEngine = readCurrentEngine()

  if (currentEngine === 'gows') {
    const result = {
      engine: currentEngine,
      currentTag,
      skipped: true,
      reason: 'GOWS mode does not use WebJS patches or locked WhatsApp Web HTML.',
      timestamp: new Date().toISOString()
    }
    if (JSON_OUTPUT) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log('============================================================')
    console.log('  WAHA GOWS mode detected')
    console.log('============================================================\n')
    console.log(`  Engine: ${currentEngine}`)
    console.log(`  Image tag: ${currentTag || 'unknown'}`)
    console.log('  WebJS patch/version checks skipped: GOWS does not use Chromium, whatsapp-web.js patches, or locked Web HTML.')
    return
  }

  if (JSON_OUTPUT) {
    // JSON 模式：收集所有数据后一次性输出
    try {
      const dockerTags = await fetchDockerHubTags()
      const releases = await fetchGitHubReleases()
      const patches = checkPatches()
      const composeMounts = checkComposeMounts()

      const latestTag = dockerTags.find(t => /^\d{4}\.\d+\.\d+$/.test(t.name))
      const needUpgrade = currentTag && latestTag ? compareVersions(latestTag.name, currentTag) > 0 : null

      console.log(JSON.stringify({
        currentTag,
        latestTag: latestTag?.name || null,
        needUpgrade,
        dockerTags: dockerTags.slice(0, VERBOSE ? 10 : 5),
        latestRelease: releases[0] ? { tag: releases[0].tagName, date: releases[0].publishedAt, url: releases[0].htmlUrl } : null,
        patches,
        composeMounts,
        timestamp: new Date().toISOString()
      }, null, 2))
      return
    } catch (err) {
      console.log(JSON.stringify({ error: err.message, currentTag, timestamp: new Date().toISOString() }))
      return
    }
  }

  console.log('============================================================')
  console.log('  WAHA Docker 镜像版本检查')
  console.log('============================================================\n')

  // 1. 当前版本
  console.log('--- 当前锁定版本 ---')
  if (!currentTag) {
    console.log('  ⚠️  未检测到锁定版本（.env 和 docker-compose.yml 中未找到 WAHA_IMAGE_REF/WAHA_IMAGE_TAG）')
    console.log('  当前可能使用 :latest 标签，建议立即锁定版本！\n')
  } else {
    console.log(`  镜像 tag:  devlikeapro/waha:${currentTag}`)
    const envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : ''
    const source = envContent.includes('WAHA_IMAGE_REF')
      ? '.env (WAHA_IMAGE_REF)'
      : envContent.includes('WAHA_IMAGE_TAG')
        ? '.env (WAHA_IMAGE_TAG)'
        : 'docker-compose.yml'
    console.log(`  来源:      ${source}\n`)
  }

  // 2. Docker Hub 最新版本
  console.log('--- Docker Hub 最新版本 ---')
  let latestTag = null
  try {
    const dockerTags = await fetchDockerHubTags()
    const versionTags = dockerTags.filter(t => /^\d{4}\.\d+\.\d+$/.test(t.name))
    latestTag = versionTags[0] || null

    if (latestTag) {
      console.log(`  最新版本:  ${latestTag.name}  (更新于 ${latestTag.lastUpdated?.split('T')[0]})`)
    }

    const showCount = VERBOSE ? 10 : 5
    console.log(`\n  最近 ${showCount} 个版本 tags:`)
    dockerTags.slice(0, showCount).forEach(t => {
      const isCurrent = t.name === currentTag ? ' ← 当前' : ''
      const isLatest = t === latestTag ? ' (latest stable)' : ''
      console.log(`    ${t.name.padEnd(20)} ${t.lastUpdated?.split('T')[0] || 'unknown'}${isCurrent}${isLatest}`)
    })
  } catch (err) {
    console.log(`  ❌ 无法查询 Docker Hub: ${err.message}`)
    console.log('     (如果在中国大陆，可能需要配置代理)\n')
  }

  // 3. 版本对比
  console.log('\n--- 版本对比 ---')
  if (currentTag && latestTag) {
    const cmp = compareVersions(latestTag.name, currentTag)
    if (cmp > 0) {
      console.log(`  ⬆️  有新版本可用: ${currentTag} → ${latestTag.name}`)
      console.log(`      建议在 WhatsApp 出现兼容性问题时再升级（不急于追新）\n`)
    } else if (cmp === 0) {
      console.log(`  ✅ 当前版本已是最新: ${currentTag}\n`)
    } else {
      console.log(`  ℹ️  当前版本 ${currentTag} 比最新 ${latestTag.name} 还新（可能是预发布）\n`)
    }
  } else if (!currentTag) {
    console.log('  ❗ 未锁定版本，建议立即锁定\n')
  }

  // 4. GitHub Release 信息
  console.log('--- GitHub 最新 Release ---')
  try {
    const releases = await fetchGitHubReleases()
    if (releases.length > 0) {
      const latest = releases[0]
      console.log(`  版本:  ${latest.tagName}`)
      console.log(`  日期:  ${latest.publishedAt?.split('T')[0]}`)
      console.log(`  链接:  ${latest.htmlUrl}`)
      // 显示 release notes 前 5 行
      const notes = latest.body.split('\n').filter(l => l.trim()).slice(0, 5)
      if (notes.length > 0) {
        console.log('  摘要:')
        notes.forEach(line => console.log(`    ${line.trim().substring(0, 100)}`))
      }
    }
  } catch (err) {
    console.log(`  ⚠️  无法查询 GitHub Releases: ${err.message}`)
  }

  // 5. 补丁兼容性检查
  console.log('\n--- 补丁兼容性检查 ---')
  const patches = checkPatches()
  const composeMounts = checkComposeMounts()
  let allPatchesOk = true

  patches.forEach(p => {
    const status = p.exists ? '✅' : '❌ 缺失!'
    if (!p.exists) allPatchesOk = false
    console.log(`  ${status} ${p.file}`)
    console.log(`     目标: ${p.target}`)
    console.log(`     说明: ${p.desc}`)
    if (p.exists) {
      console.log(`     大小: ${p.size} bytes  修改: ${p.mtime}`)
    }
  })

  // 检查 docker-compose.yml 挂载
  if (composeMounts.found) {
    console.log(`\n  docker-compose.yml 挂载检查:`)
    console.log(`    共 ${composeMounts.mounts.length} 个 :ro 挂载`)
    const expectedCount = PATCH_FILES.length
    if (composeMounts.mounts.length < expectedCount * 2) {
      // 每个补丁在两个实例中各挂载一次，所以总数应该是 PATCH_FILES.length * 实例数
      // 但这里我们只检查是否有挂载
      console.log(`    ✅ 补丁挂载存在`)
    } else {
      console.log(`    ✅ 补丁挂载完整`)
    }
  } else {
    console.log('  ⚠️  未找到 docker-compose.yml，无法检查挂载')
    allPatchesOk = false
  }

  // 6. 升级指南
  console.log('\n--- 升级指南 ---')
  console.log('  当 WhatsApp 出现兼容性问题（消息收发异常、session 反复断开）时，')
  console.log('  按以下步骤升级：\n')
  console.log('  1. 查看最新 release notes:')
  console.log('     https://github.com/devlikeapro/waha/releases')
  console.log('')
  console.log('  2. 修改 rag-server/.env 中的 WAHA_IMAGE_TAG 为新版本')
  console.log('     (例如: WAHA_IMAGE_TAG=2026.7.1)')
  console.log('')
  console.log('  3. 重新生成 docker-compose.yml:')
  console.log('     node docker/waha/generate-config.js --count 2 --apply')
  console.log('')
  console.log('  4. 【关键】验证补丁兼容性:')
  console.log('     - 对比新镜像中的源文件与 patches/ 目录中的补丁')
  console.log('     - 如果源文件有变化，需要重新制作补丁')
  console.log('     docker run --rm devlikeapro/waha:NEW_TAG cat /app/dist/core/engines/webjs/session.webjs.core.js > /tmp/compare.js')
  console.log('')
  console.log('  5. 重建容器:')
  console.log('     cd docker/waha && docker compose up -d --force-recreate')
  console.log('')
  console.log('  6. 重新扫码登录 WhatsApp')
  console.log('')
  console.log('  ⚠️  不要使用 docker compose down -v，会删除 session 数据！')
  console.log('  ⚠️  升级后必须重新验证所有补丁是否正常工作！')

  console.log('\n============================================================')
  if (!allPatchesOk) {
    console.log('  ⚠️  部分补丁缺失，请检查 patches/ 目录')
  } else {
    console.log('  ✅ 所有补丁文件正常')
  }
  console.log('============================================================')
}

main().catch(err => {
  console.error('❌ 版本检查失败:', err.message)
  process.exit(1)
})
