import {
  DefaultJobQueuePlugin,
  DefaultSchedulerPlugin,
  DefaultSearchPlugin,
  VendureConfig,
  dummyPaymentHandler,
} from '@vendure/core'
import 'dotenv/config'
import path from 'node:path'
import { loadEnvironment } from './config/environment'

const environment = loadEnvironment(process.env)
const isDevelopment = environment.appEnv === 'dev'
const corePlugins = [
  DefaultSchedulerPlugin.init(),
  DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
  DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
]
const developmentPlugins = isDevelopment
  ? require('./config/development-plugins').createDevelopmentPlugins()
  : []

export const config: VendureConfig = {
  apiOptions: {
    port: environment.serverPort,
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    trustProxy: isDevelopment ? false : 1,
    ...(isDevelopment ? { adminApiDebug: true, shopApiDebug: true } : {}),
  },
  authOptions: {
    tokenMethod: ['bearer', 'cookie'],
    superadminCredentials: {
      identifier: environment.superadminUsername,
      password: environment.superadminPassword,
    },
    cookieOptions: {
      secret: environment.cookieSecret,
    },
  },
  dbConnectionOptions: {
    type: environment.database.type,
    host: environment.database.host,
    port: environment.database.port,
    database: environment.database.name,
    username: environment.database.username,
    password: environment.database.password,
    synchronize: false,
    migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
    logging: false,
  },
  paymentOptions: {
    paymentMethodHandlers: [dummyPaymentHandler],
  },
  customFields: {},
  plugins: [...corePlugins, ...developmentPlugins],
}
