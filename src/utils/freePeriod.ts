export type FreePeriodUnit = 'days' | 'months' | 'years'

export function resolveTrialEndsAt(
  input: {
    amount?: number | null
    unit?: FreePeriodUnit | null
    lifetime?: boolean | null
  },
  from = new Date()
): Date | null {
  if (input.lifetime) {
    return new Date('2099-12-31T23:59:59.999Z')
  }

  const amount = Math.max(0, Math.round(Number(input.amount) || 0))
  const unit = input.unit
  if (!amount || !unit) return null

  const end = new Date(from)
  if (unit === 'days') {
    end.setUTCDate(end.getUTCDate() + amount)
    return end
  }
  if (unit === 'months') {
    end.setUTCMonth(end.getUTCMonth() + amount)
    return end
  }
  if (unit === 'years') {
    end.setUTCFullYear(end.getUTCFullYear() + amount)
    return end
  }
  return null
}

export function formatFreePeriodLabel(input: {
  trialEndsAt?: Date | string | null
  lifetime?: boolean | null
}): string {
  if (input.lifetime) return 'Lifetime complimentary access'
  if (!input.trialEndsAt) return 'No complimentary period'
  const end = new Date(input.trialEndsAt)
  if (!Number.isFinite(end.getTime())) return 'No complimentary period'
  if (end.getUTCFullYear() >= 2099) return 'Lifetime complimentary access'
  return `Complimentary until ${end.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`
}

export function isComplimentaryTrialActive(
  sub:
    { trialEndsAt?: Date | string | null; provider?: string | null; stripeStatus?: string | null } | null | undefined,
  now = Date.now()
): boolean {
  if (!sub?.trialEndsAt) return false
  const end = new Date(sub.trialEndsAt).getTime()
  if (!Number.isFinite(end) || end <= now) return false
  const provider = String(sub.provider || '')
    .trim()
    .toLowerCase()
  const status = String(sub.stripeStatus || '')
    .trim()
    .toLowerCase()
  return provider === 'admin' && (status === 'trialing' || status === 'active')
}
