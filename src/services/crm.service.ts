import type { Prisma } from '../../generated/prisma/client'
import config from '../configs/config'
import AppError from '../error/AppError'
import {
  buildCrmExternalLeadMeta,
  guestSaveExternalWhere,
  guestSaveOriginWhere,
  type CrmLeadOrigin,
} from '../utils/crmLeadOrigin'
import {
  assertCrmStaffAuthorization,
  assertRequestedProfileInScope,
  crmProfileWhere,
  isProfileIdInCrmScope,
  resolveCrmScopeKind,
  stripClientOwnershipClaims,
  type CrmAccessContext,
  type CrmActor,
  type CrmScopeKind,
} from '../utils/crmScope'
import { prisma } from '../utils/prisma'
import { mapGuestSave, mergeAdminMeta, type AdminLeadRow } from './adminLeads.service'
import { assertUserPackageAccess } from './entitlement.service'
import {
  countOpenForActor as countOpenWorkNotesForActor,
  countOverdueForActor as countOverdueWorkNotesForActor,
  countForActor as countWorkNotesForActor,
  listOverdue as listOverdueWorkNotes,
  listUpcoming as listUpcomingWorkNotes,
  listWorkNotesByStartsAtRange,
} from './workNote.service'

export type { CrmAccessContext, CrmActor, CrmScopeKind }

export type CrmLeadRow = AdminLeadRow

export async function resolveCrmAccess(actor: CrmActor): Promise<CrmAccessContext> {
  const kind = resolveCrmScopeKind(actor.role)

  if (kind === 'admin') {
    assertCrmStaffAuthorization(actor)
    return { kind, profileIds: null }
  }

  await assertUserPackageAccess(
    actor.id,
    actor.role,
    'allow_crm',
    'CRM isn’t on your current plan. Upgrade to Professional, Professional Concierge, or Corporate to use it.'
  )

  const where = crmProfileWhere(actor.id, kind)
  const profiles = await prisma.profile.findMany({
    where: where ?? undefined,
    select: { id: true },
  })
  return { kind, profileIds: profiles.map((row) => row.id) }
}

function searchTokens(q?: string): string[] {
  return q?.trim().split(/\s+/).filter(Boolean) ?? []
}

function profileIdentitySearch(token: string): Prisma.ProfileWhereInput {
  const search = { contains: token, mode: 'insensitive' as const }
  return {
    OR: [
      { name: search },
      { slug: search },
      { designation: search },
      { prof: search },
      { companyName: search },
      { email: search },
      { phone: search },
      { profession: { name: search } },
      { user: { is: { name: search } } },
      { user: { is: { email: search } } },
    ],
  }
}

const profileInclude = {
  select: {
    id: true,
    name: true,
    slug: true,
    designation: true,
    prof: true,
    companyName: true,
    profession: { select: { name: true } },
    userId: true,
    user: { select: { id: true, name: true } },
  },
} as const

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { firstName: parts[0] || fullName, lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

function scopedProfileFilter(profileIds: string[] | null, requestedProfileId?: string): Prisma.GuestUserDataWhereInput {
  assertRequestedProfileInScope({ profileIds }, requestedProfileId)
  if (requestedProfileId) return { profileId: requestedProfileId }
  if (profileIds === null) return {}
  return { profileId: { in: profileIds } }
}

async function countUpcomingMeetings(access: CrmAccessContext) {
  const now = new Date()
  if (access.profileIds === null) {
    return prisma.meeting.count({
      where: { status: 'Scheduled', startsAt: { gte: now } },
    })
  }
  if (!access.profileIds.length) return 0
  return prisma.meeting.count({
    where: {
      status: 'Scheduled',
      startsAt: { gte: now },
      OR: [{ profileId: { in: access.profileIds } }, { scope: 'global' }],
    },
  })
}

export async function getCrmDashboard(actor: CrmActor) {
  const access = await resolveCrmAccess(actor)
  const empty = {
    scope: access.kind,
    metrics: {
      newLeads: 0,
      openLeads: 0,
      externalLeads: 0,
      workNotesTotal: 0,
      workNotesOpen: 0,
      workNotesOverdue: 0,
      upcomingMeetings: 0,
    },
    upcomingWorkNotes: [] as Awaited<ReturnType<typeof listUpcomingWorkNotes>>,
    overdueWorkNotes: [] as Awaited<ReturnType<typeof listOverdueWorkNotes>>,
  }

  if (access.profileIds !== null && access.profileIds.length === 0) {
    return empty
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const profileFilter = access.profileIds === null ? {} : { profileId: { in: access.profileIds } }

  const [
    openLeads,
    newLeads,
    externalLeads,
    workNotesTotal,
    workNotesOpen,
    workNotesOverdue,
    upcomingMeetings,
    upcomingWorkNotes,
    overdueWorkNotes,
  ] = await Promise.all([
    prisma.guestUserData.count({ where: profileFilter }),
    prisma.guestUserData.count({ where: { ...profileFilter, createdAt: { gte: since } } }),
    prisma.guestUserData.count({ where: { ...profileFilter, ...guestSaveExternalWhere() } }),
    countWorkNotesForActor(actor, access),
    countOpenWorkNotesForActor(actor, access),
    countOverdueWorkNotesForActor(actor, access),
    countUpcomingMeetings(access),
    listUpcomingWorkNotes(actor, access, 5),
    listOverdueWorkNotes(actor, access, 5),
  ])

  return {
    scope: access.kind,
    metrics: {
      newLeads,
      openLeads,
      externalLeads,
      workNotesTotal,
      workNotesOpen,
      workNotesOverdue,
      upcomingMeetings,
    },
    upcomingWorkNotes,
    overdueWorkNotes,
  }
}

export async function listCrmLeads(
  actor: CrmActor,
  query: { q?: string; profileId?: string; origin?: CrmLeadOrigin; skip?: number; limit?: number }
) {
  const access = await resolveCrmAccess(actor)
  const skip = Math.max(0, query.skip ?? 0)
  const limit = Math.min(100, Math.max(1, query.limit ?? 50))

  if (access.profileIds !== null && access.profileIds.length === 0) {
    return { items: [] as CrmLeadRow[], total: 0, skip, limit }
  }

  const tokens = searchTokens(query.q)
  const where: Prisma.GuestUserDataWhereInput = {
    ...scopedProfileFilter(access.profileIds, query.profileId),
    ...guestSaveOriginWhere(query.origin),
    ...(tokens.length
      ? {
          AND: tokens.map((token) => {
            const search = { contains: token, mode: 'insensitive' as const }
            return {
              OR: [
                { fullName: search },
                { email: search },
                { phone: search },
                { profile: { is: profileIdentitySearch(token) } },
              ],
            }
          }),
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.guestUserData.count({ where }),
    prisma.guestUserData.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { profile: profileInclude },
    }),
  ])

  return { items: rows.map(mapGuestSave), total, skip, limit }
}

export async function createCrmLead(actor: CrmActor, rawBody: Record<string, unknown>): Promise<CrmLeadRow> {
  const access = await resolveCrmAccess(actor)
  const body = stripClientOwnershipClaims(rawBody)
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : ''
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : ''
  if (!profileId) throw new AppError(400, 'A card is required')
  if (!fullName) throw new AppError(400, 'Lead name is required')
  assertRequestedProfileInScope(access, profileId)

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const { firstName, lastName } = splitName(fullName)
  const notes = typeof body.notes === 'string' ? body.notes : undefined
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''

  const row = await prisma.guestUserData.create({
    data: {
      profileId,
      fullName,
      firstName,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      meta: buildCrmExternalLeadMeta(notes),
    },
    include: { profile: profileInclude },
  })

  return mapGuestSave(row)
}

async function loadScopedGuest(actor: CrmActor, id: string) {
  const access = await resolveCrmAccess(actor)
  const existing = await prisma.guestUserData.findUnique({
    where: { id },
    include: { profile: profileInclude },
  })
  if (!existing || !isProfileIdInCrmScope(access, existing.profileId)) {
    throw new AppError(404, 'Lead not found')
  }
  return existing
}

export async function patchCrmLead(
  actor: CrmActor,
  id: string,
  body: { privateNotes?: string; lastReply?: string }
): Promise<CrmLeadRow> {
  const existing = await loadScopedGuest(actor, id)
  const updated = await prisma.guestUserData.update({
    where: { id },
    data: { meta: mergeAdminMeta(existing.meta, body) },
    include: { profile: profileInclude },
  })
  return mapGuestSave(updated)
}

export async function deleteCrmLead(actor: CrmActor, id: string) {
  await loadScopedGuest(actor, id)
  await prisma.guestUserData.delete({ where: { id } })
  return { id, deleted: true }
}

export type SchedulePerson = {
  id: string
  kind: 'card' | 'guest'
  name: string
  email: string
  phone: string
  profileId: string | null
  subtitle: string
}

export async function searchSchedulePeople(
  actor: CrmActor,
  query: { q?: string; limit?: number }
): Promise<SchedulePerson[]> {
  const access = await resolveCrmAccess(actor)
  const q = query.q?.trim() || ''
  const limit = Math.min(40, Math.max(1, query.limit ?? 20))
  const results: SchedulePerson[] = []

  const includeCards = access.kind === 'admin' || access.kind === 'corporate'

  if (includeCards) {
    const profileWhere =
      access.kind === 'admin'
        ? q.length >= 2
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { email: { contains: q, mode: 'insensitive' as const } },
                { phone: { contains: q, mode: 'insensitive' as const } },
                { slug: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}
        : {
            AND: [
              crmProfileWhere(actor.id, access.kind) || {},
              q.length >= 2
                ? {
                    OR: [
                      { name: { contains: q, mode: 'insensitive' as const } },
                      { email: { contains: q, mode: 'insensitive' as const } },
                      { phone: { contains: q, mode: 'insensitive' as const } },
                      { slug: { contains: q, mode: 'insensitive' as const } },
                    ],
                  }
                : {},
            ],
          }

    const cards = await prisma.profile.findMany({
      where: profileWhere,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        slug: true,
        designation: true,
        companyName: true,
      },
    })

    for (const card of cards) {
      results.push({
        id: `card:${card.id}`,
        kind: 'card',
        name: card.name,
        email: card.email || '',
        phone: card.phone || '',
        profileId: card.id,
        subtitle: [card.designation, card.companyName, card.slug ? `/${card.slug}` : ''].filter(Boolean).join(' · '),
      })
    }
  }

  const guestWhere =
    access.profileIds === null
      ? q.length >= 2
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
              { phone: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}
      : {
          profileId: { in: access.profileIds },
          ...(q.length >= 2
            ? {
                OR: [
                  { fullName: { contains: q, mode: 'insensitive' as const } },
                  { email: { contains: q, mode: 'insensitive' as const } },
                  { phone: { contains: q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        }

  const guests = await prisma.guestUserData.findMany({
    where: guestWhere,
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      profileId: true,
      profile: { select: { name: true, slug: true } },
    },
  })

  for (const guest of guests) {
    results.push({
      id: `guest:${guest.id}`,
      kind: 'guest',
      name: guest.fullName || 'Guest',
      email: guest.email || '',
      phone: guest.phone || '',
      profileId: guest.profileId,
      subtitle: [guest.profile?.name, guest.profile?.slug ? `/${guest.profile.slug}` : '', 'Saved guest']
        .filter(Boolean)
        .join(' · '),
    })
  }

  return results.slice(0, limit)
}

export type CrmScheduleCalendarItem = {
  kind: 'meeting' | 'work_note'
  id: string
  zohoEventId?: string | null
  title: string
  host: string
  type: string
  date: string
  time: string
  startsAt: string
  status: string
  meetLink?: string | null
  notes?: string | null
  scope?: string
  profileId?: string | null
  canManageMeeting: boolean
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function formatInTz(date: Date, timeZone: string): { date: string; time: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(date)
    const get = (type: string) => parts.find((p) => p.type === type)?.value || ''
    const y = get('year')
    const m = get('month')
    const d = get('day')
    const hour = get('hour')
    const minute = get('minute')
    const dayPeriod = get('dayPeriod')
    return {
      date: `${y}-${m}-${d}`,
      time: `${hour}:${minute} ${dayPeriod}`.trim(),
    }
  } catch {
    return {
      date: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
      time: date.toISOString().slice(11, 16),
    }
  }
}

function parseGroupProfileIds(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

async function listMeetingsForScheduleFeed(access: CrmAccessContext, fromBound: Date, toBound: Date) {
  const rangeWhere: Prisma.MeetingWhereInput = {
    startsAt: { gte: fromBound, lte: toBound },
  }

  if (access.profileIds === null) {
    return prisma.meeting.findMany({
      where: rangeWhere,
      orderBy: { startsAt: 'asc' },
      take: 500,
    })
  }

  if (!access.profileIds.length) return []

  const [directRows, globalRows, groupRows] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        ...rangeWhere,
        profileId: { in: access.profileIds },
      },
      orderBy: { startsAt: 'asc' },
      take: 500,
    }),
    prisma.meeting.findMany({
      where: { ...rangeWhere, scope: 'global' },
      orderBy: { startsAt: 'asc' },
      take: 200,
    }),
    prisma.meeting.findMany({
      where: { ...rangeWhere, scope: 'group' },
      orderBy: { startsAt: 'asc' },
      take: 200,
    }),
  ])

  const groupMatches = groupRows.filter((row) => {
    const ids = parseGroupProfileIds(row.groupProfileIds)
    return ids.some((id) => access.profileIds!.includes(id))
  })

  const byId = new Map<string, (typeof directRows)[number]>()
  for (const row of [...directRows, ...globalRows, ...groupMatches]) {
    byId.set(row.id, row)
  }
  return [...byId.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/**
 * CRM Schedules feed: read from DB (fast), Zoho remains write-through sync on create/update/delete.
 */
export async function getCrmScheduleCalendar(
  actor: CrmActor,
  query: { from: string; to: string }
): Promise<{ items: CrmScheduleCalendarItem[]; zohoError: string | null }> {
  const access = await resolveCrmAccess(actor)
  const tz = config.ZOHO_CALENDAR.TIMEZONE || 'UTC'

  const fromBound = new Date(`${query.from}T00:00:00.000Z`)
  const toBound = new Date(`${query.to}T23:59:59.999Z`)
  if (Number.isNaN(fromBound.getTime()) || Number.isNaN(toBound.getTime())) {
    throw new AppError(400, 'Invalid from/to date range')
  }

  const [meetings, workNotes] = await Promise.all([
    listMeetingsForScheduleFeed(access, fromBound, toBound),
    listWorkNotesByStartsAtRange(actor, access, query.from, query.to),
  ])

  const meetingItems: CrmScheduleCalendarItem[] = meetings.map((row) => ({
    kind: 'meeting',
    id: row.id,
    zohoEventId: row.googleEventId,
    title: row.type,
    host: row.host,
    type: row.type,
    date: row.date,
    time: row.time,
    startsAt: row.startsAt.toISOString(),
    status: row.status,
    meetLink: row.meetLink,
    notes: row.notes,
    scope: row.scope,
    profileId: row.profileId,
    canManageMeeting: true,
  }))

  const noteItems: CrmScheduleCalendarItem[] = workNotes
    .filter((note) => note.startsAt)
    .map((note) => {
      const startsAt = new Date(note.startsAt!)
      const { date, time } = formatInTz(startsAt, tz)
      return {
        kind: 'work_note' as const,
        id: note.id,
        zohoEventId: null,
        title: note.title,
        host: note.assigneeName || note.createdByName || 'Work note',
        type: 'Work Note',
        date,
        time,
        startsAt: note.startsAt!,
        status: note.status,
        meetLink: null,
        notes: note.description,
        scope: undefined,
        profileId: note.profileId,
        canManageMeeting: false,
      }
    })

  const items = [...meetingItems, ...noteItems].sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))

  return { items, zohoError: null }
}

const crmService = {
  resolveCrmAccess,
  getCrmDashboard,
  listCrmLeads,
  createCrmLead,
  patchCrmLead,
  deleteCrmLead,
  searchSchedulePeople,
  getCrmScheduleCalendar,
}

export default crmService
