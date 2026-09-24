import { stageLabel } from './customerReport.js'

const FOLLOWUP_STATUS = {
  completed: { code: 'completed', label: '已完成', tagType: 'success' },
  skipped: { code: 'skipped', label: '已跳过', tagType: 'info' },
  cancelled: { code: 'cancelled', label: '已取消', tagType: 'info' },
  due: { code: 'due', label: '待复联', tagType: 'warning' },
  pending: { code: 'pending', label: '待复联', tagType: 'warning' }
}

function parseDateTime(value) {
  if (!value) return null
  const parsed = new Date(String(value).replace(' ', 'T'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function followupStatusMeta(followup = {}, now = new Date()) {
  const status = String(followup.status || 'pending')
  if (['completed', 'skipped', 'cancelled'].includes(status)) {
    return FOLLOWUP_STATUS[status]
  }

  const dueAt = parseDateTime(followup.dueAt || followup.due_at)
  if (dueAt && dueAt.getTime() < now.getTime()) {
    return { code: 'overdue', label: '已逾期', tagType: 'danger' }
  }
  return FOLLOWUP_STATUS[status] || FOLLOWUP_STATUS.pending
}

export function normalizeProfileSignals(signals) {
  if (!Array.isArray(signals)) return []
  return signals.flatMap((signal, index) => {
    if (typeof signal === 'string' && signal.trim()) {
      return [{ code: `signal-${index + 1}`, label: signal.trim(), evidence: '' }]
    }
    if (!signal || typeof signal !== 'object' || !String(signal.label || '').trim()) return []
    return [{
      code: String(signal.code || `signal-${index + 1}`),
      label: String(signal.label).trim(),
      evidence: String(signal.evidence || '').trim()
    }]
  })
}

export function profileStageSummary(communicationDays) {
  const days = Array.isArray(communicationDays) ? communicationDays : []
  const latest = days.reduce((current, item) => {
    const index = Number(item.communicationIndex ?? item.communication_index ?? 0)
    return index > current.index
      ? { index, code: item.stageLabel || item.stage_label || 'nth' }
      : current
  }, { index: 0, code: '' })

  return {
    count: days.length,
    index: latest.index,
    code: latest.code,
    label: latest.index ? stageLabel(latest.code, latest.index) : '暂无沟通'
  }
}
