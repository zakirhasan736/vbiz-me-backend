import config from '../configs/config'
import { buildFrontendPublicCardPath } from '../constants/frontendPublicCardPath'
import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import authUtils from '../utils/auth.utils'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import type {
  CancelMeetingInput,
  CompleteMeetingInput,
  CreatePublicRequestInput,
  ListOpenRequestsQuery,
  RescheduleMeetingInput,
  ScheduleMeetingInput,
} from '../zodValidation/oneOnOne.zod'
import calendarIntegrationService from './calendarIntegration.service'
import pushService from './push.service'

type Actor = { id: string; email: string; name?: string | null; role?: string | null }

/** Production must run `prisma generate` after schema changes or delegates are undefined. */
function assertOneOnOneClientReady() {
  const client = prisma as unknown as {
    oneOnOneRequest?: { findFirst: unknown }
    oneOnOneMeeting?: { findFirst: unknown }
  }
  if (!client.oneOnOneRequest || !client.oneOnOneMeeting) {
    throw new AppError(
      503,
      '1-on-1 is not ready on this server. Run `npx prisma generate` and `npx prisma migrate deploy`, then restart the API.'
    )
  }
}

type RequestRow = {
  id: string
  profileId: string
  guestName: string
  guestEmail: string
  guestPhone: string | null
  message: string | null
  status: string
  cardOwnerUserId: string | null
  corporateId: string | null
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

type MeetingRow = {
  id: string
  requestId: string
  cardId: string
  cardOwnerUserId: string
  corporateId: string | null
  zohoCalendarEventId: string | null
  zohoMeetingId: string | null
  zohoMeetingUrl: string | null
  title: string
  description: string | null
  startAt: Date
  endAt: Date
  timezone: string
  status: string
  createdByUserId: string
  createdAt: Date
  updatedAt: Date
  cancelledAt: Date | null
  completedAt: Date | null
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function formatDisplayDate(date: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function formatDisplayTime(date: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  } catch {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
}

function serializeRequest(row: RequestRow, meeting: MeetingRow | null = null) {
  return {
    id: row.id,
    profileId: row.profileId,
    guestName: row.guestName,
    guestEmail: row.guestEmail,
    guestPhone: row.guestPhone,
    message: row.message,
    status: row.status,
    cardOwnerUserId: row.cardOwnerUserId,
    corporateId: row.corporateId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    meeting: meeting
      ? {
          id: meeting.id,
          title: meeting.title,
          description: meeting.description,
          startAt: meeting.startAt.toISOString(),
          endAt: meeting.endAt.toISOString(),
          timezone: meeting.timezone,
          status: meeting.status,
          zohoCalendarEventId: meeting.zohoCalendarEventId,
          zohoMeetingId: meeting.zohoMeetingId,
          zohoMeetingUrl: meeting.zohoMeetingUrl,
        }
      : null,
  }
}

function serializeMeeting(row: MeetingRow) {
  return {
    id: row.id,
    requestId: row.requestId,
    cardId: row.cardId,
    cardOwnerUserId: row.cardOwnerUserId,
    corporateId: row.corporateId,
    title: row.title,
    description: row.description,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    timezone: row.timezone,
    status: row.status,
    zohoCalendarEventId: row.zohoCalendarEventId,
    zohoMeetingId: row.zohoMeetingId,
    zohoMeetingUrl: row.zohoMeetingUrl,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function signGuestToken(requestId: string) {
  const secret = config.ACCESS_TOKEN.SECRET || 'one-on-one-secret'
  return Buffer.from(`${requestId}|${secret.slice(0, 16)}`).toString('base64url')
}

function verifyGuestToken(token: string): string | null {
  const secret = config.ACCESS_TOKEN.SECRET || 'one-on-one-secret'
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const [requestId, salt] = decoded.split('|')
    if (!requestId || salt !== secret.slice(0, 16)) return null
    return requestId
  } catch {
    return null
  }
}

async function resolveCardOwnerUser(profileId: string) {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      userId: true,
      companyUserId: true,
      name: true,
      slug: true,
    },
  })
  if (!profile) throw new AppError(404, 'Card not found')
  return profile
}

async function assertOwnerCanSchedule(actor: Actor, request: RequestRow) {
  if (isStaffRole(actor.role)) return

  if (actor.role !== 'vcard-owner' && actor.role !== 'corporate-owner') {
    throw new AppError(403, 'Only card owners or corporate admins can schedule 1-on-1 meetings')
  }

  const profile = await prisma.profile.findUnique({
    where: { id: request.profileId },
    select: { userId: true, companyUserId: true },
  })
  if (!profile) throw new AppError(404, 'Card not found')

  if (actor.role === 'vcard-owner' && profile.userId !== actor.id) {
    throw new AppError(403, 'You can only schedule meetings for your own cards')
  }
  if (actor.role === 'corporate-owner') {
    if (profile.companyUserId !== actor.id && profile.userId !== actor.id) {
      throw new AppError(403, 'You can only schedule meetings for cards on your corporate account')
    }
  }
}

async function assertCanListOwnerRequests(actor: Actor) {
  if (isStaffRole(actor.role)) return

  if (actor.role !== 'vcard-owner' && actor.role !== 'corporate-owner') {
    throw new AppError(403, 'Only card owners or corporate admins can view 1-on-1 requests')
  }

  const profilesOwned = await prisma.profile.findMany({
    where: {
      OR: [{ userId: actor.id }, { companyUserId: actor.id }],
    },
    select: { id: true },
  })
  if (!profilesOwned.length) throw new AppError(403, 'No cards owned by this account')
}

async function findGuestPushProfile(guestEmail: string) {
  const email = normalizeEmail(guestEmail)
  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  })
  if (!user) return null
  const profiles = await prisma.profile.findMany({
    where: { OR: [{ userId: user.id }, { companyUserId: user.id }] },
    select: { id: true },
  })
  if (!profiles.length) return null
  for (const profile of profiles) {
    const sub = await prisma.pushSubscription.findFirst({
      where: { profileId: profile.id, isActive: true },
      select: { id: true },
    })
    if (sub) return profile.id
  }
  return profiles[0].id
}

async function pushGuestMeetingNotification(opts: {
  guestProfileId: string | null
  guestEmail: string
  ownerName: string
  eventType: 'scheduled' | 'rescheduled' | 'cancelled'
  dateLabel: string
  timeLabel: string
  meetingUrl: string | null
}) {
  if (!opts.guestProfileId) return { sent: false as const, reason: 'no_push_subscription' }
  const bodyBase =
    opts.eventType === 'scheduled'
      ? `Your meeting is scheduled for ${opts.dateLabel} at ${opts.timeLabel}. Check your email/calendar invitation for the meeting details and join link.`
      : opts.eventType === 'rescheduled'
        ? `${opts.ownerName} rescheduled your meeting to ${opts.dateLabel} at ${opts.timeLabel}. Check your calendar invitation for the updated details.`
        : `${opts.ownerName} cancelled the meeting scheduled for ${opts.dateLabel} at ${opts.timeLabel}.`

  const payload = {
    title:
      opts.eventType === 'scheduled'
        ? `${opts.ownerName} scheduled your 1-on-1`
        : opts.eventType === 'rescheduled'
          ? 'Your 1-on-1 was rescheduled'
          : 'Your 1-on-1 was cancelled',
    body: bodyBase,
    type: 'event_updates' as const,
    url: opts.meetingUrl || undefined,
  }
  pushService.notifyProfileUpdate(opts.guestProfileId, payload)
  return { sent: true as const, reason: 'ok' }
}

async function createOrUpdateZohoEvent(opts: {
  title: string
  description: string
  date: string
  time: string
  durationMinutes: number
  attendeeEmail: string
}) {
  const result = await calendarIntegrationService.createMeetingEvent({
    summary: opts.title,
    description: opts.description,
    date: opts.date,
    time: opts.time,
    durationMinutes: opts.durationMinutes,
    attendeeEmail: opts.attendeeEmail,
  })

  if (!result) {
    throw new AppError(
      502,
      "We couldn't create this meeting in Zoho Calendar. Your 1-on-1 request is still saved. Reconnect your calendar or try again."
    )
  }

  return result
}

const createPublicRequest = async (input: CreatePublicRequestInput) => {
  assertOneOnOneClientReady()
  const profile = await resolveCardOwnerUser(input.profileId)
  const guestName = input.guestName.trim()
  const guestEmail = normalizeEmail(input.guestEmail)

  const existingOpen = await prisma.oneOnOneRequest.findFirst({
    where: {
      profileId: profile.id,
      guestEmail,
      status: 'open',
    },
  })
  if (existingOpen) return serializeRequest(existingOpen)

  const row = await prisma.oneOnOneRequest.create({
    data: {
      profileId: profile.id,
      guestName,
      guestEmail,
      guestPhone: input.guestPhone || null,
      message: input.message || null,
      status: 'open',
      cardOwnerUserId: profile.userId || null,
      corporateId: profile.companyUserId || null,
    },
  })

  if (profile.userId) {
    const owner = await prisma.user.findUnique({
      where: { id: profile.userId },
      select: { id: true, name: true, email: true },
    })
    const ownerName = owner?.name || 'vCard owner'
    if (owner?.email) {
      void authUtils
        .sendEmail({
          receiverMail: owner.email,
          subject: `New 1-on-1 request from ${guestName}`,
          html: `<div style="font-family:sans-serif;line-height:1.5"><p>Hello ${ownerName},</p><p>${guestName} requested a 1-on-1 meeting.</p><p>Email: ${guestEmail}</p></div>`,
        })
        .catch((err) => logger.error('1-on-1 request email failed', err))
    }
    pushService.notifyProfileUpdate(profile.id, {
      title: 'New 1-on-1 request',
      body: `${guestName} requested a 1-on-1 meeting.`,
      type: 'event_updates',
      url: profile.slug ? buildFrontendPublicCardPath(profile.slug) : undefined,
    })
  }

  return serializeRequest(row)
}

const listOpenRequests = async (actor: Actor, query: ListOpenRequestsQuery) => {
  assertOneOnOneClientReady()
  await assertCanListOwnerRequests(actor)

  const isStaff = isStaffRole(actor.role)
  let profileIds: string[] = []
  if (!isStaff) {
    const profilesOwned = await prisma.profile.findMany({
      where: {
        OR: [{ userId: actor.id }, { companyUserId: actor.id }],
      },
      select: { id: true },
    })
    profileIds = profilesOwned.map((p) => p.id)
  }

  const rows = await prisma.oneOnOneRequest.findMany({
    where: {
      status: query.status ?? 'open',
      ...(isStaff ? {} : { profileId: { in: profileIds } }),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
    skip: query.skip,
  })

  const meetings = await prisma.oneOnOneMeeting.findMany({
    where: { requestId: { in: rows.map((r) => r.id) } },
  })
  const meetingByRequest = Object.fromEntries(meetings.map((m) => [m.requestId, m]))

  return {
    items: rows.map((row) => serializeRequest(row, meetingByRequest[row.id] ?? null)),
    total: rows.length,
    skip: query.skip,
    limit: query.limit,
  }
}

const scheduleMeetingFromRequest = async (actor: Actor, input: ScheduleMeetingInput) => {
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: input.requestId } })
  if (!request) throw new AppError(404, '1-on-1 request not found')
  if (request.status !== 'open') throw new AppError(400, 'Only open 1-on-1 requests can be scheduled')

  await assertOwnerCanSchedule(actor, request)

  const profile = await resolveCardOwnerUser(request.profileId)
  const ownerName =
    (await prisma.user.findUnique({ where: { id: profile.userId || actor.id }, select: { name: true } }))?.name ||
    actor.name ||
    'vCard owner'
  const startsAt = new Date(`${input.date}T${input.startTime}:00`)
  const durationMinutes = input.durationMinutes ?? 30
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000)
  const timezone = input.timezone || 'UTC'

  const calendar = await createOrUpdateZohoEvent({
    title: input.title || `1-on-1 with ${request.guestName}`,
    description: input.description || request.message || `1-on-1 with ${request.guestName}`,
    date: input.date,
    time: input.startTime,
    durationMinutes,
    attendeeEmail: request.guestEmail,
  })

  const meeting = await prisma.oneOnOneMeeting.create({
    data: {
      requestId: request.id,
      cardId: profile.id,
      cardOwnerUserId: profile.userId || actor.id,
      corporateId: profile.companyUserId || request.corporateId || null,
      zohoCalendarEventId: calendar.eventId,
      zohoMeetingId: calendar.eventId,
      zohoMeetingUrl: calendar.meetLink,
      title: input.title || `1-on-1 with ${request.guestName}`,
      description: input.description || request.message || null,
      startAt: startsAt,
      endAt: endsAt,
      timezone,
      status: 'scheduled',
      createdByUserId: actor.id,
    },
  })

  await prisma.oneOnOneRequest.update({
    where: { id: request.id },
    data: { status: 'scheduled', cardOwnerUserId: profile.userId || request.cardOwnerUserId },
  })

  const guestProfileId = await findGuestPushProfile(request.guestEmail)
  await pushGuestMeetingNotification({
    guestProfileId,
    guestEmail: request.guestEmail,
    ownerName,
    eventType: 'scheduled',
    dateLabel: formatDisplayDate(startsAt, timezone),
    timeLabel: formatDisplayTime(startsAt, timezone),
    meetingUrl: calendar.meetLink,
  })

  if (profile.userId) {
    pushService.notifyProfileUpdate(profile.userId, {
      title: `1-on-1 scheduled with ${request.guestName}`,
      body: `Your meeting is scheduled for ${formatDisplayDate(startsAt, timezone)} at ${formatDisplayTime(startsAt, timezone)}.`,
      type: 'event_updates',
      url: buildFrontendPublicCardPath(profile.slug || profile.id),
    })
  }

  return {
    request: serializeRequest({
      ...request,
      status: 'scheduled',
      cardOwnerUserId: profile.userId || request.cardOwnerUserId,
    }),
    meeting: serializeMeeting(meeting),
  }
}

const rescheduleMeetingFromRequest = async (actor: Actor, input: RescheduleMeetingInput) => {
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: input.requestId } })
  if (!request) throw new AppError(404, '1-on-1 request not found')
  if (request.status !== 'scheduled' && request.status !== 'open') {
    throw new AppError(400, 'Only scheduled 1-on-1 requests can be rescheduled')
  }

  await assertOwnerCanSchedule(actor, request)

  const meeting = await prisma.oneOnOneMeeting.findUnique({ where: { requestId: request.id } })
  if (!meeting) throw new AppError(404, 'No scheduled meeting for this request')
  if (meeting.status === 'cancelled') throw new AppError(400, 'Cancelled meetings cannot be rescheduled')

  const startsAt = new Date(`${input.date}T${input.startTime}:00`)
  const durationMinutes = input.durationMinutes ?? 30
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000)
  const timezone = input.timezone || meeting.timezone

  const calendar = await createOrUpdateZohoEvent({
    title: input.title || meeting.title,
    description: input.description || meeting.description || '',
    date: input.date,
    time: input.startTime,
    durationMinutes,
    attendeeEmail: request.guestEmail,
  })

  const nextMeeting = await prisma.oneOnOneMeeting.update({
    where: { id: meeting.id },
    data: {
      zohoCalendarEventId: calendar.eventId,
      zohoMeetingId: calendar.eventId,
      zohoMeetingUrl: calendar.meetLink,
      title: input.title || meeting.title,
      description: input.description || meeting.description,
      startAt: startsAt,
      endAt: endsAt,
      timezone,
      status: 'rescheduled',
      cancelledAt: null,
    },
  })

  await prisma.oneOnOneRequest.update({
    where: { id: request.id },
    data: { status: 'scheduled' },
  })

  const ownerName =
    (await prisma.user.findUnique({ where: { id: meeting.cardOwnerUserId }, select: { name: true } }))?.name ||
    actor.name ||
    'vCard owner'
  const guestProfileId = await findGuestPushProfile(request.guestEmail)
  await pushGuestMeetingNotification({
    guestProfileId,
    guestEmail: request.guestEmail,
    ownerName,
    eventType: 'rescheduled',
    dateLabel: formatDisplayDate(startsAt, timezone),
    timeLabel: formatDisplayTime(startsAt, timezone),
    meetingUrl: calendar.meetLink,
  })

  return {
    request: serializeRequest({
      ...request,
      status: 'scheduled',
    }),
    meeting: serializeMeeting(nextMeeting),
  }
}

const cancelMeetingFromRequest = async (actor: Actor, input: CancelMeetingInput) => {
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: input.requestId } })
  if (!request) throw new AppError(404, '1-on-1 request not found')

  await assertOwnerCanSchedule(actor, request)

  const meeting = await prisma.oneOnOneMeeting.findUnique({ where: { requestId: request.id } })
  if (meeting && meeting.status !== 'cancelled') {
    if (meeting.zohoCalendarEventId) {
      await calendarIntegrationService.deleteMeetingEvent(meeting.zohoCalendarEventId)
    }
    const cancelled = await prisma.oneOnOneMeeting.update({
      where: { id: meeting.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
      },
    })
    await prisma.oneOnOneRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled' },
    })
    const ownerName =
      (await prisma.user.findUnique({ where: { id: meeting.cardOwnerUserId }, select: { name: true } }))?.name ||
      actor.name ||
      'vCard owner'
    const guestProfileId = await findGuestPushProfile(request.guestEmail)
    await pushGuestMeetingNotification({
      guestProfileId,
      guestEmail: request.guestEmail,
      ownerName,
      eventType: 'cancelled',
      dateLabel: formatDisplayDate(cancelled.startAt, cancelled.timezone),
      timeLabel: formatDisplayTime(cancelled.startAt, cancelled.timezone),
      meetingUrl: null,
    })
    return serializeMeeting(cancelled)
  }

  await prisma.oneOnOneRequest.update({
    where: { id: request.id },
    data: { status: 'cancelled' },
  })
  return { id: request.id, status: 'cancelled' }
}

const completeMeetingFromRequest = async (actor: Actor, input: CompleteMeetingInput) => {
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: input.requestId } })
  if (!request) throw new AppError(404, '1-on-1 request not found')
  await assertOwnerCanSchedule(actor, request)

  const meeting = await prisma.oneOnOneMeeting.findUnique({ where: { requestId: request.id } })
  if (!meeting) throw new AppError(404, 'No scheduled meeting for this request')

  const completed = await prisma.oneOnOneMeeting.update({
    where: { id: meeting.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
    },
  })
  await prisma.oneOnOneRequest.update({
    where: { id: request.id },
    data: { status: 'completed' },
  })
  return serializeMeeting(completed)
}

const getMeetingForGuest = async (requestId: string) => {
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError(404, 'Meeting not found')
  const meeting = await prisma.oneOnOneMeeting.findUnique({ where: { requestId } })
  if (!meeting) throw new AppError(404, 'Meeting not found')
  if (meeting.status === 'cancelled') throw new AppError(410, 'Meeting was cancelled')
  return {
    title: meeting.title,
    guestName: request.guestName,
    date: formatDisplayDate(meeting.startAt, meeting.timezone),
    startTime: formatDisplayTime(meeting.startAt, meeting.timezone),
    endTime: formatDisplayTime(meeting.endAt, meeting.timezone),
    timezone: meeting.timezone,
    description: meeting.description,
    joinUrl: meeting.zohoMeetingUrl,
    status: meeting.status,
  }
}

const listOwnerMeetings = async (actor: Actor) => {
  const profilesOwned = await prisma.profile.findMany({
    where: {
      OR: [{ userId: actor.id }, { companyUserId: actor.id }],
    },
    select: { id: true },
  })
  const profileIds = profilesOwned.map((p) => p.id)
  const meetings = await prisma.oneOnOneMeeting.findMany({
    where: {
      cardOwnerUserId: { in: [actor.id] },
      OR: [{ cardId: { in: profileIds } }],
      status: { in: ['scheduled', 'rescheduled', 'completed'] },
    },
    orderBy: { startAt: 'desc' },
    take: 50,
  })
  const requestMap = await prisma.oneOnOneRequest.findMany({
    where: { id: { in: meetings.map((m) => m.requestId) } },
  })
  const requestById = Object.fromEntries(requestMap.map((r) => [r.id, r]))
  return {
    items: meetings
      .map((m) => {
        const request = requestById[m.requestId]
        return {
          ...serializeMeeting(m),
          guestName: request?.guestName,
          guestEmail: request?.guestEmail,
          requestStatus: request?.status,
        }
      })
      .filter((m) => Boolean(m.guestName)),
  }
}

const oneOnOneService = {
  createPublicRequest,
  listOpenRequests,
  scheduleMeetingFromRequest,
  rescheduleMeetingFromRequest,
  cancelMeetingFromRequest,
  completeMeetingFromRequest,
  getMeetingForGuest,
  listOwnerMeetings,
  signGuestToken,
  verifyGuestToken,
}

export default oneOnOneService
