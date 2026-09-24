const STAGE_LABELS = {
  first: '首次沟通',
  second: '二次沟通',
  third: '三次沟通'
}

export function stageLabel(code, index = null) {
  if (STAGE_LABELS[code]) return STAGE_LABELS[code]
  return index ? `第${Number(index)}次沟通` : '沟通'
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeDailyReport(payload = {}) {
  const source = payload.report || payload
  const details = payload.customers || source.details || []
  return {
    reportDate: source.reportDate || source.report_date || '',
    customerCount: number(source.customerCount ?? source.customer_count),
    firstCount: number(source.firstCount ?? source.first_count),
    secondCount: number(source.secondCount ?? source.second_count),
    thirdCount: number(source.thirdCount ?? source.third_count),
    wonCount: number(source.wonCount ?? source.won_count),
    dueCount: number(source.dueCount ?? source.due_count),
    overdueCount: number(source.overdueCount ?? source.overdue_count),
    summary: source.summary || '',
    generatedAt: source.generatedAt || source.generated_at || '',
    source: source.source || 'deterministic',
    details: Array.isArray(details) ? details.map(item => {
      const communicationIndex = number(item.communicationIndex ?? item.communication_index)
      const stageCode = item.stageCode || item.stage_code || item.stageLabel || item.stage_label
      return {
        ...item,
        communicationIndex,
        messageCount: number(item.messageCount ?? item.message_count),
        stageCode,
        stageLabel: stageLabel(stageCode, communicationIndex),
        summary: item.summary || 'AI 摘要生成中'
      }
    }) : []
  }
}
