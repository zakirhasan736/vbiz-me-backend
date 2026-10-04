import { describe, expect, it } from 'vitest'
import { collectProfileNotificationEmails } from './profileNotificationEmails'

describe('collectProfileNotificationEmails', () => {
  it('prefers card contact email over stale login email', () => {
    expect(
      collectProfileNotificationEmails({
        profileEmail: 'hello@vbizme.com',
        userEmail: 'absolutsaluteinc@gmail.com',
        companyUserEmail: null,
      })
    ).toEqual(['hello@vbizme.com'])
  })

  it('falls back to login email when card email is missing', () => {
    expect(
      collectProfileNotificationEmails({
        profileEmail: '  ',
        userEmail: 'owner@gmail.com',
        companyUserEmail: null,
      })
    ).toEqual(['owner@gmail.com'])
  })

  it('includes corporate email and de-dupes', () => {
    expect(
      collectProfileNotificationEmails({
        profileEmail: 'card@vbizme.com',
        userEmail: 'card@vbizme.com',
        companyUserEmail: 'corp@vbizme.com',
      })
    ).toEqual(['card@vbizme.com', 'corp@vbizme.com'])
  })
})
