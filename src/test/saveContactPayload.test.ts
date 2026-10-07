import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildSaveContactFields } from '../utils/saveContactPayload'

describe('save-contact personal info', () => {
  it('uses the public-card address line and designation as Profession when profession is empty', () => {
    const fields = buildSaveContactFields({
      name: 'Mike Donnelly',
      email: 'mdonnelly@thepaddockcars.com',
      phone: '(860) 918-5253',
      companyName: 'The Paddock Classic Car Restoration',
      professionName: '',
      designation: 'President',
      website: 'www.thepaddockcars.com',
      address: '285 Columbus Boulevard',
      city: 'New Britain',
      state: 'Connecticut',
      zipCode: '06051',
    })

    assert.equal(fields.name, 'Mike Donnelly')
    assert.equal(fields.profession, 'President')
    assert.equal(fields.designation, 'President')
    assert.equal(fields.company, 'The Paddock Classic Car Restoration')
    assert.equal(fields.email, 'mdonnelly@thepaddockcars.com')
    assert.equal(fields.phone, '(860) 918-5253')
    assert.equal(fields.website, 'www.thepaddockcars.com')
    assert.equal(fields.address, '285 Columbus Boulevard, New Britain, Connecticut, 06051')
  })

  it('keeps profession and designation when both are set', () => {
    const fields = buildSaveContactFields({
      name: 'Ada',
      professionName: 'Mathematician',
      designation: 'President',
      address: '10 Downing',
      city: 'London',
    })
    assert.equal(fields.profession, 'Mathematician')
    assert.equal(fields.designation, 'President')
    assert.equal(fields.address, '10 Downing, London')
  })
})
