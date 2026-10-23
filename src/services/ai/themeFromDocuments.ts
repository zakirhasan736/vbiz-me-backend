import type { MasterBusinessProfile } from './businessProfile.schema'

type Triplet = { primary: string; secondary: string; accent: string }
type ThemeRec = NonNullable<MasterBusinessProfile['themeRecommendation']>

const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g

function normalizeHex(value: string): string {
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

function roleFromLabel(label: string): keyof Triplet | null {
  const key = label.toLowerCase().replace(/[^a-z]/g, '')
  if (key.startsWith('primary') || key === 'main' || key === 'brand') return 'primary'
  if (key.startsWith('secondary') || key === 'companion') return 'secondary'
  if (key.startsWith('accent') || key === 'highlight' || key === 'cta') return 'accent'
  return null
}

function fillTripletFromBlock(block: string, into: Triplet): void {
  if (!block.trim()) return
  const labeled =
    /(?:^|\n)\s*(primary|secondary|accent|main|brand|companion|highlight|cta)\s*(?:color|colour|hex)?\s*[:\-–—]?\s*(#[0-9a-fA-F]{3,6})\b/gi
  for (const match of block.matchAll(labeled)) {
    const role = roleFromLabel(match[1])
    if (!role || into[role]) continue
    into[role] = normalizeHex(match[2])
  }
  // "Light Primary #abc" / "dark-secondary: #def"
  const prefixed =
    /(?:light|dark)?[\s_-]*(primary|secondary|accent)\s*(?:color|colour|hex)?\s*[:\-–—]?\s*(#[0-9a-fA-F]{3,6})\b/gi
  for (const match of block.matchAll(prefixed)) {
    const role = roleFromLabel(match[1])
    if (!role || into[role]) continue
    into[role] = normalizeHex(match[2])
  }
  // Fallback: first three distinct HEX in the block map to P/S/A
  if (!into.primary || !into.secondary || !into.accent) {
    const found = [...(block.match(HEX) || [])].map(normalizeHex)
    const unique = [...new Set(found)].filter((hex) => !/^#(fff|000|ffffff|000000)$/i.test(hex))
    if (!into.primary && unique[0]) into.primary = unique[0]
    if (!into.secondary && unique[1]) into.secondary = unique[1]
    if (!into.accent && unique[2]) into.accent = unique[2]
  }
}

function modeBlock(text: string, mode: 'light' | 'dark'): string {
  const re =
    mode === 'light'
      ? /(?:^|\n)\s*(?:light(?:\s+theme)?|day(?:\s+mode)?|light\s+mode)\b[\s:]*([\s\S]*?)(?=(?:^|\n)\s*(?:dark(?:\s+theme)?|night(?:\s+mode)?|dark\s+mode)\b|$)/i
      : /(?:^|\n)\s*(?:dark(?:\s+theme)?|night(?:\s+mode)?|dark\s+mode)\b[\s:]*([\s\S]*?)(?=(?:^|\n)\s*(?:light(?:\s+theme)?|day(?:\s+mode)?|light\s+mode)\b|$)/i
  const match = text.match(re)
  return match?.[1]?.trim() || ''
}

function hasAny(t: Triplet): boolean {
  return Boolean(t.primary || t.secondary || t.accent)
}

/**
 * Read light/dark Primary·Secondary·Accent HEX from PDF/text brand guidelines.
 * Deterministic — does not depend on the model returning themeRecommendation.
 * Ignores the crawl's BRAND COLOR RESEARCH block (handled separately as website).
 */
export function extractThemeRecommendationFromText(text: string): ThemeRec | null {
  if (!text?.trim()) return null
  // Strip deterministic website research so "Recommended light Primary/..." is not
  // misclassified as a PDF brand-guideline document.
  const cleaned = text
    .replace(
      /BRAND COLOR RESEARCH[\s\S]*?(?=\n(?:WEBSITE URL|DOCUMENT |OWNER-PROVIDED|USER INSTRUCTIONS|CRAWL MODE|=== PAGE)|\n\n---|\s*$)/gi,
      ' '
    )
    .replace(/Recommended (?:light|dark) Primary\/Secondary\/Accent:[^\n]*/gi, ' ')
  if (!cleaned.trim()) return null
  const light: Triplet = { primary: '', secondary: '', accent: '' }
  const dark: Triplet = { primary: '', secondary: '', accent: '' }

  const lightBlock = modeBlock(cleaned, 'light')
  const darkBlock = modeBlock(cleaned, 'dark')
  fillTripletFromBlock(lightBlock, light)
  fillTripletFromBlock(darkBlock, dark)

  // Prefixed keys anywhere in the document when section headers were missing.
  if (!hasAny(light) || !hasAny(dark)) {
    for (const match of cleaned.matchAll(
      /\b(light|dark)\s*[-_]?\s*(primary|secondary|accent)\s*(?:color|colour|hex)?\s*[:\-–—]?\s*(#[0-9a-fA-F]{3,6})\b/gi
    )) {
      const mode = match[1].toLowerCase() === 'dark' ? dark : light
      const role = roleFromLabel(match[2])
      if (!role || mode[role]) continue
      mode[role] = normalizeHex(match[3])
    }
  }

  // Single palette named once — use for both modes if only one side filled.
  if (!hasAny(light) && !hasAny(dark)) {
    fillTripletFromBlock(cleaned, light)
    if (hasAny(light)) {
      dark.primary = light.primary
      dark.secondary = light.secondary
      dark.accent = light.accent
    }
  } else if (hasAny(light) && !hasAny(dark)) {
    dark.primary = light.primary
    dark.secondary = light.secondary
    dark.accent = light.accent
  } else if (hasAny(dark) && !hasAny(light)) {
    light.primary = dark.primary
    light.secondary = dark.secondary
    light.accent = dark.accent
  }

  if (!hasAny(light) && !hasAny(dark)) return null
  return {
    light,
    dark,
    source: 'document',
    notes: 'Extracted from uploaded PDF/text brand colors (light + dark Primary/Secondary/Accent).',
  }
}

function roleFilled(side?: Partial<Triplet> | null, role?: keyof Triplet): boolean {
  if (!side || !role) return false
  return Boolean(String(side[role] || '').trim())
}

/** True when fallback supplies at least one role preferred left blank. */
function fallbackContributedRoles(preferred: ThemeRec, fallback: ThemeRec): boolean {
  for (const mode of ['light', 'dark'] as const) {
    for (const role of ['primary', 'secondary', 'accent'] as const) {
      if (!roleFilled(preferred[mode], role) && roleFilled(fallback[mode], role)) return true
    }
  }
  return false
}

/** Document/logo/website colors win over empty AI slots; never wipe a filled role with blank. */
export function mergeThemeRecommendations(
  preferred: ThemeRec | null | undefined,
  fallback: ThemeRec | null | undefined
): ThemeRec | null {
  if (!preferred && !fallback) return null
  if (!preferred) return fallback || null
  if (!fallback) return preferred
  const mergeSide = (a?: Partial<Triplet> | null, b?: Partial<Triplet> | null): Triplet => ({
    primary: (a?.primary || b?.primary || '').trim(),
    secondary: (a?.secondary || b?.secondary || '').trim(),
    accent: (a?.accent || b?.accent || '').trim(),
  })
  const light = mergeSide(preferred.light, fallback.light)
  const dark = mergeSide(preferred.dark, fallback.dark)
  if (!hasAny(light) && !hasAny(dark)) return null
  const preferredFilled = hasAny(mergeSide(preferred.light, null)) || hasAny(mergeSide(preferred.dark, null))
  const fallbackFilled = hasAny(mergeSide(fallback.light, null)) || hasAny(mergeSide(fallback.dark, null))
  const contributed = fallbackContributedRoles(preferred, fallback)
  let source: ThemeRec['source'] = preferred.source || fallback.source || 'suggestion'
  if (preferred.source === 'document' && preferredFilled) {
    source = contributed && fallback.source && fallback.source !== 'document' ? 'mixed' : 'document'
  } else if (preferred.source === 'website' && preferredFilled) {
    source = contributed && fallback.source && fallback.source !== 'website' ? 'mixed' : 'website'
  } else if (fallback.source === 'document' && fallbackFilled && !preferredFilled) {
    source = 'document'
  } else if (fallback.source === 'website' && fallbackFilled && !preferredFilled) {
    source = 'website'
  } else if (
    preferredFilled &&
    fallbackFilled &&
    contributed &&
    preferred.source &&
    fallback.source &&
    preferred.source !== fallback.source
  ) {
    source = 'mixed'
  }
  return {
    light,
    dark,
    source,
    notes: [preferred.notes, fallback.notes].filter(Boolean).join(' ').trim(),
  }
}

/**
 * Prefer PDF/document Light·Dark P/S/A, then deterministic website brand theme,
 * then AI themeRecommendation. Never wipe filled roles with blanks.
 */
export function resolveProfileThemeRecommendation(
  profile: MasterBusinessProfile,
  sourceText: string,
  websiteTheme?: ThemeRec | null
): MasterBusinessProfile {
  const fromDocs = extractThemeRecommendationFromText(sourceText)
  const fromWebsite = websiteTheme || extractThemeRecommendationFromBrandResearchBlock(sourceText) || null
  const withWebsite = mergeThemeRecommendations(fromDocs, fromWebsite)
  const merged = mergeThemeRecommendations(withWebsite, profile.themeRecommendation)
  if (!merged) return profile
  return { ...profile, themeRecommendation: merged }
}

/** Parse BRAND COLOR RESEARCH block that the crawl injects into extracted text. */
export function extractThemeRecommendationFromBrandResearchBlock(text: string): ThemeRec | null {
  if (!text?.includes('BRAND COLOR RESEARCH')) return null
  const light = text.match(
    /Recommended light Primary\/Secondary\/Accent:\s*(#[0-9a-fA-F]{3,6})\s*\/\s*(#[0-9a-fA-F]{3,6})\s*\/\s*(#[0-9a-fA-F]{3,6})/i
  )
  const dark = text.match(
    /Recommended dark Primary\/Secondary\/Accent:\s*(#[0-9a-fA-F]{3,6})\s*\/\s*(#[0-9a-fA-F]{3,6})\s*\/\s*(#[0-9a-fA-F]{3,6})/i
  )
  if (!light && !dark) return null
  const norm = (v: string) => (v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v).toLowerCase()
  return {
    light: {
      primary: light ? norm(light[1]) : dark ? norm(dark[1]) : '',
      secondary: light ? norm(light[2]) : dark ? norm(dark[2]) : '',
      accent: light ? norm(light[3]) : dark ? norm(dark[3]) : '',
    },
    dark: {
      primary: dark ? norm(dark[1]) : light ? norm(light[1]) : '',
      secondary: dark ? norm(dark[2]) : light ? norm(light[2]) : '',
      accent: dark ? norm(dark[3]) : light ? norm(light[3]) : '',
    },
    source: 'website',
    notes: 'Parsed from deterministic BRAND COLOR RESEARCH block.',
  }
}
