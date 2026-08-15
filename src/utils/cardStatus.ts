import type { Prisma } from '../../generated/prisma/client'
import { prisma } from './prisma'

export const CARD_LIFECYCLE_STATUSES = ['active', 'inactive', 'paused', 'suspended'] as const
export type CardLifecycleStatus = (typeof CARD_LIFECYCLE_STATUSES)[number]

export const CARD_STATUS_SEED_NAMES = ['active', 'inactive', 'paused', 'suspended', 'draft'] as const

const HIDDEN_PUBLIC_STATUS_NAMES = ['paused', 'suspended', 'inactive', 'draft'] as const
/** Blocked even when someone already has the /v/{slug} link. */
const BLOCKED_DIRECT_STATUS_NAMES = ['paused', 'suspended'] as const

export type AccountLockSnapshot = {
  statusName: string
  isPublic: boolean
  isDraft: boolean
}

export const normalizeCardStatusName = (name?: string | null): string =>
  String(name || '')
    .trim()
    .toLowerCase()

export const isCardLifecycleStatus = (value: string): value is CardLifecycleStatus =>
  (CARD_LIFECYCLE_STATUSES as readonly string[]).includes(value)

export const ensureStatusByName = async (name: string) => {
  const normalized = normalizeCardStatusName(name)
  const existing = await prisma.status.findFirst({
    where: { name: { equals: normalized, mode: 'insensitive' } },
  })
  if (existing) return existing
  return prisma.status.create({ data: { name: normalized } })
}

export const seedCardStatuses = async () => {
  for (const name of CARD_STATUS_SEED_NAMES) {
    await ensureStatusByName(name)
  }
}

/** Flags applied when an admin sets a card (or account-cascade) lifecycle status. */
export const lifecycleStatusFlags = (status: CardLifecycleStatus): { isDraft: boolean; isPublic: boolean } => {
  if (status === 'paused') return { isDraft: true, isPublic: false }
  if (status === 'suspended') return { isDraft: false, isPublic: false }
  if (status === 'active') return { isDraft: false, isPublic: true }
  return { isDraft: false, isPublic: false }
}

export const parseAccountLockSnapshot = (raw: unknown): AccountLockSnapshot | null => {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.statusName !== 'string') return null
  if (typeof obj.isPublic !== 'boolean' || typeof obj.isDraft !== 'boolean') return null
  return {
    statusName: normalizeCardStatusName(obj.statusName) || 'draft',
    isPublic: obj.isPublic,
    isDraft: obj.isDraft,
  }
}

/** Public directory / search — only fully published cards. */
export const publicVisibleWhere = (): Prisma.ProfileWhereInput => ({
  isPublic: true,
  isDraft: false,
  NOT: {
    status: {
      name: {
        in: [...HIDDEN_PUBLIC_STATUS_NAMES],
        mode: 'insensitive',
      },
    },
  },
})

/** Direct /v/{slug} links, wallet passes, and card sections. Drafts stay reachable by URL. */
export const publicReadableWhere = (): Prisma.ProfileWhereInput => ({
  NOT: {
    status: {
      name: {
        in: [...BLOCKED_DIRECT_STATUS_NAMES],
        mode: 'insensitive',
      },
    },
  },
})

export const slugEquals = (slug: string): Prisma.StringFilter => ({
  equals: slug.trim(),
  mode: 'insensitive',
})
