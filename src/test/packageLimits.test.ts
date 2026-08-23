import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MEDIA_UPLOAD_MAX_BYTES } from '../constants/mediaUpload'
import {
  canCreateAnotherCard,
  countFilledExtraFields,
  countFilledSocialLinks,
  maxUploadBytes,
  remainingCardSlots,
} from '../utils/packageLimits'

describe('package limit helpers', () => {
  it('counts filled social links and extra fields only', () => {
    assert.equal(
      countFilledSocialLinks([
        { name: 'LinkedIn', url: 'https://linkedin.com' },
        { name: '', url: '  ' },
      ]),
      1
    )
    assert.equal(
      countFilledExtraFields(
        JSON.stringify([
          { name: 'License', value: '123' },
          { name: '', value: '' },
        ])
      ),
      1
    )
    assert.equal(countFilledExtraFields('not-json'), 0)
  })

  it('reports remaining corporate card slots without deleting over-cap cards', () => {
    assert.equal(remainingCardSlots(18, 25), 7)
    assert.equal(remainingCardSlots(25, 25), 0)
    assert.equal(remainingCardSlots(30, 25), 0)
    assert.equal(remainingCardSlots(12, null), null)
    assert.equal(canCreateAnotherCard(25, 25), false)
    assert.equal(canCreateAnotherCard(30, 25), false)
  })

  it('caps uploads at the package megabyte limit when it is lower than the global cap', () => {
    assert.equal(maxUploadBytes(null), MEDIA_UPLOAD_MAX_BYTES)
    assert.equal(maxUploadBytes(10), 10 * 1024 * 1024)
    assert.equal(maxUploadBytes(999), MEDIA_UPLOAD_MAX_BYTES)
  })
})
