/**
 * Explicit push titles/bodies so recipients know why they got the alert
 * and which role they are in (card owner, CRM lead, assignee, scheduler).
 */

export type PushRecipientRole = 'card_owner' | 'crm_lead' | 'assignee' | 'scheduler' | 'public_follower'

function truncate(value: string, max = 140): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Public card content → followers/savers on that card (area + deep-link URL required at call site). */
export function publicCardAreaPush(input: {
  areaLabel: string
  businessName: string
  action?: 'updated' | 'added' | 'published'
}): { title: string; body: string } {
  const name = input.businessName.trim() || 'A vBiz Me card'
  const action = input.action || 'updated'
  const area = input.areaLabel.trim() || 'card'
  return {
    title: `${area} ${action}`,
    body: `${name} ${action} their ${area} tab. Tap to open that section on their public card.`,
  }
}

/** Wish / outreach delivered to a selected CRM lead. */
export function wishLeadPush(input: {
  type: string
  host: string
  recipientName?: string | null
  date: string
  time: string
  description?: string | null
}): { title: string; body: string } {
  const type = input.type.trim() || 'Wish'
  const preview = input.description?.trim()
  const host = input.host.trim() || 'Your contact'
  const greeting = input.recipientName?.trim() ? `Hi ${input.recipientName.trim()}, ` : ''
  return {
    title: `${host} sent you a ${type}`,
    body: truncate(
      preview
        ? `${greeting}${host} sent you a ${type} message: “${preview}”`
        : `${greeting}${host} sent you a ${type} message on ${input.date} at ${input.time}. Open it to view the details.`
    ),
  }
}

/** Card owner confirmation that a wish was delivered to leads. */
export function wishOwnerDeliveredPush(input: {
  type: string
  leadCount: number
  date: string
  time: string
  timezone: string
  description?: string | null
}): { title: string; body: string } {
  const type = input.type.trim() || 'Wish'
  const leads = input.leadCount === 1 ? '1 lead' : `${input.leadCount} leads`
  const preview = input.description?.trim()
  return {
    title: `Wish delivered: ${type}`,
    body: truncate(
      preview
        ? `Your ${type} message was delivered to ${leads} on ${input.date} at ${input.time} (${input.timezone}). Message: “${preview}”`
        : `Your ${type} message was delivered to ${leads} on ${input.date} at ${input.time} (${input.timezone}). Open Wish & Outreach for delivery details.`
    ),
  }
}

/** Schedule / meeting reminder for the card owner (not public followers). */
export function scheduleOwnerPush(input: {
  type: string
  host: string
  date: string
  time: string
  meetLink?: string | null
  phase: 'booked' | 'starting'
}): { title: string; body: string } {
  const type = input.type.trim() || 'Session'
  const host = input.host.trim() || 'your contact'
  const join = input.meetLink ? ' Tap to join the meeting.' : ' Open CRM to review.'
  if (input.phase === 'booked') {
    return {
      title: `Scheduled: ${type}`,
      body: truncate(`${type} with ${host} is scheduled for ${input.date} at ${input.time}.${join}`),
    }
  }
  return {
    title: `Starting now: ${type}`,
    body: truncate(`${type} with ${host} starts now (${input.date} ${input.time}).${join}`),
  }
}

/** CRM note for the card owner. */
export function noteOwnerPush(input: {
  title: string
  preview?: string | null
  actorName?: string | null
  overdue?: boolean
}): { title: string; body: string } {
  const noteTitle = input.title.trim() || 'CRM note'
  const actor = input.actorName?.trim()
  if (input.overdue) {
    return {
      title: `Card owner · Overdue note: ${noteTitle}`,
      body: truncate(`"${noteTitle}" is overdue on your card. Open CRM Notes to update it.`),
    }
  }
  return {
    title: `Card owner · CRM note: ${noteTitle}`,
    body: truncate(
      input.preview?.trim() ||
        (actor ? `${actor} added a CRM note on your card. Open CRM Notes to review.` : 'Open CRM Notes to review.')
    ),
  }
}

/** CRM note for an assignee (not necessarily the card owner). */
export function noteAssigneePush(input: { title: string; preview?: string | null; actorName?: string | null }): {
  title: string
  body: string
} {
  const noteTitle = input.title.trim() || 'CRM note'
  const actor = input.actorName?.trim()
  return {
    title: `Assigned to you · CRM note: ${noteTitle}`,
    body: truncate(
      input.preview?.trim() ||
        (actor ? `${actor} assigned you a CRM note. Open CRM Notes to continue.` : 'Open CRM Notes to continue.')
    ),
  }
}

/** Fallback title when callers omit specific copy — still names preference area, never bare "Update". */
export function fallbackPushTitle(type: string, businessName: string): string {
  const name = businessName.trim() || 'Card'
  switch (type) {
    case 'contact_updates':
      return `${name} · Contact info updated`
    case 'theme_updates':
      return `${name} · Theme & design updated`
    case 'service_updates':
      return `${name} · Services updated`
    case 'portfolio_updates':
      return `${name} · Photos updated`
    case 'news':
      return `${name} · New post`
    case 'event_updates':
      return `${name} · Event update`
    case 'business_hours':
      return `${name} · Card details updated`
    case 'announcement_updates':
      return `${name} · Announcement`
    case 'meeting_alert':
      return 'CRM alert'
    case 'viewer_return':
      return 'Visitor viewed your card again'
    case 'save_contact':
      return `${name} · New contact activity`
    default:
      return `${name} · Card section updated`
  }
}

export function fallbackPushBody(type: string, businessName: string): string {
  const name = businessName.trim() || 'A vBiz Me card'
  switch (type) {
    case 'contact_updates':
      return `${name} updated contact information. Tap to open their Contact section.`
    case 'theme_updates':
      return `${name} updated theme and design. Tap to open their card.`
    case 'service_updates':
      return `${name} updated services. Tap to open their Services tab.`
    case 'portfolio_updates':
      return `${name} updated photos. Tap to open their Gallery tab.`
    case 'news':
      return `${name} published a new post. Tap to open it.`
    case 'event_updates':
      return `${name} shared an event update. Tap to open their card.`
    case 'business_hours':
      return `${name} updated card details. Tap to open the updated area.`
    case 'meeting_alert':
      return 'Open CRM for details. This alert is for the responsible card owner or assignee — not public followers.'
    case 'viewer_return':
      return 'A visitor opened your card again. Open Contact Saves to review.'
    case 'save_contact':
      return `Someone interacted with ${name}'s contact details. Open Contact Saves or CRM Leads for the submitted information.`
    default:
      return `${name} updated a section on their public card. Tap to open it.`
  }
}
