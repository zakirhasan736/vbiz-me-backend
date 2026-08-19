export const LOGIN_OTP_ROLLBACK_VALUE = 'false'

export const PRODUCTION_REQUIRED_ENV = [
  'DATABASE_URL',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'FRONTEND_URL',
  'MAIL_ADDRESS',
  'MAIL_PASS',
] as const

export const PRODUCTION_RECOMMENDED_ENV = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'LOGIN_OTP_REQUIRED',
  'CORS_ORIGINS',
] as const

export const PACKAGE_LAUNCH_MIGRATIONS = [
  '20260819220000_auth_challenge',
  '20260820010000_corporate_feature_override',
  '20260820020000_signup_fee_and_negotiated_monthly',
  '20260820030000_stripe_events',
  '20260820040000_package_owner_mode',
  '20260820050000_negotiated_signup_fee',
] as const

export const PRODUCTION_SMOKE_CHECKS = [
  'GET /api/v1/health returns healthy',
  'Staff password login (no email OTP)',
  'Card-owner login: password then email OTP, then session cookies',
  'One Single-package owner lands on /',
  'One Corporate-package owner lands on /teamvcard',
  'Admin can edit a package catalog row',
  'Create-card blocked at the account card cap (existing cards remain)',
  'Locked media flags return 403 FEATURE_NOT_INCLUDED (existing files remain)',
  'Stripe webhook URL receives signed events: POST /api/v1/billing/webhook',
] as const

export function missingEnvKeys(env: Record<string, string | undefined>, keys: readonly string[]): string[] {
  return keys.filter((key) => !String(env[key] || '').trim())
}

export function loginOtpRollbackEnv(): { LOGIN_OTP_REQUIRED: string } {
  return { LOGIN_OTP_REQUIRED: LOGIN_OTP_ROLLBACK_VALUE }
}

export function stripeWebhookPath(): string {
  return '/api/v1/billing/webhook'
}

export function ownerModeProbeFailureHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/P1000|Authentication failed/i.test(message)) {
    return 'Database authentication failed. Fix DATABASE_URL credentials before yarn migrate:deploy.'
  }
  if (/P1001|Can't reach|ECONNREFUSED|connect ECONNREFUSED/i.test(message)) {
    return 'Database is unreachable. Fix DATABASE_URL host/port before yarn migrate:deploy.'
  }
  return 'Package.ownerMode is not readable. Apply 20260820040000_package_owner_mode with yarn migrate:deploy.'
}
