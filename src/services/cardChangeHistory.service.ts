import { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { areaLabelFor, isSnapshotRestorable, type CardChangeSnapshot } from '../utils/cardChangeHistory'
import { formatCardHealth, type CardHealthCounts } from '../utils/cardHealth'
import { prisma } from '../utils/prisma'
import type { CardChangeMeta } from '../utils/recordCardChange'
import { recordCardChange, recordCollectionChange } from '../utils/recordCardChange'
import { readCardHistoryFootprint } from './cardDailyBackup.service'
import profileService from './profile.service'

const MAX_LIST = 200

function readMeta(value: Prisma.JsonValue | null | undefined): CardChangeMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as CardChangeMeta
}

const serializeHistory = (row: {
  id: string
  area: string
  areaLabel: string
  action: string
  summary: string
  actorName: string
  actorRoleLabel: string
  device: string | null
  location: string | null
  snapshot: Prisma.JsonValue | null
  snapshotExpiresAt: Date | null
  meta?: Prisma.JsonValue | null
  restoredAt: Date | null
  createdAt: Date
}) => {
  const canRestore = isSnapshotRestorable(row.snapshot, row.snapshotExpiresAt)
  const fromRow = readMeta(row.meta)
  const fromSnapshot =
    row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
      ? readMeta((row.snapshot as { footprint?: Prisma.JsonValue; health?: CardHealthCounts }).footprint ?? null)
      : {}
  const snapshotHealth =
    row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
      ? (row.snapshot as { health?: CardHealthCounts }).health
      : undefined
  const health = fromRow.health || snapshotHealth || fromSnapshot.health
  const changeCode =
    fromRow.changeCode ||
    (row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
      ? String((row.snapshot as { changeCode?: string }).changeCode || '')
      : '') ||
    ''
  return {
    id: row.id,
    changeCode,
    area: row.area,
    areaLabel: row.areaLabel,
    action: row.action,
    summary: row.summary,
    actorName: row.actorName,
    actorRoleLabel: row.actorRoleLabel,
    actorEmail: fromRow.actorEmail || fromSnapshot.actorEmail || '',
    device: row.device || 'Unknown device',
    location: row.location || 'Unknown location',
    ip: fromRow.ip || fromSnapshot.ip || '',
    country: fromRow.country || fromSnapshot.country || '',
    countryName: fromRow.countryName || fromSnapshot.countryName || '',
    health: health || null,
    healthLabel: fromRow.healthLabel || formatCardHealth(health) || '',
    syncSourceProfileId: fromRow.syncSourceProfileId || '',
    syncSourceSlug: fromRow.syncSourceSlug || '',
    syncSourceName: fromRow.syncSourceName || '',
    syncScope: fromRow.syncScope || '',
    syncTargetCount: fromRow.syncTargetCount ?? null,
    canRestore,
    restoreExpired: Boolean(row.snapshotExpiresAt) && !canRestore,
    restoredAt: row.restoredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.snapshotExpiresAt?.toISOString() ?? null,
  }
}

export async function expireCardChangeSnapshots(now = new Date()): Promise<number> {
  const result = await prisma.cardChangeHistory.updateMany({
    where: {
      snapshot: { not: Prisma.DbNull },
      snapshotExpiresAt: { lte: now },
    },
    data: { snapshot: Prisma.DbNull },
  })
  return result.count
}

const listCardChangeHistory = async (profileId: string, userId: string, role: string, skip = 0, limit = 50) => {
  await profileService.getOwnedLite(profileId, userId, role)
  await expireCardChangeSnapshots().catch(() => undefined)
  const take = Math.min(MAX_LIST, Math.max(1, limit))
  const start = Math.max(0, skip)
  const [rows, total, footprint] = await Promise.all([
    prisma.cardChangeHistory.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
      skip: start,
      take,
    }),
    prisma.cardChangeHistory.count({ where: { profileId } }),
    readCardHistoryFootprint(profileId),
  ])
  return {
    items: rows.map(serializeHistory),
    total,
    skip: start,
    limit: take,
    inventory: footprint.inventory,
    backups: footprint.backups,
  }
}

const COLLECTION_RESTORE_MAP: Record<string, (item: Record<string, unknown>) => Record<string, unknown>> = {
  education: (item) => ({
    institute: item.institute,
    degree: item.degree,
    fromDate: item.fromDate ?? null,
    toDate: item.toDate ?? null,
    tillNow: Boolean(item.tillNow),
  }),
  experiences: (item) => ({
    company: item.company,
    jobTitle: item.jobTitle,
    description: item.description,
    fromDate: item.fromDate ?? null,
    toDate: item.toDate ?? null,
    tillNow: Boolean(item.tillNow),
  }),
  services: (item) => ({
    title: item.title,
    description: item.description,
    imageUrl: item.imageUrl ?? item.featuredImage,
    reviewUrl: item.reviewUrl ?? item.url,
    status: item.status ?? 1,
  }),
  portfolios: (item) => ({
    title: item.title,
    description: item.description,
    featuredImage: item.featuredImage ?? item.imageUrl,
    url: item.url,
    status: item.status ?? '1',
    attachmentUrl: null,
    attachmentName: null,
  }),
  reviews: (item) => ({
    author: item.author,
    text: item.text,
    rating: item.rating ?? 5,
    imageUrl: item.imageUrl || '',
    reviewUrl: item.reviewUrl ?? item.url ?? '',
    status: item.status ?? 1,
  }),
  skillTags: (item) => ({
    type: item.type,
    name: item.name ?? item.skill,
  }),
  socialLinks: (item) => ({
    name: item.name,
    url: item.url,
  }),
}

const restoreCollection = async (profileId: string, userId: string, role: string, kind: string, items: unknown) => {
  const mapItem = COLLECTION_RESTORE_MAP[kind]
  if (!mapItem) throw new AppError(400, `This ${areaLabelFor(kind)} change cannot be restored`)
  const rows = Array.isArray(items)
    ? items.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    : []
  if (rows.length === 0) {
    throw new AppError(400, 'This snapshot would erase the current list. Restore is blocked to protect live card data.')
  }
  await profileService.replaceCollection(profileId, userId, role, kind as never, rows, mapItem)
}

const restoreSettings = async (profileId: string, userId: string, role: string, snapshot: CardChangeSnapshot) => {
  const settings: Record<string, string> = {}
  for (const [key, value] of Object.entries(snapshot.settings || {})) {
    if (typeof value === 'string') settings[key] = value
  }
  const profileFields = snapshot.profileFields || {}
  await profileService.update(profileId, userId, role, {
    ...profileFields,
    ...(Object.keys(settings).length ? { settings } : {}),
  })
}

const restoreAboutMe = async (profileId: string, userId: string, role: string, snapshot: CardChangeSnapshot) => {
  const about = snapshot.aboutMe
  if (!about || typeof about !== 'object') {
    await profileService.deleteAboutMe(profileId, userId, role)
    return
  }
  const row = about as Record<string, unknown>
  await profileService.upsertAboutMe(profileId, userId, role, {
    title: typeof row.title === 'string' ? row.title : undefined,
    description: typeof row.description === 'string' ? row.description : undefined,
    featuredMediaUrl: typeof row.featuredMediaUrl === 'string' ? row.featuredMediaUrl : undefined,
    status:
      typeof row.status === 'string' ? row.status : typeof row.status === 'number' ? String(row.status) : undefined,
  })
}

const restoreCardChange = async (profileId: string, historyId: string, userId: string, role: string) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  await expireCardChangeSnapshots().catch(() => undefined)
  const row = await prisma.cardChangeHistory.findFirst({
    where: { id: historyId, profileId },
  })
  if (!row) throw new AppError(404, 'History entry not found')
  if (!isSnapshotRestorable(row.snapshot, row.snapshotExpiresAt)) {
    throw new AppError(410, 'This change can no longer be restored. The 72-hour data life has expired.')
  }
  const snapshot = row.snapshot as CardChangeSnapshot
  if (!snapshot || snapshot.version !== 1) throw new AppError(400, 'This history snapshot cannot be restored')

  if (snapshot.kind === 'collection' && snapshot.collectionKind) {
    await restoreCollection(profileId, userId, role, snapshot.collectionKind, snapshot.items)
  } else if (snapshot.kind === 'settings') {
    await restoreSettings(profileId, userId, role, snapshot)
  } else if (snapshot.kind === 'aboutMe') {
    await restoreAboutMe(profileId, userId, role, snapshot)
  } else {
    throw new AppError(400, 'This change type cannot be restored yet')
  }

  await prisma.cardChangeHistory.update({
    where: { id: row.id },
    data: { restoredAt: new Date() },
  })
  return { restored: true as const, id: row.id }
}

const cardChangeHistoryService = {
  list: listCardChangeHistory,
  restore: restoreCardChange,
  expireSnapshots: expireCardChangeSnapshots,
  record: recordCardChange,
  recordCollectionChange,
}

export default cardChangeHistoryService
