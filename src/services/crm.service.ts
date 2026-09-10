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
import crmEventService from './crmEvent.service'
import {
  countOpenForActor as countOpenWorkNotesForActor,
  countOverdueForActor as countOverdueWorkNotesForActor,
  countForActor as countWorkNotesForActor,
  listOverdue as listOverdueWorkNotes,
  listUpcoming as listUpcomingWorkNotes,
  listWorkNotesByStartsAtRange,
} from './workNote.service'

export type { CrmAccessContext, CrmActor, CrmScopeKind }

export type CrmLeadCardRef = {
  leadId: string
  profileId: string
  slug: string
  name: string
  submittedAt: string
  origin: CrmLeadOrigin
}

export type CrmLeadRow = AdminLeadRow & {
  notesCount: number
  schedulesCount: number
  eventsCount: number
  /** Cards this person (email) appears on — unique by profile. */
  cards?: CrmLeadCardRef[]
  /** All guest-save row ids under this grouped lead. */
  leadIds?: string[]
}

function normalizeLeadEmail(email: string | null | undefined): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/** Count meetings/events by lead id without GuestUserData `_count` (stale clients may lack those relations). */
async function countLeadMeetingsAndEvents(leadIds: string[]): Promise<{
  meetings: Map<string, number>
  events: Map<string, number>
}> {
  const meetings = new Map<string, number>()
  const events = new Map<string, number>()
  if (!leadIds.length) return { meetings, events }

  try {
    const [meetingRows, eventRows] = await Promise.all([
      prisma.meeting.groupBy({
        by: ['guestUserDataId'],
        where: { guestUserDataId: { in: leadIds } },
        _count: { _all: true },
      }),
      prisma.crmEvent.groupBy({
        by: ['guestUserDataId'],
        where: { guestUserDataId: { in: leadIds } },
        _count: { _all: true },
      }),
    ])
    for (const row of meetingRows) {
      if (row.guestUserDataId) meetings.set(row.guestUserDataId, row._count._all)
    }
    for (const row of eventRows) {
      if (row.guestUserDataId) events.set(row.guestUserDataId, row._count._all)
    }
  } catch {
    // Production client/DB may not expose guestUserDataId yet — keep zeros.
  }

  return { meetings, events }
}

/** One person per email; same email on many cards → one row with `cards`. No email → one row per save. */
function groupCrmLeadsByEmail(
  rows: Array<AdminLeadRow & { notesCount: number; schedulesCount: number; eventsCount: number }>
): CrmLeadRow[] {
  const buckets = new Map<
    string,
    Array<AdminLeadRow & { notesCount: number; schedulesCount: number; eventsCount: number }>
  >()
  const order: string[] = []

  for (const row of rows) {
    const email = normalizeLeadEmail(row.email)
    const key = email || `id:${row.id}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else {
      buckets.set(key, [row])
      order.push(key)
    }
  }

  return order.map((key) => {
    const list = buckets.get(key) || []
    const primary = list[0]
    const cardsByProfile = new Map<string, CrmLeadCardRef>()
    for (const row of list) {
      if (cardsByProfile.has(row.vCardId)) continue
      cardsByProfile.set(row.vCardId, {
        leadId: row.id,
        profileId: row.vCardId,
        slug: row.vCardSlug,
        name: row.vCardName,
        submittedAt: row.submittedAt,
        origin: row.origin,
      })
    }
    const cards = [...cardsByProfile.values()]
    const notesCount = list.reduce((sum, row) => sum + (row.notesCount || 0), 0)
    const schedulesCount = list.reduce((sum, row) => sum + (row.schedulesCount || 0), 0)
    const eventsCount = list.reduce((sum, row) => sum + (row.eventsCount || 0), 0)
    return {
      ...primary,
      notesCount,
      schedulesCount,
      eventsCount,
      cards,
      leadIds: list.map((row) => row.id),
      // Prefer primary card fields from the newest unique card set when only one card.
      vCardId: cards[0]?.profileId || primary.vCardId,
      vCardSlug: cards[0]?.slug || primary.vCardSlug,
      vCardName: cards[0]?.name || primary.vCardName,
    }
  })
}

export async function listCrmLeads(
  actor: CrmActor,
  query: { q?: string; profileId?: string; origin?: CrmLeadOrigin; skip?: number; limit?: number }
) {
  const access = await resolveCrmAccess(actor)
  const skip = Math.max(0, query.skip ?? 0)
  const limit = Math.min(100, Math.max(1, query.limit ?? 10))

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

  // Search/filter across all matching saves, then group by email and paginate groups.
  const rows = await prisma.guestUserData.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      profile: profileInclude,
      _count: { select: { leadNotes: true } },
    },
  })

  const activity = await countLeadMeetingsAndEvents(rows.map((row) => row.id))
  const grouped = groupCrmLeadsByEmail(
    rows.map((row) => ({
      ...mapGuestSave(row),
      notesCount: row._count.leadNotes,
      schedulesCount: activity.meetings.get(row.id) ?? 0,
      eventsCount: activity.events.get(row.id) ?? 0,
    }))
  )
  const total = grouped.length
  const items = grouped.slice(skip, skip + limit)

  return {
    items,
    total,
    skip,
    limit,
  }
}

export async function resolveCrmAccess(actor: CrmActor): Promise<CrmAccessContext> {
  const kind = resolveCrmScopeKind(actor.role)

  if (kind === 'admin') {
    assertCrmStaffAuthorization(actor)
    return { kind, profileIds: null }
  }

  // CRM is available to every owner back office (single, corporate, linked member) — not package-gated.
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
  const normalizedEmail = normalizeLeadEmail(email)

  // Same email on the same card → update existing instead of creating a duplicate.
  if (normalizedEmail) {
    const existing = await prisma.guestUserData.findFirst({
      where: {
        profileId,
        email: { equals: normalizedEmail, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        profile: profileInclude,
        _count: { select: { leadNotes: true } },
      },
    })
    if (existing) {
      const updated = await prisma.guestUserData.update({
        where: { id: existing.id },
        data: {
          fullName,
          firstName,
          lastName: lastName || null,
          email: normalizedEmail,
          phone: phone || existing.phone,
          ...(notes
            ? { meta: buildCrmExternalLeadMeta(notes) }
            : existing.meta != null
              ? { meta: existing.meta as Prisma.InputJsonValue }
              : {}),
        },
        include: {
          profile: profileInclude,
          _count: { select: { leadNotes: true } },
        },
      })
      const mapped = {
        ...mapGuestSave(updated),
        notesCount: updated._count.leadNotes,
        schedulesCount: 0,
        eventsCount: 0,
      }
      return {
        ...mapped,
        cards: [
          {
            leadId: mapped.id,
            profileId: mapped.vCardId,
            slug: mapped.vCardSlug,
            name: mapped.vCardName,
            submittedAt: mapped.submittedAt,
            origin: mapped.origin,
          },
        ],
        leadIds: [mapped.id],
      }
    }
  }

  const row = await prisma.guestUserData.create({
    data: {
      profileId,
      fullName,
      firstName,
      lastName: lastName || null,
      email: normalizedEmail || null,
      phone: phone || null,
      meta: buildCrmExternalLeadMeta(notes),
    },
    include: { profile: profileInclude },
  })

  return {
    ...mapGuestSave(row),
    notesCount: 0,
    schedulesCount: 0,
    eventsCount: 0,
    cards: [
      {
        leadId: row.id,
        profileId: row.profileId,
        slug: row.profile?.slug || '',
        name: row.profile?.name || '',
        submittedAt: row.createdAt.toISOString(),
        origin: 'crm_external' as const,
      },
    ],
    leadIds: [row.id],
  }
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
  // Guest replies belong on notepad UserNotes, not GuestUserData contact saves.
  if (body.lastReply !== undefined) {
    throw new AppError(400, 'Replies are only supported on lead notes, not contact saves')
  }
  const existing = await loadScopedGuest(actor, id)
  const updated = await prisma.guestUserData.update({
    where: { id },
    data: { meta: mergeAdminMeta(existing.meta, body) },
    include: {
      profile: profileInclude,
      _count: { select: { leadNotes: true } },
    },
  })
  const activity = await countLeadMeetingsAndEvents([id])
  return {
    ...mapGuestSave(updated),
    notesCount: updated._count.leadNotes,
    schedulesCount: activity.meetings.get(id) ?? 0,
    eventsCount: activity.events.get(id) ?? 0,
  }
}

export async function deleteCrmLead(actor: CrmActor, id: string) {
  await loadScopedGuest(actor, id)
  await prisma.guestUserData.delete({ where: { id } })
  return { id, deleted: true }
}

export type LeadScheduleRow = {
  id: string
  host: string
  type: string
  date: string
  time: string
  startsAt: string
  status: string
  meetLink: string | null
  notes: string | null
}

export type LeadEventRow = {
  id: string
  host: string
  type: string
  date: string
  time: string
  startsAt: string
  status: string
  description: string | null
  recipientName: string | null
}

export async function listLeadSchedules(actor: CrmActor, leadId: string): Promise<LeadScheduleRow[]> {
  await loadScopedGuest(actor, leadId)
  const rows = await prisma.meeting.findMany({
    where: { guestUserDataId: leadId },
    orderBy: { startsAt: 'desc' },
    take: 100,
  })
  return rows.map((row) => ({
    id: row.id,
    host: row.host,
    type: row.type,
    date: row.date,
    time: row.time,
    startsAt: row.startsAt.toISOString(),
    status: row.status,
    meetLink: row.meetLink,
    notes: row.notes,
  }))
}

export async function listLeadEvents(actor: CrmActor, leadId: string): Promise<LeadEventRow[]> {
  await loadScopedGuest(actor, leadId)
  const rows = await prisma.crmEvent.findMany({
    where: { guestUserDataId: leadId },
    orderBy: { startsAt: 'desc' },
    take: 100,
  })
  return rows.map((row) => ({
    id: row.id,
    host: row.host,
    type: row.type,
    date: row.date,
    time: row.time,
    startsAt: row.startsAt.toISOString(),
    status: row.status,
    description: row.description,
    recipientName: row.recipientName,
  }))
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

export type CrmScheduleCalendarAttachment = {
  url: string
  fileName: string
  mimeType?: string | null
  publicId?: string | null
  resourceType?: 'image' | 'video' | 'audio' | null
}

export type CrmScheduleCalendarItem = {
  kind: 'meeting' | 'work_note' | 'event'
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
  attachments?: CrmScheduleCalendarAttachment[]
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

  const [meetings, workNotes, crmEvents] = await Promise.all([
    listMeetingsForScheduleFeed(access, fromBound, toBound),
    listWorkNotesByStartsAtRange(actor, access, query.from, query.to),
    crmEventService.listCrmEventsByStartsAtRange(access, fromBound, toBound),
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
        host: note.assigneeName || note.createdByName || 'Note',
        type: 'Note',
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

  const eventItems: CrmScheduleCalendarItem[] = crmEvents.map((row) => {
    const attachments = crmEventService.parseAttachments(row.attachments)
    return {
      kind: 'event' as const,
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
      notes:
        row.description?.trim() ||
        (attachments.length ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : null),
      attachments,
      scope: row.scope,
      profileId: row.profileId,
      canManageMeeting: true,
    }
  })

  const items = [...meetingItems, ...noteItems, ...eventItems].sort((a, b) =>
    String(a.startsAt).localeCompare(String(b.startsAt))
  )

  return { items, zohoError: null }
}

const crmService = {
  resolveCrmAccess,
  getCrmDashboard,
  listCrmLeads,
  createCrmLead,
  patchCrmLead,
  deleteCrmLead,
  listLeadSchedules,
  listLeadEvents,
  searchSchedulePeople,
  getCrmScheduleCalendar,
}

export default crmService
