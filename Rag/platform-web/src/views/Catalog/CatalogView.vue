<template>
  <div class="catalog-view">
    <el-alert
      title="已发布版本用于 AI 正式报价；草稿修改不会影响线上回复。"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="catalog-toolbar">
      <div class="catalog-toolbar__left">
        <span class="catalog-toolbar__title">产品与报价</span>
        <el-select v-model="versionId" placeholder="请选择目录版本" style="width: 260px">
          <el-option
            v-for="item in versions"
            :key="item.id"
            :label="`${item.version_no} · ${statusLabel(item.status)}`"
            :value="item.id"
          />
        </el-select>
        <el-tag v-if="selectedVersion" :type="selectedVersion.status === 'published' ? 'success' : 'warning'">
          {{ statusLabel(selectedVersion.status) }}
        </el-tag>
      </div>
      <div class="catalog-toolbar__right">
        <el-button :loading="loading" @click="loadVersions">刷新</el-button>
        <el-button v-if="canManage" @click="createDraft">新建草稿</el-button>
        <el-button v-if="canManage" @click="importVisible = true">导入文件</el-button>
        <el-button
          v-if="canManage && selectedVersion?.status === 'draft'"
          type="primary"
          @click="publish"
        >
          发布版本
        </el-button>
      </div>
    </div>

    <el-empty v-if="!loading && !selectedVersion" description="暂无目录版本，请先新建草稿或导入文件" />

    <el-tabs v-else-if="selectedVersion" v-model="activeTab" class="catalog-tabs">
      <el-tab-pane label="产品与 SKU" name="products">
        <ProductSkuPanel :key="`product-${reloadKey}`" :version="selectedVersion" />
      </el-tab-pane>
      <el-tab-pane label="价格规则" name="prices">
        <PriceRulePanel :key="`price-${reloadKey}`" :version="selectedVersion" />
      </el-tab-pane>
      <el-tab-pane label="运费规则" name="freight">
        <FreightRulePanel :key="`freight-${reloadKey}`" :version="selectedVersion" />
      </el-tab-pane>
      <el-tab-pane label="报价校验" name="quote">
        <QuoteTester />
      </el-tab-pane>
    </el-tabs>

    <ImportPreviewDialog v-model="importVisible" @committed="handleImported" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createCatalogDraft,
  getCatalogVersions,
  publishCatalogVersion
} from '@/api/catalog'
import { useUserStore } from '@/stores/user'
import ProductSkuPanel from './components/ProductSkuPanel.vue'
import PriceRulePanel from './components/PriceRulePanel.vue'
import FreightRulePanel from './components/FreightRulePanel.vue'
import ImportPreviewDialog from './components/ImportPreviewDialog.vue'
import QuoteTester from './components/QuoteTester.vue'

const userStore = useUserStore()
const versions = ref([])
const versionId = ref('')
const loading = ref(false)
const activeTab = ref('products')
const importVisible = ref(false)
const reloadKey = ref(0)

const canManage = computed(() => ['admin', 'supervisor'].includes(userStore.userInfo?.role))
const selectedVersion = computed(() => versions.value.find(item => item.id === versionId.value) || null)

const statusLabel = status => ({ draft: '草稿', published: '已发布', retired: '历史版本' }[status] || status)

async function loadVersions(preferredId = '') {
  loading.value = true
  try {
    const response = await getCatalogVersions()
    versions.value = response.data || []
    versionId.value = preferredId && versions.value.some(item => item.id === preferredId)
      ? preferredId
      : versions.value.find(item => item.status === 'draft')?.id
        || versions.value.find(item => item.status === 'published')?.id
        || versions.value[0]?.id
        || ''
    reloadKey.value += 1
  } finally {
    loading.value = false
  }
}

async function createDraft() {
  const response = await createCatalogDraft()
  ElMessage.success('草稿版本已创建')
  await loadVersions(response.data.id)
}

async function publish() {
  await ElMessageBox.confirm(
    '发布后，精确报价接口将立即使用该版本。确认发布？',
    '发布确认',
    { type: 'warning', confirmButtonText: '确认发布' }
  )
  await publishCatalogVersion(versionId.value)
  ElMessage.success('目录版本已发布')
  await loadVersions(versionId.value)
}

async function handleImported(version) {
  importVisible.value = false
  ElMessage.success('文件已写入新的草稿版本')
  await loadVersions(version?.id || '')
}

onMounted(loadVersions)
</script>

<style scoped lang="scss">
.catalog-view { padding: 20px; }
.catalog-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 18px 0; }
.catalog-toolbar__left, .catalog-toolbar__right { display: flex; align-items: center; gap: 10px; }
.catalog-toolbar__title { font-size: 20px; font-weight: 700; color: #0f172a; }
.catalog-tabs { padding: 4px 18px 18px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; }
@media (max-width: 900px) {
  .catalog-toolbar { align-items: stretch; flex-direction: column; }
  .catalog-toolbar__left, .catalog-toolbar__right { flex-wrap: wrap; }
}
</style>
