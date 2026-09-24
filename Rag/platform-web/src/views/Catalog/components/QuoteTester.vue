<template>
  <div class="quote-tester">
    <el-alert title="该工具只查询已发布版本，用于上线前核对正式报价规则。" type="info" :closable="false" />
    <el-form :inline="true" class="quote-form">
      <el-form-item label="SKU"><el-input v-model="form.skuCode" placeholder="COATING-1KG" /></el-form-item>
      <el-form-item label="数量"><el-input-number v-model="form.quantity" :min="0.001" :precision="3" /></el-form-item>
      <el-form-item label="客户类型"><el-select v-model="form.customerType" style="width: 120px"><el-option label="零售" value="retail"/><el-option label="批发" value="wholesale"/></el-select></el-form-item>
      <el-form-item label="币种"><el-input v-model="form.currency" style="width: 90px" /></el-form-item>
      <el-form-item label="国家/区域"><el-input v-model="form.regionCode" placeholder="可选，如 US" /></el-form-item>
      <el-form-item label="交付方式">
        <el-select v-model="form.deliveryTerm" style="width: 110px">
          <el-option label="其他" value="OTHER" />
          <el-option label="DDU" value="DDU" />
          <el-option label="DDP" value="DDP" />
        </el-select>
      </el-form-item>
      <el-form-item label="重量(kg)"><el-input-number v-model="form.weightKg" :min="0.001" :precision="3" /></el-form-item>
      <el-form-item><el-button type="primary" :loading="loading" @click="submit">查询正式报价</el-button></el-form-item>
    </el-form>

    <el-descriptions v-if="result" :column="2" border>
      <el-descriptions-item label="结果"><el-tag :type="result.status === 'quoted' ? 'success' : 'warning'">{{ quoteStatusText(result.status) }}</el-tag></el-descriptions-item>
      <el-descriptions-item label="需人工原因">{{ result.reason || '-' }}</el-descriptions-item>
      <el-descriptions-item label="目录版本">{{ result.versionId || '-' }}</el-descriptions-item>
      <el-descriptions-item label="价格规则 ID">{{ result.priceRuleId || '-' }}</el-descriptions-item>
      <el-descriptions-item label="运费规则 ID">{{ result.freightRuleId || '-' }}</el-descriptions-item>
      <el-descriptions-item label="单价">{{ amount(result.unitPrice, result.currency) }}</el-descriptions-item>
      <el-descriptions-item label="商品金额">{{ amount(result.goodsAmount, result.currency) }}</el-descriptions-item>
      <el-descriptions-item label="运费">{{ amount(result.freightAmount, result.currency) }}</el-descriptions-item>
      <el-descriptions-item label="总金额">{{ amount(result.totalAmount, result.currency) }}</el-descriptions-item>
    </el-descriptions>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { resolveQuote } from '@/api/catalog'

const loading = ref(false)
const result = ref(null)
const form = reactive({ skuCode: '', quantity: 1, currency: 'USD', customerType: 'retail', regionCode: '', deliveryTerm: 'OTHER', weightKg: null })
const amount = (value, currency) => value == null ? '-' : `${currency || ''} ${Number(value).toFixed(2)}`
const quoteStatusText = status => ({ quoted: '已报价 (quoted)', manual_confirmation: '需人工确认 (manual_confirmation)' }[status] || status)

async function submit() {
  if (!form.skuCode.trim() || !(Number(form.quantity) > 0)) return ElMessage.warning('请填写 SKU 和数量')
  loading.value = true
  try {
    const response = await resolveQuote({ ...form, skuCode: form.skuCode.trim().toUpperCase(), currency: form.currency.trim().toUpperCase(), regionCode: form.regionCode.trim().toUpperCase() || null })
    result.value = response.data
  } finally { loading.value = false }
}
</script>

<style scoped>
.quote-tester { display: grid; gap: 18px; }
.quote-form { padding: 16px 0 0; }
</style>
