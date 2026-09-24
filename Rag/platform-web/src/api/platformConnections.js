import request from './index'

export const getPlatformConnections = () => request.get('/v1/platform-connections')
export const createPlatformConnection = data => request.post('/v1/platform-connections', data)
export const replacePlatformCredentials = (id, data) => request.patch(`/v1/platform-connections/${id}/credentials`, data)
export const verifyPlatformConnection = id => request.post(`/v1/platform-connections/${id}/verify`)
export const publishPlatformConnectionRuntime = id => request.post(`/v1/platform-connections/${id}/publish-runtime`)
export const disablePlatformConnectionRuntime = id => request.post(`/v1/platform-connections/${id}/disable-runtime`)
export const getConnectionAccounts = id => request.get(`/v1/platform-connections/${id}/accounts`)
export const updateAccountPolicy = (accountId, data) => request.patch(`/v1/platform-connections/accounts/${accountId}/policy`, data)
export const getAccountAllowlist = accountId => request.get(`/v1/platform-connections/accounts/${accountId}/allowlist`)
export const addAccountAllowlistEntry = (accountId, data) => request.post(`/v1/platform-connections/accounts/${accountId}/allowlist`, data)
export const removeAccountAllowlistEntry = (accountId, entryId) => request.delete(`/v1/platform-connections/accounts/${accountId}/allowlist/${entryId}`)
export const getPlatformOperationLogs = params => request.get('/v1/platform-connections/operation-logs', { params })
