import { RETIRED_PACKAGE_SLUGS } from '../constants/packageAccess'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'

const RETIRED_NAMES = ['Corporate Starter', 'Single Starter', 'Single Card']
const AI_ASSISTANCE_FEATURE_KEY = 'allow_ai_assistance'
const DEFAULT_AI_ASSISTANCE_SLUG = 'michaelangelo-casanova-2'
const ASSISTANT_SETTING_KEY = 'aiAssistance_checkbox'

/**
 * Idempotent startup: retire unused starter packages (Corporate Starter / Single Card).
 * Missing owner subscriptions are handled by the Step 11 backfill script, not on boot,
 * so Corporate owners are never silently attached to Free.
 *
 * Also locks AI Assistance as a paid add-on on every package (allow_ai_assistance=0),
 * and keeps michaelangelo-casanova-2 AI Assistance enabled by default.
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

  const packages = await prisma.package.findMany({ select: { id: true, slug: true } })
  let lockedAi = 0
  for (const pkg of packages) {
    const existing = await prisma.packageFeature.findUnique({
      where: { packageId_featureKey: { packageId: pkg.id, featureKey: AI_ASSISTANCE_FEATURE_KEY } },
      select: { id: true },
    })
    if (existing) continue
    await prisma.packageFeature.create({
      data: { packageId: pkg.id, featureKey: AI_ASSISTANCE_FEATURE_KEY, featureValue: '0' },
    })
    lockedAi += 1
  }
  if (lockedAi) {
    logger.info(`Inserted AI Assistance lock on ${lockedAi} package(s) (allow_ai_assistance=0)`)
  }

  // One-time rollout: if every package still has the old free unlock (`1`), force-lock all.
  // Leave mixed states alone so a paid add-on (`1` on one package) is not wiped on restart.
  const [unlockedAi, totalAiFlags] = await Promise.all([
    prisma.packageFeature.count({
      where: { featureKey: AI_ASSISTANCE_FEATURE_KEY, featureValue: '1' },
    }),
    prisma.packageFeature.count({ where: { featureKey: AI_ASSISTANCE_FEATURE_KEY } }),
  ])
  if (totalAiFlags > 0 && unlockedAi === totalAiFlags) {
    const rolled = await prisma.packageFeature.updateMany({
      where: { featureKey: AI_ASSISTANCE_FEATURE_KEY },
      data: { featureValue: '0' },
    })
    logger.info(`AI Assistance premium rollout: locked ${rolled.count} package flag(s)`)
  }

  const CRM_FEATURE_KEY = 'allow_crm'
  const CRM_INCLUDED_SLUGS = new Set(['professional', 'professional-concierge', 'corporate'])
  let seededCrm = 0
  for (const pkg of packages) {
    const existing = await prisma.packageFeature.findUnique({
      where: { packageId_featureKey: { packageId: pkg.id, featureKey: CRM_FEATURE_KEY } },
      select: { id: true },
    })
    if (existing) continue
    const slug = (pkg.slug || '').trim().toLowerCase()
    const featureValue = CRM_INCLUDED_SLUGS.has(slug) ? '1' : '0'
    await prisma.packageFeature.create({
      data: { packageId: pkg.id, featureKey: CRM_FEATURE_KEY, featureValue },
    })
    seededCrm += 1
  }
  if (seededCrm) {
    logger.info(`Seeded CRM package flag on ${seededCrm} package(s) (allow_crm)`)
  }

  const defaultCard = await prisma.profile.findFirst({
    where: { slug: { equals: DEFAULT_AI_ASSISTANCE_SLUG, mode: 'insensitive' } },
    select: { id: true },
  })
  if (defaultCard) {
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: defaultCard.id, key: ASSISTANT_SETTING_KEY } },
      create: { profileId: defaultCard.id, key: ASSISTANT_SETTING_KEY, value: '1' },
      update: { value: '1' },
    })
    await prisma.profileAssistantConfig.upsert({
      where: { profileId: defaultCard.id },
      create: { profileId: defaultCard.id, enabled: true },
      update: { enabled: true },
    })
    logger.info(`Ensured AI Assistance enabled for /v/${DEFAULT_AI_ASSISTANCE_SLUG}`)
  }
}

export default seedPackages
