import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const MAX_CARDS_FEATURE_KEY = 'max_cards'
const CORPORATE_STARTER_SLUG = 'corporate-starter'
const SINGLE_STARTER_SLUG = 'single-starter'

const activeSubscriptionWhere = (userId: string, now = new Date()) => ({
  userId,
  OR: [{ endsAt: null }, { endsAt: { gt: now } }],
})

const parseMaxCardsQuantity = (features: { featureKey: string; featureValue: string | null }[]): number | null => {
  const feature = features.find((f) => f.featureKey.trim().toLowerCase() === MAX_CARDS_FEATURE_KEY)
  if (feature?.featureValue == null || String(feature.featureValue).trim() === '') return null
  const parsed = Number.parseInt(String(feature.featureValue).trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

/**
 * Prefer a free package matching the requested slug. Corporate Starter and
 * Single Starter are retired; the fallback is another free active package with
 * a compatible card limit so a paid plan is never granted accidentally.
 */
const findStarterPackage = async (slug: string, acceptsCardLimit: (limit: number | null) => boolean) => {
  const bySlug = await prisma.package.findFirst({
    where: { slug, isActive: true, monthlyPrice: 0, yearlyPrice: 0 },
    include: { features: true },
  })
  if (bySlug && acceptsCardLimit(parseMaxCardsQuantity(bySlug.features))) return bySlug

  const freePackages = await prisma.package.findMany({
    where: { isActive: true, monthlyPrice: 0, yearlyPrice: 0 },
    include: { features: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return freePackages.find((pkg) => acceptsCardLimit(parseMaxCardsQuantity(pkg.features))) ?? null
}

/**
 * Creates a starter subscription only when the owner has no active subscription.
 * Existing subscriptions are never rewritten, including paid or imported plans.
 */
const ensureStarterSubscription = async (
  userId: string,
  slug: string,
  acceptsCardLimit: (limit: number | null) => boolean
) => {
  const now = new Date()
  const existing = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(userId, now),
    include: { package: { include: { features: true } } },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) return existing

  const starterPackage = await findStarterPackage(slug, acceptsCardLimit)
  if (!starterPackage) {
    logger.warn(`No active free ${slug} package or compatible fallback found for user ${userId}`)
    return null
  }

  const quantity = parseMaxCardsQuantity(starterPackage.features)

  return prisma.subscription.create({
    data: {
      userId,
      packageId: starterPackage.id,
      name: starterPackage.name,
      provider: 'admin',
      stripeStatus: 'active',
      endsAt: null,
      ...(quantity != null ? { quantity } : {}),
    },
    include: { package: { include: { features: true } } },
  })
}

const ensureCorporateStarterSubscription = (userId: string) =>
  ensureStarterSubscription(userId, CORPORATE_STARTER_SLUG, (limit) => limit != null && limit > 1)

const ensureSingleStarterSubscription = (userId: string) =>
  ensureStarterSubscription(userId, SINGLE_STARTER_SLUG, (limit) => limit === 1)

const ensureOwnerStarterSubscription = (userId: string, role: string) => {
  if (role === 'corporate-owner') return ensureCorporateStarterSubscription(userId)
  if (role === 'vcard-owner') return ensureSingleStarterSubscription(userId)
  return Promise.resolve(null)
}

const subscriptionService = {
  ensureCorporateStarterSubscription,
  ensureSingleStarterSubscription,
  ensureOwnerStarterSubscription,
  MAX_CARDS_FEATURE_KEY,
  CORPORATE_STARTER_SLUG,
  SINGLE_STARTER_SLUG,
}

export default subscriptionService
