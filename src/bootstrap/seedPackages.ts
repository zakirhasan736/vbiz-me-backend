import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import { RETIRED_PACKAGE_SLUGS } from '../constants/packageAccess'
import subscriptionService from '../services/subscription.service'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const RETIRED_NAMES = ['Corporate Starter', 'Single Starter', 'Single Card']

/**
 * Idempotent startup: retire unused starter packages (Corporate Starter / Single Card)
 * and attach remaining free-plan fallbacks to corporate owners who have no subscription.
 */
const seedPackages = async (): Promise<void> => {
  const retired = await prisma.package.findMany({
    where: {
      OR: [
        { slug: { in: [...RETIRED_PACKAGE_SLUGS] } },
        ...RETIRED_NAMES.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
      _count: { select: { subscriptions: true } },
    },
  })

  let deleted = 0
  let deactivated = 0
  for (const pkg of retired) {
    if (pkg._count.subscriptions === 0) {
      await prisma.packageFeature.deleteMany({ where: { packageId: pkg.id } })
      await prisma.package.delete({ where: { id: pkg.id } })
      deleted += 1
      continue
    }
    await prisma.package.update({
      where: { id: pkg.id },
      data: { isActive: false },
    })
    deactivated += 1
  }

  if (retired.length) {
    logger.info(
      `Retired starter packages: deleted ${deleted}, deactivated ${deactivated} (corporate-starter / single-starter)`
    )
  }

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
    logger.info(`Owner subscriptions ensured for ${linked}/${owners.length} corporate owners`)
  }
}

export default seedPackages
