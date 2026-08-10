import { prisma } from '../utils/prisma'

const MAX_CARDS_FEATURE_KEY = 'max_cards'
const CORPORATE_STARTER_SLUG = 'corporate-starter'

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

const subscriptionHasCardLimit = (sub: {
  quantity: number | null
  package: { features: { featureKey: string; featureValue: string | null }[] } | null
}): boolean => {
  if (sub.quantity != null && Number.isFinite(sub.quantity) && sub.quantity > 0) return true
  const fromFeatures = sub.package ? parseMaxCardsQuantity(sub.package.features) : null
  return fromFeatures != null && fromFeatures > 0
}

/** Prefer seeded corporate-starter, else first active package that has max_cards, else first active. */
const findCorporateStarterPackage = async () => {
  const bySlug = await prisma.package.findFirst({
    where: { slug: CORPORATE_STARTER_SLUG, isActive: true },
    include: { features: true },
  })
  if (bySlug) return bySlug

  const withLimit = await prisma.package.findMany({
    where: { isActive: true },
    include: { features: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  const withMaxCards = withLimit.find((p) => {
    const n = parseMaxCardsQuantity(p.features)
    return n != null && n > 0
  })
  if (withMaxCards) return withMaxCards

  return withLimit[0] ?? null
}

/**
 * Ensures a corporate owner has an active free subscription with a real card limit.
 * Prefers the seeded `corporate-starter` package. Repairs existing subscriptions that
 * have no max_cards / quantity so capacity is not stuck at 0.
 */
const ensureCorporateStarterSubscription = async (userId: string) => {
  const now = new Date()
  const existing = await prisma.subscription.findFirst({
    where: activeSubscriptionWhere(userId, now),
    include: { package: { include: { features: true } } },
    orderBy: { createdAt: 'desc' },
  })

  if (existing && subscriptionHasCardLimit(existing)) {
    return existing
  }

  const starterPackage = await findCorporateStarterPackage()
  if (!starterPackage) return existing ?? null

  const quantity = parseMaxCardsQuantity(starterPackage.features)

  if (existing) {
    return prisma.subscription.update({
      where: { id: existing.id },
      data: {
        packageId: starterPackage.id,
        name: starterPackage.name,
        provider: existing.provider || 'admin',
        stripeStatus: existing.stripeStatus || 'active',
        endsAt: null,
        ...(quantity != null ? { quantity } : {}),
      },
      include: { package: { include: { features: true } } },
    })
  }

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

const subscriptionService = {
  ensureCorporateStarterSubscription,
  MAX_CARDS_FEATURE_KEY,
  CORPORATE_STARTER_SLUG,
}

export default subscriptionService
