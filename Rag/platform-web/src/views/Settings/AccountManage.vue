<template>
  <div :class="['account-manage-view', { 'account-manage-view--embedded': props.embedded }]">
    <AccountSeatDialog v-model="seatDialogVisible" :accounts="accountList" :initial-account-id="seatAccountId" />
    <!-- 渠道连不上：整条横幅闪红光。
         注意放在 embedded 判断之外——工作台里的账号管理是**嵌入**渲染的
         （account-manage-view--embedded），只写在非嵌入的筛选条里就等于不显示。 -->
    <div v-if="abnormalChannelInScope" class="account-manage-view__channel-alert" role="status">
      渠道「{{ abnormalChannelLabel }}」连不上（本地客户端未连接），暂时无法收发消息
    </div>

    <header v-if="!props.embedded" class="account-manage-view__header">
      <div>
        <h3 class="account-manage-view__title">渠道账号管理</h3>
        <span class="account-manage-view__count">{{ accountList.length }} 个账号</span>
      </div>
      <div class="account-manage-view__actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadAccounts">刷新</el-button>
        <el-button type="primary" :icon="Plus" :disabled="!channelOptions.length" @click="handleAdd">
          添加账号
        </el-button>
      </div>
    </header>

    <div v-if="!props.embedded" class="account-manage-view__filters">
      <span class="account-manage-view__filter-label">渠道</span>
      <el-select
        v-model="filterChannel"
        class="account-manage-view__channel-filter"
        aria-label="按渠道筛选账号"
        @change="handleFilterChange"
      >
        <el-option label="全部渠道" value="all" />
        <el-option
          v-for="channel in channelOptions"
          :key="channel.code"
          :label="channel.label"
          :value="channel.code"
        >
          <span class="account-manage-view__option-label">
            <span>{{ channel.label }}</span>
            <!-- 渠道连不上：下拉里也要能看出来，否则选中之前完全无感 -->
            <span v-if="isChannelAbnormal(channel.code)" class="account-manage-view__option-alert">连不上</span>
          </span>
        </el-option>
      </el-select>
    </div>

    <section v-if="showCommerceCapability" class="douyin-capability" :aria-label="`${capabilityChannelLabel}接入能力`">
      <div class="douyin-capability__heading">
        <span class="douyin-capability__mark" aria-hidden="true"></span>
        <strong>{{ capabilityHeading }}</strong>
        <el-tag size="small" type="success" effect="plain">订单事件</el-tag>
        <el-tag size="small" type="warning" effect="plain">售后事件</el-tag>
        <el-tag v-if="activeCapabilities.productEvents" size="small" type="info" effect="plain">商品事件</el-tag>
      </div>
      <p>{{ activeCapabilities.limitation }}</p>
    </section>

    <RemoteShopConnection v-if="filterChannel === 'wechat_shop' || props.channelCode === 'wechat_shop'" @changed="loadAccounts" />
    <div class="account-manage-view__table" v-loading="loading">
      <el-table v-if="accountList.length" :data="accountList" row-key="id" stripe>
        <el-table-column label="账号" min-width="190">
          <template #default="{ row }">
            <div class="account-name">{{ row.account_name }}</div>
            <div class="account-meta">ID {{ row.id }}</div>
          </template>
        </el-table-column>

        <el-table-column label="渠道" width="130">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="channelTagType(row.channel)">
              {{ getChannelLabel(row.channel) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="账号状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="getStatusTagType(row.status)">
              {{ getStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="对话接入" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.adapter_type !== 'wechat_shop_cloud' && getAccountConnectionMode(row.channel) === 'desktop_bridge_required' ? 'warning' : 'success'">
              {{ row.adapter_type === 'wechat_shop_cloud' ? '远端中转' : connectionModeLabel(row.channel) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="桌面节点" width="120">
          <template #default="{ row }">
            <span v-if="row.adapter_type !== 'wechat_shop_cloud' && getAccountConnectionMode(row.channel) === 'desktop_bridge_required'" class="account-meta">
              {{ row.desktop_node_id || '待配置' }}
            </span>
            <span v-else class="account-meta">不适用</span>
          </template>
        </el-table-column>

        <el-table-column label="凭据" width="130">
          <template #default="{ row }">
            <template v-if="['douyin', 'pinduoduo', 'taobao', 'alibaba1688', 'xiaohongshu', 'wechat_shop', 'kuaishou'].includes(row.channel)">
              <el-tag size="small" :type="row.credentialStatus === 'configured' ? 'success' : 'danger'">
                {{ row.credentialStatus === 'configured' ? '已配置' : '待补全' }}
              </el-tag>
            </template>
            <span v-else class="account-meta">不适用</span>
          </template>
        </el-table-column>

        <el-table-column label="官方接入" min-width="260">
          <template #default="{ row }">
            <div v-if="row.channel === 'douyin'" class="callback-address">
              <code :title="callbackAddress(row)">{{ callbackAddress(row) }}</code>
              <el-tooltip content="复制回调地址" placement="top">
                <el-button
                  text
                  circle
                  :icon="CopyDocument"
                  aria-label="复制回调地址"
                  @click="copyCallback(row)"
                />
              </el-tooltip>
            </div>
            <div v-else-if="row.channel === 'pinduoduo'" class="account-connection">
              <span class="account-meta">Mall ID</span>
              <code>{{ row.mallIdMask || '未提供' }}</code>
            </div>
            <div v-else-if="row.channel === 'taobao'" class="account-connection">
              <span class="account-meta">Seller Nick</span>
              <code>{{ row.sellerNickMask || '未提供' }}</code>
            </div>
            <div v-else-if="row.channel === 'alibaba1688'" class="account-connection">
              <span class="account-meta">Seller Member ID</span>
              <code>{{ row.sellerMemberIdMask || '未提供' }}</code>
            </div>
            <div v-else-if="row.adapter_type === 'wechat_shop_cloud'" class="account-connection"><span class="account-meta">远端授权 · 无需小店密钥</span></div>
            <div v-else-if="['xiaohongshu', 'wechat_shop', 'kuaishou'].includes(row.channel)" class="account-connection">
              <span class="account-meta">Shop ID</span>
              <code>{{ row.shopIdMask || '未提供' }}</code>
            </div>
            <span v-else class="account-meta">-</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="260" fixed="right" align="right">
          <template #default="{ row }">
            <el-button text type="primary" @click="seatAccountId = row.id; seatDialogVisible = true">配置客服账号</el-button>
            <el-button
              text
              type="danger"
              :icon="Delete"
              :loading="deletingIds.has(row.id)"
              @click="row.adapter_type === 'wechat_shop_cloud' ? openShopDelete(row) : handleDelete(row)"
            >
              {{ row.adapter_type === 'wechat_shop_cloud' ? '删除店铺' : '删除' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-else-if="!loading" description="当前筛选条件下暂无账号">
        <el-button type="primary" :icon="Plus" :disabled="!channelOptions.length" @click="handleAdd">
          添加账号
        </el-button>
      </el-empty>
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="添加渠道账号"
      width="560px"
      destroy-on-close
      @closed="resetForm"
    >
      <el-form
        ref="addFormRef"
        :model="addForm"
        :rules="addRules"
        label-position="top"
        status-icon
      >
        <div class="form-grid">
          <el-form-item label="渠道" prop="channel">
            <el-select v-model="addForm.channel" placeholder="请选择渠道" @change="onChannelChange">
              <el-option
                v-for="channel in channelOptions"
                :key="channel.code"
                :label="channel.label"
                :value="channel.code"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="账号名称" prop="accountName">
            <el-input v-model="addForm.accountName" maxlength="100" :placeholder="accountNamePlaceholder" />
          </el-form-item>
        </div>

        <template v-if="addForm.channel === 'douyin'">
          <div class="credential-section">
            <div class="credential-section__title">接入方式</div>
            <el-form-item label="接入方式" prop="connectionMode">
              <el-radio-group v-model="addForm.connectionMode">
                <el-radio-button value="official_api">官方 API（App Key）</el-radio-button>
                <el-radio-button value="desktop_bridge">本地桌面客户端</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </div>
        </template>

        <template v-if="addForm.channel === 'douyin' && !useDesktopBridge">
          <div class="credential-section">
            <div class="credential-section__title">抖店开放平台凭据</div>
            <div class="form-grid">
              <el-form-item label="App Key" prop="appKey">
                <el-input v-model="addForm.appKey" autocomplete="off" placeholder="请输入 App Key" />
              </el-form-item>
              <el-form-item label="店铺 ID" prop="shopId">
                <el-input v-model="addForm.shopId" autocomplete="off" placeholder="请输入店铺 ID" />
              </el-form-item>
            </div>
            <el-form-item label="App Secret" prop="appSecret">
              <el-input
                v-model="addForm.appSecret"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入 App Secret"
              />
            </el-form-item>
            <p class="credential-section__notice">
              抖店官方目前未开放飞鸽客服收发消息 API，本系统只接订单/售后/商品事件。
            </p>
          </div>
        </template>

        <template v-if="useDesktopBridge">
          <div class="credential-section">
            <div class="credential-section__title">本机客户端检测</div>
            <p class="credential-section__notice">
              读取本机运行的抖店飞鸽客户端元素树，全程只读：不点击界面、不写入内容。需后端与客户端在同一台电脑。
            </p>
            <div class="detect-row">
              <el-button :loading="detecting" @click="handleDetect">
                {{ addForm.detection ? '重新检测' : '自动检测' }}
              </el-button>
              <span v-if="detecting" class="detect-row__hint">
                正在检测，客户端冷启动时可能需要十几秒…
              </span>
            </div>
            <el-alert
              v-if="detectionError"
              type="error"
              :closable="false"
              :title="detectionError"
              show-icon
              class="detect-alert"
            />
            <div v-if="addForm.detection" class="detect-result">
              <div class="detect-result__row">
                <span>店铺</span><strong>{{ addForm.detection.shopName }}</strong>
              </div>
              <div class="detect-result__row">
                <span>客服状态</span><strong>{{ addForm.detection.agentStatus || '—' }}</strong>
              </div>
              <div class="detect-result__row">
                <span>会话数</span><strong>{{ addForm.detection.conversationCount ?? '—' }}</strong>
              </div>
              <div class="detect-result__row">
                <span>本机</span><strong>{{ addForm.detection.hostName || '—' }}</strong>
              </div>
            </div>
          </div>
        </template>

        <template v-if="addForm.channel === 'wechat'">
          <div class="credential-section">
            <div class="credential-section__title">微信小程序凭据</div>
            <el-form-item label="App ID" prop="appId">
              <el-input v-model="addForm.appId" autocomplete="off" placeholder="请输入 App ID" />
            </el-form-item>
            <el-form-item label="App Secret" prop="appSecret">
              <el-input
                v-model="addForm.appSecret"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入 App Secret"
              />
            </el-form-item>
            <p class="credential-section__notice">
              微信小程序账号仅保存应用凭据，不与企业微信“客服1号”共用接口或回调配置。
            </p>
          </div>
        </template>

        <template v-if="addForm.channel === 'pinduoduo'">
          <div class="credential-section">
            <div class="credential-section__title">拼多多开放平台凭据</div>
            <div class="form-grid">
              <el-form-item label="Client ID" prop="clientId">
                <el-input v-model="addForm.clientId" autocomplete="off" placeholder="请输入 Client ID" />
              </el-form-item>
              <el-form-item label="Mall ID" prop="mallId">
                <el-input v-model="addForm.mallId" autocomplete="off" placeholder="请输入 Mall ID" />
              </el-form-item>
            </div>
            <el-form-item label="Client Secret" prop="clientSecret">
              <el-input
                v-model="addForm.clientSecret"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入 Client Secret"
              />
            </el-form-item>
            <el-form-item label="Access Token" prop="accessToken">
              <el-input
                v-model="addForm.accessToken"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入店铺 Access Token"
              />
            </el-form-item>
            <p class="credential-section__notice">
              拼多多官方商家 API 当前未提供买家客服聊天收发能力，本系统只同步订单和售后事件。
            </p>
          </div>
        </template>

        <template v-if="addForm.channel === 'taobao'">
          <div class="credential-section">
            <div class="credential-section__title">淘宝开放平台凭据</div>
            <div class="form-grid">
              <el-form-item label="App Key" prop="appKey">
                <el-input v-model="addForm.appKey" autocomplete="off" placeholder="请输入 App Key" />
              </el-form-item>
              <el-form-item label="Seller Nick" prop="sellerNick">
                <el-input v-model="addForm.sellerNick" autocomplete="off" placeholder="请输入授权卖家昵称" />
              </el-form-item>
            </div>
            <el-form-item label="App Secret" prop="appSecret">
              <el-input
                v-model="addForm.appSecret"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入 App Secret"
              />
            </el-form-item>
            <el-form-item label="Session Key" prop="sessionKey">
              <el-input
                v-model="addForm.sessionKey"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入店铺授权 Session Key"
              />
            </el-form-item>
            <p class="credential-section__notice">
              公开服务端 API 不提供独立网页买家聊天发送能力；本系统同步订单和退款，并用 buyer_open_uid / ouid 识别客户。
            </p>
          </div>
        </template>

        <template v-if="addForm.channel === 'alibaba1688'">
          <div class="credential-section">
            <div class="credential-section__title">1688 开放平台凭据</div>
            <div class="form-grid">
              <el-form-item label="App Key" prop="appKey">
                <el-input v-model="addForm.appKey" autocomplete="off" placeholder="请输入 App Key" />
              </el-form-item>
              <el-form-item label="Seller Member ID" prop="sellerMemberId">
                <el-input
                  v-model="addForm.sellerMemberId"
                  autocomplete="off"
                  placeholder="请输入授权卖家 Member ID"
                />
              </el-form-item>
            </div>
            <el-form-item label="App Secret" prop="appSecret">
              <el-input
                v-model="addForm.appSecret"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入 App Secret"
              />
            </el-form-item>
            <el-form-item label="Access Token" prop="accessToken">
              <el-input
                v-model="addForm.accessToken"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入店铺授权 Access Token"
              />
            </el-form-item>
            <p class="credential-section__notice">
              公开服务端 API 不提供独立网页买家聊天发送能力；系统只同步加密场景订单和退款事件。
            </p>
          </div>
        </template>

        <template v-if="['xiaohongshu', 'wechat_shop', 'kuaishou'].includes(addForm.channel)">
          <div class="credential-section">
            <div class="credential-section__title">{{ getChannelLabel(addForm.channel) }}开放平台凭据</div>
            <div class="form-grid">
              <el-form-item :label="addForm.channel === 'wechat_shop' ? 'App ID' : 'App Key'" :prop="addForm.channel === 'wechat_shop' ? 'appId' : 'appKey'">
                <el-input
                  v-if="addForm.channel === 'wechat_shop'"
                  v-model="addForm.appId"
                  autocomplete="off"
                  placeholder="请输入 App ID"
                />
                <el-input v-else v-model="addForm.appKey" autocomplete="off" placeholder="请输入 App Key" />
              </el-form-item>
              <el-form-item label="Shop ID" prop="shopId">
                <el-input v-model="addForm.shopId" autocomplete="off" placeholder="请输入店铺 Shop ID" />
              </el-form-item>
            </div>
            <el-form-item label="App Secret" prop="appSecret">
              <el-input
                v-model="addForm.appSecret"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入 App Secret"
              />
            </el-form-item>
            <el-form-item v-if="addForm.channel !== 'wechat_shop'" label="Access Token" prop="accessToken">
              <el-input
                v-model="addForm.accessToken"
                type="password"
                show-password
                autocomplete="new-password"
                placeholder="请输入店铺授权 Access Token"
              />
            </el-form-item>
            <p class="credential-section__notice">
              官方 API 同步商品、订单和售后事件；客服聊天通过已绑定的桌面消息桥接入。
            </p>
          </div>
        </template>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSave">创建账号</el-button>
      </template>
    </el-dialog>
    <ShopDeleteDialog v-model="shopDeleteVisible" :account="shopDeleteAccount" @deleted="loadAccounts" />
  </div>
</template>

<script setup>
import AccountSeatDialog from './components/AccountSeatDialog.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CopyDocument, Delete, Plus, Refresh } from '@element-plus/icons-vue'
import RemoteShopConnection from './components/RemoteShopConnection.vue'
import ShopDeleteDialog from './components/ShopDeleteDialog.vue'

import {
  createChannelAccount,
  deleteChannelAccount,
  detectDesktopAccount,
  getChannelAccounts,
  getChannelDefinitions
} from '@/api/channels'
import { getChannelCapabilities } from '@/modules/channels/channelCapabilities'
import {
  buildDouyinAccountCreateRequest,
  buildDouyinCallbackUrl,
  validateDouyinAccountForm
} from '@/modules/channels/douyinAccountForm'
import {
  buildWechatAccountCreateRequest,
  validateWechatAccountForm
} from '@/modules/channels/wechatAccountForm'
import {
  buildPinduoduoAccountCreateRequest,
  validatePinduoduoAccountForm
} from '@/modules/channels/pinduoduoAccountForm'
import {
  buildTaobaoAccountCreateRequest,
  validateTaobaoAccountForm
} from '@/modules/channels/taobaoAccountForm'
import {
  buildAlibaba1688AccountCreateRequest,
  validateAlibaba1688AccountForm
} from '@/modules/channels/alibaba1688AccountForm'
import {
  buildXiaohongshuAccountCreateRequest,
  validateXiaohongshuAccountForm
} from '@/modules/channels/xiaohongshuAccountForm'
import {
  buildWechatShopAccountCreateRequest,
  validateWechatShopAccountForm
} from '@/modules/channels/wechatShopAccountForm'
import {
  buildKuaishouAccountCreateRequest,
  validateKuaishouAccountForm
} from '@/modules/channels/kuaishouAccountForm'
import { resolveAccountChannel } from '@/modules/navigation/channelNavigation'
import { useChannelHealth } from '@/modules/channels/channelHealth'
import { connectionModeLabel, getAccountConnectionMode } from '@/modules/accounts/accountDirectory'
import {
  DESKTOP_BRIDGE_CONNECTION_MODE,
  DESKTOP_BRIDGE_DETECTABLE_CHANNELS,
  createDesktopBridgeAccountForm
} from '@/modules/channels/desktopBridgeAccountForm'

const props = defineProps({
  channelCode: { type: String, default: '' },
  embedded: { type: Boolean, default: false }
})
const route = useRoute()
const router = useRouter()
const loading = ref(false)
const shopDeleteVisible = ref(false), shopDeleteAccount = ref(null)
function openShopDelete(account) { shopDeleteAccount.value = account; shopDeleteVisible.value = true }
const submitting = ref(false)
const dialogVisible = ref(false)
const initialized = ref(false)
const addFormRef = ref(null)
const accountList = ref([])
const seatDialogVisible = ref(false), seatAccountId = ref(null)
const channelOptions = ref([])
const filterChannel = ref('all')
const deletingIds = ref(new Set())

function resolveFilterChannel(queryChannel = route.query.channel) {
  if (props.channelCode) return resolveAccountChannel(props.channelCode, '')
  return resolveAccountChannel(queryChannel, route.meta.channelCode)
}

const initialForm = () => ({
  channel: '',
  accountName: '',
  // 'official_api' 走 App Key；'desktop_bridge' 走本机客户端检测
  connectionMode: 'official_api',
  detection: null,
  appKey: '',
  appSecret: '',
  appId: '',
  shopId: '',
  clientId: '',
  clientSecret: '',
  accessToken: '',
  mallId: '',
  sessionKey: '',
  sellerNick: '',
  sellerMemberId: '',
  maxDailyQuota: 1000
})
const addForm = reactive(initialForm())
const detecting = ref(false)
const detectionError = ref('')

const requiredRule = message => ({ required: true, message, trigger: 'blur' })

// 桌面桥接接入不需要 App Key，因此这些渠道的官方凭据规则要跳过
const useDesktopBridge = computed(() =>
  addForm.connectionMode === DESKTOP_BRIDGE_CONNECTION_MODE &&
  DESKTOP_BRIDGE_DETECTABLE_CHANNELS.includes(addForm.channel)
)

const addRules = computed(() => ({
  channel: [{ required: true, message: '请选择渠道', trigger: 'change' }],
  accountName: [requiredRule('请输入账号名称')],
  ...(addForm.channel === 'douyin' && !useDesktopBridge.value ? {
    appKey: [requiredRule('请输入 App Key')],
    appSecret: [requiredRule('请输入 App Secret')],
    shopId: [requiredRule('请输入店铺 ID')]
  } : {}),
  ...(addForm.channel === 'wechat' ? {
    appId: [requiredRule('请输入 App ID')],
    appSecret: [requiredRule('请输入 App Secret')]
  } : {}),
  ...(addForm.channel === 'pinduoduo' ? {
    clientId: [requiredRule('请输入 Client ID')],
    clientSecret: [requiredRule('请输入 Client Secret')],
    accessToken: [requiredRule('请输入 Access Token')],
    mallId: [requiredRule('请输入 Mall ID')]
  } : {}),
  ...(addForm.channel === 'taobao' ? {
    appKey: [requiredRule('请输入 App Key')],
    appSecret: [requiredRule('请输入 App Secret')],
    sessionKey: [requiredRule('请输入 Session Key')],
    sellerNick: [requiredRule('请输入 Seller Nick')]
  } : {}),
  ...(addForm.channel === 'alibaba1688' ? {
    appKey: [requiredRule('请输入 App Key')],
    appSecret: [requiredRule('请输入 App Secret')],
    accessToken: [requiredRule('请输入 Access Token')],
    sellerMemberId: [requiredRule('请输入 Seller Member ID')]
  } : {}),
  ...(['xiaohongshu', 'kuaishou'].includes(addForm.channel) ? {
    appKey: [requiredRule('请输入 App Key')],
    appSecret: [requiredRule('请输入 App Secret')],
    accessToken: [requiredRule('请输入 Access Token')],
    shopId: [requiredRule('请输入 Shop ID')]
  } : {}),
  ...(addForm.channel === 'wechat_shop' ? {
    appId: [requiredRule('请输入 App ID')],
    appSecret: [requiredRule('请输入 App Secret')],
    shopId: [requiredRule('请输入 Shop ID')]
  } : {})
}))

const commerceCapabilities = Object.freeze({
  douyin: getChannelCapabilities('douyin'),
  pinduoduo: getChannelCapabilities('pinduoduo'),
  taobao: getChannelCapabilities('taobao'),
  alibaba1688: getChannelCapabilities('alibaba1688'),
  xiaohongshu: getChannelCapabilities('xiaohongshu'),
  wechat_shop: getChannelCapabilities('wechat_shop'),
  kuaishou: getChannelCapabilities('kuaishou')
})
const capabilityChannel = computed(() => {
  if (commerceCapabilities[filterChannel.value]) return filterChannel.value
  for (const channel of ['douyin', 'pinduoduo', 'taobao', 'alibaba1688', 'xiaohongshu', 'wechat_shop', 'kuaishou']) {
    if (accountList.value.some(account => account.channel === channel)) return channel
  }
  return ''
})
const showCommerceCapability = computed(() => Boolean(capabilityChannel.value))
const activeCapabilities = computed(() => commerceCapabilities[capabilityChannel.value] || commerceCapabilities.douyin)
const channelLabels = Object.freeze({
  douyin: '抖店',
  pinduoduo: '拼多多',
  taobao: '淘宝 / 千牛',
  alibaba1688: '1688',
  xiaohongshu: '小红书',
  wechat_shop: '微信小店',
  kuaishou: '快手小店'
})
const capabilityChannelLabel = computed(() => channelLabels[capabilityChannel.value] || '渠道')

// ========== 渠道异常（连不上）提示 ==========
const channelHealth = useChannelHealth()
const isChannelAbnormal = channelHealth.isChannelAbnormal
// 当前这一屏里有没有异常渠道：筛了具体渠道就看那个，否则看全部渠道里有没有异常
const abnormalChannelInScope = computed(() => {
  if (filterChannel.value !== 'all') return channelHealth.isChannelAbnormal(filterChannel.value)
  return channelHealth.channels.value.some(ch => ch.status && ['OFFLINE', 'CRITICAL'].includes(String(ch.status).toUpperCase()))
})
const abnormalChannelLabel = computed(() => {
  if (filterChannel.value !== 'all') return channelLabels[filterChannel.value] || filterChannel.value
  const bad = channelHealth.channels.value.find(ch => ['OFFLINE', 'CRITICAL'].includes(String(ch.status || '').toUpperCase()))
  return (bad && (channelLabels[bad.channel] || bad.label)) || '渠道'
})
const capabilityHeading = computed(() => `${capabilityChannelLabel.value}开放平台`)
const accountNamePlaceholders = Object.freeze({
  douyin: '例：抖店华东店',
  wechat: '例：微信小程序客服',
  pinduoduo: '例：拼多多旗舰店',
  taobao: '例：淘宝旗舰店',
  alibaba1688: '例：1688 华东店',
  xiaohongshu: '例：小红书旗舰店',
  wechat_shop: '例：微信小店旗舰店',
  kuaishou: '例：快手小店旗舰店'
})
const accountNamePlaceholder = computed(() => accountNamePlaceholders[addForm.channel] || '请输入账号名称')

function getChannelLabel(code) {
  return channelOptions.value.find(channel => channel.code === code)?.label || code
}

function getStatusLabel(status) {
  return ({ active: '启用', inactive: '停用', online: '在线', offline: '离线', restricted: '受限' })[status] || status
}

function getStatusTagType(status) {
  return ({ active: 'success', online: 'success', inactive: 'info', offline: 'info', restricted: 'danger' })[status] || 'info'
}

function channelTagType(channel) {
  return ({
    douyin: 'info', wechat: 'success', pinduoduo: 'warning', taobao: 'danger', alibaba1688: 'success',
    xiaohongshu: 'danger', wechat_shop: 'success', kuaishou: 'warning'
  })[channel] || ''
}

function callbackAddress(account) {
  return buildDouyinCallbackUrl(account, window.location.origin)
}

async function loadChannels() {
  const response = await getChannelDefinitions({ status: 'active' })
  channelOptions.value = Array.isArray(response.data) ? response.data : []
}

async function loadAccounts() {
  loading.value = true
  try {
    const params = filterChannel.value === 'all' ? {} : { channel: filterChannel.value }
    const response = await getChannelAccounts(params)
    accountList.value = Array.isArray(response.data) ? response.data : []
  } finally {
    loading.value = false
  }
}

async function handleFilterChange(channel) {
  const query = { ...route.query }
  if (channel === 'all' && route.meta.channelCode) query.channel = 'all'
  else if (channel === 'all') delete query.channel
  else query.channel = channel

  if (resolveAccountChannel(route.query.channel, route.meta.channelCode) === channel) {
    await loadAccounts()
    return
  }
  await router.replace({ query })
}

function resetForm() {
  Object.assign(addForm, initialForm())
  addFormRef.value?.clearValidate()
}

function handleAdd() {
  resetForm()
  const preferredChannel = filterChannel.value !== 'all' ? filterChannel.value : channelOptions.value[0]?.code
  addForm.channel = preferredChannel || ''
  dialogVisible.value = true
}

defineExpose({ openCreate: handleAdd, refresh: loadAccounts })

async function onChannelChange() {
  addForm.appKey = ''
  addForm.appSecret = ''
  addForm.appId = ''
  addForm.shopId = ''
  addForm.clientId = ''
  addForm.clientSecret = ''
  addForm.accessToken = ''
  addForm.mallId = ''
  addForm.sessionKey = ''
  addForm.sellerNick = ''
  addForm.sellerMemberId = ''
  await nextTick()
  addFormRef.value?.clearValidate([
    'appKey', 'appSecret', 'appId', 'shopId', 'clientId', 'clientSecret', 'accessToken', 'mallId',
    'sessionKey', 'sellerNick', 'sellerMemberId'
  ])
}

async function handleDetect() {
  detecting.value = true
  detectionError.value = ''
  try {
    const response = await detectDesktopAccount()
    const data = response?.data || {}
    if (!data.shopName) {
      addForm.detection = null
      detectionError.value = '检测到客户端但读不到店铺名，请确认飞鸽已登录且主窗口未被最小化'
      return
    }
    addForm.detection = { ...data }
    // 账号名称留空时用店铺名兜底，减少手工输入
    if (!addForm.accountName) addForm.accountName = data.shopName
    ElMessage.success(`已检测到店铺：${data.shopName}`)
  } catch (error) {
    addForm.detection = null
    detectionError.value = error?.response?.data?.message || error?.message || '检测失败，请稍后重试'
  } finally {
    detecting.value = false
  }
}

async function handleSave() {
  if (!addFormRef.value) return
  try {
    await addFormRef.value.validate()
  } catch {
    return
  }

  let payload
  if (useDesktopBridge.value) {
    const form = createDesktopBridgeAccountForm({ channel: addForm.channel })
    const input = {
      accountName: addForm.accountName,
      detection: addForm.detection,
      maxDailyQuota: addForm.maxDailyQuota
    }
    const errors = form.validate(input)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = form.buildRequest(input)
  } else if (addForm.channel === 'douyin') {
    const errors = validateDouyinAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildDouyinAccountCreateRequest(addForm)
  } else if (addForm.channel === 'wechat') {
    const errors = validateWechatAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildWechatAccountCreateRequest(addForm)
  } else if (addForm.channel === 'pinduoduo') {
    const errors = validatePinduoduoAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildPinduoduoAccountCreateRequest(addForm)
  } else if (addForm.channel === 'taobao') {
    const errors = validateTaobaoAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildTaobaoAccountCreateRequest(addForm)
  } else if (addForm.channel === 'alibaba1688') {
    const errors = validateAlibaba1688AccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildAlibaba1688AccountCreateRequest(addForm)
  } else if (addForm.channel === 'xiaohongshu') {
    const errors = validateXiaohongshuAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildXiaohongshuAccountCreateRequest(addForm)
  } else if (addForm.channel === 'wechat_shop') {
    const errors = validateWechatShopAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildWechatShopAccountCreateRequest(addForm)
  } else if (addForm.channel === 'kuaishou') {
    const errors = validateKuaishouAccountForm(addForm)
    if (errors.length) {
      ElMessage.warning(errors[0])
      return
    }
    payload = buildKuaishouAccountCreateRequest(addForm)
  } else {
    payload = {
      channel: addForm.channel,
      account_name: addForm.accountName.trim(),
      max_daily_quota: addForm.maxDailyQuota,
      config: {}
    }
  }

  submitting.value = true
  try {
    await createChannelAccount(payload)
    addForm.appSecret = ''
    addForm.appId = ''
    addForm.accessToken = ''
    addForm.sessionKey = ''
    dialogVisible.value = false
    ElMessage.success('账号创建成功')
    await loadAccounts()
  } finally {
    submitting.value = false
  }
}

async function copyCallback(account) {
  try {
    await navigator.clipboard.writeText(callbackAddress(account))
    ElMessage.success('回调地址已复制')
  } catch {
    ElMessage.error('复制失败，请手动复制回调地址')
  }
}

async function handleDelete(account) {
  try {
    await ElMessageBox.confirm(
      `确认删除账号“${account.account_name}”吗？此操作不可撤销。`,
      '删除账号',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return
  }

  deletingIds.value = new Set([...deletingIds.value, account.id])
  try {
    await deleteChannelAccount(account.id)
    ElMessage.success('账号已删除')
    await loadAccounts()
  } finally {
    const next = new Set(deletingIds.value)
    next.delete(account.id)
    deletingIds.value = next
  }
}

watch([() => props.channelCode, () => route.query.channel], async ([, value]) => {
  if (!initialized.value) return
  filterChannel.value = resolveFilterChannel(value)
  await loadAccounts()
})

onMounted(async () => {
  channelHealth.startPolling()
  try {
    await loadChannels()
    filterChannel.value = resolveFilterChannel()
    initialized.value = true
    await loadAccounts()
  } catch {
    accountList.value = []
  }
})

onBeforeUnmount(() => {
  channelHealth.stopPolling()
})
</script>

<style scoped lang="scss">
.account-manage-view {
  min-width: 0;
  padding: $spacing-xl;

  &--embedded {
    padding: 0;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: $spacing-lg;
    margin-bottom: $spacing-lg;

    > div:first-child {
      display: flex;
      align-items: baseline;
      gap: $spacing-sm;
    }
  }

  &__title {
    margin: 0;
    color: $color-text-primary;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0;
  }

  &__count,
  &__filter-label {
    color: $color-text-secondary;
    font-size: 13px;
  }

  &__actions {
    display: flex;
    gap: $spacing-sm;
  }

  &__filters {
    display: flex;
    align-items: center;
    gap: $spacing-sm;
    padding: $spacing-md 0;
    border-top: 1px solid $color-border;
  }

  &__channel-filter {
    width: 220px;
  }

  &__option-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  &__option-alert {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 8px;
    background: #fee2e2;
    border: 1px solid #fecaca;
    color: #dc2626;
    font-size: 11px;
  }

  // 渠道异常横幅：红光呼吸（工作台嵌入渲染时也显示）
  &__channel-alert {
    margin-bottom: $spacing-md;
    padding: 8px 12px;
    border-radius: $radius-md;
    border: 1px solid #fca5a5;
    font-size: 13px;
    line-height: 20px;
    color: #b91c1c;
    animation: account-channel-alert 1.2s ease-in-out infinite;
  }

  &__table {
    min-height: 280px;
    overflow: hidden;
    border: 1px solid $color-border;
    border-radius: $radius-md;
    background: $color-bg-white;

    :deep(.el-table) {
      --el-table-header-bg-color: #f8fafc;
      --el-table-row-hover-bg-color: #f8fafc;
    }
  }
}

.douyin-capability {
  margin: 0 0 $spacing-md;
  padding: 10px $spacing-md;
  border: 1px solid $color-border;
  border-left: 3px solid #00b8bd;
  background: $color-bg-white;

  &__heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: $spacing-sm;
    color: $color-text-primary;
    font-size: 14px;
  }

  &__mark {
    width: 6px;
    height: 16px;
    border-top: 8px solid #00b8bd;
    border-bottom: 8px solid #fe2c55;
  }

  p {
    margin: 6px 0 0 14px;
    color: $color-text-regular;
    font-size: 13px;
    line-height: 1.5;
  }
}

.account-name {
  overflow: hidden;
  color: $color-text-primary;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-meta {
  color: $color-text-secondary;
  font-size: 12px;
}

.callback-address {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: $spacing-xs;

  code {
    overflow: hidden;
    color: $color-text-regular;
    font-family: Consolas, 'Courier New', monospace;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.account-connection {
  display: flex;
  align-items: center;
  gap: $spacing-sm;

  code {
    color: $color-text-regular;
    font-family: Consolas, 'Courier New', monospace;
    font-size: 12px;
  }
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 $spacing-lg;

  :deep(.el-select) {
    width: 100%;
  }
}

.credential-section {
  margin: 2px 0 $spacing-lg;
  padding: $spacing-md;
  border: 1px solid $color-border;
  border-radius: $radius-md;
  background: #f8fafc;

  &__title {
    margin-bottom: $spacing-md;
    color: $color-text-primary;
    font-size: 14px;
    font-weight: 600;
  }

  &__notice {
    margin: 0;
    padding-top: $spacing-sm;
    border-top: 1px solid $color-border;
    color: $color-text-regular;
    font-size: 12px;
    line-height: 1.6;
  }
}

/* 桌面桥接接入：自动检测面板 */
.detect-row {
  display: flex;
  align-items: center;
  gap: $spacing-sm;
  padding-top: $spacing-sm;

  &__hint {
    color: $color-text-secondary;
    font-size: 12px;
  }
}

.detect-alert {
  margin-top: $spacing-sm;
}

.detect-result {
  margin-top: $spacing-md;
  padding: $spacing-md;
  border: 1px solid $color-border;
  border-radius: $radius-sm;
  background: $color-bg-white;

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: $spacing-md;
    padding: 2px 0;
    font-size: 13px;

    span {
      color: $color-text-secondary;
    }

    strong {
      color: $color-text-primary;
      font-weight: 600;
    }
  }
}

@media (max-width: 720px) {
  .account-manage-view {
    padding: $spacing-md;

    &__header {
      align-items: flex-start;
      flex-direction: column;
    }

    &__actions,
    &__channel-filter {
      width: 100%;
    }

    &__actions :deep(.el-button) {
      flex: 1;
      margin-left: 0;
    }
  }

  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  :deep(.el-dialog) {
    max-width: calc(100vw - 24px);
  }
}

/* 渠道异常：红光呼吸（避免只靠颜色，色觉差异也能看出变化） */
@keyframes account-channel-alert {
  0%, 100% { background: rgba(239, 68, 68, 0.06); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.25); }
  50% { background: rgba(239, 68, 68, 0.22); box-shadow: 0 0 10px 0 rgba(239, 68, 68, 0.45); }
}
</style>
