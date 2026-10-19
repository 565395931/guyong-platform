const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
function harness(affected=1){
 const queries=[],logs=[],events=[],moves=[];let invalidations=0;
 const modules={
 '../../config/database':{sequelize:{query:async(sql,options)=>{queries.push({sql,params:options.replacements});return sql.startsWith('UPDATE')?[undefined,{affectedRows:affected}]:[[{id:'fixture',updated_at:new Date(0)}]]}}},
 './pool.service':{clearPoolStatsCache:()=>invalidations++,logPoolAction:async log=>logs.push(log),movePool:async options=>{moves.push(options);return {success:true}}},
 './constants':require('./constants'),'../websocket/events':require('../websocket/events')};
 const box={module:{exports:{}},require:p=>modules[p],console:{log(){},error(){}},Date};
 vm.runInNewContext(fs.readFileSync(__dirname+'/pool-timer.service.js','utf8')+'\nmodule.exports.testing={processAiSelfPoolTimeout,processPrivatePoolStale,processAiSelfPoolStale,processAnsweredPublicPoolIdle};',box);
 return {service:box.module.exports.testing,queries,logs,events,moves,get invalidations(){return invalidations},emitter:{emit:(name,payload)=>events.push({name,payload})}};
}
for(const [name,fn,replyBy] of [['AI','processAiSelfPoolTimeout','ai'],['人工','processPrivatePoolStale','agent']]){
 test(name+'已回复后客户沉默直接归档，记录日志并刷新列表',async()=>{
 const h=harness();await h.service[fn]({},h.emitter);
 assert.equal(h.moves.length,0);assert.equal(h.logs[0].action,'auto_archive');assert.equal(h.events[0].payload.type,'archived');assert.equal(h.invalidations,1);
 const update=h.queries.find(q=>q.sql.startsWith('UPDATE'));assert.match(update.sql,/status = 'closed'/);assert.equal(update.params.replyBy,replyBy);assert.equal(update.params.archived,'archived');assert.match(update.sql,/updated_at <=> :observedUpdate/);assert.match(update.sql,/TIMESTAMPDIFF/);
 const selection=h.queries[0];assert.match(selection.sql,/last_reply_by = :replyBy/);assert.equal(selection.params.replyBy,replyBy);
 });
 test(name+'扫描后有新消息或被接管时，不误归档、不广播',async()=>{
 const h=harness(0);await h.service[fn]({},h.emitter);assert.equal(h.logs.length,0);assert.equal(h.events.length,0);assert.equal(h.invalidations,0);
 });
}
test('关闭客户沉默超时开关时不归档',async()=>{const h=harness();await h.service.processAiSelfPoolTimeout({ai_no_reply_timeout_enabled:false},h.emitter);await h.service.processPrivatePoolStale({private_pool_stale_timeout_enabled:false},h.emitter);assert.equal(h.queries.length,0)});
test('客户仍在等AI回复的会话保留转待人工兜底',async()=>{const h=harness();await h.service.processAiSelfPoolStale({},h.emitter);assert.equal(h.moves[0].targetPool,'pending_human');assert.equal(h.logs.length,0);assert.equal(h.queries[0].params.replyBy,'customer')});

test('旧规则已移到公共池的已回复会话按沉默时限归档',async()=>{const h=harness();await h.service.processAnsweredPublicPoolIdle({},h.emitter);assert.equal(h.logs.length,2);assert.ok(h.logs.every(x=>x.fromPool==='public'));assert.equal(h.queries[0].params.replyBy,'ai');assert.equal(h.queries[2].params.replyBy,'agent');assert.ok(h.queries.filter(x=>!x.sql.startsWith('UPDATE')).every(x=>/last_reply_by = :replyBy/.test(x.sql)))});
