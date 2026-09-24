'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { buildRuntimeConfig, normalizeServerUrl } = require('./runtime-config.cjs')
const { isAllowedNavigation: allowsNavigation } = require('./navigation-policy.cjs')

const isDevelopment = !app.isPackaged
const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:3003'
const entryUrl = isDevelopment ? devServerUrl : pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href
const appLock = app.requestSingleInstanceLock()

if (!appLock) {
  app.quit()
} else {
  let mainWindow = null
  let runtimeConfig = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  function configPath() {
    return path.join(app.getPath('userData'), 'desktop-config.json')
  }

  function readServerUrl() {
    const fromEnv = process.env.RAG_DESKTOP_API_URL || process.env.RAG_SERVER_URL
    if (fromEnv) return fromEnv
    try {
      const value = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
      return value.serverUrl || ''
    } catch {
      return ''
    }
  }

  function refreshRuntimeConfig() {
    runtimeConfig = buildRuntimeConfig(readServerUrl(), {
      isDevelopment: isDevelopment && !process.env.RAG_DESKTOP_API_URL
    })
    return runtimeConfig
  }

  function saveServerUrl(value) {
    const serverUrl = normalizeServerUrl(value)
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), `${JSON.stringify({ serverUrl }, null, 2)}\n`, 'utf8')
    refreshRuntimeConfig()
    return runtimeConfig
  }

  function isAllowedNavigation(url) {
    return allowsNavigation(url, entryUrl, isDevelopment)
  }

  function isTrustedSender(event) {
    return Boolean(mainWindow && event.sender === mainWindow.webContents &&
      event.senderFrame === mainWindow.webContents.mainFrame && isAllowedNavigation(event.senderFrame.url))
  }

  function createWindow() {
    refreshRuntimeConfig()
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1080,
      minHeight: 680,
      show: false,
      title: '客户服务聚合工作台',
      backgroundColor: '#f5f7fa',
      autoHideMenuBar: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault()
        if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      }
    })

    mainWindow.once('ready-to-show', () => mainWindow.show())
    mainWindow.on('closed', () => { mainWindow = null })

    if (isDevelopment) {
      mainWindow.loadURL(devServerUrl)
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    } else {
      mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    }
  }

  function buildApplicationMenu() {
    const template = [
      {
        label: '工作台',
        submenu: [
          { label: '重新加载', role: 'reload' },
          { label: '连接设置', click: () => mainWindow?.webContents.send('desktop:open-settings') },
          { type: 'separator' },
          { label: '退出', role: 'quit' }
        ]
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'togglefullscreen' }
        ]
      }
    ]
    if (isDevelopment) template.push({ label: '开发', submenu: [{ role: 'toggleDevTools' }] })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  ipcMain.on('desktop:get-config', event => {
    if (!isTrustedSender(event)) { event.returnValue = null; return }
    event.returnValue = {
      ...runtimeConfig,
      isDesktop: true,
      isDevelopment,
      appVersion: app.getVersion()
    }
  })

  ipcMain.handle('desktop:set-server-url', async (event, value) => {
    if (!isTrustedSender(event)) return { success: false, message: '无权修改连接设置' }
    try {
      const next = saveServerUrl(value)
      return { success: true, config: next }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  ipcMain.handle('desktop:open-external', async (event, value) => {
    if (!isTrustedSender(event)) return { success: false, message: '无权打开外部链接' }
    try {
      const url = new URL(String(value))
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 http(s) 链接')
      await shell.openExternal(url.toString())
      return { success: true }
    } catch (error) {
      return { success: false, message: error.message }
    }
  })

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'notifications')
    })
    buildApplicationMenu()
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
