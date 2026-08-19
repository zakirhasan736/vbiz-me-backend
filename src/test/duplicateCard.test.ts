import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { duplicateContactFields } from '../utils/duplicateCard'

describe('duplicateContactFields', () => {
  it('preserves email and date of birth on a duplicated card', () => {
    const dob = new Date('1990-07-18T00:00:00.000Z')
    assert.deepEqual(duplicateContactFields({ email: 'owner@example.com', dob }), {
      email: 'owner@example.com',
      dob,
    })
  })

  it('allows a duplicated card to reuse the same email', () => {
    const createInput = {
      name: 'Card (Copy)',
      slug: 'card-copy',
      skipCreateContactRules: true,
      ...duplicateContactFields({ email: 'owner@example.com', dob: '1990-07-18' }),
    }

    assert.equal(createInput.email, 'owner@example.com')
    assert.equal('email' in createInput, true)
    assert.equal('phone' in createInput, false)
    assert.equal('whatsapp' in createInput, false)
    assert.equal(createInput.dob, '1990-07-18')
  })
})
