import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import type {
  CreateMeetingInput,
  ListMeetingsQuery,
  MeetingStatus,
  UpdateMeetingInput,
} from '../zodValidation/meeting.zod'
import announcementService from './announcement.service'
import googleCalendarService from './googleCalendar/googleCalendar.service'

type Actor = { id: string; email: string; name?: string | null }

type MeetingRow = {
  id: string
  host: string
  type: string
  date: string
  time: string
  startsAt: Date
  location: string | null
  notes: string | null
  status: string
  profileId: string | null
  createdById: string | null
  googleEventId: string | null
  meetLink: string | null
  createdAt: Date
  updatedAt: Date
}

/** Parse display time like "10:00 AM" / "14:30" into hours/minutes. */
function parseTimeParts(time: string): { hours: number; minutes: number } {
  const trimmed = time.trim()
  const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (ampm) {
    let hours = Number(ampm[1])
    const minutes = Number(ampm[2])
    const period = ampm[3].toUpperCase()
    if (period === 'PM' && hours < 12) hours += 12
    if (period === 'AM' && hours === 12) hours = 0
    return { hours, minutes }
  }
  const twentyFour = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  if (twentyFour) {
    return { hours: Number(twentyFour[1]), minutes: Number(twentyFour[2]) }
  }
  return { hours: 0, minutes: 0 }
}

export function computeStartsAt(date: string, time: string): Date {
  const { hours, minutes } = parseTimeParts(time)
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, hours, minutes, 0, 0)
}

function serializeMeeting(row: MeetingRow) {
  return {
    id: row.id,
    host: row.host,
    type: row.type,
    date: row.date,
    time: row.time,
    startsAt: row.startsAt.toISOString(),
    location: row.location,
    notes: row.notes,
    status: row.status as MeetingStatus,
    profileId: row.profileId,
    googleEventId: row.googleEventId,
    meetLink: row.meetLink,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function resolveOwnerEmails(profileId: string | null | undefined): Promise<{
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

function calendarSummary(type: string, host: string) {
  return `${type} with ${host}`
}

function calendarDescription(input: { notes?: string | null; host: string; type: string; meetLink?: string | null }) {
  const parts = [
    `vBiz Me admin schedule: ${input.type}`,
    `Host / card owner: ${input.host}`,
    input.notes?.trim() || null,
    input.meetLink ? `Google Meet: ${input.meetLink}` : null,
  ].filter(Boolean)
  return parts.join('\n\n')
}

async function notifyOwnerAnnouncement(actor: Actor, meeting: MeetingRow, ownerEmails: string[]) {
  if (!ownerEmails.length) return

  const meetLine = meeting.meetLink ? `\n\nGoogle Meet: ${meeting.meetLink}` : ''
  const notesLine = meeting.notes?.trim() ? `\n\n${meeting.notes.trim()}` : ''

  try {
    await announcementService.create(actor, {
      type: 'info',
      kind: 'announcement',
      title: `Meeting scheduled: ${meeting.type}`,
      body: `You have a ${meeting.type} with admin on ${meeting.date} at ${meeting.time}.${notesLine}${meetLine}`,
      status: 'active',
      targetType: 'specific',
      targetEmails: ownerEmails,
      meta: {
        profileId: meeting.profileId || '',
        meetingId: meeting.id,
        meetLink: meeting.meetLink || '',
      },
    })
  } catch (error) {
    logger.error('Failed to create meeting announcement for owner', error)
  }
}

const list = async (query: ListMeetingsQuery) => {
  const skip = query.skip
  const limit = query.limit

  const where: Prisma.MeetingWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.profileId ? { profileId: query.profileId } : {}),
  }

  if (query.from || query.to) {
    where.startsAt = {
      ...(query.from ? { gte: computeStartsAt(query.from, '12:00 AM') } : {}),
      ...(query.to ? { lte: computeStartsAt(query.to, '11:59 PM') } : {}),
    }
  }

  const [total, rows] = await Promise.all([
    prisma.meeting.count({ where }),
    prisma.meeting.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      skip,
      take: limit,
    }),
  ])

  return {
    items: rows.map(serializeMeeting),
    total,
    skip,
    limit,
  }
}

const getOne = async (id: string) => {
  const row = await prisma.meeting.findUnique({ where: { id } })
  if (!row) throw new AppError(404, 'Meeting not found')
  return serializeMeeting(row)
}

const create = async (actor: Actor, input: CreateMeetingInput) => {
  if (input.profileId) {
    const profile = await prisma.profile.findUnique({ where: { id: input.profileId }, select: { id: true } })
    if (!profile) throw new AppError(404, 'Profile not found')
  }

  const status = input.status ?? 'Scheduled'
  const startsAt = computeStartsAt(input.date, input.time)
  const { emails: ownerEmails } = await resolveOwnerEmails(input.profileId)

  let row = await prisma.meeting.create({
    data: {
      host: input.host,
      type: input.type,
      date: input.date,
      time: input.time,
      startsAt,
      location: input.location ?? null,
      notes: input.notes ?? null,
      status,
      profileId: input.profileId ?? null,
      createdById: actor.id,
    },
  })

  if (status === 'Scheduled') {
    const calendar = await googleCalendarService.createMeetingEvent({
      summary: calendarSummary(input.type, input.host),
      description: calendarDescription({
        notes: input.notes,
        host: input.host,
        type: input.type,
      }),
      date: input.date,
      time: input.time,
      attendeeEmail: ownerEmails[0] || null,
    })

    if (calendar) {
      row = await prisma.meeting.update({
        where: { id: row.id },
        data: {
          googleEventId: calendar.eventId,
          meetLink: calendar.meetLink,
          ...(row.location ? {} : calendar.meetLink ? { location: calendar.meetLink } : {}),
        },
      })
    }

    await notifyOwnerAnnouncement(actor, row, ownerEmails)
  }

  const actorLabel = actor.name?.trim() || actor.email || 'Admin'
  await writeAuditLog({
    action: 'Meeting Scheduled',
    details: `${input.type} with ${input.host} on ${input.date} at ${input.time}`,
    type: 'schedule',
    actor: actorLabel,
    actorId: actor.id,
    profileId: input.profileId ?? null,
    meta: {
      meetingId: row.id,
      meetingType: input.type,
      status,
      googleEventId: row.googleEventId || '',
      meetLink: row.meetLink || '',
    },
  })

  return serializeMeeting(row)
}

const update = async (id: string, actor: Actor, input: UpdateMeetingInput) => {
  const existing = await prisma.meeting.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Meeting not found')

  if (input.profileId) {
    const profile = await prisma.profile.findUnique({ where: { id: input.profileId }, select: { id: true } })
    if (!profile) throw new AppError(404, 'Profile not found')
  }

  const nextDate = input.date ?? existing.date
  const nextTime = input.time ?? existing.time
  const dateOrTimeChanged = Boolean(input.date || input.time)

  let row = await prisma.meeting.update({
    where: { id },
    data: {
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.time !== undefined ? { time: input.time } : {}),
      ...(dateOrTimeChanged ? { startsAt: computeStartsAt(nextDate, nextTime) } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
    },
  })

  if (existing.googleEventId) {
    if (input.status === 'Cancelled' || input.status === 'Completed') {
      await googleCalendarService.deleteMeetingEvent(existing.googleEventId)
      if (input.status === 'Cancelled') {
        row = await prisma.meeting.update({
          where: { id },
          data: { googleEventId: null },
        })
      }
    } else if (
      input.date !== undefined ||
      input.time !== undefined ||
      input.notes !== undefined ||
      input.host !== undefined ||
      input.type !== undefined
    ) {
      const updatedCal = await googleCalendarService.updateMeetingEvent(existing.googleEventId, {
        summary: calendarSummary(row.type, row.host),
        description: calendarDescription({
          notes: row.notes,
          host: row.host,
          type: row.type,
          meetLink: row.meetLink,
        }),
        date: row.date,
        time: row.time,
      })
      if (updatedCal?.meetLink && updatedCal.meetLink !== row.meetLink) {
        row = await prisma.meeting.update({
          where: { id },
          data: { meetLink: updatedCal.meetLink },
        })
      }
    }
  }

  const actorLabel = actor.name?.trim() || actor.email || 'Admin'
  const statusChanged = input.status && input.status !== existing.status

  if (statusChanged) {
    const auditType = input.status === 'Cancelled' ? 'cancel' : input.status === 'Completed' ? 'status' : 'update'
    await writeAuditLog({
      action:
        input.status === 'Cancelled'
          ? 'Meeting Cancelled'
          : input.status === 'Completed'
            ? 'Meeting Completed'
            : 'Meeting Updated',
      details: `${row.type} with ${row.host} marked ${input.status}`,
      type: auditType,
      actor: actorLabel,
      actorId: actor.id,
      profileId: row.profileId,
      meta: { meetingId: row.id, previousStatus: existing.status, status: input.status },
    })
  } else {
    await writeAuditLog({
      action: 'Meeting Updated',
      details: `${row.type} with ${row.host} was updated`,
      type: 'update',
      actor: actorLabel,
      actorId: actor.id,
      profileId: row.profileId,
      meta: { meetingId: row.id },
    })
  }

  return serializeMeeting(row)
}

const remove = async (id: string, actor: Actor) => {
  const existing = await prisma.meeting.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Meeting not found')

  if (existing.googleEventId) {
    await googleCalendarService.deleteMeetingEvent(existing.googleEventId)
  }

  await prisma.meeting.delete({ where: { id } })

  const actorLabel = actor.name?.trim() || actor.email || 'Admin'
  await writeAuditLog({
    action: 'Meeting Deleted',
    details: `${existing.type} with ${existing.host} on ${existing.date} was deleted`,
    type: 'delete',
    actor: actorLabel,
    actorId: actor.id,
    profileId: existing.profileId,
    meta: { meetingId: existing.id },
  })

  return { id }
}

const meetingService = {
  list,
  getOne,
  create,
  update,
  remove,
}

export default meetingService
