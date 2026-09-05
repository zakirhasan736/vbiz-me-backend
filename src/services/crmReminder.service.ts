import config from '../configs/config'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import announcementService from './announcement.service'
import crmEventService from './crmEvent.service'
import pushService from './push.service'

type SystemActor = {
  id: string
  role: string
  name?: string | null
  email?: string | null
}

async function systemActor(): Promise<SystemActor> {
  const admin = await prisma.user.findFirst({
    where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] }, deletedAt: null },
    select: { id: true, role: true, name: true, email: true },
    orderBy: { createdAt: 'asc' },
  })
  if (admin) {
    return {
      id: admin.id,
      role: admin.role === 'SUPER_ADMIN' ? 'super-admin' : 'admin',
      name: admin.name,
      email: admin.email || 'system@vbizme.com',
    }
  }
  return { id: 'system', role: 'super-admin', name: 'System', email: 'system@vbizme.com' }
}

async function notifyEmails(emails: string[], title: string, body: string, meta: Record<string, string>) {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
  if (!unique.length) return
  const actor = await systemActor()
  try {
    await announcementService.create(
      { id: actor.id, email: actor.email || 'system@vbizme.com', name: actor.name },
      {
        type: 'info',
        kind: 'announcement',
        title,
        body,
        status: 'active',
        targetType: 'specific',
        targetEmails: unique,
        meta: { ...meta, sendPush: '1', category: 'event', channel: 'inbox' },
      }
    )
  } catch (error) {
    logger.error('CRM reminder announcement failed', error)
  }
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }
  return value.replace(/[&<>"']/g, (character) => entities[character] || character)
}

function crmEventEmailHtml(input: {
  recipientName: string
  type: string
  host: string
  date: string
  time: string
  attachments: { url: string; fileName: string; resourceType?: string | null }[]
}) {
  const attachmentBlock = input.attachments.length
    ? [
        '<p style="margin:16px 0 8px"><strong>Attachments</strong></p>',
        '<ul style="padding-left:18px;margin:0">',
        ...input.attachments.map(
          (file) =>
            `<li style="margin:4px 0"><a href="${escapeHtml(file.url)}" style="color:#be123c;text-decoration:none">${escapeHtml(file.fileName)}</a>${
              file.resourceType
                ? ` <span style="color:#64748b;font-size:12px">(${escapeHtml(file.resourceType)})</span>`
                : ''
            }</li>`
        ),
        '</ul>',
      ].join('')
    : ''

  return [
    '<div style="margin:0 auto;max-width:640px;font-family:Arial,sans-serif;color:#172033;line-height:1.6">',
    `<p>Hello ${escapeHtml(input.recipientName)},</p>`,
    `<p>You have a scheduled CRM event from vBiz Me.</p>`,
    '<div style="margin:20px 0;padding:16px 20px;border:1px solid #ffe4e6;border-radius:12px;background:#fff1f2">',
    `<p style="margin:0 0 8px"><strong>${escapeHtml(input.type)}</strong></p>`,
    `<p style="margin:0 0 4px">For: ${escapeHtml(input.host)}</p>`,
    `<p style="margin:0 0 4px">Date: ${escapeHtml(input.date)}</p>`,
    `<p style="margin:0">Time: ${escapeHtml(input.time)}</p>`,
    attachmentBlock,
    '</div>',
    '<p style="margin-top:24px">Regards,<br><strong>vBiz.me Team</strong></p>',
    '</div>',
  ].join('')
}

async function resolveProfileEmails(profileId: string | null | undefined): Promise<{
  emails: string[]
  displayName: string | null
}> {
  if (!profileId) return { emails: [], displayName: null }
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      name: true,
      email: true,
      user: { select: { email: true, name: true } },
      companyUser: { select: { email: true } },
    },
  })
  if (!profile) return { emails: [], displayName: null }
  const emails = [
    ...new Set(
      [profile.user?.email, profile.email, profile.companyUser?.email]
        .map((e) => e?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e))
    ),
  ]
  return {
    emails,
    displayName: profile.user?.name?.trim() || profile.name?.trim() || null,
  }
}

function parseGroupProfileIds(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

async function processWorkNoteReminders(leadMinutes: number) {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + leadMinutes * 60 * 1000)

  const notes = await prisma.workNote.findMany({
    where: {
      status: { not: 'complete' },
      reminderSentAt: null,
      OR: [{ remindAt: { lte: now } }, { dueAt: { lte: windowEnd } }],
    },
    take: 80,
    include: {
      assignee: { select: { email: true } },
      createdBy: { select: { email: true } },
      profile: { select: { id: true, email: true, user: { select: { email: true } } } },
    },
  })

  for (const note of notes) {
    const emails = [note.assignee?.email, note.createdBy.email, note.profile?.email, note.profile?.user?.email].filter(
      (e): e is string => Boolean(e)
    )

    const overdue = Boolean(note.dueAt && note.dueAt.getTime() < now.getTime())
    const dueLabel = note.dueAt ? note.dueAt.toLocaleString() : 'soon'

    await notifyEmails(
      emails,
      overdue ? `Overdue note: ${note.title}` : `Note reminder: ${note.title}`,
      overdue
        ? `"${note.title}" was due ${dueLabel}. Open CRM Notes to update it.`
        : `"${note.title}" is due ${dueLabel}. Open CRM Notes to continue.`,
      { workNoteId: note.id, href: '/crm' }
    )

    if (note.profileId) {
      pushService.notifyProfileUpdate(note.profileId, {
        title: overdue ? 'Overdue note' : 'Note reminder',
        body: note.title,
        type: 'event_updates',
      })
    }

    await prisma.workNote.update({
      where: { id: note.id },
      data: { reminderSentAt: now },
    })
  }
}

async function processMeetingReminders(leadMinutes: number) {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + leadMinutes * 60 * 1000)

  const meetings = await prisma.meeting.findMany({
    where: {
      status: 'Scheduled',
      reminderSentAt: null,
      startsAt: { gte: now, lte: windowEnd },
    },
    take: 50,
    include: {
      profile: {
        select: {
          id: true,
          email: true,
          user: { select: { email: true } },
        },
      },
    },
  })

  for (const meeting of meetings) {
    const emails = [meeting.profile?.email, meeting.profile?.user?.email].filter((e): e is string => Boolean(e))
    await notifyEmails(
      emails,
      `Upcoming: ${meeting.type}`,
      `${meeting.type} with ${meeting.host} starts at ${meeting.date} ${meeting.time}.${
        meeting.meetLink ? ` Join: ${meeting.meetLink}` : ''
      }`,
      { meetingId: meeting.id, href: '/crm' }
    )

    if (meeting.profileId) {
      pushService.notifyProfileUpdate(meeting.profileId, {
        title: `Upcoming: ${meeting.type}`,
        body: `${meeting.date} ${meeting.time}`,
        type: 'event_updates',
      })
    }

    await prisma.meeting.update({
      where: { id: meeting.id },
      data: { reminderSentAt: now },
    })
  }
}

async function processCrmEventReminders(leadMinutes: number) {
  const now = new Date()
  const windowEnd = new Date(now.getTime() + leadMinutes * 60 * 1000)

  const events = await prisma.crmEvent.findMany({
    where: {
      status: 'Scheduled',
      reminderSentAt: null,
      startsAt: { gte: now, lte: windowEnd },
    },
    take: 50,
  })

  for (const event of events) {
    const attachments = crmEventService.parseAttachments(event.attachments)
    const emails = new Set<string>()
    let displayName = event.recipientName?.trim() || event.host

    if (event.recipientEmail?.trim()) {
      emails.add(event.recipientEmail.trim().toLowerCase())
    }

    if (event.scope === 'group') {
      const ids = parseGroupProfileIds(event.groupProfileIds)
      for (const profileId of ids) {
        const resolved = await resolveProfileEmails(profileId)
        for (const email of resolved.emails) emails.add(email)
        if (!event.recipientName && resolved.displayName) displayName = resolved.displayName
      }
    } else if (event.profileId) {
      const resolved = await resolveProfileEmails(event.profileId)
      for (const email of resolved.emails) emails.add(email)
      if (!event.recipientName && resolved.displayName) displayName = resolved.displayName
    }

    const recipientList = [...emails]
    const attachmentSummary = attachments.length
      ? ` Includes ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}.`
      : ''

    await notifyEmails(
      recipientList,
      `CRM event: ${event.type}`,
      `${event.type} for ${event.host} is scheduled at ${event.date} ${event.time}.${attachmentSummary}`,
      { crmEventId: event.id, href: '/crm' }
    )

    if (config.ZOHO_EMAIL_USER && config.ZOHO_EMAIL_PASSWORD) {
      const html = crmEventEmailHtml({
        recipientName: displayName || 'there',
        type: event.type,
        host: event.host,
        date: event.date,
        time: event.time,
        attachments,
      })
      const subject = `${event.type} — ${event.date} ${event.time}`
      for (const email of recipientList) {
        void authUtils
          .sendEmail({
            receiverMail: email,
            subject,
            html,
          })
          .catch((error) => logger.error('CRM event reminder email failed', { error, email, crmEventId: event.id }))
      }
    }

    if (event.profileId) {
      pushService.notifyProfileUpdate(event.profileId, {
        title: `CRM event: ${event.type}`,
        body: `${event.date} ${event.time}`,
        type: 'event_updates',
      })
    } else if (event.scope === 'group') {
      for (const profileId of parseGroupProfileIds(event.groupProfileIds)) {
        pushService.notifyProfileUpdate(profileId, {
          title: `CRM event: ${event.type}`,
          body: `${event.date} ${event.time}`,
          type: 'event_updates',
        })
      }
    }

    await prisma.crmEvent.update({
      where: { id: event.id },
      data: { reminderSentAt: now },
    })
  }
}

export async function runCrmReminders() {
  const leadMinutes = config.CRM_REMINDER_CRON.LEAD_MINUTES
  await processWorkNoteReminders(leadMinutes)
  await processMeetingReminders(leadMinutes)
  await processCrmEventReminders(leadMinutes)
}

const crmReminderService = {
  runCrmReminders,
}

export default crmReminderService
