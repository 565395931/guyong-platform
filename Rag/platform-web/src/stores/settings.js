import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  // state - 使用 WorkbenchView 中引用的属性名
  const leftCollapsed = ref(false)
  const rightCollapsed = ref(false)
  const sidebarCollapsed = ref(false)
  const darkMode = ref(false)
  const rightPanelWidth = ref(380)

  // actions - 兼容两种命名方式
  function toggleLeft() {
    leftCollapsed.value = !leftCollapsed.value
  }

  function toggleRight() {
    rightCollapsed.value = !rightCollapsed.value
  }

  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function toggleRightPanel() {
    rightCollapsed.value = !rightCollapsed.value
  }

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
    if (darkMode.value) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  return {
    leftCollapsed,
    rightCollapsed,
    sidebarCollapsed,
    darkMode,
    rightPanelWidth,
    toggleLeft,
    toggleRight,
    toggleSidebar,
    toggleRightPanel,
    toggleDarkMode
  }
})
