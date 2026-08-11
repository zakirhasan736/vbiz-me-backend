/**
 * Repair package facilities + subscription→package links after Laravel import.
 * Laravel packages have no yearly_price; package_features use limit_value/feature_type;
 * subscriptions have no package_id (matched by name/provider/stripe_price).
 *
 * Usage: yarn tsx --env-file=.env scripts/backfill-package-subscription-data.ts
 */
import 'dotenv/config'
import { prisma } from '../src/utils/prisma'

/** From vbizme_app_live_latest.sql `package_features` INSERT */
const LARAVEL_FEATURES: Array<{
  legacyId: number
  packageLegacyId: number
  featureKey: string
  featureType: string
  limitValue: number | null
}> = [
  { legacyId: 1, packageLegacyId: 1, featureKey: 'max_social_links', featureType: 'numeric', limitValue: 0 },
  { legacyId: 2, packageLegacyId: 1, featureKey: 'max_extra_fields', featureType: 'numeric', limitValue: 0 },
  { legacyId: 3, packageLegacyId: 1, featureKey: 'allow_video_upload', featureType: 'boolean', limitValue: 0 },
  { legacyId: 4, packageLegacyId: 1, featureKey: 'allow_music_upload', featureType: 'boolean', limitValue: 0 },
  { legacyId: 5, packageLegacyId: 1, featureKey: 'allow_2d_explainer', featureType: 'boolean', limitValue: 0 },
  { legacyId: 6, packageLegacyId: 1, featureKey: 'max_file_size_mb', featureType: 'numeric', limitValue: 2 },
  { legacyId: 7, packageLegacyId: 2, featureKey: 'max_social_links', featureType: 'numeric', limitValue: 10 },
  { legacyId: 8, packageLegacyId: 2, featureKey: 'max_extra_fields', featureType: 'numeric', limitValue: 5 },
  { legacyId: 9, packageLegacyId: 2, featureKey: 'allow_video_upload', featureType: 'boolean', limitValue: 0 },
  { legacyId: 10, packageLegacyId: 2, featureKey: 'allow_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 11, packageLegacyId: 2, featureKey: 'allow_2d_explainer', featureType: 'boolean', limitValue: 0 },
  { legacyId: 12, packageLegacyId: 2, featureKey: 'max_file_size_mb', featureType: 'numeric', limitValue: 5 },
  { legacyId: 13, packageLegacyId: 3, featureKey: 'max_social_links', featureType: 'numeric', limitValue: 30 },
  { legacyId: 14, packageLegacyId: 3, featureKey: 'max_extra_fields', featureType: 'numeric', limitValue: 15 },
  { legacyId: 15, packageLegacyId: 3, featureKey: 'allow_video_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 16, packageLegacyId: 3, featureKey: 'allow_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 17, packageLegacyId: 3, featureKey: 'allow_2d_explainer', featureType: 'boolean', limitValue: 1 },
  { legacyId: 18, packageLegacyId: 3, featureKey: 'max_file_size_mb', featureType: 'numeric', limitValue: 15 },
  { legacyId: 19, packageLegacyId: 4, featureKey: 'max_social_links', featureType: 'unlimited', limitValue: null },
  { legacyId: 20, packageLegacyId: 4, featureKey: 'max_extra_fields', featureType: 'unlimited', limitValue: null },
  { legacyId: 21, packageLegacyId: 4, featureKey: 'allow_video_upload', featureType: 'boolean', limitValue: 0 },
  { legacyId: 22, packageLegacyId: 4, featureKey: 'allow_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 23, packageLegacyId: 4, featureKey: 'allow_2d_explainer', featureType: 'boolean', limitValue: 1 },
  { legacyId: 24, packageLegacyId: 4, featureKey: 'max_file_size_mb', featureType: 'numeric', limitValue: 50 },
  { legacyId: 31, packageLegacyId: 1, featureKey: 'allow_yt_bg_music_upload', featureType: 'boolean', limitValue: 0 },
  { legacyId: 32, packageLegacyId: 1, featureKey: 'allow_bg_music_upload', featureType: 'boolean', limitValue: 0 },
  { legacyId: 33, packageLegacyId: 1, featureKey: 'allow_intro_video_upload', featureType: 'boolean', limitValue: 1 },
  {
    legacyId: 34,
    packageLegacyId: 1,
    featureKey: 'allow_background_video_upload',
    featureType: 'boolean',
    limitValue: 0,
  },
  { legacyId: 35, packageLegacyId: 2, featureKey: 'allow_yt_bg_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 36, packageLegacyId: 2, featureKey: 'allow_bg_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 37, packageLegacyId: 2, featureKey: 'allow_intro_video_upload', featureType: 'boolean', limitValue: 1 },
  {
    legacyId: 38,
    packageLegacyId: 2,
    featureKey: 'allow_background_video_upload',
    featureType: 'boolean',
    limitValue: 0,
  },
  { legacyId: 39, packageLegacyId: 3, featureKey: 'allow_yt_bg_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 40, packageLegacyId: 3, featureKey: 'allow_bg_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 41, packageLegacyId: 3, featureKey: 'allow_intro_video_upload', featureType: 'boolean', limitValue: 1 },
  {
    legacyId: 42,
    packageLegacyId: 3,
    featureKey: 'allow_background_video_upload',
    featureType: 'boolean',
    limitValue: 1,
  },
  { legacyId: 43, packageLegacyId: 4, featureKey: 'allow_yt_bg_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 44, packageLegacyId: 4, featureKey: 'allow_bg_music_upload', featureType: 'boolean', limitValue: 1 },
  { legacyId: 45, packageLegacyId: 4, featureKey: 'allow_intro_video_upload', featureType: 'boolean', limitValue: 1 },
  {
    legacyId: 46,
    packageLegacyId: 4,
    featureKey: 'allow_background_video_upload',
    featureType: 'boolean',
    limitValue: 1,
  },
]

function featureValueFromLaravel(featureType: string, limitValue: number | null): string {
  if (featureType === 'unlimited') return 'unlimited'
  if (limitValue == null) return ''
  return String(limitValue)
}

async function resolvePackageId(input: {
  name?: string | null
  provider?: string | null
  stripePrice?: string | null
}): Promise<string | null> {
  const packages = await prisma.package.findMany({ select: { id: true, slug: true, name: true } })
  const needle = String(input.name || input.provider || '')
    .trim()
    .toLowerCase()
  if (needle) {
    const bySlug = packages.find((p) => (p.slug || '').trim().toLowerCase() === needle)
    if (bySlug) return bySlug.id
    const byName = packages.find((p) => p.name.trim().toLowerCase() === needle)
    if (byName) return byName.id
  }
  const stripePrice = String(input.stripePrice || '')
    .trim()
    .toLowerCase()
  if (stripePrice.startsWith('corporate_') || stripePrice === 'price_corporate_monthly') {
    return packages.find((p) => (p.slug || '').trim().toLowerCase() === 'corporate')?.id ?? null
  }
  if (stripePrice.startsWith('free_')) {
    return packages.find((p) => (p.slug || '').trim().toLowerCase() === 'free')?.id ?? null
  }
  if (stripePrice.includes('ssanq') || stripePrice === 'price_1ssanqhq8b3mdyv38gd8kaxw') {
    return packages.find((p) => (p.slug || '').trim().toLowerCase() === 'professional')?.id ?? null
  }
  if (stripePrice.includes('tx021') || stripePrice.includes('concierge')) {
    return packages.find((p) => (p.slug || '').trim().toLowerCase() === 'professional-concierge')?.id ?? null
  }
  return null
}

async function main() {
  // Trim sloppy Laravel slugs/names and sync sort order from legacyId
  const packages = await prisma.package.findMany()
  for (const pkg of packages) {
    const slug = pkg.slug?.trim() || null
    const name = pkg.name.trim()
    await prisma.package.update({
      where: { id: pkg.id },
      data: {
        name,
        slug,
        yearlyPrice: 0, // Laravel had no yearly column
        sortOrder: pkg.legacyId ?? pkg.sortOrder,
      },
    })
  }
  console.log(`Normalized ${packages.length} packages`)

  const byLegacy = new Map(
    (await prisma.package.findMany({ select: { id: true, legacyId: true } }))
      .filter((p) => p.legacyId != null)
      .map((p) => [p.legacyId as number, p.id])
  )

  let featuresUpserted = 0
  for (const row of LARAVEL_FEATURES) {
    const packageId = byLegacy.get(row.packageLegacyId)
    if (!packageId) continue
    const featureValue = featureValueFromLaravel(row.featureType, row.limitValue)
    await prisma.packageFeature.upsert({
      where: { packageId_featureKey: { packageId, featureKey: row.featureKey } },
      create: {
        legacyId: row.legacyId,
        packageId,
        featureKey: row.featureKey,
        featureValue,
      },
      update: {
        legacyId: row.legacyId,
        featureValue,
      },
    })
    featuresUpserted += 1
  }
  console.log(`Upserted ${featuresUpserted} package features from Laravel dump`)

  const subs = await prisma.subscription.findMany({
    where: { OR: [{ packageId: null }, { packageId: { not: null } }] },
    select: { id: true, name: true, provider: true, stripePrice: true, packageId: true },
  })
  let linked = 0
  for (const sub of subs) {
    const packageId = await resolvePackageId(sub)
    if (!packageId || packageId === sub.packageId) continue
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { packageId },
    })
    linked += 1
  }
  console.log(`Linked ${linked} subscriptions to packages`)

  const counts = await prisma.package.findMany({
    select: {
      name: true,
      slug: true,
      monthlyPrice: true,
      _count: { select: { subscriptions: true, features: true } },
      features: { select: { featureKey: true, featureValue: true }, orderBy: { featureKey: 'asc' } },
    },
    orderBy: { sortOrder: 'asc' },
  })
  for (const p of counts) {
    console.log(
      `\n${p.name} ($${((p.monthlyPrice || 0) / 100).toFixed(2)}/mo) — ${p._count.subscriptions} subscribers, ${p._count.features} facilities`
    )
    for (const f of p.features) {
      console.log(`  - ${f.featureKey}=${f.featureValue}`)
    }
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
