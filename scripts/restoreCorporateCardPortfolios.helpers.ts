export function normalizeMediaUrl(url?: string | null): string {
  return (url || '').trim().split(/[?#]/)[0]
}

export type RecoveredPortfolioItem = {
  title: string
  description: string
  url: string
  featuredImage: string
  status: string
  source: 'history' | 'attachment' | 'legacy-row'
}

export function itemFromMediaUrl(
  imageUrl: string,
  extras: Partial<RecoveredPortfolioItem> = {},
  source: RecoveredPortfolioItem['source'] = 'attachment'
): RecoveredPortfolioItem | null {
  const featuredImage = (imageUrl || '').trim()
  if (!featuredImage || !/^https?:\/\//i.test(featuredImage)) return null
  return {
    title: extras.title?.trim() || '',
    description: extras.description?.trim() || '',
    url: extras.url?.trim() || '',
    featuredImage,
    status: extras.status?.trim() || '1',
    source,
  }
}

export function extractPortfolioItemsFromSnapshot(snapshot: unknown): RecoveredPortfolioItem[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return []
  const row = snapshot as { kind?: unknown; collectionKind?: unknown; items?: unknown }
  const kind = typeof row.collectionKind === 'string' ? row.collectionKind : ''
  if (row.kind !== 'collection' || (kind !== 'portfolios' && kind !== 'gallery')) return []
  if (!Array.isArray(row.items)) return []

  const items: RecoveredPortfolioItem[] = []
  for (const raw of row.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const featured =
      (typeof item.featuredImage === 'string' && item.featuredImage) ||
      (typeof item.imageUrl === 'string' && item.imageUrl) ||
      (typeof item.attachmentUrl === 'string' && item.attachmentUrl) ||
      ''
    const next = itemFromMediaUrl(
      featured,
      {
        title: typeof item.title === 'string' ? item.title : '',
        description: typeof item.description === 'string' ? item.description : '',
        url: typeof item.url === 'string' ? item.url : '',
        status: item.status == null ? '1' : String(item.status),
      },
      'history'
    )
    if (next) items.push(next)
  }
  return items
}

export function isPortfolioGalleryAttachment(typeName?: string | null, attachableType?: string | null): boolean {
  const type = (typeName || '').toLowerCase().trim()
  const attachable = (attachableType || '').toLowerCase().trim()
  if (/profile image|profile picture|profile pic|avatar|intro vcard|background video|background music/.test(type)) {
    return false
  }
  if (type.includes('portfolio') || type.includes('gallery') || type.includes('featured')) return true
  return (
    attachable === 'gallery' ||
    attachable === 'portfolio' ||
    attachable.endsWith('\\gallery') ||
    attachable.endsWith('\\portfolio')
  )
}

export function missingPortfolioItems(
  currentUrls: Array<string | null | undefined>,
  candidates: RecoveredPortfolioItem[]
): RecoveredPortfolioItem[] {
  const seen = new Set(currentUrls.map(normalizeMediaUrl).filter(Boolean))
  const added: RecoveredPortfolioItem[] = []
  for (const item of candidates) {
    const key = normalizeMediaUrl(item.featuredImage)
    if (!key || seen.has(key)) continue
    seen.add(key)
    added.push(item)
  }
  return added
}

export function keyFromPublicUrl(url: string): string | null {
  try {
    const key = new URL(url).pathname.replace(/^\/+/, '')
    return key || null
  } catch {
    return null
  }
}
