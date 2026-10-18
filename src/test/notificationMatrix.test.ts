import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import config from '../configs/config'
import { guestSaveCrmContactableWhere, isQualifiedCrmLead, isRealGuestFullName } from '../utils/crmLeadOrigin'
import {
  cardChangeAlsoReachesSavers,
  defaultPushDeliveryAudience,
  mergeAnnouncementPushProfiles,
  staffAdminAllowsBrowserPush,
} from '../utils/pushAudience'
import { DEFAULT_CAMPAIGN_TIMEZONE, normalizeIanaTimeZone, zonedLocalDateTimeToUtc } from '../utils/scheduleTimezone'

describe('notification matrix — CRM lead qualification', () => {
  it('rejects name-only and anonymous visitor saves as qualified leads', () => {
    assert.equal(isQualifiedCrmLead({ fullName: 'Alex Buyer', email: null, phone: null }), false)
    assert.equal(isQualifiedCrmLead({ fullName: 'Visitor', email: 'a@b.com', phone: null }), false)
    assert.equal(isRealGuestFullName('Visitor'), false)
  })

  it('qualifies name + email, name + phone, and name + both', () => {
    assert.equal(isQualifiedCrmLead({ fullName: 'Alex Buyer', email: 'a@b.com', phone: null }), true)
    assert.equal(isQualifiedCrmLead({ fullName: 'Alex Buyer', email: null, phone: '+15551234567' }), true)
    assert.equal(isQualifiedCrmLead({ fullName: 'Alex Buyer', email: 'a@b.com', phone: '+15551234567' }), true)
  })

  it('CRM contactable filter requires name plus email or phone', () => {
    const where = guestSaveCrmContactableWhere()
    assert.ok(where.AND)
    const and = where.AND as unknown[]
    assert.ok(and.length >= 2)
  })
})

describe('notification matrix — admin browser push (Rule B)', () => {
  it('blocks routine admin browser push; allows operational owner alerts only', () => {
    assert.equal(staffAdminAllowsBrowserPush('announcement_updates'), false)
    assert.equal(staffAdminAllowsBrowserPush('contact_updates'), false)
    assert.equal(staffAdminAllowsBrowserPush('offers'), false)
    assert.equal(staffAdminAllowsBrowserPush('save_contact'), true)
    assert.equal(staffAdminAllowsBrowserPush('viewer_return'), true)
    assert.equal(staffAdminAllowsBrowserPush('meeting_alert'), true)
  })
})

describe('notification matrix — public contact isolation (Rule A)', () => {
  it('never fans card-change pushes to savers via legacy includeSavers path', () => {
    for (const type of [
      'contact_updates',
      'announcement_updates',
      'save_contact',
      'viewer_return',
      'meeting_alert',
      'service_updates',
    ]) {
      assert.equal(cardChangeAlsoReachesSavers(type), false)
    }
  })

  it('routes operational events to owners, not followers', () => {
    assert.equal(defaultPushDeliveryAudience('save_contact'), 'owners')
    assert.equal(defaultPushDeliveryAudience('viewer_return'), 'owners')
    assert.equal(defaultPushDeliveryAudience('meeting_alert'), 'owners')
  })

  it('backoffice-only global announcements do not absorb every active subscription', () => {
    const inbox = mergeAnnouncementPushProfiles({
      targetType: 'all',
      showPublic: false,
      explicitProfileIds: ['owned-card'],
      emailMatchedProfileIds: [],
      activeSubscriptionProfileIds: ['public-saver-a', 'public-saver-b', 'random-owner'],
    })
    assert.deepEqual(inbox, ['owned-card'])
    assert.ok(!inbox.includes('public-saver-a'))
  })

  it('public global announcements include opted-in subscription cards', () => {
    const publicGlobal = mergeAnnouncementPushProfiles({
      targetType: 'all',
      showPublic: true,
      explicitProfileIds: [],
      emailMatchedProfileIds: [],
      activeSubscriptionProfileIds: ['saver-a', 'owner-b'],
    })
    assert.deepEqual(publicGlobal.sort(), ['owner-b', 'saver-a'])
  })
})

describe('notification matrix — USA scheduling / birthday TZ', () => {
  it('uses America/New_York as the default campaign and birthday cron timezone', () => {
    assert.equal(DEFAULT_CAMPAIGN_TIMEZONE, 'America/New_York')
    assert.equal(config.BIRTHDAY_CRON.TZ, 'America/New_York')
    assert.equal(normalizeIanaTimeZone('America/Chicago'), 'America/Chicago')
    assert.equal(normalizeIanaTimeZone('America/Denver'), 'America/Denver')
  })

  it('does not shift Eastern spring-forward wall time by a fixed UTC offset', () => {
    // 2024-03-10 02:30 never existed in America/New_York (DST spring forward).
    // Helper should still produce a stable UTC instant without using a fixed -5/-4 offset string.
    const before = zonedLocalDateTimeToUtc('2024-03-10', '01:30', 'America/New_York')
    const after = zonedLocalDateTimeToUtc('2024-03-10', '03:30', 'America/New_York')
    assert.equal(before.toISOString(), '2024-03-10T06:30:00.000Z') // EST
    assert.equal(after.toISOString(), '2024-03-10T07:30:00.000Z') // EDT
  })

  it('maps Central winter local time correctly', () => {
    const utc = zonedLocalDateTimeToUtc('2024-01-15', '10:00 AM', 'America/Chicago')
    assert.equal(utc.toISOString(), '2024-01-15T16:00:00.000Z')
  })
})
