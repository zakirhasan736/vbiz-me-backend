/**
 * Models don't always return the exact JSON shape we asked for — especially when asked to
 * rewrite ("summarize") rather than copy. Typical drift: `null` for a missing value, a rating
 * of `null` / `0` / "5/5", a bare array, a single object instead of a list, or a different
 * wrapper key. None of that is a reason to fail the owner's paste, so we repair the shape
 * here before the strict schema runs. Content is never invented or changed, only re-typed.
 */

const LIST_ITEM_KEYS: Record<string, readonly string[]> = {
  services: ['title', 'description', 'type'],
  blogs: ['title', 'description'],
  portfolio: ['title', 'description'],
  reviews: ['author', 'text'],
  skills: ['skills', 'type'],
  education: ['institute', 'degree'],
  experience: ['company', 'jobTitle'],
  faqs: ['question', 'answer'],
  entries: ['title', 'description'],
}

const OBJECT_SECTION_KEYS: Record<string, readonly string[]> = {
  content: ['title', 'description'],
  personal: ['fullName', 'email', 'phone', 'designation', 'company', 'about', 'website', 'address'],
  seo: ['metaTitle', 'metaDescription', 'keywords'],
}

/** Fields that are string lists; every other field is plain text unless listed below. */
const STRING_LIST_FIELDS = new Set(['skills', 'keywords'])
const BOOLEAN_FIELDS = new Set(['tillNow'])

/** Common names a model gives a field when it drifts from the requested one. */
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  reviews: {
    name: 'author',
    reviewer: 'author',
    customer: 'author',
    client: 'author',
    quote: 'text',
    review: 'text',
    testimonial: 'text',
    content: 'text',
    body: 'text',
    description: 'text',
    summary: 'text',
    stars: 'rating',
    image: 'imageUrl',
    link: 'url',
  },
  faqs: { q: 'question', title: 'question', a: 'answer', description: 'answer', body: 'answer', summary: 'answer' },
  default: {
    name: 'title',
    heading: 'title',
    headline: 'title',
    body: 'description',
    content: 'description',
    summary: 'description',
    text: 'description',
    image: 'imageUrl',
    link: 'url',
  },
  education: { school: 'institute', institution: 'institute', university: 'institute' },
  experience: {
    title: 'jobTitle',
    role: 'jobTitle',
    position: 'jobTitle',
    employer: 'company',
    summary: 'description',
  },
  skills: { category: 'type', name: 'type', items: 'skills', list: 'skills' },
  personal: { name: 'fullName', title: 'designation', jobTitle: 'designation', bio: 'about', companyName: 'company' },
  seo: { title: 'metaTitle', description: 'metaDescription' },
  socialHandles: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((v) => toText(v)).filter((v): v is string => Boolean(v && v.trim()))
    if (!parts.length) return undefined
    // Paragraph arrays become HTML paragraphs unless they already carry markup.
    return parts.some((p) => /<[a-z][\s\S]*>/i.test(p)) ? parts.join('') : parts.join('\n\n')
  }
  if (isRecord(value)) {
    for (const key of ['html', 'text', 'value', 'content']) {
      const inner = toText(value[key])
      if (inner) return inner
    }
  }
  return undefined
}

function toStringList(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]+/) : []
  return rows
    .map((v) => (isRecord(v) ? (toText(v.name) ?? toText(v.title) ?? toText(v.skill) ?? '') : (toText(v) ?? '')))
    .map((v) => v.trim())
    .filter(Boolean)
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', 'yes', '1', 'present', 'current', 'now'].includes(v)) return true
    if (['false', 'no', '0', ''].includes(v)) return false
  }
  return undefined
}

/** 1–5 stars from 5, "5", "4.5 stars", "5/5", "★★★★★"; anything unusable → undefined (schema default). */
export function normalizeRating(value: unknown): number | undefined {
  let n: number | undefined
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const stars = (value.match(/[★⭐]/g) || []).length
    const match = value.match(/\d+(?:[.,]\d+)?/)
    if (match) n = Number(match[0].replace(',', '.'))
    else if (stars) n = stars
  }
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  return Math.min(5, Math.max(1, Math.round(n)))
}

function normalizeFields(
  scope: string,
  row: Record<string, unknown>,
  known: readonly string[]
): Record<string, unknown> {
  const aliases = FIELD_ALIASES[scope] ?? FIELD_ALIASES.default ?? {}
  const out: Record<string, unknown> = {}
  const assign = (key: string, value: unknown) => {
    if (key === 'rating') {
      const rating = normalizeRating(value)
      if (rating !== undefined) out.rating = rating
    } else if (BOOLEAN_FIELDS.has(key)) {
      const flag = toBoolean(value)
      if (flag !== undefined) out[key] = flag
    } else if (STRING_LIST_FIELDS.has(key)) {
      out[key] = toStringList(value)
    } else if (isRecord(value) && key === 'socialHandles') {
      out[key] = normalizeFields('socialHandles', value, [])
    } else {
      const text = toText(value)
      if (text !== undefined) out[key] = text
    }
  }
  // Real field names first, so an alias never overwrites a value the model put in the right place.
  for (const [key, value] of Object.entries(row)) {
    if (!(key in aliases) || known.includes(key)) assign(key, value)
  }
  for (const [key, value] of Object.entries(row)) {
    const target = aliases[key]
    if (!target || known.includes(key)) continue
    const current = out[target]
    if (current === undefined || current === '' || (Array.isArray(current) && !current.length)) assign(target, value)
  }
  return out
}

function findList(scope: string, raw: Record<string, unknown>): unknown {
  if (raw[scope] !== undefined && raw[scope] !== null) return raw[scope]
  const lower = Object.keys(raw).find((k) => k.toLowerCase() === scope)
  if (lower) return raw[lower]
  // A differently named wrapper ("items", "data", "testimonials"…): the only array of objects wins.
  const arrays = Object.values(raw).filter((v) => Array.isArray(v) && v.some(isRecord))
  if (arrays.length === 1) return arrays[0]
  for (const value of Object.values(raw)) {
    if (isRecord(value)) {
      const nested = findList(scope, value)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function looksLikeItem(scope: string, raw: Record<string, unknown>, known: readonly string[]): boolean {
  const aliases = FIELD_ALIASES[scope] ?? FIELD_ALIASES.default ?? {}
  return Object.keys(raw).some((k) => known.includes(k) || known.includes(aliases[k] ?? ''))
}

/**
 * Repair the shape of a fill-section model response for `scope`. Unknown scopes and values
 * that can't be repaired are returned untouched so the schema reports the real problem.
 */
export function normalizeFillPayload(scope: string, input: unknown): unknown {
  let raw = input
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return input
    }
  }

  const itemKeys = LIST_ITEM_KEYS[scope]
  if (itemKeys) {
    let list: unknown
    if (Array.isArray(raw)) list = raw
    else if (isRecord(raw)) {
      list = findList(scope, raw)
      if (list === undefined && looksLikeItem(scope, raw, itemKeys)) list = [raw]
    }
    if (list === undefined || list === null) return isRecord(raw) ? { ...raw, [scope]: [] } : { [scope]: [] }
    if (isRecord(list)) list = looksLikeItem(scope, list, itemKeys) ? [list] : Object.values(list)
    if (!Array.isArray(list)) return raw
    const rows = list
      .map((row) => {
        if (isRecord(row)) return normalizeFields(scope, row, itemKeys)
        // A list of plain strings: skills become one group later; others are bodies without a label.
        const text = toText(row)?.trim()
        if (!text) return null
        if (scope === 'skills') return { __skill: text }
        const bodyKey = scope === 'reviews' ? 'text' : scope === 'faqs' ? 'answer' : 'description'
        return scope === 'education' || scope === 'experience' ? null : { [bodyKey]: text }
      })
      .filter((row): row is Record<string, unknown> => row !== null)
    if (scope === 'skills') {
      const loose = rows.filter((r) => '__skill' in r).map((r) => String(r.__skill))
      const groups = rows.filter((r) => !('__skill' in r))
      return { skills: loose.length ? [...groups, { type: 'General', skills: loose }] : groups }
    }
    return { [scope]: rows }
  }

  const objectKeys = OBJECT_SECTION_KEYS[scope]
  if (objectKeys) {
    if (Array.isArray(raw)) raw = raw.find(isRecord) ?? {}
    if (!isRecord(raw)) return raw
    let section: unknown = raw[scope]
    if (Array.isArray(section)) section = section.find(isRecord)
    // The model answered with the fields directly instead of wrapping them in `{ [scope]: … }`.
    if (!isRecord(section)) section = looksLikeItem(scope, raw, objectKeys) ? raw : {}
    const out: Record<string, unknown> = {
      [scope]: normalizeFields(scope, section as Record<string, unknown>, objectKeys),
    }
    if (scope === 'personal') {
      const handles = isRecord(raw.socialHandles)
        ? raw.socialHandles
        : isRecord((section as Record<string, unknown>).socialHandles)
          ? ((section as Record<string, unknown>).socialHandles as Record<string, unknown>)
          : null
      if (handles) out.socialHandles = normalizeFields('socialHandles', handles, [])
      delete (out.personal as Record<string, unknown>).socialHandles
    }
    return out
  }

  return raw
}
