import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  adminAssignBilling,
  packageRequiresStripe,
  resolveFirstInvoiceCents,
  resolveMonthlyCents,
  resolveRecurringInvoiceCents,
} from '../utils/billingQuote'

describe('billing quotes', () => {
  it('uses catalog monthly price for Single packages', () => {
    assert.equal(
      resolveMonthlyCents({
        ownerMode: 'single',
        packageMonthlyCents: 2900,
        negotiatedMonthlyCents: 1000,
      }),
      2900
    )
  })

  it('uses negotiated monthly for Corporate when set, otherwise the catalog price', () => {
    assert.equal(
      resolveMonthlyCents({
        ownerMode: 'corporate',
        packageMonthlyCents: 9900,
        negotiatedMonthlyCents: 7500,
      }),
      7500
    )
    assert.equal(
      resolveMonthlyCents({
        ownerMode: 'corporate',
        packageMonthlyCents: 9900,
        negotiatedMonthlyCents: null,
      }),
      9900
    )
  })

  it('adds signup fee only on the first invoice', () => {
    assert.equal(resolveFirstInvoiceCents({ monthlyCents: 2900, signupFeeCents: 5000, signupFeeChargedAt: null }), 7900)
    assert.equal(
      resolveFirstInvoiceCents({
        monthlyCents: 2900,
        signupFeeCents: 5000,
        signupFeeChargedAt: '2026-08-20T00:00:00.000Z',
      }),
      2900
    )
    assert.equal(resolveRecurringInvoiceCents(2900), 2900)
  })

  it('marks paid packages as pending Stripe billing when assigned by admin', () => {
    assert.deepEqual(adminAssignBilling({ monthlyPrice: 0, signupFeeCents: 0 }), {
      provider: 'admin',
      stripeStatus: 'active',
    })
    assert.deepEqual(adminAssignBilling({ monthlyPrice: 7500, signupFeeCents: 2000 }), {
      provider: 'stripe',
      stripeStatus: 'incomplete',
    })
    assert.equal(packageRequiresStripe({ monthlyPrice: 2900, signupFeeCents: 0 }), true)
    assert.equal(packageRequiresStripe({ monthlyPrice: 0, signupFeeCents: 0 }), false)
  })
})
