import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fallbackPushTitle,
  noteAssigneePush,
  noteOwnerPush,
  scheduleOwnerPush,
  wishLeadPush,
  wishOwnerDeliveredPush,
} from '../utils/pushRecipientCopy'

describe('pushRecipientCopy', () => {
  it('never uses bare Card updated / Update fallbacks', () => {
    assert.notEqual(fallbackPushTitle('service_updates', 'WD'), 'Card updated')
    assert.notEqual(fallbackPushTitle('meeting_alert', 'WD'), 'Update')
    assert.match(fallbackPushTitle('service_updates', 'WD'), /Services updated/)
    assert.match(fallbackPushTitle('meeting_alert', 'WD'), /CRM alert/)
    assert.match(fallbackPushTitle('save_contact', 'WD'), /New contact activity/)
    assert.match(fallbackPushTitle('viewer_return', 'WD'), /viewed your card again/)
  })

  it('labels wish lead vs card-owner delivery roles', () => {
    const lead = wishLeadPush({
      type: 'Birthday Wish',
      host: 'Acme',
      recipientName: 'Jordan',
      date: '2026-10-18',
      time: '10:00 AM',
    })
    const owner = wishOwnerDeliveredPush({
      type: 'Birthday Wish',
      leadCount: 2,
      date: '2026-10-18',
      time: '10:00 AM',
      timezone: 'America/New_York',
    })
    assert.match(lead.title, /Acme sent you/)
    assert.match(lead.body, /Hi Jordan/)
    assert.match(owner.title, /Wish delivered/)
    assert.match(owner.body, /2 leads/)
  })

  it('labels schedule and note recipients as card owner or assignee', () => {
    const schedule = scheduleOwnerPush({
      type: 'Intro call',
      host: 'Sam',
      date: '2026-10-18',
      time: '3:00 PM',
      phase: 'starting',
    })
    assert.match(schedule.title, /Starting now/)
    assert.match(schedule.body, /Sam/)

    const ownerNote = noteOwnerPush({ title: 'Follow up', actorName: 'Alex' })
    const assigneeNote = noteAssigneePush({ title: 'Follow up', actorName: 'Alex' })
    assert.match(ownerNote.title, /Card owner/)
    assert.match(assigneeNote.title, /Assigned to you/)
  })
})
