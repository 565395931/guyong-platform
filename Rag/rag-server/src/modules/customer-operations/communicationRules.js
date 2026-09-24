const STAGES = [
  { code: 'first', label: '首次沟通' },
  { code: 'second', label: '二次沟通' },
  { code: 'third', label: '三次沟通' }
]

function stageForCommunicationIndex(index) {
  const communicationIndex = Math.max(1, Number(index) || 1)
  return STAGES[communicationIndex - 1] || {
    code: 'nth',
    label: `第${communicationIndex}次沟通`
  }
}

function localDateKey(value, timeZone = process.env.APP_TIMEZONE || 'Asia/Shanghai') {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid date value')

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)

  const get = type => parts.find(part => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function buildVisibilityPredicate(user, alias = 'c') {
  if (['admin', 'supervisor'].includes(user?.role)) {
    return { sql: '1=1', replacements: {} }
  }

  return {
    sql: `(${alias}.claimed_by = :viewerId OR ${alias}.agent_id = :viewerId)`,
    replacements: { viewerId: Number(user?.id || user?.userId) }
  }
}

module.exports = {
  stageForCommunicationIndex,
  localDateKey,
  buildVisibilityPredicate
}
