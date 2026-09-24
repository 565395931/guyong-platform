export {}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      APP_ENV?: string
      VENDURE_SERVER_PORT?: string
      COOKIE_SECRET?: string
      SUPERADMIN_USERNAME?: string
      SUPERADMIN_PASSWORD?: string
      DB_HOST?: string
      DB_PORT?: string
      DB_NAME?: string
      DB_USERNAME?: string
      DB_PASSWORD?: string
    }
  }
}
