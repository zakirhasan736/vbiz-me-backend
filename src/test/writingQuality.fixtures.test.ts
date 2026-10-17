import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { REALTOR_AFTER, REALTOR_BEFORE, scoreWritingUpgrade } from '../services/ai/writingQuality.fixtures'

describe('writing quality before/after fixtures', () => {
  it('shows first-person About and in-range service copy after upgrade', () => {
    const before = scoreWritingUpgrade({
      about: REALTOR_BEFORE.about,
      serviceDescription: REALTOR_BEFORE.service.description,
    })
    const after = scoreWritingUpgrade({
      about: REALTOR_AFTER.about,
      serviceDescription: REALTOR_AFTER.service.description,
    })

    assert.equal(before.firstPerson, false)
    assert.equal(before.serviceInRange, false)
    assert.ok(before.serviceWordCount < 40)

    assert.equal(after.firstPerson, true)
    assert.equal(after.serviceInRange, true)
    assert.ok(after.aboutWordCount >= 40)
    assert.match(REALTOR_AFTER.service.title, /🏠/)
  })
})
