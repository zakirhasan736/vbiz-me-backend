type CacheEntry<T> = { value: T; expiresAt: number }

const store = new Map<string, CacheEntry<unknown>>()
const DEFAULT_TTL_MS = 30 * 60 * 1000

function sweep() {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key)
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    store.delete(key)
    return undefined
  }
  return entry.value
}

export function cacheSet<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS) {
  if (store.size > 200) sweep()
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

export function cacheKey(parts: Array<string | number | undefined | null>): string {
  return parts.map((p) => String(p ?? '')).join('|')
}
