export const SEO_META_TITLE_SETTING_KEY = 'seo_meta_title'
export const SEO_META_DESCRIPTION_SETTING_KEY = 'seo_meta_description'
export const SEO_META_KEYWORDS_SETTING_KEY = 'seo_meta_keywords_json'
export const MAX_SEO_KEYWORDS = 10
export const MAX_SEO_TITLE_LENGTH = 70
export const MAX_SEO_DESCRIPTION_LENGTH = 160

export const SEO_FIXED_KEYWORDS = [
  'vbizme',
  'vbiz me',
  'virtual card',
  'digital business card',
  'online business card',
] as const

export type SeoMetadata = {
  metaTitle: string
  metaDescription: string
  keywords: string[]
}

function cleanKeyword(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function normalizeSeoKeywords(input: unknown): string[] {
  const source = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : []
  const seen = new Set<string>()
  const result: string[] = []

  for (const keyword of [...SEO_FIXED_KEYWORDS, ...source]) {
    const value = cleanKeyword(keyword)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= MAX_SEO_KEYWORDS) break
  }

  return result
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
