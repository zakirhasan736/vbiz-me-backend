/**
 * Pure helpers for finding and rewriting our S3 media keys inside arbitrary card data
 * (plain URLs, rich-text HTML, JSON snapshots, settings blobs …).
 *
 * Keys always look like `<prefix>/<something>` and appear in stored data as
 * `<PUBLIC_BASE_URL>/<key>`. We match the full public URL so we never touch text
 * that merely mentions the prefix.
 */

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Characters that terminate a key inside HTML / JSON / CSS / query strings. */
const KEY_BODY = `[^\\s"'<>()\\\\?#,;]+`

export function buildPublicUrlRegex(publicBaseUrl: string): RegExp | null {
  const base = (publicBaseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return null
  return new RegExp(`${escapeRegExp(base)}/(${KEY_BODY})`, 'g')
}

const decodeKey = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Every distinct bucket key referenced anywhere in `input` (strings, arrays, objects). */
export function extractMediaKeys(input: unknown, publicBaseUrl: string): Set<string> {
  const keys = new Set<string>()
  const re = buildPublicUrlRegex(publicBaseUrl)
  if (!re) return keys
  const text = typeof input === 'string' ? input : safeStringify(input)
  if (!text) return keys
  for (const match of text.matchAll(re)) {
    const key = decodeKey(match[1]).replace(/^\/+/, '')
    if (key) keys.add(key)
  }
  return keys
}

/**
 * Rewrite `<base>/<oldKey>` → `<base>/<newKey>` for every pair in `keyMap`.
 * Only whole keys are replaced (the next character must end the key), so
 * `vbizme/1-a.jpg` never rewrites `vbizme/1-a.jpg.webp`.
 */
export function replaceMediaKeys(text: string, keyMap: Map<string, string>, publicBaseUrl: string): string {
  if (!text || !keyMap.size) return text
  const re = buildPublicUrlRegex(publicBaseUrl)
  if (!re) return text
  const base = publicBaseUrl.trim().replace(/\/+$/, '')
  return text.replace(re, (full, rawKey: string) => {
    const key = decodeKey(rawKey).replace(/^\/+/, '')
    const next = keyMap.get(key)
    return next ? `${base}/${next}` : full
  })
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}
