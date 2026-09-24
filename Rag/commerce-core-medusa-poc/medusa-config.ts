import { defineConfig } from '@medusajs/framework/utils'
import { loadEnvironment } from './src/config/environment'

const environment = loadEnvironment(process.env)

export default defineConfig({
  projectConfig: {
    databaseUrl: environment.databaseUrl,
    http: {
      storeCors: environment.storeCors,
      adminCors: environment.adminCors,
      authCors: environment.authCors,
      jwtSecret: environment.jwtSecret,
      cookieSecret: environment.cookieSecret,
    },
  },
})
