import config from '../configs/config'
import AppError from '../error/AppError'

export type GoogleFontItem = {
  family: string
  category: string
}

type GoogleWebfontsResponse = {
  items?: Array<{
    family?: string
    category?: string
  }>
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 48

let cache: { fetchedAt: number; items: GoogleFontItem[] } | null = null

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : DEFAULT_LIMIT
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

async function fetchAllFonts(): Promise<GoogleFontItem[]> {
  if (!config.GOOGLE_FONTS_API_KEY) {
    throw new AppError(503, 'Google Fonts API is not configured')
  }

  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items
  }

  const url = new URL('https://www.googleapis.com/webfonts/v1/webfonts')
  url.searchParams.set('key', config.GOOGLE_FONTS_API_KEY)
  url.searchParams.set('sort', 'popularity')

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new AppError(502, 'Failed to fetch Google Fonts catalog')
  }

  const body = (await res.json()) as GoogleWebfontsResponse
  const items: GoogleFontItem[] = (body.items ?? [])
    .map((item) => ({
      family: typeof item.family === 'string' ? item.family.trim() : '',
      category: typeof item.category === 'string' ? item.category.trim() : 'sans-serif',
    }))
    .filter((item) => item.family.length > 0)

  cache = { fetchedAt: now, items }
  return items
}

const listFonts = async (q?: string, limitRaw?: unknown): Promise<GoogleFontItem[]> => {
  const limit = clampLimit(limitRaw)
  const items = await fetchAllFonts()
  const query = typeof q === 'string' ? q.trim().toLowerCase() : ''

  if (!query) {
    return items.slice(0, limit)
  }

  return items.filter((item) => item.family.toLowerCase().includes(query)).slice(0, limit)
}

const fontsService = {
  listFonts,
}

export default fontsService
