const express = require('express')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createAuthenticate } = require('../middleware/authenticate')

const SERVER_STARTED_AT = new Date().toISOString()

function isRestartEnabled(environment = process.env, platform = process.platform) {
  const configured = String(environment.LOCAL_BACKEND_RESTART_ENABLED || '').trim().toLowerCase()
  if (configured) return platform === 'win32' && ['1', 'true', 'yes', 'on'].includes(configured)
  return platform === 'win32' && environment.NODE_ENV !== 'production'
}

function requireAdministrator(req, res, next) {
  if (req.user?.role === 'admin') return next()
  return res.status(403).json({ success: false, message: '仅管理员可以重启后端' })
}

function launchWindowsRestart({ currentPid = process.pid, port = 3001 } = {}) {
  const scriptPath = path.resolve(__dirname, '../../../tools/local-deploy/restart-backend.ps1')
  if (!fs.existsSync(scriptPath)) {
    const error = new Error(`重启脚本不存在: ${scriptPath}`)
    error.code = 'RESTART_SCRIPT_MISSING'
    throw error
  }
  const powershellPath = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
  if (!fs.existsSync(powershellPath)) {
    const error = new Error(`Windows PowerShell 不存在: ${powershellPath}`)
    error.code = 'POWERSHELL_MISSING'
    throw error
  }

  const child = spawn(powershellPath, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-CurrentPid', String(currentPid),
    '-Port', String(port)
  ], {
    cwd: path.resolve(__dirname, '../..'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.once('error', error => {
    console.error('[SystemControl] Failed to launch restart helper:', error.message)
  })
  child.unref()
}

function createSystemControlRouter({
  authenticate = createAuthenticate(),
  environment = process.env,
  platform = process.platform,
  currentPid = process.pid,
  startedAt = SERVER_STARTED_AT,
  launchRestart = launchWindowsRestart,
  scheduleExit = (callback, delay) => setTimeout(callback, delay),
  exitProcess = code => process.exit(code)
} = {}) {
  const router = express.Router()
  let restartRequested = false

  router.use(authenticate, requireAdministrator)

  router.get('/status', (req, res) => {
    return res.json({
      success: true,
      data: {
        pid: currentPid,
        startedAt,
        restartEnabled: isRestartEnabled(environment, platform)
      }
    })
  })

  router.post('/restart-backend', (req, res) => {
    if (!isRestartEnabled(environment, platform)) {
      return res.status(403).json({
        success: false,
        message: '当前环境未启用本地后端重启功能'
      })
    }
    if (restartRequested) {
      return res.status(409).json({ success: false, message: '后端正在重启，请稍候' })
    }

    try {
      launchRestart({
        currentPid,
        port: Number.parseInt(environment.PORT || '3001', 10)
      })
      restartRequested = true
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: ['RESTART_SCRIPT_MISSING', 'POWERSHELL_MISSING'].includes(error?.code)
          ? error.message
          : '无法启动后端重启任务'
      })
    }

    res.once('finish', () => {
      scheduleExit(() => exitProcess(0), 300)
    })
    return res.status(202).json({
      success: true,
      data: { previousPid: currentPid }
    })
  })

  return router
}

module.exports = {
  createSystemControlRouter,
  isRestartEnabled,
  launchWindowsRestart,
  requireAdministrator
}
