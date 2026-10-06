import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isHideOwnerMediaEnabled, withoutOwnedIds } from '../utils/memberMediaVisibility'

describe('member media visibility', () => {
  it('treats the checkbox values as on', () => {
    assert.equal(isHideOwnerMediaEnabled('1'), true)
    assert.equal(isHideOwnerMediaEnabled('true'), true)
    assert.equal(isHideOwnerMediaEnabled('0'), false)
    assert.equal(isHideOwnerMediaEnabled(''), false)
    assert.equal(isHideOwnerMediaEnabled(null), false)
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
