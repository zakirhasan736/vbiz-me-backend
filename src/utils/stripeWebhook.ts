export type StripeActivationDecision =
  | { action: 'ignore'; reason: string }
  | { action: 'activate'; reason: string; markSignupCharged: boolean }
  | { action: 'do_not_activate'; reason: string }
  | { action: 'sync_status'; stripeStatus: string; reason: string }

function objectOf(event: { data?: { object?: Record<string, unknown> } }): Record<string, unknown> {
  return event.data?.object && typeof event.data.object === 'object' ? event.data.object : {}
}

export function stripeOwnerRefs(object: Record<string, unknown>): {
  userId: string
  packageId: string
  subscriptionId: string
  addon: string
  profileId: string
} {
  const metadata =
    object.metadata && typeof object.metadata === 'object' ? (object.metadata as Record<string, unknown>) : {}
  return {
    userId: String(metadata.userId || object.client_reference_id || '').trim(),
    packageId: String(metadata.packageId || '').trim(),
    subscriptionId: String(metadata.subscriptionId || '').trim(),
    addon: String(metadata.addon || '')
      .trim()
      .toLowerCase(),
    profileId: String(metadata.profileId || '').trim(),
  }
}

export function decideStripeEvent(event: {
  type?: string
  data?: { object?: Record<string, unknown> }
}): StripeActivationDecision {
  const type = String(event.type || '')
  const object = objectOf(event)

  if (type === 'checkout.session.completed') {
    const paymentStatus = String(object.payment_status || '').toLowerCase()
    if (paymentStatus === 'paid') {
      return {
        action: 'activate',
        reason: object.payment_link ? 'payment link paid' : 'checkout paid',
        markSignupCharged: true,
      }
    }
    return { action: 'do_not_activate', reason: `checkout payment_status=${paymentStatus || 'unknown'}` }
  }

  if (type === 'invoice.paid') {
    const billingReason = String(object.billing_reason || '')
    return {
      action: 'activate',
      reason: 'invoice paid',
      markSignupCharged: billingReason === 'subscription_create' || billingReason === '',
    }
  }

  if (type === 'invoice.payment_failed') {
    return { action: 'do_not_activate', reason: 'invoice payment failed' }
  }

  if (type === 'customer.subscription.deleted') {
    return { action: 'sync_status', stripeStatus: 'canceled', reason: 'subscription deleted' }
  }

  if (type === 'customer.subscription.updated') {
    const status = String(object.status || 'incomplete')
    if (status === 'active' || status === 'trialing') {
      return { action: 'activate', reason: `subscription ${status}`, markSignupCharged: false }
    }
    return { action: 'sync_status', stripeStatus: status, reason: `subscription ${status}` }
  }

  return { action: 'ignore', reason: `unhandled ${type || 'event'}` }
}

export function claimStripeEventId(processedIds: Iterable<string>, eventId: string): 'claimed' | 'duplicate' {
  return new Set(processedIds).has(eventId) ? 'duplicate' : 'claimed'
}
