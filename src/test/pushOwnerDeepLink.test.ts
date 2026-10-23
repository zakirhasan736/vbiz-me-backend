import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOwnerBackofficePath } from '../utils/pushOwnerDeepLink'

describe('pushOwnerDeepLink', () => {
  it('maps owner areas to exact back-office paths', () => {
    assert.equal(buildOwnerBackofficePath('contacts'), '/?contacts=1')
    assert.equal(buildOwnerBackofficePath('contact_notes'), '/?contacts=1&tab=notes')
    assert.equal(buildOwnerBackofficePath('leads'), '/crm?tab=leads')
    assert.equal(buildOwnerBackofficePath('calendar'), '/crm?tab=calendar')
    assert.equal(buildOwnerBackofficePath('wish'), '/crm?tab=events')
    assert.equal(buildOwnerBackofficePath('crm_notes'), '/crm?tab=work_notes')
    assert.equal(buildOwnerBackofficePath('one_on_one', 'card-1'), '/vcards/edit/home/card-1')
  })
})
