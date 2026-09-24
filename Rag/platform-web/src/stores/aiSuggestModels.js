import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { fetchAiSuggestModels } from '@/api/messages'

const LS_KEY = 'ai_suggest_model'
const FALLBACK_MODELS = ['qwen3.7-plus']

export const useAiSuggestModelsStore = defineStore('aiSuggestModels', () => {
  const models = ref([])
  const selectedModel = ref(localStorage.getItem(LS_KEY) || FALLBACK_MODELS[0])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref(null)
  let loadingPromise = null

  const availableModels = computed(() => models.value.length > 0 ? models.value : FALLBACK_MODELS)

  const ensureSelectedModel = () => {
    const saved = localStorage.getItem(LS_KEY)
    const candidates = availableModels.value

    if (saved && candidates.includes(saved)) {
      selectedModel.value = saved
    } else if (!selectedModel.value || !candidates.includes(selectedModel.value)) {
      selectedModel.value = candidates[0] || ''
    }
  }

  const loadModels = async ({ force = false } = {}) => {
    if (loaded.value && !force) {
      ensureSelectedModel()
      return availableModels.value
    }

    if (loadingPromise && !force) {
      return loadingPromise
    }

    loading.value = true
    error.value = null

    loadingPromise = fetchAiSuggestModels()
      .then((res) => {
        const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
        models.value = list.length > 0 ? list : FALLBACK_MODELS
        loaded.value = true
        ensureSelectedModel()
        return availableModels.value
      })
      .catch((err) => {
        console.error('[AiSuggestModelsStore] 获取AI模型列表失败:', err)
        error.value = err
        models.value = FALLBACK_MODELS
        loaded.value = true
        ensureSelectedModel()
        return availableModels.value
      })
      .finally(() => {
        loading.value = false
        loadingPromise = null
      })

    return loadingPromise
  }

  const setSelectedModel = (model) => {
    selectedModel.value = model
    if (model) {
      localStorage.setItem(LS_KEY, model)
    }
  }

  return {
    models,
    selectedModel,
    loading,
    loaded,
    error,
    availableModels,
    loadModels,
    setSelectedModel
  }
})
