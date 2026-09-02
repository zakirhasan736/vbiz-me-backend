/** Frontend public card URL segment (https://domain/vCard/{slug}). */
export const FRONTEND_PUBLIC_CARD_PATH_SEGMENT = 'vCard'

export function buildFrontendPublicCardPath(slug: string): string {
  const trimmed = slug.trim()
  if (!trimmed) return `/${FRONTEND_PUBLIC_CARD_PATH_SEGMENT}`
  return `/${FRONTEND_PUBLIC_CARD_PATH_SEGMENT}/${encodeURIComponent(trimmed)}`
}

export function buildFrontendPublicCardUrl(baseUrl: string, slug: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return `${base}${buildFrontendPublicCardPath(slug)}`
}

export function buildFrontendPublicCardWalletArtUrl(baseUrl: string, slug: string, format: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return `${base}${buildFrontendPublicCardPath(slug)}/wallet-art?format=${encodeURIComponent(format)}&v=face4`
}
