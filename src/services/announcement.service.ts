import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { assertAdminCanContactProfile } from '../utils/adminOutreachAccess'
import { writeAuditLog } from '../utils/auditLog'
import { prisma } from '../utils/prisma'
import type { PublicViewerIdentity } from '../utils/publicVisitor'
import type {
  AnnouncementKind,
  AnnouncementStatus,
  AnnouncementTargetType,
  AnnouncementType,
  CreateAnnouncementInput,
  ListAnnouncementsQuery,
  UpdateAnnouncementInput,
} from '../zodValidation/announcement.zod'
import pushService from './push.service'

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
      if (isBirthdayNotice(row.meta)) return false
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

function metaRecord(
  meta: CreateAnnouncementInput['meta'] | Prisma.JsonValue | null | undefined
): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  return meta as Record<string, unknown>
}

function profileIdFromMeta(
  meta: CreateAnnouncementInput['meta'] | Prisma.JsonValue | null | undefined
): string | undefined {
  const profileId = metaRecord(meta)?.profileId
  return typeof profileId === 'string' && profileId.trim() ? profileId.trim() : undefined
}

function isInboxOnly(meta: CreateAnnouncementInput['meta'] | Prisma.JsonValue | null | undefined): boolean {
  return metaRecord(meta)?.channel === 'inbox'
}

function isBirthdayNotice(meta: CreateAnnouncementInput['meta'] | Prisma.JsonValue | null | undefined): boolean {
  return metaRecord(meta)?.kind === 'birthday'
}

const LOCK_ACTIONS = new Set(['paused', 'suspended'])

/** Archive pause/suspend banners for a user account or a specific card. */
const archiveLockNotices = async (opts: { userId?: string; profileId?: string }) => {
  const userId = opts.userId?.trim()
  const profileId = opts.profileId?.trim()
  if (!userId && !profileId) return { archivedCount: 0 }

  const activeSpecific = await prisma.announcement.findMany({
    where: { status: 'active', targetType: 'specific' },
    select: { id: true, meta: true },
  })

  const toArchive = activeSpecific
    .filter((row) => {
      const meta = metaRecord(row.meta)
      if (!meta) return false
      const action = typeof meta.action === 'string' ? meta.action : ''
      if (!LOCK_ACTIONS.has(action)) return false
      if (userId && meta.userId === userId) return true
      if (profileId && meta.profileId === profileId) return true
      return false
    })
    .map((row) => row.id)

  if (toArchive.length) {
    await prisma.announcement.updateMany({
      where: { id: { in: toArchive } },
      data: { status: 'archived' },
    })
  }

  return { archivedCount: toArchive.length }
}

function normalizeEmails(emails?: string[]): string[] {
  if (!emails?.length) return []
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
}

type ViewerAnnouncementKind = 'global' | 'team_notice'

async function isAnnouncementSuppressed(
  kind: ViewerAnnouncementKind,
  announcementId: string,
  profileId: string,
  viewer?: PublicViewerIdentity
): Promise<boolean> {
  if (!viewer?.browserKey) return false

  const now = new Date()
  type ViewerStateRow = { dismissedAt: Date | null; suppressUntil: Date | null } | null
  const viewerState = (
    prisma as unknown as {
      announcementViewerState: { findFirst: (args: unknown) => Promise<ViewerStateRow> }
    }
  ).announcementViewerState

  const row = await viewerState.findFirst({
    where: {
      announcementType: kind,
      announcementId,
      profileId,
      OR: [{ browserKey: viewer.browserKey }, ...(viewer.visitorId ? [{ visitorId: viewer.visitorId }] : [])],
    },
    orderBy: { updatedAt: 'desc' },
  })

  if (!row) return false
  if (row.dismissedAt) return true
  if (row.suppressUntil && row.suppressUntil > now) return true
  return false
}

async function writeAnnouncementViewerState(opts: {
  kind: ViewerAnnouncementKind
  announcementId: string
  profileId: string
  viewer: PublicViewerIdentity
  dismissedAt?: Date | null
  suppressUntil?: Date | null
}) {
  const viewerState = (
    prisma as unknown as { announcementViewerState: { upsert: (args: unknown) => Promise<unknown> } }
  ).announcementViewerState

  await viewerState.upsert({
    where: {
      announcementType_announcementId_browserKey: {
        announcementType: opts.kind,
        announcementId: opts.announcementId,
        browserKey: opts.viewer.browserKey,
      },
    },
    create: {
      announcementType: opts.kind,
      announcementId: opts.announcementId,
      profileId: opts.profileId,
      visitorId: opts.viewer.visitorId,
      browserKey: opts.viewer.browserKey,
      dismissedAt: opts.dismissedAt ?? null,
      suppressUntil: opts.suppressUntil ?? null,
    },
    update: {
      profileId: opts.profileId,
      visitorId: opts.viewer.visitorId ?? undefined,
      dismissedAt: opts.dismissedAt ?? null,
      suppressUntil: opts.suppressUntil ?? null,
    },
  })
}

const list = async (query: ListAnnouncementsQuery) => {
  const where: Prisma.AnnouncementWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    // System birthday wishes are owner-inbox only — hide from admin announcements UI.
    NOT: { meta: { path: ['kind'], equals: 'birthday' } },
  }

  const [total, activeCount, rows] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.count({
      where: {
        status: 'active',
        NOT: { meta: { path: ['kind'], equals: 'birthday' } },
      },
    }),
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

  if (profileId) {
    await assertAdminCanContactProfile(actor.id, profileId)
  }

  const inboxOnly = isInboxOnly(input.meta)

  const row = await prisma.$transaction(async (tx) => {
    if (status === 'active' && !inboxOnly) {
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

  // Background: if admin requested push delivery (via meta), send push notifications.
  try {
    const meta = input.meta ?? {}
    const wantsPush =
      typeof meta === 'object' &&
      meta !== null &&
      ('sendPush' in meta || (meta.sendTo && String(meta.sendTo).includes('push')))

    if (wantsPush) {
      void (async () => {
        try {
          const profileIds = new Set<string>()

          // If targeted to specific emails, resolve profiles by email
          if (targetType === 'specific' && targetEmails.length) {
            for (const e of targetEmails) {
              const p = await prisma.profile.findFirst({ where: { email: e }, select: { id: true } })
              if (p) profileIds.add(p.id)
            }
          }

          // If meta contains a profileId (explicit card owner), include it
          if (profileId) profileIds.add(profileId)

          const metaUserId = metaRecord(meta)?.userId
          if (typeof metaUserId === 'string' && metaUserId.trim()) {
            const owned = await prisma.profile.findMany({
              where: { OR: [{ userId: metaUserId }, { companyUserId: metaUserId }] },
              select: { id: true },
            })
            for (const p of owned) profileIds.add(p.id)
          }

          // If global, send to all profiles that have active push subscriptions
          if (targetType === 'all') {
            const subs = await prisma.pushSubscription.findMany({
              where: { isActive: true },
              select: { profileId: true },
            })
            for (const s of subs) profileIds.add(s.profileId)
          }

          const payloadPartial = {
            title: row.title || defaultTitle(row.type as AnnouncementType),
            body: row.body,
            type: 'announcement_updates',
          }

          for (const pid of profileIds) {
            await pushService.sendToProfile(pid, payloadPartial)
          }
        } catch {
          /* swallow background errors */
        }
      })()
    }
  } catch {
    /* ignore */
  }

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

  const profileId = profileIdFromMeta(input.meta ?? existing.meta)
  if (profileId) {
    await assertAdminCanContactProfile(actor.id, profileId)
  }

  const inboxOnly = isInboxOnly(input.meta ?? existing.meta)

  const row = await prisma.$transaction(async (tx) => {
    if (nextStatus === 'active' && existing.status !== 'active' && !inboxOnly) {
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

  const matchesEmail = (row: AnnouncementRow) =>
    row.targetType === 'specific' && row.targetEmails.map((e) => e.toLowerCase()).includes(email)

  const inbox = candidates.filter(matchesEmail).map(serializeAnnouncement)

  const bannerRow =
    candidates.find((row) => !isInboxOnly(row.meta) && matchesEmail(row)) ??
    candidates.find((row) => row.targetType === 'all' && !isInboxOnly(row.meta))

  return {
    banner: bannerRow ? serializeAnnouncement(bannerRow) : null,
    inbox,
  }
}

function isShowPublic(meta: CreateAnnouncementInput['meta'] | Prisma.JsonValue | null | undefined): boolean {
  return metaRecord(meta)?.showPublic === '1'
}

const getActiveForPublicCard = async (profileId: string, viewer?: PublicViewerIdentity) => {
  const id = profileId.trim()
  if (!id) return null

  const profile = await prisma.profile.findUnique({
    where: { id },
    select: { id: true, email: true },
  })
  if (!profile) return null

  const email = (profile.email ?? '').trim().toLowerCase()
  const now = new Date()

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

  const matchesTarget = (row: AnnouncementRow) => {
    if (row.targetType === 'all') return true
    if (profileIdFromMeta(row.meta) === id) return true
    if (row.targetType === 'specific' && email) {
      return row.targetEmails.map((e) => e.toLowerCase()).includes(email)
    }
    return false
  }

  const bannerRow = candidates.find((row) => isShowPublic(row.meta) && !isInboxOnly(row.meta) && matchesTarget(row))
  if (!bannerRow) return null
  if (await isAnnouncementSuppressed('global', bannerRow.id, id, viewer)) return null
  return serializeAnnouncement(bannerRow)
}

const dismissPublicAnnouncement = async (opts: {
  profileId: string
  announcementId: string
  viewer: PublicViewerIdentity
}) => {
  const profileId = opts.profileId.trim()
  const announcementId = opts.announcementId.trim()
  if (!profileId || !announcementId) throw new AppError(400, 'profileId and announcementId are required')

  const announcement = await prisma.announcement.findFirst({
    where: { id: announcementId, status: 'active' },
    select: { id: true },
  })
  if (!announcement) throw new AppError(404, 'Announcement not found')

  await writeAnnouncementViewerState({
    kind: 'global',
    announcementId,
    profileId,
    viewer: opts.viewer,
    dismissedAt: new Date(),
    suppressUntil: null,
  })

  return { id: announcementId, dismissed: true }
}

/** Remove the owner-inbox companion created by an admin card notice. */
const archiveCardNotices = async (profileId: string) => {
  const active = await prisma.announcement.findMany({
    where: { status: 'active', targetType: 'specific' },
    select: { id: true, meta: true },
  })
  const ids = active
    .filter((row) => {
      const meta = metaRecord(row.meta)
      return meta?.source === 'card_notice' && meta.profileId === profileId
    })
    .map((row) => row.id)
  if (ids.length) {
    await prisma.announcement.updateMany({ where: { id: { in: ids } }, data: { status: 'archived' } })
  }
  return { archivedCount: ids.length }
}

const announcementService = {
  list,
  getOne,
  create,
  update,
  remove,
  clearLive,
  archiveLockNotices,
  archiveCardNotices,
  getActiveForUser,
  getActiveForPublicCard,
  dismissPublicAnnouncement,
}

export default announcementService
