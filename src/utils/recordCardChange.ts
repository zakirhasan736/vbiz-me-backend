import type { Prisma } from '../../generated/prisma/client'
import { toApiRole } from '../constants/userRole'
import {
  areaLabelFor,
  formatChangeLocation,
  getCardChangeActor,
  parseDeviceLabel,
  resolveActorRoleLabel,
  snapshotExpiresAt,
  summarizeCollectionChange,
  type CardChangeSnapshot,
} from './cardChangeHistory'
import logger from './logger'
import { prisma } from './prisma'

export async function recordCardChange(input: {
  profileId: string
  area: string
  action: string
  summary: string
  snapshot: CardChangeSnapshot | null
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
    const actorRoleLabel = resolveActorRoleLabel({
      actorRole: actor.role || (user?.role ? toApiRole(user.role) : 'vcard-owner'),
      actorUserId: actor.userId,
      profileUserId: profile?.userId,
      profileCompanyUserId: profile?.companyUserId,
    })
    await prisma.cardChangeHistory.create({
      data: {
        profileId: input.profileId,
        area: input.area,
        areaLabel: areaLabelFor(input.area),
        action: input.action,
        summary: input.summary,
        actorId: actor.userId,
        actorName,
        actorRoleLabel,
        device: parseDeviceLabel(actor.userAgent),
        location: formatChangeLocation(actor.ip, actor.country),
        userAgent: actor.userAgent || null,
        snapshot: input.snapshot ? (input.snapshot as Prisma.InputJsonValue) : undefined,
        snapshotExpiresAt: input.snapshot ? snapshotExpiresAt() : null,
      },
    })
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
