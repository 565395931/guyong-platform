const test = require('node:test')
const assert = require('node:assert/strict')

const {
  PLATFORM_LABELS,
  normalizeVideoDataInput,
  presentVideoDataRecord,
  buildVideoDataSummary,
  buildVideoDataCsv
} = require('./videoData.service')

test('normalizes a video data record and maps presentation fields', () => {
  const result = normalizeVideoDataInput({
    dataDate: '2026-08-05',
    accountNo: ' 15295155085 ',
    platform: 'douyin',
    playCount: '2276',
    likeCount: 0,
    commentCount: 3,
    inquiryCount: 1,
    intentCustomerCount: 2,
    dealCount: 0,
    remark: '  新品首发  '
  })

  assert.equal(result.error, undefined)
  assert.equal(result.data.accountNo, '15295155085')
  assert.equal(result.data.remark, '新品首发')
  assert.equal(PLATFORM_LABELS.douyin, '抖音')

  const presented = presentVideoDataRecord({
    id: 9,
    data_date: '2026-08-05',
    account_no: '15295155085',
    platform: 'douyin',
    play_count: 2276,
    like_count: 0,
    comment_count: 3,
    inquiry_count: 1,
    intent_customer_count: 2,
    deal_count: 0,
    remark: '新品首发'
  })

  assert.equal(presented.platformLabel, '抖音')
  assert.equal(presented.playCount, 2276)
})

test('rejects invalid video data input', () => {
  assert.match(normalizeVideoDataInput({}).error, /日期/)
  assert.match(
    normalizeVideoDataInput({
      dataDate: '2026-08-05',
      accountNo: '152',
      platform: 'douyin',
      playCount: -1,
      likeCount: 0,
      commentCount: 0,
      inquiryCount: 0,
      intentCustomerCount: 0,
      dealCount: 0
    }).error,
    /播放量/
  )
})

test('builds a total summary and a csv export', () => {
  const summary = buildVideoDataSummary([
    { playCount: 65, likeCount: 0, commentCount: 0, inquiryCount: 0, intentCustomerCount: 0, dealCount: 0 },
    { playCount: 2276, likeCount: 2, commentCount: 1, inquiryCount: 2, intentCustomerCount: 1, dealCount: 0 }
  ])

  assert.deepEqual(summary, {
    totalRecords: 2,
    playCount: 2341,
    likeCount: 2,
    commentCount: 1,
    inquiryCount: 2,
    intentCustomerCount: 1,
    dealCount: 0
  })

  const csv = buildVideoDataCsv([
    {
      id: 3,
      dataDate: '2026-08-05',
      accountNo: '15295155085',
      platformLabel: '小红书',
      playCount: 65,
      likeCount: 0,
      commentCount: 0,
      inquiryCount: 0,
      intentCustomerCount: 0,
      dealCount: 0,
      remark: '首发,主推'
    }
  ])

  assert.match(csv, /^\ufeffID,日期,账号,平台,播放量,点赞量,评论,有效询盘,意向客户数,成交数,备注/)
  assert.match(csv, /"首发,主推"/)
})

