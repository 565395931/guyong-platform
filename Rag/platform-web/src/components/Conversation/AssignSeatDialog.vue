<template>
  <el-dialog
    v-model="visible"
    title="分配坐席"
    width="420px"
    @open="handleOpen"
    @closed="handleClosed"
  >
    <div class="assign-seat-dialog">
      <div v-if="conversation" class="assign-seat-dialog__target">
        <span class="assign-seat-dialog__label">当前会话</span>
        <span class="assign-seat-dialog__name">{{ conversation.user_name || conversation.user_id || '未知用户' }}</span>
      </div>

      <el-select
        v-model="targetSeatId"
        filterable
        placeholder="选择要分配到的坐席私有池"
        style="width: 100%"
        :loading="loadingSeats"
      >
        <el-option
          v-for="seat in seats"
          :key="seat.id"
          :label="seatLabel(seat)"
          :value="seat.id"
          :disabled="seat.canClaim === false"
        >
          <div class="assign-seat-dialog__option">
            <span>{{ seat.username }}</span>
            <span class="assign-seat-dialog__meta">
              {{ roleLabel(seat.role) }} · {{ seat.current }}/{{ seat.max }}
            </span>
          </div>
        </el-option>
      </el-select>

      <div v-if="!loadingSeats && seats.length === 0" class="assign-seat-dialog__empty">
        暂无可分配坐席
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleConfirm">
        确认分配
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { getAssignableSeats } from '@/api/conversations'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  conversation: { type: Object, default: null },
  submitting: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'confirm'])

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})

const seats = ref([])
const targetSeatId = ref(null)
const loadingSeats = ref(false)

const roleLabel = (role) => ({
  agent: '客服',
  supervisor: '主管'
}[role] || role || '坐席')

const seatLabel = (seat) => `${seat.username} (${roleLabel(seat.role)} ${seat.current}/${seat.max})`

const loadSeats = async () => {
  loadingSeats.value = true
  try {
    const res = await getAssignableSeats()
    seats.value = res.data || []
  } catch (error) {
    console.error('[AssignSeatDialog] 获取坐席失败:', error)
    ElMessage.error('获取可分配坐席失败')
  } finally {
    loadingSeats.value = false
  }
}

const handleOpen = () => {
  targetSeatId.value = null
  loadSeats()
}

const handleClosed = () => {
  targetSeatId.value = null
}

const handleConfirm = () => {
  if (!targetSeatId.value) {
    ElMessage.warning('请选择要分配的坐席')
    return
  }
  const seat = seats.value.find(item => item.id === targetSeatId.value)
  if (seat?.canClaim === false) {
    ElMessage.warning(`坐席 ${seat.username} 已达接待上限`)
    return
  }
  emit('confirm', { seatId: targetSeatId.value, seat })
}
</script>

<style lang="scss" scoped>
.assign-seat-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;

  &__target {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-size: 13px;
  }

  &__label {
    color: #909399;
    flex: 0 0 auto;
  }

  &__name {
    color: #303133;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
  }

  &__meta {
    color: #909399;
    font-size: 12px;
    flex: 0 0 auto;
  }

  &__empty {
    color: #909399;
    font-size: 13px;
    text-align: center;
  }
}
</style>
