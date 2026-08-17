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
