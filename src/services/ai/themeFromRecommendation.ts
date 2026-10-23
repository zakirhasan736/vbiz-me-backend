import type { MasterBusinessProfile } from './businessProfile.schema'
import { contrastRatio, ensureContrast, relativeLuminance } from './cssColorParse'

type ThemeTriplet = { primary?: string; secondary?: string; accent?: string }

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!HEX_RE.test(trimmed)) return null
  if (trimmed.length === 4) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase()
  }
  return trimmed.toLowerCase()
}

/**
 * vBiz roles are paired, not independent:
 * Secondary is the text/icon color ON Primary and Accent fills.
 * Prefer shifting Secondary lightness (same hue) before a hard fallback.
 */
function ensureReadableSecondary(fill: string, secondary: string): string {
  if (contrastRatio(fill, secondary) >= 3) return secondary
  const preferDarker = relativeLuminance(fill) > 0.5
  const adjusted = ensureContrast(secondary, fill, 3, preferDarker)
  if (contrastRatio(fill, adjusted) >= 3) return adjusted
  return preferDarker ? '#0f2c4d' : '#f4f4f5'
}

function resolveTriplet(
  recommended: ThemeTriplet | undefined,
  fallback: { primary: string; secondary: string; accent: string },
  mode: 'light' | 'dark'
) {
  let primary = normalizeHex(recommended?.primary) || fallback.primary
  let secondary = normalizeHex(recommended?.secondary) || fallback.secondary
  let accent = normalizeHex(recommended?.accent) || fallback.accent
  const pageBg = mode === 'light' ? '#ffffff' : '#020914'
  // Primary = Home description text on page; Secondary = Home name (light) + control chrome.
  primary = ensureContrast(primary, pageBg, 4.5, mode === 'light')
  secondary = ensureContrast(secondary, pageBg, mode === 'light' ? 4.5 : 3, mode === 'light')
  // Critical pairs: Secondary on Primary fill, Secondary on Accent fill.
  secondary = ensureReadableSecondary(primary, secondary)
  secondary = ensureReadableSecondary(accent, secondary)
  // If Accent is too close to Primary, nudge Accent so highlights stay distinct.
  if (contrastRatio(primary, accent) < 1.4) {
    accent = ensureContrast(accent, primary, 1.6, relativeLuminance(primary) > 0.5)
  }
  return { primary, secondary, accent }
}

/** Sources that may overwrite Card Settings → Global Color. Pure AI "suggestion" never does. */
export const BRAND_THEME_APPLY_SOURCES = ['document', 'website', 'logo', 'mixed'] as const

export type BrandThemeApplySource = (typeof BRAND_THEME_APPLY_SOURCES)[number]

export function isBrandThemeApplySource(source: string | null | undefined): source is BrandThemeApplySource {
  return Boolean(source && (BRAND_THEME_APPLY_SOURCES as readonly string[]).includes(source))
}

function recommendationHasHex(
  recommendation: MasterBusinessProfile['themeRecommendation'] | null | undefined
): boolean {
  if (!recommendation || typeof recommendation !== 'object') return false
  return Boolean(
    normalizeHex(recommendation.light?.primary) ||
    normalizeHex(recommendation.light?.secondary) ||
    normalizeHex(recommendation.light?.accent) ||
    normalizeHex(recommendation.dark?.primary) ||
    normalizeHex(recommendation.dark?.secondary) ||
    normalizeHex(recommendation.dark?.accent)
  )
}

/**
 * Only apply Global Color when PDF/document, website CSS research, or logo evidence
 * produced the palette. If no website URL and docs say nothing about colors, keep
 * the platform's existing default themeConfig untouched.
 */
export function shouldApplyBrandThemeConfig(
  recommendation: MasterBusinessProfile['themeRecommendation'] | null | undefined
): boolean {
  return isBrandThemeApplySource(recommendation?.source) && recommendationHasHex(recommendation)
}

/**
 * Map AI themeRecommendation (light+dark primary/secondary/accent) into vBiz Me themeConfig.
 * Preserves default backgrounds/surfaces/components; only brand role colors are replaced.
 */
export function themeConfigFromRecommendation(
  recommendation: MasterBusinessProfile['themeRecommendation'] | null | undefined
): Record<string, unknown> | null {
  if (!recommendation || typeof recommendation !== 'object') return null
  const lightRec = recommendation.light
  const darkRec = recommendation.dark
  const hasAny =
    Boolean(normalizeHex(lightRec?.primary)) ||
    Boolean(normalizeHex(lightRec?.secondary)) ||
    Boolean(normalizeHex(lightRec?.accent)) ||
    Boolean(normalizeHex(darkRec?.primary)) ||
    Boolean(normalizeHex(darkRec?.secondary)) ||
    Boolean(normalizeHex(darkRec?.accent))
  if (!hasAny) return null

  const light = resolveTriplet(
    lightRec,
    {
      primary: '#eed677',
      secondary: '#0f2c4d',
      accent: '#cca43b',
    },
    'light'
  )
  const dark = resolveTriplet(
    darkRec,
    {
      primary: light.primary,
      secondary: '#e2e8f0',
      accent: light.accent,
    },
    'dark'
  )

  return {
    version: 1,
    colors: {
      defaultMode: 'dark',
      light: {
        primary: light.primary,
        secondary: light.secondary,
        accent: light.accent,
        background: '#ffffff',
        surface: '#f4f5f7',
        text: '#0b0b0d',
        textMuted: '#52525b',
        border: '#e4e4e7',
        overlay: 'rgba(0,0,0,0.35)',
      },
      dark: {
        primary: dark.primary,
        secondary: dark.secondary,
        accent: dark.accent,
        background: '#020914',
        surface: '#0b1626',
        text: '#f4f4f5',
        textMuted: '#a1a1aa',
        border: '#1e293b',
        overlay: 'rgba(0,0,0,0.55)',
      },
    },
    components: {
      button: {
        primary: {
          style: 'filled',
          colors: {
            light: {
              fill: 'primary',
              foreground: 'secondary',
              borderColor: 'primary',
              hoverOverlay: 'rgba(0,0,0,0.08)',
            },
            dark: {
              fill: 'primary',
              foreground: 'secondary',
              borderColor: 'primary',
              hoverOverlay: 'rgba(255,255,255,0.10)',
            },
          },
        },
        secondary: {
          style: 'filled',
          colors: {
            light: {
              fill: 'secondary',
              foreground: 'auto',
              borderColor: 'secondary',
              hoverOverlay: 'rgba(0,0,0,0.08)',
            },
            dark: {
              fill: 'secondary',
              foreground: 'auto',
              borderColor: 'secondary',
              hoverOverlay: 'rgba(255,255,255,0.10)',
            },
          },
        },
        accent: {
          style: 'filled',
          colors: {
            light: {
              fill: 'accent',
              foreground: 'secondary',
              borderColor: 'accent',
              hoverOverlay: 'rgba(0,0,0,0.08)',
            },
            dark: {
              fill: 'accent',
              foreground: 'secondary',
              borderColor: 'accent',
              hoverOverlay: 'rgba(255,255,255,0.10)',
            },
          },
        },
      },
      socialIcon: {
        style: 'filled',
        iconSize: 22,
        size: 40,
        cornerRadius: 9999,
        colors: {
          light: {
            fill: 'primary',
            foreground: 'secondary',
            borderColor: 'auto',
            hoverOverlay: 'rgba(0,0,0,0.10)',
          },
          dark: {
            fill: 'primary',
            foreground: 'secondary',
            borderColor: 'auto',
            hoverOverlay: 'rgba(255,255,255,0.12)',
          },
        },
      },
    },
    appearance: {
      profileTemplate: 'v3',
      layoutStyle: 'classic',
      buttonStyle: 'solid',
      cornerStyle: 'round',
      fontFamily: 'inter',
      buttonShadow: 'none',
    },
    aiThemeMeta: {
      source: recommendation.source || 'suggestion',
      notes: recommendation.notes || '',
    },
  }
}
