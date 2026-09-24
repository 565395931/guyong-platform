<template>
  <div class="sessions-management">
    <el-card>
      <template #header>
        <span>会话记录</span>
      </template>
      
      <el-table :data="sessions" style="width: 100%">
        <el-table-column prop="userId" label="用户ID" />
        <el-table-column prop="createTime" label="创建时间" />
        <el-table-column label="消息数">
          <template #default="{ row }">
            {{ row.messages ? row.messages.length : 0 }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button size="small" @click="viewSession(row)">查看详情</el-button>
            <el-button size="small" type="danger" @click="deleteSession(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    
    <el-dialog v-model="sessionDialogVisible" title="会话详情" width="600px">
      <div class="session-messages">
        <div 
          v-for="(message, index) in sessionMessages" 
          :key="index"
          :class="['message-item', message.type]"
        >
          <div class="message-type">{{ message.type === 'user' ? '用户' : 'AI' }}</div>
          <div class="message-content">{{ message.content }}</div>
          <div class="message-time">{{ message.time }}</div>
        </div>
      </div>
      <template #footer>
        <el-button @click="sessionDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api/admin'

const sessions = ref([])
const sessionDialogVisible = ref(false)
const sessionMessages = ref([])

onMounted(async () => {
  loadSessions()
})

const loadSessions = async () => {
  try {
    const res = await adminApi.getSessions()
    sessions.value = res.data
  } catch (error) {
    ElMessage.error('获取会话列表失败')
  }
}

const viewSession = async (row) => {
  try {
    const res = await adminApi.getSessionDetail(row._id)
    sessionMessages.value = res.data.messages || []
    sessionDialogVisible.value = true
  } catch (error) {
    ElMessage.error('获取会话详情失败')
  }
}

const deleteSession = async (row) => {
  try {
    await adminApi.deleteSession(row._id)
    ElMessage.success('删除成功')
    loadSessions()
  } catch (error) {
    ElMessage.error('删除失败')
  }
}
</script>

<style scoped lang="scss">
.sessions-management {
  .session-messages {
    max-height: 400px;
    overflow-y: auto;
    
    .message-item {
      margin-bottom: 15px;
      padding: 10px;
      border-radius: 8px;
      
      &.user {
        background: #e6f7ff;
      }
      
      &.ai {
        background: #f6f6f6;
      }
      
      .message-type {
        font-size: 12px;
        color: #999;
        margin-bottom: 5px;
      }
      
      .message-content {
        font-size: 14px;
        color: #333;
      }
      
      .message-time {
        font-size: 12px;
        color: #999;
        margin-top: 5px;
      }
    }
  }
}
</style>