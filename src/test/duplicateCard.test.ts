import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearedDuplicateContactFields } from '../utils/duplicateCard'

describe('clearedDuplicateContactFields', () => {
  it('blanks unique personal contact fields on a duplicated card', () => {
    assert.deepEqual(clearedDuplicateContactFields, {
      email: '',
      phone: null,
      whatsapp: null,
      dob: null,
      countryCode: null,
    })
  })
})
