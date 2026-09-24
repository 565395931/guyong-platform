import { bootstrapWorker } from '@vendure/core'
import { config } from './vendure-config'

bootstrapWorker(config)
  .then(worker => worker.startJobQueue())
  .catch(error => {
    console.error('[commerce-core-poc] worker startup failed', error)
    process.exitCode = 1
  })
