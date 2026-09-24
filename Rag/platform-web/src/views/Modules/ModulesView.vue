<template>
  <div class="modules-view">
    <div class="modules-view__header">
      <div>
        <h1>功能模块</h1>
        <p>平台辅助工具集合</p>
      </div>
      <el-button :icon="Refresh" @click="fetchInvoices">刷新</el-button>
    </div>

    <div class="tools-layout">
      <div class="tool-nav">
        <button
          v-for="tool in tools"
          :key="tool.key"
          class="tool-nav__item"
          :class="{ 'is-active': activeTool === tool.key }"
          @click="activeTool = tool.key"
        >
          <el-icon><component :is="tool.icon" /></el-icon>
          <span>{{ tool.name }}</span>
        </button>
      </div>

      <div v-if="activeTool === 'invoice'" class="invoice-tool">
        <div class="invoice-tool__left">
          <h2>PI 发票工具</h2>
        <el-form label-width="90px">
          <el-form-item label="订单 ID/号">
            <el-input v-model="invoiceOrderId" placeholder="可填写订单 ID 或订单号，如 SO202607181304459DD6" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :icon="Document" :loading="invoiceLoading" @click="generateInvoiceById">
              从订单生成 PI
            </el-button>
          </el-form-item>
        </el-form>

        <div class="section-title">空白生成</div>
        <el-input
          v-model="invoiceJson"
          type="textarea"
          :rows="22"
          spellcheck="false"
          class="json-editor"
        />
        <div class="invoice-tool__footer">
          <el-button :icon="Refresh" @click="resetInvoiceJson">重置示例</el-button>
          <el-button type="primary" :icon="Document" :loading="invoiceLoading" @click="generateStandaloneInvoice">
            生成 PI
          </el-button>
        </div>
        </div>

        <div class="invoice-tool__right">
          <h2>最近生成</h2>
          <el-table :data="invoices" height="calc(100vh - 210px)" border>
            <el-table-column prop="invoice_no" label="PI 编号" width="140" />
            <el-table-column prop="order_no" label="订单号" width="160" />
            <el-table-column prop="customer_name" label="客户" min-width="120" />
            <el-table-column label="金额" width="120" align="right">
              <template #default="{ row }">{{ money(row.total_amount) }} {{ row.currency || 'USD' }}</template>
            </el-table-column>
            <el-table-column label="文件" width="90">
              <template #default="{ row }">
                <el-button v-if="row.public_url" link type="primary" @click="openFile(row.public_url)">打开</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { resolveAssetUrl } from '@/utils/runtimeConfig'
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, Refresh } from '@element-plus/icons-vue'
import { generateInvoice, getInvoices } from '@/api/orders'

const activeTool = ref('invoice')
const invoiceLoading = ref(false)
const invoiceOrderId = ref('')
const invoices = ref([])

const tools = [
  { key: 'invoice', name: 'PI 发票', icon: Document }
]

const invoiceSample = {
  invoice_date: new Date().toISOString().slice(0, 10),
  currency: 'USD',
  shipping: 60,
  receiver: {
    type: '',
    name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    country: ''
  },
  products: [
    { description: 'Heat Insulation Material | 250ml', qty: 1, unit_value: 50 }
  ]
}

const invoiceJson = ref(JSON.stringify(invoiceSample, null, 2))

onMounted(fetchInvoices)

function money(value) {
  const n = Number(value || 0)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

async function fetchInvoices() {
  const res = await getInvoices({ limit: 50 })
  invoices.value = res.data?.list || []
}

async function generateInvoiceById() {
  if (!invoiceOrderId.value.trim()) {
    ElMessage.warning('请填写订单 ID 或订单号')
    return
  }
  invoiceLoading.value = true
  try {
    const res = await generateInvoice({ orderId: invoiceOrderId.value.trim() })
    await fetchInvoices()
    ElMessage.success(`PI ${res.data?.invoiceNo || ''} 已生成`)
    if (res.data?.publicUrl) openFile(res.data.publicUrl)
  } finally {
    invoiceLoading.value = false
  }
}

async function generateStandaloneInvoice() {
  let data
  try {
    data = JSON.parse(invoiceJson.value)
  } catch {
    ElMessage.warning('JSON 格式不正确')
    return
  }
  invoiceLoading.value = true
  try {
    const res = await generateInvoice(data)
    await fetchInvoices()
    ElMessage.success(`PI ${res.data?.invoiceNo || ''} 已生成`)
    if (res.data?.publicUrl) openFile(res.data.publicUrl)
  } finally {
    invoiceLoading.value = false
  }
}

function resetInvoiceJson() {
  invoiceJson.value = JSON.stringify(invoiceSample, null, 2)
}

function openFile(url) {
  window.open(resolveAssetUrl(url), '_blank', 'noopener,noreferrer')
}
</script>

<style scoped lang="scss">
.modules-view {
  height: 100%;
  padding: 16px 18px;
  background: #f5f7fa;
  overflow: hidden;

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
}

.tools-layout {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  gap: 16px;
  height: calc(100vh - 130px);
}

.tool-nav {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px;
  overflow: auto;

  &__item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 40px;
    padding: 0 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #475569;
    cursor: pointer;
    text-align: left;
    font-size: 13px;

    &:hover {
      background: #f1f5f9;
    }

    &.is-active {
      background: #eff6ff;
      color: #2563eb;
      font-weight: 600;
    }
  }
}

.invoice-tool {
  display: grid;
  grid-template-columns: minmax(420px, 1fr) minmax(360px, 0.85fr);
  gap: 16px;
  min-width: 0;

  &__left,
  &__right {
    min-width: 0;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 14px;
    overflow: auto;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    color: #1e293b;
  }

  &__footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
}

.section-title {
  margin: 8px 0 12px;
  padding-top: 10px;
  border-top: 1px solid #e2e8f0;
  color: #475569;
  font-weight: 600;
  font-size: 13px;
}

.json-editor {
  :deep(textarea) {
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
}

@media (max-width: 960px) {
  .tools-layout,
  .invoice-tool {
    grid-template-columns: 1fr;
    height: auto;
  }

  .modules-view {
    overflow: auto;
  }
}
</style>
