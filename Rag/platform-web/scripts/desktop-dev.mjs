import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.RAG_DESKTOP_DEV_PORT || 3003)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('开发端口必须在 1024–65535 之间')
const serverUrl = `http://127.0.0.1:${port}`
const electronBinary = require('electron')
let vite
let electron
let stopping = false

async function stop(code = 0) {
  if (stopping) return
  stopping = true
  if (electron && electron.exitCode === null) electron.kill()
  await vite?.close()
  process.exitCode = code
}

process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))

try {
  process.env.RAG_DESKTOP_DEV = '1'
  // Wait for our own listener; an occupied port must not open another service.
  vite = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, https: false, open: false } })
  await vite.listen()
  if (!stopping) {
    vite.printUrls()
    const { ELECTRON_RUN_AS_NODE, ...electronEnv } = process.env
    // Start the executable directly; .cmd spawning fails on Windows.
    electron = spawn(electronBinary, ['.'], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...electronEnv, VITE_DEV_SERVER_URL: serverUrl } })
    electron.once('error', error => { console.error(error.message); void stop(1) })
    electron.once('exit', code => { void stop(code ?? 0) })
  }
} catch (error) {
  console.error(error.message)
  await stop(1)
}
