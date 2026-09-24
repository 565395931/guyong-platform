<template>
  <section class="conversation-panel" aria-label="会话上下文">
    <header class="conversation-header">
      <div>
        <span>会话上下文</span>
        <strong>{{ item?.userName || '未选择任务' }}</strong>
      </div>
      <el-tag v-if="item?.channel" effect="plain" size="small">{{ item.channel }}</el-tag>
    </header>

    <div v-loading="loading" class="message-stream">
      <template v-if="item">
        <article
          v-for="(message, index) in item.context || []"
          :key="message.id || index"
          class="message-row"
          :class="[
            message.role === 'customer' || message.role === 'user' ? 'message-row--customer' : 'message-row--agent',
            { 'message-row--reviewed': item.messageIds?.includes(message.id) }
          ]"
        >
          <div class="message-row__meta">
            <span>{{ roleLabel(message.role) }}</span>
            <time>{{ formatTime(message.createdAt || message.created_at) }}</time>
          </div>
          <p>{{ contentText(message.content) || '非文本消息' }}</p>
          <span v-if="item.messageIds?.includes(message.id)" class="review-marker">本次审核</span>
        </article>
        <div v-if="!(item.context || []).length" class="context-empty">暂无可显示的上下文</div>
      </template>
      <el-empty v-else description="从左侧选择一条审核任务" :image-size="82" />
    </div>
  </section>
</template>

<script setup>
import dayjs from 'dayjs'

defineProps({
  item: { type: Object, default: null },
  loading: { type: Boolean, default: false }
})

const contentText = content => typeof content === 'string' ? content : (content?.text || content?.content || '')
const formatTime = value => value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '--'
const roleLabel = role => role === 'customer' || role === 'user' ? '客户' : role === 'ai' ? 'AI' : '坐席'
</script>

<style scoped lang="scss">
.conversation-panel { display: flex; min-width: 0; flex-direction: column; background: #f3f5f6; }
.conversation-header { display: flex; align-items: center; justify-content: space-between; min-height: 68px; padding: 12px 20px; border-bottom: 1px solid #dce2e8; background: #fff; }
.conversation-header div { display: flex; flex-direction: column; gap: 3px; }
.conversation-header span { color: #7b8791; font-size: 11px; }
.conversation-header strong { color: #172630; font-size: 15px; }
.message-stream { flex: 1; min-height: 260px; overflow: auto; padding: 22px clamp(16px, 4vw, 54px); }
.message-row { position: relative; width: min(76%, 680px); margin-bottom: 18px; padding: 12px 14px; border: 1px solid #d9e0e5; border-radius: 6px; background: #fff; box-shadow: 0 2px 8px rgba(25, 42, 54, .04); }
.message-row--agent { margin-left: auto; border-color: #b9cedc; background: #eef5f8; }
.message-row--reviewed { border-color: #c84545; box-shadow: 0 0 0 2px rgba(200, 69, 69, .1); }
.message-row__meta { display: flex; justify-content: space-between; margin-bottom: 7px; color: #74818b; font-size: 11px; }
.message-row p { margin: 0; color: #263640; font-size: 14px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.review-marker { position: absolute; right: 10px; bottom: -9px; padding: 2px 6px; border-radius: 3px; background: #c84545; color: #fff; font-size: 10px; }
.context-empty { padding-top: 80px; color: #89949d; text-align: center; }
@media (max-width: 900px) { .conversation-panel { min-height: 520px; border-bottom: 1px solid #dce2e8; } .message-row { width: 88%; } }
</style>
