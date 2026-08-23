export const PUBLIC_SIGNUP_DISABLED_CODE = 'PUBLIC_SIGNUP_DISABLED'

export const ACCOUNT_LOOKUP_OK_MESSAGE = 'If an account exists for that email, we sent the next steps.'

export function isPublicSignupEnabled(raw?: string | null): boolean {
  return (raw || 'false').trim().toLowerCase() === 'true'
}
