import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const crmEventService = readFileSync(join(here, '../services/crmEvent.service.ts'), 'utf8')
const reminderService = readFileSync(join(here, '../services/crmReminder.service.ts'), 'utf8')
const meetingService = readFileSync(join(here, '../services/meeting.service.ts'), 'utf8')
const exactOwnerNotify = readFileSync(join(here, '../services/exactOwnerNotify.service.ts'), 'utf8')

describe('CRM Wish & Outreach delivery timing', () => {
  it('does not deliver wish email/push to leads on create — only schedules and confirms the owner', () => {
    assert.match(crmEventService, /On create: schedule only/)
    assert.match(crmEventService, /Scheduled: \$\{row\.type\}/)
    assert.doesNotMatch(crmEventService, /notifyVisitorChannels/)
    assert.match(crmEventService, /No browser push on create/)
    assert.match(crmEventService, /recipientLeadIds/)
    assert.match(crmEventService, /resolveWishLeadIds/)
  })

  it('at startsAt delivers lead email+SMS link and confirms the card owner (inbox/email/push/SMS)', () => {
    assert.match(reminderService, /startsAt:\s*\{\s*gte:\s*catchupFloor,\s*lte:\s*now\s*\}/)
    assert.match(reminderService, /wishOwnerDeliveredPush|Wish sent:/)
    assert.match(reminderService, /wishLeadPush|Wish for you:/)
    assert.match(reminderService, /notifyExactCardOwnerInbox/)
    assert.match(reminderService, /smsTopic:\s*'Wish'/)
    assert.match(reminderService, /notifyVisitorChannels/)
    assert.match(reminderService, /leadWishLink/)
    assert.match(reminderService, /recipientLeadIds/)
  })

  it('never enables public-saver browser push from CRM reminder inbox helpers', () => {
    assert.match(reminderService, /showPublic: '0'/)
    assert.match(reminderService, /onlyBackoffice: '1'/)
    assert.match(reminderService, /allowPush = options\?\.sendPush === true/)
  })
})

describe('Schedule / event public push isolation', () => {
  it('does not browser-push guests for meeting schedule alerts', () => {
    assert.match(meetingService, /never public Web Push for schedules\/events/)
    assert.doesNotMatch(meetingService, /audience: 'all'/)
  })

  it('visitor channel push is opt-in and owner-audience only (no public saver fan-out)', () => {
    assert.match(exactOwnerNotify, /allowPush\?: boolean/)
    assert.match(exactOwnerNotify, /if \(opts\.allowPush\)/)
    assert.match(exactOwnerNotify, /audience: 'owners'/)
    assert.match(exactOwnerNotify, /not for public card-saver fan-out/)
  })
})
