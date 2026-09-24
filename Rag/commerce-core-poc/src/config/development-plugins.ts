import { AssetServerPlugin } from '@vendure/asset-server-plugin'
import { DashboardPlugin } from '@vendure/dashboard/plugin'
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin'
import { GraphiqlPlugin } from '@vendure/graphiql-plugin'
import path from 'node:path'

export function createDevelopmentPlugins() {
  return [
    GraphiqlPlugin.init(),
    AssetServerPlugin.init({
      route: 'assets',
      assetUploadDir: path.join(__dirname, '../../static/assets'),
    }),
    EmailPlugin.init({
      devMode: true,
      outputPath: path.join(__dirname, '../../static/email/test-emails'),
      route: 'mailbox',
      handlers: defaultEmailHandlers,
      templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../../static/email/templates')),
      globalTemplateVars: {
        fromAddress: '"Commerce Core PoC" <noreply@example.invalid>',
        verifyEmailAddressUrl: 'http://localhost:8080/verify',
        passwordResetUrl: 'http://localhost:8080/password-reset',
        changeEmailAddressUrl: 'http://localhost:8080/verify-email-address-change',
      },
    }),
    DashboardPlugin.init({
      route: 'dashboard',
      appDir: path.join(__dirname, '../../dist/dashboard'),
    }),
  ]
}
