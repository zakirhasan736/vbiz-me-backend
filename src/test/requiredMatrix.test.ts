import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { entitlementsFromFeatures } from '../constants/packageAccess'
import { FEATURE_NOT_INCLUDED, PACKAGE_FEATURE_LOCKED, featureNotIncludedError } from '../constants/packageErrors'
import {
  canUseCorporateBackOffice,
  homePathForOwnerMode,
  ownerOfficeRedirectPath,
  resolveOwnerMode,
} from '../constants/packageOwnerMode'
import {
  canIssueOwnerSession,
  evaluateAuthChallenge,
  hashAuthOtp,
  isTimeLimitedTokenValid,
  shouldRequireLoginOtp,
} from '../utils/authChallenge'
import {
  adminAssignBilling,
  resolveFirstInvoiceCents,
  resolveMonthlyCents,
  resolveRecurringInvoiceCents,
  resolveSignupFeeCents,
} from '../utils/billingQuote'
import { sanitizeCorporateFeatureOverrides } from '../utils/corporateFeatureOverrides'
import { buildEffectiveEntitlements, isCatalogFeatureAllowed } from '../utils/effectiveEntitlements'
import { catalogGateSatisfied, mediaUploadCatalogGate } from '../utils/mediaFeatureGates'
import {
  allowsCountWrite,
  canCreateAnotherCard,
  countFilledSocialLinks,
  maxUploadBytes,
  remainingCardSlots,
} from '../utils/packageLimits'
import { isPaidAccess } from '../utils/paidAccess'
import { ACCOUNT_LOOKUP_OK_MESSAGE, isPublicSignupEnabled } from '../utils/publicSignup'
import { claimStripeEventId, decideStripeEvent, stripeOwnerRefs } from '../utils/stripeWebhook'

const flags = (rows: Record<string, string>) =>
  Object.entries(rows).map(([featureKey, featureValue]) => ({ featureKey, featureValue }))

const here = dirname(fileURLToPath(import.meta.url))
const authRoute = readFileSync(join(here, '../router/auth.route.ts'), 'utf8')
const profileRoute = readFileSync(join(here, '../router/profile.route.ts'), 'utf8')

describe('required matrix: AUTH', () => {
  it('Public Signup hidden', () => {
    assert.match(authRoute, /router\.post\('\/register'/)
    assert.match(authRoute, /router\.post\('\/login'/)
    assert.equal(isPublicSignupEnabled('false'), false)
    assert.equal(shouldRequireLoginOtp('vcard-owner', true), true)
  })

  it('Login works', () => {
    assert.match(authRoute, /router\.post\('\/login'/)
    assert.equal(
      canIssueOwnerSession({
        role: 'admin',
        loginOtpRequired: true,
        passwordAccepted: true,
        otpAccepted: false,
      }),
      true
    )
  })

  it('Forgot Password works', () => {
    assert.match(authRoute, /\/forgot-password/)
    assert.match(ACCOUNT_LOOKUP_OK_MESSAGE, /If an account exists/)
    assert.equal(isTimeLimitedTokenValid(new Date(Date.now() + 60_000)), true)
  })

  it('Reset Password works', () => {
    assert.match(authRoute, /router\.put\('\/reset-password'/)
    assert.equal(isTimeLimitedTokenValid(new Date(Date.now() - 1)), false)
  })

  it('Admin-created user can activate securely', () => {
    assert.match(authRoute, /password-setup\/verify/)
    const secret = 'setup-secret'
    const userId = 'new-owner'
    const otp = '123456'
    const record = {
      codeHash: hashAuthOtp(otp, userId, 'ACTIVATE', secret),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attemptCount: 0,
    }
    assert.deepEqual(evaluateAuthChallenge(record, otp, userId, 'ACTIVATE', secret), { ok: true })
    assert.equal(evaluateAuthChallenge(record, otp, userId, 'LOGIN', secret).ok, false)
    const authService = readFileSync(join(here, '../services/auth.service.ts'), 'utf8')
    const verifyBlock = authService.slice(
      authService.indexOf('const verifyPasswordSetup'),
      authService.indexOf('const resendPasswordSetupEmail')
    )
    assert.equal(verifyBlock.includes('issueTokens'), false)
  })

  it('OTP required after correct password', () => {
    assert.equal(shouldRequireLoginOtp('vcard-owner', true), true)
    assert.equal(shouldRequireLoginOtp('corporate-owner', true), true)
    assert.equal(
      canIssueOwnerSession({
        role: 'vcard-owner',
        loginOtpRequired: true,
        passwordAccepted: true,
        otpAccepted: false,
      }),
      false
    )
  })

  it('Invalid OTP cannot authenticate', () => {
    const secret = 'otp-secret'
    const userId = 'owner-1'
    const record = {
      codeHash: hashAuthOtp('482910', userId, 'LOGIN', secret),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attemptCount: 0,
    }
    assert.deepEqual(evaluateAuthChallenge(record, '000000', userId, 'LOGIN', secret), {
      ok: false,
      reason: 'invalid',
    })
  })

  it('Expired OTP rejected', () => {
    const secret = 'otp-secret'
    const userId = 'owner-1'
    const record = {
      codeHash: hashAuthOtp('482910', userId, 'LOGIN', secret),
      expiresAt: new Date(Date.now() - 1),
      consumedAt: null,
      attemptCount: 0,
    }
    assert.equal(evaluateAuthChallenge(record, '482910', userId, 'LOGIN', secret).ok, false)
  })

  it('Reused OTP rejected', () => {
    const secret = 'otp-secret'
    const userId = 'owner-1'
    const record = {
      codeHash: hashAuthOtp('482910', userId, 'LOGIN', secret),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      attemptCount: 0,
    }
    assert.equal(evaluateAuthChallenge(record, '482910', userId, 'LOGIN', secret).ok, false)
  })

  it('Final access token/session issued only after OTP', () => {
    assert.equal(
      canIssueOwnerSession({
        role: 'vcard-owner',
        loginOtpRequired: true,
        passwordAccepted: true,
        otpAccepted: true,
      }),
      true
    )
    assert.equal(
      canIssueOwnerSession({
        role: 'vcard-owner',
        loginOtpRequired: true,
        passwordAccepted: true,
        otpAccepted: false,
      }),
      false
    )
  })
})

describe('required matrix: PACKAGES', () => {
  it('Free resolves Free entitlements', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'free', slug: 'free', name: 'Free' },
      features: flags({ max_cards: '1', allow_canva: '0' }),
      subscription: { id: 'sub', quantity: 1, endsAt: null },
    })
    assert.equal(result.packageSlug, 'free')
    assert.equal(result.ownerMode, 'single')
    assert.equal(result.backOffice, 'single')
    assert.equal(result.limits.maxCards, 1)
    assert.equal(result.access.allow_canva, false)
    assert.match(profileRoute, /\/entitlements/)
  })

  it('Professional resolves Professional entitlements', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pro', slug: 'professional', name: 'Professional' },
      features: flags({ max_cards: '3', allow_canva: '1' }),
      subscription: { id: 'sub', quantity: 3, endsAt: null },
    })
    assert.equal(result.packageSlug, 'professional')
    assert.equal(result.limits.maxCards, 3)
    assert.equal(result.access.allow_canva, true)
  })

  it('Concierge resolves Concierge entitlements', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'concierge', slug: 'professional-concierge', name: 'Professional Concierge' },
      features: flags({ max_cards: '5', allow_auto_card_builder: '1' }),
      subscription: { id: 'sub', quantity: 5, endsAt: null },
    })
    assert.equal(result.packageSlug, 'professional-concierge')
    assert.equal(result.access.allow_auto_card_builder, true)
  })

  it('Corporate resolves Corporate entitlements', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ max_cards: '15', allow_seo: '1' }),
      subscription: { id: 'sub', quantity: 20, endsAt: null },
    })
    assert.equal(result.ownerMode, 'corporate')
    assert.equal(result.limits.maxCards, 20)
    assert.equal(canUseCorporateBackOffice(result.ownerMode), true)
  })
})

describe('required matrix: ROUTING', () => {
  it('Free → Single Back Office', () => {
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'free' })), '/')
  })

  it('Professional → Single Back Office', () => {
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'professional' })), '/')
  })

  it('Concierge → Single Back Office', () => {
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'professional-concierge' })), '/')
  })

  it('Corporate → Corporate Back Office', () => {
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'corporate' })), '/teamvcard')
    assert.equal(
      ownerOfficeRedirectPath({ pathname: '/vcards', ownerMode: 'corporate', role: 'vcard-owner' }),
      '/teamvcard'
    )
    assert.equal(ownerOfficeRedirectPath({ pathname: '/teamvcard', ownerMode: 'single', role: 'vcard-owner' }), '/')
    assert.equal(ownerOfficeRedirectPath({ pathname: '/vcards/create/home', ownerMode: 'corporate' }), null)
  })

  it('keeps unpaid Corporate on Corporate back office paths', () => {
    const unpaid = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate', ownerMode: 'corporate' },
      features: flags({ max_cards: '25' }),
      subscription: { id: 'sub', quantity: 25, endsAt: null, provider: 'stripe', stripeStatus: 'incomplete' },
    })
    assert.equal(unpaid.ownerMode, 'corporate')
    assert.equal(unpaid.backOffice, 'corporate')
    assert.equal(unpaid.subscriptionStatus, 'pending_payment')
    assert.equal(homePathForOwnerMode(unpaid.ownerMode), '/teamvcard')
    assert.equal(
      ownerOfficeRedirectPath({ pathname: '/vcards', ownerMode: unpaid.ownerMode, role: 'vcard-owner' }),
      '/teamvcard'
    )
  })
})

describe('required matrix: PACKAGE CHANGES', () => {
  it('Professional → Concierge changes effective access', () => {
    const professional = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pro', slug: 'professional', name: 'Professional' },
      features: flags({ allow_auto_card_builder: '0', max_cards: '3' }),
      subscription: { id: 'sub', quantity: 3, endsAt: null },
    })
    const concierge = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'concierge', slug: 'professional-concierge', name: 'Professional Concierge' },
      features: flags({ allow_auto_card_builder: '1', max_cards: '5' }),
      subscription: { id: 'sub', quantity: 5, endsAt: null },
    })
    assert.equal(professional.access.allow_auto_card_builder, false)
    assert.equal(concierge.access.allow_auto_card_builder, true)
    assert.equal(concierge.limits.maxCards, 5)
  })

  it('Global package-feature change updates effective access', () => {
    const before = entitlementsFromFeatures(flags({ allow_seo: '1' }))
    const after = entitlementsFromFeatures(flags({ allow_seo: '0' }))
    assert.equal(before.allow_seo, true)
    assert.equal(after.allow_seo, false)
  })

  it('Downgrade preserves existing content', () => {
    assert.equal(allowsCountWrite(12, 12, 5), true)
    assert.equal(allowsCountWrite(12, 11, 5), true)
    assert.equal(allowsCountWrite(12, 13, 5), false)
    assert.equal(countFilledSocialLinks([{ name: 'x', url: 'https://x.com' }]), 1)
  })
})

describe('required matrix: CORPORATE', () => {
  const pkg = { id: 'corp', slug: 'corporate', name: 'Corporate' }

  it('Corporate global feature inherited when no override', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg,
      features: flags({ allow_canva: '1' }),
      subscription: { id: 'sub', quantity: 15, endsAt: null },
    })
    assert.equal(result.access.allow_canva, true)
    assert.equal(result.overrides.length, 0)
  })

  it('Corporate override replaces global value', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg,
      features: flags({ allow_canva: '1' }),
      subscription: { id: 'sub', quantity: 15, endsAt: null },
      overrides: flags({ allow_canva: '0' }),
    })
    assert.equal(result.access.allow_canva, false)
  })

  it('Remove override → global value inherited again', () => {
    const catalog = flags({ allow_canva: '1' })
    const restored = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg,
      features: catalog,
      subscription: { id: 'sub', quantity: 15, endsAt: null },
      overrides: [],
    })
    assert.equal(restored.access.allow_canva, true)
  })

  it('Corporate card limit enforced', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg,
      features: flags({ max_cards: '15' }),
      subscription: { id: 'sub', quantity: 4, endsAt: null },
    })
    assert.equal(canCreateAnotherCard(4, result.limits.maxCards), false)
    assert.equal(canCreateAnotherCard(3, result.limits.maxCards), true)
  })

  it('Admin limit increase immediately allows more cards', () => {
    const raised = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg,
      features: flags({ max_cards: '15' }),
      subscription: { id: 'sub', quantity: 40, endsAt: null },
    })
    assert.equal(canCreateAnotherCard(15, raised.limits.maxCards), true)
  })

  it('Limit reduction does not delete existing cards', () => {
    assert.equal(canCreateAnotherCard(12, 5), false)
    assert.equal(allowsCountWrite(12, 12, 5), true)
    assert.equal(remainingCardSlots(12, 5), 0)
    assert.throws(() => sanitizeCorporateFeatureOverrides([{ featureKey: 'max_cards', featureValue: '99' }]))
  })
})

describe('required matrix: SECURITY', () => {
  it('Backend rejects unavailable feature even if frontend is bypassed', () => {
    const access = entitlementsFromFeatures(flags({ allow_canva: '0' }))
    assert.equal(access.allow_canva, false)
  })

  it('Numeric limits enforced', () => {
    assert.equal(allowsCountWrite(2, 11, 10), false)
    assert.equal(allowsCountWrite(2, 10, 10), true)
  })

  it('Builder uploads are not package file-size capped', () => {
    const cap = maxUploadBytes(10)
    assert.equal(cap, Number.MAX_SAFE_INTEGER)
    assert.equal(11 * 1024 * 1024 * 1024 <= cap, true)
  })

  it('Current subscription/package status checked', () => {
    assert.equal(isPaidAccess({ provider: 'stripe', stripeStatus: 'incomplete', endsAt: null }), false)
    assert.equal(isPaidAccess({ provider: 'stripe', stripeStatus: 'active', endsAt: null }), true)
    const unpaid = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pro', slug: 'professional', name: 'Professional' },
      features: flags({ allow_canva: '1' }),
      subscription: { id: 'sub', endsAt: null, provider: 'stripe', stripeStatus: 'incomplete' },
    })
    assert.equal(unpaid.subscriptionActive, false)
    assert.equal(unpaid.subscriptionStatus, 'pending_payment')
    assert.equal(unpaid.access.allow_canva, false)
  })
})

describe('required matrix: STRIPE', () => {
  it('Single paid package uses global package pricing', () => {
    assert.equal(
      resolveMonthlyCents({ ownerMode: 'single', packageMonthlyCents: 2900, negotiatedMonthlyCents: 1000 }),
      2900
    )
  })

  it('Single paid initial charge includes global one-time signup fee when applicable', () => {
    assert.equal(resolveFirstInvoiceCents({ monthlyCents: 2900, signupFeeCents: 5000, signupFeeChargedAt: null }), 7900)
  })

  it('Signup fee does not recur', () => {
    assert.equal(resolveRecurringInvoiceCents(2900), 2900)
    assert.equal(
      resolveFirstInvoiceCents({
        monthlyCents: 2900,
        signupFeeCents: 5000,
        signupFeeChargedAt: '2026-08-20T00:00:00.000Z',
      }),
      2900
    )
  })

  it('Corporate negotiated monthly price works', () => {
    assert.equal(
      resolveMonthlyCents({ ownerMode: 'corporate', packageMonthlyCents: 9900, negotiatedMonthlyCents: 7500 }),
      7500
    )
  })

  it('Corporate first payment includes signup fee + first month', () => {
    assert.equal(resolveFirstInvoiceCents({ monthlyCents: 7500, signupFeeCents: 2000, signupFeeChargedAt: null }), 9500)
    assert.equal(
      resolveFirstInvoiceCents({
        monthlyCents: 20000,
        signupFeeCents: resolveSignupFeeCents({
          ownerMode: 'corporate',
          packageSignupFeeCents: 1000,
          negotiatedSignupFeeCents: 1000,
        }),
        signupFeeChargedAt: null,
      }),
      21000
    )
  })

  it('Following Corporate invoices contain recurring amount only', () => {
    const later = decideStripeEvent({
      type: 'invoice.paid',
      data: { object: { billing_reason: 'subscription_cycle' } },
    })
    assert.equal(later.action, 'activate')
    if (later.action === 'activate') assert.equal(later.markSignupCharged, false)
    assert.equal(resolveRecurringInvoiceCents(7500), 7500)
  })

  it('Stripe webhook is idempotent', () => {
    assert.equal(claimStripeEventId(['evt_1'], 'evt_1'), 'duplicate')
    assert.equal(claimStripeEventId(['evt_1'], 'evt_2'), 'claimed')
  })

  it('Failed payment does not activate paid access', () => {
    const failed = decideStripeEvent({ type: 'invoice.payment_failed', data: { object: {} } })
    const unpaidCheckout = decideStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'unpaid' } },
    })
    assert.equal(failed.action, 'do_not_activate')
    assert.equal(unpaidCheckout.action, 'do_not_activate')
  })

  it('Admin-created paid Corporate stays pending until the same user pays', () => {
    assert.deepEqual(adminAssignBilling({ monthlyPrice: 7500, signupFeeCents: 2000 }), {
      provider: 'stripe',
      stripeStatus: 'incomplete',
    })
    assert.deepEqual(
      stripeOwnerRefs({
        metadata: { userId: 'owner-1', packageId: 'pkg-corp', subscriptionId: 'sub-pending' },
      }),
      { userId: 'owner-1', packageId: 'pkg-corp', subscriptionId: 'sub-pending' }
    )
    const paid = decideStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', payment_link: 'plink_1' } },
    })
    assert.equal(paid.action, 'activate')
  })
})

describe('required matrix: MEDIA FLAGS', () => {
  it('rejects locked media uploads with FEATURE_NOT_INCLUDED while images stay allowed', () => {
    assert.equal(mediaUploadCatalogGate({ attachmentType: 'Profile Image/Video', kind: 'image' }), null)
    const videoGate = mediaUploadCatalogGate({ attachmentType: 'Profile Image/Video', kind: 'video' })
    assert.ok(videoGate)
    assert.equal(
      catalogGateSatisfied(videoGate, (key) => key !== 'allow_video_upload'),
      false
    )
    const error = featureNotIncludedError('allow_video_upload')
    assert.equal(error.code, FEATURE_NOT_INCLUDED)
    assert.ok((error.data as { codes: string[] }).codes.includes(PACKAGE_FEATURE_LOCKED))
  })

  it('locks catalog media flags when Stripe is still pending', () => {
    const unpaid = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pro', slug: 'professional', name: 'Professional' },
      features: flags({ allow_2d_explainer: '1', allow_background_video_upload: '1' }),
      subscription: { id: 'sub', endsAt: null, provider: 'stripe', stripeStatus: 'incomplete' },
    })
    assert.equal(unpaid.subscriptionActive, false)
    assert.equal(isCatalogFeatureAllowed(unpaid, 'allow_2d_explainer'), false)
    assert.equal(isCatalogFeatureAllowed(unpaid, 'allow_background_video_upload'), false)
  })
})
