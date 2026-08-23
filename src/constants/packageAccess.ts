export const PACKAGE_ACCESS_FEATURES = [
  { key: 'allow_ai_assistance', label: 'AI assistance' },
  { key: 'allow_canva', label: 'Canva feature' },
  { key: 'allow_push_notification', label: 'Push notification' },
  { key: 'allow_email_notification', label: 'Email notification' },
  { key: 'allow_support_ticket', label: 'Contact support ticket' },
  { key: 'allow_auto_card_builder', label: 'Auto card builder' },
  { key: 'allow_seo', label: 'SEO' },
] as const

export type PackageAccessKey = (typeof PACKAGE_ACCESS_FEATURES)[number]['key']

export type PackageAccessMap = Record<PackageAccessKey, boolean>

export const CARD_LIMIT_FEATURE_KEY = 'max_cards'

export const CORPORATE_LIMIT_OVERRIDE_KEYS = ['max_social_links', 'max_extra_fields', 'max_file_size_mb'] as const

export type CorporateLimitOverrideKey = (typeof CORPORATE_LIMIT_OVERRIDE_KEYS)[number]

export const RETIRED_PACKAGE_SLUGS = ['corporate-starter', 'single-starter'] as const

export const PACKAGE_MEDIA_FEATURE_KEYS = [
  'allow_video_upload',
  'allow_2d_explainer',
  'allow_background_video_upload',
  'allow_intro_video_upload',
  'allow_music_upload',
  'allow_bg_music_upload',
  'allow_yt_bg_music_upload',
] as const

export type PackageMediaFeatureKey = (typeof PACKAGE_MEDIA_FEATURE_KEYS)[number]

/** Missing rows stay allowed when paid; backfill inserts these as explicit `1` without overwriting existing 0s. */
export const EXPLICIT_ALLOW_FLAG_KEYS = [
  ...PACKAGE_ACCESS_FEATURES.map((item) => item.key),
  ...PACKAGE_MEDIA_FEATURE_KEYS,
] as const

const ACCESS_KEY_SET = new Set<string>(PACKAGE_ACCESS_FEATURES.map((item) => item.key))
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSY = new Set(['0', 'false', 'no', 'off', 'disabled'])

export function isPackageAccessKey(key: string): key is PackageAccessKey {
  return ACCESS_KEY_SET.has(key.trim().toLowerCase())
}

export function allPackageAccessEnabled(): PackageAccessMap {
  return Object.fromEntries(PACKAGE_ACCESS_FEATURES.map((item) => [item.key, true])) as PackageAccessMap
}

export function parseAccessFlag(value: string | null | undefined, whenMissing = true): boolean {
  if (value == null || String(value).trim() === '') return whenMissing
  const normalized = String(value).trim().toLowerCase()
  if (FALSY.has(normalized)) return false
  if (TRUTHY.has(normalized)) return true
  return whenMissing
}

export function allPackageAccessDisabled(): PackageAccessMap {
  return Object.fromEntries(PACKAGE_ACCESS_FEATURES.map((item) => [item.key, false])) as PackageAccessMap
}

export function entitlementsFromFeatures(
  features: { featureKey: string; featureValue?: string | null }[] | undefined | null,
  whenMissing = true
): PackageAccessMap {
  const map = whenMissing ? allPackageAccessEnabled() : allPackageAccessDisabled()
  // Premium add-on: missing allow_ai_assistance stays locked unless explicitly enabled.
  map.allow_ai_assistance = false
  if (!features?.length) return map
  for (const item of PACKAGE_ACCESS_FEATURES) {
    const row = features.find((feature) => feature.featureKey.trim().toLowerCase() === item.key)
    if (!row) continue
    const defaultWhenMissing = item.key === 'allow_ai_assistance' ? false : whenMissing
    map[item.key] = parseAccessFlag(row.featureValue, defaultWhenMissing)
  }
  return map
}

/** Default explicit allow_* featureValue used when backfilling missing package flags. */
export function defaultAllowFlagValue(featureKey: string): '0' | '1' {
  return featureKey.trim().toLowerCase() === 'allow_ai_assistance' ? '0' : '1'
}

export function isUnlimitedFeatureValue(value: string | null | undefined): boolean {
  if (value == null || String(value).trim() === '') return true
  const raw = String(value).trim().toLowerCase()
  return raw === 'unlimited' || raw === '-1'
}
