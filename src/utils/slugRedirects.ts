import { publicReadableWhere, slugEquals } from './cardStatus'
import logger from './logger'
import { prisma } from './prisma'
import { isSlugRename, normalizeSlug } from './slugRename'

export { isSlugRename, normalizeSlug }

/**
 * Remember the old address so /vCard/{oldSlug} can 301 to the new one. The new slug is
 * removed from the alias table in case it used to be an old address of this or another card.
 * Best-effort: a failure here must never block saving the card.
 */
export async function recordSlugRename(profileId: string, oldSlug: string | null | undefined, newSlug: string) {
  if (!isSlugRename(oldSlug, newSlug)) return
  const from = normalizeSlug(oldSlug)
  const to = normalizeSlug(newSlug)
  try {
    await prisma.$transaction([
      prisma.profileSlugRedirect.deleteMany({ where: { oldSlug: to } }),
      prisma.profileSlugRedirect.upsert({
        where: { oldSlug: from },
        create: { oldSlug: from, profileId },
        update: { profileId },
      }),
    ])
  } catch (error) {
    logger.warn('Could not record slug redirect', {
      profileId,
      from,
      to,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** A slug that is now live on a card can no longer redirect elsewhere. */
export async function releaseSlugAlias(slug: string | null | undefined) {
  const value = normalizeSlug(slug)
  if (!value) return
  await prisma.profileSlugRedirect.deleteMany({ where: { oldSlug: value } }).catch(() => undefined)
}

/**
 * Current public slug for an old address, or null. Only resolves to cards that are
 * publicly readable, so unpublished or deleted cards still return 404.
 */
export async function resolveSlugRedirect(slug: string): Promise<string | null> {
  const value = normalizeSlug(slug)
  if (!value) return null
  const redirect = await prisma.profileSlugRedirect.findUnique({
    where: { oldSlug: value },
    select: { profileId: true },
  })
  if (!redirect) return null
  const profile = await prisma.profile.findFirst({
    where: { id: redirect.profileId, slug: { not: null }, ...publicReadableWhere() },
    select: { slug: true },
  })
  const target = profile?.slug?.trim()
  if (!target || normalizeSlug(target) === value) return null
  // A different live card that now owns this slug always wins over an old alias.
  const liveOwner = await prisma.profile.findFirst({ where: { slug: slugEquals(value) }, select: { id: true } })
  if (liveOwner && liveOwner.id !== redirect.profileId) return null
  return target
}
