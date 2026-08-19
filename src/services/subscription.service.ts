import { RETIRED_PACKAGE_SLUGS } from '../constants/packageAccess'
import {
  CORPORATE_CATALOG_SLUG,
  FREE_CATALOG_SLUG,
  parsePackageMaxCards,
  resolveOwnerMode,
  resolveProvisionCardQuantity,
} from '../constants/packageOwnerMode'
import AppError from '../error/AppError'
import { adminAssignBilling } from '../utils/billingQuote'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const CORPORATE_STARTER_SLUG = 'corporate-starter'
const SINGLE_STARTER_SLUG = 'single-starter'

const activeSubscriptionWhere = (userId: string, now = new Date()) => ({
  userId,
  OR: [{ endsAt: null }, { endsAt: { gt: now } }],
})

const findCatalogPackage = async (slug: string) => {
  return prisma.package.findFirst({
    where: { slug, isActive: true },
    include: { features: true },
  })
}

/**
 * Creates a catalog subscription only when the owner has no active subscription.
 * Existing subscriptions are never rewritten. Corporate owners are never attached to Free.
 */
const ensureCatalogSubscription = async (
  userId: string,
  slug: typeof FREE_CATALOG_SLUG | typeof CORPORATE_CATALOG_SLUG
) => {
  const now = new Date()
  const existing = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(userId, now),
    include: { package: { include: { features: true } } },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) return existing

  const catalogPackage = await findCatalogPackage(slug)
  if (!catalogPackage) {
    logger.warn(`No active ${slug} package found for user ${userId}`)
    return null
  }

  const ownerMode = resolveOwnerMode(catalogPackage)
  const quantity = resolveProvisionCardQuantity({
    ownerMode,
    packageMaxCards: parsePackageMaxCards(catalogPackage.features),
  })

  return prisma.subscription.create({
    data: {
      userId,
      packageId: catalogPackage.id,
      name: catalogPackage.name,
      provider: 'admin',
      stripeStatus: 'active',
      endsAt: null,
      ...(quantity != null ? { quantity } : {}),
    },
    include: { package: { include: { features: true } } },
  })
}

const ensureCorporateStarterSubscription = (userId: string) => ensureCatalogSubscription(userId, CORPORATE_CATALOG_SLUG)

const ensureSingleStarterSubscription = (userId: string) => ensureCatalogSubscription(userId, FREE_CATALOG_SLUG)

const ensureOwnerStarterSubscription = (userId: string, role: string) => {
  if (role === 'corporate-owner') return ensureCorporateStarterSubscription(userId)
  if (role === 'vcard-owner') return ensureSingleStarterSubscription(userId)
  return Promise.resolve(null)
}

const loadAssignablePackage = async (packageId: string) => {
  const pkg = await prisma.package.findFirst({
    where: { id: packageId },
    include: { features: true },
  })
  if (!pkg) throw new AppError(404, 'Package not found')
  if (!pkg.isActive) throw new AppError(400, 'That package is not active')
  const slug = (pkg.slug || '').trim().toLowerCase()
  if ((RETIRED_PACKAGE_SLUGS as readonly string[]).includes(slug)) {
    throw new AppError(400, 'That package is retired. Choose Free, Professional, Concierge, or Corporate.')
  }
  return pkg
}

const assignPackageSubscription = async (
  userId: string,
  packageId: string,
  options?: {
    cardLimit?: number | null
    negotiatedMonthlyCents?: number | null
    negotiatedSignupFeeCents?: number | null
  }
) => {
  const pkg = await loadAssignablePackage(packageId)
  const ownerMode = resolveOwnerMode(pkg)
  const packageMaxCards = parsePackageMaxCards(pkg.features)
  const quantity = resolveProvisionCardQuantity({
    ownerMode,
    packageMaxCards,
    cardLimit: options?.cardLimit,
  })

  const existing = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(userId),
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    throw new AppError(400, 'This account already has an active subscription')
  }

  const negotiatedMonthlyCents =
    ownerMode === 'corporate' && options?.negotiatedMonthlyCents != null
      ? Math.max(0, Math.round(Number(options.negotiatedMonthlyCents) || 0))
      : null
  const negotiatedSignupFeeCents =
    ownerMode === 'corporate' && options?.negotiatedSignupFeeCents != null
      ? Math.max(0, Math.round(Number(options.negotiatedSignupFeeCents) || 0))
      : null

  const billing = adminAssignBilling({
    monthlyPrice: pkg.monthlyPrice,
    signupFeeCents: pkg.signupFeeCents,
    ownerMode,
    negotiatedMonthlyCents,
    negotiatedSignupFeeCents,
  })

  return prisma.subscription.create({
    data: {
      userId,
      packageId: pkg.id,
      name: pkg.name,
      provider: billing.provider,
      stripeStatus: billing.stripeStatus,
      endsAt: null,
      ...(quantity != null ? { quantity } : {}),
      ...(negotiatedMonthlyCents != null ? { negotiatedMonthlyCents } : {}),
      ...(negotiatedSignupFeeCents != null ? { negotiatedSignupFeeCents } : {}),
    },
    include: { package: { include: { features: true } } },
  })
}

const subscriptionService = {
  ensureCorporateStarterSubscription,
  ensureSingleStarterSubscription,
  ensureOwnerStarterSubscription,
  assignPackageSubscription,
  loadAssignablePackage,
  CORPORATE_STARTER_SLUG,
  SINGLE_STARTER_SLUG,
}

export default subscriptionService
