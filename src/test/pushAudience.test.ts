import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cardChangeAlsoReachesSavers,
  isOperationalPushType,
  mergeAnnouncementPushProfiles,
  skipsPublicProfileGate,
} from '../utils/pushAudience'

describe('push audience', () => {
  it('treats meetings, repeat views, and save-contact as operational alerts', () => {
    for (const type of ['meeting_alert', 'viewer_return', 'save_contact']) {
      assert.equal(isOperationalPushType(type), true)
      assert.equal(skipsPublicProfileGate(type), true)
      assert.equal(cardChangeAlsoReachesSavers(type), false)
    }
  })

  it('sends card edits to saved contacts and still requires a public card for the follower blast', () => {
    for (const type of ['contact_updates', 'theme_updates', 'service_updates', 'news', 'business_hours']) {
      assert.equal(cardChangeAlsoReachesSavers(type), true)
      assert.equal(skipsPublicProfileGate(type), false)
    }
  })

  it('delivers global notices to every subscribed card and specific notices only to matched cards', () => {
    assert.equal(skipsPublicProfileGate('announcement_updates'), true)

    const globalIds = mergeAnnouncementPushProfiles({
      targetType: 'all',
      showPublic: true,
      explicitProfileIds: ['owner-card'],
      emailMatchedProfileIds: [],
      activeSubscriptionProfileIds: ['saver-a', 'saver-b', 'owner-card'],
    })
    assert.deepEqual(globalIds.sort(), ['owner-card', 'saver-a', 'saver-b'])

    const specificIds = mergeAnnouncementPushProfiles({
      targetType: 'specific',
      showPublic: true,
      explicitProfileIds: ['owner-card'],
      emailMatchedProfileIds: ['guest-card'],
      activeSubscriptionProfileIds: ['someone-else'],
    })
    assert.deepEqual(specificIds.sort(), ['guest-card', 'owner-card'])

    const inboxOnly = mergeAnnouncementPushProfiles({
      targetType: 'all',
      showPublic: false,
      explicitProfileIds: ['owner-card'],
      emailMatchedProfileIds: ['guest-card'],
      activeSubscriptionProfileIds: ['someone-else'],
    })
    assert.deepEqual(inboxOnly.sort(), ['guest-card', 'owner-card'])
  })
})
