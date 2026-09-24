const { spawnSync } = require('node:child_process')
const dns = require('node:dns').promises
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const tls = require('node:tls')

const DEFAULT_DOMAIN = 'wecom.thelonelybrave.cn'
const DEFAULT_TIMEOUT_MS = 5000

function assessReadiness(checks = {}) {
  const failed = ['localGateway', 'dns', 'tls', 'https', 'ecsTunnel']
    .filter(name => checks[name] !== true)
  return { ready: failed.length === 0, failed }
}

function redactDiagnostic(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b(?:msg_signature|token|secret|access_token)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .slice(0, 240)
}

function validateDomain(value) {
  const domain = String(value || '').trim()
  if (!domain || !/^[A-Za-z0-9.-]+$/.test(domain)) throw new Error('domain is invalid')
  return domain
}

function parseCliArguments(argv = []) {
  const options = {}
  const supported = new Set(['--domain', '--ssh-host', '--ssh-port', '--ssh-user', '--identity-file'])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (!supported.has(flag)) throw new Error(`unsupported option: ${flag}`)
    if (Object.hasOwn(options, flag)) throw new Error(`duplicate option: ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    options[flag.slice(2).replaceAll('-', '')] = value
  }
  const domain = validateDomain(options.domain || DEFAULT_DOMAIN)
  const sshFlags = ['sshhost', 'sshport', 'sshuser', 'identityfile']
  const requiredSshFlags = ['sshhost', 'sshuser', 'identityfile']
  const present = sshFlags.filter(name => options[name] !== undefined)
  const missing = requiredSshFlags.filter(name => options[name] === undefined)
  if (present.length !== 0 && missing.length !== 0) {
    throw new Error('SSH probe requires ssh-host, ssh-user, and identity-file')
  }
  return {
    domain,
    sshHost: options.sshhost,
    sshPort: options.sshport === undefined ? 22 : Number(options.sshport),
    sshUser: options.sshuser,
    identityFile: options.identityfile ? path.resolve(options.identityfile) : undefined
  }
}

function withTimeout(request, timeoutMs) {
  request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')))
  return request
}

function checkLocalGateway({ request = http.get, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let body = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let clientRequest
    try {
      clientRequest = request({ hostname: '127.0.0.1', port: 8788, path: '/healthz', method: 'GET' }, response => {
        response.setEncoding('utf8')
        response.on('data', chunk => {
          if (body.length < 65536) body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) return finish(false)
          try {
            finish(JSON.parse(body)?.status === 'ok')
          } catch {
            finish(false)
          }
        })
      })
      clientRequest.on('error', () => finish(false))
      withTimeout(clientRequest, timeoutMs)
    } catch {
      finish(false)
    }
  })
}

async function checkDns(domain, resolver = dns) {
  const results = await Promise.allSettled([
    resolver.resolve4(domain),
    resolver.resolve6(domain)
  ])
  return results.some(result => result.status === 'fulfilled' && result.value.length > 0)
}

function checkTls(domain, { connect = tls.connect, port = 443, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let socket
    try {
      socket = connect({ host: domain, port, servername: domain, rejectUnauthorized: true })
      socket.setTimeout(timeoutMs, () => socket.destroy())
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate?.()
        const validUntil = certificate?.valid_to ? Date.parse(certificate.valid_to) : NaN
        finish(socket.authorized === true && Number.isFinite(validUntil) && validUntil > Date.now())
        socket.end()
      })
      socket.once('error', () => finish(false))
      socket.once('close', () => finish(false))
    } catch {
      finish(false)
    }
  })
}

function checkPublicHttps(domain, { request = https.request, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let clientRequest
    try {
      clientRequest = request({ hostname: domain, port: 443, path: '/', method: 'GET', servername: domain, rejectUnauthorized: true }, response => {
        response.resume()
        response.once('end', () => finish(response.statusCode === 404))
      })
      clientRequest.once('error', () => finish(false))
      withTimeout(clientRequest, timeoutMs)
      clientRequest.end()
    } catch {
      finish(false)
    }
  })
}

function checkEcsTunnel({ sshHost, sshPort = 22, sshUser, identityFile, spawn = spawnSync } = {}) {
  if (!sshHost || !sshUser || !identityFile) return false
  if (!/^[A-Za-z0-9.-]+$/.test(String(sshHost)) || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(String(sshUser))) return false
  const port = Number(sshPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false
  const args = [
    '-p', String(port), '-i', path.resolve(String(identityFile)),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes',
    `${sshUser}@${sshHost}`, 'curl', '-fsS', '--max-time', '5', 'http://127.0.0.1:18788/healthz'
  ]
  try {
    const result = spawn('ssh.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: DEFAULT_TIMEOUT_MS + 5000
    })
    return result.status === 0 && !result.error
  } catch {
    return false
  }
}

async function runReadiness(options, dependencies = {}) {
  const domain = validateDomain(options.domain || DEFAULT_DOMAIN)
  const checks = {
    localGateway: await checkLocalGateway(dependencies),
    dns: await checkDns(domain, dependencies.resolver || dns),
    tls: await checkTls(domain, dependencies),
    https: await checkPublicHttps(domain, dependencies),
    ecsTunnel: checkEcsTunnel(options, dependencies)
  }
  const readiness = assessReadiness(checks)
  return {
    ...readiness,
    checks,
    errors: Object.fromEntries(readiness.failed.map(name => [name, `${name.toUpperCase()}_CHECK_FAILED`]))
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCliArguments(argv)
    const result = await runReadiness(options)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return result.ready ? 0 : 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ready: false, failed: ['configuration'], checks: {}, errors: { configuration: 'INVALID_CONFIGURATION' } })}\n`)
    return 1
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code })
}

module.exports = {
  assessReadiness,
  checkDns,
  checkEcsTunnel,
  checkLocalGateway,
  checkPublicHttps,
  checkTls,
  main,
  parseCliArguments,
  redactDiagnostic,
  runReadiness,
  validateDomain
}
