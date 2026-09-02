import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultAllowFlagValue, entitlementsFromFeatures } from '../constants/packageAccess'
import AppError from '../error/AppError'
import {
  buildCrmExternalLeadMeta,
  crmOriginFromMeta,
  guestSaveDashboardVisibleWhere,
  guestSaveExternalWhere,
  guestSaveOriginWhere,
  isCrmExternalMeta,
} from '../utils/crmLeadOrigin'
import {
  assertCrmStaffAuthorization,
  assertRequestedProfileInScope,
  crmProfileWhere,
  isProfileIdInCrmScope,
  profileOwnedByCrmActor,
  resolveCrmScopeKind,
  stripClientOwnershipClaims,
} from '../utils/crmScope'
import { buildEffectiveEntitlements } from '../utils/effectiveEntitlements'

const flags = (rows: Record<string, string>) =>
  Object.entries(rows).map(([featureKey, featureValue]) => ({ featureKey, featureValue }))

function assertForbidden(fn: () => void) {
  assert.throws(fn, (err: unknown) => err instanceof AppError && err.statusCode === 403)
}

function assertNotFound(fn: () => void) {
  assert.throws(fn, (err: unknown) => err instanceof AppError && err.statusCode === 404)
}

describe('CRM package entitlement', () => {
  it('locks CRM when allow_crm is missing', () => {
    const access = entitlementsFromFeatures(flags({ allow_seo: '1' }), true)
    assert.equal(access.allow_crm, false)
    assert.equal(access.allow_seo, true)
  })

  it('includes CRM only when the package flag is on', () => {
    const locked = entitlementsFromFeatures(flags({ allow_crm: '0' }), true)
    const open = entitlementsFromFeatures(flags({ allow_crm: '1' }), true)
    assert.equal(locked.allow_crm, false)
    assert.equal(open.allow_crm, true)
  })

  it('does not backfill missing CRM flags as enabled', () => {
    assert.equal(defaultAllowFlagValue('allow_crm'), '0')
    assert.equal(defaultAllowFlagValue('allow_seo'), '1')
  })

  it('keeps Free CRM off even when other missing allow_* default on', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-free', slug: 'free', name: 'Free' },
      features: flags({ max_cards: '1', allow_canva: '0' }),
      subscription: { id: 'sub-free', quantity: 1, endsAt: null },
    })
    assert.equal(result.access.allow_crm, false)
  })

  it('honors allow_crm on Professional', () => {
    const result = buildEffectiveEntitlements({
      role: 'vcard-owner',
      pkg: { id: 'pkg-pro', slug: 'professional', name: 'Professional' },
      features: flags({ max_cards: '1', allow_crm: '1' }),
      subscription: { id: 'sub-pro', quantity: 1, endsAt: null },
    })
    assert.equal(result.access.allow_crm, true)
  })
})

describe('CRM access scope', () => {
  it('maps roles to admin / corporate / single scopes', () => {
    assert.equal(resolveCrmScopeKind('super-admin'), 'admin')
    assert.equal(resolveCrmScopeKind('admin'), 'admin')
    assert.equal(resolveCrmScopeKind('corporate-owner'), 'corporate')
    assert.equal(resolveCrmScopeKind('vcard-owner'), 'single')
  })

  it('lets super-admin use CRM without module flags', () => {
    assert.doesNotThrow(() => assertCrmStaffAuthorization({ role: 'super-admin', allowedModules: [] }))
  })

  it('lets an admin with the leads module use CRM', () => {
    assert.doesNotThrow(() => assertCrmStaffAuthorization({ role: 'admin', allowedModules: ['leads', 'dashboard'] }))
  })

  it('denies an admin without the leads module', () => {
    assertForbidden(() => assertCrmStaffAuthorization({ role: 'admin', allowedModules: ['dashboard', 'support'] }))
  })

  it('does not treat card-user role as company-wide CRM', () => {
    const where = crmProfileWhere('user-sarah', 'single')
    assert.deepEqual(where, { userId: 'user-sarah' })
    assert.equal(
      profileOwnedByCrmActor('single', 'user-sarah', { userId: 'user-sarah', companyUserId: 'corp-abc' }),
      true
    )
    assert.equal(
      profileOwnedByCrmActor('single', 'user-sarah', { userId: 'user-john', companyUserId: 'corp-abc' }),
      false
    )
  })

  it('lets a corporate owner see company cards and not another company', () => {
    assert.equal(
      profileOwnedByCrmActor('corporate', 'corp-abc', { userId: 'user-sarah', companyUserId: 'corp-abc' }),
      true
    )
    assert.equal(
      profileOwnedByCrmActor('corporate', 'corp-abc', { userId: 'user-mike', companyUserId: 'corp-xyz' }),
      false
    )
  })

  it('ignores client-supplied ownership IDs as proof of access', () => {
    const stripped = stripClientOwnershipClaims({
      title: 'Follow up',
      corporateAccountId: 'corp-xyz',
      ownerId: 'someone-else',
      ownerUserId: 'someone-else',
      companyUserId: 'corp-xyz',
      accountId: 'acct',
      profileId: 'card-1',
    })
    assert.equal(stripped.title, 'Follow up')
    assert.equal(stripped.profileId, 'card-1')
    assert.equal('corporateAccountId' in stripped, false)
    assert.equal('ownerId' in stripped, false)
    assert.equal('ownerUserId' in stripped, false)
    assert.equal('companyUserId' in stripped, false)
    assert.equal('accountId' in stripped, false)
  })

  it('rejects a profile filter outside the session scope', () => {
    const single = { profileIds: ['card-a'] }
    assert.equal(isProfileIdInCrmScope(single, 'card-a'), true)
    assert.equal(isProfileIdInCrmScope(single, 'card-b'), false)
    assert.doesNotThrow(() => assertRequestedProfileInScope(single, 'card-a'))
    assertNotFound(() => assertRequestedProfileInScope(single, 'card-b'))
    assert.equal(isProfileIdInCrmScope({ profileIds: null }, 'any-card'), true)
  })
})

describe('CRM external lead origin', () => {
  it('marks and reads crmOrigin on guest meta', () => {
    const meta = buildCrmExternalLeadMeta('Follow up Friday')
    assert.equal(crmOriginFromMeta(meta), 'crm_external')
    assert.equal(isCrmExternalMeta(meta), true)
    assert.equal(crmOriginFromMeta({ userAgent: 'Mozilla' }), 'guest')
    assert.equal(isCrmExternalMeta(null), false)
  })

  it('builds dashboard-visible vs external Prisma filters', () => {
    assert.deepEqual(guestSaveDashboardVisibleWhere(), {
      NOT: { meta: { path: ['crmOrigin'], equals: 'external' } },
    })
    assert.deepEqual(guestSaveExternalWhere(), {
      meta: { path: ['crmOrigin'], equals: 'external' },
    })
    assert.deepEqual(guestSaveOriginWhere('guest'), guestSaveDashboardVisibleWhere())
    assert.deepEqual(guestSaveOriginWhere('crm_external'), guestSaveExternalWhere())
    assert.deepEqual(guestSaveOriginWhere(), {})
  })
})
