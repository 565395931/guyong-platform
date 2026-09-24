/**
 * Convert the API response into a stable view model for the on-demand drawer.
 * Missing sections are intentionally represented as empty values so a partial
 * AI/profile response never breaks the conversation workspace.
 */
export function normalizeCustomerWorkspace(raw = {}) {
  return {
    customer: raw.customer || null,
    activeConversation: raw.activeConversation || null,
    stage: raw.communicationStage || { code: null, index: 0, label: '暂无沟通' },
    profile: raw.aiProfile || { summary: '', signals: [], version: 0 },
    language: raw.language || raw.customer?.languageProfile || raw.aiProfile?.languageProfile || { code: 'zh', label: '涓枃', confidence: 0.2, politeness: 'neutral' },
    followups: Array.isArray(raw.followups) ? raw.followups : [],
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    identities: Array.isArray(raw.identities) ? raw.identities : [],
    permissions: {
      view: false,
      editProfile: false,
      manageFollowups: false,
      markWon: false,
      ...((raw && raw.permissions) || {})
    },
    source: raw.source || null,
    generatedAt: raw.generatedAt || null
  }
}

export function workspaceCustomerName(customer) {
  return customer?.display_name || customer?.name || customer?.phone || '未命名客户'
}
