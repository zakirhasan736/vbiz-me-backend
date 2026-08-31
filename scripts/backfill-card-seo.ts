/**
 * Backfill missing per-card SEO settings (title, description, keywords).
 *
 * Usage:
 *   npx tsx scripts/backfill-card-seo.ts
 *   npx tsx scripts/backfill-card-seo.ts --dry-run
 */
import {
  SEO_META_DESCRIPTION_SETTING_KEY,
  SEO_META_KEYWORDS_SETTING_KEY,
  SEO_META_TITLE_SETTING_KEY,
  deriveDefaultSeoFromProfile,
  seoMetadataToSettings,
} from '../src/services/seoMetadata.service'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  const profiles = await prisma.profile.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      companyName: true,
      designation: true,
      about: true,
      profession: { select: { name: true } },
      settings: { select: { key: true, value: true } },
    },
  })

  let updatedProfiles = 0
  let upsertedSettings = 0

  for (const profile of profiles) {
    const settings = Object.fromEntries(profile.settings.map((row) => [row.key, row.value || '']))
    const hasTitle = Boolean(settings[SEO_META_TITLE_SETTING_KEY]?.trim())
    const hasDescription = Boolean(settings[SEO_META_DESCRIPTION_SETTING_KEY]?.trim())
    if (hasTitle && hasDescription) continue

    const defaults = deriveDefaultSeoFromProfile({
      name: profile.name,
      slug: profile.slug,
      companyName: profile.companyName,
      designation: profile.designation,
      profession: profile.profession?.name ?? null,
      about: profile.about,
    })
    const next = seoMetadataToSettings({
      metaTitle: hasTitle ? settings[SEO_META_TITLE_SETTING_KEY] : defaults.metaTitle,
      metaDescription: hasDescription ? settings[SEO_META_DESCRIPTION_SETTING_KEY] : defaults.metaDescription,
      keywords: settings[SEO_META_KEYWORDS_SETTING_KEY]
        ? JSON.parse(settings[SEO_META_KEYWORDS_SETTING_KEY] || '[]')
        : defaults.keywords,
    })

    updatedProfiles += 1
    for (const [key, value] of Object.entries(next)) {
      const existing = settings[key]?.trim()
      if (existing) continue
      upsertedSettings += 1
      if (dryRun) {
        logger.info(`[dry-run] ${profile.slug} ${key}=${value.slice(0, 80)}`)
        continue
      }
      await prisma.setting.upsert({
        where: { profileId_key: { profileId: profile.id, key } },
        create: { profileId: profile.id, key, value },
        update: { value },
      })
    }
  }

  logger.info(
    `${dryRun ? 'Dry run: would update' : 'Updated'} ${updatedProfiles} profile(s); ${upsertedSettings} setting row(s) written`
  )
}

main()
  .catch((error) => {
    logger.error('backfill-card-seo failed', { error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
