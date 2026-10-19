const test = require('node:test')
const assert = require('node:assert/strict')
const { appendReplyProtocol, parseReplyDecision, explicitHumanRequest } = require('./replyProtocol')
test('valid reply, clarification and handoff decisions expose only customer text', () => {
  for (const action of ['reply','clarify','handoff']) {
    const value={action,reply:'客户可见内容',reason:action==='handoff'?'knowledge_gap':null}
    assert.deepEqual(parseReplyDecision(JSON.stringify(value)),value)
  }
})
test('malformed, wrapped, empty and invented decisions are rejected', () => {
  for (const raw of ['hello','```json\n{}\n```','null','[]',JSON.stringify({action:'reply',reply:'',reason:null}),JSON.stringify({action:'reply',reply:'ok',reason:'knowledge_gap'}),JSON.stringify({action:'handoff',reply:'ok',reason:'invented'}),JSON.stringify({action:'delete',reply:'ok',reason:null}),JSON.stringify({action:'reply',reply:'ok',reason:null,command:'send'})]) assert.throws(()=>parseReplyDecision(raw))
})
test('business prompt remains intact with the fixed protocol appended', () => {
  assert.ok(appendReplyProtocol('业务内容').startsWith('业务内容\n\n'))
  assert.match(appendReplyProtocol('业务内容'),/问候闲聊正常reply/)
  assert.equal(explicitHumanRequest('请转人工'),true)
  assert.equal(explicitHumanRequest('你好'),false)
})
