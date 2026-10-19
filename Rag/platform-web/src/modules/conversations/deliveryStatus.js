export function mergeDeliveryStatus(previous, incoming) {
  if (previous === 'sent' && ['received','accepted','unknown','pending','sending'].includes(incoming)) return previous
  if (['sent','failed','unknown'].includes(previous) && ['received','accepted','pending','sending'].includes(incoming)) return previous
  return incoming || previous
}
