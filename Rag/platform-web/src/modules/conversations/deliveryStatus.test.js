import test from 'node:test'
import assert from 'node:assert/strict'
import {mergeDeliveryStatus} from './deliveryStatus.js'
test('迟到响应不覆盖成功或不确定回执，明确拒绝可重试',()=>{
 assert.equal(mergeDeliveryStatus('sent','unknown'),'sent')
 assert.equal(mergeDeliveryStatus('failed','received'),'failed')
 assert.equal(mergeDeliveryStatus('unknown','accepted'),'unknown')
 assert.equal(mergeDeliveryStatus('received','failed'),'failed')
 assert.equal(mergeDeliveryStatus('unknown','sent'),'sent')
})
