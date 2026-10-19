const test = require('node:test')
const assert = require('node:assert/strict')
const { isAiReplyEligible } = require('./aiReplyPolicy')
test('仅AI池自动回复，待人工停止自动回复', () => {
 assert.equal(isAiReplyEligible({pool_type:'ai_self',conv_status:'ai_serving',claimed_by:null}),true)
 assert.equal(isAiReplyEligible({pool_type:'pending_human',conv_status:'pending_claim',claimed_by:null}),false)
})
test('认领、归档和长期跟进阻止回复，返回AI后恢复', () => {
 for(const s of [{pool_type:'private',conv_status:'handling',claimed_by:1},{pool_type:'pending_human',conv_status:'pending_claim',claimed_by:1},{pool_type:'ai_self',conv_status:'archived'},{pool_type:'long_term',conv_status:'following',claimed_by:1}]) assert.equal(isAiReplyEligible(s),false)
 assert.equal(isAiReplyEligible({poolType:'ai_self',convStatus:'ai_serving',claimedBy:null}),true)
})
