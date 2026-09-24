const VALID_SCOPES = new Set(['common', 'overseas', 'domestic', 'channel']);
const BUILTIN_CHANNELS = new Set(['all', 'whatsapp', 'wechat', 'douyin']);
const CHANNEL_CODE_PATTERN = /^[a-z0-9_-]{2,30}$/;

function normalizeKnowledgeScope(scope, fallbackChannel = '') {
  const normalized = String(scope || '').trim().toLowerCase();
  if (VALID_SCOPES.has(normalized)) return normalized;
  return defaultKnowledgeScopeForChannel(fallbackChannel);
}

function defaultKnowledgeScopeForChannel(channel = '') {
  const normalized = String(channel || '').trim().toLowerCase();
  if (normalized === 'whatsapp') return 'overseas';
  if (['wechat', 'douyin'].includes(normalized)) return 'domestic';
  return 'common';
}

function normalizeKnowledgeChannels(channels, scope = 'common', fallbackChannel = '') {
  let list = channels;
  if (typeof list === 'string') {
    const trimmed = list.trim();
    if (trimmed.startsWith('[')) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        list = trimmed.split(',');
      }
    } else {
      list = trimmed.split(',');
    }
  }

  if (!Array.isArray(list)) list = [];

  const normalized = [...new Set(list
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => item === 'all' || CHANNEL_CODE_PATTERN.test(item)))];

  if (normalized.includes('all')) return ['all'];
  if (normalized.length > 0) return normalized;

  const fallback = String(fallbackChannel || '').trim().toLowerCase();
  if (scope === 'channel' && CHANNEL_CODE_PATTERN.test(fallback) && fallback !== 'all') return [fallback];
  return ['all'];
}

function normalizeKnowledgeMetadata(input = {}, fallbackChannel = '') {
  const scope = normalizeKnowledgeScope(input.knowledgeScope || input.scope, fallbackChannel);
  const channels = normalizeKnowledgeChannels(input.knowledgeChannels || input.channels, scope, fallbackChannel);
  return { knowledgeScope: scope, knowledgeChannels: channels };
}

function buildAllowedKnowledgeFilter(channel = '', input = {}) {
  const normalizedChannel = String(channel || '').trim().toLowerCase();
  const { knowledgeScope, knowledgeChannels } = normalizeKnowledgeMetadata(input, normalizedChannel);
  const scope = knowledgeScope;
  const allowedScopes = scope === 'domestic'
    ? ['common', 'domestic', 'channel']
    : scope === 'overseas'
      ? ['common', 'overseas', 'channel']
      : scope === 'channel'
        ? ['common', 'channel']
        : ['common'];

  const specificChannels = knowledgeChannels.filter(item => item !== 'all');
  const allowedChannels = specificChannels.length > 0
    ? ['all', ...specificChannels]
    : normalizedChannel
      ? ['all', normalizedChannel]
      : ['all'];

  return {
    channel: normalizedChannel || 'all',
    allowedScopes,
    allowedChannels
  };
}

function parseKnowledgeMetadataFromText(text = '') {
  const result = {};
  const scopeMatch = String(text).match(/【适用范围】\s*([^\n\r]+)/);
  const channelMatch = String(text).match(/【适用渠道】\s*([^\n\r]+)/);
  if (scopeMatch?.[1]) result.knowledgeScope = scopeMatch[1].trim();
  if (channelMatch?.[1]) result.knowledgeChannels = channelMatch[1].split(',').map(item => item.trim());
  return result;
}

function isKnowledgeNodeAllowed(node = {}, filter = null) {
  if (!filter) return true;

  const metadataFromText = parseKnowledgeMetadataFromText(node.text || node.content || '');
  const rawScope = node.knowledgeScope || node.metadata?.knowledgeScope || node.metadata?.scope || metadataFromText.knowledgeScope;
  const rawChannels = node.knowledgeChannels || node.metadata?.knowledgeChannels || node.metadata?.channels || metadataFromText.knowledgeChannels;
  const defaultUnknownScope = process.env.KNOWLEDGE_UNKNOWN_SCOPE_DEFAULT || 'overseas';
  const scope = normalizeKnowledgeScope(rawScope || defaultUnknownScope);
  const channels = normalizeKnowledgeChannels(rawChannels, scope);

  if (!filter.allowedScopes.includes(scope)) return false;
  if (scope !== 'channel') return true;
  return channels.some(channel => filter.allowedChannels.includes(channel));
}

module.exports = {
  VALID_SCOPES,
  VALID_CHANNELS: BUILTIN_CHANNELS,
  CHANNEL_CODE_PATTERN,
  normalizeKnowledgeScope,
  normalizeKnowledgeChannels,
  normalizeKnowledgeMetadata,
  defaultKnowledgeScopeForChannel,
  buildAllowedKnowledgeFilter,
  parseKnowledgeMetadataFromText,
  isKnowledgeNodeAllowed
};
