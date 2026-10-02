import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { birthdayPersonKey, buildVbizSms, hasFullSaveContactInfo, toE164 } from '../utils/smsMessage'

describe('vBiz Me SMS copy', () => {
  it('formats United States, Canada, UK, India, Pakistan, and Bangladesh numbers', () => {
    assert.equal(toE164('(860) 770-9893'), '+18607709893')
    assert.equal(toE164('1-416-555-0199'), '+14165550199')
    assert.equal(toE164('+1 604 555 0199', 'Canada'), '+16045550199')
    assert.equal(toE164('07123 456789', 'United Kingdom'), '+447123456789')
    assert.equal(toE164('0044 7123 456789'), '+447123456789')
    assert.equal(toE164('9876543210', 'India'), '+919876543210')
    assert.equal(toE164('919876543210'), '+919876543210')
    assert.equal(toE164('0300 1234567', 'Pakistan'), '+923001234567')
    assert.equal(toE164('01712345678', 'Bangladesh'), '+8801712345678')
    assert.equal(toE164('1712345678', '+880'), '+8801712345678')
    assert.equal(toE164('+8801712345678'), '+8801712345678')
    assert.equal(toE164('abc'), null)
    assert.equal(toE164('+33123456789'), null)
  })

  it('names vBiz Me, the topic, the card, and the card URL', () => {
    const text = buildVbizSms({
      topic: '1-on-1',
      cardName: 'Northstar Dental',
      cardUrl: 'https://vbiz.me/vCard/northstar-dental',
      detail: 'Alex proposed times. Open the card to choose one.',
    })
    assert.match(text, /^vBiz Me\n/)
    assert.match(text, /1-on-1: Alex proposed times/)
    assert.match(text, /Card: Northstar Dental/)
    assert.match(text, /https:\/\/vbiz\.me\/vCard\/northstar-dental/)
  })

  it('treats one phone and one birthday as one person, even across many cards', () => {
    const first = birthdayPersonKey('(860) 770-9893', 'United States', 10, 2)
    const second = birthdayPersonKey('+1 860-770-9893', 'US', 10, 2)
    const otherDay = birthdayPersonKey('8607709893', 'USA', 11, 2)
    const otherPhone = birthdayPersonKey('4165550199', 'Canada', 10, 2)
    assert.equal(first, second)
    assert.notEqual(first, otherDay)
    assert.notEqual(first, otherPhone)
    assert.equal(birthdayPersonKey('', 'US', 10, 2), null)
  })

  it('texts a saved contact only when name, email, and phone were all given', () => {
    assert.equal(hasFullSaveContactInfo({ name: 'Alex', email: 'a@b.com', phone: '8607709893' }), true)
    assert.equal(hasFullSaveContactInfo({ name: 'Alex', email: 'a@b.com', phone: '' }), false)
    assert.equal(hasFullSaveContactInfo({ name: '', email: 'a@b.com', phone: '8607709893' }), false)
  })
})
