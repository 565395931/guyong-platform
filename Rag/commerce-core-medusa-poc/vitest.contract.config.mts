import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/commerce/**/*.test.ts', 'src/config/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/commerce/**/*.ts', 'src/config/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
