type LooseItem = Record<string, unknown>

function pick(item: LooseItem) {
  return {
    id: item.id ?? null,
    title: item.title ?? item.author ?? null,
    featuredImage: item.featuredImage ?? null,
    featured_image: item.featured_image ?? null,
    imageUrl: item.imageUrl ?? null,
    attachmentUrl: item.attachmentUrl ?? null,
    attachments: item.attachments ?? null,
    url: item.url ?? null,
    general_info_url: item.general_info_url ?? null,
    video_url: item.video_url ?? null,
    reviewUrl: item.reviewUrl ?? null,
    review_link: item.review_link ?? null,
    status: item.status ?? null,
  }
}

const MEDIA_SECTIONS = new Set([
  'clients',
  'gallery',
  'portfolios',
  'portfolio',
  'reviews',
  'video links',
  'video-links',
  'videos',
])

export function shouldLogPublicSectionMedia(sectionName: string) {
  return MEDIA_SECTIONS.has(sectionName.trim().toLowerCase())
}

/** Temporary: copy this JSON from the API terminal and paste it in chat. */
export function logPublicSectionMedia(sectionName: string, profileId: string, data: unknown, extra?: unknown) {
  if (!shouldLogPublicSectionMedia(sectionName)) return
  const root = data && typeof data === 'object' ? (data as { items?: unknown }) : null
  const items = Array.isArray(root?.items)
    ? root.items.filter((item): item is LooseItem => Boolean(item) && typeof item === 'object').map(pick)
    : []
  console.info(
    '[public-section-media]',
    JSON.stringify(
      {
        sectionName,
        profileId,
        itemCount: items.length,
        items,
        extra: extra ?? null,
      },
      null,
      2
    )
  )
}
