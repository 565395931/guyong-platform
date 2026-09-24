import { bootstrap, runMigrations } from '@vendure/core'
import { config } from './vendure-config'

runMigrations(config)
  .then(() => bootstrap(config))
  .catch(error => {
    console.error('[commerce-core-poc] server startup failed', error)
    process.exitCode = 1
  })
