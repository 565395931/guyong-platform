function createAiDeliveryFallback({repo,store,dispatch,transfer,eligible,emit=()=>{}}) {
  async function update(id,result) {
    const status = result.status === 'unknown' ? 'unknown' : result.success ? (result.status === 'accepted' ? 'received' : 'sent') : 'failed'
    await repo.status(id,status,result.error)
    await emit(id,status,result.error)
    return status
  }
  async function safeDispatch(payload,send=dispatch) {
    try { const result=await send(payload);return result?.transport==='noop'?{success:false,status:'failed',error:'发送渠道尚未接入'}:result || {success:false,status:'failed',error:'未获得发送回执'} } catch(error) {
      return {success:false,status:['TimeoutError','AbortError','TypeError'].includes(error.name)?'unknown':'failed',error:'AI回复发送未完成'}
    }
  }
  async function handoff(row) {
    if (!await eligible(row.conversationId, row.content?.aiDelivery?.epoch)) {await repo.finish?.(row.localMessageId,'skipped');return {skipped:true}}
    const transferred = await transfer(row.conversationId,'AI回复发送失败，请人工处理',row.content?.aiDelivery?.epoch)
    if (transferred?.skipped) { await repo.finish?.(row.localMessageId,'skipped'); return {skipped:true} }
    await repo.finish?.(row.localMessageId,'done')
    return {transferredToHuman:true}
  }
  async function handle(id,send=dispatch) {
    const row = await repo.load(id)
    if (!row || row.senderType !== 'ai' || !row.content?.aiDelivery || !['failed','unknown'].includes(row.status)) return {}
    if (!await repo.claim(id)) return {}
    if (!await eligible(row.conversationId, row.content?.aiDelivery?.epoch)) {await repo.finish?.(row.localMessageId,'skipped');return {skipped:true}}
    return handoff(row)
  }
  async function sendText(payload,send=dispatch) {
    if (!await eligible(payload.conversationId, payload.aiEpoch)) return { skipped:true, status:'cancelled' }
    const text = {...payload,content:{...payload.content,aiDelivery:{stage:'text',state:'ready',epoch:payload.aiEpoch ?? 0}}}
    // Persist before sending so fast remote receipts can always find their target.
    await store(text,'received')
    if (!await eligible(payload.conversationId, payload.aiEpoch)) {
      await repo.status(text.localMessageId,'cancelled','人工已接管，AI回复作废')
      await repo.finish?.(text.localMessageId,'skipped')
      await emit(text.localMessageId,'cancelled','人工已接管，AI回复作废')
      return { skipped:true,status:'cancelled' }
    }
    const status = await update(text.localMessageId,await safeDispatch(text,send))
    return {status,...(['failed','unknown'].includes(status)?await handle(text.localMessageId,send):{})}
  }
  return {sendText,handle}
}

function runtime(eventEmitter) {
  const {sequelize}=require('../../config/database')
  const parse=value=>typeof value==='string'?JSON.parse(value):value
  const repo={
    async load(id) {
      const [rows]=await sequelize.query(`SELECT m.id,m.conversation_id,m.channel,m.account_id,m.user_id,m.sender_type,m.message_type,m.content,m.send_status
        FROM plat_messages m WHERE m.id=:id LIMIT 1`,{replacements:{id}})
      const r=rows[0]; return r?{localMessageId:r.id,conversationId:r.conversation_id,channel:r.channel,accountId:r.account_id,targetUserId:r.user_id,senderType:r.sender_type,messageType:r.message_type,content:parse(r.content),status:r.send_status}:null
    },
    async claim(id) {
      return sequelize.transaction(async transaction=>{
        const [rows]=await sequelize.query("SELECT send_status,content FROM plat_messages WHERE id=:id FOR UPDATE",{replacements:{id},transaction})
        const row=rows[0]
        if (!row || !['failed','unknown'].includes(row.send_status) || parse(row.content)?.aiDelivery?.state!=='ready') return false
        await sequelize.query("UPDATE plat_messages SET content=JSON_SET(content,'$.aiDelivery.state','processing'),updated_at=NOW() WHERE id=:id",{replacements:{id},transaction})
        return true
      })
    },
    async finish(id,state) {
      await sequelize.query("UPDATE plat_messages SET content=JSON_SET(content,'$.aiDelivery.state',:state),updated_at=NOW() WHERE id=:id",{replacements:{id,state}})
    },
    async status(id,status,error) {
      await sequelize.query(`UPDATE plat_messages SET send_status=CASE WHEN send_status IN ('sent','failed','unknown') AND :status = 'received' THEN send_status WHEN send_status='sent' THEN 'sent' ELSE :status END,
        content=CASE WHEN :status IN ('failed','unknown') THEN JSON_SET(content,'$.sendError',:error) ELSE content END,updated_at=NOW() WHERE id=:id`,
      {replacements:{id,status,error:error||'发送未完成'}})
    }
  }
  return createAiDeliveryFallback({repo,
    store:async(p,status)=>{const result=await require('../messaging/messaging.service').sendAiReply({id:p.localMessageId,conversationId:p.conversationId,content:p.content,messageType:p.messageType,sendStatus:status},eventEmitter);if(!result.success)throw Error('AI回复记录未保存')},
    dispatch:p=>{const d=require('../cloud-gateway/runtime').getDispatcher();if(!d)throw Error('发送通道未就绪');return d.dispatch(p)},
    eligible:async (id,epoch)=>{const [rows]=await sequelize.query('SELECT pool_type,conv_status,status,ai_epoch,claimed_by FROM conversations WHERE id=:id',{replacements:{id}});return require('./aiReplyPolicy').isAiReplyEligible(rows[0]||{}) && Number(rows[0]?.ai_epoch||0)===Number(epoch??0)},
    transfer:async(id,reason,epoch)=>{const result=await require('./pool.service').aiTransferToHuman(id,reason,eventEmitter,null,{expectedEpoch:epoch??0});if(!result.success) return {skipped:true}},
    emit:async(id,status,error)=>{const row=await repo.load(id);eventEmitter?.emit(require('../websocket/events').INTERNAL_EVENTS.MESSAGE_UPDATE,{conversationId:row?.conversationId,messageId:id,sendStatus:row?.status||status,errorMessage:error||null})}
  })
}
function startRecovery(eventEmitter) {
  let busy=false
  const sweep=async()=>{
    if(busy)return
    busy=true
    try {
      const {sequelize}=require('../../config/database')
      // Recover interrupted delivery checks and transfer failed replies to pending human.
      await sequelize.query(`UPDATE plat_messages SET send_status='unknown',content=JSON_SET(content,'$.aiDelivery.state','ready','$.sendError','发送结果待确认，请人工核实'),updated_at=NOW()
        WHERE sender_type='ai' AND JSON_EXTRACT(content,'$.aiDelivery') IS NOT NULL
        AND ((send_status='received' AND JSON_UNQUOTE(JSON_EXTRACT(content,'$.aiDelivery.state'))='ready' AND updated_at<DATE_SUB(NOW(),INTERVAL 2 MINUTE))
          OR (send_status IN ('failed','unknown') AND JSON_UNQUOTE(JSON_EXTRACT(content,'$.aiDelivery.state'))='processing' AND updated_at<DATE_SUB(NOW(),INTERVAL 5 MINUTE)))`)
      const [rows]=await sequelize.query(`SELECT id FROM plat_messages WHERE sender_type='ai' AND send_status IN ('failed','unknown')
        AND JSON_UNQUOTE(JSON_EXTRACT(content,'$.aiDelivery.state'))='ready' ORDER BY created_at LIMIT 20`)
      const service=runtime(eventEmitter)
      for(const row of rows)await service.handle(row.id)
    } catch { console.error('[AiDelivery] 失败消息转人工恢复未完成，稍后重试') }
    finally {busy=false}
  }
  const timer=setInterval(sweep,30000);timer.unref()
  void sweep()
  return ()=>clearInterval(timer)
}
module.exports={createAiDeliveryFallback,runtime,startRecovery}
