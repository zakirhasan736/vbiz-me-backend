import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countryNameFromCode,
  formatChangeLocation,
  generateChangeCode,
  isSnapshotRestorable,
  parseDeviceLabel,
  resolveActorRoleLabel,
  snapshotExpiresAt,
  summarizeCollectionChange,
} from '../utils/cardChangeHistory'
import { toGalleryWriteData } from '../utils/galleryMedia'

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
      'Corporate Team Owner'
    )
    assert.equal(
      resolveActorRoleLabel({
        actorRole: 'vcard-owner',
        actorUserId: 'm1',
        profileUserId: 'm1',
        profileCompanyUserId: 'c1',
      }),
      'Corporate Team Member'
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

  it('maps snapshot imageUrl onto Gallery featuredImage and drops imageUrl', () => {
    const data = toGalleryWriteData({
      title: 'CBNA 33-3',
      description: '',
      imageUrl: 'https://cdn.example.com/gallery.jpg',
      featuredImage: 'https://cdn.example.com/gallery.jpg',
      url: '',
      status: '1',
    })
    assert.equal(data.featuredImage, 'https://cdn.example.com/gallery.jpg')
    assert.equal('imageUrl' in data, false)
    assert.equal(data.attachmentUrl, null)
    assert.equal(data.attachmentName, null)
  })

  it('allows restore only while the 10-day snapshot is still present', () => {
    const expires = snapshotExpiresAt(new Date('2026-09-27T00:00:00.000Z'))
    assert.equal(expires.toISOString(), '2026-10-07T00:00:00.000Z')
    assert.equal(isSnapshotRestorable({ version: 1 }, expires, new Date('2026-10-06T23:00:00.000Z')), true)
    assert.equal(isSnapshotRestorable({ version: 1 }, expires, new Date('2026-10-07T00:00:01.000Z')), false)
    assert.equal(isSnapshotRestorable(null, expires, new Date('2026-10-06T00:00:00.000Z')), false)
  })

  it('generates a 7-digit change code', () => {
    const code = generateChangeCode()
    assert.match(code, /^[1-9]\d{6}$/)
  })
})
