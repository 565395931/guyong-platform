<template>
  <div class="catalog-panel">
    <div class="panel-header">
      <strong>产品</strong>
      <el-button type="primary" :disabled="!editable" @click="openProduct()">新增产品</el-button>
    </div>
    <el-table v-loading="loading" :data="products" border>
      <el-table-column label="产品图" width="96">
        <template #default="{ row }">
          <el-image
            v-if="row.image_url"
            :src="resolveAssetUrl(row.image_url)"
            :preview-src-list="[resolveAssetUrl(row.image_url)]"
            fit="cover"
            class="product-thumbnail"
          />
          <span v-else class="muted">-</span>
        </template>
      </el-table-column>
      <el-table-column prop="product_code" label="产品编码" min-width="150" />
      <el-table-column prop="name" label="名称" min-width="180" />
      <el-table-column prop="description" label="说明" min-width="240" show-overflow-tooltip />
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ statusText(row.status) }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }"><el-button link type="primary" :disabled="!editable" @click="openProduct(row)">编辑</el-button></template>
      </el-table-column>
    </el-table>

    <div class="panel-header panel-header--second">
      <strong>SKU</strong>
      <el-button type="primary" :disabled="!editable" @click="openSku()">新增 SKU</el-button>
    </div>
    <el-table v-loading="loading" :data="skus" border>
      <el-table-column prop="sku_code" label="SKU" min-width="150" />
      <el-table-column prop="product_code" label="产品编码" min-width="140" />
      <el-table-column prop="specification" label="规格" min-width="140" />
      <el-table-column prop="packaging" label="包装" min-width="130" />
      <el-table-column prop="weight_kg" label="重量(kg)" width="110" />
      <el-table-column label="覆盖面积(㎡)" width="140">
        <template #default="{ row }">{{ rangeText(row.coverage_min_sqm, row.coverage_max_sqm) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ statusText(row.status) }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }"><el-button link type="primary" :disabled="!editable" @click="openSku(row)">编辑</el-button></template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="productVisible" title="产品" width="560px">
      <el-form label-width="90px">
        <el-form-item label="产品编码"><el-input v-model="productForm.productCode" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="productForm.name" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="productForm.description" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="productForm.status"><el-option label="启用" value="active"/><el-option label="停用" value="inactive"/></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="productVisible = false">取消</el-button><el-button type="primary" @click="submitProduct">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="skuVisible" title="SKU" width="620px">
      <el-form label-width="110px">
        <el-form-item label="所属产品"><el-select v-model="skuForm.productCode" filterable><el-option v-for="item in products" :key="item.product_code" :label="`${item.name} (${item.product_code})`" :value="item.product_code" /></el-select></el-form-item>
        <el-form-item label="SKU 编码"><el-input v-model="skuForm.skuCode" /></el-form-item>
        <el-form-item label="规格"><el-input v-model="skuForm.specification" /></el-form-item>
        <el-form-item label="包装"><el-input v-model="skuForm.packaging" /></el-form-item>
        <el-form-item label="重量(kg)"><el-input-number v-model="skuForm.weightKg" :min="0.001" :precision="3" /></el-form-item>
        <el-form-item label="覆盖面积"><el-input-number v-model="skuForm.coverageMinSqm" :min="0.01" /> 至 <el-input-number v-model="skuForm.coverageMaxSqm" :min="0.01" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="skuForm.status"><el-option label="启用" value="active"/><el-option label="停用" value="inactive"/></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="skuVisible = false">取消</el-button><el-button type="primary" @click="submitSku">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getProducts, getSkus, saveProduct, saveSku } from '@/api/catalog'
import { normalizeProductForm, normalizeSkuForm } from '@/modules/catalog/catalogForm'
import { resolveAssetUrl } from '@/utils/runtimeConfig'

const props = defineProps({ version: { type: Object, required: true } })
const editable = computed(() => props.version.status === 'draft')
const loading = ref(false)
const products = ref([])
const skus = ref([])
const productVisible = ref(false)
const skuVisible = ref(false)
const productForm = reactive({ id: undefined, productCode: '', name: '', description: '', status: 'active' })
const skuForm = reactive({ id: undefined, productCode: '', skuCode: '', specification: '', packaging: '', weightKg: null, coverageMinSqm: null, coverageMaxSqm: null, status: 'active' })

const rangeText = (min, max) => min == null && max == null ? '-' : [min, max].filter(value => value != null).join(' - ')
const statusText = status => ({ active: '启用', inactive: '停用' }[status] || status)

async function load() {
  loading.value = true
  try {
    const [productResponse, skuResponse] = await Promise.all([getProducts(props.version.id), getSkus(props.version.id)])
    products.value = productResponse.data || []
    skus.value = skuResponse.data || []
  } finally { loading.value = false }
}

function openProduct(row = null) {
  Object.assign(productForm, normalizeProductForm(row || {}))
  productVisible.value = true
}

function openSku(row = null) {
  Object.assign(skuForm, normalizeSkuForm(row || { productCode: products.value[0]?.product_code || '' }))
  skuVisible.value = true
}

async function submitProduct() {
  const payload = normalizeProductForm(productForm)
  if (!payload.productCode || !payload.name) return ElMessage.error('产品编码和名称不能为空')
  await saveProduct(props.version.id, payload)
  productVisible.value = false
  ElMessage.success('产品已保存')
  await load()
}

async function submitSku() {
  const payload = normalizeSkuForm(skuForm)
  if (!payload.productCode || !payload.skuCode) return ElMessage.error('所属产品和 SKU 编码不能为空')
  await saveSku(props.version.id, payload)
  skuVisible.value = false
  ElMessage.success('SKU 已保存')
  await load()
}

onMounted(load)
</script>

<style scoped>
.catalog-panel { display: grid; gap: 12px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; }
.panel-header--second { margin-top: 16px; }
.product-thumbnail { width: 64px; height: 64px; border-radius: 4px; border: 1px solid #e2e8f0; }
.muted { color: #94a3b8; }
</style>
