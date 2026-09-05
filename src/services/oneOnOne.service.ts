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
  ConfirmGuestSlotInput,
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
  proposedTitle?: string | null
  proposedDescription?: string | null
  proposedTimezone?: string | null
  proposedDurationMinutes?: number | null
  createdAt: Date
  updatedAt: Date
}

type SlotRow = {
  id: string
  requestId: string
  date: string
  startTime: string
  durationMinutes: number
  timezone: string
  status: string
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

function normalizeTimeToHHmm(time: string): string {
  const t = time.trim()
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    const [h, m] = t.split(':')
    return `${h.padStart(2, '0')}:${m}`
  }
  const match = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return t
  let h = Number(match[1])
  const m = match[2]
  const ap = match[3].toUpperCase()
  if (ap === 'PM' && h < 12) h += 12
  if (ap === 'AM' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${m}`
}

function parseSlotDateTime(date: string, startTime: string) {
  const hhmm = normalizeTimeToHHmm(startTime)
  return new Date(`${date}T${hhmm}:00`)
}

function guestPickUrl(requestId: string) {
  const base = (config.FRONTEND_URL || '').replace(/\/$/, '')
  return `${base}/1-on-1/${encodeURIComponent(requestId)}`
}

function serializeSlot(slot: SlotRow) {
  return {
    id: slot.id,
    date: slot.date,
    startTime: slot.startTime,
    durationMinutes: slot.durationMinutes,
    timezone: slot.timezone,
    status: slot.status,
  }
}

function serializeRequest(row: RequestRow, meeting: MeetingRow | null = null, slots: SlotRow[] = []) {
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
    proposedTitle: row.proposedTitle ?? null,
    proposedDescription: row.proposedDescription ?? null,
    proposedTimezone: row.proposedTimezone ?? null,
    proposedDurationMinutes: row.proposedDurationMinutes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    slots: slots.map(serializeSlot),
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

function normalizeActorRole(role?: string | null): string | null {
  if (!role) return null
  if (role === 'VCARD_OWNER') return 'vcard-owner'
  if (role === 'CORPORATE_OWNER') return 'corporate-owner'
  if (role === 'ADMIN') return 'admin'
  if (role === 'SUPER_ADMIN') return 'super-admin'
  return role
}

async function assertOwnerCanSchedule(actor: Actor, request: RequestRow) {
  const role = normalizeActorRole(actor.role)
  if (isStaffRole(role)) return

  if (role !== 'vcard-owner' && role !== 'corporate-owner') {
    throw new AppError(403, 'Only card owners or corporate admins can schedule 1-on-1 meetings')
  }

  const profile = await prisma.profile.findUnique({
    where: { id: request.profileId },
    select: { userId: true, companyUserId: true },
  })
  if (!profile) throw new AppError(404, 'Card not found')

  if (role === 'vcard-owner' && profile.userId !== actor.id) {
    throw new AppError(403, 'You can only schedule meetings for your own cards')
  }
  if (role === 'corporate-owner') {
    if (profile.companyUserId !== actor.id && profile.userId !== actor.id) {
      throw new AppError(403, 'You can only schedule meetings for cards on your corporate account')
    }
  }
}

async function assertCanListOwnerRequests(actor: Actor) {
  const role = normalizeActorRole(actor.role)
  if (isStaffRole(role)) return

  if (role !== 'vcard-owner' && role !== 'corporate-owner') {
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

async function resolveCardStakeholderEmails(profileId: string): Promise<{
  emails: string[]
  ownerName: string
  cardName: string
  slug: string | null
  companyUserId: string | null
  userId: string | null
}> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      name: true,
      slug: true,
      email: true,
      userId: true,
      companyUserId: true,
      user: { select: { email: true, name: true } },
      companyUser: { select: { email: true, name: true } },
    },
  })
  if (!profile) throw new AppError(404, 'Card not found')

  const emails = [
    ...new Set(
      [profile.user?.email, profile.email, profile.companyUser?.email]
        .map((e) => e?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e))
    ),
  ]

  return {
    emails,
    ownerName: profile.user?.name?.trim() || profile.name?.trim() || 'vCard owner',
    cardName: profile.name?.trim() || 'your card',
    slug: profile.slug,
    companyUserId: profile.companyUserId,
    userId: profile.userId,
  }
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function oneOnOneEmailHtml(opts: {
  greetingName: string
  intro: string
  details: Array<{ label: string; value: string }>
  ctaLabel?: string
  ctaUrl?: string | null
  footer?: string
}) {
  const detailRows = opts.details
    .filter((d) => d.value.trim())
    .map(
      (d) =>
        `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:120px">${escapeHtml(d.label)}</td><td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600">${escapeHtml(d.value)}</td></tr>`
    )
    .join('')
  const cta =
    opts.ctaUrl && opts.ctaLabel
      ? `<p style="margin:20px 0 8px"><a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;padding:12px 18px;background:#0f766e;color:#fff;text-decoration:none;border-radius:10px;font-weight:700">${escapeHtml(opts.ctaLabel)}</a></p>`
      : ''
  return `<div style="margin:0 auto;max-width:640px;font-family:Arial,sans-serif;color:#172033;line-height:1.6">
    <p>Hello ${escapeHtml(opts.greetingName)},</p>
    <p>${opts.intro}</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">${detailRows}</table>
    ${cta}
    ${opts.footer ? `<p style="font-size:12px;color:#94a3b8">${escapeHtml(opts.footer)}</p>` : ''}
    <p style="font-size:12px;color:#94a3b8">— vBiz Me</p>
  </div>`
}

async function createStakeholderInboxNotice(opts: {
  emails: string[]
  title: string
  body: string
  profileId: string
  slug?: string | null
  requestId?: string
}) {
  const emails = [...new Set(opts.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
  if (!emails.length) return
  try {
    await prisma.announcement.create({
      data: {
        kind: 'announcement',
        type: 'info',
        title: opts.title,
        body: opts.body,
        status: 'active',
        targetType: 'specific',
        targetEmails: emails,
        meta: {
          channel: 'inbox',
          category: 'event',
          profileId: opts.profileId,
          ...(opts.slug ? { slug: opts.slug } : {}),
          ...(opts.requestId ? { oneOnOneRequestId: opts.requestId } : {}),
          sendPush: '0',
        },
        createdById: null,
      },
    })
  } catch (error) {
    logger.error('1-on-1 inbox notice failed', error)
  }
}

function notifyCardPush(
  profileId: string,
  payload: { title: string; body: string; url?: string },
  slug?: string | null
) {
  pushService.notifyProfileUpdate(profileId, {
    title: payload.title,
    body: payload.body,
    type: 'event_updates',
    url: payload.url || (slug ? buildFrontendPublicCardPath(slug) : undefined),
  })
}

async function sendEmailsSafe(emails: string[], subject: string, html: string, context: string) {
  for (const email of [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]) {
    void authUtils
      .sendEmail({ receiverMail: email, subject, html })
      .catch((err) => logger.error(`${context} email failed`, { err, email }))
  }
}

async function pushGuestMeetingNotification(opts: {
  guestProfileId: string | null
  guestEmail: string
  ownerName: string
  eventType: 'times_proposed' | 'scheduled' | 'rescheduled' | 'cancelled'
  dateLabel: string
  timeLabel: string
  meetingUrl: string | null
}) {
  if (!opts.guestProfileId) return { sent: false as const, reason: 'no_push_subscription' as const }

  const title =
    opts.eventType === 'times_proposed'
      ? `${opts.ownerName} proposed 1-on-1 times`
      : opts.eventType === 'scheduled'
        ? `Your 1-on-1 with ${opts.ownerName} is confirmed`
        : opts.eventType === 'rescheduled'
          ? 'Your 1-on-1 was rescheduled'
          : 'Your 1-on-1 was cancelled'

  const body =
    opts.eventType === 'times_proposed'
      ? `${opts.ownerName} shared ${opts.dateLabel}. Open the link to pick a time.`
      : opts.eventType === 'scheduled'
        ? `Confirmed for ${opts.dateLabel} at ${opts.timeLabel}. Check your email for the join link.`
        : opts.eventType === 'rescheduled'
          ? `${opts.ownerName} moved your meeting to ${opts.dateLabel} at ${opts.timeLabel}.`
          : `${opts.ownerName} cancelled the meeting for ${opts.dateLabel} at ${opts.timeLabel}.`

  pushService.notifyProfileUpdate(opts.guestProfileId, {
    title,
    body,
    type: 'event_updates',
    url: opts.meetingUrl || undefined,
  })
  return { sent: true as const, reason: 'ok' as const }
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
  const guestPhone = input.guestPhone?.trim() || null

  const existingActive = await prisma.oneOnOneRequest.findFirst({
    where: {
      profileId: profile.id,
      status: { in: ['open', 'awaiting_guest'] },
      OR: [{ guestEmail }, ...(guestPhone ? [{ guestPhone }] : [])],
    },
    orderBy: { createdAt: 'desc' },
  })
  if (existingActive) {
    const byEmail = existingActive.guestEmail === guestEmail
    throw new AppError(
      409,
      byEmail
        ? 'This email already requested a 1-on-1 for this card. Please wait for a response or use a different email.'
        : 'This phone number already has an open 1-on-1 request for this card. Please wait for a response or use different contact details.',
      {
        code: 'ONE_ON_ONE_ALREADY_REQUESTED',
        data: { requestId: existingActive.id, status: existingActive.status },
      }
    )
  }

  const row = await prisma.oneOnOneRequest.create({
    data: {
      profileId: profile.id,
      guestName,
      guestEmail,
      guestPhone,
      message: input.message || null,
      status: 'open',
      cardOwnerUserId: profile.userId || null,
      corporateId: profile.companyUserId || null,
    },
  })

  const stakeholders = await resolveCardStakeholderEmails(profile.id)
  const messageLine = input.message?.trim() || ''
  const emailHtml = oneOnOneEmailHtml({
    greetingName: stakeholders.ownerName,
    intro: `<strong>${escapeHtml(guestName)}</strong> requested a 1-on-1 on <strong>${escapeHtml(stakeholders.cardName)}</strong>.`,
    details: [
      { label: 'Guest', value: guestName },
      { label: 'Email', value: guestEmail },
      { label: 'Phone', value: guestPhone || '—' },
      { label: 'Message', value: messageLine || '—' },
    ],
    footer: stakeholders.companyUserId
      ? 'You are receiving this because you own or manage this card (including corporate).'
      : 'You are receiving this because you own this card.',
  })

  await sendEmailsSafe(stakeholders.emails, `New 1-on-1 request from ${guestName}`, emailHtml, '1-on-1 request owner')

  notifyCardPush(
    profile.id,
    {
      title: 'New 1-on-1 request',
      body: `${guestName} requested a 1-on-1 meeting.`,
    },
    stakeholders.slug
  )

  await createStakeholderInboxNotice({
    emails: stakeholders.emails,
    title: `New 1-on-1: ${guestName}`,
    body: `${guestName} (${guestEmail})${guestPhone ? ` · ${guestPhone}` : ''} requested a 1-on-1${messageLine ? `: ${messageLine}` : '.'}`,
    profileId: profile.id,
    slug: stakeholders.slug,
    requestId: row.id,
  })

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
      ...(query.status ? { status: query.status } : { status: { in: ['open', 'awaiting_guest', 'scheduled'] } }),
      ...(isStaff ? {} : { profileId: { in: profileIds } }),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit,
    skip: query.skip,
  })

  const requestIds = rows.map((r) => r.id)
  const meetings = await prisma.oneOnOneMeeting.findMany({
    where: { requestId: { in: requestIds } },
  })
  const meetingByRequest = Object.fromEntries(meetings.map((m) => [m.requestId, m]))
  const slots = await prisma.oneOnOneProposedSlot.findMany({
    where: { requestId: { in: requestIds }, status: { in: ['available', 'selected'] } },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  })
  const slotsByRequest = slots.reduce<Record<string, SlotRow[]>>((acc, slot) => {
    ;(acc[slot.requestId] ||= []).push(slot)
    return acc
  }, {})

  return {
    items: rows.map((row) => serializeRequest(row, meetingByRequest[row.id] ?? null, slotsByRequest[row.id] ?? [])),
    total: rows.length,
    skip: query.skip,
    limit: query.limit,
  }
}

const scheduleMeetingFromRequest = async (actor: Actor, input: ScheduleMeetingInput) => {
  assertOneOnOneClientReady()
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: input.requestId } })
  if (!request) throw new AppError(404, '1-on-1 request not found')
  if (request.status !== 'open' && request.status !== 'awaiting_guest') {
    throw new AppError(400, 'Only open 1-on-1 requests can receive proposed times')
  }
  if (await prisma.oneOnOneMeeting.findUnique({ where: { requestId: request.id } })) {
    throw new AppError(400, 'This request already has a confirmed meeting')
  }

  await assertOwnerCanSchedule(actor, request)

  const profile = await resolveCardOwnerUser(request.profileId)
  const ownerUserId = profile.userId || actor.id
  const ownerName =
    (await prisma.user.findUnique({ where: { id: ownerUserId }, select: { name: true } }))?.name ||
    actor.name ||
    'vCard owner'
  const timezone = input.timezone || 'UTC'
  const durationMinutes = input.durationMinutes ?? 30
  const title = input.title || `1-on-1 with ${request.guestName}`
  const description = input.description || request.message || null

  const uniqueSlots = new Map<string, { date: string; startTime: string }>()
  for (const slot of input.slots) {
    const startTime = normalizeTimeToHHmm(slot.startTime)
    uniqueSlots.set(`${slot.date}|${startTime}`, { date: slot.date, startTime })
  }
  if (!uniqueSlots.size) throw new AppError(400, 'Add at least one date and time option')

  await prisma.oneOnOneProposedSlot.deleteMany({ where: { requestId: request.id } })
  await prisma.oneOnOneProposedSlot.createMany({
    data: [...uniqueSlots.values()].map((slot) => ({
      requestId: request.id,
      date: slot.date,
      startTime: slot.startTime,
      durationMinutes,
      timezone,
      status: 'available',
    })),
  })

  const updated = await prisma.oneOnOneRequest.update({
    where: { id: request.id },
    data: {
      status: 'awaiting_guest',
      cardOwnerUserId: ownerUserId,
      corporateId: profile.companyUserId || request.corporateId || null,
      proposedTitle: title,
      proposedDescription: description,
      proposedTimezone: timezone,
      proposedDurationMinutes: durationMinutes,
    },
  })

  const slots = await prisma.oneOnOneProposedSlot.findMany({
    where: { requestId: request.id, status: 'available' },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  })

  const pickUrl = guestPickUrl(request.id)
  const slotLines = slots.map((s) => `${s.date} at ${s.startTime} (${s.timezone})`)
  const optionsLabel = `${slots.length} time option${slots.length === 1 ? '' : 's'}`

  await sendEmailsSafe(
    [request.guestEmail],
    `${ownerName} proposed times for your 1-on-1`,
    oneOnOneEmailHtml({
      greetingName: request.guestName,
      intro: `<strong>${escapeHtml(ownerName)}</strong> proposed times for your 1-on-1. Pick one option to confirm the meeting.`,
      details: [
        { label: 'Host', value: ownerName },
        { label: 'Options', value: slotLines.join(' · ') },
        { label: 'Duration', value: `${durationMinutes} minutes` },
        { label: 'Note', value: description || '—' },
      ],
      ctaLabel: 'Choose your time',
      ctaUrl: pickUrl,
      footer: 'After you confirm, the meeting is created automatically — no further action needed.',
    }),
    '1-on-1 propose guest'
  )

  const guestProfileId = await findGuestPushProfile(request.guestEmail)
  await pushGuestMeetingNotification({
    guestProfileId,
    guestEmail: request.guestEmail,
    ownerName,
    eventType: 'times_proposed',
    dateLabel: optionsLabel,
    timeLabel: 'pick a time',
    meetingUrl: pickUrl,
  })

  return {
    request: serializeRequest(updated, null, slots),
    meeting: null,
    guestPickUrl: pickUrl,
  }
}

const confirmGuestSlot = async (requestId: string, input: ConfirmGuestSlotInput) => {
  assertOneOnOneClientReady()
  const request = await prisma.oneOnOneRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError(404, '1-on-1 request not found')
  if (request.status === 'scheduled') {
    const existing = await prisma.oneOnOneMeeting.findUnique({ where: { requestId } })
    if (existing) {
      return {
        request: serializeRequest(request, existing),
        meeting: serializeMeeting(existing),
        alreadyConfirmed: true,
      }
    }
  }
  if (request.status !== 'awaiting_guest') {
    throw new AppError(400, 'This request is not waiting for a guest time selection')
  }

  const slot = await prisma.oneOnOneProposedSlot.findFirst({
    where: { id: input.slotId, requestId, status: 'available' },
  })
  if (!slot) throw new AppError(404, 'That time option is no longer available')

  const profile = await resolveCardOwnerUser(request.profileId)
  const ownerUserId = profile.userId || request.cardOwnerUserId
  if (!ownerUserId) throw new AppError(400, 'This card has no owner to host the meeting')

  const ownerName =
    (await prisma.user.findUnique({ where: { id: ownerUserId }, select: { name: true } }))?.name || 'vCard owner'
  const timezone = slot.timezone || request.proposedTimezone || 'UTC'
  const durationMinutes = slot.durationMinutes || request.proposedDurationMinutes || 30
  const startsAt = parseSlotDateTime(slot.date, slot.startTime)
  if (Number.isNaN(startsAt.getTime())) throw new AppError(400, 'Invalid selected date/time')
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000)
  const title = request.proposedTitle || `1-on-1 with ${request.guestName}`
  const description = request.proposedDescription || request.message || `1-on-1 with ${request.guestName}`

  const calendar = await createOrUpdateZohoEvent({
    title,
    description: description || '',
    date: slot.date,
    time: normalizeTimeToHHmm(slot.startTime),
    durationMinutes,
    attendeeEmail: request.guestEmail,
  })

  const meeting = await prisma.oneOnOneMeeting.create({
    data: {
      requestId: request.id,
      cardId: profile.id,
      cardOwnerUserId: ownerUserId,
      corporateId: profile.companyUserId || request.corporateId || null,
      zohoCalendarEventId: calendar.eventId,
      zohoMeetingId: calendar.eventId,
      zohoMeetingUrl: calendar.meetLink,
      title,
      description,
      startAt: startsAt,
      endAt: endsAt,
      timezone,
      status: 'scheduled',
      createdByUserId: ownerUserId,
    },
  })

  await prisma.oneOnOneProposedSlot.update({
    where: { id: slot.id },
    data: { status: 'selected' },
  })
  await prisma.oneOnOneProposedSlot.updateMany({
    where: { requestId: request.id, id: { not: slot.id }, status: 'available' },
    data: { status: 'discarded' },
  })

  const updatedRequest = await prisma.oneOnOneRequest.update({
    where: { id: request.id },
    data: { status: 'scheduled', cardOwnerUserId: ownerUserId },
  })

  const dateLabel = formatDisplayDate(startsAt, timezone)
  const timeLabel = formatDisplayTime(startsAt, timezone)
  const pickUrl = guestPickUrl(request.id)
  const joinUrl = calendar.meetLink || pickUrl

  const guestProfileId = await findGuestPushProfile(request.guestEmail)
  await pushGuestMeetingNotification({
    guestProfileId,
    guestEmail: request.guestEmail,
    ownerName,
    eventType: 'scheduled',
    dateLabel,
    timeLabel,
    meetingUrl: joinUrl,
  })

  await sendEmailsSafe(
    [request.guestEmail],
    `Your 1-on-1 with ${ownerName} is confirmed`,
    oneOnOneEmailHtml({
      greetingName: request.guestName,
      intro: `Your 1-on-1 with <strong>${escapeHtml(ownerName)}</strong> is confirmed.`,
      details: [
        { label: 'Date', value: dateLabel },
        { label: 'Time', value: `${timeLabel} (${timezone})` },
        { label: 'Duration', value: `${durationMinutes} minutes` },
        { label: 'Join link', value: calendar.meetLink || 'See calendar invitation' },
      ],
      ctaLabel: calendar.meetLink ? 'Join meeting' : 'View details',
      ctaUrl: joinUrl,
      footer: 'You do not need a Zoho account to join. Keep this email for your records.',
    }),
    '1-on-1 confirm guest'
  )

  const stakeholders = await resolveCardStakeholderEmails(profile.id)
  notifyCardPush(
    profile.id,
    {
      title: `${request.guestName} confirmed the 1-on-1`,
      body: `Meeting confirmed for ${dateLabel} at ${timeLabel}.`,
      url: calendar.meetLink || undefined,
    },
    stakeholders.slug
  )

  await sendEmailsSafe(
    stakeholders.emails,
    `${request.guestName} confirmed your 1-on-1`,
    oneOnOneEmailHtml({
      greetingName: stakeholders.ownerName,
      intro: `<strong>${escapeHtml(request.guestName)}</strong> confirmed a time for the 1-on-1 on <strong>${escapeHtml(stakeholders.cardName)}</strong>.`,
      details: [
        { label: 'Guest', value: `${request.guestName} · ${request.guestEmail}` },
        { label: 'Date', value: dateLabel },
        { label: 'Time', value: `${timeLabel} (${timezone})` },
        { label: 'Join link', value: calendar.meetLink || 'See calendar invitation' },
      ],
      ctaLabel: calendar.meetLink ? 'Open join link' : undefined,
      ctaUrl: calendar.meetLink,
      footer: stakeholders.companyUserId
        ? 'Sent to the card owner and linked corporate manager.'
        : 'Sent to the card owner.',
    }),
    '1-on-1 confirm stakeholders'
  )

  await createStakeholderInboxNotice({
    emails: stakeholders.emails,
    title: `1-on-1 confirmed: ${request.guestName}`,
    body: `${request.guestName} confirmed ${dateLabel} at ${timeLabel}.${calendar.meetLink ? ` Join: ${calendar.meetLink}` : ''}`,
    profileId: profile.id,
    slug: stakeholders.slug,
    requestId: request.id,
  })

  return {
    request: serializeRequest(updatedRequest, meeting),
    meeting: serializeMeeting(meeting),
    alreadyConfirmed: false,
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

  const startsAt = parseSlotDateTime(input.date, input.startTime)
  const durationMinutes = input.durationMinutes ?? 30
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000)
  const timezone = input.timezone || meeting.timezone

  const calendar = await createOrUpdateZohoEvent({
    title: input.title || meeting.title,
    description: input.description || meeting.description || '',
    date: input.date,
    time: normalizeTimeToHHmm(input.startTime),
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
  if (meeting) {
    if (meeting.status === 'cancelled') throw new AppError(410, 'Meeting was cancelled')
    return {
      mode: 'confirmed' as const,
      title: meeting.title,
      guestName: request.guestName,
      date: formatDisplayDate(meeting.startAt, meeting.timezone),
      startTime: formatDisplayTime(meeting.startAt, meeting.timezone),
      endTime: formatDisplayTime(meeting.endAt, meeting.timezone),
      timezone: meeting.timezone,
      description: meeting.description,
      joinUrl: meeting.zohoMeetingUrl,
      status: meeting.status,
      slots: [] as ReturnType<typeof serializeSlot>[],
    }
  }

  if (request.status !== 'awaiting_guest') {
    throw new AppError(404, 'Meeting not found')
  }

  const slots = await prisma.oneOnOneProposedSlot.findMany({
    where: { requestId, status: 'available' },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  })
  if (!slots.length) throw new AppError(404, 'No time options are available for this request')

  return {
    mode: 'pick_slot' as const,
    title: request.proposedTitle || `1-on-1 with ${request.guestName}`,
    guestName: request.guestName,
    date: '',
    startTime: '',
    endTime: '',
    timezone: request.proposedTimezone || slots[0]?.timezone || 'UTC',
    description: request.proposedDescription || request.message,
    joinUrl: null,
    status: request.status,
    slots: slots.map(serializeSlot),
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
  confirmGuestSlot,
  rescheduleMeetingFromRequest,
  cancelMeetingFromRequest,
  completeMeetingFromRequest,
  getMeetingForGuest,
  listOwnerMeetings,
  signGuestToken,
  verifyGuestToken,
}

export default oneOnOneService
