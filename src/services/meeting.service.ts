import type { Prisma } from '../../generated/prisma/client'
import config from '../configs/config'
import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { assertAdminCanContactProfile } from '../utils/adminOutreachAccess'
import { writeAuditLog } from '../utils/auditLog'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import type {
  CreateMeetingInput,
  ListMeetingsQuery,
  ListOwnerMeetingsQuery,
  MeetingScope,
  MeetingStatus,
  UpdateMeetingInput,
} from '../zodValidation/meeting.zod'
import announcementService from './announcement.service'
import calendarIntegrationService from './calendarIntegration.service'
import pushService from './push.service'

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
  scope: string
  profileId: string | null
  groupProfileIds: Prisma.JsonValue | null
  createdById: string | null
  googleEventId: string | null
  meetLink: string | null
  createdAt: Date
  updatedAt: Date
}

function parseGroupProfileIds(value: Prisma.JsonValue | null | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry || '').trim()).filter(Boolean)
      }
    } catch {
      return []
    }
  }
  return []
}

function resolveCreateScope(input: CreateMeetingInput): MeetingScope {
  return input.scope ?? (input.profileId ? 'one_to_one' : 'global')
}

async function resolveGroupProfileIds(input: CreateMeetingInput): Promise<string[]> {
  const explicit = (input.groupProfileIds || []).map((id) => id.trim()).filter(Boolean)
  if (explicit.length) return [...new Set(explicit)]

  const companyUserId = input.companyUserId?.trim()
  if (!companyUserId) return []

  const profiles = await prisma.profile.findMany({
    where: { companyUserId },
    select: { id: true },
  })
  return profiles.map((profile) => profile.id)
}

async function normalizeCreateInput(input: CreateMeetingInput) {
  const scope = resolveCreateScope(input)
  const groupProfileIds = scope === 'group' ? await resolveGroupProfileIds(input) : []

  if (scope === 'group' && !groupProfileIds.length) {
    throw new AppError(400, 'Group schedules require at least one card')
  }

  return {
    scope,
    profileId:
      scope === 'global'
        ? null
        : scope === 'one_to_one'
          ? (input.profileId ?? null)
          : (input.profileId ?? groupProfileIds[0] ?? null),
    groupProfileIds: scope === 'group' ? groupProfileIds : [],
  }
}

async function assertOwnerCanCreateMeeting(
  userId: string,
  role: string | undefined | null,
  input: CreateMeetingInput,
  normalized: Awaited<ReturnType<typeof normalizeCreateInput>>
) {
  if (isStaffRole(role)) return

  const apiRole = role === 'corporate-owner' || role === 'vcard-owner' ? role : null
  if (!apiRole) throw new AppError(403, 'FORBIDDEN ACCESS')

  if (normalized.scope === 'global') {
    throw new AppError(403, 'Only admins can create global schedules')
  }

  const targetProfileIds =
    normalized.scope === 'group' ? normalized.groupProfileIds : normalized.profileId ? [normalized.profileId] : []

  if (!targetProfileIds.length) throw new AppError(400, 'Schedule target card is required')

  const profiles = await prisma.profile.findMany({
    where: { id: { in: targetProfileIds } },
    select: { id: true, userId: true, companyUserId: true },
  })

  if (profiles.length !== targetProfileIds.length) {
    throw new AppError(404, 'One or more schedule target cards were not found')
  }

  for (const profile of profiles) {
    const ownsDirect = profile.userId === userId
    const ownsCorporate = profile.companyUserId === userId
    if (apiRole === 'vcard-owner' && !ownsDirect) {
      throw new AppError(403, 'You can only schedule meetings for your own cards')
    }
    if (apiRole === 'corporate-owner' && !ownsDirect && !ownsCorporate) {
      throw new AppError(403, 'You can only schedule meetings for cards on your corporate account')
    }
  }
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
    scope: row.scope as MeetingScope,
    profileId: row.profileId,
    groupProfileIds: parseGroupProfileIds(row.groupProfileIds),
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

function meetLabelForEvent(_eventId: string | null | undefined): string {
  return calendarIntegrationService.meetLabel(calendarIntegrationService.resolveProvider())
}

function calendarDescription(input: {
  notes?: string | null
  host: string
  type: string
  meetLink?: string | null
  meetLabel?: string
}) {
  const label = input.meetLabel || 'Meeting'
  const parts = [
    `vBiz Me admin schedule: ${input.type}`,
    `Host / card owner: ${input.host}`,
    input.notes?.trim() || null,
    input.meetLink ? `${label}: ${input.meetLink}` : null,
  ].filter(Boolean)
  return parts.join('\n\n')
}

function meetingEmailHtml(input: {
  recipientName: string
  type: string
  host: string
  date: string
  time: string
  notes?: string | null
  meetLink?: string | null
  meetLabel?: string
  isAdminCopy?: boolean
}) {
  const label = input.meetLabel || 'Meeting'
  const meetBlock = input.meetLink
    ? `<p style="margin:16px 0"><a href="${escapeHtml(input.meetLink)}" style="display:inline-block;padding:12px 20px;background:#0f766e;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Join ${escapeHtml(label)}</a></p><p style="font-size:13px;color:#64748b">${escapeHtml(label)} link: ${escapeHtml(input.meetLink)}</p>`
    : ''

  const intro = input.isAdminCopy
    ? `A new session has been booked on the vBiz Me schedule calendar.`
    : `You have an upcoming session scheduled with the vBiz Me team.`

  return [
    '<div style="margin:0 auto;max-width:640px;font-family:Arial,sans-serif;color:#172033;line-height:1.6">',
    `<p>Hello ${escapeHtml(input.recipientName)},</p>`,
    `<p>${intro}</p>`,
    '<div style="margin:20px 0;padding:16px 20px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc">',
    `<p style="margin:0 0 8px"><strong>${escapeHtml(input.type)}</strong></p>`,
    `<p style="margin:0 0 4px">With: ${escapeHtml(input.host)}</p>`,
    `<p style="margin:0 0 4px">Date: ${escapeHtml(input.date)}</p>`,
    `<p style="margin:0">Time: ${escapeHtml(input.time)}</p>`,
    input.notes?.trim() ? `<p style="margin:12px 0 0;white-space:pre-wrap">${escapeHtml(input.notes.trim())}</p>` : '',
    '</div>',
    meetBlock,
    '<p style="margin-top:24px">Regards,<br><strong>vBiz.me Team</strong></p>',
    '</div>',
  ].join('')
}

async function sendMeetingEmails(input: {
  meeting: MeetingRow
  ownerEmails: string[]
  ownerDisplayName: string | null
  actor: Actor
  meetLabel: string
}) {
  if (!config.MAIL_ADDRESS || !config.MAIL_PASS) return

  const subject = `Upcoming session: ${input.meeting.type} on ${input.meeting.date}`
  const adminSubject = `Scheduled: ${input.meeting.type} with ${input.meeting.host}`

  for (const email of input.ownerEmails) {
    void authUtils
      .sendEmail({
        receiverMail: email,
        subject,
        html: meetingEmailHtml({
          recipientName: input.ownerDisplayName || 'vCard owner',
          type: input.meeting.type,
          host: input.meeting.host,
          date: input.meeting.date,
          time: input.meeting.time,
          notes: input.meeting.notes,
          meetLink: input.meeting.meetLink,
          meetLabel: input.meetLabel,
        }),
      })
      .catch((error) => logger.error('Meeting owner email failed', { error, email }))
  }

  const adminEmail = input.actor.email?.trim()
  if (adminEmail) {
    void authUtils
      .sendEmail({
        receiverMail: adminEmail,
        subject: adminSubject,
        html: meetingEmailHtml({
          recipientName: input.actor.name?.trim() || 'Admin',
          type: input.meeting.type,
          host: input.meeting.host,
          date: input.meeting.date,
          time: input.meeting.time,
          notes: input.meeting.notes,
          meetLink: input.meeting.meetLink,
          meetLabel: input.meetLabel,
          isAdminCopy: true,
        }),
      })
      .catch((error) => logger.error('Meeting admin email failed', { error, adminEmail }))
  }
}

function notifyOwnerPush(meeting: MeetingRow, _meetLabel: string) {
  const meetSuffix = meeting.meetLink ? ` Join link included.` : ''
  const payload = {
    title: `Upcoming session: ${meeting.type}`,
    body: `${meeting.type} on ${meeting.date} at ${meeting.time}.${meetSuffix}`,
    type: 'event_updates' as const,
    url: meeting.meetLink || undefined,
  }

  if (meeting.scope === 'global') {
    return
  }

  if (meeting.scope === 'group') {
    for (const profileId of parseGroupProfileIds(meeting.groupProfileIds)) {
      pushService.notifyProfileUpdate(profileId, payload)
    }
    return
  }

  if (!meeting.profileId) return
  pushService.notifyProfileUpdate(meeting.profileId, payload)
}

async function resolveOwnerEmailsForMeeting(meeting: MeetingRow): Promise<{
  emails: string[]
  displayName: string | null
}> {
  if (meeting.scope === 'global') return { emails: [], displayName: null }

  if (meeting.scope === 'group') {
    const ids = parseGroupProfileIds(meeting.groupProfileIds)
    const emailSets = await Promise.all(ids.map((profileId) => resolveOwnerEmails(profileId)))
    const emails = [...new Set(emailSets.flatMap((entry) => entry.emails))]
    return { emails, displayName: emailSets[0]?.displayName ?? null }
  }

  return resolveOwnerEmails(meeting.profileId)
}

async function notifyOwnerAnnouncement(actor: Actor, meeting: MeetingRow, ownerEmails: string[], meetLabel: string) {
  if (!ownerEmails.length) return
  if (meeting.scope === 'global') return

  const meetLine = meeting.meetLink ? `\n\n${meetLabel}: ${meeting.meetLink}` : ''
  const notesLine = meeting.notes?.trim() ? `\n\n${meeting.notes.trim()}` : ''
  const scopeLine = meeting.scope === 'group' ? '\n\nThis is a group session for your team cards.' : ''

  try {
    await announcementService.create(actor, {
      type: 'info',
      kind: 'announcement',
      title: `Upcoming session: ${meeting.type}`,
      body: `You have a ${meeting.type} with admin on ${meeting.date} at ${meeting.time}.${scopeLine}${notesLine}${meetLine}`,
      status: 'active',
      targetType: 'specific',
      targetEmails: ownerEmails,
      meta: {
        profileId: meeting.profileId || parseGroupProfileIds(meeting.groupProfileIds)[0] || '',
        meetingId: meeting.id,
        meetLink: meeting.meetLink || '',
        sendPush: '1',
        category: 'event',
        meetingScope: meeting.scope,
      },
    })
  } catch (error) {
    logger.error('Failed to create meeting announcement for owner', error)
  }
}

async function notifyMeetingCreated(actor: Actor, meeting: MeetingRow, meetLabel: string) {
  const { emails: ownerEmails, displayName: ownerDisplayName } = await resolveOwnerEmailsForMeeting(meeting)
  await notifyOwnerAnnouncement(actor, meeting, ownerEmails, meetLabel)
  notifyOwnerPush(meeting, meetLabel)
  if (ownerEmails.length) {
    void sendMeetingEmails({ meeting, ownerEmails, ownerDisplayName, actor, meetLabel })
  }
}

const list = async (query: ListMeetingsQuery) => {
  const skip = query.skip
  const limit = query.limit

  const where: Prisma.MeetingWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.scope ? { scope: query.scope } : {}),
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

async function resolveOwnerProfileIds(userId: string, profileId?: string): Promise<string[]> {
  const profiles = await prisma.profile.findMany({
    where: {
      OR: [{ userId }, { companyUserId: userId }],
      ...(profileId ? { id: profileId } : {}),
    },
    select: { id: true },
  })
  return profiles.map((profile) => profile.id)
}

async function fetchMeetingsVisibleToOwner(profileIds: string[]) {
  const [globalRows, directRows, groupRows] = await Promise.all([
    prisma.meeting.findMany({ where: { scope: 'global' }, orderBy: { startsAt: 'asc' } }),
    profileIds.length
      ? prisma.meeting.findMany({
          where: { scope: 'one_to_one', profileId: { in: profileIds } },
          orderBy: { startsAt: 'asc' },
        })
      : Promise.resolve([]),
    prisma.meeting.findMany({ where: { scope: 'group' }, orderBy: { startsAt: 'asc' } }),
  ])

  const groupMatches = groupRows.filter((row) => {
    const ids = parseGroupProfileIds(row.groupProfileIds)
    return ids.some((id) => profileIds.includes(id))
  })

  return [...globalRows, ...directRows, ...groupMatches]
    .map(serializeMeeting)
    .filter((item, index, all) => all.findIndex((entry) => entry.id === item.id) === index)
    .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))
}

const listOwnerMeetings = async (userId: string, query: ListOwnerMeetingsQuery) => {
  const profileIds = await resolveOwnerProfileIds(userId, query.profileId)
  if (query.profileId && !profileIds.length) {
    return { items: [], total: 0, skip: query.skip, limit: query.limit }
  }

  let items = await fetchMeetingsVisibleToOwner(profileIds)

  if (query.status) {
    items = items.filter((item) => item.status === query.status)
  }

  if (query.upcomingOnly) {
    const now = new Date()
    items = items.filter((item) => item.status === 'Scheduled' && new Date(item.startsAt) >= now)
  }

  if (query.from || query.to) {
    const fromAt = query.from ? computeStartsAt(query.from, '12:00 AM') : null
    const toAt = query.to ? computeStartsAt(query.to, '11:59 PM') : null
    items = items.filter((item) => {
      const startsAt = new Date(item.startsAt)
      if (fromAt && startsAt < fromAt) return false
      if (toAt && startsAt > toAt) return false
      return true
    })
  }

  const total = items.length
  const skip = query.skip
  const limit = query.limit
  return {
    items: items.slice(skip, skip + limit),
    total,
    skip,
    limit,
  }
}

const listOwnerUpcoming = async (userId: string, options: { limit?: number; profileId?: string } = {}) => {
  const data = await listOwnerMeetings(userId, {
    limit: options.limit ?? 10,
    skip: 0,
    profileId: options.profileId,
    status: 'Scheduled',
    upcomingOnly: true,
  })
  return {
    items: data.items,
    total: data.total,
  }
}

const getOne = async (id: string) => {
  const row = await prisma.meeting.findUnique({ where: { id } })
  if (!row) throw new AppError(404, 'Meeting not found')
  return serializeMeeting(row)
}

const create = async (actor: Actor, input: CreateMeetingInput, actorRole?: string | null) => {
  const normalized = await normalizeCreateInput(input)
  await assertOwnerCanCreateMeeting(actor.id, actorRole, input, normalized)

  if (isStaffRole(actorRole)) {
    if (normalized.profileId) {
      await assertAdminCanContactProfile(actor.id, normalized.profileId)
    }
    if (normalized.scope === 'group') {
      for (const profileId of normalized.groupProfileIds) {
        await assertAdminCanContactProfile(actor.id, profileId)
      }
    }
  }

  const status = input.status ?? 'Scheduled'
  const startsAt = computeStartsAt(input.date, input.time)
  const primaryProfileId = normalized.profileId
  const { emails: ownerEmails } = await resolveOwnerEmails(primaryProfileId)
  const meetLabel = meetLabelForEvent(null)

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
      scope: normalized.scope,
      profileId: primaryProfileId,
      groupProfileIds: normalized.groupProfileIds.length ? normalized.groupProfileIds : undefined,
      createdById: actor.id,
    },
  })

  if (status === 'Scheduled') {
    const calendar = await calendarIntegrationService.createMeetingEvent({
      summary: calendarSummary(input.type, input.host),
      description: calendarDescription({
        notes: input.notes,
        host: input.host,
        type: input.type,
        meetLabel,
      }),
      date: input.date,
      time: input.time,
      attendeeEmail: ownerEmails[0] || null,
    })

    if (calendar) {
      const resolvedMeetLabel = calendarIntegrationService.meetLabel(calendar.provider)
      row = await prisma.meeting.update({
        where: { id: row.id },
        data: {
          googleEventId: calendar.eventId,
          meetLink: calendar.meetLink,
          ...(row.location ? {} : calendar.meetLink ? { location: calendar.meetLink } : {}),
        },
      })
      await notifyMeetingCreated(actor, row, resolvedMeetLabel)
    } else {
      await notifyMeetingCreated(actor, row, meetLabel)
    }
  }

  const actorLabel = actor.name?.trim() || actor.email || 'Admin'
  await writeAuditLog({
    action: 'Meeting Scheduled',
    details: `${input.type} with ${input.host} on ${input.date} at ${input.time}`,
    type: 'schedule',
    actor: actorLabel,
    actorId: actor.id,
    profileId: primaryProfileId,
    meta: {
      meetingId: row.id,
      meetingType: input.type,
      meetingScope: normalized.scope,
      status,
      calendarEventId: row.googleEventId || '',
      meetLink: row.meetLink || '',
      calendarProvider: calendarIntegrationService.resolveProvider(),
      groupProfileIds: normalized.groupProfileIds.join(','),
    },
  })

  return serializeMeeting(row)
}

const update = async (id: string, actor: Actor, input: UpdateMeetingInput) => {
  const existing = await prisma.meeting.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Meeting not found')

  if (input.profileId) {
    await assertAdminCanContactProfile(actor.id, input.profileId)
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

  const meetLabel = meetLabelForEvent(existing.googleEventId)

  if (existing.googleEventId) {
    if (input.status === 'Cancelled' || input.status === 'Completed') {
      await calendarIntegrationService.deleteMeetingEvent(existing.googleEventId)
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
      const updatedCal = await calendarIntegrationService.updateMeetingEvent(existing.googleEventId, {
        summary: calendarSummary(row.type, row.host),
        description: calendarDescription({
          notes: row.notes,
          host: row.host,
          type: row.type,
          meetLink: row.meetLink,
          meetLabel,
        }),
        date: row.date,
        time: row.time,
      })
      if (updatedCal?.meetLink && updatedCal.meetLink !== row.meetLink) {
        row = await prisma.meeting.update({
          where: { id },
          data: {
            meetLink: updatedCal.meetLink,
            ...(updatedCal.eventId ? { googleEventId: updatedCal.eventId } : {}),
          },
        })
      } else if (updatedCal?.eventId && updatedCal.eventId !== existing.googleEventId) {
        row = await prisma.meeting.update({
          where: { id },
          data: { googleEventId: updatedCal.eventId },
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
    await calendarIntegrationService.deleteMeetingEvent(existing.googleEventId)
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
  listOwnerMeetings,
  listOwnerUpcoming,
  getOne,
  create,
  update,
  remove,
}

export default meetingService
