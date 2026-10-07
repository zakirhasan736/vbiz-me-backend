import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hiddenOwnerMediaMatches,
  isHideOwnerMediaEnabled,
  ownerMediaFingerprint,
  parseHiddenOwnerMedia,
  withoutOwnedIds,
} from '../utils/memberMediaVisibility'

describe('member media visibility', () => {
  it('treats the checkbox values as on', () => {
    assert.equal(isHideOwnerMediaEnabled('1'), true)
    assert.equal(isHideOwnerMediaEnabled('true'), true)
    assert.equal(isHideOwnerMediaEnabled('0'), false)
    assert.equal(isHideOwnerMediaEnabled(''), false)
    assert.equal(isHideOwnerMediaEnabled(null), false)
  })

  it('matches a hidden owner photo after its id changes', () => {
    const original = { id: 'old-id', title: 'Office', imageUrl: 'https://cdn.example/office.jpg' }
    const synced = { id: 'new-id', title: 'Office', imageUrl: 'https://cdn.example/office.jpg' }
    const entries = [{ id: original.id, fingerprint: ownerMediaFingerprint(original) }]
    assert.equal(hiddenOwnerMediaMatches(entries, original), true)
    assert.equal(hiddenOwnerMediaMatches(entries, synced), true)
    assert.equal(hiddenOwnerMediaMatches(entries, { id: 'mine', title: 'Headshot' }), false)
    assert.deepEqual(parseHiddenOwnerMedia(JSON.stringify({ photos: entries, videos: [] })).photos, entries)
  })

  it('drops only owner-synced rows', () => {
    const rows = [
      { id: 'owner-photo', title: 'Office' },
      { id: 'mine', title: 'Headshot' },
    ]
    assert.deepEqual(withoutOwnedIds(rows, new Set(['owner-photo'])), [{ id: 'mine', title: 'Headshot' }])
    assert.deepEqual(withoutOwnedIds(rows, new Set()), rows)
  })
})
