import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  absoluteFrontendUrl,
  buildOwnerNotifyEmailHtml,
  notifyAreaLabel,
  notifyTopicLabel,
} from '../utils/ownerNotifyEmail'

describe('ownerNotifyEmail', () => {
  it('labels back-office deep links for email area copy', () => {
    assert.equal(notifyAreaLabel('/?contacts=1', 'card'), 'Contact Saves')
    assert.equal(notifyAreaLabel('/?contacts=1&tab=notes', 'card'), 'Contact Saves · Lead Notes')
    assert.equal(notifyAreaLabel('/crm?tab=leads', 'crm'), 'CRM · Leads')
    assert.equal(notifyAreaLabel('/crm?tab=events', 'crm'), 'CRM · Wish & Outreach')
    assert.equal(notifyTopicLabel('card'), 'Card back-office alert')
    assert.equal(notifyTopicLabel('crm'), 'CRM alert')
  })

  it('builds identity email with name details, area, and absolute CTA', () => {
    const html = buildOwnerNotifyEmailHtml({
      greetingName: 'Alex',
      title: 'New lead: Sam Lee',
      body: 'Sam Lee · sam@example.com shared contact details on Acme Card.',
      topic: 'card',
      href: '/crm?tab=leads',
      cardName: 'Acme Card',
      details: [
        { label: 'Contact', value: 'Sam Lee' },
        { label: 'Email', value: 'sam@example.com' },
      ],
    })
    assert.match(html, /New lead: Sam Lee/)
    assert.match(html, /Sam Lee/)
    assert.match(html, /sam@example\.com/)
    assert.match(html, /CRM · Leads/)
    assert.match(html, /Card back-office alert/)
    assert.match(html, /Open CRM · Leads/)
    assert.match(html, new RegExp(absoluteFrontendUrl('/crm?tab=leads').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})
