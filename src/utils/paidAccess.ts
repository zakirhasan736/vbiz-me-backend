export function isPaidAccess(
  sub:
    | {
        endsAt?: Date | string | null
        provider?: string | null
        stripeStatus?: string | null
      }
    | null
    | undefined,
  now = Date.now()
): boolean {
  if (!sub) return false
  if (sub.endsAt != null && sub.endsAt !== '') {
    const ends = new Date(sub.endsAt).getTime()
    if (!Number.isFinite(ends) || ends <= now) return false
  }

  const provider = String(sub.provider || '')
    .trim()
    .toLowerCase()
  const status = String(sub.stripeStatus || '')
    .trim()
    .toLowerCase()

  if (provider === 'stripe') {
    return status === 'active' || status === 'trialing'
  }

  if (!status) return true
  if (
    status === 'incomplete' ||
    status === 'incomplete_expired' ||
    status === 'unpaid' ||
    status === 'past_due' ||
    status === 'canceled' ||
    status === 'cancelled'
  ) {
    return false
  }
  return status === 'active' || status === 'trialing'
}

export type SubscriptionAccessStatus = 'active' | 'pending_payment' | 'inactive'

export function resolveSubscriptionAccessStatus(
  sub:
    | {
        endsAt?: Date | string | null
        provider?: string | null
        stripeStatus?: string | null
      }
    | null
    | undefined,
  now = Date.now()
): SubscriptionAccessStatus {
  if (!sub) return 'inactive'
  if (isPaidAccess(sub, now)) return 'active'
  const status = String(sub.stripeStatus || '')
    .trim()
    .toLowerCase()
  if (status === 'incomplete' || status === 'incomplete_expired' || status === 'unpaid') return 'pending_payment'
  return 'inactive'
}
