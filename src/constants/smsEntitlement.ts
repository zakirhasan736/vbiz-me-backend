/**
 * Owner text-alert entitlements (10DLC SMS via Twilio Messaging Service).
 *
 * Free → push + email only (no SMS).
 * Professional → 200 texts / calendar month.
 * Concierge (+ Corporate paid) → 1,000 texts / calendar month.
 * When the monthly cap is hit, operational alerts keep push + email; SMS is skipped
 * until the next month (extra-text purchases come later).
 */
export const SMS_MONTHLY_LIMIT_FEATURE_KEY = 'sms_monthly_limit'

export const SMS_MONTHLY_LIMIT_BY_SLUG: Record<string, number> = {
  free: 0,
  professional: 200,
  'professional-concierge': 1000,
  corporate: 1000,
  // Retired catalogs keep a safe paid default if still attached.
  'single-starter': 0,
  'corporate-starter': 0,
}

export function smsMonthlyLimitForPackageSlug(slug?: string | null): number {
  const key = (slug || '').trim().toLowerCase()
  if (!key) return 0
  if (Object.prototype.hasOwnProperty.call(SMS_MONTHLY_LIMIT_BY_SLUG, key)) {
    return SMS_MONTHLY_LIMIT_BY_SLUG[key]
  }
  if (key.includes('concierge')) return 1000
  if (key.includes('corporate')) return 1000
  if (key.includes('professional')) return 200
  if (key.includes('free') || key.includes('starter')) return 0
  return 0
}

export function parseSmsMonthlyLimitFeature(value?: string | null): number | null {
  if (value == null || String(value).trim() === '') return null
  const raw = String(value).trim().toLowerCase()
  if (raw === 'unlimited' || raw === '-1') return Number.POSITIVE_INFINITY
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}
