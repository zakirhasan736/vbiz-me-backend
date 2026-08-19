import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveFirstInvoiceCents, resolveMonthlyCents, resolveRecurringInvoiceCents } from '../utils/billingQuote'
import { isPaidAccess } from '../utils/paidAccess'
import { buildCheckoutLineItems, checkoutModeForItems } from '../utils/stripeCheckout'
import { decideStripeEvent, stripeOwnerRefs } from '../utils/stripeWebhook'

describe('Stripe checkout quotes', () => {
  it('uses global package pricing for Single paid plans and adds signup fee only on the first invoice', () => {
    const monthly = resolveMonthlyCents({
      ownerMode: 'single',
      packageMonthlyCents: 2900,
      negotiatedMonthlyCents: 1000,
    })
    assert.equal(monthly, 2900)
    const first = resolveFirstInvoiceCents({ monthlyCents: monthly, signupFeeCents: 5000, signupFeeChargedAt: null })
    const later = resolveRecurringInvoiceCents(monthly)
    const items = buildCheckoutLineItems({
      productName: 'Professional',
      monthlyCents: monthly,
      signupFeeCents: 5000,
      includeSignup: true,
    })
    assert.equal(first, 7900)
    assert.equal(later, 2900)
    assert.equal(items.length, 2)
    assert.equal(items[0]?.interval, 'month')
    assert.equal(items[1]?.interval, undefined)
    assert.equal(checkoutModeForItems(items), 'subscription')
    assert.equal(
      buildCheckoutLineItems({
        productName: 'Professional',
        monthlyCents: monthly,
        signupFeeCents: 5000,
        includeSignup: false,
      }).length,
      1
    )
  })

  it('uses Corporate negotiated monthly and includes signup only on the first payment', () => {
    const monthly = resolveMonthlyCents({
      ownerMode: 'corporate',
      packageMonthlyCents: 9900,
      negotiatedMonthlyCents: 7500,
    })
    assert.equal(monthly, 7500)
    assert.equal(
      resolveFirstInvoiceCents({ monthlyCents: monthly, signupFeeCents: 2000, signupFeeChargedAt: null }),
      9500
    )
    assert.equal(
      resolveFirstInvoiceCents({
        monthlyCents: monthly,
        signupFeeCents: 2000,
        signupFeeChargedAt: '2026-08-20T00:00:00.000Z',
      }),
      7500
    )
  })
})

describe('Stripe webhook decisions', () => {
  it('activates only after a paid checkout and is safe to ignore duplicates at the decision layer', () => {
    assert.deepEqual(
      decideStripeEvent({
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'paid' } },
      }).action,
      'activate'
    )
    const unpaid = decideStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'unpaid' } },
    })
    assert.equal(unpaid.action, 'do_not_activate')
    const fromLink = decideStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', payment_link: 'plink_1' } },
    })
    assert.equal(fromLink.action, 'activate')
    assert.deepEqual(
      stripeOwnerRefs({
        client_reference_id: 'user-1',
        metadata: { userId: 'user-1', packageId: 'pkg-1', subscriptionId: 'sub-1' },
      }),
      { userId: 'user-1', packageId: 'pkg-1', subscriptionId: 'sub-1' }
    )
  })

  it('does not activate paid access on a failed invoice', () => {
    const failed = decideStripeEvent({ type: 'invoice.payment_failed', data: { object: {} } })
    assert.equal(failed.action, 'do_not_activate')
  })

  it('treats invoice.paid subscription_create as first invoice and later cycles as recurring only', () => {
    const first = decideStripeEvent({
      type: 'invoice.paid',
      data: { object: { billing_reason: 'subscription_create' } },
    })
    const later = decideStripeEvent({
      type: 'invoice.paid',
      data: { object: { billing_reason: 'subscription_cycle' } },
    })
    assert.equal(first.action, 'activate')
    if (first.action === 'activate') assert.equal(first.markSignupCharged, true)
    assert.equal(later.action, 'activate')
    if (later.action === 'activate') assert.equal(later.markSignupCharged, false)
  })
})

describe('paid access gating', () => {
  it('does not treat incomplete Stripe subscriptions as paid access', () => {
    assert.equal(isPaidAccess({ provider: 'stripe', stripeStatus: 'incomplete', endsAt: null }), false)
    assert.equal(isPaidAccess({ provider: 'stripe', stripeStatus: 'active', endsAt: null }), true)
    assert.equal(isPaidAccess({ provider: 'admin', stripeStatus: 'active', endsAt: null }), true)
  })
})
