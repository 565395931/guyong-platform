<template>
  <div class="model-test">
    <header><div><h1>大模型测试</h1><p>与模型连续对话，使用本地已保存的系统提示词。测试会消耗模型额度。</p></div><el-button @click="router.push('/settings/ai')">模型配置</el-button></header>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" />
    <section class="test-panel" v-loading="loading">
      <div class="panel-heading"><div class="model-controls"><label for="test-model">测试模型</label><el-select id="test-model" v-model="selectedModel" filterable placeholder="请先配置模型" :disabled="pending || loading || !provider?.credential?.configured" @change="changeModel"><el-option v-for="model in modelOptions" :key="model" :label="model" :value="model" /></el-select><el-button :loading="refreshing" :disabled="pending || loading || !provider?.credential?.configured" @click="refreshModels">刷新列表</el-button></div><el-button :disabled="pending || (!history.length && !draftTurn && !message && !image && !error)" @click="clearConversation">清空记录</el-button></div>
      <el-alert v-if="provider?.enabled === false" title="第三方模型服务已关闭，请在 AI 配置中开启后测试" type="info" :closable="false" />
      <div class="chat-settings"><el-select v-model="selectedChannel" placeholder="不追加渠道提示词" :disabled="pending || loading" aria-label="模型测试渠道" style="width:180px" @change="clearConversation"><el-option label="不追加渠道提示词" value="" /><el-option v-for="channel in testChannels" :key="channel.code" :value="channel.code" :label="channel.label" /></el-select><el-checkbox v-model="useBailian" :disabled="pending || !bailianReady" @change="clearConversation">使用百炼知识库</el-checkbox><span>上下文 {{ provider?.replySettings?.contextMessageCount ?? 20 }} 条</span><el-tag size="small" type="success">{{ provider?.replySettings?.systemPrompt ? '已使用本地系统提示词' : '使用默认客服提示词' }}</el-tag><span v-if="resetNotice" role="status">{{ resetNotice }}</span></div>
      <div ref="conversationRef" class="conversation" role="log" aria-label="模型测试对话" aria-live="polite">
        <el-empty v-if="!history.length && !draftTurn" :description="provider?.credential?.configured ? '说一句话，开始测试对话' : '请先在 AI 配置中连接模型服务'" />
        <article v-for="(item, index) in history" :key="index" :class="item.role"><small>{{ item.role === 'user' ? '你' : '大模型' }}</small><p>{{ displayContent(item.content) }}</p><img v-if="imageFrom(item.content)" :src="imageFrom(item.content)" alt="测试图片" /></article>
        <article v-if="draftTurn" class="user"><small>你{{ !pending && error ? ' · 发送失败' : '' }}</small><p>{{ displayContent(draftTurn.content) }}</p><img v-if="imageFrom(draftTurn.content)" :src="imageFrom(draftTurn.content)" alt="测试图片" /></article>
        <article v-if="pending" class="assistant pending" role="status"><small>大模型</small><p>正在回复…</p></article>
      </div>
      <div v-if="result" class="result"><strong>{{ decisionLabels[result.action] || '正常回复' }}</strong><span v-if="result.reason"> · {{ reasonLabels[result.reason] || result.reason }}</span><span v-if="result.action === 'handoff'"> · 测试判定，不操作真实客户会话</span><span v-if="result.retrieval"> · 百炼命中 {{ result.retrieval.nodes.length }} 条</span><br />本次携带上下文 {{ result.contextCount }} 条 · 耗时 {{ (result.elapsedMs / 1000).toFixed(1) }} 秒 · Token {{ result.usage?.total_tokens ?? '—' }} · 模型 {{ result.model }}</div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <div class="composer"><label for="model-test-message">测试消息</label><el-input id="model-test-message" ref="messageInput" v-model="message" type="textarea" :rows="3" maxlength="20000" placeholder="输入消息，与模型对话…" :disabled="pending" @keydown="onComposerKeydown" />
        <div class="actions"><div><label class="image-picker">添加图片<input type="file" accept="image/png,image/jpeg,image/webp" :disabled="pending" @change="selectImage" /></label><span v-if="image"> 已添加图片 <el-button link :disabled="pending" @click="image = ''">移除</el-button></span><span class="shortcut-hint">Ctrl / ⌘ + Enter 发送</span></div><el-button type="primary" :loading="pending" :disabled="loading || provider?.enabled === false || !provider?.credential?.configured || !selectedModel || (!message.trim() && !image)" @click="send">{{ error && draftTurn ? '重试发送' : '发送' }}</el-button></div>
      </div>
    </section>
  </div>
</template>
<script setup>
import { ref, computed, nextTick, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getChannelDefinitions } from '@/api/channels'
import { getAiProvider, testAiPlayground, syncAiProviderModels, getBailianRetrieval } from '@/api/aiConfig'
const router = useRouter()
const provider = ref(null), loading = ref(true), loadError = ref(''), error = ref(''), pending = ref(false)
const history = ref([]), message = ref(''), image = ref(''), result = ref(null), draftTurn = ref(null)
const selectedModel = ref(''), refreshing = ref(false), resetNotice = ref(''), conversationRef = ref(), messageInput = ref()
const selectedChannel=ref(''),testChannels=ref([])
const useBailian=ref(false), bailianReady=ref(false)
const decisionLabels = { reply:'正常回复',clarify:'继续追问',handoff:'需要转人工' }
const reasonLabels = { knowledge_gap:'缺少可靠业务依据',manual_operation:'需要人工操作',out_of_scope:'超出服务范围',customer_request:'客户要求人工' }
const modelOptions = computed(() => [...new Set([provider.value?.provider?.model, ...(provider.value?.models || [])].filter(Boolean))])
const displayContent = content => typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n')
const imageFrom = content => Array.isArray(content) ? content.find(item => item.type === 'image_url')?.image_url?.url : ''
async function scrollToLatest() { await nextTick(); if (conversationRef.value) conversationRef.value.scrollTop = conversationRef.value.scrollHeight }
function clearConversation() {
  if (pending.value) return
  history.value = []; draftTurn.value = null; result.value = null; error.value = ''; message.value = ''; image.value = ''
  resetNotice.value = '已清空历史，下一条消息将开始新的测试对话'
  nextTick(() => messageInput.value?.focus())
}
function changeModel() { clearConversation(); resetNotice.value = '模型已切换，开始新的测试对话' }
function onComposerKeydown(event) { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() } }
async function refreshModels() {
  if (refreshing.value) return
  refreshing.value = true
  try { const response = await syncAiProviderModels(); provider.value.models = response.data.models; loadError.value = '' }
  catch { loadError.value = '模型列表暂时无法获取，可以继续使用已配置模型或点击刷新重试' }
  finally { refreshing.value = false }
}
async function selectImage(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 350000) { error.value = '请选择350KB以内的PNG、JPEG或WebP图片'; return }
  const reader = new FileReader()
  reader.onload = () => { image.value = String(reader.result); error.value = '' }
  reader.onerror = () => { error.value = '图片读取失败，请重新选择' }
  reader.readAsDataURL(file)
}
async function send() {
  if (pending.value || loading.value || provider.value?.enabled === false || !provider.value?.credential?.configured || !selectedModel.value || (!message.value.trim() && !image.value)) return
  pending.value = true; error.value = ''; resetNotice.value = ''
  draftTurn.value = { role: 'user', content: image.value ? [{type:'text',text:message.value.trim() || '请描述这张图片'},{type:'image_url',image_url:{url:image.value}}] : message.value.trim() }
  await scrollToLatest()
  try {
    const count = provider.value.replySettings?.contextMessageCount ?? 20
    const response = await testAiPlayground({ channel:selectedChannel.value, useBailian:useBailian.value, model: selectedModel.value, message: message.value, image: image.value || undefined, history: count ? history.value.slice(-count) : [] })
    result.value = response.data
    history.value.push(response.data.userMessage, { role: 'assistant', content: response.data.content })
    message.value = ''; image.value = ''; draftTurn.value = null
  } catch (e) { error.value = e.response?.data?.message || e.message || '测试失败，请检查模型配置' }
  finally { pending.value = false; await scrollToLatest(); messageInput.value?.focus() }
}
onMounted(async () => { try { const [p,b,c] = await Promise.all([getAiProvider(),getBailianRetrieval(),getChannelDefinitions({status:'active'})]); provider.value = p.data;testChannels.value=c.data || []; bailianReady.value=b.data.enabled !== false && b.data.configured;useBailian.value=bailianReady.value; selectedModel.value = provider.value.provider?.model || ''; if (provider.value.credential?.configured) await refreshModels() } catch { loadError.value = '配置加载失败，请刷新页面重试' } finally { loading.value = false } })
</script>
<style scoped>
.model-test{padding:32px 40px;background:#f5f7fb;min-height:100%;box-sizing:border-box}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}h1{font-size:24px;margin:0 0 8px}header p{color:#64748b;margin:0;font-size:14px}.test-panel{background:white;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}.panel-heading{display:flex;justify-content:space-between;align-items:center;padding:20px 24px;border-bottom:1px solid #e2e8f0}.panel-heading span{margin-left:20px;color:#64748b;font-size:13px}.conversation{min-height:260px;max-height:460px;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px}article{border-radius:8px;background:#f1f5f9;padding:14px 18px;max-width:85%}article.user{align-self:flex-end;background:#eff6ff}article small{color:#64748b}article p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:8px 0 0}article img{max-width:200px;max-height:160px;margin-top:12px}.composer{border-top:1px solid #e2e8f0;padding:24px}.composer>label{display:block;margin-bottom:10px;font-size:14px}.actions{display:flex;justify-content:space-between;align-items:center;margin-top:14px}.image-picker{font-size:14px;color:#2563eb;cursor:pointer;position:relative}.image-picker input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.result{font-size:12px;color:#64748b;padding:12px 24px;background:#f8fafc}.pending{color:#64748b}.el-alert{margin-bottom:12px}@media(max-width:800px){.model-test{padding:20px}header{gap:16px}.panel-heading span{display:block;margin:6px 0 0}}
.model-test{height:100%;display:flex;flex-direction:column;min-height:640px}header{flex:none}.test-panel{display:flex;flex-direction:column;flex:1;min-height:0}.panel-heading{gap:20px;flex:none}.model-controls{display:flex;align-items:center;gap:12px}.model-controls label{font-size:14px;white-space:nowrap}.model-controls .el-select{width:260px}.chat-settings{display:flex;align-items:center;gap:16px;padding:12px 24px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;flex-wrap:wrap}.chat-settings span[role=status]{color:#2563eb}.conversation{flex:1;max-height:none;min-height:180px;scroll-behavior:auto}article.assistant{align-self:flex-start}article.user{max-width:75%}.composer{flex:none;padding:18px 24px}.result{flex:none}.shortcut-hint{margin-left:20px;color:#64748b;font-size:12px}.test-panel>.el-alert{width:calc(100% - 48px);margin:8px 24px}.panel-heading span{margin-left:0}@media(max-width:800px){.model-controls{flex-wrap:wrap}.model-controls .el-select{width:200px}.panel-heading{align-items:flex-start}.shortcut-hint{display:block;margin:8px 0 0}}
</style>
