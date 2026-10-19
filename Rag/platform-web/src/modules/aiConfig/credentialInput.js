export function savedCredentialText(credential) {
  return credential?.configured ? '••••••••' + (credential.lastFour || '') : ''
}
export function credentialForSubmission(value, credential) {
  return value === savedCredentialText(credential) ? '' : String(value || '').trim()
}
