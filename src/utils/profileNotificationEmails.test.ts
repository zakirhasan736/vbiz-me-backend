import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectProfileNotificationEmails } from './profileNotificationEmails'

describe('collectProfileNotificationEmails', () => {
  it('prefers card contact email over stale login email', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'hello@vbizme.com',
        userEmail: 'absolutsaluteinc@gmail.com',
        companyUserEmail: null,
      }),
      ['hello@vbizme.com']
    )
  })

  it('falls back to login email when card email is missing', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: '  ',
        userEmail: 'owner@gmail.com',
        companyUserEmail: null,
      }),
      ['owner@gmail.com']
    )
  })

  it('includes corporate email and de-dupes', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'card@vbizme.com',
        userEmail: 'card@vbizme.com',
        companyUserEmail: 'corp@vbizme.com',
      }),
      ['card@vbizme.com', 'corp@vbizme.com']
    )
  })
})
