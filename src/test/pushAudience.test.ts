import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cardChangeAlsoReachesSavers,
  defaultPushDeliveryAudience,
  exactOwnerPushProfileIds,
  isOperationalPushType,
  mergeAnnouncementPushProfiles,
  skipsPublicProfileGate,
  subscriberKindsForDelivery,
  userMatchesSpecificAnnouncement,
} from '../utils/pushAudience'

describe('push audience', () => {
  it('treats meetings, repeat views, and save-contact as operational alerts', () => {
    for (const type of ['meeting_alert', 'viewer_return', 'save_contact']) {
      assert.equal(isOperationalPushType(type), true)
      assert.equal(skipsPublicProfileGate(type), true)
      assert.equal(cardChangeAlsoReachesSavers(type), false)
    }
  })

  it('keeps card-edit pushes on the updated card only (no cross-card saver fan-out)', () => {
    for (const type of ['contact_updates', 'theme_updates', 'service_updates', 'news', 'business_hours']) {
      assert.equal(cardChangeAlsoReachesSavers(type), false)
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

  it('keeps owner push on the exact card profile only', () => {
    assert.deepEqual(exactOwnerPushProfileIds({ primaryProfileId: 'julie-card' }), ['julie-card'])
    assert.deepEqual(
      exactOwnerPushProfileIds({
        primaryProfileId: null,
        additionalProfileIds: ['a', 'b', 'a'],
      }).sort(),
      ['a', 'b']
    )
  })

  it('routes owner-only events away from public-card savers', () => {
    assert.equal(defaultPushDeliveryAudience('save_contact'), 'owners')
    assert.equal(defaultPushDeliveryAudience('viewer_return'), 'owners')
    assert.equal(defaultPushDeliveryAudience('meeting_alert'), 'owners')
    assert.equal(defaultPushDeliveryAudience('contact_updates'), 'followers')
    assert.equal(defaultPushDeliveryAudience('theme_updates'), 'followers')
    assert.equal(defaultPushDeliveryAudience('announcement_updates'), 'followers')
    assert.deepEqual(subscriberKindsForDelivery('owners'), ['owner'])
    assert.deepEqual(subscriberKindsForDelivery('followers'), ['follower'])
    assert.equal(subscriberKindsForDelivery('all'), null)
  })

  it('matches inbox notices by userId / owned profile, not shared corporate email', () => {
    assert.equal(
      userMatchesSpecificAnnouncement({
        userId: 'julie',
        userEmail: 'corp@vbizme.com',
        targetEmails: ['corp@vbizme.com'],
        metaUserId: 'julie',
        metaProfileId: 'julie-card',
        ownedProfileIds: ['julie-card'],
      }),
      true
    )
    assert.equal(
      userMatchesSpecificAnnouncement({
        userId: 'corp-parent',
        userEmail: 'corp@vbizme.com',
        targetEmails: ['corp@vbizme.com'],
        metaUserId: 'julie',
        metaProfileId: 'julie-card',
        ownedProfileIds: ['other-card'],
      }),
      false
    )
    assert.equal(
      userMatchesSpecificAnnouncement({
        userId: 'julie',
        userEmail: 'julie@vbizme.com',
        targetEmails: ['ignored@example.com'],
        metaUserId: null,
        metaProfileId: 'julie-card',
        ownedProfileIds: ['julie-card'],
      }),
      true
    )
  })
})
