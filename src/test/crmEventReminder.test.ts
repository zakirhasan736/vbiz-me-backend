import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const reminderService = readFileSync(join(here, '../services/crmReminder.service.ts'), 'utf8')
const meetingService = readFileSync(join(here, '../services/meeting.service.ts'), 'utf8')

describe('CRM Wish & Outreach event reminders', () => {
  it('fires due CrmEvents at startsAt with a 7-day catch-up window', () => {
    assert.match(reminderService, /CRM_EVENT_CATCHUP_DAYS = 7/)
    assert.match(reminderService, /startsAt:\s*\{\s*gte:\s*catchupFloor,\s*lte:\s*now\s*\}/)
    assert.doesNotMatch(reminderService, /processCrmEventReminders\(leadMinutes\)/)
  })

  it('includes wish description in email, inbox, and push payloads', () => {
    assert.match(reminderService, /description\?: string \| null/)
    assert.match(reminderService, /<strong>Message<\/strong>/)
    assert.match(reminderService, /const pushBody = description/)
    assert.match(reminderService, /truncateForPush\(description/)
  })

  it('notifies sender via inbox/push with userId and excludes sender from Zoho email loop', () => {
    assert.match(reminderService, /Your wish was delivered:/)
    assert.match(reminderService, /userId:\s*event\.createdBy\.id/)
    const emailLoop = reminderService.lastIndexOf('for (const email of recipientList)')
    const senderNotify = reminderService.indexOf('Your wish was delivered:')
    assert.ok(emailLoop >= 0)
    assert.ok(senderNotify > emailLoop)
  })
})

describe('Schedule / Book Discussion meeting notifications', () => {
  it('fires due meetings at startsAt with a 7-day catch-up window', () => {
    assert.match(reminderService, /MEETING_CATCHUP_DAYS = 7/)
    assert.doesNotMatch(reminderService, /processMeetingReminders\(leadMinutes\)/)
  })

  it('emails and pushes receivers at due time, including guest leads', () => {
    assert.match(reminderService, /guestUserData:\s*\{\s*select:\s*\{\s*email:\s*true,\s*fullName:\s*true\s*\}\s*\}/)
    assert.match(reminderService, /Meeting reminder email failed/)
    assert.match(reminderService, /Session starting:/)
  })

  it('notifies meeting sender via inbox/push at due time and on create', () => {
    assert.match(reminderService, /Your session is starting:/)
    assert.match(reminderService, /userId:\s*meeting\.createdBy\.id/)
    assert.match(meetingService, /notifySenderAnnouncement/)
    assert.match(meetingService, /Session booked:/)
    assert.match(meetingService, /userId:\s*actor\.id/)
  })
})
