import request from './index'

export function listReviews(params = {}) {
  return request.get('/v1/message-reviews', { params })
}

export function getReviewStats() {
  return request.get('/v1/message-reviews/stats')
}

export function getReview(id) {
  return request.get(`/v1/message-reviews/${id}`)
}

export function claimReview(id) {
  return request.post(`/v1/message-reviews/${id}/claim`)
}

export function takeoverReview(id) {
  return request.post(`/v1/message-reviews/${id}/takeover`)
}

export function releaseReview(id) {
  return request.post(`/v1/message-reviews/${id}/release`)
}

export function replyReview(id, text) {
  return request.post(`/v1/message-reviews/${id}/reply`, { text })
}

export function dismissReview(id, input) {
  return request.post(`/v1/message-reviews/${id}/dismiss`, input)
}
