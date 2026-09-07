import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import {
  assertRequestedProfileInScope,
  isProfileIdInCrmScope,
  stripClientOwnershipClaims,
  type CrmAccessContext,
  type CrmActor,
} from '../utils/crmScope'
import { prisma } from '../utils/prisma'

export const WORK_NOTE_STATUSES = ['not_started', 'in_progress', 'in_review', 'complete'] as const
export type WorkNoteStatus = (typeof WORK_NOTE_STATUSES)[number]

export type WorkNoteRow = {
  id: string
  title: string
  description: string | null
  status: WorkNoteStatus
  assigneeUserId: string | null
  assigneeName: string | null
  createdById: string
  createdByName: string | null
  profileId: string | null
  profileName: string | null
  leadRef: string | null
  startsAt: string | null
  dueAt: string | null
  remindAt: string | null
  ownerUserId: string | null
  companyUserId: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  isOverdue: boolean
}

const include = {
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  profile: { select: { id: true, name: true, slug: true } },
} as const

function isStatus(value: string): value is WorkNoteStatus {
  return (WORK_NOTE_STATUSES as readonly string[]).includes(value)
}

function mapRow(row: {
  id: string
  title: string
  description: string | null
  status: string
  assigneeUserId: string | null
  createdById: string
  profileId: string | null
  leadRef: string | null
  startsAt: Date | null
  dueAt: Date | null
  remindAt: Date | null
  ownerUserId: string | null
  companyUserId: string | null
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  assignee: { id: string; name: string | null; email: string } | null
  createdBy: { id: string; name: string | null; email: string }
  profile: { id: string; name: string; slug: string | null } | null
}): WorkNoteRow {
  const status = isStatus(row.status) ? row.status : 'not_started'
  const now = Date.now()
  const isOverdue = status !== 'complete' && Boolean(row.dueAt) && row.dueAt!.getTime() < now
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status,
    assigneeUserId: row.assigneeUserId,
    assigneeName: row.assignee?.name || row.assignee?.email || null,
    createdById: row.createdById,
    createdByName: row.createdBy.name || row.createdBy.email || null,
    profileId: row.profileId,
    profileName: row.profile?.name || null,
    leadRef: row.leadRef,
    startsAt: row.startsAt?.toISOString() || null,
    dueAt: row.dueAt?.toISOString() || null,
    remindAt: row.remindAt?.toISOString() || null,
    ownerUserId: row.ownerUserId,
    companyUserId: row.companyUserId,
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    isOverdue,
  }
}

function scopeWhere(actor: CrmActor, access: CrmAccessContext): Prisma.WorkNoteWhereInput {
  if (access.kind === 'admin') return {}
  if (access.kind === 'corporate') {
    return {
      OR: [
        { companyUserId: actor.id },
        { ownerUserId: actor.id },
        { createdById: actor.id },
        { assigneeUserId: actor.id },
        ...(access.profileIds?.length ? [{ profileId: { in: access.profileIds } }] : []),
      ],
    }
  }
  return {
    OR: [
      { ownerUserId: actor.id },
      { createdById: actor.id },
      { assigneeUserId: actor.id },
      ...(access.profileIds?.length ? [{ profileId: { in: access.profileIds } }] : []),
    ],
  }
}

async function assertInScope(actor: CrmActor, access: CrmAccessContext, id: string) {
  const row = await prisma.workNote.findUnique({ where: { id }, include })
  if (!row) throw new AppError(404, 'Work note not found')

  if (access.kind === 'admin') return row

  const allowed =
    row.createdById === actor.id ||
    row.assigneeUserId === actor.id ||
    row.ownerUserId === actor.id ||
    row.companyUserId === actor.id ||
    (row.profileId ? isProfileIdInCrmScope(access, row.profileId) : false)

  if (!allowed) throw new AppError(404, 'Work note not found')
  return row
}

export async function listWorkNotes(
  actor: CrmActor,
  access: CrmAccessContext,
  query: { status?: string; q?: string; skip?: number; limit?: number } = {}
) {
  const skip = Math.max(0, query.skip ?? 0)
  const limit = Math.min(200, Math.max(1, query.limit ?? 100))
  const where: Prisma.WorkNoteWhereInput = {
    ...scopeWhere(actor, access),
    ...(query.status && isStatus(query.status) ? { status: query.status } : {}),
    ...(query.q?.trim()
      ? {
          OR: [
            { title: { contains: query.q.trim(), mode: 'insensitive' } },
            { description: { contains: query.q.trim(), mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.workNote.count({ where }),
    prisma.workNote.findMany({
      where,
      orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
      include,
    }),
  ])

  return { items: rows.map(mapRow), total, skip, limit }
}

/** Work notes with startsAt inside [fromStart, toEnd] (inclusive calendar days). */
export async function listWorkNotesByStartsAtRange(
  actor: CrmActor,
  access: CrmAccessContext,
  fromIsoDate: string,
  toIsoDate: string
) {
  const from = new Date(`${fromIsoDate}T00:00:00.000Z`)
  const to = new Date(`${toIsoDate}T23:59:59.999Z`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError(400, 'Invalid from/to date range')
  }

  const rows = await prisma.workNote.findMany({
    where: {
      ...scopeWhere(actor, access),
      startsAt: { gte: from, lte: to },
    },
    orderBy: { startsAt: 'asc' },
    take: 500,
    include,
  })
  return rows.map(mapRow)
}

export async function getWorkNote(actor: CrmActor, access: CrmAccessContext, id: string) {
  const row = await assertInScope(actor, access, id)
  return mapRow(row)
}

export async function createWorkNote(actor: CrmActor, access: CrmAccessContext, rawBody: Record<string, unknown>) {
  const body = stripClientOwnershipClaims(rawBody)
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) throw new AppError(400, 'Title is required')

  const statusRaw = typeof body.status === 'string' ? body.status : 'not_started'
  if (!isStatus(statusRaw)) throw new AppError(400, 'Invalid status')

  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : ''
  if (profileId) assertRequestedProfileInScope(access, profileId)

  const assigneeUserId = typeof body.assigneeUserId === 'string' ? body.assigneeUserId.trim() : ''
  const leadRef = typeof body.leadRef === 'string' ? body.leadRef.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''

  const parseDate = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return null
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }

  const startsAt = parseDate(body.startsAt)
  const dueAt = parseDate(body.dueAt)
  if (!startsAt || !dueAt) {
    throw new AppError(400, 'Start and due dates are required')
  }
  const remindAt = parseDate(body.remindAt) || new Date(dueAt.getTime() - 30 * 60 * 1000)

  let companyUserId: string | null = null
  let ownerUserId: string | null = actor.id

  if (profileId) {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: { userId: true, companyUserId: true },
    })
    if (!profile) throw new AppError(404, 'Profile not found')
    ownerUserId = profile.userId || actor.id
    companyUserId = profile.companyUserId
  } else if (access.kind === 'corporate') {
    companyUserId = actor.id
  }

  const maxOrder = await prisma.workNote.aggregate({
    where: { ...scopeWhere(actor, access), status: statusRaw },
    _max: { sortOrder: true },
  })

  const row = await prisma.workNote.create({
    data: {
      title,
      description: description || null,
      status: statusRaw,
      sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      assigneeUserId: assigneeUserId || actor.id,
      createdById: actor.id,
      profileId: profileId || null,
      leadRef: leadRef || null,
      startsAt,
      dueAt,
      remindAt,
      ownerUserId,
      companyUserId,
    },
    include,
  })

  return mapRow(row)
}

export async function updateWorkNote(
  actor: CrmActor,
  access: CrmAccessContext,
  id: string,
  rawBody: Record<string, unknown>
) {
  await assertInScope(actor, access, id)
  const body = stripClientOwnershipClaims(rawBody)

  const data: Prisma.WorkNoteUpdateInput = {}

  if (typeof body.title === 'string') {
    const title = body.title.trim()
    if (!title) throw new AppError(400, 'Title is required')
    data.title = title
  }
  if (typeof body.description === 'string') data.description = body.description.trim() || null
  if (typeof body.status === 'string') {
    if (!isStatus(body.status)) throw new AppError(400, 'Invalid status')
    data.status = body.status
  }
  if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) {
    data.sortOrder = Math.max(0, Math.floor(body.sortOrder))
  }
  if (typeof body.assigneeUserId === 'string') {
    data.assignee = body.assigneeUserId.trim() ? { connect: { id: body.assigneeUserId.trim() } } : { disconnect: true }
  }
  if (typeof body.profileId === 'string') {
    const profileId = body.profileId.trim()
    if (profileId) {
      assertRequestedProfileInScope(access, profileId)
      data.profile = { connect: { id: profileId } }
    } else {
      data.profile = { disconnect: true }
    }
  }
  if (typeof body.leadRef === 'string') data.leadRef = body.leadRef.trim() || null

  const parseDate = (value: unknown) => {
    if (value === null) return null
    if (typeof value !== 'string' || !value.trim()) return undefined
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) throw new AppError(400, 'Invalid date')
    return d
  }

  if ('startsAt' in body) {
    const v = parseDate(body.startsAt)
    if (v === null || v === undefined) throw new AppError(400, 'Start date is required')
    data.startsAt = v
  }
  if ('dueAt' in body) {
    const v = parseDate(body.dueAt)
    if (v === null || v === undefined) throw new AppError(400, 'Due date is required')
    data.dueAt = v
  }
  if ('remindAt' in body) {
    const v = parseDate(body.remindAt)
    if (v !== undefined) data.remindAt = v
  }

  const row = await prisma.workNote.update({ where: { id }, data, include })
  return mapRow(row)
}

export async function reorderWorkNotes(
  actor: CrmActor,
  access: CrmAccessContext,
  items: { id: string; status: WorkNoteStatus; sortOrder: number }[]
) {
  const ids = items.map((item) => item.id)
  const uniqueIds = new Set(ids)
  if (uniqueIds.size !== ids.length) throw new AppError(400, 'Duplicate work note ids')

  const rows = await prisma.workNote.findMany({
    where: { id: { in: ids }, ...scopeWhere(actor, access) },
    select: { id: true },
  })
  if (rows.length !== ids.length) throw new AppError(404, 'Work note not found')

  await prisma.$transaction(
    items.map((item) =>
      prisma.workNote.update({
        where: { id: item.id },
        data: { status: item.status, sortOrder: item.sortOrder },
      })
    )
  )

  return { updated: items.length }
}

export async function deleteWorkNote(actor: CrmActor, access: CrmAccessContext, id: string) {
  await assertInScope(actor, access, id)
  await prisma.workNote.delete({ where: { id } })
  return { id, deleted: true }
}

export async function countForActor(_actor: CrmActor, access: CrmAccessContext) {
  return prisma.workNote.count({ where: scopeWhere(_actor, access) })
}

export async function countOpenForActor(actor: CrmActor, access: CrmAccessContext) {
  return prisma.workNote.count({
    where: {
      ...scopeWhere(actor, access),
      status: { not: 'complete' },
    },
  })
}

export async function countOverdueForActor(actor: CrmActor, access: CrmAccessContext) {
  return prisma.workNote.count({
    where: {
      ...scopeWhere(actor, access),
      status: { not: 'complete' },
      dueAt: { lt: new Date() },
    },
  })
}

export async function listUpcoming(actor: CrmActor, access: CrmAccessContext, limit = 5) {
  const now = new Date()
  const rows = await prisma.workNote.findMany({
    where: {
      ...scopeWhere(actor, access),
      status: { not: 'complete' },
      dueAt: { gte: now },
    },
    orderBy: { dueAt: 'asc' },
    take: limit,
    include,
  })
  return rows.map(mapRow)
}

export async function listOverdue(actor: CrmActor, access: CrmAccessContext, limit = 5) {
  const rows = await prisma.workNote.findMany({
    where: {
      ...scopeWhere(actor, access),
      status: { not: 'complete' },
      dueAt: { lt: new Date() },
    },
    orderBy: { dueAt: 'asc' },
    take: limit,
    include,
  })
  return rows.map(mapRow)
}

const workNoteService = {
  listWorkNotes,
  listWorkNotesByStartsAtRange,
  getWorkNote,
  createWorkNote,
  updateWorkNote,
  reorderWorkNotes,
  deleteWorkNote,
  countForActor,
  countOpenForActor,
  countOverdueForActor,
  listUpcoming,
  listOverdue,
  WORK_NOTE_STATUSES,
}

export default workNoteService
