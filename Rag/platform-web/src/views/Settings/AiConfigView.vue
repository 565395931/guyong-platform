<template>
  <div class="ai-settings" v-loading="loading">
    <header class="settings-heading">
      <div><h1>AI 配置</h1><p>连接模型服务，设定回答方式与对话上下文。</p></div>
      <el-button @click="router.push('/settings/model-test')">打开大模型测试</el-button>
    </header>
    <section class="settings-card">
      <div class="card-heading"><div><h2>第三方模型服务</h2><p>填写服务地址、API Key 与模型即可连接。</p></div><el-tag :type="provider.credential?.configured ? 'success' : 'info'">{{ provider.credential?.configured ? '已保存连接' : '未配置' }}</el-tag><el-switch v-model="provider.enabled" :loading="modelToggling" :disabled="saving || loading" active-text="开启" inactive-text="关闭" aria-label="启用第三方模型服务" @change="toggleModel" /></div>
      <el-form ref="formRef" :model="connection" :rules="rules" label-position="top">
        <div class="connection-grid">
          <el-form-item label="Base URL" prop="baseUrl"><el-input v-model="connection.baseUrl" placeholder="https://provider.thelonelybrave.cn/v1" /><div class="input-hint">可填写服务根地址、/v1 或完整调用地址。</div></el-form-item>
          <el-form-item label="模型" prop="model"><el-select v-model="connection.model" filterable allow-create default-first-option placeholder="选择或输入模型名称"><el-option v-for="model in provider.models" :key="model" :label="model" :value="model" /></el-select></el-form-item>
          <el-form-item label="API Key" class="key-field"><el-input v-model="connection.apiKey" type="password" show-password :placeholder="provider.credential?.configured ? '已保存密钥，覆盖填写可更换' : '粘贴 API Key'" autocomplete="off" /><div class="input-hint">{{ provider.credential?.configured ? '已保存密钥尾号：' + provider.credential.lastFour + '；需要更换时覆盖填写。' : '使用远端服务时，请先在远端客户账号下生成模型 Key。' }}</div></el-form-item>
          <el-form-item label="上下文条数" prop="contextMessageCount"><el-input-number v-model="connection.contextMessageCount" :min="0" :max="100" :step="1" controls-position="right" /><div class="input-hint">每次回答携带最近这些条历史消息；0 表示只发送当前消息。</div></el-form-item>
        </div>
        <el-form-item label="系统提示词" prop="systemPrompt"><el-input v-model="connection.systemPrompt" type="textarea" :rows="5" maxlength="20000" show-word-limit placeholder="例如：你是一名客服助手，请根据对话上下文准确回答，使用简洁、自然的中文。" /><div class="input-hint">填写公司身份、语气和业务要求，最终顺序：系统提示词 → 渠道提示词 → 默认提示词；渠道提示词默认留空。</div></el-form-item>
        <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
        <div class="form-actions"><div><el-button type="primary" :loading="saving" @click="save">保存配置</el-button><el-button :loading="syncing" @click="syncModels">获取模型列表</el-button><el-button @click="openPromptTemplate">默认提示词模板（非技术人员不要改动）</el-button><el-button @click="openChannelPrompts">渠道提示词</el-button></div><el-button text type="danger" @click="reset">清空模型连接</el-button></div>
      </el-form>
      <div class="service-footer">
        <div><span class="footer-label">账户余额</span><strong :class="{ 'balance-low': balanceLow }">{{ balanceText }}</strong><small :class="{ 'balance-low': balanceLow }">{{ balanceReason }}</small><el-button text @click="refreshAiServiceStatus">刷新余额</el-button></div>
        <div class="template-actions"><span class="footer-label">快速填写</span><el-button @click="template('managed')">远端服务模板</el-button><el-button @click="template('deepseek')">DeepSeek 模板</el-button></div>
      </div>
    </section>
    <section class="settings-card">
      <div class="card-heading"><div><h2>百炼知识库</h2><p>百炼检索资料，交给上方配置的模型组织回答。</p></div><el-tag :type="retrieval.configured ? 'success' : 'info'">{{ retrieval.configured ? 'API Key 检索已配置' : '知识库检索' }}</el-tag><el-switch v-model="retrieval.enabled" :loading="retrievalToggling" :disabled="retrievalSaving || loading" active-text="开启" inactive-text="关闭" aria-label="启用百炼知识库" @change="toggleRetrieval" /></div>
      <el-form label-position="top">
        <el-form-item label="检索方式"><el-radio-group v-model="retrievalInput.method" :disabled="retrievalSaving"><el-radio-button value="api-key">API Key 检索</el-radio-button><el-radio-button value="sdk">原有 AccessKey 检索</el-radio-button></el-radio-group></el-form-item>
        <div v-if="retrievalInput.method === 'api-key'" class="connection-grid">
          <el-form-item label="百炼 API Key"><el-input v-model="retrievalInput.apiKey" type="password" show-password autocomplete="off" :placeholder="retrieval.credential?.configured ? '已保存，留空保留当前 Key' : '粘贴百炼 API Key'" /><div class="input-hint">保存后显示密钥掩码；需要更换时覆盖填写。与知识库位于同一业务空间。</div></el-form-item>
          <el-form-item label="地域"><el-input model-value="华北2（北京）" disabled /></el-form-item>
          <el-form-item label="Workspace ID"><el-input v-model="retrievalInput.workspaceId" placeholder="业务空间 ID" /><div class="input-hint">百炼控制台 → 业务空间管理 → Workspace ID。</div></el-form-item>
          <el-form-item label="知识库 Index ID"><el-input v-model="retrievalInput.indexId" placeholder="知识库 ID，非应用 APP ID" /><div class="input-hint">百炼控制台 → 知识库 → 对应知识库详情 → 知识库 ID。</div></el-form-item>
        </div>
        <p v-if="retrievalError" class="settings-error" role="alert">{{ retrievalError }}</p>
        <div class="form-actions"><el-button type="primary" :loading="retrievalSaving" @click="saveRetrieval">保存检索配置</el-button></div>
        <div v-if="retrievalInput.method === 'api-key'" class="retrieval-test"><el-form-item label="测试检索问题"><el-input v-model="retrievalQuery" placeholder="输入一个知识库中能找到答案的问题" /></el-form-item><el-button :loading="retrievalTesting" :disabled="!retrieval.enabled || !retrieval.configured || !retrievalQuery.trim()" @click="testRetrieval">测试检索（使用已保存配置）</el-button><p v-if="retrievalResult" class="input-hint">检索到 {{ retrievalResult.nodes.length }} 条资料，耗时 {{ retrievalResult.elapsedMs }} 毫秒</p><article v-for="(node,index) in retrievalResult?.nodes || []" :key="index" class="retrieval-node"><strong>{{ node.metadata?.doc_name || '资料 ' + (index + 1) }}</strong><p>{{ node.text }}</p></article></div>
      </el-form>
      <el-collapse class="legacy-bailian"><el-collapse-item title="上传管理与原有 AccessKey 配置（可选）" name="sdk">
      <el-form label-position="top"><div class="connection-grid">
        <el-form-item label="AccessKey ID"><el-input v-model="bailianInput.accessKeyId" :placeholder="bailian.credential?.accessKeyIdMasked || '阿里云 AccessKey ID'" /></el-form-item>
        <el-form-item label="AccessKey Secret"><el-input v-model="bailianInput.accessKeySecret" type="password" show-password :placeholder="bailian.credential?.configured ? '已保存，留空保留当前凭据' : '阿里云 AccessKey Secret'" /></el-form-item>
        <el-form-item v-for="field in bailianFields" :key="field.key" :label="field.label"><el-input v-model="bailianConfig[field.key]" /></el-form-item>
      </div><p v-if="bailianError" class="settings-error" role="alert">{{ bailianError }}</p><div class="form-actions"><el-button :loading="bailianSaving" @click="saveBailian">保存百炼配置</el-button></div></el-form>
      </el-collapse-item></el-collapse>
    </section>
    <el-dialog v-model="channelPromptsVisible" title="渠道提示词" width="760px" :before-close="closeChannelPrompts" @opened="channelPromptInput?.focus()">
      <p class="input-hint">每个渠道默认留空，仅对选中的渠道生效。组合顺序：系统提示词 → 渠道提示词 → 默认提示词。</p>
      <el-form label-position="top" v-loading="channelPromptsLoading">
        <el-form-item label="渠道"><el-select v-model="selectedPromptChannel" :disabled="channelPromptsLoading || channelPromptsSaving" aria-label="渠道提示词所属渠道"><el-option v-for="channel in promptChannels" :key="channel.code" :value="channel.code" :label="channel.label" /></el-select></el-form-item>
        <el-form-item label="渠道提示词内容"><el-input ref="channelPromptInput" v-model="selectedChannelPrompt" type="textarea" :rows="10" maxlength="20000" show-word-limit :disabled="!selectedPromptChannel || channelPromptsSaving || channelPromptsLoading" placeholder="留空表示不追加渠道提示词" aria-label="渠道提示词内容" /></el-form-item>
      </el-form>
      <p v-if="channelPromptsError" class="settings-error" role="alert">{{ channelPromptsError }}</p>
      <template #footer><el-button :disabled="channelPromptsSaving || !selectedPromptChannel" @click="selectedChannelPrompt = ''">清空当前渠道</el-button><el-button :disabled="channelPromptsSaving" @click="closeChannelPrompts()">取消</el-button><el-button type="primary" :loading="channelPromptsSaving" :disabled="channelPromptsLoading || !selectedPromptChannel" @click="saveChannelPromptSettings">保存渠道提示词</el-button></template>
    </el-dialog>
    <el-dialog v-model="promptTemplateVisible" title="默认提示词模板（非技术人员不要改动）" width="760px" :before-close="closePromptTemplate" @opened="promptTemplateInput?.focus()">
      <p class="input-hint">保存后，模型测试和正式客服回复使用此模板。系统提示词、当前渠道提示词依次放在模板前面；请保留 action、reply、reason 的 JSON 格式。</p>
      <el-input ref="promptTemplateInput" v-model="promptTemplateDraft" type="textarea" :rows="16" maxlength="20000" show-word-limit :disabled="promptTemplateSaving" aria-label="默认提示词模板内容" />
      <p class="input-hint">每次请求只携带一份系统规则，再携带设置条数的历史、当前客户消息和本轮知识库资料。规则与参考资料不会累积到聊天历史中。</p>
      <p v-if="promptTemplateError" class="settings-error" role="alert">{{ promptTemplateError }}</p>
      <template #footer><el-button :disabled="promptTemplateSaving" @click="restorePromptTemplate">恢复默认</el-button><el-button :disabled="promptTemplateSaving" @click="closePromptTemplate()">取消</el-button><el-button type="primary" :loading="promptTemplateSaving" @click="savePromptTemplate">保存模板</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { aiServiceStatus, refreshAiServiceStatus } from '@/utils/aiServiceStatus'
import { getAiProvider, saveAiProviderConnection, resetAiProviderConnection, syncAiProviderModels, getAiConfig, updateAiConfig, getBailianCredential, saveBailianCredential, getBailianRetrieval, saveBailianRetrieval, testBailianRetrieval, setAiProviderEnabled, setBailianRetrievalEnabled, saveDefaultPromptTemplate, saveChannelPrompts } from '@/api/aiConfig'
import { getChannelDefinitions } from '@/api/channels'
import { savedCredentialText, credentialForSubmission } from '@/modules/aiConfig/credentialInput'
import { normalizeAiConfig } from '@/modules/aiConfig/aiConfigForm'
const router = useRouter(), formRef = ref(), promptTemplateVisible = ref(false)
const promptTemplateDraft=ref(''),promptTemplateSaving=ref(false),promptTemplateError=ref(''),promptTemplateInput=ref()
function openPromptTemplate(){promptTemplateDraft.value=provider.defaultPromptTemplate || '';promptTemplateError.value='';promptTemplateVisible.value=true}
function restorePromptTemplate(){promptTemplateDraft.value=provider.builtinDefaultPromptTemplate || '';promptTemplateError.value=''}
async function closePromptTemplate(done){if(promptTemplateSaving.value)return;if(promptTemplateDraft.value!==(provider.defaultPromptTemplate || '')){try{await ElMessageBox.confirm('默认提示词模板有未保存修改，是否放弃？','放弃修改',{confirmButtonText:'放弃修改',cancelButtonText:'继续编辑',type:'warning'})}catch{return}}promptTemplateVisible.value=false;if(typeof done==='function')done()}
async function savePromptTemplate(){if(promptTemplateSaving.value)return;promptTemplateSaving.value=true;promptTemplateError.value='';try{Object.assign(provider,(await saveDefaultPromptTemplate(promptTemplateDraft.value)).data);promptTemplateVisible.value=false;ElMessage.success('默认提示词模板已保存')}catch(e){promptTemplateError.value=e.response?.data?.message || e.message || '模板保存失败，请重试'}finally{promptTemplateSaving.value=false}}
const channelPromptsVisible=ref(false),channelPromptsLoading=ref(false),channelPromptsSaving=ref(false),channelPromptsError=ref(''),channelPromptInput=ref()
const promptChannels=ref([]),selectedPromptChannel=ref(''),channelPromptDraft=ref({})
const selectedChannelPrompt=computed({get:()=>channelPromptDraft.value[selectedPromptChannel.value] || '',set:value=>{channelPromptDraft.value[selectedPromptChannel.value]=value}})
async function openChannelPrompts(){
 channelPromptsVisible.value=true;channelPromptsLoading.value=true;channelPromptsError.value='';selectedPromptChannel.value='';
 try{const [channels,status]=await Promise.all([getChannelDefinitions({status:'active'}),getAiProvider()]);Object.assign(provider,status.data);promptChannels.value=channels.data || [];channelPromptDraft.value={...(provider.channelPrompts || {})};selectedPromptChannel.value=promptChannels.value.find(c=>c.code==='wechat_shop')?.code || promptChannels.value[0]?.code || '';if(!selectedPromptChannel.value)channelPromptsError.value='暂无可配置渠道';}
 catch(e){channelPromptsError.value=e.response?.data?.message || '渠道配置读取失败，请关闭后重试'}finally{channelPromptsLoading.value=false}
}
async function closeChannelPrompts(done){if(channelPromptsSaving.value)return;if(JSON.stringify(channelPromptDraft.value)!==JSON.stringify(provider.channelPrompts || {})){try{await ElMessageBox.confirm('渠道提示词有未保存修改，是否放弃？','放弃修改',{confirmButtonText:'放弃修改',cancelButtonText:'继续编辑',type:'warning'})}catch{return}}channelPromptsVisible.value=false;if(typeof done==='function')done()}
async function saveChannelPromptSettings(){if(channelPromptsSaving.value)return;channelPromptsSaving.value=true;channelPromptsError.value='';try{Object.assign(provider,(await saveChannelPrompts(channelPromptDraft.value)).data);channelPromptDraft.value={...(provider.channelPrompts || {})};channelPromptsVisible.value=false;ElMessage.success('渠道提示词已保存')}catch(e){channelPromptsError.value=e.response?.data?.message || '保存失败，请重试'}finally{channelPromptsSaving.value=false}}
const loading = ref(false), saving = ref(false), syncing = ref(false), error = ref('')
const provider = reactive({ enabled:true,models: [], credential: {} })
const modelToggling=ref(false),retrievalToggling=ref(false)
async function toggleModel(value){if(modelToggling.value)return;modelToggling.value=true;error.value='';try{Object.assign(provider,(await setAiProviderEnabled(value)).data);await refreshAiServiceStatus()}catch(e){provider.enabled=!value;error.value=e.response?.data?.message || '模型启用状态保存失败，请重试'}finally{modelToggling.value=false}}
async function toggleRetrieval(value){if(retrievalToggling.value)return;retrievalToggling.value=true;retrievalError.value='';try{Object.assign(retrieval,(await setBailianRetrievalEnabled(value)).data);retrievalResult.value=null}catch(e){retrieval.enabled=!value;retrievalError.value=e.response?.data?.message || '知识库启用状态保存失败，请重试'}finally{retrievalToggling.value=false}}
const connection = reactive({ baseUrl: '', model: '', apiKey: '', contextMessageCount: 20, systemPrompt: '' })
const rules = { baseUrl:[{ required:true,message:'请填写服务地址',trigger:'blur' }], model:[{ required:true,message:'请选择或填写模型',trigger:'blur' }],contextMessageCount:[{ type:'number',min:0,max:100,required:true,message:'请输入0–100的上下文条数',trigger:'change' }] }
const balanceLow = computed(() => aiServiceStatus.managed && aiServiceStatus.balance !== null && aiServiceStatus.balance < 10)
const balanceText = computed(() => aiServiceStatus.managed && aiServiceStatus.balance !== null ? '¥ ' + aiServiceStatus.balance.toFixed(6) : '—')
const balanceReason = computed(() => balanceLow.value ? '大模型余额已不足10元，请及时联系管理员补充大模型额度。' : aiServiceStatus.managed ? '以远端余额为准，每分钟同步' : '自有模型 Key 不统计余额')
const bailian = reactive({ credential:{} }), bailianInput = reactive({accessKeyId:'',accessKeySecret:''}), bailianConfig=reactive({})
const bailianSaving=ref(false), bailianError=ref('')
const retrieval=reactive({enabled:true,configured:false,credential:{}}), retrievalInput=reactive({method:'api-key',apiKey:'',workspaceId:'',indexId:''})
const retrievalSaving=ref(false),retrievalTesting=ref(false),retrievalError=ref(''),retrievalQuery=ref(''),retrievalResult=ref(null)
async function saveRetrieval(){
  retrievalSaving.value=true;retrievalError.value='';retrievalResult.value=null
  try { const r=await saveBailianRetrieval({...retrievalInput,apiKey:credentialForSubmission(retrievalInput.apiKey,retrieval.credential)});Object.assign(retrieval,r.data);retrievalInput.apiKey=savedCredentialText(retrieval.credential);ElMessage.success('百炼检索配置已保存') }
  catch(e){retrievalError.value=e.response?.data?.message || e.message || '保存失败'}finally{retrievalSaving.value=false}
}
async function testRetrieval(){
  retrievalTesting.value=true;retrievalError.value='';retrievalResult.value=null
  try { retrievalResult.value=(await testBailianRetrieval(retrievalQuery.value)).data }
  catch(e){retrievalError.value=e.response?.data?.message || e.message || '检索失败'}finally{retrievalTesting.value=false}
}
const bailianFields=[{key:'bailian_workspace_id',label:'Workspace ID'},{key:'bailian_index_id',label:'知识库 Index ID'},{key:'bailian_category_id',label:'Category ID'}]
async function load() {
  loading.value=true; error.value=''
  try {
    const [p,b,c,r]=await Promise.all([getAiProvider(),getBailianCredential(),getAiConfig(),getBailianRetrieval()])
    Object.assign(retrieval,r.data);Object.assign(retrievalInput,{workspaceId:r.data.workspaceId,indexId:r.data.indexId,apiKey:savedCredentialText(r.data.credential),method:r.data.credential?.configured ? r.data.method : 'api-key'})
    Object.assign(provider,p.data);Object.assign(connection,{baseUrl:p.data.provider.baseURL || '',model:p.data.provider.model || '',apiKey:savedCredentialText(p.data.credential),...p.data.replySettings})
    Object.assign(bailian,b.data);Object.assign(bailianInput,{accessKeyId:b.data.credential?.accessKeyIdMasked || '',accessKeySecret:savedCredentialText(b.data.credential?.secret)});const values=normalizeAiConfig(c.data);for(const field of bailianFields) bailianConfig[field.key]=values[field.key] || ''
  } catch(e){error.value=e.message || '读取配置失败，请刷新重试'}finally{loading.value=false}
}
function template(kind){connection.baseUrl=kind==='managed'?'https://provider.thelonelybrave.cn/v1':'https://api.deepseek.com/v1';connection.model=kind==='managed'?'customer-auto':'deepseek-chat';connection.apiKey=''}
async function save(){
  if(!await formRef.value.validate().catch(()=>false))return
  if(!connection.apiKey.trim()&&!provider.credential?.configured){error.value='请填写 API Key';return}
  saving.value=true;error.value=''
  try{const result=await saveAiProviderConnection({...connection,apiKey:credentialForSubmission(connection.apiKey,provider.credential)});Object.assign(provider,result.data);Object.assign(connection,{baseUrl:result.data.provider.baseURL,model:result.data.provider.model,apiKey:savedCredentialText(result.data.credential),...result.data.replySettings});await refreshAiServiceStatus();ElMessage.success('模型配置已保存')}
  catch(e){error.value=e.message || '保存失败，请检查配置'}finally{saving.value=false}
}
async function syncModels(){
  if(!connection.baseUrl || (!connection.apiKey && !provider.credential?.configured)){error.value='请先填写服务地址和 API Key';return}
  syncing.value=true;error.value=''
  try{const result=await syncAiProviderModels({...connection,apiKey:credentialForSubmission(connection.apiKey,provider.credential)});provider.models=result.data.models;ElMessage.success('模型列表已更新')}
  catch(e){error.value=e.message || '获取模型列表失败，也可以手动填写模型'}finally{syncing.value=false}
}
async function reset(){
  try{await ElMessageBox.confirm('清空当前模型地址、Key、模型和提示词，重新配置后才能调用模型。','清空模型连接',{confirmButtonText:'清空',cancelButtonText:'取消',type:'warning'})}catch{return}
  try{await resetAiProviderConnection();await load();await refreshAiServiceStatus();ElMessage.success('模型连接已清空')}catch(e){error.value=e.message || '清空失败'}
}
async function saveBailian(){
  bailianSaving.value=true;bailianError.value=''
  try{
    if((bailianInput.accessKeyId && bailianInput.accessKeyId !== bailian.credential?.accessKeyIdMasked) || credentialForSubmission(bailianInput.accessKeySecret,bailian.credential?.secret)){if(!bailianInput.accessKeyId || bailianInput.accessKeyId === bailian.credential?.accessKeyIdMasked || !credentialForSubmission(bailianInput.accessKeySecret,bailian.credential?.secret))throw Error('请同时填写 AccessKey ID 和 Secret');const b=await saveBailianCredential({...bailianInput});Object.assign(bailian,b.data);bailianInput.accessKeyId=b.data.credential.accessKeyIdMasked;bailianInput.accessKeySecret=savedCredentialText(b.data.credential.secret)}
    for(const field of bailianFields) await updateAiConfig(field.key,bailianConfig[field.key])
    ElMessage.success('百炼配置已保存')
  }catch(e){bailianError.value=e.message || '百炼配置保存失败'}finally{bailianSaving.value=false}
}
onMounted(load)
</script>
<style scoped lang="scss">
.ai-settings{padding:32px 40px 48px;min-height:100%;background:#f1f5f9;color:#1e293b}
.settings-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.settings-heading h1{font-size:26px;margin:0 0 8px}.settings-heading p,.card-heading p{margin:0;color:#64748b;font-size:13px;line-height:1.6}
.settings-card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:24px;padding:28px 32px}
.card-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:26px;padding-bottom:20px;border-bottom:1px solid #e2e8f0}
.card-heading>div:first-child{flex:1}.card-heading .el-switch{flex:none}
.card-heading h2{font-size:18px;margin:0 0 6px}
.connection-grid{display:grid;grid-template-columns:2fr 1fr;gap:0 28px}.key-field{grid-column:1}
.el-select{width:100%}.input-hint{font-size:12px;line-height:1.6;color:#64748b;margin-top:7px}
.form-actions>div{display:flex;flex-wrap:wrap;gap:8px}.form-actions>div .el-button{margin-left:0}
.form-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:12px}
.service-footer{display:flex;justify-content:space-between;gap:24px;border-top:1px solid #e2e8f0;margin-top:24px;padding-top:20px}
.service-footer strong{font-size:23px;margin-left:12px}.service-footer small{display:block;margin-top:6px;color:#64748b}
.footer-label{font-size:12px;color:#64748b}.template-actions{display:flex;align-items:flex-start;gap:8px}.template-actions .footer-label{padding:9px}
.settings-error,.balance-low{color:#b42318!important}.settings-error{font-size:13px}
.retrieval-test{border-top:1px solid #e2e8f0;margin-top:24px;padding-top:20px}.retrieval-node{padding:12px;background:#f8fafc;border-radius:6px;margin-top:12px}.retrieval-node p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:180px;overflow:auto}.legacy-bailian{margin-top:24px}
</style>

<style scoped>
@media(max-width:800px){.ai-settings{padding:20px}.settings-heading{gap:16px}.settings-card{padding:20px}.connection-grid{grid-template-columns:1fr}.service-footer{flex-direction:column}.template-actions{flex-wrap:wrap}.form-actions{flex-wrap:wrap}}
</style>
