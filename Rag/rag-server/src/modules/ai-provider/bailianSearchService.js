const { createCredentialCipher } = require('./credentialCipher')
const { maskCredential } = require('./providerRegistry')
const KEY = 'bailian_search_config'
function createBailianSearchService({getConfig,updateConfig,cipher,request=require('axios').request}) {
  async function getStatus() {
    const c = await getConfig(KEY)
    return { enabled:await getConfig('bailian_retrieval_enabled') !== false,method:c?.method || 'sdk',workspaceId:c?.workspaceId || '',indexId:c?.indexId || '',region:'cn-beijing',configured:Boolean(c?.method==='api-key' && c.credentialCiphertext && c.workspaceId && c.indexId),credential:maskCredential(c?.credentialCiphertext ? cipher.decrypt(c.credentialCiphertext) : '',c?.credentialCiphertext ? 'database' : 'none') }
  }
  async function save(input, actorId) {
    if (!['api-key','sdk'].includes(input.method)) throw new Error('请选择百炼检索方式')
    if (input.method === 'sdk') {
      const previous = await getConfig(KEY)
      const result = await updateConfig(KEY,{...previous,method:'sdk'},actorId)
      if (!result.success) throw new Error('保存百炼检索方式失败')
      return getStatus()
    }
    const workspaceId=String(input.workspaceId || '').trim(),indexId=String(input.indexId || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) throw new Error('请填写有效的 Workspace ID')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(indexId)) throw new Error('请填写有效的知识库 Index ID')
    const previous=await getConfig(KEY), apiKey=String(input.apiKey || '').trim()
    if (apiKey && (apiKey.length<8 || apiKey.length>500 || /\s/.test(apiKey))) throw new Error('API Key 格式不正确')
    const credentialCiphertext=apiKey ? cipher.encrypt(apiKey) : previous?.credentialCiphertext
    if (!credentialCiphertext) throw new Error('首次配置请填写百炼 API Key')
    const result=await updateConfig(KEY,{method:'api-key',workspaceId,indexId,credentialCiphertext},actorId)
    if (!result.success) throw new Error('保存百炼检索配置失败')
    return getStatus()
  }
  async function setEnabled(enabled, actorId) {
    if (typeof enabled !== 'boolean') throw new Error('启用状态必须为布尔值')
    const result=await updateConfig('bailian_retrieval_enabled',enabled,actorId)
    if (!result.success) throw new Error('保存知识库启用状态失败')
    return getStatus()
  }
  async function search(query, { topK=5,indexId:overrideIndex }={}) {
    if (await getConfig('bailian_retrieval_enabled') === false) throw new Error('百炼知识库已关闭，请在AI配置中开启')
    const c=await getConfig(KEY)
    if (c?.method!=='api-key' || !c.credentialCiphertext) throw new Error('请先保存百炼 API Key 检索配置')
    const text=String(query || '').trim()
    if (!text || text.length>20000) throw new Error('请输入20000字以内的检索问题')
    // Construct the destination from a validated identifier, never from an arbitrary user URL.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(c.workspaceId)) throw new Error('百炼业务空间配置无效')
    const indexId=overrideIndex || c.indexId
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(indexId)) throw new Error('百炼知识库配置无效')
    const started=Date.now()
    try {
      const response=await request({method:'POST',url:`https://${c.workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/indices/rag/index/retrieve`,headers:{Authorization:`Bearer ${cipher.decrypt(c.credentialCiphertext)}`,'Content-Type':'application/json'},data:{index_id:indexId,query:text,top_k:Math.max(1,Math.min(20,Number(topK)||5))},timeout:25000,maxRedirects:0,maxContentLength:2000000})
      const payload=response.data
      if (payload?.success===false || payload?.error || payload?.code && !['Success','success','200',200].includes(payload.code)) throw new Error('response_error')
      const nodes=payload?.output?.nodes || payload?.data?.nodes || payload?.nodes
      if (!Array.isArray(nodes)) throw new Error('invalid_response')
      return {nodes:nodes.map(n=>({text:String(n.text || ''),score:Number(n.score)||0,metadata:n.metadata || {}})),requestId:payload.request_id || payload.requestId,elapsedMs:Date.now()-started}
    } catch(error) {
      const providerMessage=String(error.response?.data?.message || '')
      if (providerMessage === 'Agent application not found.') throw new Error('百炼检索接口类型不匹配，请使用单知识库检索接口')
      if ([401,403].includes(error.response?.status)) throw new Error('百炼鉴权失败，请检查 API Key、业务空间和权限')
      throw new Error('百炼检索失败，请检查业务空间、知识库 ID 或稍后重试')
    }
  }
  return {getStatus,save,search,setEnabled}
}
let singleton
function getBailianSearchService() {
  if (!singleton) {
    const config=require('../../services/configService')
    const key=process.env.AI_PROVIDER_CREDENTIAL_KEY || process.env.PLATFORM_CREDENTIAL_KEY
    const cipher=key ? createCredentialCipher({key}) : {encrypt(){throw new Error('未配置凭据加密密钥')},decrypt(){throw new Error('未配置凭据加密密钥')}}
    singleton=createBailianSearchService({...config,cipher})
  }
  return singleton
}
module.exports={createBailianSearchService,getBailianSearchService}
