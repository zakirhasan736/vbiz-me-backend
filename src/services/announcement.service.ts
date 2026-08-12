import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import { prisma } from '../utils/prisma'
import type {
  AnnouncementKind,
  AnnouncementStatus,
  AnnouncementTargetType,
  AnnouncementType,
  CreateAnnouncementInput,
  ListAnnouncementsQuery,
  UpdateAnnouncementInput,
} from '../zodValidation/announcement.zod'

type Actor = { id: string; email: string; name?: string | null }

type AnnouncementRow = {
  id: string
  kind: string
  type: string
  title: string
  body: string
  status: string
  targetType: string
  targetEmails: string[]
  startsAt: Date | null
  endsAt: Date | null
  meta: Prisma.JsonValue | null
  createdById: string | null
  createdAt: Date
  updatedAt: Date
}

function defaultTitle(type: AnnouncementType): string {
  if (type === 'warning') return 'Warning notice'
  if (type === 'success') return 'Success notice'
  return 'Info announcement'
}

function resolveKind(type: AnnouncementType, kind?: AnnouncementKind): AnnouncementKind {
  if (kind) return kind
  return type === 'warning' ? 'warning' : 'announcement'
}

function serializeAnnouncement(row: AnnouncementRow) {
  return {
    id: row.id,
    kind: row.kind as AnnouncementKind,
    type: row.type as AnnouncementType,
    title: row.title,
    body: row.body,
    status: row.status as AnnouncementStatus,
    targetType: row.targetType as AnnouncementTargetType,
    targetEmails: row.targetEmails,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    meta:
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
        ? (row.meta as Record<string, string>)
        : undefined,
    createdById: row.createdById ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function archiveActiveAllBanners(tx: Prisma.TransactionClient, exceptId?: string) {
  await tx.announcement.updateMany({
    where: {
      status: 'active',
      targetType: 'all',
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { status: 'archived' },
  })
}

/** Archive active specific-targeted notices that overlap emails or the same profileId in meta. */
async function archiveOverlappingSpecificBanners(
  tx: Prisma.TransactionClient,
  opts: { emails: string[]; profileId?: string; exceptId?: string }
) {
  const emailSet = new Set(opts.emails.map((e) => e.toLowerCase()))
  const activeSpecific = await tx.announcement.findMany({
    where: {
      status: 'active',
      targetType: 'specific',
      ...(opts.exceptId ? { id: { not: opts.exceptId } } : {}),
    },
    select: { id: true, targetEmails: true, meta: true },
  })

  const toArchive = activeSpecific
    .filter((row) => {
      if (row.targetEmails.some((e) => emailSet.has(e.toLowerCase()))) return true
      if (opts.profileId && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)) {
        const meta = row.meta as Record<string, unknown>
        return meta.profileId === opts.profileId
      }
      return false
    })
    .map((row) => row.id)

  if (toArchive.length) {
    await tx.announcement.updateMany({
      where: { id: { in: toArchive } },
      data: { status: 'archived' },
    })
  }
}

function profileIdFromMeta(
  meta: CreateAnnouncementInput['meta'] | Prisma.JsonValue | null | undefined
): string | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const profileId = (meta as Record<string, unknown>).profileId
  return typeof profileId === 'string' && profileId.trim() ? profileId.trim() : undefined
}

function normalizeEmails(emails?: string[]): string[] {
  if (!emails?.length) return []
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
}

const list = async (query: ListAnnouncementsQuery) => {
  const where: Prisma.AnnouncementWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
  }

  const [total, activeCount, rows] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.count({ where: { status: 'active' } }),
    prisma.announcement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: query.skip,
      take: query.limit,
    }),
  ])

  return {
    items: rows.map(serializeAnnouncement),
    total,
    skip: query.skip,
    limit: query.limit,
    activeCount,
  }
}

const getOne = async (id: string) => {
  const row = await prisma.announcement.findUnique({ where: { id } })
  if (!row) throw new AppError(404, 'Announcement not found')
  return serializeAnnouncement(row)
}

const create = async (actor: Actor, input: CreateAnnouncementInput) => {
  const type = input.type
  const kind = resolveKind(type, input.kind)
  const title = input.title?.trim() || defaultTitle(type)
  const targetType = input.targetType ?? 'all'
  const targetEmails = targetType === 'specific' ? normalizeEmails(input.targetEmails) : []
  const status = input.status ?? 'active'
  const profileId = profileIdFromMeta(input.meta)

  const row = await prisma.$transaction(async (tx) => {
    if (status === 'active') {
      if (targetType === 'all') {
        await archiveActiveAllBanners(tx)
      } else {
        await archiveOverlappingSpecificBanners(tx, { emails: targetEmails, profileId })
      }
    }

    return tx.announcement.create({
      data: {
        kind,
        type,
        title,
        body: input.body.trim(),
        status,
        targetType,
        targetEmails,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        meta: input.meta ?? undefined,
        createdById: actor.id,
      },
    })
  })

  await writeAuditLog({
    action:
      targetType === 'specific'
        ? status === 'active'
          ? 'Card Backoffice Notice Published'
          : 'Card Backoffice Notice Created'
        : status === 'active'
          ? 'Global Announcement Published'
          : 'Global Announcement Created',
    details: `Pushed [${type}] to ${
      targetType === 'all' ? 'all users' : `specific emails (${targetEmails.join(', ')})`
    }`,
    type: 'create',
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { announcementId: row.id, kind, type, status, targetType, profileId: profileId || '' },
  })

  return serializeAnnouncement(row)
}

const update = async (id: string, actor: Actor, input: UpdateAnnouncementInput) => {
  const existing = await prisma.announcement.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Announcement not found')

  const nextType = (input.type ?? existing.type) as AnnouncementType
  const nextKind = resolveKind(nextType, input.kind ?? (existing.kind as AnnouncementKind))
  const nextTargetType = (input.targetType ?? existing.targetType) as AnnouncementTargetType
  const nextEmails =
    input.targetEmails !== undefined
      ? nextTargetType === 'specific'
        ? normalizeEmails(input.targetEmails)
        : []
      : nextTargetType === 'specific'
        ? existing.targetEmails
        : []
  const nextStatus = (input.status ?? existing.status) as AnnouncementStatus

  if (nextTargetType === 'specific' && nextEmails.length === 0) {
    throw new AppError(400, 'At least one target email is required when targetType is specific')
  }

  const row = await prisma.$transaction(async (tx) => {
    if (nextStatus === 'active' && existing.status !== 'active') {
      if (nextTargetType === 'all') {
        await archiveActiveAllBanners(tx, id)
      } else {
        await archiveOverlappingSpecificBanners(tx, {
          emails: nextEmails,
          profileId: profileIdFromMeta(input.meta ?? existing.meta),
          exceptId: id,
        })
      }
    }

    return tx.announcement.update({
      where: { id },
      data: {
        ...(input.kind !== undefined || input.type !== undefined ? { kind: nextKind } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body.trim() } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.targetType !== undefined ? { targetType: input.targetType } : {}),
        ...(input.targetEmails !== undefined || input.targetType !== undefined ? { targetEmails: nextEmails } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.meta !== undefined ? { meta: input.meta ?? undefined } : {}),
      },
    })
  })

  await writeAuditLog({
    action: 'Global Announcement Updated',
    details: `${existing.title}: status → ${row.status}`,
    type: input.status !== undefined && input.status !== existing.status ? 'status' : 'update',
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { announcementId: row.id, status: row.status },
  })

  return serializeAnnouncement(row)
}

const remove = async (id: string, actor: Actor) => {
  const existing = await prisma.announcement.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Announcement not found')

  await prisma.announcement.delete({ where: { id } })

  await writeAuditLog({
    action: 'Global Announcement Deleted',
    details: existing.title,
    type: 'delete',
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { announcementId: id },
  })

  return { id }
}

const clearLive = async (actor: Actor) => {
  const result = await prisma.announcement.updateMany({
    where: { status: 'active', targetType: 'all' },
    data: { status: 'archived' },
  })

  await writeAuditLog({
    action: 'Global Banner Cleared',
    details: `Archived ${result.count} active global announcement(s)`,
    type: 'status',
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { clearedCount: result.count },
  })

  return { clearedCount: result.count }
}

const getActiveForUser = async (user: { email: string; role?: string }) => {
  const now = new Date()
  const email = user.email.trim().toLowerCase()

  const candidates = await prisma.announcement.findMany({
    where: {
      status: 'active',
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })

  const specific = candidates.find(
    (row) => row.targetType === 'specific' && row.targetEmails.map((e) => e.toLowerCase()).includes(email)
  )
  if (specific) return serializeAnnouncement(specific)

  const global = candidates.find((row) => row.targetType === 'all')
  return global ? serializeAnnouncement(global) : null
}

const announcementService = {
  list,
  getOne,
  create,
  update,
  remove,
  clearLive,
  getActiveForUser,
}

export default announcementService
