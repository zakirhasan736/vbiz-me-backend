import type { Prisma } from '../../generated/prisma/client'
import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { assertAdminCanContactProfile } from '../utils/adminOutreachAccess'
import { writeAuditLog } from '../utils/auditLog'
import {
  assertRequestedProfileInScope,
  isProfileIdInCrmScope,
  type CrmAccessContext,
  type CrmActor,
} from '../utils/crmScope'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import type {
  CreateCrmEventInput,
  CrmEventAttachmentInput,
  CrmEventScope,
  CrmEventStatus,
  ListCrmEventsQuery,
  UpdateCrmEventInput,
} from '../zodValidation/crmEvent.zod'
import calendarIntegrationService from './calendarIntegration.service'
import { computeStartsAt } from './meeting.service'

type CrmEventRow = {
  id: string
  host: string
  type: string
  date: string
  time: string
  startsAt: Date
  status: string
  scope: string
  profileId: string | null
  groupProfileIds: Prisma.JsonValue | null
  attachments: Prisma.JsonValue | null
  recipientEmail: string | null
  recipientName: string | null
  createdById: string | null
  googleEventId: string | null
  meetLink: string | null
  createdAt: Date
  updatedAt: Date
}

export type CrmEventAttachment = {
  url: string
  fileName: string
  mimeType?: string | null
  publicId?: string | null
  resourceType?: 'image' | 'video' | 'audio' | null
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

function parseAttachments(value: Prisma.JsonValue | null | undefined): CrmEventAttachment[] {
  if (!value) return []
  if (!Array.isArray(value)) return []
  const out: CrmEventAttachment[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    const fileName = typeof row.fileName === 'string' ? row.fileName.trim() : ''
    if (!url || !fileName) continue
    const resourceType =
      row.resourceType === 'image' || row.resourceType === 'video' || row.resourceType === 'audio'
        ? row.resourceType
        : null
    out.push({
      url,
      fileName,
      mimeType: typeof row.mimeType === 'string' ? row.mimeType : null,
      publicId: typeof row.publicId === 'string' ? row.publicId : null,
      resourceType,
    })
  }
  return out
}

function normalizeAttachments(items: CrmEventAttachmentInput[] | undefined): CrmEventAttachment[] {
  if (!items?.length) return []
  return items.map((item) => ({
    url: item.url,
    fileName: item.fileName,
    mimeType: item.mimeType ?? null,
    publicId: item.publicId ?? null,
    resourceType: item.resourceType ?? null,
  }))
}

function resolveCreateScope(input: CreateCrmEventInput): CrmEventScope {
  return input.scope ?? (input.profileId ? 'one_to_one' : 'global')
}

async function resolveGroupProfileIds(input: CreateCrmEventInput): Promise<string[]> {
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

async function normalizeCreateInput(input: CreateCrmEventInput) {
  const scope = resolveCreateScope(input)
  const groupProfileIds = scope === 'group' ? await resolveGroupProfileIds(input) : []

  if (scope === 'group' && !groupProfileIds.length) {
    throw new AppError(400, 'Group events require at least one card')
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

async function assertCanCreateEvent(
  actor: CrmActor,
  access: CrmAccessContext,
  normalized: Awaited<ReturnType<typeof normalizeCreateInput>>
) {
  if (normalized.scope === 'global' && access.kind !== 'admin') {
    throw new AppError(403, 'Only admins can create global events')
  }

  const targetProfileIds =
    normalized.scope === 'group' ? normalized.groupProfileIds : normalized.profileId ? [normalized.profileId] : []

  for (const profileId of targetProfileIds) {
    if (!isProfileIdInCrmScope(access, profileId)) {
      throw new AppError(403, 'You can only create events for cards in your CRM scope')
    }
  }

  if (isStaffRole(actor.role)) {
    for (const profileId of targetProfileIds) {
      await assertAdminCanContactProfile(actor.id, profileId)
    }
  }
}

function serializeCrmEvent(row: CrmEventRow) {
  return {
    id: row.id,
    host: row.host,
    type: row.type,
    date: row.date,
    time: row.time,
    startsAt: row.startsAt.toISOString(),
    status: row.status as CrmEventStatus,
    scope: row.scope as CrmEventScope,
    profileId: row.profileId,
    groupProfileIds: parseGroupProfileIds(row.groupProfileIds),
    attachments: parseAttachments(row.attachments),
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    googleEventId: row.googleEventId,
    meetLink: row.meetLink,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function calendarSummary(type: string, host: string) {
  return `${type} with ${host}`
}

function calendarDescription(input: {
  host: string
  type: string
  attachments: CrmEventAttachment[]
  meetLink?: string | null
}) {
  const attachmentLines = input.attachments.map((a) => `- ${a.fileName}: ${a.url}`).join('\n')
  const parts = [
    `vBiz Me CRM event: ${input.type}`,
    `Host / card: ${input.host}`,
    attachmentLines ? `Attachments:\n${attachmentLines}` : null,
    input.meetLink ? `Link: ${input.meetLink}` : null,
  ].filter(Boolean)
  return parts.join('\n\n')
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

function eventVisibleInAccess(row: CrmEventRow, access: CrmAccessContext): boolean {
  if (access.profileIds === null) return true
  if (!access.profileIds.length) return false
  if (row.scope === 'global') return true
  if (row.scope === 'one_to_one') {
    return Boolean(row.profileId && access.profileIds.includes(row.profileId))
  }
  if (row.scope === 'group') {
    const ids = parseGroupProfileIds(row.groupProfileIds)
    return ids.some((id) => access.profileIds!.includes(id))
  }
  return false
}

async function listEventsForAccess(access: CrmAccessContext, whereExtra: Prisma.CrmEventWhereInput = {}) {
  if (access.profileIds === null) {
    return prisma.crmEvent.findMany({
      where: whereExtra,
      orderBy: { startsAt: 'desc' },
      take: 500,
    })
  }

  if (!access.profileIds.length) return []

  const [directRows, globalRows, groupRows] = await Promise.all([
    prisma.crmEvent.findMany({
      where: {
        ...whereExtra,
        profileId: { in: access.profileIds },
      },
      orderBy: { startsAt: 'desc' },
      take: 500,
    }),
    prisma.crmEvent.findMany({
      where: { ...whereExtra, scope: 'global' },
      orderBy: { startsAt: 'desc' },
      take: 200,
    }),
    prisma.crmEvent.findMany({
      where: { ...whereExtra, scope: 'group' },
      orderBy: { startsAt: 'desc' },
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
  return [...byId.values()].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
}

export async function listCrmEventsByStartsAtRange(
  access: CrmAccessContext,
  fromBound: Date,
  toBound: Date
): Promise<CrmEventRow[]> {
  return listEventsForAccess(access, {
    startsAt: { gte: fromBound, lte: toBound },
  })
}

async function assertCanManageEvent(access: CrmAccessContext, row: CrmEventRow) {
  if (!eventVisibleInAccess(row, access)) {
    throw new AppError(404, 'Event not found')
  }
}

const list = async (actor: CrmActor, access: CrmAccessContext, query: ListCrmEventsQuery) => {
  assertRequestedProfileInScope(access, query.profileId)

  const whereExtra: Prisma.CrmEventWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.scope ? { scope: query.scope } : {}),
    ...(query.profileId ? { profileId: query.profileId } : {}),
  }

  if (query.from || query.to) {
    whereExtra.startsAt = {
      ...(query.from ? { gte: computeStartsAt(query.from, '12:00 AM') } : {}),
      ...(query.to ? { lte: computeStartsAt(query.to, '11:59 PM') } : {}),
    }
  }

  const rows = await listEventsForAccess(access, whereExtra)
  const total = rows.length
  const skip = query.skip
  const limit = query.limit
  return {
    items: rows.slice(skip, skip + limit).map(serializeCrmEvent),
    total,
    skip,
    limit,
  }
}

const getOne = async (_actor: CrmActor, access: CrmAccessContext, id: string) => {
  const row = await prisma.crmEvent.findUnique({ where: { id } })
  if (!row) throw new AppError(404, 'Event not found')
  await assertCanManageEvent(access, row)
  return serializeCrmEvent(row)
}

const create = async (actor: CrmActor, access: CrmAccessContext, input: CreateCrmEventInput) => {
  const normalized = await normalizeCreateInput(input)
  await assertCanCreateEvent(actor, access, normalized)

  const status = input.status ?? 'Scheduled'
  const startsAt = computeStartsAt(input.date, input.time)
  const attachments = normalizeAttachments(input.attachments)
  const primaryProfileId = normalized.profileId
  const { emails: ownerEmails } = await resolveOwnerEmails(primaryProfileId)
  const recipientEmail = input.recipientEmail?.trim().toLowerCase() || ownerEmails[0] || null
  const recipientName = input.recipientName?.trim() || input.host.trim() || null

  let row = await prisma.crmEvent.create({
    data: {
      host: input.host,
      type: input.type,
      date: input.date,
      time: input.time,
      startsAt,
      status,
      scope: normalized.scope,
      profileId: primaryProfileId,
      groupProfileIds: normalized.groupProfileIds.length ? normalized.groupProfileIds : undefined,
      attachments: attachments.length ? attachments : undefined,
      recipientEmail,
      recipientName,
      createdById: actor.id,
    },
  })

  if (status === 'Scheduled') {
    try {
      const calendar = await calendarIntegrationService.createMeetingEvent({
        summary: calendarSummary(input.type, input.host),
        description: calendarDescription({
          host: input.host,
          type: input.type,
          attachments,
        }),
        date: input.date,
        time: input.time,
        attendeeEmail: recipientEmail || ownerEmails[0] || null,
      })

      if (calendar) {
        row = await prisma.crmEvent.update({
          where: { id: row.id },
          data: {
            googleEventId: calendar.eventId,
            meetLink: calendar.meetLink,
          },
        })
      }
    } catch (error) {
      logger.error('CRM event calendar sync failed on create', error)
    }
  }

  const actorUser = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true, email: true },
  })
  const actorLabel = actorUser?.name?.trim() || actorUser?.email || 'User'

  await writeAuditLog({
    action: 'CRM Event Created',
    details: `${input.type} with ${input.host} on ${input.date} at ${input.time}`,
    type: 'schedule',
    actor: actorLabel,
    actorId: actor.id,
    profileId: primaryProfileId,
    meta: {
      crmEventId: row.id,
      eventType: input.type,
      eventScope: normalized.scope,
      status,
      attachmentCount: String(attachments.length),
      calendarEventId: row.googleEventId || '',
    },
  })

  return serializeCrmEvent(row)
}

const update = async (actor: CrmActor, access: CrmAccessContext, id: string, input: UpdateCrmEventInput) => {
  const existing = await prisma.crmEvent.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Event not found')
  await assertCanManageEvent(access, existing)

  if (input.profileId) {
    assertRequestedProfileInScope(access, input.profileId)
    if (isStaffRole(actor.role)) {
      await assertAdminCanContactProfile(actor.id, input.profileId)
    }
  }

  const nextDate = input.date ?? existing.date
  const nextTime = input.time ?? existing.time
  const dateOrTimeChanged = Boolean(input.date || input.time)
  const nextAttachments =
    input.attachments !== undefined ? normalizeAttachments(input.attachments) : parseAttachments(existing.attachments)

  let row = await prisma.crmEvent.update({
    where: { id },
    data: {
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.time !== undefined ? { time: input.time } : {}),
      ...(dateOrTimeChanged ? { startsAt: computeStartsAt(nextDate, nextTime) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.groupProfileIds !== undefined ? { groupProfileIds: input.groupProfileIds } : {}),
      ...(input.attachments !== undefined ? { attachments: nextAttachments } : {}),
      ...(input.recipientEmail !== undefined
        ? { recipientEmail: input.recipientEmail?.trim().toLowerCase() || null }
        : {}),
      ...(input.recipientName !== undefined ? { recipientName: input.recipientName?.trim() || null } : {}),
    },
  })

  if (existing.googleEventId) {
    try {
      if (input.status === 'Cancelled' || input.status === 'Completed') {
        await calendarIntegrationService.deleteMeetingEvent(existing.googleEventId)
        if (input.status === 'Cancelled') {
          row = await prisma.crmEvent.update({
            where: { id },
            data: { googleEventId: null },
          })
        }
      } else if (
        input.date !== undefined ||
        input.time !== undefined ||
        input.host !== undefined ||
        input.type !== undefined ||
        input.attachments !== undefined
      ) {
        const updatedCal = await calendarIntegrationService.updateMeetingEvent(existing.googleEventId, {
          summary: calendarSummary(row.type, row.host),
          description: calendarDescription({
            host: row.host,
            type: row.type,
            attachments: nextAttachments,
            meetLink: row.meetLink,
          }),
          date: row.date,
          time: row.time,
        })
        if (updatedCal?.meetLink && updatedCal.meetLink !== row.meetLink) {
          row = await prisma.crmEvent.update({
            where: { id },
            data: {
              meetLink: updatedCal.meetLink,
              ...(updatedCal.eventId ? { googleEventId: updatedCal.eventId } : {}),
            },
          })
        } else if (updatedCal?.eventId && updatedCal.eventId !== existing.googleEventId) {
          row = await prisma.crmEvent.update({
            where: { id },
            data: { googleEventId: updatedCal.eventId },
          })
        }
      }
    } catch (error) {
      logger.error('CRM event calendar sync failed on update', error)
    }
  }

  const actorUser = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true, email: true },
  })
  const actorLabel = actorUser?.name?.trim() || actorUser?.email || 'User'
  const statusChanged = input.status && input.status !== existing.status

  await writeAuditLog({
    action: statusChanged
      ? input.status === 'Cancelled'
        ? 'CRM Event Cancelled'
        : input.status === 'Completed'
          ? 'CRM Event Completed'
          : 'CRM Event Updated'
      : 'CRM Event Updated',
    details: `${row.type} with ${row.host}${statusChanged ? ` marked ${input.status}` : ' was updated'}`,
    type: statusChanged ? (input.status === 'Cancelled' ? 'cancel' : 'status') : 'update',
    actor: actorLabel,
    actorId: actor.id,
    profileId: row.profileId,
    meta: { crmEventId: row.id, previousStatus: existing.status, status: input.status || existing.status },
  })

  return serializeCrmEvent(row)
}

const remove = async (actor: CrmActor, access: CrmAccessContext, id: string) => {
  const existing = await prisma.crmEvent.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Event not found')
  await assertCanManageEvent(access, existing)

  if (existing.googleEventId) {
    try {
      await calendarIntegrationService.deleteMeetingEvent(existing.googleEventId)
    } catch (error) {
      logger.error('CRM event calendar sync failed on delete', error)
    }
  }

  await prisma.crmEvent.delete({ where: { id } })

  const actorUser = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { name: true, email: true },
  })
  const actorLabel = actorUser?.name?.trim() || actorUser?.email || 'User'

  await writeAuditLog({
    action: 'CRM Event Deleted',
    details: `${existing.type} with ${existing.host} on ${existing.date} was deleted`,
    type: 'delete',
    actor: actorLabel,
    actorId: actor.id,
    profileId: existing.profileId,
    meta: { crmEventId: existing.id },
  })

  return { id }
}

const crmEventService = {
  list,
  getOne,
  create,
  update,
  remove,
  listCrmEventsByStartsAtRange,
  serializeCrmEvent,
  parseAttachments,
}

export default crmEventService
