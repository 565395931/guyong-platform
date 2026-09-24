<template>
  <div class="knowledge-base-view">
    <!-- 顶部操作栏 -->
    <div class="knowledge-base-view__toolbar">
      <div class="knowledge-base-view__toolbar-left">
        <el-button type="primary" :icon="Plus" @click="handleCreate">
          新建知识库
        </el-button>
      </div>
      <div class="knowledge-base-view__toolbar-right">
        <el-input
          v-model="searchKeyword"
          placeholder="搜索知识库名称"
          :prefix-icon="Search"
          clearable
          style="width: 240px"
          @input="handleSearch"
        />
      </div>
    </div>

    <!-- 知识库卡片列表 -->
    <div v-loading="loading" class="knowledge-base-view__grid">
      <el-row v-if="filteredList.length > 0" :gutter="20">
        <el-col
          v-for="item in filteredList"
          :key="item.id"
          :xs="24"
          :sm="12"
          :md="8"
          :lg="6"
        >
          <el-card
            class="kb-card"
            shadow="hover"
            :body-style="{ padding: '0' }"
            @click="handleCardClick(item)"
          >
            <div class="kb-card__header">
              <el-icon :size="32" class="kb-card__icon"><Reading /></el-icon>
              <div class="kb-card__name-wrap">
                <span class="kb-card__name">{{ item.name }}</span>
                <el-tag
                  :type="item.status === 'active' ? 'success' : 'info'"
                  size="small"
                  effect="light"
                >
                  {{ item.status === 'active' ? '运行中' : '已停用' }}
                </el-tag>
              </div>
            </div>
            <div class="kb-card__body">
              <p class="kb-card__desc">{{ item.description }}</p>
              <div class="kb-card__tags">
                <el-tag
                  v-for="ch in item.channels"
                  :key="ch"
                  size="small"
                  type="warning"
                  effect="plain"
                >
                  {{ ch }}
                </el-tag>
              </div>
            </div>
            <div class="kb-card__footer">
              <div class="kb-card__stat">
                <el-icon><Document /></el-icon>
                <span>{{ item.docCount }} 篇文档</span>
              </div>
              <el-button text type="primary" @click.stop="handleCardClick(item)">
                查看详情
              </el-button>
            </div>
          </el-card>
        </el-col>
      </el-row>
      <el-empty v-else-if="!loading" description="暂无知识库，请新建" />
    </div>

    <!-- 文档列表弹窗 -->
    <el-dialog
      v-model="docDialogVisible"
      :title="`${selectedKb?.name || ''} - 文档列表`"
      width="80%"
      top="5vh"
    >
      <div v-loading="docLoading" class="knowledge-base-view__doc-table">
        <el-table :data="docList" border style="width: 100%" max-height="400">
          <el-table-column prop="name" label="文档名称" min-width="200" show-overflow-tooltip />
          <el-table-column prop="type" label="类型" width="100">
            <template #default="{ row }">
              <el-tag size="small">{{ row.type }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="chunkStatus" label="切片状态" width="120">
            <template #default="{ row }">
              <el-tag :type="getChunkTagType(row.chunkStatus)" size="small">
                {{ row.chunkStatus }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="chunkCount" label="切片数" width="80" align="center" />
          <el-table-column prop="uploadTime" label="上传时间" width="180" />
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button
                text
                type="danger"
                size="small"
                :icon="Delete"
                @click="handleDeleteDoc(row)"
              />
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="docList.length === 0 && !docLoading" description="该知识库暂无文档" />
      </div>

      <!-- 检索测试区域 -->
      <el-divider content-position="left">检索测试</el-divider>
      <div class="knowledge-base-view__retrieval">
        <div class="knowledge-base-view__retrieval-input">
          <el-input
            v-model="retrievalQuery"
            placeholder="输入测试问题，验证知识库检索效果"
            clearable
            @keyup.enter="handleRetrieval"
          >
            <template #prepend>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-button
            type="primary"
            :loading="retrievalLoading"
            @click="handleRetrieval"
          >
            查询
          </el-button>
        </div>
        <div v-if="retrievalResults.length > 0" class="knowledge-base-view__retrieval-results">
          <div
            v-for="(res, idx) in retrievalResults"
            :key="idx"
            class="retrieval-item"
          >
            <div class="retrieval-item__header">
              <el-tag type="success" size="small">Top {{ idx + 1 }}</el-tag>
              <span class="retrieval-item__score">相似度: {{ res.score }}%</span>
            </div>
            <p class="retrieval-item__content">{{ res.content }}</p>
          </div>
        </div>
        <el-empty
          v-else-if="retrievalQueried"
          description="未检索到相关片段"
          :image-size="60"
        />
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, Reading, Document, Delete } from '@element-plus/icons-vue'

const loading = ref(false)
const searchKeyword = ref('')
const docDialogVisible = ref(false)
const docLoading = ref(false)
const selectedKb = ref(null)
const retrievalQuery = ref('')
const retrievalLoading = ref(false)
const retrievalResults = ref([])
const retrievalQueried = ref(false)

// Mock 知识库数据
const kbList = ref([
  {
    id: 1,
    name: '产品常见问题',
    description: '涵盖产品功能、使用方法、故障排查等常见问题解答',
    docCount: 28,
    channels: ['WhatsApp', '抖音'],
    status: 'active'
  },
  {
    id: 2,
    name: '售后服务手册',
    description: '退换货流程、保修政策、售后联系方式等',
    docCount: 15,
    channels: ['微信'],
    status: 'active'
  },
  {
    id: 3,
    name: '促销活动话术',
    description: '各类促销活动期间的标准回复与营销话术',
    docCount: 12,
    channels: ['WhatsApp', '抖音', '微信'],
    status: 'active'
  },
  {
    id: 4,
    name: '产品规格参数',
    description: '全产品线技术参数、规格说明、对比数据',
    docCount: 8,
    channels: ['指纹浏览器'],
    status: 'inactive'
  }
])

const filteredList = computed(() => {
  if (!searchKeyword.value) return kbList.value
  const kw = searchKeyword.value.toLowerCase()
  return kbList.value.filter(
    (item) =>
      item.name.toLowerCase().includes(kw) ||
      item.description.toLowerCase().includes(kw)
  )
})

// Mock 文档数据
const mockDocs = [
  { id: 1, name: '产品使用指南_v2.pdf', type: 'PDF', chunkStatus: '已完成', chunkCount: 42, uploadTime: '2026-06-15 10:30:00' },
  { id: 2, name: '常见FAQ汇总.docx', type: 'Word', chunkStatus: '已完成', chunkCount: 35, uploadTime: '2026-06-14 14:20:00' },
  { id: 3, name: '故障排查手册.pdf', type: 'PDF', chunkStatus: '处理中', chunkCount: 0, uploadTime: '2026-07-01 09:00:00' },
  { id: 4, name: '产品规格表.xlsx', type: 'Excel', chunkStatus: '已完成', chunkCount: 18, uploadTime: '2026-06-20 16:45:00' },
  { id: 5, name: '话术模板.txt', type: 'TXT', chunkStatus: '失败', chunkCount: 0, uploadTime: '2026-07-03 11:15:00' }
]

const docList = ref([])

const getChunkTagType = (status) => {
  const map = { '已完成': 'success', '处理中': 'warning', '失败': 'danger' }
  return map[status] || 'info'
}

const handleSearch = () => {
  // computed 自动处理
}

const handleCreate = () => {
  ElMessage.info('新建知识库功能开发中')
}

const handleCardClick = (item) => {
  selectedKb.value = item
  docDialogVisible.value = true
  docLoading.value = true
  retrievalResults.value = []
  retrievalQueried.value = false

  // 模拟加载
  setTimeout(() => {
    docList.value = [...mockDocs]
    docLoading.value = false
  }, 500)
}

const handleDeleteDoc = (row) => {
  ElMessageBox.confirm(
    `确认删除文档「${row.name}」吗？`,
    '删除确认',
    { type: 'warning' }
  )
    .then(() => {
      docList.value = docList.value.filter((d) => d.id !== row.id)
      ElMessage.success('删除成功')
    })
    .catch(() => {})
}

const handleRetrieval = () => {
  if (!retrievalQuery.value.trim()) {
    ElMessage.warning('请输入测试问题')
    return
  }
  retrievalLoading.value = true
  retrievalQueried.value = false

  // 模拟检索结果
  setTimeout(() => {
    retrievalResults.value = [
      { score: 95, content: '根据产品使用指南，该功能需要在设置页面中开启「智能模式」选项，开启后系统将自动识别并优化...' },
      { score: 88, content: '常见问题解答中提到，如果遇到此问题，建议先检查网络连接状态，并确保设备固件已更新至最新版本...' },
      { score: 82, content: '故障排查手册第三章节指出，该错误码通常表示传感器异常，可通过重启设备或联系售后进行进一步检测...' }
    ]
    retrievalLoading.value = false
    retrievalQueried.value = true
  }, 800)
}

onMounted(() => {
  // 模拟加载
  loading.value = true
  setTimeout(() => {
    loading.value = false
  }, 300)
})
</script>

<style scoped lang="scss">
.knowledge-base-view {
  padding: 20px;

  &__toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  &__grid {
    min-height: 300px;
  }

  &__doc-table {
    min-height: 200px;
  }

  &__retrieval {
    margin-top: 12px;
  }

  &__retrieval-input {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }

  &__retrieval-results {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
}

.kb-card {
  margin-bottom: 20px;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
  border-radius: $radius-base;

  &:hover {
    transform: translateY(-2px);
  }

  &__header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    background: linear-gradient(135deg, #ecf5ff, #f0f9ff);
    border-bottom: 1px solid $border-light;
  }

  &__icon {
    color: $primary-color;
    flex-shrink: 0;
  }

  &__name-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  &__name {
    font-size: 16px;
    font-weight: 600;
    color: $text-primary;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__body {
    padding: 16px;
  }

  &__desc {
    font-size: 13px;
    color: $text-secondary;
    line-height: 1.6;
    margin: 0 0 12px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-top: 1px solid $border-light;
    background: #fafafa;
  }

  &__stat {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: $text-secondary;
  }
}

.retrieval-item {
  padding: 12px 16px;
  background: #f9fafc;
  border: 1px solid $border-light;
  border-radius: $radius-small;

  &__header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  &__score {
    font-size: 12px;
    color: $success-color;
    font-weight: 600;
  }

  &__content {
    font-size: 13px;
    color: $text-regular;
    line-height: 1.6;
    margin: 0;
  }
}
</style>
