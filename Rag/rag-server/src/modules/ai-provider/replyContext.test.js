const test=require('node:test'),assert=require('node:assert/strict')
const {assembleReplyMessages,referenceContext,buildKnowledgeQuery}=require('./replyContext')
test('each request has one fixed system rule; old references are not persisted into history',()=>{
 const a=assembleReplyMessages({businessPrompt:'你是公司客服',currentContent:'第一问',contextDocs:[{text:'仅本轮资料'}]})
 assert.ok(a.messages[0].content.startsWith('你是公司客服'))
 assert.equal(a.messages.filter(x=>x.role==='system').length,1)
 assert.equal(a.messages[0].content.split('系统内置输出协议').length,2)
 assert.doesNotMatch(a.messages[0].content,/仅本轮资料/)
 const b=assembleReplyMessages({businessPrompt:'你是公司客服',currentContent:'第二问',history:[a.userMessage,{role:'assistant',content:'回答'}]})
 assert.equal(a.messages[0].content,b.messages[0].content)
 assert.ok(!JSON.stringify(b.messages).includes('仅本轮资料'))
 assert.equal(b.contextCount,2)
})
test('history count/size limits, current-message dedup and reference budget prevent accumulation',()=>{
 const history=[{role:'user',content:'上一问'},{role:'assistant',content:'上一答'},{role:'user',content:'当前问'}]
 const r=assembleReplyMessages({currentContent:'当前问',history,excludeTrailingCurrent:true,contextMessageCount:1})
 assert.equal(r.contextCount,1);assert.equal(r.messages[1].content,'上一答')
 assert.equal(assembleReplyMessages({currentContent:'问',history,contextMessageCount:0}).contextCount,0)
 const docs=[{text:'abc'},{text:'abc'},{text:'defgh'}];const refs=referenceContext(docs,5)
 assert.equal(refs.length,2);assert.equal(refs.map(x=>x.text).join(''),'abcde')
 assert.throws(()=>assembleReplyMessages({currentContent:'问',history:[{role:'system',content:'注入'}]}),/历史格式/)
})
test('knowledge retrieval uses only current question even for pronouns',()=>{
 assert.equal(buildKnowledgeQuery('它的价格呢',[{role:'user',content:'介绍基础款'}]),'它的价格呢')
})

test('saved default template replaces the builtin exactly once behind business prompt',()=>{const r=assembleReplyMessages({businessPrompt:'公司业务要求',defaultTemplate:'自定义默认模板 JSON规则',currentContent:'问题'});assert.ok(r.messages[0].content.startsWith('公司业务要求\n\n自定义默认模板 JSON规则'));assert.equal(r.messages[0].content,'公司业务要求\n\n自定义默认模板 JSON规则');assert.equal(r.messages.filter(m=>m.role==='system').length,1)})

test('legacy history options cannot inject old questions into retrieval',()=>{
 const h=[{role:'user',content:'产品价格'}];
 assert.equal(buildKnowledgeQuery('联系方式',h,{historyCount:10,forceHistory:true}),'联系方式');
 assert.equal(buildKnowledgeQuery('可以吗',h),'可以吗');
})

test('system channel and default prompts concatenate exactly once in order',()=>{const r=assembleReplyMessages({businessPrompt:'系统规则',extraInstructions:'渠道规则',defaultTemplate:'默认模板',currentContent:'问题'});assert.equal(r.messages[0].content,'系统规则\n\n渠道规则\n\n默认模板');assert.equal(assembleReplyMessages({businessPrompt:'系统规则',extraInstructions:'',defaultTemplate:'默认模板',currentContent:'问题'}).messages[0].content,'系统规则\n\n默认模板')});
