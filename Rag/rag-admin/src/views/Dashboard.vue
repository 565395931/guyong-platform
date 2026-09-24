<template>
  <div class="dashboard">
    <el-row :gutter="20">
      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-title">今日对话数</div>
          <div class="stat-value">{{ stats.todayChats }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-title">知识库文档</div>
          <div class="stat-value">{{ stats.documents }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-title">问答条数</div>
          <div class="stat-value">{{ stats.questions }}</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="stat-card">
          <div class="stat-title">活跃用户</div>
          <div class="stat-value">{{ stats.activeUsers }}</div>
        </el-card>
      </el-col>
    </el-row>
    
    <el-card class="chart-card">
      <template #header>
        <span>对话趋势</span>
      </template>
      <div id="chart" style="height: 300px;"></div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { adminApi } from '@/api/admin'

const stats = ref({
  todayChats: 0,
  documents: 0,
  questions: 0,
  activeUsers: 0
})

onMounted(async () => {
  try {
    const res = await adminApi.getStats()
    stats.value = res.data
  } catch (error) {
    console.error('获取统计数据失败')
  }
})
</script>

<style scoped lang="scss">
.dashboard {
  .stat-card {
    margin-bottom: 20px;
    
    .stat-title {
      font-size: 14px;
      color: #999;
    }
    
    .stat-value {
      font-size: 32px;
      font-weight: 600;
      color: #409eff;
      margin-top: 10px;
    }
  }
  
  .chart-card {
    margin-top: 20px;
  }
}
</style>