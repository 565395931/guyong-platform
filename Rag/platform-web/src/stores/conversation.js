import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getPoolStats, getSeatLoad, markConversationRead } from '@/api/conversations'

const POOL_STATS_CACHE_MS = 3000
const SEAT_LOAD_CACHE_MS = 3000

export const useConversationStore = defineStore('conversation', () => {
  // ========== state ==========
  const list = ref([])
  const current = ref(null)
  const selectionVersion = ref(0)

  // 池类型 Tab — 默认待人工池（最高优先级）
  const activePoolTab = ref('pending_human')

  // 各池数量统计
  const poolStats = ref({
    ai_self: 0,
    pending_human: 0,
    public: 0,
    long_term: 0,
    private: 0,
    archived: 0,
    all: 0
  })

  // 坐席负载
  const seatLoad = ref({ canClaim: true, current: 0, max: 5 })

  // 新消息未读高亮，用于会话列表视觉提醒
  const highlightedConversationIds = ref([])

  // 有新消息的会话池 Tab，用于顶部 Tab 闪烁提醒
  const flashingPoolTabs = ref([])

  let poolStatsPromise = null
  let poolStatsFetchedAt = 0
  let seatLoadPromise = null
  let seatLoadFetchedAt = 0

  // ========== getters ==========
  const unreadTotal = computed(() =>
    list.value.reduce((sum, conv) => sum + (conv.unread_count || 0), 0)
  )

  // ========== actions ==========
  function setList(newList) {
    list.value = newList || []
  }

  function selectConversation(conv) {
    current.value = conv
    selectionVersion.value += 1
    if (conv && conv.id) {
      const target = list.value.find(item => item.id === conv.id)
      if (target) {
        target.unread_count = 0
      }
      clearConversationHighlight(conv.id)
      // 通知后端清零未读数（fire-and-forget）
      markConversationRead(conv.id).catch(() => {})
    }
  }

  function updateConversation(conv) {
    if (!conv || !conv.id) return
    const index = list.value.findIndex(item => item.id === conv.id)
    if (index !== -1) {
      list.value[index] = { ...list.value[index], ...conv }
    } else {
      list.value.unshift({ ...conv, unread_count: conv.unread_count || 0 })
    }
    if (current.value?.id === conv.id) {
      current.value = { ...current.value, ...conv }
    }
  }

  function updateCurrentConversation(conv) {
    if (!conv || !conv.id || current.value?.id !== conv.id) return
    current.value = { ...current.value, ...conv }
  }

  // 插入或更新会话（新消息到达时调用）
  function upsertConversation(convId, convData, options = {}) {
    if (!convId) return
    const { moveToTop = false } = options
    const index = list.value.findIndex(item => item.id === convId)
    if (index !== -1) {
      list.value[index] = { ...list.value[index], ...convData }
      if (moveToTop) {
        const [updated] = list.value.splice(index, 1)
        list.value.unshift(updated)
      }
    } else if (convData) {
      list.value.unshift({
        id: convId,
        channel: convData.channel,
        account_id: convData.account_id,
        account_name: convData.account_name || '',
        phone_number: convData.phone_number || '',
        whatsapp_name: convData.whatsapp_name || '',
        user_id: convData.user_id,
        customer_phone: convData.customer_phone || '',
        user_name: convData.user_name || convData.user_id || '未知用户',
        user_avatar: convData.user_avatar || '',
        nationality_code: convData.nationality_code || null,
        nationality_name: convData.nationality_name || null,
        nationality_name_en: convData.nationality_name_en || null,
        nationality_source: convData.nationality_source || null,
        nationality_inferred_at: convData.nationality_inferred_at || null,
        agent_id: convData.agent_id,
        agent_name: convData.agent_name,
        pool_type: convData.pool_type || 'ai_self',
        conv_status: convData.conv_status || 'ai_serving',
        claimed_by: convData.claimed_by,
        claimed_by_name: convData.claimed_by_name,
        claimed_at: convData.claimed_at,
        priority: convData.priority || 0,
        last_reply_by: convData.last_reply_by,
        last_reply_time: convData.last_reply_time,
        last_message: convData.last_message || '',
        last_message_time: convData.last_message_time || Date.now(),
        unread_count: convData.unread_count || 0,
        status: convData.status || 'open',
        ai_reply_count: convData.ai_reply_count || 0,
        inbound_count: convData.inbound_count || 0,
        tags: [],
        created_at: convData.created_at
      })
    }
  }

  function highlightConversation(convId) {
    if (!convId) return
    highlightedConversationIds.value = [
      convId,
      ...highlightedConversationIds.value.filter(id => id !== convId)
    ].slice(0, 20)
  }

  function clearConversationHighlight(convId) {
    highlightedConversationIds.value = highlightedConversationIds.value.filter(id => id !== convId)
  }

  function flashPoolTab(tab) {
    if (!tab || tab === activePoolTab.value) return
    flashingPoolTabs.value = [
      tab,
      ...flashingPoolTabs.value.filter(item => item !== tab)
    ]
  }

  function clearPoolTabFlash(tab) {
    if (!tab) return
    flashingPoolTabs.value = flashingPoolTabs.value.filter(item => item !== tab)
  }

  function addMessage(convId, message) {
    if (current.value && current.value.id === convId) {
      if (!Array.isArray(current.value.messages)) {
        current.value.messages = []
      }
      // 去重：避免同一消息被重复添加（如本地已追加后又收到 WebSocket 推送）
      if (message.id && current.value.messages.some(m => m.id === message.id)) {
        return
      }
      current.value.messages.push(message)
    }
  }

  function clearCurrent() {
    current.value = null
  }

  // 从列表中移除会话（归档或池变更不在当前 Tab 时）
  function removeConversation(convId, options = {}) {
    const { preserveCurrent = false } = options
    const index = list.value.findIndex(item => item.id === convId)
    if (index !== -1) {
      list.value.splice(index, 1)
    }
    if (!preserveCurrent && current.value?.id === convId) {
      current.value = null
    }
  }

  // ========== 池统计 ==========
  async function fetchPoolStats(options = {}) {
    const { force = false } = options
    const now = Date.now()
    if (!force && poolStatsFetchedAt && now - poolStatsFetchedAt < POOL_STATS_CACHE_MS) {
      return poolStats.value
    }
    if (poolStatsPromise) return poolStatsPromise

    poolStatsPromise = (async () => {
      try {
        const res = await getPoolStats()
        if (res.data) {
          poolStats.value = res.data
          poolStatsFetchedAt = Date.now()
        }
        return poolStats.value
      } catch (err) {
        console.error('[Store] 获取池统计失败:', err)
        return poolStats.value
      } finally {
        poolStatsPromise = null
      }
    })()

    return poolStatsPromise
  }

  async function fetchSeatLoad(options = {}) {
    const { force = false } = options
    const now = Date.now()
    if (!force && seatLoadFetchedAt && now - seatLoadFetchedAt < SEAT_LOAD_CACHE_MS) {
      return seatLoad.value
    }
    if (seatLoadPromise) return seatLoadPromise

    seatLoadPromise = (async () => {
      try {
        const res = await getSeatLoad()
        if (res.data) {
          seatLoad.value = res.data
          seatLoadFetchedAt = Date.now()
        }
        return seatLoad.value
      } catch (err) {
        console.error('[Store] 获取坐席负载失败:', err)
        return seatLoad.value
      } finally {
        seatLoadPromise = null
      }
    })()

    return seatLoadPromise
  }

  function setPoolTab(tab) {
    activePoolTab.value = tab
    clearPoolTabFlash(tab)
  }

  // 更新池统计（WebSocket 推送时本地更新）
  function updatePoolStats(stats) {
    if (stats) {
      poolStats.value = { ...poolStats.value, ...stats }
      poolStatsFetchedAt = Date.now()
    }
  }

  // 更新头像（手动刷新后同步到列表和当前会话）
  function updateConversationAvatar(convId, avatar) {
    if (!convId) return
    const index = list.value.findIndex(item => item.id === convId)
    if (index !== -1) {
      list.value[index].user_avatar = avatar
    }
    if (current.value?.id === convId) {
      current.value = { ...current.value, user_avatar: avatar }
    }
  }

  return {
    // state
    list,
    current,
    selectionVersion,
    activePoolTab,
    poolStats,
    seatLoad,
    highlightedConversationIds,
    flashingPoolTabs,
    // getters
    unreadTotal,
    // actions
    setList,
    selectConversation,
    updateConversation,
    updateCurrentConversation,
    upsertConversation,
    addMessage,
    clearCurrent,
    removeConversation,
    fetchPoolStats,
    fetchSeatLoad,
    setPoolTab,
    updatePoolStats,
    updateConversationAvatar,
    highlightConversation,
    clearConversationHighlight,
    flashPoolTab,
    clearPoolTabFlash
  }
})
