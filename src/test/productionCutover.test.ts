import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loginOtpRollbackEnv,
  missingEnvKeys,
  ownerModeProbeFailureHint,
  PACKAGE_LAUNCH_MIGRATIONS,
  PRODUCTION_REQUIRED_ENV,
  PRODUCTION_SMOKE_CHECKS,
  stripeWebhookPath,
} from '../utils/productionCutover'

describe('production cutover', () => {
  it('requires mail and database env and rolls login OTP back without a code deploy', () => {
    assert.deepEqual(
      missingEnvKeys({ DATABASE_URL: 'postgres://x', ACCESS_TOKEN_SECRET: 'a' }, PRODUCTION_REQUIRED_ENV),
      ['REFRESH_TOKEN_SECRET', 'FRONTEND_URL', 'ZOHO_EMAIL_USER', 'ZOHO_EMAIL_PASSWORD']
    )
    assert.equal(loginOtpRollbackEnv().LOGIN_OTP_REQUIRED, 'false')
    assert.equal(stripeWebhookPath(), '/api/v1/billing/webhook')
  })

  it('lists the package-launch migrations and smoke checks', () => {
    assert.ok(PACKAGE_LAUNCH_MIGRATIONS.includes('20260820030000_stripe_events'))
    assert.ok(PACKAGE_LAUNCH_MIGRATIONS.includes('20260820040000_package_owner_mode'))
    assert.ok(PACKAGE_LAUNCH_MIGRATIONS.includes('20260820050000_negotiated_signup_fee'))
    assert.ok(PRODUCTION_SMOKE_CHECKS.some((item) => item.includes('email OTP')))
    assert.ok(PRODUCTION_SMOKE_CHECKS.some((item) => item.includes('card cap')))
    assert.ok(PRODUCTION_SMOKE_CHECKS.some((item) => item.includes('FEATURE_NOT_INCLUDED')))
  })

  it('tells operators to fix credentials when ownerMode probe cannot authenticate', () => {
    assert.match(
      ownerModeProbeFailureHint(new Error('P1000: Authentication failed against database server')),
      /authentication failed/i
    )
    assert.match(ownerModeProbeFailureHint(new Error('column ownerMode does not exist')), /package_owner_mode/i)
  })
})
