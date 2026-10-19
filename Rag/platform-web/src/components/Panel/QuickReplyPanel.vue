<template>
  <div class="quick-reply-panel">
    <el-input v-model="filterText" placeholder="搜索话术" size="small" :prefix-icon="Search" clearable />

    <div class="quick-reply-panel__hint">新增、编辑和删减只影响你的账号；其他人仍使用自己的话术。</div>
    <div class="quick-reply-panel__tools">
      <el-button size="small" :icon="Plus" @click="openCreate({ scope: 'personal' })">新增个人话术</el-button>
      <el-button size="small" :loading="restoring" @click="restoreShared">恢复公共话术</el-button>
    </div>

    <el-empty
      v-if="!loading && treeData.length === 0"
      description="暂无话术，点击「新增个人话术」添加"
      :image-size="60"
    />

    <el-tree
      v-else
      :key="treeVersion"
      ref="treeRef"
      :data="treeData"
      :props="treeProps"
      :filter-node-method="filterNode"
      node-key="id"
      default-expand-all
      :expand-on-click-node="false"
      @node-click="handleClick"
    >
      <template #default="{ data }">
        <div class="quick-node" :class="`quick-node--${data.kind}`">
          <span class="quick-node__label" :title="data.tooltip">{{ data.label }}</span>

          <span v-if="canManage" class="quick-node__actions">
            <el-button v-if="data.kind !== 'item'" text size="small" :icon="Plus" aria-label="添加个人话术" title="添加个人话术" @click.stop="openCreate(data)" />
            <el-button v-if="data.kind === 'item'" text size="small" :icon="EditPen" aria-label="编辑我的话术" title="编辑我的话术" @click.stop="openEdit(data)" />
            <el-button text size="small" type="danger" :icon="Delete" aria-label="从我的话术中移除" title="从我的话术中移除" @click.stop="handleDelete(data)" />
          </span>
        </div>
      </template>
    </el-tree>

    <!-- 新增 / 编辑 -->
    <el-dialog
      v-model="dialogVisible"
      :title="form.id ? '编辑话术' : '新增话术'"
      width="440px"
      append-to-body
      destroy-on-close
    >
      <el-alert v-if="form.shared" title="公共库内容对其他客服可见；他们已有的个人修改会保留。" type="info" :closable="false" show-icon style="margin-bottom: 12px" />
      <el-form label-width="72px" label-position="left" novalidate>
        <el-form-item v-if="isAdmin && (!form.id || form.isSharedSource)" label="归属">
          <el-radio-group v-model="form.shared">
            <el-radio :value="false">个人话术</el-radio>
            <el-radio :value="true">公共库（所有人可见）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="分类">
          <el-select
            v-model="form.category"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="如：开场白（可直接输入新分类）"
            style="width: 100%"
          >
            <el-option v-for="c in categoryOptions" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="form.title" maxlength="100" placeholder="给这条话术起个名字，如：开场白问候" />
        </el-form-item>
        <el-form-item label="触发词">
          <el-input v-model="form.shortcut" maxlength="80" placeholder="如：/开场白（输入框里打 / 可调用）" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="4"
            resize="none"
            maxlength="10000"
            placeholder="点击话术时复制到剪贴板的内容"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { Search, Plus, EditPen, Delete } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply
} from '@/api/messages'
import request from '@/api/index'
import { useUserStore } from '@/stores/user'

defineProps({
  conversation: { type: Object, default: null }
})

const userStore = useUserStore()
const treeRef = ref()
const filterText = ref('')
const loading = ref(false)
const saving = ref(false)
const replies = ref([])
const treeVersion = ref(0)

const treeProps = { label: 'label', children: 'children' }

const SCOPE_LABELS = { personal: '个人话术', shared: '公共话术（我的版本）' }

// 所有登录客服都可以维护自己的话术版本
const canManage = computed(() => ['admin', 'agent'].includes(userStore.userInfo?.role))
const isAdmin = computed(() => userStore.userInfo?.role === 'admin')
const currentUserId = computed(() => userStore.userInfo?.id ?? null)

const categoryOptions = computed(() => {
  const set = new Set()
  replies.value.forEach(r => { if (r.category) set.add(r.category) })
  return Array.from(set)
})

/**
 * 把后端扁平的话术列表拼成三层树：
 *   归属（个人话术 / 公共话术，按创建人是不是我） → 分类 → 话术内容
 * 后端没有"归属"字段，公共话术用 created_by 留空表示。
 */
const treeData = computed(() => {
  const groups = { personal: [], shared: [] }
  replies.value.forEach(r => {
    const scope = r.createdBy != null && r.createdBy === currentUserId.value ? 'personal' : 'shared'
    groups[scope].push(r)
  })

  return ['personal', 'shared']
    .filter(scope => groups[scope].length > 0)
    .map(scope => {
      const byCategory = new Map()
      groups[scope].forEach(r => {
        const category = r.category || '未分类'
        if (!byCategory.has(category)) byCategory.set(category, [])
        byCategory.get(category).push(r)
      })
      return {
        id: `group:${scope}`,
        kind: 'group',
        scope,
        label: SCOPE_LABELS[scope],
        children: Array.from(byCategory.entries()).map(([category, items]) => ({
          id: `cat:${scope}:${category}`,
          kind: 'category',
          scope,
          category,
          label: category,
          children: items.map(item => ({
            id: item.id,
            kind: 'item',
            scope,
            label: item.content,
            tooltip: `${item.title}（${item.shortcut}）`,
            reply: item
          }))
        }))
      }
    })
})

const loadReplies = async () => {
  loading.value = true
  try {
    const all = []
    let page = 1
    let total = 0
    do {
      const res = await getQuickReplies({ page, pageSize: 100 })
      const data = res.data || res || {}
      const batch = data.list || []
      all.push(...batch)
      total = data.total || 0
      page += 1
      if (!batch.length) break
    } while (all.length < total)
    replies.value = all
    treeVersion.value += 1
    // 树是整棵重建的，搜索过滤要重新套一遍
    await nextTick()
    treeRef.value?.filter(filterText.value)
  } catch (err) {
    console.error('[QuickReplyPanel] 获取话术失败:', err)
    ElMessage.error('话术加载失败，请重试')
  } finally {
    loading.value = false
  }
}

/**
 * 复制文本。
 * ⚠️ 不能用 navigator.clipboard 就算完：它只在安全上下文（https / localhost）可用，
 * 而工作台平时是从局域网 IP（http://192.168.2.199:3003）打开的，那里它是 undefined。
 * 所以退回 textarea + execCommand。
 */
const copyText = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

const handleClick = async (data) => {
  if (data.kind !== 'item') return
  const ok = await copyText(data.label)
  if (ok) {
    ElMessage.success('已复制话术内容')
  } else {
    ElMessage.warning('复制失败，请手动选中复制')
  }
}

// ========== 新增 / 编辑 ==========
const dialogVisible = ref(false)
const form = ref({ id: null, shared: false, category: '', title: '', shortcut: '', content: '' })

const openCreate = (data) => {
  if (!canManage.value) return
  form.value = {
    id: null,
    shared: false,
    // 在分类行点添加时，分类跟着预填，省一次输入
    category: data.kind === 'category' ? data.category : '',
    title: '',
    shortcut: '',
    content: ''
  }
  dialogVisible.value = true
}

const openEdit = (data) => {
  if (!canManage.value) return
  const r = data.reply
  form.value = {
    id: r.id,
    isSharedSource: r.createdBy == null,
    shared: false,
    category: r.category || '',
    title: r.title || '',
    shortcut: r.shortcut || '',
    content: r.content || ''
  }
  dialogVisible.value = true
}

const handleSave = async () => {
  const payload = {
    title: form.value.title.trim(),
    shortcut: form.value.shortcut.trim(),
    content: form.value.content.trim(),
    category: form.value.category?.trim() || '',
    shared: form.value.shared
  }
  if (!payload.title) return ElMessage.warning('标题不能为空')
  if (!payload.shortcut) return ElMessage.warning('触发词不能为空')
  if (/\s/.test(payload.shortcut)) return ElMessage.warning('触发词不能包含空格')
  if (!payload.content) return ElMessage.warning('内容不能为空')

  saving.value = true
  try {
    if (form.value.id) {
      await updateQuickReply(form.value.id, payload)
      ElMessage.success('已保存')
    } else {
      await createQuickReply(payload)
      ElMessage.success('已添加')
    }
    dialogVisible.value = false
    await loadReplies()
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err.message || '保存失败')
  } finally {
    saving.value = false
  }
}

const handleDelete = async (data) => {
  if (!canManage.value) return
  const targets = data.kind === 'item' ? [data.reply] : collectReplies(data)
  if (targets.length === 0) return
  const label = data.kind === 'item'
    ? `这条话术「${truncate(data.label)}」`
    : `「${data.label}」这一层，及其中的 ${targets.length} 条话术`
  try {
    await ElMessageBox.confirm(`确定从你的话术中移除${label}吗？不会影响其他人，公共话术可以恢复。`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger'
    })
  } catch {
    return
  }
  try {
    for (const r of targets) {
      await deleteQuickReply(r.id)
    }
    ElMessage.success(`已删除 ${targets.length} 条`)
    await loadReplies()
  } catch (err) {
    ElMessage.error(err?.response?.data?.message || err.message || '删除失败')
    await loadReplies()
  }
}

const collectReplies = (node) => {
  if (node.kind === 'item') return [node.reply]
  return (node.children || []).flatMap(collectReplies)
}

const truncate = (text, max = 12) => (text.length > max ? `${text.slice(0, max)}…` : text)

watch(filterText, (val) => { treeRef.value?.filter(val) })

const filterNode = (value, data) => {
  if (!value) return true
  if (data.kind === 'item') {
    const r = data.reply || {}
    return [r.content, r.title, r.shortcut, r.category]
      .some(field => String(field || '').includes(value))
  }
  return data.label.includes(value)
}

const restoring = ref(false)
const restoreShared = async () => {
  if (restoring.value) return
  try { await ElMessageBox.confirm('恢复你对公共话术的编辑和删减，个人新增话术保留。', '恢复公共话术', { confirmButtonText: '恢复', cancelButtonText: '取消', autofocus: false }) } catch { return }
  restoring.value = true
  try { await request.post('/v1/quick-replies/restore-shared'); await loadReplies(); ElMessage.success('已恢复公共话术') }
  finally { restoring.value = false }
}
onMounted(loadReplies)
</script>

<style lang="scss" scoped>
.quick-reply-panel {
  .el-input { margin-bottom: 12px; }
  &__tools { display: flex; gap: 8px; margin-bottom: 12px; }

  &__hint {
    margin-bottom: 10px;
    padding: 6px 8px;
    border-radius: 6px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    font-size: 12px;
    line-height: 1.5;
    color: #64748b;
  }

  :deep(.el-tree) { font-size: 13px; background: transparent; }
  :deep(.el-tree-node__content) { height: 30px; }
}

.quick-node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;

  &__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &--group > &__label { font-weight: 600; }
  &--item > &__label { color: #475569; }

  &__actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0.55;
    transition: opacity 0.15s ease;
  }

  &:hover &__actions { opacity: 1; }

  &__icon {
    padding: 2px;
    border-radius: 4px;
    font-size: 14px;
    color: #64748b;
    cursor: pointer;

    &:hover { color: #3b82f6; background: #eff6ff; }
    &--danger:hover { color: #ef4444; background: #fef2f2; }
  }
}
</style>
