<template>
  <router-view />
  <DesktopConnectionDialog v-if="isDesktop" v-model="desktopSettingsOpen" />
</template>

<script setup>
import { onBeforeUnmount, onMounted, provide, ref } from 'vue'
import DesktopConnectionDialog from '@/components/Layout/DesktopConnectionDialog.vue'
import { getDesktopBridge, runtimeConfig } from '@/utils/runtimeConfig'

const isDesktop = runtimeConfig.isDesktop
const desktopSettingsOpen = ref(false)
const openDesktopSettings = () => { desktopSettingsOpen.value = true }
provide('openDesktopSettings', openDesktopSettings)
let removeListener
onMounted(() => { removeListener = getDesktopBridge()?.onOpenSettings?.(openDesktopSettings) })
onBeforeUnmount(() => removeListener?.())
</script>

<style lang="scss">
</style>
