import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectProfileNotificationEmails } from '../utils/profileNotificationEmails'

describe('collectProfileNotificationEmails — direct owner only', () => {
  it('emails the member, not the corporate parent, when a linked card kept the corporate email', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'Office@Corp.com',
        userEmail: 'b@corp.com',
        companyUserEmail: 'office@corp.com',
      }),
      ['b@corp.com']
    )
  })

  it('uses the linked card own contact email when it differs from corporate', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'b.sales@corp.com',
        userEmail: 'b@corp.com',
        companyUserEmail: 'office@corp.com',
      }),
      ['b.sales@corp.com']
    )
  })

  it('never adds the corporate parent to a member card by default', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'b@corp.com',
        userEmail: 'b@corp.com',
        companyUserEmail: 'office@corp.com',
      }),
      ['b@corp.com']
    )
  })

  it('still emails corporate for its own card and for an unassigned linked card', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({ profileEmail: 'office@corp.com', userEmail: 'office@corp.com' }),
      ['office@corp.com']
    )
    assert.deepEqual(collectProfileNotificationEmails({ companyUserEmail: 'office@corp.com' }), ['office@corp.com'])
  })
})
