import { createServer } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const certDir = fileURLToPath(new URL('../certs/', import.meta.url))
const https = {
  key: fs.readFileSync(path.join(certDir, 'rag-local-key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'rag-local.pem'))
}

const proxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true
  },
  '/socket.io': {
    target: 'http://localhost:3001',
    changeOrigin: true,
    ws: true
  }
}

const server = await createServer({
  root: process.cwd(),
  server: { port: 3003, host: '0.0.0.0', https, proxy },
  logLevel: 'info'
})

await server.listen()
const info = server.printUrls()
console.log('\n  Server started successfully!\n')
