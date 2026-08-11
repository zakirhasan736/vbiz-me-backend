import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import subscriptionService from '../services/subscription.service'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const MAX_CARDS_FEATURE_KEY = 'max_cards'

const DEFAULT_PACKAGES = [
  {
    slug: 'corporate-starter',
    name: 'Corporate Starter',
    description:
      'Temporary free starter for corporate owners (pre-Stripe). Includes a fixed team card capacity for testing.',
    sortOrder: 0,
    maxCards: '15',
  },
  {
    slug: 'single-starter',
    name: 'Single Card',
    description: 'Default free package for single card owners (one vCard).',
    sortOrder: 1,
    maxCards: '1',
  },
] as const

/**
 * Idempotent startup seed: ensures starter packages exist with max_cards.
 * Does not overwrite package fields or existing max_cards values if an admin already edited them.
 */
const seedPackages = async (): Promise<void> => {
  for (const pkg of DEFAULT_PACKAGES) {
    const row = await prisma.package.upsert({
      where: { slug: pkg.slug },
      create: {
        slug: pkg.slug,
        name: pkg.name,
        description: pkg.description,
        monthlyPrice: 0,
        yearlyPrice: 0,
        isActive: true,
        sortOrder: pkg.sortOrder,
      },
      // Leave admin-edited name/prices/active/sortOrder alone on re-run.
      update: {},
    })

    await prisma.packageFeature.upsert({
      where: {
        packageId_featureKey: {
          packageId: row.id,
          featureKey: MAX_CARDS_FEATURE_KEY,
        },
      },
      create: {
        packageId: row.id,
        featureKey: MAX_CARDS_FEATURE_KEY,
        featureValue: pkg.maxCards,
      },
      // Do not overwrite admin-edited max_cards.
      update: {},
    })
  }

  logger.info('Package seed ensured (corporate-starter, single-starter)')

  // Repair corporate accounts that signed up before packages existed
  const owners = await prisma.user.findMany({
    where: {
      role: PrismaUserRole.CORPORATE_OWNER,
      deletedAt: null,
      isActive: true,
    },
    select: { id: true },
  })

  let linked = 0
  for (const owner of owners) {
    const sub = await subscriptionService.ensureCorporateStarterSubscription(owner.id)
    if (sub?.packageId) linked += 1
  }

  if (owners.length) {
    logger.info(`Corporate starter subscriptions ensured for ${linked}/${owners.length} corporate owners`)
  }
}

export default seedPackages
