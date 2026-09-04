import { CARD_LIMIT_FEATURE_KEY, isMandatoryPackageAccess } from '../constants/packageAccess'
import AppError from '../error/AppError'

export type CorporateFeatureOverrideInput = {
  featureKey: string
  featureValue?: string | null
}

export function sanitizeCorporateFeatureOverrides(
  rows: CorporateFeatureOverrideInput[] | undefined | null
): { featureKey: string; featureValue: string | null }[] {
  const seen = new Map<string, string | null>()
  for (const row of rows || []) {
    const featureKey = row.featureKey.trim().toLowerCase()
    if (!featureKey) continue
    if (featureKey === CARD_LIMIT_FEATURE_KEY) {
      throw new AppError(400, 'Card limits are set with the account card limit, not a package override.')
    }
    if (isMandatoryPackageAccess(featureKey)) continue
    if (!/^[a-z0-9_]{1,80}$/.test(featureKey)) {
      throw new AppError(400, `Invalid feature key: ${row.featureKey}`)
    }
    const raw = row.featureValue == null ? '' : String(row.featureValue).trim()
    if (!raw || raw.toLowerCase() === 'inherit') continue
    seen.set(featureKey, raw)
  }
  return [...seen.entries()].map(([featureKey, featureValue]) => ({ featureKey, featureValue }))
}
