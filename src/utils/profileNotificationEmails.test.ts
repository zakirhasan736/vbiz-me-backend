import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectProfileNotificationEmails, resolveDirectOwnerUserId } from './profileNotificationEmails'

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

  it('does not CC corporate parent on member-card alerts by default', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'julie@vbizme.com',
        userEmail: 'julie@vbizme.com',
        companyUserEmail: 'corp@vbizme.com',
      }),
      ['julie@vbizme.com']
    )
  })

  it('includes corporate email only when explicitly requested', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: 'card@vbizme.com',
        userEmail: 'card@vbizme.com',
        companyUserEmail: 'corp@vbizme.com',
        includeCompanyUser: true,
      }),
      ['card@vbizme.com', 'corp@vbizme.com']
    )
  })

  it('falls back to corporate email when the card has no member contact', () => {
    assert.deepEqual(
      collectProfileNotificationEmails({
        profileEmail: null,
        userEmail: null,
        companyUserEmail: 'corp@vbizme.com',
      }),
      ['corp@vbizme.com']
    )
  })
})

describe('resolveDirectOwnerUserId', () => {
  it('prefers the member login over the corporate parent', () => {
    assert.equal(resolveDirectOwnerUserId({ userId: 'julie', companyUserId: 'corp' }), 'julie')
    assert.equal(resolveDirectOwnerUserId({ userId: null, companyUserId: 'corp' }), 'corp')
  })
})
