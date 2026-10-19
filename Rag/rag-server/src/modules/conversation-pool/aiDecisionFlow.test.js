const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
function harness(action){
 const transfers=[],stored=[],dispatches=[]
 const modules={
  crypto:require('node:crypto'), './aiReplyPolicy':require('./aiReplyPolicy'),
  '../../config/database':{sequelize:{query:async()=>[[]]}}, '../../queues':{isLatestAiReplyJob:async()=>true},
  '../messaging/messaging.service':{sendAiReply:async m=>stored.push(m)},
  './pool.service':{getPoolConfig:async()=>({sentiment_check_enabled:true,ai_max_rounds:0}),aiTransferToHuman:async(...args)=>transfers.push(args)},
  '../cloud-gateway/runtime':{getDispatcher:()=>({dispatch:async p=>{dispatches.push(p);return {success:true,status:'accepted'}}})},
  './aiDeliveryFallback':{runtime:()=>({sendText:async(p,dispatch)=>{stored.push({sendStatus:'received'});return dispatch(p)}})},
  './constants':require('./constants'),
  './handoff-keyword.service':{matchCustomerHandoffKeyword:async()=>({matched:false}),buildCustomerHandoffReason:()=>''},
  '../../services/configService':{getConfig:async()=>true},
  '../ai-provider/replyProtocol':{explicitHumanRequest:()=>false},
  '../../services/languageGuard':{ensureOutputLanguage:async t=>t}
 }
 const box={module:{exports:{}},require:p=>{if(!modules[p])throw Error('Unexpected dependency '+p);return modules[p]},console:{log(){},error(){}},action,Date,Map,Intl,process:{env:{}}}
 const overrides=`
 getConversationAiState=async()=>({canAiReply:true});
 buildLatestCustomerInput=async()=>({text:'请介绍产品性能和资料',retrievalText:'产品性能',count:1});
 detectGreetingByLLM=async()=>false;
 retrieveWithContext=async()=>({contextDocs:[],maxScore:0});
 generateAiReplyFromContext=async(id,text,docs,lang,options)=>{options.onDecision({action,reason:action==='handoff'?'knowledge_gap':null});return '目前没有具体规格资料，请补充您所用的玻璃类型。'};
 getDesktopBridgeAdapter=async()=>null;getWahaAdapter=()=>null;
 analyzeSentiment=async()=>{throw Error('旧情绪审核不应运行')};
 `
 vm.runInNewContext(fs.readFileSync(__dirname+'/ai-auto-reply.service.js','utf8')+overrides,box)
 return {service:box.module.exports,transfers,stored,dispatches}
}
for(const action of ['reply','clarify','handoff'])test('正式AI流程严格遵循JSON '+action+'，不被旧情绪和文案规则覆盖',async()=>{
 const h=harness(action)
 const result=await h.service.handleAiSelfPoolMessage('fixture',{messageType:'text',channel:'wechat_shop',content:{text:'请介绍产品性能和资料'},accountId:1,channelUserId:'fixture-user'})
 assert.equal(result.transferredToHuman,action==='handoff',result.error)
 assert.equal(h.transfers.length,action==='handoff'?1:0)
 assert.equal(h.dispatches.length,action==='handoff'?0:1)
 if(action!=='handoff'){assert.equal(result.replied,true,result.error);assert.equal(h.stored[0].sendStatus,'received')}
})

test('formal retrieval uses only current message and configured index without account scope filters',async()=>{
 let requested;
 const nodes=[{text:'公司联系信息',score:0.5}];
 const box={module:{exports:{}},require:p=>p==='../rag/ragService'?{retrieve:async options=>{requested=options;return {nodes}}}:p==='../ai-provider/replyContext'?require('../ai-provider/replyContext'):p==='../../config/database'?{sequelize:{query(){throw Error('Retrieval must not load account scope or history')}}}:p==='crypto'?require('node:crypto'):{},console:{log(){},error(){}},Date,Map,Intl,process:{env:{}}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/ai-auto-reply.service.js','utf8'),box);
 const r=await box.module.exports.retrieveWithContext('合并的旧问题','fixture','当前问题','wechat_shop',1);
 assert.equal(requested.query,'当前问题');
 for(const key of ['channel','knowledgeScope','knowledgeChannels'])assert.equal(key in requested,false);
 assert.equal(r.contextDocs,nodes);assert.equal(r.maxScore,0.5);
});

test('retrieval diagnostics retain all five source identities without storing customer message or source body',()=>{
 const box={module:{exports:{}},require:p=>p==='crypto'?require('node:crypto'):{},console:{log(){},error(){}},Date,Map,Intl,process:{env:{}}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/ai-auto-reply.service.js','utf8')+'\nmodule.exports.diagnostics=buildRetrievalDiagnostics;',box);
 const r=box.module.exports.diagnostics({queryText:'private-current-question',retrieveQuery:'private-current-question',contextDocs:Array.from({length:5},(_,i)=>({docName:'资料'+i,text:'private-source-body',score:0.5})),topScore:0.5});
 assert.equal(r.topNodes.length,5);assert.equal(r.queryHash,r.retrieveQueryHash);assert.doesNotMatch(JSON.stringify(r),/private-current-question|private-source-body/);
});
