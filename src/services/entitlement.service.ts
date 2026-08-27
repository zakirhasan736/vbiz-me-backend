import { PACKAGE_ACCESS_FEATURES, type PackageAccessKey, type PackageAccessMap } from '../constants/packageAccess'
import {
  FEATURE_NOT_INCLUDED_MESSAGE,
  featureLimitReachedError,
  featureNotIncludedError,
} from '../constants/packageErrors'
import { canUseCorporateBackOffice, type OwnerMode } from '../constants/packageOwnerMode'
import { isStaffRole, toApiRole } from '../constants/userRole'
import AppError from '../error/AppError'
import {
  sanitizeCorporateFeatureOverrides,
  type CorporateFeatureOverrideInput,
} from '../utils/corporateFeatureOverrides'
import {
  buildEffectiveEntitlements,
  isCatalogFeatureAllowed,
  staffEntitlements,
  type EffectiveEntitlements,
} from '../utils/effectiveEntitlements'
import {
  catalogGateSatisfied,
  firstDeniedFeatureKey,
  guessUploadedKind,
  mediaUploadCatalogGate,
  type MediaCatalogGate,
} from '../utils/mediaFeatureGates'
import { maxUploadBytes } from '../utils/packageLimits'
import { isPaidAccess } from '../utils/paidAccess'
import { prisma } from '../utils/prisma'

export { buildEffectiveEntitlements, isCatalogFeatureAllowed, staffEntitlements } from '../utils/effectiveEntitlements'
export type { EffectiveEntitlements, EntitlementCatalogInput, EntitlementLimits } from '../utils/effectiveEntitlements'

export async function getEffectiveEntitlements(userId: string, role?: string | null): Promise<EffectiveEntitlements> {
  if (isStaffRole(role)) return staffEntitlements()

  const now = new Date()
  const [subscriptionRows, overrideRows, cardsUsed] = await Promise.all([
    prisma.subscription.findMany({
      where: {
        userId,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      include: { package: { include: { features: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.corporateFeatureOverride.findMany({ where: { userId } }),
    prisma.profile.count({ where: { OR: [{ userId }, { companyUserId: userId }] } }),
  ])

  const paidSubscription =
    subscriptionRows.find((row) =>
      isPaidAccess({ endsAt: row.endsAt, provider: row.provider, stripeStatus: row.stripeStatus })
    ) || null
  const assigned = paidSubscription || subscriptionRows[0] || null
  const pkg = assigned?.package
    ? {
        id: assigned.package.id,
        slug: assigned.package.slug,
        name: assigned.package.name,
        ownerMode: assigned.package.ownerMode,
      }
    : null

  return buildEffectiveEntitlements({
    role,
    pkg,
    features: assigned?.package?.features,
    subscription: assigned
      ? {
          id: assigned.id,
          quantity: assigned.quantity,
          endsAt: assigned.endsAt,
          provider: assigned.provider,
          stripeStatus: assigned.stripeStatus,
        }
      : null,
    overrides: overrideRows,
    cardsUsed,
  })
}

export async function getUserPackageAccess(userId: string, role?: string | null): Promise<PackageAccessMap> {
  const entitlements = await getEffectiveEntitlements(userId, role)
  return entitlements.access
}

export async function assertUserPackageAccess(
  userId: string,
  role: string | null | undefined,
  key: PackageAccessKey,
  message?: string
): Promise<void> {
  const entitlements = await getEffectiveEntitlements(userId, role)
  if (entitlements.access[key]) return
  const label = PACKAGE_ACCESS_FEATURES.find((item) => item.key === key)?.label || key
  throw featureNotIncludedError(key, message || `${label} is not included in your package.`)
}

export async function getProfileOwnerEntitlements(profileId: string): Promise<EffectiveEntitlements | null> {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      userId: true,
      companyUserId: true,
      user: { select: { role: true } },
      companyUser: { select: { role: true } },
    },
  })
  if (!profile) return null
  const ownerId = profile.companyUserId || profile.userId
  if (!ownerId) return null
  const owner = profile.companyUserId && profile.companyUser ? profile.companyUser : profile.user
  return getEffectiveEntitlements(ownerId, owner ? toApiRole(owner.role) : null)
}

export async function assertProfileOwnerPackageAccess(
  profileId: string,
  key: PackageAccessKey,
  message?: string
): Promise<void> {
  const entitlements = await getProfileOwnerEntitlements(profileId)
  if (!entitlements) throw new AppError(404, 'Profile not found')
  if (entitlements.access[key]) return
  const label = PACKAGE_ACCESS_FEATURES.find((item) => item.key === key)?.label || key
  throw featureNotIncludedError(key, message || `${label} is not included in your package.`)
}

export async function profileOwnerAllowsPackageAccess(profileId: string, key: PackageAccessKey): Promise<boolean> {
  const entitlements = await getProfileOwnerEntitlements(profileId)
  if (!entitlements) return false
  return entitlements.access[key]
}

export async function assertCountWithinPackageLimit(
  userId: string,
  role: string | null | undefined,
  key: 'maxSocialLinks' | 'maxExtraFields',
  count: number,
  message?: string
): Promise<void> {
  if (isStaffRole(role)) return
  const entitlements = await getEffectiveEntitlements(userId, role)
  const limit = entitlements.limits[key]
  if (limit == null || count <= limit) return
  const label = key === 'maxSocialLinks' ? 'social links' : 'extra fields'
  throw featureLimitReachedError(message || `Your package allows up to ${limit} ${label}.`, { limit, count, key })
}

export async function assertUploadWithinPackageLimit(
  userId: string,
  role: string | null | undefined,
  bytes: number
): Promise<void> {
  if (isStaffRole(role)) return
  const entitlements = await getEffectiveEntitlements(userId, role)
  const cap = maxUploadBytes(entitlements.limits.maxFileSizeMb)
  if (bytes <= cap) return
  const maxMb = Math.max(1, Math.round(cap / (1024 * 1024)))
  throw featureLimitReachedError(
    `File size exceeds ${maxMb}MB for your package.`,
    { maxBytes: cap, bytes },
    { statusCode: 413 }
  )
}

export async function assertCatalogFeatureGate(
  userId: string,
  role: string | null | undefined,
  gate: MediaCatalogGate,
  message?: string
): Promise<void> {
  if (isStaffRole(role)) return
  const entitlements = await getEffectiveEntitlements(userId, role)
  const allowed = (key: string) => isCatalogFeatureAllowed(entitlements, key)
  if (catalogGateSatisfied(gate, allowed)) return
  throw featureNotIncludedError(firstDeniedFeatureKey(gate, allowed), message || FEATURE_NOT_INCLUDED_MESSAGE)
}

export async function assertMediaUploadAllowed(
  userId: string,
  role: string | null | undefined,
  input: { attachmentType?: string | null; mimetype?: string | null; filename?: string | null }
): Promise<void> {
  const gate = mediaUploadCatalogGate({
    attachmentType: input.attachmentType,
    kind: guessUploadedKind({ mimetype: input.mimetype, filename: input.filename }),
  })
  if (!gate) return
  await assertCatalogFeatureGate(userId, role, gate)
}

export async function assertOwnerMode(
  userId: string,
  role: string | null | undefined,
  required: OwnerMode,
  message?: string
): Promise<void> {
  if (isStaffRole(role)) return
  const entitlements = await getEffectiveEntitlements(userId, role)
  if (entitlements.ownerMode === required) return
  throw new AppError(
    403,
    message ||
      (required === 'corporate'
        ? 'Corporate back office is not included in your package.'
        : 'This action is not available on your package.'),
    {
      code: 'OWNER_MODE_LOCKED',
      data: { ownerMode: entitlements.ownerMode, required },
    }
  )
}

export async function setCorporateCardLimit(
  userId: string,
  role: string | null | undefined,
  cardLimit: number
): Promise<void> {
  if (!Number.isInteger(cardLimit) || cardLimit < 0) {
    throw new AppError(400, 'Card limit must be a whole number of 0 or more.')
  }
  if (isStaffRole(role)) {
    throw new AppError(400, 'Staff accounts do not use a per-account card limit.')
  }

  const entitlements = await getEffectiveEntitlements(userId, role)
  if (entitlements.ownerMode !== 'corporate') {
    throw new AppError(400, 'Per-account card limits apply only to Corporate package accounts.')
  }
  if (!entitlements.subscriptionId) {
    throw new AppError(400, 'This account has no active subscription to attach a card limit.')
  }

  await prisma.subscription.update({
    where: { id: entitlements.subscriptionId },
    data: { quantity: cardLimit },
  })
}

export async function setNegotiatedMonthlyCents(
  userId: string,
  role: string | null | undefined,
  negotiatedMonthlyCents: number | null
): Promise<void> {
  if (negotiatedMonthlyCents != null && (!Number.isInteger(negotiatedMonthlyCents) || negotiatedMonthlyCents < 0)) {
    throw new AppError(400, 'Negotiated monthly price must be a whole number of cents, 0 or more.')
  }
  if (isStaffRole(role)) {
    throw new AppError(400, 'Staff accounts do not use a negotiated monthly price.')
  }

  const entitlements = await getEffectiveEntitlements(userId, role)
  if (entitlements.ownerMode !== 'corporate') {
    throw new AppError(400, 'Negotiated monthly pricing applies only to Corporate package accounts.')
  }
  if (!entitlements.subscriptionId) {
    throw new AppError(400, 'This account has no active subscription to attach a negotiated monthly price.')
  }

  await prisma.subscription.update({
    where: { id: entitlements.subscriptionId },
    data: { negotiatedMonthlyCents },
  })
}

export async function setNegotiatedSignupFeeCents(
  userId: string,
  role: string | null | undefined,
  negotiatedSignupFeeCents: number | null
): Promise<void> {
  if (
    negotiatedSignupFeeCents != null &&
    (!Number.isInteger(negotiatedSignupFeeCents) || negotiatedSignupFeeCents < 0)
  ) {
    throw new AppError(400, 'Negotiated signup fee must be a whole number of cents, 0 or more.')
  }
  if (isStaffRole(role)) {
    throw new AppError(400, 'Staff accounts do not use a negotiated signup fee.')
  }

  const entitlements = await getEffectiveEntitlements(userId, role)
  if (entitlements.ownerMode !== 'corporate') {
    throw new AppError(400, 'Negotiated signup fees apply only to Corporate package accounts.')
  }
  if (!entitlements.subscriptionId) {
    throw new AppError(400, 'This account has no active subscription to attach a negotiated signup fee.')
  }

  await prisma.subscription.update({
    where: { id: entitlements.subscriptionId },
    data: { negotiatedSignupFeeCents },
  })
}

export { sanitizeCorporateFeatureOverrides } from '../utils/corporateFeatureOverrides'
export type { CorporateFeatureOverrideInput } from '../utils/corporateFeatureOverrides'

export async function replaceCorporateFeatureOverrides(
  userId: string,
  role: string | null | undefined,
  rows: CorporateFeatureOverrideInput[] | undefined | null
): Promise<void> {
  if (isStaffRole(role)) {
    throw new AppError(400, 'Staff accounts do not use Corporate feature overrides.')
  }

  const entitlements = await getEffectiveEntitlements(userId, role)
  if (entitlements.ownerMode !== 'corporate') {
    throw new AppError(400, 'Feature overrides apply only to Corporate package accounts.')
  }

  const next = sanitizeCorporateFeatureOverrides(rows)
  await prisma.$transaction(async (tx) => {
    await tx.corporateFeatureOverride.deleteMany({ where: { userId } })
    if (!next.length) return
    await tx.corporateFeatureOverride.createMany({
      data: next.map((row) => ({ userId, featureKey: row.featureKey, featureValue: row.featureValue })),
    })
  })
}

export async function assertCorporateBackOffice(userId: string, role?: string | null): Promise<void> {
  if (isStaffRole(role)) return
  const entitlements = await getEffectiveEntitlements(userId, role)
  if (canUseCorporateBackOffice(entitlements.ownerMode)) return
  throw new AppError(403, 'Corporate back office is not included in your package.', {
    code: 'OWNER_MODE_LOCKED',
    data: { ownerMode: entitlements.ownerMode, required: 'corporate' },
  })
}
