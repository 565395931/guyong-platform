<template>
  <div class="quick-reply-panel">
    <el-input v-model="filterText" placeholder="搜索话术" size="small" :prefix-icon="Search" clearable />
    <el-tree
      ref="treeRef"
      :data="treeData"
      :props="treeProps"
      :filter-node-method="filterNode"
      node-key="id"
      default-expand-all
      @node-click="handleClick"
    />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'

const emit = defineEmits(['insert'])
const filterText = ref('')
const treeRef = ref()

const treeProps = { label: 'label', children: 'children' }

const treeData = ref([
  {
    id: 1, label: '个人话术', children: [
      { id: 11, label: '开场白', children: [
        { id: 111, label: '您好，很高兴为您服务！' },
        { id: 112, label: '亲，有什么可以帮您的吗？' }
      ]},
      { id: 12, label: '结束语', children: [
        { id: 121, label: '感谢您的咨询，祝您生活愉快！' },
        { id: 122, label: '如有其他问题随时联系我们哦~' }
      ]}
    ]
  },
  {
    id: 2, label: '公共话术', children: [
      { id: 21, label: '产品介绍', children: [
        { id: 211, label: '我们的产品支持30天无理由退换，全国联保。' },
        { id: 212, label: '目前有新品9折优惠活动，限时3天。' }
      ]},
      { id: 22, label: '物流查询', children: [
        { id: 221, label: '您的订单已发货，预计2-3天到达。' }
      ]}
    ]
  }
])

watch(filterText, (val) => { treeRef.value?.filter(val) })

const filterNode = (value, data) => {
  if (!value) return true
  return data.label.includes(value)
}

const handleClick = (data) => {
  if (!data.children) emit('insert', data.label)
}
</script>

<style lang="scss" scoped>
.quick-reply-panel {
  .el-input { margin-bottom: 12px; }
  :deep(.el-tree) { font-size: 13px; }
  :deep(.el-tree-node__content) { height: 32px; }
}
</style>
