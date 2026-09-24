<template>
  <section class="queue-panel" aria-label="审核任务队列">
    <header class="panel-heading">
      <div>
        <span class="panel-kicker">REVIEW QUEUE</span>
        <h2>待核查消息</h2>
      </div>
      <el-tooltip content="刷新审核队列" placement="bottom">
        <el-button circle text :icon="Refresh" :loading="loading" aria-label="刷新审核队列" @click="$emit('refresh')" />
      </el-tooltip>
    </header>

    <div class="scope-row">
      <button
        v-for="option in scopeOptions"
        :key="option.value"
        type="button"
        class="scope-option"
        :class="{ 'scope-option--active': scope === option.value }"
        @click="$emit('scope-change', option.value)"
      >
        <span>{{ option.label }}</span>
        <strong>{{ stats[option.value] ?? 0 }}</strong>
      </button>
    </div>

    <div class="filter-row">
      <el-select :model-value="riskLevel" clearable placeholder="风险等级" @change="$emit('filter-change', { riskLevel: $event })">
        <el-option label="高风险" value="high" />
        <el-option label="中风险" value="medium" />
      </el-select>
      <el-select :model-value="channel" clearable placeholder="全部渠道" @change="$emit('filter-change', { channel: $event })">
        <el-option label="WhatsApp" value="whatsapp" />
        <el-option label="微信客服" value="wecom_kf" />
        <el-option label="抖店" value="douyin" />
        <el-option label="拼多多" value="pinduoduo" />
        <el-option label="淘宝 / 千牛" value="taobao" />
        <el-option label="1688" value="alibaba1688" />
        <el-option label="小红书" value="xiaohongshu" />
        <el-option label="微信小店" value="wechat_shop" />
        <el-option label="快手小店" value="kuaishou" />
      </el-select>
    </div>

    <div v-loading="loading" class="queue-list">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="queue-item"
        :class="[`queue-item--${item.riskLevel}`, { 'queue-item--active': item.id === selectedId }]"
        @click="$emit('select', item)"
      >
        <span class="queue-item__rail" />
        <span class="queue-item__body">
          <span class="queue-item__topline">
            <strong>{{ item.userName || '未知客户' }}</strong>
            <time>{{ formatTime(item.createdAt) }}</time>
          </span>
          <span class="queue-item__message">{{ item.lastMessage || item.reasonText || '待核查入站消息' }}</span>
          <span class="queue-item__meta">
            <span class="risk-label">{{ item.riskLevel === 'high' ? '高风险' : '需核查' }}</span>
            <span>{{ channelLabel(item.channel) }}</span>
            <span v-if="item.status === 'claimed'">处理中</span>
          </span>
        </span>
      </button>
      <el-empty v-if="!loading && !items.length" description="当前没有待审核消息" :image-size="72" />
    </div>
  </section>
</template>

<script setup>
import dayjs from 'dayjs'
import { Refresh } from '@element-plus/icons-vue'

const props = defineProps({
  items: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  scope: { type: String, default: 'mine' },
  riskLevel: { type: String, default: '' },
  channel: { type: String, default: '' },
  stats: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  canViewAll: { type: Boolean, default: false }
})

defineEmits(['select', 'scope-change', 'filter-change', 'refresh'])

const scopeOptions = [
  { label: '我的', value: 'mine' },
  { label: '公共池', value: 'public' },
  ...(props.canViewAll ? [{ label: '全部', value: 'all' }] : [])
]

const formatTime = value => value ? dayjs(value).format('MM-DD HH:mm') : '--'
const channelLabel = value => ({
  whatsapp: 'WhatsApp', wecom_kf: '微信客服', douyin: '抖店',
  pinduoduo: '拼多多', taobao: '淘宝', alibaba1688: '1688',
  xiaohongshu: '小红书', wechat_shop: '微信小店', kuaishou: '快手小店'
})[value] || value || '未知渠道'
</script>

<style scoped lang="scss">
.queue-panel { display: flex; min-width: 0; flex-direction: column; background: #f8fafc; border-right: 1px solid #dce2e8; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; min-height: 68px; padding: 12px 16px; border-bottom: 1px solid #dce2e8; background: #fff; }
.panel-heading h2 { margin: 2px 0 0; color: #17202a; font-size: 16px; letter-spacing: 0; }
.panel-kicker { color: #77838f; font-family: Consolas, monospace; font-size: 10px; letter-spacing: 1px; }
.scope-row { display: grid; grid-template-columns: repeat(3, 1fr); min-height: 48px; padding: 8px 12px; gap: 6px; border-bottom: 1px solid #e4e9ee; }
.scope-option { display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #60707d; cursor: pointer; }
.scope-option strong { min-width: 20px; color: #263746; font-family: Consolas, monospace; }
.scope-option--active { border-color: #9eb5c8; background: #edf3f7; color: #183b56; }
.filter-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e4e9ee; }
.queue-list { flex: 1; min-height: 180px; overflow: auto; }
.queue-item { position: relative; display: flex; width: 100%; min-height: 112px; padding: 14px 14px 14px 17px; border: 0; border-bottom: 1px solid #e4e9ee; background: #fff; color: inherit; text-align: left; cursor: pointer; }
.queue-item:hover { background: #f5f8fa; }
.queue-item--active { background: #edf4f8; box-shadow: inset 0 0 0 1px #a8bfce; }
.queue-item__rail { position: absolute; inset: 12px auto 12px 7px; width: 3px; border-radius: 2px; background: #d69a2d; }
.queue-item--high .queue-item__rail { background: #c84545; }
.queue-item__body { display: flex; min-width: 0; width: 100%; flex-direction: column; gap: 8px; }
.queue-item__topline, .queue-item__meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.queue-item__topline strong { min-width: 0; overflow: hidden; color: #1e2d38; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.queue-item__topline time { color: #85919c; font-family: Consolas, monospace; font-size: 11px; }
.queue-item__message { display: -webkit-box; overflow: hidden; color: #53616d; font-size: 13px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.queue-item__meta { justify-content: flex-start; color: #7a8792; font-size: 11px; }
.risk-label { font-weight: 700; color: #b53b3b; }
@media (max-width: 900px) { .queue-panel { min-height: 420px; border-right: 0; border-bottom: 1px solid #dce2e8; } }
</style>
