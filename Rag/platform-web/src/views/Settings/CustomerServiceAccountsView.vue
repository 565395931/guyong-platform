<template>
  <div class="customer-service-accounts-view">
    <section class="account-toolbar" aria-label="客服账号筛选">
      <div class="account-toolbar__actions">
        <el-tooltip content="刷新账号列表" placement="bottom">
          <el-button circle size="small" :icon="Refresh" aria-label="刷新账号列表" @click="refresh" />
        </el-tooltip>
        <el-button type="primary" size="small" :icon="Plus" @click="openCreate">
          添加账号
        </el-button>
      </div>
    </section>

    <main class="customer-service-accounts-view__content">
      <PlatformAccountsView
        v-if="selectedChannel === 'wecom_kf'"
        ref="managerRef"
        channel-code="wecom_kf"
        embedded
      />
      <AccountManage
        v-else
        ref="managerRef"
        :channel-code="selectedChannel"
        embedded
      />
    </main>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Plus, Refresh } from '@element-plus/icons-vue'
import AccountManage from './AccountManage.vue'
import PlatformAccountsView from './PlatformAccountsView.vue'
import { normalizePlatformChannel } from '@/modules/platformMessages/platformFilters'

const route = useRoute()
const managerRef = ref(null)
const selectedChannel = ref(normalizePlatformChannel(route.query.channel))

function openCreate() {
  managerRef.value?.openCreate?.()
}

async function refresh() {
  await managerRef.value?.refresh?.()
}

watch(
  () => route.query.channel,
  value => {
    selectedChannel.value = normalizePlatformChannel(value)
  }
)
</script>

<style scoped lang="scss">
.customer-service-accounts-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: #f5f7fa;

  &__content {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: $spacing-md;
  }
}

.account-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-md;
  min-height: 52px;
  padding: 8px $spacing-lg;
  border-bottom: 1px solid $color-border;
  background: $color-bg-white;

  &__actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: $spacing-sm;
  }

}

@media (max-width: 900px) {
  .account-toolbar {
    align-items: flex-start;
    flex-direction: column;

    &__actions {
      align-self: flex-end;
    }
  }
}
</style>
