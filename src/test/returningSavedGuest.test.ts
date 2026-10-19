import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isQualifiedCrmLead } from '../utils/crmLeadOrigin'
import { defaultPushDeliveryAudience, staffAdminAllowsBrowserPush } from '../utils/pushAudience'
import {
  RETURNING_SAVED_GUEST_COOLDOWN_MS,
  RETURNING_SAVED_GUEST_EVENT,
  buildReturningViewCopy,
  formatReturningViewWhen,
  returningGuestEventKey,
  wonReturningGuestClaim,
} from '../utils/returningSavedGuest'

const here = dirname(fileURLToPath(import.meta.url))
const publicCardService = readFileSync(join(here, '../services/publicCard.service.ts'), 'utf8')
const exactOwnerNotify = readFileSync(join(here, '../services/exactOwnerNotify.service.ts'), 'utf8')
const announcementService = readFileSync(join(here, '../services/announcement.service.ts'), 'utf8')

describe('returning saved guest — copy and claim helpers', () => {
  it('builds the required owner-facing message', () => {
    const copy = buildReturningViewCopy({ guestName: 'AB', when: 'Oct 18, 2026, 9:00 AM' })
    assert.equal(copy.title, 'AB viewed your card again')
    assert.match(copy.body, /AB opened your vBiz Me card again on Oct 18, 2026, 9:00 AM/)
  })

  it('formats timestamps in America/New_York, not server-local', () => {
    // Fixed UTC instant → Eastern winter display
    const when = formatReturningViewWhen(new Date('2026-01-15T15:00:00.000Z'), 'America/New_York')
    assert.match(when, /Jan 15, 2026/)
    assert.match(when, /10:00 AM/)
  })

  it('keeps a 30-minute same-visit cooldown so later-day returns still qualify', () => {
    assert.equal(RETURNING_SAVED_GUEST_COOLDOWN_MS, 30 * 60 * 1000)
    assert.equal(RETURNING_SAVED_GUEST_EVENT, 'returning_saved_guest')
  })

  it('resolves concurrent claim races to the oldest eventLog id', () => {
    assert.equal(wonReturningGuestClaim('a', ['a', 'b']), true)
    assert.equal(wonReturningGuestClaim('b', ['a', 'b']), false)
    assert.equal(wonReturningGuestClaim('x', []), false)
  })

  it('builds a stable per-visit event key for delivery audit', () => {
    assert.equal(returningGuestEventKey('card-1', 'guest-ab', 'log-9'), 'returning_saved_guest:card-1:guest-ab:log-9')
  })
})

describe('returning saved guest — wiring contract', () => {
  it('dispatches all four owner channels through exactOwnerNotify with SMS', () => {
    assert.match(publicCardService, /sendSms:\s*true/)
    assert.match(publicCardService, /smsTopic:\s*'Repeat view'/)
    assert.match(publicCardService, /type:\s*'viewer_return'/)
    assert.match(publicCardService, /topic:\s*'card'/)
    assert.match(publicCardService, /eventKey/)
    assert.match(publicCardService, /wonReturningGuestClaim/)
    assert.doesNotMatch(publicCardService, /void smsService\.notifyProfilePhone\(profile\.id, 'Repeat view'/)
  })

  it('keeps channel failures independent and audits SMS', () => {
    assert.match(exactOwnerNotify, /Continue — push \/ email \/ SMS must still run independently/)
    assert.match(exactOwnerNotify, /channel: 'sms'/)
    assert.match(exactOwnerNotify, /sendToProfile/)
    assert.match(exactOwnerNotify, /includeSavers: false/)
  })

  it('does not block operational inbox creates with admin outreach gate', () => {
    assert.match(announcementService, /!inboxOnly/)
    assert.match(announcementService, /Operational inbox/)
  })

  it('routes viewer_return to owners only and allows staff operational push', () => {
    assert.equal(defaultPushDeliveryAudience('viewer_return'), 'owners')
    assert.equal(staffAdminAllowsBrowserPush('viewer_return'), true)
  })

  it('does not treat a repeat view as a new CRM lead qualification event', () => {
    // Name alone still unqualified; return-view path must not invent email/phone.
    assert.equal(isQualifiedCrmLead({ fullName: 'AB', email: null, phone: null }), false)
    assert.doesNotMatch(publicCardService, /guestUserData\.create[\s\S]{0,200}RETURNING_SAVED_GUEST/)
    assert.match(publicCardService, /Never savers \/ other cards \/ admin broadcast/)
  })
})
