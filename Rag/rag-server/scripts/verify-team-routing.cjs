// Explicit, isolated MySQL verification; never uses real conversations or sends messages.
require('dotenv').config({ quiet: true })
const assert = require('node:assert/strict')
const { Sequelize } = require('sequelize')
const { EventEmitter } = require('node:events')
const { sequelize: source } = require('../src/config/database')
const { createWorkspaceService } = require('../src/modules/conversation-pool/workspace.service')
const { isAiReplyEligible } = require('../src/modules/conversation-pool/aiReplyPolicy')
const { createAiDeliveryFallback } = require('../src/modules/conversation-pool/aiDeliveryFallback')
const { createSeatAssignmentService } = require('../src/modules/conversation-pool/seatAssignment.service')

async function verifyRealtime(fixture) {
  const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http'), jwt = require('jsonwebtoken')
  const { io: connect } = require('../../platform-web/node_modules/socket.io-client')
  const events = require('../src/modules/websocket/events'), constants = require('../src/modules/conversation-pool/constants')
  await fixture.query(`ALTER TABLE conversations ADD COLUMN channel VARCHAR(30) DEFAULT 'wechat_shop', ADD COLUMN user_id VARCHAR(60), ADD COLUMN user_name VARCHAR(60),
    ADD COLUMN last_reply_by VARCHAR(20), ADD COLUMN last_reply_time DATETIME, ADD COLUMN last_message TEXT,
    ADD COLUMN last_message_time DATETIME, ADD COLUMN unread_count INT DEFAULT 0`)
  await fixture.query('ALTER TABLE seat_status ADD COLUMN manual_offline TINYINT DEFAULT 0')
  await fixture.query("UPDATE seat_account_bindings SET status=IF(seat_id IN (1,2),'active','inactive')")
  await fixture.query("INSERT INTO conversations (id,account_id,pool_type,conv_status,status,user_id) VALUES ('ai-watch',10,'ai_self','ai_serving','open','fixture-customer')")
  const secret = 'isolated-realtime-test-only'
  const pool = {
    updateSeatStatus: (userId,status) => fixture.query('UPDATE seat_status SET status=:status WHERE user_id=:userId',{replacements:{userId,status}}),
    releaseOnSeatOffline: async()=>0, getPoolStats: async()=>({})
  }
  const modules = {
    'socket.io': require('socket.io'), jsonwebtoken: jwt,
    './events': events, '../conversation-pool/constants': constants,
    '../conversation-pool/pool.service': pool, '../../config/database': {sequelize:fixture},
    '../conversation-pool/workspace.service': {createWorkspaceService},
    '../conversation-pool/workspacePolicy': require('../src/modules/conversation-pool/workspacePolicy'),
    '../../models/User': {findByPk:async id=>{const [rows]=await fixture.query('SELECT * FROM users WHERE id=:id',{replacements:{id}});return rows[0]}}
  }
  const errors = []
  const context = { module:{exports:{}}, require:name=>{if(!modules[name])throw Error(`Unmapped module ${name}`);return modules[name]},
    process:{env:{JWT_SECRET:secret,SEAT_OFFLINE_GRACE_MS:'1'}}, console:{log(){},warn(){},error:(...args)=>errors.push(args.join(' '))},
    Map,Set,Date,Number,setTimeout,clearTimeout }
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/websocket/socketHandler'),'utf8'),context)
  const handler = context.module.exports, bus = new EventEmitter(), server = http.createServer()
  const socketServer = handler.initializeSocket(server,bus)
  const pushModules = {...modules,'./socketHandler':handler}
  const pushContext = {...context,module:{exports:{}},require:name=>{if(!pushModules[name])throw Error(`Unmapped module ${name}`);return pushModules[name]}}
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/websocket/pushService'),'utf8'),pushContext)
  pushContext.module.exports.initializePushService(bus)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const clients=[], received=[[],[],[]]
  let phase='connect rooms'
  const waitUntil=async condition=>{
    for(let i=0;i<100;i++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,10))}
    throw Error('Realtime verification timed out: '+phase+'; '+errors.join('; '))
  }
  try {
    for(const id of [1,2,3]) {
      const client=connect(`http://127.0.0.1:${server.address().port}`,{autoConnect:false,transports:['websocket'],reconnection:false,
        auth:{token:jwt.sign({id,role:'agent'},secret)}})
      client.on('new_message',message=>received[id-1].push(message));clients.push(client)
      const connected=new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject)})
      client.connect();await connected
    }
    await waitUntil(()=>[...socketServer.sockets.sockets.values()].filter(socket=>socket.rooms.has('account:10:ai')).length===2)
    phase='AI room membership'
    clients[0].emit('join_conversation','ai-watch')
    await waitUntil(()=>[...socketServer.sockets.sockets.values()].some(socket=>socket.userId===1&&socket.rooms.has('conversation:ai-watch')))
    const emitMessage=id=>bus.emit(events.INTERNAL_EVENTS.NEW_MESSAGE,{conversationId:'ai-watch',messageId:id,direction:'outbound',senderType:'ai',messageType:'text',content:{text:'fixture'}})
    phase='bound AI broadcast'
    emitMessage('watch-1')
    await waitUntil(()=>received[0].length===1&&received[1].length===1)
    assert.equal(received[2].length,0)
    await fixture.query("UPDATE seat_account_bindings SET status='inactive' WHERE seat_id=1")
    await handler.syncSeatAccountRooms(1,{notify:true})
    phase='binding revoked';received.forEach(list=>list.length=0);emitMessage('watch-2')
    await waitUntil(()=>received[1].length===1)
    assert.equal(received[0].length,0);assert.equal(received[2].length,0)
    await fixture.query("UPDATE seat_account_bindings SET status='active' WHERE seat_id=1")
    await handler.syncSeatAccountRooms(1)
    await fixture.query("UPDATE conversations SET pool_type='pending_human',conv_status='pending_claim',agent_id=2 WHERE id='ai-watch'")
    phase='seat-specific pending';received.forEach(list=>list.length=0);emitMessage('pending-1')
    await waitUntil(()=>received[1].length===1)
    assert.equal(received[0].length,0);assert.equal(received[2].length,0)
    assert.deepEqual(errors,[])
  } finally {
    clients.forEach(client=>client.disconnect())
    await new Promise(resolve=>setTimeout(resolve,20))
    await new Promise(resolve=>socketServer.close(resolve))
    if(server.listening) await new Promise(resolve=>server.close(resolve))
  }
}

async function main() {
  const database = `rag_team_validation_${Date.now()}_${process.pid}`
  if (!/^rag_team_validation_\d+_\d+$/.test(database) || database === source.config.database) throw new Error('Unsafe fixture database name')
  let fixture
  try {
    await source.query(`CREATE DATABASE \`${database}\``)
    fixture = new Sequelize(database, source.config.username, source.config.password, {
      dialect: 'mysql', host: source.config.host, port: source.config.port, logging: false, timezone: '+00:00'
    })
    const definitions = [
      'CREATE TABLE workspace_dispatch_lock (id INT PRIMARY KEY)',
      'INSERT INTO workspace_dispatch_lock VALUES (1)',
      'CREATE TABLE channel_accounts (id INT PRIMARY KEY, status VARCHAR(20))',
      "INSERT INTO channel_accounts VALUES (10, 'active'), (11, 'active'), (12, 'inactive')",
      'CREATE TABLE users (id INT PRIMARY KEY, username VARCHAR(40), role VARCHAR(20), status VARCHAR(20), max_concurrent INT)',
      'CREATE TABLE seat_status (user_id INT PRIMARY KEY, status VARCHAR(20), updated_at DATETIME)',
      'CREATE TABLE conversation_seat_history (user_id INT,conversation_id VARCHAR(36),first_reply_at DATETIME,last_reply_at DATETIME,PRIMARY KEY(user_id,conversation_id))',
      'CREATE TABLE conversation_seat_daily (user_id INT,conversation_id VARCHAR(36),service_day DATE,first_reply_at DATETIME,PRIMARY KEY(user_id,conversation_id,service_day))',
      'CREATE TABLE seat_account_bindings (seat_id INT, account_id INT, status VARCHAR(20))',
      `CREATE TABLE conversations (id VARCHAR(36) PRIMARY KEY, account_id INT, pool_type VARCHAR(20), conv_status VARCHAR(20),
        status VARCHAR(20), claimed_by INT NULL, agent_id INT NULL, claimed_at DATETIME NULL, priority INT DEFAULT 0, ai_epoch INT DEFAULT 0, pending_since DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE conversation_pool_logs (conversation_id VARCHAR(36), action VARCHAR(30), from_pool VARCHAR(20), to_pool VARCHAR(20),
        operator_id INT NULL, operator_name VARCHAR(40), operator_type VARCHAR(20), reason VARCHAR(255), created_at DATETIME)`
    ]
    for (const sql of definitions) await fixture.query(sql)
    for (const id of [1, 2, 3]) {
      await fixture.query(`INSERT INTO users VALUES (:id, :username, 'agent', 'active', 5)`, { replacements: { id, username: `fixture${id}` } })
      await fixture.query("INSERT INTO seat_status VALUES (:id, 'online', NOW())", { replacements: { id } })
      await fixture.query("INSERT INTO seat_account_bindings VALUES (:id, 10, 'active')", { replacements: { id } })
    }
    await fixture.query("INSERT INTO conversations (id, account_id, pool_type, conv_status, status, claimed_by) VALUES ('old-archived', 10, 'private', 'archived', 'closed', 1)")
    for (let i = 0; i < 7; i++) await fixture.query("INSERT INTO conversations (id, account_id, pool_type, conv_status, status,pending_since) VALUES (:id, 10, 'pending_human', 'pending_claim', 'open',DATE_SUB(NOW(),INTERVAL 11 SECOND))", { replacements: { id: `fixture-${i}` } })
    await fixture.query("INSERT INTO conversations (id, account_id, pool_type, conv_status, status) VALUES ('unbound', 11, 'pending_human', 'pending_claim', 'open')")
    await fixture.query("INSERT INTO conversations (id, account_id, pool_type, conv_status, status) VALUES ('inactive-channel', 12, 'pending_human', 'pending_claim', 'open')")
    const emitted = []
    const events = new EventEmitter()
    events.on('conversationUpdate', event => emitted.push(event.conversationId))
    const options = { sequelize: fixture, eventEmitter: events, poolService: { clearPoolStatsCache() {} },
      connectedSeatIds: () => [1, 2, 3], removePendingJobs: async () => {} }
    const first = createSeatAssignmentService(options)
    const second = createSeatAssignmentService(options)
    const totals = await Promise.all([first.kick(), second.kick()])
    assert.equal(totals.reduce((a, b) => a + b, 0), 7)
    const [loads] = await fixture.query("SELECT agent_id, COUNT(*) AS count FROM conversations WHERE agent_id IS NOT NULL AND conv_status = 'pending_claim' GROUP BY agent_id")
    assert.deepEqual(loads.map(row => Number(row.count)).sort(), [2, 2, 3])
    assert.equal(new Set(emitted).size, 7)
    const [unbound] = await fixture.query("SELECT claimed_by FROM conversations WHERE id = 'unbound'")
    assert.equal(unbound[0].claimed_by, null)
    const [inactive] = await fixture.query("SELECT claimed_by FROM conversations WHERE id = 'inactive-channel'")
    assert.equal(inactive[0].claimed_by, null)
    // A recent entry remains in Admin pending for at least ten seconds.
    await fixture.query("INSERT INTO conversations (id,account_id,pool_type,conv_status,status,pending_since) VALUES ('delay',10,'pending_human','pending_claim','open',NOW())")
    assert.equal(await first.kick(),0)
    await fixture.query("UPDATE conversations SET pending_since=DATE_SUB(NOW(),INTERVAL 11 SECOND) WHERE id='delay'")
    await fixture.query("UPDATE seat_status SET status='offline'")
    assert.equal(await first.kick(),0)
    await fixture.query("UPDATE seat_account_bindings SET status='inactive' WHERE seat_id IN (2,3)")
    const disconnected = createSeatAssignmentService({...options,connectedSeatIds:()=>[]})
    assert.equal(await disconnected.kick(),1)
    const [sole] = await fixture.query("SELECT agent_id,claimed_by,pool_type FROM conversations WHERE id='delay'")
    assert.equal(sole[0].agent_id,1);assert.equal(sole[0].claimed_by,null);assert.equal(sole[0].pool_type,'pending_human')
    const workspace=createWorkspaceService({sequelize:fixture})
    assert.equal((await workspace.takeOver('delay',1,{countReply:true})).success,true)
    assert.equal(await workspace.dailyCount(1),1)
    assert.equal((await workspace.takeOver('delay',1,{countReply:true})).success,true)
    assert.equal(await workspace.dailyCount(1),1)
    await fixture.query("UPDATE conversations SET pool_type='ai_self',conv_status='ai_serving',claimed_by=NULL,agent_id=NULL,ai_epoch=ai_epoch+1 WHERE id='delay'")
    assert.equal(await workspace.canView(1,'agent','delay'),true)
    const [history]=await fixture.query("SELECT * FROM conversation_seat_history WHERE user_id=1 AND conversation_id='delay'")
    assert.equal(history.length,1)
    let dispatched=0
    const fallback=createAiDeliveryFallback({repo:{},store:async()=>{throw new Error('stale output must not be stored')},dispatch:async()=>{dispatched++;return {success:true}},
      transfer:async()=>{throw new Error('stale callback must not transfer')},
      eligible:async(id,epoch)=>{const [rows]=await fixture.query('SELECT * FROM conversations WHERE id=:id',{replacements:{id}});return isAiReplyEligible(rows[0])&&Number(rows[0].ai_epoch)===Number(epoch)}})
    assert.equal((await fallback.sendText({conversationId:'delay',aiEpoch:0,content:{text:'fixture'}})).skipped,true)
    assert.equal(dispatched,0)
    await fixture.query("UPDATE conversations SET status='closed',conv_status='archived',ai_epoch=ai_epoch+1 WHERE id='delay'")
    assert.equal((await workspace.takeOver('delay',1,{countReply:true})).success,false)
    assert.equal((await workspace.reserve('delay',1,1)).success,false)
    await verifyRealtime(fixture)
    console.log(JSON.stringify({ passed: true, checks:['concurrent reservation 3/2/2','10-second delay','pending stays pending','multi-seat offline excluded','sole offline seat still assigned','reply day count deduplicated','My membership survives AI','stale AI epoch cannot dispatch','archive blocks takeover and reassignment','bound AI realtime visible','unbound AI realtime excluded','revoked seat loses AI room','pending realtime seat-specific'], realMessagesSent: 0 }))
  } finally {
    if (fixture) await fixture.close()
    await source.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await source.close()
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
