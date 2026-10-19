const test=require('node:test'),assert=require('node:assert/strict')
const {createAiDeliveryFallback}=require('./aiDeliveryFallback')
function fixture(results,{canReply=true}={}) {
 const rows=new Map(),sent=[],transfers=[];
 const service=createAiDeliveryFallback({
  repo:{load:async id=>rows.get(id),claim:async id=>{const r=rows.get(id);if(r.content.aiDelivery.state!=='ready')return false;r.content.aiDelivery.state='processing';return true},status:async(id,status)=>{rows.get(id).status=status},finish:async(id,state)=>{rows.get(id).content.aiDelivery.state=state}},
  store:async(p,status)=>rows.set(p.localMessageId,{...p,senderType:'ai',status}),
  dispatch:async p=>{sent.push(p);return results.shift()||{success:true,status:'sent'}},
  transfer:async id=>transfers.push(id),eligible:async()=>canReply
 });
 return {service,rows,sent,transfers,payload:{localMessageId:'text-fixture',conversationId:'fixture',messageType:'text',content:{text:'测试答复'}}}
}
test('failed text transfers directly to pending human without any second send',async()=>{
 const f=fixture([{success:false,status:'failed'}]);const r=await f.service.sendText(f.payload);
 assert.equal(r.transferredToHuman,true);assert.deepEqual(f.sent.map(p=>p.messageType),['text']);assert.equal(f.transfers.length,1);
 await Promise.all([f.service.handle('text-fixture'),f.service.handle('text-fixture')]);assert.equal(f.sent.length,1);assert.equal(f.transfers.length,1);
})
test('late remote failure after acceptance transfers without supplementary delivery',async()=>{
 const f=fixture([{success:true,status:'accepted'}]);await f.service.sendText(f.payload);assert.equal(f.transfers.length,0);
 f.rows.get('text-fixture').status='failed';await f.service.handle('text-fixture');assert.equal(f.transfers.length,1);assert.equal(f.sent.length,1);
})
test('unknown send result transfers without repeat delivery',async()=>{
 const f=fixture([{success:false,status:'unknown'}]);assert.equal((await f.service.sendText(f.payload)).transferredToHuman,true);assert.equal(f.sent.length,1);
})
test('claimed conversations are not moved by late failed receipts',async()=>{
 const f=fixture([{success:false}],{canReply:false});assert.equal((await f.service.sendText(f.payload)).skipped,true);assert.equal(f.transfers.length,0);assert.equal(f.sent.length,0);
 f.rows.set('late',{localMessageId:'late',conversationId:'fixture',senderType:'ai',status:'failed',content:{aiDelivery:{state:'ready',epoch:0}}});
 assert.equal((await f.service.handle('late')).skipped,true);assert.equal(f.transfers.length,0);
})
test('successful text stays in AI and manual failures do not trigger AI handoff',async()=>{
 const f=fixture([{success:true,status:'sent'}]);await f.service.sendText(f.payload);assert.equal(f.transfers.length,0);
 f.rows.get('text-fixture').senderType='agent';f.rows.get('text-fixture').status='failed';await f.service.handle('text-fixture');assert.equal(f.transfers.length,0);
})
test('legacy failed AI image records transfer directly with no new image',async()=>{
 const f=fixture([]);f.rows.set('legacy',{localMessageId:'legacy',conversationId:'fixture',senderType:'ai',messageType:'image',status:'failed',content:{aiDelivery:{state:'ready',stage:'image'}}});
 await f.service.handle('legacy');assert.equal(f.sent.length,0);assert.equal(f.transfers.length,1);
})

test('runtime status SQL binds every named parameter with the actual MySQL dialect',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{Sequelize}=require('sequelize')
 const {injectReplacements}=require('sequelize/lib/utils/sql')
 const dialect=new Sequelize('mysql://fixture:unused@127.0.0.1/fixture',{logging:false})
 const queries=[]
 const sequelize={query:async(sql,options)=>{const bound=injectReplacements(sql,dialect.dialect,options.replacements);assert.doesNotMatch(bound,/:status\b/);queries.push(bound);return sql.includes('FROM conversations') ? [[{pool_type:'ai_self',conv_status:'ai_serving',ai_epoch:0,claimed_by:null}]] : [[]]}}
 const box={module:{exports:{}},require:p=>p==='node:crypto'?require(p):p==='../../config/database'?{sequelize}:p==='./aiReplyPolicy'?require('./aiReplyPolicy'):p==='../messaging/messaging.service'?{sendAiReply:async()=>({success:true})}:p==='./replyImage'?{}:{}}
 vm.runInNewContext(fs.readFileSync(__dirname+'/aiDeliveryFallback.js','utf8'),box)
 try {
  await box.module.exports.runtime().sendText({localMessageId:'fixture',conversationId:'fixture',content:{text:'测试'}},async()=>({success:false,status:'failed'}))
  assert.ok(queries.some(sql=>sql.startsWith('UPDATE plat_messages SET send_status=')))
 } finally {await dialect.close()}
})
