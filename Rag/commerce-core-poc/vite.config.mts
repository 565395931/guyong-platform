import { vendureDashboardPlugin } from '@vendure/dashboard/vite'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig } from 'vite'

const serverPort = Number(process.env.VENDURE_SERVER_PORT || 3050)

export default defineConfig({
  base: '/dashboard',
  build: {
    outDir: join(__dirname, 'dist/dashboard'),
  },
  plugins: [
    vendureDashboardPlugin({
      vendureConfigPath: pathToFileURL('./src/vendure-config.ts'),
      api: process.env.NODE_ENV === 'production'
        ? { host: 'auto', port: 'auto' }
        : { host: 'http://localhost', port: serverPort },
      gqlOutputPath: './src/gql',
    }),
  ],
  resolve: {
    alias: {
      '@/gql': resolve(__dirname, './src/gql/graphql.ts'),
    },
  },
})
