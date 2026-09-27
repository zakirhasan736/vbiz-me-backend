import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countryNameFromCode,
  formatChangeLocation,
  isSnapshotRestorable,
  parseDeviceLabel,
  resolveActorRoleLabel,
  snapshotExpiresAt,
  summarizeCollectionChange,
} from '../utils/cardChangeHistory'

describe('card change history helpers', () => {
  it('labels admin, corporate owner, team member, and card owner', () => {
    assert.equal(
      resolveActorRoleLabel({ actorRole: 'admin', actorUserId: 'a1', profileUserId: 'p1', profileCompanyUserId: 'c1' }),
      'Admin'
    )
    assert.equal(
      resolveActorRoleLabel({
        actorRole: 'corporate-owner',
        actorUserId: 'c1',
        profileUserId: 'm1',
        profileCompanyUserId: 'c1',
      }),
      'Corporate card owner'
    )
    assert.equal(
      resolveActorRoleLabel({
        actorRole: 'vcard-owner',
        actorUserId: 'm1',
        profileUserId: 'm1',
        profileCompanyUserId: 'c1',
      }),
      'Corporate team member'
    )
    assert.equal(
      resolveActorRoleLabel({
        actorRole: 'vcard-owner',
        actorUserId: 'p1',
        profileUserId: 'p1',
        profileCompanyUserId: null,
      }),
      'Card owner'
    )
  })

  it('parses a browser and OS from the user agent', () => {
    assert.equal(
      parseDeviceLabel(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ),
      'Chrome on Windows'
    )
    assert.equal(parseDeviceLabel(''), 'Unknown device')
  })

  it('summarizes add, delete, and update of list items', () => {
    assert.deepEqual(summarizeCollectionChange(2, 4), { action: 'add', summary: 'Added 2 items (2 → 4)' })
    assert.deepEqual(summarizeCollectionChange(3, 1), { action: 'delete', summary: 'Removed 2 items (3 → 1)' })
    assert.deepEqual(summarizeCollectionChange(2, 2), { action: 'update', summary: 'Updated list (2 → 2 items)' })
  })

  it('prints a country name with the IP for the history footprint', () => {
    assert.equal(countryNameFromCode('US'), 'United States')
    assert.equal(formatChangeLocation('172.59.13.230', 'US'), 'United States (US) · 172.59.13.230')
  })

  it('allows restore only while the 72-hour snapshot is still present', () => {
    const expires = snapshotExpiresAt(new Date('2026-09-27T00:00:00.000Z'))
    assert.equal(expires.toISOString(), '2026-09-30T00:00:00.000Z')
    assert.equal(isSnapshotRestorable({ version: 1 }, expires, new Date('2026-09-29T23:00:00.000Z')), true)
    assert.equal(isSnapshotRestorable({ version: 1 }, expires, new Date('2026-09-30T00:00:01.000Z')), false)
    assert.equal(isSnapshotRestorable(null, expires, new Date('2026-09-29T00:00:00.000Z')), false)
  })
})
