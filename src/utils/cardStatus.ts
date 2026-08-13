import type { Prisma } from '../../generated/prisma/client'
import { prisma } from './prisma'

export const CARD_LIFECYCLE_STATUSES = ['active', 'inactive', 'paused', 'suspended'] as const
export type CardLifecycleStatus = (typeof CARD_LIFECYCLE_STATUSES)[number]

export const CARD_STATUS_SEED_NAMES = ['active', 'inactive', 'paused', 'suspended', 'draft'] as const

const HIDDEN_PUBLIC_STATUS_NAMES = ['paused', 'suspended', 'inactive', 'draft'] as const

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

/** Public pages must not serve paused, suspended, inactive, or draft cards. */
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
