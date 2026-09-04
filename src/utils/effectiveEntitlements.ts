import {
  allPackageAccessEnabled,
  entitlementsFromFeatures,
  isMandatoryPackageAccess,
  isUnlimitedFeatureValue,
  parseAccessFlag,
  type PackageAccessMap,
} from '../constants/packageAccess'
import { resolveOwnerMode, type OwnerMode } from '../constants/packageOwnerMode'
import { isStaffRole } from '../constants/userRole'
import { isPaidAccess, resolveSubscriptionAccessStatus, type SubscriptionAccessStatus } from './paidAccess'

const MAX_CARDS_FEATURE_KEY = 'max_cards'

export type EntitlementLimits = {
  maxCards: number | null
  packageMaxCards: number | null
  maxSocialLinks: number | null
  maxExtraFields: number | null
  maxFileSizeMb: number | null
}

export type EffectiveFeature = {
  featureKey: string
  featureValue: string | null
  unlimited: boolean
}

export type CardCapacity = {
  limit: number | null
  used: number | null
  remaining: number | null
}

export type BackOfficeKind = 'single' | 'corporate' | 'admin'

export type EffectiveEntitlements = {
  source: 'staff' | 'subscription' | 'none'
  ownerMode: OwnerMode | null
  backOffice: BackOfficeKind | null
  packageId: string | null
  packageSlug: string | null
  packageName: string | null
  subscriptionId: string | null
  subscriptionActive: boolean
  subscriptionStatus: SubscriptionAccessStatus
  access: PackageAccessMap
  features: EffectiveFeature[]
  limits: EntitlementLimits
  overrides: { featureKey: string; featureValue: string | null }[]
  cardCapacity: CardCapacity | null
}

export type EntitlementCatalogInput = {
  role?: string | null
  pkg?: { id: string; slug?: string | null; name?: string | null; ownerMode?: string | null } | null
  features?: { featureKey: string; featureValue?: string | null }[] | null
  subscription?: {
    id: string
    quantity?: number | null
    endsAt?: Date | string | null
    stripeStatus?: string | null
    provider?: string | null
  } | null
  overrides?: { featureKey: string; featureValue?: string | null }[] | null
  cardsUsed?: number | null
}

function parseNumericLimit(value: string | null | undefined): number | null {
  if (value == null || String(value).trim() === '') return null
  const raw = String(value).trim().toLowerCase()
  if (raw === 'unlimited' || raw === '-1') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function featureValue(
  features: { featureKey: string; featureValue?: string | null }[],
  key: string
): string | null | undefined {
  return features.find((row) => row.featureKey.trim().toLowerCase() === key)?.featureValue
}

function mergeFeatures(
  packageFeatures: { featureKey: string; featureValue?: string | null }[] | undefined | null,
  overrides: { featureKey: string; featureValue?: string | null }[] | undefined | null
) {
  const merged = new Map<string, string | null | undefined>()
  for (const row of packageFeatures || []) {
    merged.set(row.featureKey.trim().toLowerCase(), row.featureValue)
  }
  for (const row of overrides || []) {
    const key = row.featureKey.trim().toLowerCase()
    if (key === MAX_CARDS_FEATURE_KEY) continue
    if (isMandatoryPackageAccess(key)) continue
    merged.set(key, row.featureValue)
  }
  return [...merged.entries()].map(([featureKey, featureValue]) => ({ featureKey, featureValue: featureValue ?? null }))
}

function toPublicFeatures(rows: { featureKey: string; featureValue: string | null }[]): EffectiveFeature[] {
  return rows.map((row) => {
    const booleanFeature = row.featureKey.startsWith('allow_')
    return {
      featureKey: row.featureKey,
      featureValue: row.featureValue,
      unlimited: booleanFeature ? false : isUnlimitedFeatureValue(row.featureValue),
    }
  })
}

function defaultMaxCardsForRole(role?: string | null): number | null {
  if (role === 'vcard-owner') return 1
  if (role === 'corporate-owner') return 0
  return null
}

function cardCapacityFor(
  ownerMode: OwnerMode | null,
  limit: number | null,
  cardsUsed: number | null | undefined
): CardCapacity | null {
  if (ownerMode !== 'corporate') return null
  const used = cardsUsed == null ? null : Math.max(0, Math.round(Number(cardsUsed) || 0))
  const remaining = limit == null || used == null ? null : Math.max(0, limit - used)
  return { limit, used, remaining }
}

export function staffEntitlements(): EffectiveEntitlements {
  return {
    source: 'staff',
    ownerMode: null,
    backOffice: 'admin',
    packageId: null,
    packageSlug: null,
    packageName: null,
    subscriptionId: null,
    subscriptionActive: true,
    subscriptionStatus: 'active',
    access: allPackageAccessEnabled(),
    features: [],
    limits: {
      maxCards: null,
      packageMaxCards: null,
      maxSocialLinks: null,
      maxExtraFields: null,
      maxFileSizeMb: null,
    },
    overrides: [],
    cardCapacity: null,
  }
}

export function isCatalogFeatureAllowed(
  entitlements: Pick<EffectiveEntitlements, 'access' | 'features' | 'subscriptionActive' | 'source'>,
  key: string
): boolean {
  const featureKey = key.trim().toLowerCase()
  if (isMandatoryPackageAccess(featureKey)) return true
  const unpaidOwner = entitlements.source !== 'staff' && !entitlements.subscriptionActive
  if (unpaidOwner && featureKey.startsWith('allow_')) return false
  if (featureKey in entitlements.access) {
    return entitlements.access[featureKey as keyof PackageAccessMap]
  }
  const row = entitlements.features.find((item) => item.featureKey === featureKey)
  const whenMissing = entitlements.source === 'staff' || entitlements.subscriptionActive
  if (!featureKey.startsWith('allow_')) return whenMissing
  return parseAccessFlag(row?.featureValue, whenMissing)
}

export function buildEffectiveEntitlements(input: EntitlementCatalogInput): EffectiveEntitlements {
  if (isStaffRole(input.role)) return staffEntitlements()

  const sub = input.subscription || null
  const paid = sub ? isPaidAccess(sub) : false
  const assignedPkg = input.pkg || null
  /** Admin-selected package is enough to use card seats; Stripe paid/unpaid is checked later. */
  const hasAssignedPackage = Boolean(assignedPkg)
  const ownerMode: OwnerMode = assignedPkg
    ? resolveOwnerMode(assignedPkg)
    : input.role === 'corporate-owner'
      ? 'corporate'
      : 'single'
  // Corporate UI overrides apply fully when paid. Paid single-owner accounts may still hold
  // allow_* add-on overrides (e.g. AI Assistance purchased via Stripe).
  const rawOverrides = !paid ? [] : input.overrides || []
  const overrides =
    ownerMode === 'single'
      ? rawOverrides.filter((row) => row.featureKey.trim().toLowerCase().startsWith('allow_'))
      : rawOverrides
  const merged = mergeFeatures(paid ? input.features : null, overrides)
  const access = entitlementsFromFeatures(merged, paid)
  const assignedFeatures = hasAssignedPackage ? input.features || [] : []

  const packageMaxCards = parseNumericLimit(featureValue(assignedFeatures, MAX_CARDS_FEATURE_KEY))
  const maxCardsFromQuantity =
    hasAssignedPackage &&
    ownerMode === 'corporate' &&
    sub?.quantity != null &&
    Number.isFinite(sub.quantity) &&
    sub.quantity >= 0
      ? sub.quantity
      : null
  const maxCards =
    ownerMode === 'corporate'
      ? (maxCardsFromQuantity ?? packageMaxCards ?? defaultMaxCardsForRole(input.role))
      : (packageMaxCards ?? defaultMaxCardsForRole(input.role))

  return {
    source: assignedPkg ? 'subscription' : 'none',
    ownerMode,
    backOffice: ownerMode,
    packageId: assignedPkg?.id || null,
    packageSlug: assignedPkg?.slug || null,
    packageName: assignedPkg?.name || null,
    subscriptionId: sub?.id || null,
    subscriptionActive: paid,
    subscriptionStatus: resolveSubscriptionAccessStatus(sub),
    access,
    features: toPublicFeatures(merged),
    limits: {
      maxCards,
      packageMaxCards,
      maxSocialLinks: parseNumericLimit(featureValue(paid ? merged : assignedFeatures, 'max_social_links')),
      maxExtraFields: parseNumericLimit(featureValue(paid ? merged : assignedFeatures, 'max_extra_fields')),
      maxFileSizeMb: parseNumericLimit(featureValue(paid ? merged : assignedFeatures, 'max_file_size_mb')),
    },
    overrides: overrides.map((row) => ({
      featureKey: row.featureKey,
      featureValue: row.featureValue ?? null,
    })),
    cardCapacity: cardCapacityFor(ownerMode, maxCards, input.cardsUsed),
  }
}
