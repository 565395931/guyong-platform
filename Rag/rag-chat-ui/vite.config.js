import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import fs from 'fs'
import path from 'path'

// 打包时间标记插件
function buildTimePlugin() {
  return {
    name: 'build-time-plugin',
    apply: 'build',  // 仅在生产构建时应用

    // 使用 transformIndexHtml 钩子（Vite 推荐方式）
    transformIndexHtml(html, context) {
      const buildTime = new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })

      // 在 head 标签后注入 base 标签（解决子路径部署问题）
      const baseTag = `  <base href="/chat/">\n`

      // 在 body 标签后注入时间标记
      const buildInfo = `
  <!-- ==================== Build Information ==================== -->
  <!-- Build Time: ${buildTime} -->
  <!-- Environment: Production -->
  <!-- Base Path: /chat/ -->
  <!-- ============================================================ -->`

      console.log(`✅ [Build Time Plugin] 打包时间标记已注入到 body: ${buildTime}`)
      console.log(`✅ [Build Time Plugin] Base 标签已注入: /chat/`)

      // 先添加 base 标签，再添加时间标记
      let result = html.replace('<head>', `<head>\n${baseTag}`)
      result = result.replace('<body>', `<body>\n${buildInfo}\n`)

      return result
    },

    // 打包完成后创建 version.json
    closeBundle() {
      const buildTime = new Date().toISOString()
      const versionInfo = {
        buildTime: buildTime,
        buildTimeCN: new Date().toLocaleString('zh-CN'),
        environment: 'production',
        version: process.env.npm_package_version || '1.0.0',
        commit: process.env.GIT_COMMIT || 'unknown'
      }

      // 写入 version.json
      const outputPath = path.resolve(process.cwd(), 'chat')
      const versionPath = path.join(outputPath, 'version.json')

      fs.writeFileSync(versionPath, JSON.stringify(versionInfo, null, 2), 'utf-8')
      console.log(`✅ [Build Time Plugin] version.json 已生成: ${versionPath}`)
    }
  }
}

// 根据环境自动设置 base 路径
// 开发环境：根路径 /
// 生产环境：子路径 /chat/
export default defineConfig(({ mode }) => {
  // 开发模式使用根路径，生产模式使用子路径
  const base = mode === 'development' ? '/' : '/chat/'

  return {
    plugins: [
      vue(),
      buildTimePlugin()  // 打包时间标记插件
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host: true,
      port: 3000,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true
        }
      }
    },
    // 自动根据环境设置 base
    base: base,
    build: {
      outDir: 'chat',  // 输出目录名称
    }
  }
})