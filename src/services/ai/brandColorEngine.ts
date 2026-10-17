/**
 * Website brand color discovery → vBiz Me light/dark Primary·Secondary·Accent.
 * Deterministic extraction + accessibility repair. AI may refine; this seeds Global Color.
 */

import type { MasterBusinessProfile } from './businessProfile.schema'
import {
  adjustLightness,
  contrastRatio,
  ensureContrast,
  expandHex,
  hexToHsl,
  hslToHex,
  isNearNeutral,
  parseCssColor,
  relativeLuminance,
  type ParsedCssColor,
} from './cssColorParse'

export type BrandColorUsage =
  | 'brand_token'
  | 'primary_cta'
  | 'navigation'
  | 'header'
  | 'heading'
  | 'accent_token'
  | 'footer'
  | 'logo'
  | 'banner'
  | 'supporting'
  | 'incidental'

export type BrandColorEvidence = {
  originalValue: string
  format: string
  hex: string
  alpha: number
  usage: BrandColorUsage
  sourceType: 'css_variable' | 'stylesheet' | 'inline_style' | 'svg' | 'html_attribute'
  confidence: 'high' | 'medium' | 'low'
  property?: string
  selectorHint?: string
}

type ThemeRec = NonNullable<MasterBusinessProfile['themeRecommendation']>
type Triplet = { primary: string; secondary: string; accent: string }

const COLOR_PROP_RE =
  /(?:^|[;\s{])((?:--[\w-]+)|(?:background(?:-color)?|color|border(?:-color)?|outline-color|fill|stroke|box-shadow))\s*:\s*([^;{}]+)/gi

const BRAND_VAR_RE =
  /--(?:[\w-]*(?:primary|secondary|accent|brand|theme|cta|main|highlight|action|link|nav|header|button)[\w-]*)\s*:\s*([^;}+]+)/gi

const LIGHT_BG = '#ffffff'
const DARK_BG = '#020914'

function scoreUsage(usage: BrandColorUsage): number {
  switch (usage) {
    case 'brand_token':
      return 100
    case 'primary_cta':
      return 90
    case 'logo':
      return 85
    case 'navigation':
      return 75
    case 'header':
      return 70
    case 'accent_token':
      return 68
    case 'heading':
      return 55
    case 'banner':
      return 50
    case 'footer':
      return 35
    case 'supporting':
      return 25
    default:
      return 10
  }
}

function classifyVarName(name: string): BrandColorUsage {
  const n = name.toLowerCase()
  if (/accent|highlight|cta|action|promo/.test(n)) return 'accent_token'
  if (/secondary|companion|muted|surface/.test(n)) return 'supporting'
  if (/primary|brand|theme|main|button|link/.test(n)) return 'brand_token'
  if (/nav|header|footer/.test(n)) return /footer/.test(n) ? 'footer' : 'navigation'
  return 'supporting'
}

function classifySelector(selector: string, property: string): BrandColorUsage {
  const s = `${selector} ${property}`.toLowerCase()
  if (/btn|button|cta|get-started|signup|sign-up|book|buy|subscribe/.test(s)) return 'primary_cta'
  if (/nav|navbar|menu|header/.test(s)) return /footer/.test(s) ? 'footer' : 'navigation'
  if (/footer/.test(s)) return 'footer'
  if (/logo|brand/.test(s)) return 'logo'
  if (/banner|hero|jumbotron/.test(s)) return 'banner'
  if (/h1|h2|heading|title/.test(s)) return 'heading'
  if (/accent|highlight/.test(s)) return 'accent_token'
  return 'supporting'
}

function extractCustomProperties(css: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/gi)) {
    const name = match[1].toLowerCase()
    const value = match[2].trim()
    if (!vars[name]) vars[name] = value
  }
  return vars
}

function pushEvidence(
  out: BrandColorEvidence[],
  parsed: ParsedCssColor,
  usage: BrandColorUsage,
  sourceType: BrandColorEvidence['sourceType'],
  confidence: BrandColorEvidence['confidence'],
  extra?: { property?: string; selectorHint?: string }
) {
  if (parsed.alpha < 0.35) return
  if (isNearNeutral(parsed.hex) && usage === 'incidental') return
  out.push({
    originalValue: parsed.original,
    format: parsed.format,
    hex: parsed.hex,
    alpha: parsed.alpha,
    usage,
    sourceType,
    confidence,
    property: extra?.property,
    selectorHint: extra?.selectorHint,
  })
}

/** Collect stylesheet + inline + SVG color evidence from HTML (and optional linked CSS text). */
export function extractBrandColorEvidence(html: string, linkedCss = ''): BrandColorEvidence[] {
  if (!html?.trim() && !linkedCss.trim()) return []
  const evidence: BrandColorEvidence[] = []
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  const cssBundle = [...styleBlocks, linkedCss].join('\n')
  const vars = extractCustomProperties(cssBundle)

  // Brand-ish custom properties first.
  for (const match of cssBundle.matchAll(BRAND_VAR_RE)) {
    const full = match[0]
    const varName = full.match(/(--[\w-]+)/)?.[1] || ''
    const parsed = parseCssColor(match[1], vars)
    if (!parsed) continue
    pushEvidence(evidence, parsed, classifyVarName(varName), 'css_variable', 'high', {
      property: varName,
      selectorHint: ':root',
    })
  }

  // Declaration scanning with rough selector context.
  const ruleRe = /([^{}@][^{]*)\{([^{}]+)\}/g
  for (const rule of cssBundle.matchAll(ruleRe)) {
    const selector = rule[1].trim().slice(-180)
    const body = rule[2]
    COLOR_PROP_RE.lastIndex = 0
    for (const decl of body.matchAll(COLOR_PROP_RE)) {
      const prop = decl[1]
      const rawVal = decl[2].trim()
      // Gradients: pull nested color stops.
      const tokens = rawVal.match(
        /#(?:[0-9a-fA-F]{3,8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)|hwb\([^)]+\)|var\([^)]+\)|[a-z]{3,20}/gi
      ) || [rawVal]
      for (const token of tokens) {
        const parsed = parseCssColor(token, vars)
        if (!parsed) continue
        const usage = prop.startsWith('--') ? classifyVarName(prop) : classifySelector(selector, prop)
        const confidence: BrandColorEvidence['confidence'] =
          usage === 'primary_cta' || usage === 'brand_token' || usage === 'logo' ? 'high' : 'medium'
        pushEvidence(evidence, parsed, usage, prop.startsWith('--') ? 'css_variable' : 'stylesheet', confidence, {
          property: prop,
          selectorHint: selector.slice(0, 80),
        })
      }
    }
  }

  // Inline styles
  for (const match of html.matchAll(/\bstyle\s*=\s*["']([^"']+)["']/gi)) {
    const style = match[1]
    for (const decl of style.matchAll(/\b(background(?:-color)?|color|border-color|fill|stroke)\s*:\s*([^;]+)/gi)) {
      const parsed = parseCssColor(decl[2].trim(), vars)
      if (!parsed) continue
      pushEvidence(evidence, parsed, 'supporting', 'inline_style', 'medium', { property: decl[1] })
    }
  }

  // SVG fills/strokes with literal colors
  for (const match of html.matchAll(/\b(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi)) {
    const parsed = parseCssColor(match[1], vars)
    if (!parsed || isNearNeutral(parsed.hex)) continue
    pushEvidence(evidence, parsed, 'logo', 'svg', 'medium', { property: 'fill/stroke' })
  }

  // Theme-color meta
  const themeColor = html.match(/<meta\b[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)?.[1]
  if (themeColor) {
    const parsed = parseCssColor(themeColor, vars)
    if (parsed) {
      pushEvidence(evidence, parsed, 'brand_token', 'html_attribute', 'high', { property: 'theme-color' })
    }
  }

  return evidence
}

function clusterKey(hex: string): string {
  const hsl = hexToHsl(hex)
  if (!hsl) return hex
  // Perceptual-ish bucket
  return `${Math.round(hsl.h / 12)}_${Math.round(hsl.s * 8)}_${Math.round(hsl.l * 8)}`
}

type RankedColor = {
  hex: string
  score: number
  usages: Set<BrandColorUsage>
  count: number
  confidence: number
}

function rankBrandColors(evidence: BrandColorEvidence[]): RankedColor[] {
  const map = new Map<string, RankedColor>()
  for (const item of evidence) {
    if (item.alpha < 0.5) continue
    const key = clusterKey(item.hex)
    const existing = map.get(key)
    const conf = item.confidence === 'high' ? 3 : item.confidence === 'medium' ? 2 : 1
    const add = scoreUsage(item.usage) + conf * 5
    if (!existing) {
      map.set(key, {
        hex: item.hex,
        score: add,
        usages: new Set([item.usage]),
        count: 1,
        confidence: conf,
      })
    } else {
      existing.score += add
      existing.count += 1
      existing.usages.add(item.usage)
      existing.confidence = Math.max(existing.confidence, conf)
      // Prefer higher-chroma / non-neutral exemplar
      if (!isNearNeutral(item.hex) && isNearNeutral(existing.hex)) existing.hex = item.hex
    }
  }
  return [...map.values()]
    .filter((c) => !isNearNeutral(c.hex) || c.usages.has('brand_token') || c.usages.has('primary_cta'))
    .sort((a, b) => b.score - a.score)
}

function pickDistinct(from: RankedColor[], avoid: string[], minDist = 28): string | null {
  for (const candidate of from) {
    const hsl = hexToHsl(candidate.hex)
    if (!hsl) continue
    const ok = avoid.every((hex) => {
      const other = hexToHsl(hex)
      if (!other) return true
      let dh = Math.abs(hsl.h - other.h)
      if (dh > 180) dh = 360 - dh
      const dist = dh + Math.abs(hsl.s - other.s) * 40 + Math.abs(hsl.l - other.l) * 50
      return dist >= minDist
    })
    if (ok) return candidate.hex
  }
  return from[0]?.hex || null
}

function companionSecondary(primary: string, preferDark: boolean): string {
  const hsl = hexToHsl(primary)
  if (!hsl) return preferDark ? '#0f2c4d' : '#e2e8f0'
  if (preferDark) {
    // Deep navy/charcoal companion sharing a hint of brand hue
    return hslToHex(hsl.h, Math.min(0.45, hsl.s * 0.55 + 0.15), 0.16)
  }
  return hslToHex(hsl.h, Math.min(0.25, hsl.s * 0.35), 0.9)
}

function deriveAccent(primary: string, secondary: string, candidates: RankedColor[]): string {
  const fromCandidates = pickDistinct(
    candidates.filter((c) => c.usages.has('accent_token') || c.usages.has('banner') || c.usages.has('heading')),
    [primary, secondary],
    24
  )
  if (fromCandidates) return fromCandidates
  const any = pickDistinct(candidates, [primary, secondary], 30)
  if (any) return any
  const hsl = hexToHsl(primary)
  if (!hsl) return '#cca43b'
  return hslToHex((hsl.h + 38) % 360, Math.min(0.85, hsl.s + 0.15), Math.min(0.55, Math.max(0.38, hsl.l)))
}

function repairLightTriplet(t: Triplet): Triplet {
  let primary = expandHex(t.primary) || t.primary
  let secondary = expandHex(t.secondary) || t.secondary
  let accent = expandHex(t.accent) || t.accent

  // Primary as Home description text on white
  primary = ensureContrast(primary, LIGHT_BG, 4.5, true)
  // Secondary as Home name on white + button label on Primary fill
  secondary = ensureContrast(secondary, LIGHT_BG, 4.5, true)
  secondary = ensureContrast(secondary, primary, 3, relativeLuminance(primary) > 0.5)
  // Accent fill with Secondary glyph/text
  if (contrastRatio(secondary, accent) < 3) {
    accent = ensureContrast(accent, secondary, 3, relativeLuminance(secondary) > 0.5)
    if (contrastRatio(secondary, accent) < 3) {
      secondary = ensureContrast(secondary, accent, 3, relativeLuminance(accent) > 0.45)
    }
  }
  return { primary, secondary, accent }
}

function repairDarkTriplet(light: Triplet, brandPrimary: string, brandAccent: string): Triplet {
  const pHsl = hexToHsl(brandPrimary) || hexToHsl(light.primary)
  const aHsl = hexToHsl(brandAccent) || hexToHsl(light.accent)
  let primary = pHsl
    ? hslToHex(pHsl.h, Math.min(0.75, pHsl.s + 0.05), Math.max(0.55, Math.min(0.78, pHsl.l + 0.18)))
    : light.primary
  let accent = aHsl
    ? hslToHex(aHsl.h, Math.min(0.8, aHsl.s + 0.05), Math.max(0.5, Math.min(0.72, aHsl.l + 0.12)))
    : light.accent
  let secondary = companionSecondary(brandPrimary || light.primary, false)

  primary = ensureContrast(primary, DARK_BG, 4.5, false)
  // Secondary is light text/icons on Primary & Accent fills in dark mode
  secondary = ensureContrast(secondary, primary, 3, relativeLuminance(primary) > 0.5)
  secondary = ensureContrast(secondary, accent, 3, relativeLuminance(accent) > 0.5)
  // Also keep secondary readable if used as control chrome on dark bg
  if (contrastRatio(secondary, DARK_BG) < 3) {
    secondary = ensureContrast(secondary, DARK_BG, 3, false)
  }
  return { primary, secondary, accent }
}

/**
 * Build light+dark themeRecommendation from website HTML/CSS evidence.
 */
export function themeRecommendationFromWebsite(
  html: string,
  linkedCss = ''
): { recommendation: ThemeRec; evidence: BrandColorEvidence[] } | null {
  const evidence = extractBrandColorEvidence(html, linkedCss)
  const ranked = rankBrandColors(evidence)
  if (!ranked.length) return null

  const primaryPool = ranked.filter(
    (c) =>
      c.usages.has('brand_token') ||
      c.usages.has('primary_cta') ||
      c.usages.has('logo') ||
      c.usages.has('navigation') ||
      c.usages.has('header')
  )
  const brandPrimary = (primaryPool[0] || ranked[0]).hex

  const secondaryPool = ranked.filter(
    (c) =>
      c.hex !== brandPrimary &&
      (c.usages.has('navigation') ||
        c.usages.has('header') ||
        c.usages.has('footer') ||
        c.usages.has('supporting') ||
        relativeLuminance(c.hex) < 0.35)
  )
  let brandSecondary = pickDistinct(secondaryPool, [brandPrimary], 20) || companionSecondary(brandPrimary, true)
  if (relativeLuminance(brandSecondary) > 0.45) {
    brandSecondary = companionSecondary(brandPrimary, true)
  }

  const brandAccent = deriveAccent(brandPrimary, brandSecondary, ranked)

  const light = repairLightTriplet({
    primary: brandPrimary,
    secondary: brandSecondary,
    accent: brandAccent,
  })
  const dark = repairDarkTriplet(light, brandPrimary, brandAccent)

  const topHex = ranked.slice(0, 8).map((c) => c.hex)
  return {
    recommendation: {
      light,
      dark,
      source: 'website',
      notes: `Brand colors inferred from website CSS/HTML (${evidence.length} signals). Candidates: ${topHex.join(', ')}. Roles mapped for vBiz Primary/Secondary/Accent with contrast repair.`,
    },
    evidence,
  }
}

/** Stylesheet URLs linked from HTML (same-origin preferred by caller). */
export function extractStylesheetUrls(html: string, baseUrl: string, limit = 4): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(/<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*>/gi)) {
    const href = match[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href || href.startsWith('data:')) continue
    try {
      const abs = new URL(href, baseUrl).toString()
      if (seen.has(abs)) continue
      seen.add(abs)
      out.push(abs)
      if (out.length >= limit) break
    } catch {
      /* ignore */
    }
  }
  return out
}

/** Compact block for AI corpus + deterministic resolve. */
export function formatBrandColorResearchBlock(recommendation: ThemeRec | null, evidence: BrandColorEvidence[]): string {
  const lines = ['BRAND COLOR RESEARCH (deterministic website extraction — prefer these for themeRecommendation):']
  if (!recommendation && !evidence.length) {
    lines.push('- No brand colors resolved from website CSS/HTML.')
    return lines.join('\n')
  }
  if (recommendation) {
    lines.push(
      `- Recommended light Primary/Secondary/Accent: ${recommendation.light.primary} / ${recommendation.light.secondary} / ${recommendation.light.accent}`
    )
    lines.push(
      `- Recommended dark Primary/Secondary/Accent: ${recommendation.dark.primary} / ${recommendation.dark.secondary} / ${recommendation.dark.accent}`
    )
    lines.push('- Map into themeRecommendation with source "website" unless PDF/document lists exact Light/Dark roles.')
    lines.push(
      '- vBiz roles: Primary=main CTA/nav/Home description; Secondary=banners/Home name/button text·icons; Accent=My vCard + social fills. Preserve brand hue; keep WCAG-minded contrast.'
    )
  }
  const top = evidence
    .filter((e) => e.confidence !== 'low')
    .slice(0, 14)
    .map((e) => `${e.hex} (${e.usage}, ${e.format})`)
  if (top.length) lines.push(`- Evidence: ${top.join('; ')}`)
  return lines.join('\n')
}

/** Soften primary chroma slightly for readability when overly neon. */
export function toneDownIfHarsh(hex: string): string {
  const hsl = hexToHsl(hex)
  if (!hsl) return hex
  if (hsl.s > 0.9 && hsl.l > 0.45 && hsl.l < 0.7) {
    return adjustLightness(hslToHex(hsl.h, 0.78, hsl.l), hsl.l)
  }
  return hex
}
