import { prisma } from './prisma'
import { isPrismaSchemaDrift } from './prismaErrors'

type GalleryLike = {
  title?: string | null
  legacyPostId?: number | null
  legacyPortfolioId?: number | null
  featuredImage?: string | null
}

type PortfolioLike = {
  legacyId?: number | null
  title?: string | null
  imageUrl?: string | null
}

const titleKey = (value?: string | null) =>
  String(value || '')
    .trim()
    .toLowerCase()

const mediaUrl = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

/** Copy featured URLs from legacy Portfolio rows onto Gallery rows that only have titles. */
export function fillMissingGalleryMedia<G extends GalleryLike, P extends PortfolioLike>(
  galleries: G[],
  portfolios: P[]
): G[] {
  if (!galleries.length || !portfolios.length) return galleries

  const byLegacyId = new Map<number, P>()
  const titleBuckets = new Map<string, P[]>()

  for (const row of portfolios) {
    if (typeof row.legacyId === 'number' && !byLegacyId.has(row.legacyId)) {
      byLegacyId.set(row.legacyId, row)
    }

    const key = titleKey(row.title)
    if (!key) continue

    const bucket = titleBuckets.get(key) || []
    bucket.push(row)
    titleBuckets.set(key, bucket)
  }

  return galleries.map((gallery, index) => {
    const existing = mediaUrl(gallery.featuredImage)
    if (existing) {
      return existing === gallery.featuredImage ? gallery : { ...gallery, featuredImage: existing }
    }

    const linkedLegacyId =
      typeof gallery.legacyPortfolioId === 'number'
        ? gallery.legacyPortfolioId
        : typeof gallery.legacyPostId === 'number'
          ? gallery.legacyPostId
          : null

    let legacy = linkedLegacyId !== null ? byLegacyId.get(linkedLegacyId) : undefined

    if (!legacy) {
      const key = titleKey(gallery.title)
      const matches = key ? titleBuckets.get(key) || [] : []

      // Prefer a unique title match. Duplicate titles (common in the editor) are
      // ambiguous, so fall through to sort-order / index alignment with Portfolio.
      if (matches.length === 1) {
        legacy = matches[0]
      }
    }

    if (!legacy) {
      legacy = portfolios[index]
    }

    const fromLegacy = mediaUrl(legacy?.imageUrl)
    if (!fromLegacy) {
      return existing === gallery.featuredImage ? gallery : { ...gallery, featuredImage: existing }
    }

    return {
      ...gallery,
      featuredImage: fromLegacy,
    }
  })
}

export function galleryHasMedia(rows: Array<{ featuredImage?: string | null }>): boolean {
  return rows.some((row) => Boolean(mediaUrl(row.featuredImage)))
}

export type LiveGalleryRow = {
  id: string
  profileId: string
  title: string | null
  description: string | null
  url: string | null
  featuredImage: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  status: string
  sortOrder: number
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
  legacyPostId: number | null
  metas: unknown
}

const GALLERY_SAFE_SELECT = {
  id: true,
  profileId: true,
  title: true,
  description: true,
  url: true,
  featuredImage: true,
  attachmentUrl: true,
  attachmentName: true,
  status: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  legacyPostId: true,
} as const

const withGalleryDefaults = (row: {
  id: string
  profileId: string
  title: string | null
  description: string | null
  url: string | null
  featuredImage: string | null
  attachmentUrl?: string | null
  attachmentName?: string | null
  status: string
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  legacyPostId?: number | null
}): LiveGalleryRow => ({
  ...row,
  attachmentUrl: row.attachmentUrl ?? null,
  attachmentName: row.attachmentName ?? null,
  deletedAt: null,
  legacyPostId: row.legacyPostId ?? null,
  metas: null,
})

/** Load Gallery rows with legacyPostId while keeping schema-drift fallbacks for older optional columns. */
export async function listGalleriesForProfile(profileId: string, take = 200): Promise<LiveGalleryRow[]> {
  const limit = Math.min(200, Math.max(1, take))
  try {
    const rows = await prisma.gallery.findMany({
      where: { profileId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: limit,
      select: GALLERY_SAFE_SELECT,
    })
    return rows.map(withGalleryDefaults)
  } catch (error) {
    if (!isPrismaSchemaDrift(error)) throw error
  }
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        profileId: string
        title: string | null
        description: string | null
        url: string | null
        featuredImage: string | null
        attachmentUrl: string | null
        attachmentName: string | null
        status: string
        sortOrder: number
        createdAt: Date
        updatedAt: Date
        legacyPostId: number | null
      }>
    >`
      SELECT
        id,
        "profileId",
        title,
        description,
        url,
        "featuredImage",
        "attachmentUrl",
        "attachmentName",
        status::text AS status,
        "sortOrder",
        "createdAt",
        "updatedAt",
        "legacyPostId"
      FROM "Gallery"
      WHERE "profileId" = ${profileId}
      ORDER BY "sortOrder" ASC, "createdAt" DESC
      LIMIT ${limit}
    `
    return rows.map(withGalleryDefaults)
  } catch (error) {
    if (!isPrismaSchemaDrift(error)) throw error
  }
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        id: string
        profileId: string
        title: string | null
        description: string | null
        url: string | null
        featuredImage: string | null
        status: string
        sortOrder: number
        createdAt: Date
        updatedAt: Date
      }>
    >`
      SELECT
        id,
        "profileId",
        title,
        description,
        url,
        "featuredImage",
        status::text AS status,
        COALESCE("sortOrder", 0) AS "sortOrder",
        COALESCE("createdAt", NOW()) AS "createdAt",
        COALESCE("updatedAt", NOW()) AS "updatedAt"
      FROM "Gallery"
      WHERE "profileId" = ${profileId}
      LIMIT ${limit}
    `
    return rows.map((row) =>
      withGalleryDefaults({
        ...row,
        attachmentUrl: null,
        attachmentName: null,
      })
    )
  } catch {
    return []
  }
}
