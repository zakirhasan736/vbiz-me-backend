import { Prisma } from '../../generated/prisma/client'
import { toApiRole } from '../constants/userRole'
import {
  areaLabelFor,
  CARD_CHANGE_SNAPSHOT_KEEP,
  countryNameFromCode,
  formatChangeLocation,
  generateChangeCode,
  getCardChangeActor,
  parseDeviceLabel,
  resolveActorRoleLabel,
  snapshotExpiresAt,
  summarizeCollectionChange,
  type CardChangeSnapshot,
} from './cardChangeHistory'
import { collectCardHealth, formatCardHealth, type CardHealthCounts } from './cardHealth'
import logger from './logger'
import { prisma } from './prisma'

export type CardChangeMeta = {
  health?: CardHealthCounts
  healthLabel?: string
  actorEmail?: string
  ip?: string
  country?: string
  countryName?: string
  /** Short 7-digit change id (e.g. 4829173) for restore / support. */
  changeCode?: string
  /** When this row was caused by linked corporate sync from another card. */
  syncSourceProfileId?: string
  syncSourceSlug?: string
  syncSourceName?: string
  syncScope?: string
  syncTargetCount?: number
}

async function pruneOldCardChangeSnapshots(profileId: string): Promise<void> {
  const overflow = await prisma.cardChangeHistory.findMany({
    where: { profileId, snapshot: { not: Prisma.DbNull } },
    orderBy: { createdAt: 'desc' },
    skip: CARD_CHANGE_SNAPSHOT_KEEP,
    select: { id: true },
  })
  if (!overflow.length) return
  await prisma.cardChangeHistory.updateMany({
    where: { id: { in: overflow.map((row) => row.id) } },
    data: { snapshot: Prisma.DbNull, snapshotExpiresAt: null },
  })
}

export async function recordCardChange(input: {
  profileId: string
  area: string
  action: string
  summary: string
  snapshot: CardChangeSnapshot | null
  meta?: Partial<CardChangeMeta>
}): Promise<void> {
  try {
    const actor = getCardChangeActor()
    if (!actor) return
    const [user, profile] = await Promise.all([
      prisma.user.findUnique({
        where: { id: actor.userId },
        select: { id: true, name: true, email: true, role: true },
      }),
      prisma.profile.findUnique({
        where: { id: input.profileId },
        select: { userId: true, companyUserId: true },
      }),
    ])
    const actorName = user?.name?.trim() || user?.email || actor.email || 'Unknown user'
    const actorEmail = user?.email?.trim() || actor.email || ''
    const actorRoleLabel = resolveActorRoleLabel({
      actorRole: actor.role || (user?.role ? toApiRole(user.role) : 'vcard-owner'),
      actorUserId: actor.userId,
      profileUserId: profile?.userId,
      profileCompanyUserId: profile?.companyUserId,
    })
    const health = await collectCardHealth(input.profileId)
    const changeCode = generateChangeCode()
    const meta: CardChangeMeta = {
      health,
      healthLabel: formatCardHealth(health),
      actorEmail: actorEmail || undefined,
      ip: actor.ip,
      country: actor.country,
      countryName: countryNameFromCode(actor.country) || undefined,
      changeCode,
      ...input.meta,
    }
    const snapshotPayload = input.snapshot
      ? ({ ...input.snapshot, health, footprint: meta, changeCode } as Prisma.InputJsonValue)
      : undefined
    const data = {
      profileId: input.profileId,
      area: input.area,
      areaLabel: areaLabelFor(input.area),
      action: input.action,
      summary: `[#${changeCode}] ${input.summary}`,
      actorId: actor.userId,
      actorName,
      actorRoleLabel,
      device: parseDeviceLabel(actor.userAgent),
      location: formatChangeLocation(actor.ip, actor.country),
      userAgent: actor.userAgent || null,
      snapshot: snapshotPayload,
      snapshotExpiresAt: input.snapshot ? snapshotExpiresAt() : null,
      meta: meta as Prisma.InputJsonValue,
    }
    try {
      await prisma.cardChangeHistory.create({ data })
    } catch {
      const withoutMeta = { ...data }
      delete (withoutMeta as { meta?: unknown }).meta
      await prisma.cardChangeHistory.create({ data: withoutMeta })
    }
    if (input.snapshot) {
      await pruneOldCardChangeSnapshots(input.profileId).catch(() => undefined)
    }
  } catch (error) {
    logger.warn('card change history record failed', error)
  }
}

export async function recordCollectionChange(input: {
  profileId: string
  kind: string
  beforeItems: unknown[]
  afterCount: number
}): Promise<void> {
  const beforeCount = input.beforeItems.length
  if (beforeCount === 0 && input.afterCount === 0) return
  const { action, summary } = summarizeCollectionChange(beforeCount, input.afterCount)
  await recordCardChange({
    profileId: input.profileId,
    area: input.kind,
    action,
    summary,
    snapshot: {
      version: 1,
      kind: 'collection',
      collectionKind: input.kind,
      items: input.beforeItems,
    },
  })
}
