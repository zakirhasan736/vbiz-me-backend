import config from '../configs/config'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import announcementService from './announcement.service'
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
      overdue ? `Overdue work note: ${note.title}` : `Work note reminder: ${note.title}`,
      overdue
        ? `"${note.title}" was due ${dueLabel}. Open CRM Work Notes to update it.`
        : `"${note.title}" is due ${dueLabel}. Open CRM Work Notes to continue.`,
      { workNoteId: note.id, href: '/crm' }
    )

    if (note.profileId) {
      pushService.notifyProfileUpdate(note.profileId, {
        title: overdue ? 'Overdue work note' : 'Work note reminder',
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

export async function runCrmReminders() {
  const leadMinutes = config.CRM_REMINDER_CRON.LEAD_MINUTES
  await processWorkNoteReminders(leadMinutes)
  await processMeetingReminders(leadMinutes)
}

const crmReminderService = {
  runCrmReminders,
}

export default crmReminderService
