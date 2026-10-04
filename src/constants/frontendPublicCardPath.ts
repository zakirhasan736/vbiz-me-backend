/** Frontend public card URL segment (https://domain/vCard/{slug}). */
export const FRONTEND_PUBLIC_CARD_PATH_SEGMENT = 'vCard'
const LEGACY_PUBLIC_CARD_PATH_SEGMENT = 'v'

export function buildFrontendPublicCardPath(slug: string): string {
  const trimmed = slug.trim()
  if (!trimmed) return `/${FRONTEND_PUBLIC_CARD_PATH_SEGMENT}`
  return `/${FRONTEND_PUBLIC_CARD_PATH_SEGMENT}/${encodeURIComponent(trimmed)}`
}

export function buildFrontendPublicCardUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return `${base}${buildFrontendPublicCardPath(slug)}`
}

/** Rewrite legacy `/v/{slug}` (and bare slug) to `/vCard/{slug}` for push deep links. */
export function normalizeFrontendPublicCardPath(rawUrl: string | null | undefined, slug?: string | null): string {
  const fallbackSlug = slug?.trim() || ''
  const fallback = fallbackSlug ? buildFrontendPublicCardPath(fallbackSlug) : `/${FRONTEND_PUBLIC_CARD_PATH_SEGMENT}`
  if (!rawUrl?.trim()) return fallback
  try {
    const absolute = /^https?:\/\//i.test(rawUrl)
    const parsed = absolute ? new URL(rawUrl) : new URL(rawUrl, 'https://app.vbizme.com')
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)
    if (parts[0] === LEGACY_PUBLIC_CARD_PATH_SEGMENT && parts[1]) {
      parsed.pathname = `/${FRONTEND_PUBLIC_CARD_PATH_SEGMENT}/${parts.slice(1).join('/')}`
      return absolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
    if (parts[0] === FRONTEND_PUBLIC_CARD_PATH_SEGMENT && parts[1]) {
      return absolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
    if (parts.length === 1 && parts[0]) {
      return buildFrontendPublicCardPath(decodeURIComponent(parts[0]))
    }
    return absolute ? parsed.href : rawUrl.startsWith('/') ? rawUrl : fallback
  } catch {
    return fallback
  }
}

export function buildFrontendPublicCardWalletArtUrl(baseUrl: string, slug: string, format: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return `${base}${buildFrontendPublicCardPath(slug)}/wallet-art?format=${encodeURIComponent(format)}&v=face4`
}
