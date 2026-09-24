import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const certDir = fileURLToPath(new URL('../certs/', import.meta.url))
const hasLocalCertificate = fs.existsSync(path.join(certDir, 'rag-local-key.pem')) && fs.existsSync(path.join(certDir, 'rag-local.pem'))
const httpsOptions = process.env.RAG_DESKTOP_DEV !== '1' && hasLocalCertificate ? {
  key: fs.readFileSync(path.join(certDir, 'rag-local-key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'rag-local.pem'))
} : false

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/assets/styles/variables.scss" as *;`
      }
    }
  },
  server: {
    host: true,
    port: 3003,
    https: httpsOptions,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // Socket.IO 默认路径，连接直接走 VITE_WS_URL 时不会经过此代理
      // 保留以支持未来可能改为相对路径的场景
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true
      }
    }
  },
  preview: {
    host: true,
    port: 3004,
    https: false,
    proxy: {
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
  }
})
