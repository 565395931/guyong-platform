<template>
  <div class="orders-view" :class="{ 'orders-view--fullscreen': fullscreen }">
    <div class="orders-view__header">
      <div>
        <h1>订单记录</h1>
        <p>按原成单管理字段维护客户、物流和金额信息</p>
      </div>
      <div class="orders-view__actions">
        <el-button :icon="Refresh" @click="fetchOrders">刷新</el-button>
        <el-button :icon="FullScreen" @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增订单</el-button>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="order-tabs" @tab-change="handleTabChange">
      <el-tab-pane label="国外订单" name="foreign" />
      <el-tab-pane label="国内订单" name="domestic" />
    </el-tabs>

    <div class="toolbar">
      <el-input
        v-model="query.keyword"
        clearable
        placeholder="搜索账号、姓名、单号、批次、备注..."
        :prefix-icon="Search"
        @keyup.enter="searchOrders"
        @clear="searchOrders"
      />
      <el-select v-model="query.status" clearable placeholder="订单状态" @change="searchOrders">
        <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="query.payment_status" clearable placeholder="付款状态" @change="searchOrders">
        <el-option v-for="item in paymentOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select
        v-model="query.platform"
        clearable
        filterable
        allow-create
        default-first-option
        :placeholder="activeTab === 'domestic' ? '平台' : '付款平台'"
        @change="handlePlatformFilterChange"
      >
        <el-option v-for="item in platformFilterOptions" :key="item.id" :label="item.option_value" :value="item.option_value">
          <div class="option-row">
            <span>{{ item.option_value }}</span>
            <el-button link type="danger" :icon="Close" @click.stop.prevent="removeOption(platformOptionType(), item)" />
          </div>
        </el-option>
      </el-select>
      <el-select
        v-model="query.courier"
        clearable
        filterable
        allow-create
        default-first-option
        placeholder="快递商"
        @change="handleCourierFilterChange"
      >
        <el-option v-for="item in courierOptions" :key="item.id" :label="item.option_value" :value="item.option_value">
          <div class="option-row">
            <span>{{ item.option_value }}</span>
            <el-button link type="danger" :icon="Close" @click.stop.prevent="removeOption('courier', item)" />
          </div>
        </el-option>
      </el-select>
      <el-select v-model="query.date_type" placeholder="日期类型" @change="searchOrders">
        <el-option label="购买时间" value="purchase" />
        <el-option label="预计到达" value="expected_arrival" />
        <el-option label="到货时间" value="arrival" />
      </el-select>
      <el-date-picker
        v-model="query.dateRange"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        range-separator="-"
        @change="searchOrders"
      />
      <el-button type="primary" plain :icon="Search" @click="searchOrders">查询</el-button>
      <el-button plain @click="resetFilters">重置</el-button>
      <el-button type="success" plain @click="calcTotal">计算合计</el-button>
      <span class="toolbar__total">{{ totalText }}</span>
    </div>

    <el-table
      v-loading="loading"
      class="orders-table"
      :data="orders"
      height="100%"
      :size="fullscreen ? 'small' : 'default'"
      border
    >
      <el-table-column label="ID" :width="fullscreen ? 70 : 104" fixed show-overflow-tooltip>
        <template #default="{ row }">{{ displayId(row) }}</template>
      </el-table-column>
      <el-table-column label="状态" :width="fullscreen ? 74 : 92" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tag size="small" :type="statusTag(row.status)">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="账号" :width="fullscreen ? 110 : 140" show-overflow-tooltip>
        <template #default="{ row }">
          <el-button link type="primary" class="cell-link" @click="copyText(row.channel_user_id)">
            {{ row.channel_user_id || '-' }}
          </el-button>
        </template>
      </el-table-column>
      <el-table-column label="姓名" :width="fullscreen ? 64 : 86" show-overflow-tooltip>
        <template #default="{ row }">
          <el-button link type="primary" class="cell-link" @click="copyText(row.customer_name)">
            {{ row.customer_name || '-' }}
          </el-button>
        </template>
      </el-table-column>
      <el-table-column :label="activeTab === 'domestic' ? '平台' : '付款平台'" :width="fullscreen ? 74 : 96" show-overflow-tooltip>
        <template #default="{ row }">{{ displayPlatform(row) }}</template>
      </el-table-column>
      <el-table-column prop="purchase_amount" label="购买量/kg" :width="fullscreen ? 74 : 96" show-overflow-tooltip />
      <el-table-column v-if="activeTab === 'foreign'" label="国家" :width="fullscreen ? 64 : 88" show-overflow-tooltip>
        <template #default="{ row }">{{ displayAddress(row) }}</template>
      </el-table-column>
      <el-table-column v-if="activeTab === 'foreign'" label="详细地址" :min-width="fullscreen ? 170 : 180" show-overflow-tooltip>
        <template #default="{ row }">{{ displayDetailedAddress(row) }}</template>
      </el-table-column>
      <el-table-column prop="domestic_tracking" label="国内单号" :width="fullscreen ? 110 : 138" show-overflow-tooltip />
      <el-table-column v-if="activeTab === 'foreign'" prop="international_tracking" label="国际单号" :min-width="fullscreen ? 140 : 180" show-overflow-tooltip />
      <el-table-column label="购买时间" :width="fullscreen ? 78 : 96" show-overflow-tooltip>
        <template #default="{ row }">{{ formatDate(row.purchase_time) }}</template>
      </el-table-column>
      <el-table-column label="预计到达" :width="fullscreen ? 78 : 96" show-overflow-tooltip>
        <template #default="{ row }">{{ formatDate(row.expected_arrival) }}</template>
      </el-table-column>
      <el-table-column label="到货时间" :width="fullscreen ? 78 : 96" show-overflow-tooltip>
        <template #default="{ row }">{{ formatDate(row.arrival_time) }}</template>
      </el-table-column>
      <el-table-column prop="courier" label="快递商" :width="fullscreen ? 70 : 100" show-overflow-tooltip />
      <el-table-column prop="notes" label="备注" :width="fullscreen ? 110 : 150" show-overflow-tooltip />
       <el-table-column label="生产批次" :width="fullscreen ? 84 : 120" show-overflow-tooltip>
        <template #default="{ row }">{{ displayProductionBatch(row) }}</template>
      </el-table-column>
      <el-table-column label="成交额" :width="fullscreen ? 72 : 90" align="right" show-overflow-tooltip>
        <template #default="{ row }">{{ money(row.deal_amount) }}</template>
      </el-table-column>
      <el-table-column label="运费/RMB" :width="fullscreen ? 72 : 96" align="right" show-overflow-tooltip>
        <template #default="{ row }">{{ money(row.freight_fee_rmb) }}</template>
      </el-table-column>
      <el-table-column label="成本" :width="fullscreen ? 72 : 70" align="right" show-overflow-tooltip>
        <template #default="{ row }">{{ money(row.cost_amount) }}</template>
      </el-table-column>
      <el-table-column label="营销额" :width="fullscreen ? 72 : 90" align="right" show-overflow-tooltip>
        <template #default="{ row }">{{ money(marketingAmount(row)) }}</template>
      </el-table-column>
      <el-table-column label="操作" :width="fullscreen ? 160 : (activeTab === 'foreign' ? 230 : 150)" align="center" header-align="center">
        <template #default="{ row }">
          <div class="operation-actions">
            <el-button link type="primary" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button
              v-if="activeTab === 'foreign'"
              link
              type="success"
              :icon="Document"
              :loading="invoiceGeneratingId === row.id"
              @click="generateOrderInvoice(row)"
            >
              生成 PI
            </el-button>
            <el-button link type="danger" :icon="Delete" @click="handleDeleteOrder(row)">删除</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination-bar">
      <el-pagination
        v-model:current-page="pagination.page"
        v-model:page-size="pagination.pageSize"
        :page-sizes="[20, 50, 100, 200]"
        :total="pagination.total"
        layout="total, sizes, prev, pager, next, jumper"
        background
        @size-change="handlePageSizeChange"
        @current-change="fetchOrders"
      />
    </div>

    <el-drawer v-model="drawerVisible" :title="editingId ? '编辑订单' : '新增订单'" size="1040px" class="order-drawer">
      <el-form label-width="82px" class="order-form">
        <div class="section-title section-title--first">基础信息</div>
        <div class="form-grid">
          <el-form-item label="订单状态">
            <el-select v-model="form.status">
              <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="付款状态">
            <el-select v-model="form.paymentStatus">
              <el-option v-for="item in paymentOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="账号"><el-input v-model="form.channelUserId" /></el-form-item>
          <el-form-item label="姓名"><el-input v-model="form.customerName" /></el-form-item>
          <el-form-item v-if="activeTab === 'foreign'" label="付款平台">
            <el-select
              v-model="form.paymentPlatform"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="选择或输入"
              @change="rememberOption('paymentPlatform', form.paymentPlatform)"
            >
              <el-option v-for="item in paymentPlatformOptions" :key="item.id" :label="item.option_value" :value="item.option_value">
                <div class="option-row">
                  <span>{{ item.option_value }}</span>
                  <el-button link type="danger" :icon="Close" @click.stop.prevent="removeOption('paymentPlatform', item)" />
                </div>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item v-else label="平台">
            <el-select
              v-model="form.domesticPlatform"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="选择或输入"
              @change="rememberOption('domesticPlatform', form.domesticPlatform)"
            >
              <el-option v-for="item in domesticPlatformOptions" :key="item.id" :label="item.option_value" :value="item.option_value">
                <div class="option-row">
                  <span>{{ item.option_value }}</span>
                  <el-button link type="danger" :icon="Close" @click.stop.prevent="removeOption('domesticPlatform', item)" />
                </div>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item v-if="activeTab === 'foreign'" label="国家"><el-input v-model="form.customerAddress" /></el-form-item>
          <el-form-item label="生产批次"><el-input v-model="form.productionBatch" /></el-form-item>
          <el-form-item label="购买量">
            <el-input v-model="form.purchaseAmount" />
          </el-form-item>
        </div>

        <div class="section-title">物流与时间</div>
        <div class="form-grid">
          <el-form-item label="国内单号"><el-input v-model="form.domesticTracking" /></el-form-item>
          <el-form-item v-if="activeTab === 'foreign'" label="国际单号"><el-input v-model="form.internationalTracking" /></el-form-item>
          <el-form-item label="购买时间">
            <el-date-picker v-model="form.purchaseTime" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" />
          </el-form-item>
          <el-form-item label="预计到达">
            <el-date-picker v-model="form.expectedArrivalAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" />
          </el-form-item>
          <el-form-item label="到货时间">
            <el-date-picker v-model="form.arrivedAt" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" />
          </el-form-item>
          <el-form-item label="快递商">
            <el-select
              v-model="form.courier"
              filterable
              allow-create
              default-first-option
              clearable
              placeholder="选择或输入"
              @change="rememberOption('courier', form.courier)"
            >
              <el-option v-for="item in courierOptions" :key="item.id" :label="item.option_value" :value="item.option_value">
                <div class="option-row">
                  <span>{{ item.option_value }}</span>
                  <el-button link type="danger" :icon="Close" @click.stop.prevent="removeOption('courier', item)" />
                </div>
              </el-option>
            </el-select>
          </el-form-item>
        </div>

        <div class="section-title">金额</div>
        <div class="form-grid">
          <el-form-item label="成交额"><el-input-number v-model="form.dealAmount" :precision="2" :min="0" controls-position="right" /></el-form-item>
          <el-form-item label="运费(RMB)"><el-input-number v-model="form.freightFeeRmb" :precision="2" :min="0" controls-position="right" /></el-form-item>
          <el-form-item label="成本"><el-input-number v-model="form.costAmount" :precision="2" :min="0" controls-position="right" /></el-form-item>
          <el-form-item label="营销额">
            <el-input :model-value="money(formMarketingAmount)" disabled />
          </el-form-item>
        </div>

        <div class="section-title">{{ activeTab === 'foreign' ? '备注与地址' : '备注' }}</div>
        <div class="form-grid form-grid--notes">
          <el-form-item v-if="activeTab === 'foreign'" label="详细地址">
            <el-input v-model="form.detailedAddress" type="textarea" :rows="2" resize="none" />
          </el-form-item>
          <el-form-item label="备注" :class="{ 'form-grid__full': activeTab !== 'foreign' }">
            <el-input v-model="form.notes" type="textarea" :rows="2" resize="none" />
          </el-form-item>
        </div>
      </el-form>

      <div v-if="editingId" class="section-title">订单附件</div>
      <div v-if="editingId" class="attachment-panel">
        <el-upload
          class="attachment-upload"
          drag
          multiple
          :show-file-list="false"
          :http-request="uploadAttachmentRequest"
        >
          <el-icon><Upload /></el-icon>
          <div class="el-upload__text">拖拽或点击上传附件</div>
        </el-upload>

        <div v-if="attachments.length" class="attachment-list">
          <div v-for="file in attachments" :key="file.id" class="attachment-item">
            <div class="attachment-item__info">
              <span class="attachment-item__name">{{ file.original_name }}</span>
              <span class="attachment-item__meta">{{ fileSize(file.size) }}</span>
            </div>
            <div class="attachment-item__actions">
              <el-button link type="primary" @click="openFile(file.public_url)">打开</el-button>
              <el-button link type="danger" :icon="Delete" @click="handleDeleteAttachment(file)">删除</el-button>
            </div>
          </div>
        </div>
        <el-empty v-else class="attachment-empty" description="暂无附件" :image-size="40" />
      </div>
      <template #footer>
        <el-button @click="drawerVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitOrder">保存</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { resolveAssetUrl } from '@/utils/runtimeConfig'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Close, Delete, Document, Edit, FullScreen, Plus, Refresh, Search, Upload } from '@element-plus/icons-vue'
import {
  createOrder,
  createOrderOption,
  deleteOrder,
  deleteOrderAttachment,
  deleteOrderOption,
  generateInvoice,
  getOrder,
  getOrderOptions,
  getOrders,
  updateOrder,
  uploadOrderAttachments
} from '@/api/orders'

const loading = ref(false)
const saving = ref(false)
const drawerVisible = ref(false)
const editingId = ref('')
const fullscreen = ref(false)
const activeTab = ref('foreign')
const invoiceGeneratingId = ref('')
const orders = ref([])
const attachments = ref([])
const route = useRoute()
const router = useRouter()

const query = reactive({
  keyword: '',
  status: '',
  payment_status: '',
  platform: '',
  courier: '',
  date_type: 'purchase',
  dateRange: []
})
const totalRange = reactive({ from: '', to: '' })
const totalText = ref('')
const applyingForm = ref(false)
const pagination = reactive({
  page: 1,
  pageSize: 20,
  total: 0
})

const statusOptions = [
  { label: '草稿', value: 'draft' },
  { label: '已成交', value: 'confirmed' },
  { label: '已付款', value: 'paid' },
  { label: '采购中', value: 'purchasing' },
  { label: '国内物流', value: 'domestic_shipping' },
  { label: '国际物流', value: 'international_shipping' },
  { label: '已到货', value: 'delivered' },
  { label: '售后中', value: 'after_sales' },
  { label: '已完成', value: 'closed' },
  { label: '已取消', value: 'cancelled' }
]

const paymentOptions = [
  { label: '未付款', value: 'unpaid' },
  { label: '部分付款', value: 'partial' },
  { label: '已付款', value: 'paid' },
  { label: '已退款', value: 'refunded' }
]

const optionConfig = {
  paymentPlatform: {
    type: 'payment_platform',
    label: '付款平台'
  },
  domesticPlatform: {
    type: 'domestic_platform',
    label: '平台'
  },
  courier: {
    type: 'courier',
    label: '快递商'
  }
}

const paymentPlatformOptions = ref([])
const domesticPlatformOptions = ref([])
const courierOptions = ref([])

const emptyForm = () => ({
  channelUserId: '',
  customerName: '',
  paymentPlatform: '',
  domesticPlatform: '',
  productionBatch: '',
  purchaseAmount: '',
  customerAddress: '',
  domesticTracking: '',
  internationalTracking: '',
  purchaseTime: currentDateTimeValue(),
  expectedArrivalAt: dateTimeOffsetValue(15),
  arrivedAt: '',
  courier: '',
  dealAmount: null,
  freightFeeRmb: null,
  costAmount: null,
  notes: '',
  detailedAddress: '',
  status: 'draft',
  paymentStatus: 'unpaid',
  currency: 'USD',
  rawPayload: null
})

const form = reactive(emptyForm())
const platformFilterOptions = computed(() => activeTab.value === 'domestic'
  ? domesticPlatformOptions.value
  : paymentPlatformOptions.value)
const formMarketingAmount = computed(() => {
  const deal = Number(form.dealAmount)
  const cost = Number(form.costAmount)
  if (!Number.isFinite(deal) || !Number.isFinite(cost)) return null
  return Number((deal - cost).toFixed(2))
})

watch(() => form.expectedArrivalAt, (value, oldValue) => {
  if (applyingForm.value) return
  if (!value || (form.arrivedAt && oldValue)) return
  form.arrivedAt = dateTimeOffsetValue(15, value)
})

onMounted(async () => {
  if (route.query.orderTab === 'domestic') activeTab.value = 'domestic'
  initTotalRange()
  await Promise.all([fetchOrders(), fetchOrderOptions()])
  const orderId = route.query.orderId
  if (orderId) {
    await openEdit({ id: String(orderId) })
    router.replace({ path: '/orders', query: activeTab.value === 'domestic' ? { orderTab: 'domestic' } : {} })
  }
})

function optionRef(type) {
  const map = {
    paymentPlatform: paymentPlatformOptions,
    domesticPlatform: domesticPlatformOptions,
    courier: courierOptions
  }
  return map[type]
}

function platformOptionType() {
  return activeTab.value === 'domestic' ? 'domesticPlatform' : 'paymentPlatform'
}

function setOptions(rows) {
  paymentPlatformOptions.value = rows.filter(row => row.option_type === 'payment_platform')
  domesticPlatformOptions.value = rows.filter(row => row.option_type === 'domestic_platform')
  courierOptions.value = rows.filter(row => row.option_type === 'courier')
}

async function fetchOrderOptions() {
  const res = await getOrderOptions()
  setOptions(res.data || [])
}

async function rememberOption(type, value) {
  const text = String(value || '').trim()
  const list = optionRef(type)
  const config = optionConfig[type]
  if (!text || !list || !config) return true
  if (list.value.some(item => item.option_value === text)) return true

  try {
    await ElMessageBox.confirm(`确认新增${config.label}选项「${text}」吗？`, '新增选项确认', {
      confirmButtonText: '新增',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const res = await createOrderOption({ type: config.type, value: text })
    list.value = [...list.value, res.data]
    ElMessage.success('选项已新增')
    return true
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '新增选项失败')
    }
    return false
  }
}

async function removeOption(type, item) {
  const list = optionRef(type)
  const config = optionConfig[type]
  if (!list || !config || !item?.id) return
  try {
    await ElMessageBox.confirm(`确认删除${config.label}选项「${item.option_value}」吗？`, '删除选项确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    })
    await deleteOrderOption(item.id)
    list.value = list.value.filter(option => option.id !== item.id)
    clearDeletedOption(type, item.option_value)
    ElMessage.success('选项已删除')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') {
      ElMessage.error(err.message || '删除选项失败')
    }
  }
}

function clearDeletedOption(type, value) {
  if (!value) return
  if (type === 'paymentPlatform') {
    if (form.paymentPlatform === value) form.paymentPlatform = ''
    if (activeTab.value === 'foreign' && query.platform === value) query.platform = ''
  }
  if (type === 'domesticPlatform') {
    if (form.domesticPlatform === value) form.domesticPlatform = ''
    if (activeTab.value === 'domestic' && query.platform === value) query.platform = ''
  }
  if (type === 'courier') {
    if (form.courier === value) form.courier = ''
    if (query.courier === value) query.courier = ''
  }
  fetchOrders()
}

async function handlePlatformFilterChange(value) {
  const type = platformOptionType()
  const ok = await rememberOption(type, value)
  if (!ok) {
    query.platform = ''
    return
  }
  searchOrders()
}

async function handleCourierFilterChange(value) {
  const ok = await rememberOption('courier', value)
  if (!ok) {
    query.courier = ''
    return
  }
  searchOrders()
}

function currentDateTimeValue() {
  return dateTimeOffsetValue(0)
}

function dateOffsetValue(days, base = new Date()) {
  return formatLocalDate(offsetDate(base, days))
}

function dateTimeOffsetValue(days, base = new Date()) {
  return formatLocalDateTime(offsetDate(base, days))
}

function offsetDate(base, days) {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

function formatLocalDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatLocalDateTime(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) {
    const text = String(value || '').trim()
    return text.length === 10 ? `${text} 00:00:00` : text.slice(0, 19)
  }
  const pad = (n) => String(n).padStart(2, '0')
  return `${formatLocalDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function initTotalRange() {
  totalRange.to = dateOffsetValue(0)
  totalRange.from = dateOffsetValue(-30)
}

function displayId(row) {
  const raw = parseRawPayload(row.raw_payload)
  return raw.legacy_id || row.order_no || String(row.id || '').slice(0, 8)
}

function parseRawPayload(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

function legacyRow(row) {
  return parseRawPayload(row.raw_payload).legacy_row || {}
}

function orderScope(row) {
  return parseRawPayload(row.raw_payload).order_scope === 'domestic' ? 'domestic' : 'foreign'
}

function displayAddress(row) {
  const legacy = legacyRow(row)
  const address = legacy.address ?? row.customer_address ?? ''
  const detailed = legacy.detailed_address ?? row.detailed_address ?? ''
  return address && address !== detailed ? address : ''
}

function displayDetailedAddress(row) {
  const legacy = legacyRow(row)
  return legacy.detailed_address ?? row.detailed_address ?? ''
}

function displayPlatform(row) {
  return activeTab.value === 'domestic'
    ? (parseRawPayload(row.raw_payload).domestic_platform || '')
    : (row.payment_platform || '')
}

function displayProductionBatch(row) {
  const legacy = legacyRow(row)
  return row.production_batch || legacy.production_batch || legacy.batch || ''
}

function statusLabel(value) {
  return statusOptions.find(item => item.value === value)?.label || value || '-'
}

function statusTag(value) {
  return {
    draft: 'info',
    confirmed: 'primary',
    paid: 'success',
    purchasing: 'warning',
    domestic_shipping: 'warning',
    international_shipping: 'warning',
    delivered: 'success',
    after_sales: 'danger',
    closed: 'info',
    cancelled: 'info'
  }[value] || 'info'
}

function marketingAmount(row) {
  if (row.marketing_amount !== null && row.marketing_amount !== undefined) return row.marketing_amount
  const deal = Number(row.deal_amount)
  const cost = Number(row.cost_amount)
  if (!Number.isFinite(deal) || !Number.isFinite(cost)) return null
  return Number((deal - cost).toFixed(2))
}

function money(value) {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : ''
}

function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10)
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(d.getFullYear()).slice(2)}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
}

function resetForm(data = {}) {
  applyingForm.value = true
  Object.assign(form, emptyForm(), data)
  queueMicrotask(() => { applyingForm.value = false })
}

async function fetchOrders() {
  loading.value = true
  try {
    const res = await getOrders({
      keyword: query.keyword,
      status: query.status,
      payment_status: query.payment_status,
      payment_platform: activeTab.value === 'foreign' ? query.platform : '',
      domestic_platform: activeTab.value === 'domestic' ? query.platform : '',
      courier: query.courier,
      order_scope: activeTab.value,
      date_type: query.date_type,
      start_date: query.dateRange?.[0] || '',
      end_date: query.dateRange?.[1] || '',
      limit: pagination.pageSize,
      offset: (pagination.page - 1) * pagination.pageSize
    })
    orders.value = res.data?.list || []
    pagination.total = Number(res.data?.total || 0)
  } finally {
    loading.value = false
  }
}

function searchOrders() {
  pagination.page = 1
  fetchOrders()
}

function handlePageSizeChange() {
  pagination.page = 1
  fetchOrders()
}

function handleTabChange() {
  pagination.page = 1
  query.platform = ''
  totalText.value = ''
  fetchOrders()
}

function resetFilters() {
  Object.assign(query, {
    keyword: '',
    status: '',
    payment_status: '',
    platform: '',
    courier: '',
    date_type: 'purchase',
    dateRange: []
  })
  totalText.value = ''
  searchOrders()
}

function openCreate() {
  editingId.value = ''
  attachments.value = []
  resetForm()
  drawerVisible.value = true
}

function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
}

async function openEdit(row) {
  editingId.value = row.id
  const res = await getOrder(row.id)
  const data = res.data || row
  attachments.value = data.attachments || []
  const firstItem = data.items?.[0] || {}
  const domestic = data.shipments?.find(item => item.shipment_type === 'domestic') || {}
  const international = data.shipments?.find(item => item.shipment_type !== 'domestic') || {}
  const legacy = legacyRow(data)
  const scope = orderScope(data)
  const primaryShipment = scope === 'domestic' ? domestic : international
  activeTab.value = scope
  resetForm({
    channelUserId: data.channel_user_id || '',
    customerName: data.customer_name || '',
    paymentPlatform: data.payment_platform || '',
    domesticPlatform: parseRawPayload(data.raw_payload).domestic_platform || '',
    productionBatch: data.production_batch || legacy.production_batch || legacy.batch || '',
    purchaseAmount: firstItem.description || firstItem.product_name || data.purchase_amount || '',
    customerAddress: legacy.address ?? data.customer_address ?? '',
    domesticTracking: domestic.tracking_no || '',
    internationalTracking: international.tracking_no || '',
    purchaseTime: data.purchase_time ? formatLocalDateTime(data.purchase_time) : '',
    expectedArrivalAt: primaryShipment.expected_arrival_at ? formatLocalDateTime(primaryShipment.expected_arrival_at) : '',
    arrivedAt: primaryShipment.arrived_at ? formatLocalDateTime(primaryShipment.arrived_at) : '',
    courier: international.courier || domestic.courier || '',
    dealAmount: data.deal_amount === null || data.deal_amount === undefined ? null : Number(data.deal_amount),
    freightFeeRmb: data.freight_fee_rmb === null || data.freight_fee_rmb === undefined ? null : Number(data.freight_fee_rmb),
    costAmount: data.cost_amount === null || data.cost_amount === undefined ? null : Number(data.cost_amount),
    notes: data.notes || '',
    detailedAddress: legacy.detailed_address ?? international.address_detail ?? '',
    status: data.status || inferStatus(data),
    paymentStatus: data.payment_status || inferPaymentStatus(data),
    currency: data.currency || 'USD',
    rawPayload: parseRawPayload(data.raw_payload)
  })
  drawerVisible.value = true
}

function inferStatus(data = form) {
  if (data.arrivedAt || data.arrival_time) return 'delivered'
  if (data.internationalTracking || data.international_tracking) return 'international_shipping'
  if (data.domesticTracking || data.domestic_tracking) return 'domestic_shipping'
  if (Number(data.dealAmount ?? data.deal_amount) > 0) return 'confirmed'
  return 'draft'
}

function inferPaymentStatus(data = form) {
  return Number(data.dealAmount ?? data.deal_amount) > 0 ? 'paid' : 'unpaid'
}

function buildOrderPayload() {
  const itemText = String(form.purchaseAmount || '').trim()
  const items = itemText
    ? [{
        description: itemText,
        productName: itemText,
        quantity: 1,
        unitPrice: Number(form.dealAmount || 0),
        currency: form.currency
      }]
    : []
  const shipments = []
  if (
    form.domesticTracking ||
    form.courier ||
    (activeTab.value === 'domestic' && (form.expectedArrivalAt || form.arrivedAt || form.freightFeeRmb !== null))
  ) {
    shipments.push({
      shipmentType: 'domestic',
      courier: form.courier,
      trackingNo: form.domesticTracking,
      expectedArrivalAt: activeTab.value === 'domestic' ? form.expectedArrivalAt : '',
      arrivedAt: activeTab.value === 'domestic' ? form.arrivedAt : '',
      freightFee: activeTab.value === 'domestic' ? form.freightFeeRmb : null,
      status: form.arrivedAt ? 'delivered' : (form.domesticTracking ? 'shipped' : 'pending')
    })
  }
  if (activeTab.value === 'foreign' && (form.internationalTracking || form.courier || form.expectedArrivalAt || form.arrivedAt || form.detailedAddress || form.freightFeeRmb !== null)) {
    shipments.push({
      shipmentType: 'international',
      courier: form.courier,
      trackingNo: form.internationalTracking,
      expectedArrivalAt: form.expectedArrivalAt,
      arrivedAt: form.arrivedAt,
      recipientName: form.customerName,
      addressDetail: form.detailedAddress,
      freightFee: form.freightFeeRmb,
      status: form.arrivedAt ? 'delivered' : (form.internationalTracking ? 'shipped' : 'pending')
    })
  }
  return {
    channelUserId: form.channelUserId,
    customerName: form.customerName,
    customerAddress: form.customerAddress,
    status: form.status || inferStatus(),
    paymentStatus: form.paymentStatus || inferPaymentStatus(),
    paymentPlatform: form.paymentPlatform,
    productionBatch: form.productionBatch,
    currency: form.currency,
    dealAmount: form.dealAmount,
    costAmount: form.costAmount,
    freightFeeRmb: form.freightFeeRmb,
    marketingAmount: formMarketingAmount.value,
    purchaseTime: form.purchaseTime,
    notes: form.notes,
    rawPayload: {
      ...(form.rawPayload || {}),
      order_scope: activeTab.value,
      domestic_platform: activeTab.value === 'domestic' ? form.domesticPlatform : undefined
    },
    items,
    shipments
  }
}

function fileSize(size) {
  const n = Number(size || 0)
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function calcTotal() {
  const [fromValue, toValue] = query.dateRange || []
  if (!fromValue || !toValue) {
    ElMessage.warning('请选择起始和结束日期')
    return
  }
  const from = new Date(fromValue)
  const to = new Date(toValue)
  to.setHours(23, 59, 59, 999)
  let count = 0
  let dealTotal = 0
  let marketingTotal = 0
  orders.value.forEach((row) => {
    const value = {
      purchase: row.purchase_time,
      expected_arrival: row.expected_arrival,
      arrival: row.arrival_time
    }[query.date_type] || row.purchase_time
    const date = value ? new Date(value) : null
    if (!date || date < from || date > to) return
    count += 1
    dealTotal += Number(row.deal_amount || 0)
    marketingTotal += Number(marketingAmount(row) || 0)
  })
  totalText.value = count
    ? `${count}笔 | 成交额: ${dealTotal.toFixed(2)} | 营销额: ${marketingTotal.toFixed(2)}`
    : '所选日期暂无订单'
}

async function copyText(text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(String(text))
    ElMessage.success(`已复制: ${text}`)
  } catch {
    ElMessage.error('复制失败')
  }
}

async function refreshEditingOrder() {
  if (!editingId.value) return
  const res = await getOrder(editingId.value)
  attachments.value = res.data?.attachments || []
}

async function submitOrder() {
  saving.value = true
  try {
    const payload = buildOrderPayload()
    if (editingId.value) {
      await updateOrder(editingId.value, payload)
      ElMessage.success('订单已更新')
    } else {
      await createOrder(payload)
      ElMessage.success('订单已创建')
    }
    drawerVisible.value = false
    await fetchOrders()
  } finally {
    saving.value = false
  }
}

async function generateOrderInvoice(row) {
  if (orderScope(row) === 'domestic') {
    ElMessage.warning('国内订单不生成 PI')
    return
  }
  if (Number(row.item_count || 0) <= 0) {
    ElMessage.warning('请先编辑订单添加商品明细后再生成 PI')
    return
  }
  if (invoiceGeneratingId.value) return
  const previewWindow = window.open('', '_blank')
  invoiceGeneratingId.value = row.id
  try {
    const res = await generateInvoice({ orderId: row.id })
    ElMessage.success(`PI ${res.data?.invoiceNo || ''} 已生成`)
    if (res.data?.publicUrl) {
      if (previewWindow) {
        previewWindow.location.href = resolveAssetUrl(res.data.publicUrl)
      } else {
        window.open(resolveAssetUrl(res.data.publicUrl), '_blank', 'noopener,noreferrer')
      }
    } else if (previewWindow) {
      previewWindow.close()
    }
  } catch (err) {
    if (previewWindow) previewWindow.close()
    throw err
  } finally {
    invoiceGeneratingId.value = ''
  }
}

async function handleDeleteOrder(row) {
  try {
    await ElMessageBox.confirm(`确认删除订单 ${row.order_no || displayId(row)} 吗？此操作会删除订单明细和附件记录。`, '删除订单确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    })
    await deleteOrder(row.id)
    if (editingId.value === row.id) {
      drawerVisible.value = false
      editingId.value = ''
    }
    ElMessage.success('订单已删除')
    await fetchOrders()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.message || '删除订单失败')
  }
}

async function uploadAttachmentRequest(options) {
  if (!editingId.value) {
    options.onError?.(new Error('请先保存订单'))
    return
  }
  const formData = new FormData()
  formData.append('files', options.file)
  try {
    await uploadOrderAttachments(editingId.value, formData)
    options.onSuccess?.()
    ElMessage.success('附件已上传')
    await refreshEditingOrder()
  } catch (err) {
    options.onError?.(err)
    ElMessage.error(err.message || '附件上传失败')
  }
}

async function handleDeleteAttachment(file) {
  try {
    await ElMessageBox.confirm(`确认删除附件「${file.original_name}」吗？`, '删除附件确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
      confirmButtonClass: 'el-button--danger'
    })
    await deleteOrderAttachment(editingId.value, file.id)
    ElMessage.success('附件已删除')
    await refreshEditingOrder()
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error(err.message || '删除附件失败')
  }
}

function openFile(url) {
  if (url) window.open(resolveAssetUrl(url), '_blank', 'noopener,noreferrer')
}
</script>

<style scoped lang="scss">
.orders-view {
  height: 100%;
  padding: 16px 18px;
  background: #f5f7fa;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  &--fullscreen {
    position: fixed;
    inset: 0;
    z-index: 2000;
    height: 100vh;
    padding: 10px 12px;
    background: #f5f7fa;
  }

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;

    h1 {
      margin: 0;
      font-size: 20px;
      color: #1e293b;
      font-weight: 700;
    }

    p {
      margin: 4px 0 0;
      color: #64748b;
      font-size: 13px;
    }
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  flex-shrink: 0;

  > .el-input {
    width: 320px;
    flex: 0 0 320px;
  }

  > .el-select {
    width: 126px;
    flex: 0 0 126px;
  }

  :deep(.el-date-editor.el-input) {
    width: 150px;
    min-width: 150px;
    flex: 0 0 150px;
  }

  :deep(.el-date-editor--daterange) {
    width: 250px;
    min-width: 250px;
    flex: 0 0 250px;
  }

  .el-button {
    flex: 0 0 auto;
  }

  &__total {
    color: #166534;
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
    flex: 1 1 220px;
    min-width: 220px;
  }
}

.orders-table {
  flex: 1;
  min-height: 0;

  :deep(.cell) {
    min-width: 0;
  }

  :deep(.el-table__header-wrapper th.el-table__cell),
  :deep(.el-table__fixed-header-wrapper th.el-table__cell),
  :deep(.el-table__fixed-right .el-table__header-wrapper th.el-table__cell) {
    background: #eef3f8 !important;
    color: #334155;
    font-weight: 700;
    border-color: #d7dee8;
  }

  :deep(.el-table__header-wrapper th.el-table__cell .cell),
  :deep(.el-table__fixed-header-wrapper th.el-table__cell .cell),
  :deep(.el-table__fixed-right .el-table__header-wrapper th.el-table__cell .cell) {
    color: #334155;
    letter-spacing: 0;
  }
}

.orders-view--fullscreen {
  .orders-table {
    font-size: 12px;

    :deep(.el-table__cell) {
      padding: 3px 0;
    }

    :deep(.cell) {
      padding: 0 4px;
      line-height: 1.3;
    }
  }

  .operation-actions {
    gap: 6px;

    :deep(.el-button) {
      font-size: 12px;

      .el-icon {
        margin-right: 2px;
      }
    }
  }
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  padding-top: 10px;
}

.cell-link {
  max-width: 100%;
  min-width: 0;
  padding: 0;

  :deep(span) {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.operation-actions {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  white-space: nowrap;

  :deep(.el-button) {
    margin-left: 0;
    padding: 0;
  }
}

:global(.order-drawer) {
  max-width: calc(100vw - 32px);
}

:global(.order-drawer .el-drawer__header) {
  margin-bottom: 0;
  padding: 12px 16px 8px;
}

:global(.order-drawer .el-drawer__body) {
  padding: 10px 16px 0;
}

:global(.order-drawer .el-drawer__footer) {
  padding: 8px 16px 12px;
}

.order-form {
  :deep(.el-form-item) {
    margin-bottom: 8px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 12px;

    &__full {
      grid-column: 1 / -1;
    }

    &--notes {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  :deep(.el-select),
  :deep(.el-input-number),
  :deep(.el-date-editor.el-input) {
    width: 100%;
  }

  :deep(.el-input__wrapper),
  :deep(.el-select__wrapper) {
    min-height: 30px;
  }

  :deep(.el-input-number .el-input__wrapper) {
    padding-left: 8px;
    padding-right: 28px;
  }

  &__full {
    margin-bottom: 8px;

    :deep(.el-form-item__content) {
      max-width: 100%;
    }
  }
}

.section-title {
  margin: 8px 0 8px;
  padding-top: 8px;
  border-top: 1px solid #e2e8f0;
  color: #475569;
  font-weight: 600;
  font-size: 13px;

  &--first {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }
}

.option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .el-button {
    width: 22px;
    height: 22px;
    padding: 0;
    opacity: 0.7;

    &:hover {
      opacity: 1;
    }
  }
}

.attachment-panel {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding-bottom: 8px;
}

.attachment-upload {
  width: 100%;

  :deep(.el-upload),
  :deep(.el-upload-dragger) {
    width: 100%;
  }

  :deep(.el-upload-dragger) {
    min-height: 66px;
    padding: 10px;
  }

  :deep(.el-icon) {
    margin-bottom: 2px;
    font-size: 20px;
  }

  :deep(.el-upload__text) {
    font-size: 12px;
    line-height: 1.3;
  }
}

.attachment-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  max-height: 112px;
  margin-top: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.attachment-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;

  &__info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__name {
    color: #1e293b;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__meta {
    color: #94a3b8;
    font-size: 11px;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
}

.attachment-empty {
  height: 66px;
  padding: 0;

  :deep(.el-empty__image) {
    width: 40px;
  }

  :deep(.el-empty__description) {
    margin-top: 4px;
  }
}

@media (max-width: 960px) {
  .order-form .form-grid {
    grid-template-columns: 1fr;
  }

  .order-form .form-grid__full,
  .order-form .form-grid--notes {
    grid-column: span 1;
    grid-template-columns: 1fr;
  }

  .attachment-panel,
  .attachment-list {
    grid-template-columns: 1fr;
  }

  .toolbar {
    > .el-input,
    > .el-select,
    :deep(.el-date-editor--daterange),
    :deep(.el-date-editor.el-input) {
      width: 100%;
      min-width: 0;
      flex-basis: 100%;
    }

    .el-button {
      flex: 1 1 calc(50% - 5px);
    }

    &__total {
      flex-basis: 100%;
      min-width: 0;
    }
  }

  .orders-view {
    overflow: auto;
  }
}
</style>
