const test=require('node:test')
const assert=require('node:assert/strict')
const vm=require('node:vm'), fs=require('node:fs')
const { isAiReplyEligible }=require('../modules/conversation-pool/aiReplyPolicy')
function harness() {
 const state={pool_type:'ai_self',conv_status:'ai_serving',claimed_by:null}
 const transfers=[]
 class Worker { constructor(name,processor){this.processor=processor;this.listeners={}} on(name,listener){this.listeners[name]=listener} once(name,listener){this.listeners[name]=listener} }
 const modules={
  bullmq:{Worker},'../config/redis':{redisClient:{set:async()=> 'OK',eval:async()=>1},redisConfig:{}},
  '../queues':{QUEUE_NAMES:{AI_REPLY:'test'},isLatestAiReplyJob:async()=>true},
  '../services/configService':{getConfig:async(key,fallback)=>({ai_self_pool_enabled:true,ai_reply_lock_ttl_ms:1000,ai_reply_lock_wait_ms:1000,ai_retry_limit:3}[key]??fallback)},
  '../config/database':{sequelize:{query:async sql=>sql.startsWith('SELECT')?[[{...state}]]:[{affectedRows:1}]}},
  '../modules/conversation-pool/constants':require('../modules/conversation-pool/constants'),
  '../modules/websocket/events':require('../modules/websocket/events'),
  'node:crypto':require('node:crypto'),'../utils/systemLogger':{},
  '../modules/conversation-pool/aiReplyPolicy':{isAiReplyEligible},
  '../modules/conversation-pool/aiDeliveryFallback':{startRecovery:()=>()=>{}},
  '../modules/conversation-pool/ai-auto-reply.service':{handleAiSelfPoolMessage:async()=>({replied:false,transferredToHuman:false,error:'invalid model JSON'})},
  '../modules/conversation-pool/pool.service':{aiTransferToHuman:async(...args)=>transfers.push(args)}
 }
 const box={module:{exports:{}},require:p=>{if(!modules[p])throw Error(p);return modules[p]},process:{env:{}},console:{log(){},error(){}},setInterval:()=>({}),clearInterval(){},setTimeout,Date,Math}
 vm.runInNewContext(fs.readFileSync(__dirname+'/aiReplyWorker.js','utf8'),box)
 return {worker:box.module.exports.initAiReplyWorker(),state,transfers}
}
test('单次模型格式失败触发重试，不立即转人工',async()=>{
 const h=harness(),job={id:'test',data:{conversationId:'test',message:{}},attemptsMade:0}
 await assert.rejects(h.worker.processor(job),/invalid model JSON/)
 job.attemptsMade=1;await h.worker.listeners.failed(job,new Error('invalid model JSON'))
 assert.equal(h.transfers.length,0)
})
test('重试耗尽才转人工，人工已接管时禁止迟到转池',async()=>{
 const h=harness(),job={id:'test',data:{conversationId:'test',message:{}},attemptsMade:3}
 await h.worker.listeners.failed(job,new Error('invalid model JSON'))
 assert.equal(h.transfers.length,1)
 Object.assign(h.state,{pool_type:'private',conv_status:'handling',claimed_by:1})
 await h.worker.listeners.failed(job,new Error('invalid model JSON'))
 assert.equal(h.transfers.length,1)
})
