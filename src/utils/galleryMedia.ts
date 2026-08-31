import { prisma } from './prisma'
import { isPrismaSchemaDrift } from './prismaErrors'

type GalleryLike = {
  title?: string | null
  featuredImage?: string | null
  attachmentUrl?: string | null
  attachmentName?: string | null
}

type PortfolioLike = {
  title?: string | null
  imageUrl?: string | null
  attachmentUrl?: string | null
  attachmentName?: string | null
}

const titleKey = (value?: string | null) =>
  String(value || '')
    .trim()
    .toLowerCase()

/** Copy featured/attachment URLs from legacy Portfolio rows onto Gallery rows that only have titles. */
export function fillMissingGalleryMedia<G extends GalleryLike, P extends PortfolioLike>(
  galleries: G[],
  portfolios: P[]
): G[] {
  if (!galleries.length || !portfolios.length) return galleries
  const byTitle = new Map<string, P>()
  for (const row of portfolios) {
    const key = titleKey(row.title)
    if (key && !byTitle.has(key)) byTitle.set(key, row)
  }
  return galleries.map((gallery, index) => {
    if (gallery.featuredImage && gallery.attachmentUrl) return gallery
    const legacy = (titleKey(gallery.title) ? byTitle.get(titleKey(gallery.title)) : undefined) || portfolios[index]
    if (!legacy) return gallery
    return {
      ...gallery,
      featuredImage: gallery.featuredImage || legacy.imageUrl || gallery.featuredImage,
      attachmentUrl: gallery.attachmentUrl || legacy.attachmentUrl || gallery.attachmentUrl,
      attachmentName: gallery.attachmentName || legacy.attachmentName || gallery.attachmentName,
    }
  })
}

export function galleryHasMedia(
  rows: Array<{ featuredImage?: string | null; attachmentUrl?: string | null }>
): boolean {
  return rows.some((row) => Boolean(row.featuredImage || row.attachmentUrl))
}

export type LiveGalleryRow = {
  id: string
  profileId: string
  type: string
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
  type: true,
  url: true,
  featuredImage: true,
  attachmentUrl: true,
  attachmentName: true,
  status: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const

const withGalleryDefaults = (row: {
  id: string
  profileId: string
  type?: string | null
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
}): LiveGalleryRow => ({
  ...row,
  type: row.type || 'Image',
  attachmentUrl: row.attachmentUrl ?? null,
  attachmentName: row.attachmentName ?? null,
  deletedAt: null,
  legacyPostId: null,
  metas: null,
})

/** Load gallery rows without selecting columns the live DB may not have (`legacyPostId`, `deletedAt`, `metas`). */
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
        "updatedAt"
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
