const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const constants = require('./constants')
const { isAiReplyEligible } = require('./aiReplyPolicy')
function harness({duringLanguage} = {}) {
 const state = {id:'test',channel:'wechat_shop',account_id:3,user_id:'test-user',pool_type:'ai_self',conv_status:'ai_serving',claimed_by:null,status:'open',ai_epoch:0}
 const sends=[], stored=[], cancelled=[], updates=[]
 const query = async (sql,options={}) => {
  const r=options.replacements || {}
  if(sql.startsWith('UPDATE conversations')) {
   updates.push(sql)
   if(state.pool_type!==r.fromPool || state.conv_status!==r.fromStatus || state.claimed_by!==r.previousClaimed) return [{affectedRows:0}]
   Object.assign(state,{pool_type:r.targetPool,conv_status:r.targetStatus,claimed_by:r.claimedBy ?? null,status:'open',ai_epoch:state.ai_epoch+1})
   return [{affectedRows:1}]
  }
  if(sql.includes('INSERT INTO')) return [{affectedRows:1}]
  if(sql.includes('FROM conversations')) return [[{...state}]]
  throw Error('Unexpected SQL')
 }
 const modules={
  'node:crypto':require('node:crypto'),
  '../../config/database':{sequelize:{query}},
  '../websocket/events':{INTERNAL_EVENTS:{}},
  '../../queues':{removePendingAiReplyJobs:async(...args)=>cancelled.push(args)},
  './handoff-keyword.service':{}, './constants':constants, './aiReplyPolicy':{isAiReplyEligible},
  '../../utils/systemLogger':{info(){},error(){}},
  '../cloud-gateway/runtime':{getDispatcher:()=>({dispatch:async p=>{sends.push(p);return {success:true}}})},
  '../../services/configService':{getConfig:async(key, fallback)=>fallback ?? null},
  '../../services/languageGuard':{ensureOutputLanguage:async text=>{await duringLanguage?.(state);return text}},
  '../channel-adapters':{getAdapterByChannel:()=>null},
  '../messaging/messaging.service':{sendAiReply:async m=>stored.push(m)}
 }
 const box={module:{exports:{}},require:p=>{if(!modules[p])throw Error('Unexpected dependency '+p);return modules[p]},console:{log(){},error(){}},Map,Date,Intl}
 vm.runInNewContext(fs.readFileSync(__dirname+'/pool.service.js','utf8'),box)
 return {service:box.module.exports,state,sends,stored,cancelled,updates}
}
test('首次转人工只发送一次提示，待人工停止AI接待',async()=>{
 const h=harness()
 const results=await Promise.all([h.service.aiTransferToHuman('test','needs human',null,'zh'),h.service.aiTransferToHuman('test','needs human',null,'zh')])
 assert.equal(results.filter(r=>r.success).length,1)
 assert.equal(h.sends.length,1)
 assert.equal(h.sends[0].content.text,'正在为您转接技术同事，请您耐心等待。')
 assert.equal(h.stored.length,1)
 assert.equal(h.stored[0].id.length,36)
 assert.equal(h.cancelled.length,1)
 assert.equal(isAiReplyEligible(h.state),false)
})
test('提示生成过程中认领，阻止迟到转接提示',async()=>{
 const h=harness({duringLanguage:async s=>Object.assign(s,{pool_type:'private',conv_status:'handling',claimed_by:1})})
 await h.service.aiTransferToHuman('test','needs human',null,'zh')
 assert.equal(h.sends.length,0)
 assert.equal(h.stored.length,0)
})
test('AI不能把已由人工接管的会话重新转走',async()=>{
 const h=harness();Object.assign(h.state,{pool_type:'private',conv_status:'handling',claimed_by:1})
 assert.equal((await h.service.aiTransferToHuman('test','late result',null,'zh')).success,false)
 assert.equal(h.updates.length,0)
})
test('待人工转入人工窗口取消排队，转回AI恢复接待',async()=>{
 const h=harness();Object.assign(h.state,{pool_type:'pending_human',conv_status:'pending_claim'})
 assert.equal((await h.service.movePool({conversationId:'test',targetPool:'private',claimedBy:1})).success,true)
 assert.equal(h.cancelled.length,0)
 assert.equal(isAiReplyEligible(h.state),false)
 assert.equal((await h.service.movePool({conversationId:'test',targetPool:'ai_self'})).success,true)
 assert.equal(isAiReplyEligible(h.state),true)
})

test('归档时即使池字段过期，AI失败也不能重新转人工', async()=>{
 const h=harness();Object.assign(h.state,{status:'closed',conv_status:'ai_serving'})
 assert.equal((await h.service.aiTransferToHuman('test','late result',null,'zh')).success,false)
 assert.equal(h.updates.length,0)
})
