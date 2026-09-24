<template>
  <div class="loading-skeleton">
    <el-skeleton :rows="rows" animated />
  </div>
</template>

<script setup>
defineProps({
  rows: {
    type: Number,
    default: 3
  },
  height: {
    type: String,
    default: '60px'
  }
})
</script>

<style lang="scss" scoped>
.loading-skeleton {
  width: 100%;
  padding: 16px;

  :deep(.el-skeleton__item) {
    height: v-bind(height);
  }
}
</style>
