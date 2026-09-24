function createCustomerOperationsWorker({
  repository,
  aiService,
  logger = console,
  limit = 20,
  now = () => new Date()
} = {}) {
  if (!repository || !aiService) throw new Error('repository and aiService are required')

  function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback
    if (typeof value === 'object') return value
    try { return JSON.parse(value) } catch { return fallback }
  }

  async function buildAiInput(record, extra = {}) {
    const context = await repository.getCustomerAiContext?.(record.customer_id) || {}
    return {
      customerId: record.customer_id,
      evaluationTime: now().toISOString(),
      customer: {
        phone: record.phone || null,
        displayName: record.display_name || null,
        existingProfile: parseJson(record.ai_profile, null)
      },
      accountIdentities: context.accountIdentities || [],
      recentCommunications: context.recentCommunications || [],
      recentMessages: context.recentMessages || [],
      recentOrders: context.recentOrders || [],
      ...extra
    }
  }

  async function audit(input) {
    try {
      await repository.appendAiAuditLog(input)
    } catch (error) {
      logger.error?.('[CustomerOperationsWorker] audit write failed:', error.message)
    }
  }

  async function processCommunicationDay(day) {
    const input = await buildAiInput(day, {
      communicationDay: day,
      followupType: null
    })
    const decision = await aiService.decide(input)
    await repository.updateCommunicationAi({
      id: day.id,
      summary: decision.summary,
      stageLabel: day.stage_label
    })
    await repository.updateCustomerAiProfile({
      customerId: day.customer_id,
      profile: {
        summary: decision.summary,
        signals: decision.signals || [],
        recommendedTone: decision.recommendedTone || '',
        source: decision.source,
        updatedAt: now().toISOString()
      }
    })
    await audit({
      customerId: day.customer_id,
      actionType: 'profile_summary',
      source: decision.source,
      inputSummary: { communicationDayId: day.id },
      output: decision,
      confidence: decision.confidence
    })
  }

  async function processFollowup(followup) {
    const input = await buildAiInput(followup, {
      followup: {
        type: followup.type,
        status: followup.status,
        dueAt: followup.dueAt || followup.due_at,
        assignedTo: followup.assigned_to,
        existingReason: followup.aiReason || followup.ai_reason
      },
      followupType: followup.type
    })
    const decision = await aiService.decide(input, followup)
    await repository.updateFollowupAi({
      id: followup.id,
      dueAt: decision.nextFollowupAt,
      aiReason: decision.summary,
      aiConfidence: decision.confidence,
      aiSignals: decision.signals || [],
      source: decision.source
    })
    await audit({
      customerId: followup.customer_id,
      followupId: followup.id,
      actionType: 'followup_decision',
      source: decision.source,
      inputSummary: { followupType: followup.type },
      output: decision,
      confidence: decision.confidence
    })
  }

  async function runPendingWork() {
    await repository.markDueFollowups()
    const communicationDays = await repository.listPendingCommunicationDays(limit)
    for (const day of communicationDays) {
      try {
        await processCommunicationDay(day)
      } catch (error) {
        logger.error?.('[CustomerOperationsWorker] communication AI failed:', error.message)
      }
    }

    const followups = await repository.listPendingFollowups(limit)
    for (const followup of followups) {
      try {
        await processFollowup(followup)
      } catch (error) {
        logger.error?.('[CustomerOperationsWorker] follow-up AI failed:', error.message)
      }
    }
  }

  return { runPendingWork, processCommunicationDay, processFollowup }
}

module.exports = { createCustomerOperationsWorker }
