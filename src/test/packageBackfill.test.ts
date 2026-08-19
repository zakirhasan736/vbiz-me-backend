import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EXPLICIT_ALLOW_FLAG_KEYS } from '../constants/packageAccess'
import {
  assertProfileCountUnchanged,
  decideCorporateQuantityCopy,
  decideMissingSubscription,
  decideOwnerRoleBackfill,
  missingAllowFlagKeys,
} from '../utils/packageBackfill'

describe('package backfill decisions', () => {
  it('attaches Free to Single owners and Corporate to Corporate owners when they have no subscription', () => {
    assert.deepEqual(decideMissingSubscription({ role: 'vcard-owner', hasActiveSubscription: false }), {
      action: 'attach',
      slug: 'free',
    })
    assert.deepEqual(decideMissingSubscription({ role: 'corporate-owner', hasActiveSubscription: false }), {
      action: 'attach',
      slug: 'corporate',
    })
    assert.deepEqual(decideMissingSubscription({ role: 'corporate-owner', hasActiveSubscription: true }), {
      action: 'none',
    })
    assert.deepEqual(decideMissingSubscription({ role: 'admin', hasActiveSubscription: false }), { action: 'none' })
  })

  it('aligns vcard-owner on Corporate and never auto-demotes Corporate owners on Single/Free', () => {
    assert.deepEqual(decideOwnerRoleBackfill({ role: 'vcard-owner', ownerMode: 'corporate' }), {
      action: 'set',
      nextRole: 'corporate-owner',
      reason: 'Package is Corporate; role can be aligned without removing cards.',
    })
    const demote = decideOwnerRoleBackfill({ role: 'corporate-owner', ownerMode: 'single' })
    assert.equal(demote.action, 'report')
    if (demote.action === 'report') {
      assert.equal(demote.code, 'corporate-owner-on-single-package')
    }
    assert.deepEqual(decideOwnerRoleBackfill({ role: 'corporate-owner', ownerMode: 'corporate' }), { action: 'none' })
    assert.deepEqual(decideOwnerRoleBackfill({ role: 'vcard-owner', ownerMode: 'single' }), { action: 'none' })
  })

  it('copies package max_cards into Corporate quantity only when quantity is unset', () => {
    assert.deepEqual(decideCorporateQuantityCopy({ ownerMode: 'corporate', quantity: null, packageMaxCards: 15 }), {
      action: 'set',
      quantity: 15,
    })
    assert.deepEqual(decideCorporateQuantityCopy({ ownerMode: 'corporate', quantity: 40, packageMaxCards: 15 }), {
      action: 'none',
    })
    assert.deepEqual(decideCorporateQuantityCopy({ ownerMode: 'corporate', quantity: 0, packageMaxCards: 15 }), {
      action: 'none',
    })
    assert.deepEqual(decideCorporateQuantityCopy({ ownerMode: 'single', quantity: null, packageMaxCards: 1 }), {
      action: 'none',
    })
  })

  it('adds missing allow_* rows as explicit defaults without touching existing flags', () => {
    const missing = missingAllowFlagKeys(['allow_canva', 'ALLOW_SEO', 'allow_video_upload'])
    assert.equal(missing.includes('allow_canva'), false)
    assert.equal(missing.includes('allow_seo'), false)
    assert.equal(missing.includes('allow_video_upload'), false)
    assert.equal(missing.includes('allow_ai_assistance'), true)
    assert.equal(missing.includes('allow_2d_explainer'), true)
    assert.equal(missing.length, EXPLICIT_ALLOW_FLAG_KEYS.length - 3)
  })

  it('refuses a profile-count drop', () => {
    assert.doesNotThrow(() => assertProfileCountUnchanged(12, 12))
    assert.throws(() => assertProfileCountUnchanged(12, 11), /No profiles may be deleted/)
  })
})
