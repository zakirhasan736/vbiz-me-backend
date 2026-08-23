import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canUseCorporateBackOffice,
  homePathForOwnerMode,
  ownerOfficeRedirectPath,
  resolveOwnerMode,
  resolveProvisionCardQuantity,
  roleForOwnerMode,
} from '../constants/packageOwnerMode'

describe('package owner-mode resolution', () => {
  it('maps Free to Single back office', () => {
    assert.equal(resolveOwnerMode({ slug: 'free', name: 'Free' }), 'single')
    assert.equal(roleForOwnerMode('single'), 'vcard-owner')
  })

  it('maps Professional to Single back office', () => {
    assert.equal(resolveOwnerMode({ slug: 'professional', name: 'Professional' }), 'single')
  })

  it('maps Concierge to Single back office', () => {
    assert.equal(resolveOwnerMode({ slug: 'professional-concierge', name: 'Professional Concierge' }), 'single')
  })

  it('prefers stored Package.ownerMode over a misleading slug', () => {
    assert.equal(resolveOwnerMode({ slug: 'corporate', name: 'Corporate' }), 'corporate')
    assert.equal(resolveOwnerMode({ ownerMode: 'corporate', slug: 'free', name: 'Free' }), 'corporate')
    assert.equal(resolveOwnerMode({ ownerMode: 'SINGLE', slug: 'corporate', name: 'Corporate' }), 'single')
    assert.equal(resolveOwnerMode({ ownerMode: 'CORPORATE', slug: 'anything' }), 'corporate')
  })

  it('keeps Free / Professional / Concierge off Corporate back office', () => {
    assert.equal(canUseCorporateBackOffice('single'), false)
    assert.equal(homePathForOwnerMode('single'), '/')
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'free' })), '/')
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'professional' })), '/')
    assert.equal(homePathForOwnerMode(resolveOwnerMode({ slug: 'professional-concierge' })), '/')
    assert.equal(ownerOfficeRedirectPath({ pathname: '/teamvcard', ownerMode: 'single' }), '/')
    assert.equal(ownerOfficeRedirectPath({ pathname: '/vcards', ownerMode: 'corporate' }), '/teamvcard')
    assert.equal(ownerOfficeRedirectPath({ pathname: '/vcards/edit/home/abc', ownerMode: 'corporate' }), null)
  })

  it('derives owner role from the selected package', () => {
    assert.equal(roleForOwnerMode(resolveOwnerMode({ slug: 'free' })), 'vcard-owner')
    assert.equal(roleForOwnerMode(resolveOwnerMode({ slug: 'professional' })), 'vcard-owner')
    assert.equal(roleForOwnerMode(resolveOwnerMode({ slug: 'professional-concierge' })), 'vcard-owner')
    assert.equal(roleForOwnerMode(resolveOwnerMode({ slug: 'corporate' })), 'corporate-owner')
  })

  it('uses package max_cards for Single and optional account cap for Corporate', () => {
    assert.equal(resolveProvisionCardQuantity({ ownerMode: 'single', packageMaxCards: 3, cardLimit: 40 }), 3)
    assert.equal(resolveProvisionCardQuantity({ ownerMode: 'corporate', packageMaxCards: 15, cardLimit: 40 }), 40)
    assert.equal(resolveProvisionCardQuantity({ ownerMode: 'corporate', packageMaxCards: 15, cardLimit: null }), 15)
  })
})
