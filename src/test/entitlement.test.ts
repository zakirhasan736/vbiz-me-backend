import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildEffectiveEntitlements } from '../utils/effectiveEntitlements'

const flags = (rows: Record<string, string>) =>
  Object.entries(rows).map(([featureKey, featureValue]) => ({ featureKey, featureValue }))

describe('central entitlement service', () => {
  it('resolves Free catalog entitlements as Single', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-free', slug: 'free', name: 'Free' },
      features: flags({ max_cards: '1', allow_canva: '0', allow_auto_card_builder: '0' }),
      subscription: { id: 'sub-free', quantity: 1, endsAt: null },
    })
    assert.equal(result.ownerMode, 'single')
    assert.equal(result.backOffice, 'single')
    assert.equal(result.subscriptionStatus, 'active')
    assert.equal(result.subscriptionActive, true)
    assert.equal(result.limits.maxCards, 1)
    assert.equal(result.access.allow_canva, false)
    assert.equal(result.access.allow_seo, true)
    assert.equal(result.access.allow_crm, false)
    assert.equal(result.limits.maxCards, 1)
  })

  it('ignores leftover subscription quantity and overrides on Single packages', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-free', slug: 'free', name: 'Free' },
      features: flags({ max_cards: '1', allow_canva: '0' }),
      subscription: { id: 'sub-free', quantity: 40, endsAt: null },
      overrides: flags({ max_cards: '40', allow_canva: '1' }),
    })
    assert.equal(result.ownerMode, 'single')
    assert.equal(result.limits.maxCards, 1)
    assert.equal(result.access.allow_canva, false)
    assert.equal(result.overrides.length, 0)
  })

  it('resolves Professional catalog entitlements as Single', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-pro', slug: 'professional', name: 'Professional' },
      features: flags({ max_cards: '3', allow_canva: '1', allow_crm: '1', max_file_size_mb: '15' }),
      subscription: { id: 'sub-pro', quantity: 3, endsAt: null },
    })
    assert.equal(result.ownerMode, 'single')
    assert.equal(result.packageSlug, 'professional')
    assert.equal(result.limits.maxCards, 3)
    assert.equal(result.limits.maxFileSizeMb, 15)
    assert.equal(result.access.allow_canva, true)
    assert.equal(result.access.allow_crm, true)
  })

  it('resolves Concierge catalog entitlements as Single', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-concierge', slug: 'professional-concierge', name: 'Professional Concierge' },
      features: flags({ max_cards: '5', allow_ai_assistance: '1', allow_auto_card_builder: '1', allow_crm: '1' }),
      subscription: { id: 'sub-concierge', quantity: 5, endsAt: null },
    })
    assert.equal(result.ownerMode, 'single')
    assert.equal(result.packageSlug, 'professional-concierge')
    assert.equal(result.limits.maxCards, 5)
    assert.equal(result.access.allow_ai_assistance, true)
    assert.equal(result.access.allow_auto_card_builder, true)
    assert.equal(result.access.allow_crm, true)
  })

  it('resolves Corporate catalog entitlements and applies overrides on the current package', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ max_cards: '15', allow_seo: '1', allow_canva: '1', allow_crm: '1' }),
      subscription: { id: 'sub-corp', quantity: 20, endsAt: null },
      overrides: flags({ allow_seo: '0', max_cards: '25' }),
    })
    assert.equal(result.ownerMode, 'corporate')
    assert.equal(result.packageSlug, 'corporate')
    assert.equal(result.access.allow_seo, false)
    assert.equal(result.access.allow_canva, true)
    assert.equal(result.limits.maxCards, 20)
    assert.equal(result.limits.packageMaxCards, 15)
    assert.equal(result.subscriptionId, 'sub-corp')
  })

  it('uses Corporate package max_cards when the account has no quantity override', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ max_cards: '15' }),
      subscription: { id: 'sub-corp', quantity: null, endsAt: null },
    })
    assert.equal(result.limits.maxCards, 15)
    assert.equal(result.limits.packageMaxCards, 15)
  })

  it('lets an admin raise or lower the Corporate account cap without deleting cards', () => {
    const raised = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ max_cards: '15' }),
      subscription: { id: 'sub-corp', quantity: 40, endsAt: null },
    })
    const lowered = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ max_cards: '15' }),
      subscription: { id: 'sub-corp', quantity: 5, endsAt: null },
    })
    assert.equal(raised.limits.maxCards, 40)
    assert.equal(lowered.limits.maxCards, 5)
  })

  it('inherits Corporate package features when no override exists', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ allow_canva: '1', allow_seo: '0', max_file_size_mb: '10' }),
      subscription: { id: 'sub-corp', quantity: 15, endsAt: null },
    })
    assert.equal(result.access.allow_canva, true)
    assert.equal(result.access.allow_seo, false)
    assert.equal(result.limits.maxFileSizeMb, 10)
    assert.equal(result.overrides.length, 0)
  })

  it('replaces Corporate package features with account overrides', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: flags({ allow_canva: '1', allow_seo: '1', max_file_size_mb: '10' }),
      subscription: { id: 'sub-corp', quantity: 15, endsAt: null },
      overrides: flags({ allow_canva: '0', max_file_size_mb: '50' }),
    })
    assert.equal(result.access.allow_canva, false)
    assert.equal(result.access.allow_seo, true)
    assert.equal(result.limits.maxFileSizeMb, 50)
    assert.equal(result.overrides.length, 2)
  })

  it('restores Corporate package features when overrides are removed', () => {
    const catalog = flags({ allow_canva: '1', max_file_size_mb: '10' })
    const overridden = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: catalog,
      subscription: { id: 'sub-corp', quantity: 15, endsAt: null },
      overrides: flags({ allow_canva: '0', max_file_size_mb: '50' }),
    })
    const restored = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate' },
      features: catalog,
      subscription: { id: 'sub-corp', quantity: 15, endsAt: null },
      overrides: [],
    })
    assert.equal(overridden.access.allow_canva, false)
    assert.equal(overridden.limits.maxFileSizeMb, 50)
    assert.equal(restored.access.allow_canva, true)
    assert.equal(restored.limits.maxFileSizeMb, 10)
    assert.equal(restored.overrides.length, 0)
  })

  it('does not activate a paid package from an incomplete Stripe subscription', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-pro', slug: 'professional', name: 'Professional' },
      features: flags({ max_cards: '3', allow_canva: '1' }),
      subscription: { id: 'sub-pro', quantity: 3, endsAt: null, provider: 'stripe', stripeStatus: 'incomplete' },
    })
    assert.equal(result.subscriptionActive, false)
    assert.equal(result.subscriptionStatus, 'pending_payment')
    assert.equal(result.packageSlug, 'professional')
    assert.equal(result.backOffice, 'single')
    assert.equal(result.access.allow_canva, false)
    assert.equal(result.source, 'none')
  })

  it('exposes catalog media flags and Corporate card capacity', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate', ownerMode: 'corporate' },
      features: flags({
        max_cards: '25',
        allow_2d_explainer: '1',
        allow_background_video_upload: '0',
        max_file_size_mb: 'unlimited',
      }),
      subscription: { id: 'sub-corp', quantity: 25, endsAt: null, provider: 'admin', stripeStatus: 'active' },
      cardsUsed: 18,
    })
    assert.equal(result.backOffice, 'corporate')
    assert.equal(result.subscriptionStatus, 'active')
    assert.equal(result.features.find((row) => row.featureKey === 'allow_2d_explainer')?.featureValue, '1')
    assert.equal(result.features.find((row) => row.featureKey === 'allow_background_video_upload')?.featureValue, '0')
    assert.equal(result.features.find((row) => row.featureKey === 'max_file_size_mb')?.unlimited, true)
    assert.equal(result.limits.maxFileSizeMb, null)
    assert.deepEqual(result.cardCapacity, { limit: 25, used: 18, remaining: 7 })
  })

  it('ignores sneaked max_cards overrides on Corporate catalogs', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate', ownerMode: 'corporate' },
      features: flags({ max_cards: '25', allow_canva: '1' }),
      subscription: { id: 'sub-corp', quantity: 10, endsAt: null, provider: 'admin', stripeStatus: 'active' },
      overrides: flags({ max_cards: '99', allow_canva: '0' }),
      cardsUsed: 10,
    })
    assert.equal(result.limits.maxCards, 10)
    assert.equal(result.access.allow_canva, false)
    assert.deepEqual(result.cardCapacity, { limit: 10, used: 10, remaining: 0 })
  })

  it('does not grant Corporate card seats before Stripe payment', () => {
    const result = buildEffectiveEntitlements({
      role: 'corporate-owner',
      pkg: { id: 'pkg-corp', slug: 'corporate', name: 'Corporate', ownerMode: 'corporate' },
      features: flags({ max_cards: '25', allow_canva: '1' }),
      subscription: {
        id: 'sub-corp',
        quantity: 25,
        endsAt: null,
        provider: 'stripe',
        stripeStatus: 'incomplete',
      },
      cardsUsed: 0,
    })
    assert.equal(result.subscriptionStatus, 'pending_payment')
    assert.equal(result.subscriptionActive, false)
    assert.equal(result.access.allow_canva, false)
    assert.equal(result.limits.maxCards, 0)
    assert.deepEqual(result.cardCapacity, { limit: 0, used: 0, remaining: 0 })
  })
})
