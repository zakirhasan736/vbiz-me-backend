import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import { prisma } from '../utils/prisma'
import type {
  CreateMeetingInput,
  ListMeetingsQuery,
  MeetingStatus,
  UpdateMeetingInput,
} from '../zodValidation/meeting.zod'

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

function serializeMeeting(row: {
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
  createdAt: Date
  updatedAt: Date
}) {
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
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

const create = async (actor: { id: string; email: string; name?: string | null }, input: CreateMeetingInput) => {
  if (input.profileId) {
    const profile = await prisma.profile.findUnique({ where: { id: input.profileId }, select: { id: true } })
    if (!profile) throw new AppError(404, 'Profile not found')
  }

  const status = input.status ?? 'Scheduled'
  const startsAt = computeStartsAt(input.date, input.time)

  const row = await prisma.meeting.create({
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

  const actorLabel = actor.name?.trim() || actor.email || 'Admin'
  await writeAuditLog({
    action: 'Meeting Scheduled',
    details: `${input.type} with ${input.host} on ${input.date} at ${input.time}`,
    type: 'schedule',
    actor: actorLabel,
    actorId: actor.id,
    profileId: input.profileId ?? null,
    meta: { meetingId: row.id, meetingType: input.type, status },
  })

  return serializeMeeting(row)
}

const update = async (
  id: string,
  actor: { id: string; email: string; name?: string | null },
  input: UpdateMeetingInput
) => {
  const existing = await prisma.meeting.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Meeting not found')

  if (input.profileId) {
    const profile = await prisma.profile.findUnique({ where: { id: input.profileId }, select: { id: true } })
    if (!profile) throw new AppError(404, 'Profile not found')
  }

  const nextDate = input.date ?? existing.date
  const nextTime = input.time ?? existing.time
  const dateOrTimeChanged = Boolean(input.date || input.time)

  const row = await prisma.meeting.update({
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

const remove = async (id: string, actor: { id: string; email: string; name?: string | null }) => {
  const existing = await prisma.meeting.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Meeting not found')

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
