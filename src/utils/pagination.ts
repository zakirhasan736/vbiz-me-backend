export type ListQuery = {
  skip: number
  limit: number
}

export type ListMeta = {
  skip: number
  limit: number
  page: number
  total: number
  hasMore: boolean
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function parseListQuery(
  query: { skip?: unknown; limit?: unknown; page?: unknown; per_page?: unknown },
  defaults: { limit?: number; max?: number } = {}
): ListQuery {
  const max = defaults.max ?? MAX_LIMIT
  const fallback = defaults.limit ?? DEFAULT_LIMIT
  const limitRaw = query.limit ?? query.per_page
  const limit = Math.min(max, Math.max(1, Number(limitRaw) || fallback))
  const page = Math.max(1, Number(query.page) || 1)
  const skipFromPage = query.page != null && query.skip == null ? (page - 1) * limit : Number(query.skip) || 0
  return { skip: Math.max(0, skipFromPage), limit }
}

export function listMeta(skip: number, limit: number, total: number): ListMeta {
  return {
    skip,
    limit,
    page: Math.floor(skip / Math.max(1, limit)) + 1,
    total,
    hasMore: skip + limit < total,
  }
}
