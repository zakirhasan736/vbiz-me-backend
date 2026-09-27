/**
 * Restore unique corporate-card portraits after sibling sync copied one avatar onto every linked card.
 *
 * Sources, in order:
 *   1. That card's own Profile Image/Video attachments (S3 URLs still in Attachment rows)
 *   2. Card-change history snapshots (72h) that still hold the old profile_media_url / avatar
 *
 * Dry-run by default. Re-run with --apply to write Profile.avatar + profile_media_url + display settings.
 *
 *   yarn tsx --env-file=.env scripts/restoreCorporateCardAvatars.ts
 *   yarn tsx --env-file=.env scripts/restoreCorporateCardAvatars.ts --email=mcasanova@vbizme.com --apply
 */
import { attachmentTypeNameMatches } from '../src/utils/attachmentTypeMatch'
import { prisma } from '../src/utils/prisma'
import {
  extractAvatarUrlsFromSnapshot,
  extractProfileImageFromDisplaySettings,
  mostCommonSharedUrl,
  patchDisplaySettingsProfileImage,
  pickRestoreAvatarUrl,
} from './restoreCorporateCardAvatars.helpers'

const DEFAULT_EMAIL = 'mcasanova@vbizme.com'
const EXTRA_SLUGS = ['michaelangelo-casanova-2', 'michaelanglo-casanova', 'julia-rose', 'mila', 'gefft-excited']

function parseArgs(argv: string[]) {
  const emailArg = argv.find((arg) => arg.startsWith('--email='))
  return {
    apply: argv.includes('--apply'),
    email: (emailArg?.slice('--email='.length) || DEFAULT_EMAIL).trim().toLowerCase(),
  }
}

function isProfileMediaAttachment(typeName?: string | null) {
  return attachmentTypeNameMatches(typeName, 'Profile Image/Video')
}

async function main() {
  const { apply, email } = parseArgs(process.argv.slice(2))

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  })

  const cards = await prisma.profile.findMany({
    where: {
      OR: [
        { slug: { in: EXTRA_SLUGS, mode: 'insensitive' } },
        { email: { equals: email, mode: 'insensitive' } },
        ...(user ? [{ userId: user.id }, { companyUserId: user.id }] : []),
      ],
    },
    select: {
      id: true,
      slug: true,
      name: true,
      avatar: true,
      settings: {
        where: { key: { in: ['profile_media_url', 'display_settings_json'] } },
        select: { key: true, value: true },
      },
      attachments: {
        include: { attachmentType: { select: { name: true } } },
        orderBy: { updatedAt: 'desc' },
      },
    },
    orderBy: { slug: 'asc' },
  })

  const unique = [...new Map(cards.map((card) => [card.id, card])).values()]
  const currentUrls = unique.map((card) => {
    const settings = Object.fromEntries(card.settings.map((row) => [row.key, row.value || '']))
    return (
      settings.profile_media_url ||
      card.avatar ||
      extractProfileImageFromDisplaySettings(settings.display_settings_json)
    )
  })
  const sharedOverwriteUrl = mostCommonSharedUrl(currentUrls)

  const plans = []
  for (const card of unique) {
    const settings = Object.fromEntries(card.settings.map((row) => [row.key, row.value || '']))
    const currentUrl =
      settings.profile_media_url ||
      card.avatar ||
      extractProfileImageFromDisplaySettings(settings.display_settings_json) ||
      ''
    const attachmentUrls = card.attachments
      .filter((att) => isProfileMediaAttachment(att.attachmentType?.name))
      .map((att) => att.url || '')
      .filter(Boolean)
    const history = await prisma.cardChangeHistory.findMany({
      where: { profileId: card.id },
      select: { snapshot: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 40,
    })
    const historyUrls = history.flatMap((row) => extractAvatarUrlsFromSnapshot(row.snapshot))
    const picked = pickRestoreAvatarUrl({
      currentUrl,
      sharedOverwriteUrl,
      attachmentUrls,
      historyUrls,
    })
    const willWrite = Boolean(picked.url && picked.source !== 'keep' && picked.source !== 'none')
    plans.push({
      slug: card.slug,
      name: card.name,
      currentUrl,
      restoreUrl: picked.url,
      source: picked.source,
      willWrite,
      attachmentCount: attachmentUrls.length,
      historyHintCount: historyUrls.length,
    })

    if (!apply || !willWrite || !picked.url) continue

    await prisma.profile.update({
      where: { id: card.id },
      data: { avatar: picked.url },
    })
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: card.id, key: 'profile_media_url' } },
      create: { profileId: card.id, key: 'profile_media_url', value: picked.url },
      update: { value: picked.url },
    })
    const nextDisplay = patchDisplaySettingsProfileImage(settings.display_settings_json, picked.url)
    if (nextDisplay != null) {
      await prisma.setting.upsert({
        where: { profileId_key: { profileId: card.id, key: 'display_settings_json' } },
        create: { profileId: card.id, key: 'display_settings_json', value: nextDisplay },
        update: { value: nextDisplay },
      })
    }
  }

  console.log(
    JSON.stringify(
      {
        apply,
        corporateUser: user,
        sharedOverwriteUrl,
        restoreCount: plans.filter((row) => row.willWrite).length,
        cards: plans,
      },
      null,
      2
    )
  )
  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to write each card's own portrait back.")
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
