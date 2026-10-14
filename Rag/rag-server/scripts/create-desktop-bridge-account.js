/**
 * 创建「桌面桥接」渠道账号（含桥接绑定），与 POST /channel-accounts 的
 * desktop_bridge 分支同一套逻辑（配置加密、绑定同事务、adapterId 按渠道决定）。
 *
 * 用法：
 *   node scripts/create-desktop-bridge-account.js <channel> <账号名> <店铺名> <机器指纹>
 * 例：
 *   node scripts/create-desktop-bridge-account.js pinduoduo "AIEBS汽车用品旗舰店" "AIEBS汽车用品旗舰店" <machineFingerprint>
 *
 * 机器指纹取任意一个桌面探针（feige/千帆/拼多多）输出的 machineFingerprint——
 * 同机各平台指纹一致（一台机器一个桥接节点）。
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })

const { sequelize } = require('../src/config/database')
const { ChannelAccount } = require('../src/models')
const { encrypt } = require('../src/shared/utils/encrypt')
const { createBridgeRepository } = require('../src/modules/desktop-bridge/bridgeRepository')
const {
  prepareDesktopBridgeAccountCreation
} = require('../src/modules/channel-adapters/desktop-bridge/desktopBridgeAccountConfig')

async function main() {
  const [channel, accountName, shopName, machineFingerprint] = process.argv.slice(2)
  if (!channel || !accountName || !shopName || !machineFingerprint) {
    console.error('用法: node scripts/create-desktop-bridge-account.js <channel> <账号名> <店铺名> <机器指纹>')
    process.exit(1)
  }

  const prepared = prepareDesktopBridgeAccountCreation({
    channel,
    config: { shopName, machineFingerprint }
  })
  console.log(`渠道=${channel} adapterId=${prepared.adapterId} adapterType=${prepared.adapterType}`)

  const accountPayload = {
    channel: channel.trim().toLowerCase(),
    account_name: accountName.trim(),
    config: encrypt(prepared.config),
    status: 'active',
    adapter_type: prepared.adapterType,
    max_daily_quota: 1000
  }

  const bridgeRepository = createBridgeRepository(sequelize)
  const created = await sequelize.transaction(async transaction => {
    const account = await ChannelAccount.create(accountPayload, { transaction })
    const binding = await bridgeRepository.upsertBinding({
      channelAccountId: account.id,
      adapterId: prepared.adapterId,
      mode: 'desktop_bridge',
      enabled: 1,
      transaction
    })
    return { account, binding }
  })

  console.log(`✅ 账号已创建: id=${created.account.id} channel=${created.account.channel} ` +
    `name=${created.account.account_name} adapter=${created.account.adapter_type}`)
  console.log(`✅ 桥接绑定: account=${created.binding.channelAccountId} ` +
    `adapter=${created.binding.adapterId} mode=${created.binding.mode} enabled=${created.binding.enabled}`)
  await sequelize.close()
  process.exit(0)
}

main().catch(error => {
  console.error('创建失败:', error.message)
  process.exit(1)
})
