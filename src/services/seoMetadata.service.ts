export const SEO_META_TITLE_SETTING_KEY = 'seo_meta_title'
export const SEO_META_DESCRIPTION_SETTING_KEY = 'seo_meta_description'
export const SEO_META_KEYWORDS_SETTING_KEY = 'seo_meta_keywords_json'
export const MAX_OWNER_SEO_KEYWORDS = 10
export const MAX_SEO_TITLE_LENGTH = 70
export const MAX_SEO_DESCRIPTION_LENGTH = 160

export const SEO_FIXED_KEYWORDS = [
  'vbizme',
  'vbiz me',
  'virtual card',
  'digital business card',
  'online business card',
] as const

/** Stored/public keyword cap: hidden vBiz terms + owner-visible phrases. */
export const MAX_SEO_KEYWORDS = SEO_FIXED_KEYWORDS.length + MAX_OWNER_SEO_KEYWORDS

export type SeoMetadata = {
  metaTitle: string
  metaDescription: string
  keywords: string[]
}

function cleanKeyword(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function isFixedSeoKeyword(value: unknown): boolean {
  const key = cleanKeyword(value).toLowerCase()
  if (!key) return false
  return SEO_FIXED_KEYWORDS.some((item) => item.toLowerCase() === key)
}

function uniqueKeywords(source: unknown[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const keyword of source) {
    const value = cleanKeyword(keyword)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

/** Owner-visible keywords only — vBiz Me terms are prepended on persist/public output. */
export function ownerSeoKeywords(input: unknown): string[] {
  const source = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : []
  return uniqueKeywords(
    source.filter((keyword) => !isFixedSeoKeyword(keyword)),
    MAX_OWNER_SEO_KEYWORDS
  )
}

export function normalizeSeoKeywords(input: unknown): string[] {
  return uniqueKeywords([...SEO_FIXED_KEYWORDS, ...ownerSeoKeywords(input)], MAX_SEO_KEYWORDS)
}

export function normalizeSeoMetadata(input: Partial<SeoMetadata> | null | undefined): SeoMetadata {
  return {
    metaTitle: String(input?.metaTitle || '')
      .trim()
      .slice(0, MAX_SEO_TITLE_LENGTH),
    metaDescription: String(input?.metaDescription || '')
      .trim()
      .slice(0, MAX_SEO_DESCRIPTION_LENGTH),
    keywords: normalizeSeoKeywords(input?.keywords),
  }
}

export function normalizeSeoSettings(settings: Record<string, string>): Record<string, string> {
  const next = { ...settings }
  const hasSeoSettings = [
    SEO_META_TITLE_SETTING_KEY,
    SEO_META_DESCRIPTION_SETTING_KEY,
    SEO_META_KEYWORDS_SETTING_KEY,
  ].some((key) => Object.prototype.hasOwnProperty.call(next, key))
  if (Object.prototype.hasOwnProperty.call(next, SEO_META_TITLE_SETTING_KEY)) {
    next[SEO_META_TITLE_SETTING_KEY] = String(next[SEO_META_TITLE_SETTING_KEY] || '')
      .trim()
      .slice(0, MAX_SEO_TITLE_LENGTH)
  }
  if (Object.prototype.hasOwnProperty.call(next, SEO_META_DESCRIPTION_SETTING_KEY)) {
    next[SEO_META_DESCRIPTION_SETTING_KEY] = String(next[SEO_META_DESCRIPTION_SETTING_KEY] || '')
      .trim()
      .slice(0, MAX_SEO_DESCRIPTION_LENGTH)
  }
  if (Object.prototype.hasOwnProperty.call(next, SEO_META_KEYWORDS_SETTING_KEY)) {
    let raw: unknown = next[SEO_META_KEYWORDS_SETTING_KEY]
    try {
      raw = JSON.parse(next[SEO_META_KEYWORDS_SETTING_KEY])
    } catch {
      /* comma-separated legacy values remain supported */
    }
    next[SEO_META_KEYWORDS_SETTING_KEY] = JSON.stringify(normalizeSeoKeywords(raw))
  } else if (hasSeoSettings) {
    next[SEO_META_KEYWORDS_SETTING_KEY] = JSON.stringify(normalizeSeoKeywords([]))
  }
  return next
}

export function seoMetadataToSettings(input: Partial<SeoMetadata> | null | undefined): Record<string, string> {
  const seo = normalizeSeoMetadata(input)
  return normalizeSeoSettings({
    [SEO_META_TITLE_SETTING_KEY]: seo.metaTitle,
    [SEO_META_DESCRIPTION_SETTING_KEY]: seo.metaDescription,
    [SEO_META_KEYWORDS_SETTING_KEY]: JSON.stringify(seo.keywords),
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function deriveDefaultSeoFromProfile(input: {
  name?: string | null
  slug?: string | null
  companyName?: string | null
  designation?: string | null
  profession?: string | null
  about?: string | null
}): SeoMetadata {
  const name = String(input.name || input.slug || 'Digital Card').trim()
  const company = String(input.companyName || '').trim()
  const role = String(input.designation || input.profession || '').trim()
  const about = stripHtml(String(input.about || ''))

  const metaTitle = company && role ? `${name} | ${role}` : company ? `${name} | ${company}` : name
  const metaDescription =
    about ||
    (role && company
      ? `${role} at ${company}. Connect with ${name}.`
      : role
        ? `${role}. Connect with ${name}.`
        : `${name}'s digital business card on vBiz Me.`)

  return normalizeSeoMetadata({
    metaTitle,
    metaDescription,
    keywords: [name, company, role].filter(Boolean),
  })
}

export function mergeSeoSettingsWithDefaults(
  settings: Record<string, string>,
  profile: {
    name?: string | null
    slug?: string | null
    companyName?: string | null
    designation?: string | null
    profession?: string | null
    about?: string | null
  }
): Record<string, string> {
  const hasTitle = Boolean(settings[SEO_META_TITLE_SETTING_KEY]?.trim())
  const hasDescription = Boolean(settings[SEO_META_DESCRIPTION_SETTING_KEY]?.trim())
  if (hasTitle && hasDescription) return settings

  const defaults = deriveDefaultSeoFromProfile(profile)
  return normalizeSeoSettings({
    ...settings,
    ...(hasTitle ? {} : { [SEO_META_TITLE_SETTING_KEY]: defaults.metaTitle }),
    ...(hasDescription ? {} : { [SEO_META_DESCRIPTION_SETTING_KEY]: defaults.metaDescription }),
    ...(!settings[SEO_META_KEYWORDS_SETTING_KEY]
      ? { [SEO_META_KEYWORDS_SETTING_KEY]: JSON.stringify(defaults.keywords) }
      : {}),
  })
}
