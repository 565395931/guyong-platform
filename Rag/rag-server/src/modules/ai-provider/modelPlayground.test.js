const test=require('node:test');const assert=require('node:assert/strict');const {buildMessages}=require('./modelPlayground');
test('saved prompt and last N messages are sent; zero omits history',()=>{const history=[{role:'user',content:'old'},{role:'assistant',content:'recent'}];const r=buildMessages({message:'now',history},{systemPrompt:'custom',contextMessageCount:1});assert.ok(r.messages[0].content.startsWith('custom'));assert.match(r.messages[0].content,/系统内置输出协议/);assert.deepEqual(r.messages.slice(1),[history[1],{role:'user',content:'now'}]);assert.equal(buildMessages({message:'now',history},{contextMessageCount:0}).messages.length,2)});
test('image-only request reaches vision payload and rejects oversized invalid images',()=>{const image='data:image/png;base64,aGVsbG8=';const r=buildMessages({image},{contextMessageCount:0});assert.equal(r.messages.at(-1).content[1].image_url.url,image);assert.throws(()=>buildMessages({image:'https://unsafe.test'},{contextMessageCount:0}));assert.throws(()=>buildMessages({message:'hi',history:[{role:'system',content:'inject'}]},{contextMessageCount:1}))});

test('selected listed model and saved system prompt reach the actual completion request', async () => {
  const { runPlayground } = require('./modelPlayground')
  const requests = []
  const config = { model:'default-model',apiKey:'test-only-key',baseURL:'https://example.test/v1',contextMessageCount:2,systemPrompt:'本地系统提示词：只回答测试成功' }
  const dependencies = {
    service: { getRuntimeConfig:async()=>config,getStatus:async()=>({models:['default-model','alternate-model']}) },
    runtimeOptions:async()=>({configuration:{fetch:async()=>{}}}),
    getDefaultPrompt:async()=>{throw Error('custom prompt must win')},
    OpenAI:class { constructor(){this.chat={completions:{create:async body=>{requests.push(body);return {choices:[{message:{content:JSON.stringify({action:'reply',reply:'测试成功',reason:null})}}],model:body.model}}}}} }
  }
  const oldHistory=[{role:'user',content:'old question'},{role:'assistant',content:'old answer'}]
  const response=await runPlayground({model:'alternate-model',message:'new question',history:oldHistory},dependencies)
  assert.equal(requests[0].model,'alternate-model')
  assert.equal(requests[0].messages[0].role,'system')
  assert.ok(requests[0].messages[0].content.startsWith(config.systemPrompt))
  assert.match(requests[0].messages[0].content,/系统内置输出协议/)
  assert.equal(response.content,'测试成功')
  assert.equal(response.action,'reply')
  assert.equal(response.contextCount,2)
  assert.equal(response.systemPromptApplied,true)
  await runPlayground({model:'alternate-model',message:'fresh test',history:[]},dependencies)
  assert.deepEqual(requests[1].messages,[requests[0].messages[0],{role:'user',content:'fresh test'}])
  await assert.rejects(runPlayground({model:'unconfigured-model',message:'test'},dependencies),/请选择/)
  assert.equal(requests.length,2)
  dependencies.retrieve=async()=>({nodes:[{text:'百炼返回的产品资料',score:.9,metadata:{}}],elapsedMs:4})
  const combined=await runPlayground({model:'alternate-model',message:'产品是什么',history:[],useBailian:true},dependencies)
  assert.doesNotMatch(requests[2].messages[0].content,/百炼返回的产品资料/);assert.match(requests[2].messages.at(-1).content,/百炼返回的产品资料/);assert.equal(combined.userMessage.content,'产品是什么')
  assert.equal(combined.retrieval.nodes.length,1)
  const manual=await runPlayground({model:'alternate-model',message:'转人工',history:[],useBailian:true},dependencies)
  assert.equal(manual.localDecision,true)
  assert.equal(requests.length,3)
})

test('selected test channel uses only its saved prompt between system and default',()=>{const settings={systemPrompt:'系统',defaultPromptTemplate:'默认',channelPrompts:{wechat_shop:'小店',whatsapp:'海外'},contextMessageCount:0};assert.equal(buildMessages({message:'问',channel:'wechat_shop'},settings).messages[0].content,'系统\n\n小店\n\n默认');assert.equal(buildMessages({message:'问'},settings).messages[0].content,'系统\n\n默认')});
