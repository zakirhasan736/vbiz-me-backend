import { RETIRED_PACKAGE_SLUGS } from '../constants/packageAccess'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const RETIRED_NAMES = ['Corporate Starter', 'Single Starter', 'Single Card']

/**
 * Idempotent startup: retire unused starter packages (Corporate Starter / Single Card).
 * Missing owner subscriptions are handled by the Step 11 backfill script, not on boot,
 * so Corporate owners are never silently attached to Free.
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
}

export default seedPackages
