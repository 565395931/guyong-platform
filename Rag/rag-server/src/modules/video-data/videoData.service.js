const PLATFORM_OPTIONS = Object.freeze([
  { value: 'douyin', label: '抖音' },
  { value: 'kuaishou', label: '快手' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'wechat_channel', label: '视频号' },
  { value: 'taobao', label: '淘宝' },
  { value: 'pinduoduo', label: '拼多多' },
  { value: 'alibaba1688', label: '1688' },
  { value: 'other', label: '其他' }
])

const PLATFORM_LABELS = Object.freeze(
  Object.fromEntries(PLATFORM_OPTIONS.map(option => [option.value, option.label]))
)

function normalizeText(value) {
  return String(value == null ? '' : value).trim()
}

function parseDate(value) {
  const clean = normalizeText(value)
  if (!clean) return ''
  const directMatch = clean.match(/^\d{4}-\d{2}-\d{2}$/)
  if (directMatch) return directMatch[0]
  const parsed = new Date(clean)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

function normalizeCount(value, fieldName) {
  const number = Number(value)
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    return { error: `${fieldName}必须是非负整数` }
  }
  return { value: number }
}

function normalizeVideoDataInput(input = {}) {
  const dataDate = parseDate(input.dataDate ?? input.date)
  if (!dataDate) return { error: '日期不能为空' }

  const accountNo = normalizeText(input.accountNo ?? input.account ?? input.account_number)
  if (!accountNo) return { error: '账号不能为空' }
  if (accountNo.length > 100) return { error: '账号不能超过100个字符' }

  const platform = normalizeText(input.platform).toLowerCase()
  if (!platform) return { error: '平台不能为空' }
  if (platform.length > 50) return { error: '平台不能超过50个字符' }

  const playCount = normalizeCount(input.playCount ?? input.play_count ?? input.viewsCount ?? input.views_count, '播放量')
  if (playCount.error) return playCount
  const likeCount = normalizeCount(input.likeCount ?? input.like_count, '点赞量')
  if (likeCount.error) return likeCount
  const commentCount = normalizeCount(input.commentCount ?? input.comment_count, '评论数')
  if (commentCount.error) return commentCount
  const inquiryCount = normalizeCount(input.inquiryCount ?? input.inquiry_count, '有效询盘')
  if (inquiryCount.error) return inquiryCount
  const intentCustomerCount = normalizeCount(input.intentCustomerCount ?? input.intent_customer_count, '意向客户数')
  if (intentCustomerCount.error) return intentCustomerCount
  const dealCount = normalizeCount(input.dealCount ?? input.deal_count, '成交数')
  if (dealCount.error) return dealCount

  const remark = normalizeText(input.remark ?? input.note ?? '')
  if (remark.length > 255) return { error: '备注不能超过255个字符' }

  return {
    data: {
      dataDate,
      accountNo,
      platform,
      playCount: playCount.value,
      likeCount: likeCount.value,
      commentCount: commentCount.value,
      inquiryCount: inquiryCount.value,
      intentCustomerCount: intentCustomerCount.value,
      dealCount: dealCount.value,
      remark
    }
  }
}

function presentVideoDataRecord(row = {}) {
  return {
    id: row.id,
    dataDate: row.data_date || row.dataDate || null,
    accountNo: row.account_no || row.accountNo || '',
    platform: row.platform || '',
    platformLabel: PLATFORM_LABELS[row.platform] || row.platform || '',
    playCount: Number(row.play_count ?? row.playCount ?? 0),
    likeCount: Number(row.like_count ?? row.likeCount ?? 0),
    commentCount: Number(row.comment_count ?? row.commentCount ?? 0),
    inquiryCount: Number(row.inquiry_count ?? row.inquiryCount ?? 0),
    intentCustomerCount: Number(row.intent_customer_count ?? row.intentCustomerCount ?? 0),
    dealCount: Number(row.deal_count ?? row.dealCount ?? 0),
    remark: row.remark || '',
    createdBy: row.created_by ?? row.createdBy ?? null,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null
  }
}

function buildVideoDataSummary(rows = []) {
  return rows.reduce((summary, row) => ({
    totalRecords: summary.totalRecords + 1,
    playCount: summary.playCount + Number(row.playCount ?? row.play_count ?? 0),
    likeCount: summary.likeCount + Number(row.likeCount ?? row.like_count ?? 0),
    commentCount: summary.commentCount + Number(row.commentCount ?? row.comment_count ?? 0),
    inquiryCount: summary.inquiryCount + Number(row.inquiryCount ?? row.inquiry_count ?? 0),
    intentCustomerCount: summary.intentCustomerCount + Number(row.intentCustomerCount ?? row.intent_customer_count ?? 0),
    dealCount: summary.dealCount + Number(row.dealCount ?? row.deal_count ?? 0)
  }), {
    totalRecords: 0,
    playCount: 0,
    likeCount: 0,
    commentCount: 0,
    inquiryCount: 0,
    intentCustomerCount: 0,
    dealCount: 0
  })
}

function csvEscape(value) {
  const text = String(value == null ? '' : value)
  if (/["\n,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function buildVideoDataCsv(rows = []) {
  const header = ['ID', '日期', '账号', '平台', '播放量', '点赞量', '评论', '有效询盘', '意向客户数', '成交数', '备注']
  const lines = [header.join(',')]

  for (const row of rows) {
    lines.push([
      row.id,
      row.dataDate || row.data_date || '',
      row.accountNo || row.account_no || '',
      row.platformLabel || PLATFORM_LABELS[row.platform] || row.platform || '',
      row.playCount ?? row.play_count ?? 0,
      row.likeCount ?? row.like_count ?? 0,
      row.commentCount ?? row.comment_count ?? 0,
      row.inquiryCount ?? row.inquiry_count ?? 0,
      row.intentCustomerCount ?? row.intent_customer_count ?? 0,
      row.dealCount ?? row.deal_count ?? 0,
      row.remark || ''
    ].map(csvEscape).join(','))
  }

  return `\ufeff${lines.join('\n')}`
}

module.exports = {
  PLATFORM_OPTIONS,
  PLATFORM_LABELS,
  normalizeText,
  parseDate,
  normalizeCount,
  normalizeVideoDataInput,
  presentVideoDataRecord,
  buildVideoDataSummary,
  buildVideoDataCsv
}

