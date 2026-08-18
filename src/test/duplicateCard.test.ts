import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clearedDuplicateContactFields } from '../utils/duplicateCard'

describe('clearedDuplicateContactFields', () => {
  it('blanks unique email and date of birth on a duplicated card', () => {
    assert.deepEqual(clearedDuplicateContactFields, {
      email: '',
      dob: null,
    })
  })

  it('is spread into duplicate create input so owner email is not copied', () => {
    const createInput = {
      name: 'Card (Copy)',
      slug: 'card-copy',
      ...clearedDuplicateContactFields,
    }

    assert.equal(createInput.email, '')
    assert.equal('email' in createInput, true)
    assert.equal('phone' in createInput, false)
    assert.equal('whatsapp' in createInput, false)
    assert.equal(createInput.dob, null)
  })
})
