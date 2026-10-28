/**
 * Repair misplaced intro videos that landed on Profile Background during
 * Laravel → new-system cutover.
 *
 * Target: OLDER cards only — createdAt BEFORE the last N months (default 2).
 * Recent/new-system cards (created within the last N months) are NEVER touched.
 *
 *   IF background has a video AND intro is blank
 *   THEN move that video to Intro vCard Video and clear background media.
 *
 * Images on background are never moved. S3 objects are not deleted — only
 * settings + attachment type are reclassified.
 *
 * Dry-run:  npx tsx --env-file=.env scripts/moveBackgroundVideoToIntro.ts
 * Apply:    npx tsx --env-file=.env scripts/moveBackgroundVideoToIntro.ts --apply
 *
 * Options:
 *   --months=2              older-than cutoff in months (default 2)
 *   --before=2026-08-29     absolute upper bound (overrides --months); cards with
 *                           createdAt < this date are eligible
 *   --slug=some-card        limit to one slug
 *   --limit=50              max cards to mutate on --apply
 */
import { attachmentTypeNameMatches } from '../src/utils/attachmentTypeMatch'
import { prisma } from '../src/utils/prisma'
import {
  BACKGROUND_FIELD,
  DISPLAY_SETTINGS_KEY,
  INTRO_FIELD,
  matchingBackgroundAttachmentIds,
  monthsAgo,
  patchDisplaySettingsMediaMove,
  planBackgroundVideoToIntroMove,
  settingsPatchForMove,
  type CardMediaSnapshot,
  type MovePlan,
} from './moveBackgroundVideoToIntro.helpers'

function parseArgs(argv: string[]) {
  const monthsArg = argv.find((a) => a.startsWith('--months='))
  const beforeArg = argv.find((a) => a.startsWith('--before=')) || argv.find((a) => a.startsWith('--since='))
  const slugArg = argv.find((a) => a.startsWith('--slug='))
  const limitArg = argv.find((a) => a.startsWith('--limit='))
  const months = Math.max(1, Number(monthsArg?.slice('--months='.length) || 2) || 2)
  const beforeRaw = beforeArg?.includes('=') ? beforeArg.slice(beforeArg.indexOf('=') + 1).trim() : ''
  const before = beforeRaw ? new Date(beforeRaw) : monthsAgo(months)
  if (Number.isNaN(before.getTime())) {
    throw new Error(`Invalid --before date: ${beforeRaw}`)
  }
  return {
    apply: argv.includes('--apply'),
    months,
    /** Cards with createdAt strictly before this date are eligible; newer cards are skipped. */
    before,
    slug: slugArg?.slice('--slug='.length)?.trim() || '',
    limit: Math.max(1, Number(limitArg?.slice('--limit='.length) || 5000) || 5000),
  }
}

async function resolveAttachmentTypeId(canonical: string): Promise<string> {
  const rows = await prisma.attachmentType.findMany({
    select: { id: true, name: true },
    take: 500,
  })
  const hit = rows.find((row) => attachmentTypeNameMatches(row.name, canonical))
  if (hit) return hit.id
  const created = await prisma.attachmentType.create({
    data: {
      name: canonical,
      slug: canonical.toLowerCase().replace(/\s+/g, '-'),
    },
    select: { id: true },
  })
  return created.id
}

async function upsertSetting(profileId: string, key: string, value: string) {
  await prisma.setting.upsert({
    where: { profileId_key: { profileId, key } },
    create: { profileId, key, value },
    update: { value },
  })
}

async function loadCards(before: Date, slug?: string): Promise<CardMediaSnapshot[]> {
  const rows = await prisma.profile.findMany({
    where: {
      // Older than cutoff only — do not touch recent/new-system cards.
      createdAt: { lt: before },
      ...(slug ? { slug: { equals: slug, mode: 'insensitive' } } : {}),
    },
    select: {
      id: true,
      slug: true,
      name: true,
      createdAt: true,
      settings: {
        where: {
          key: {
            in: [
              'intro_video_url',
              'intro_youtube_url',
              'background_media_url',
              'profile_video_checkbox',
              'profile_video_link_checkbox',
              'background_video_checkbox',
              DISPLAY_SETTINGS_KEY,
            ],
          },
        },
        select: { key: true, value: true },
      },
      attachments: {
        where: {
          OR: [{ attachableType: 'Profile' }, { profileId: { not: null } }],
        },
        select: {
          id: true,
          url: true,
          mimeType: true,
          format: true,
          extension: true,
          docName: true,
          attachmentType: { select: { name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 40,
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  return rows.map((row) => ({
    profileId: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.createdAt,
    settings: Object.fromEntries(row.settings.map((s) => [s.key, s.value || ''])),
    attachments: row.attachments.map((att) => ({
      id: att.id,
      url: att.url,
      mimeType: att.mimeType,
      format: att.format,
      extension: att.extension,
      docName: att.docName,
      typeName: att.attachmentType?.name || null,
    })),
  }))
}

async function applyPlan(card: CardMediaSnapshot, plan: MovePlan, introTypeId: string) {
  if (plan.status !== 'would_move' || !plan.videoUrl || !plan.videoKind) return

  const patch = settingsPatchForMove(plan)
  for (const [key, value] of Object.entries(patch)) {
    await upsertSetting(card.profileId, key, value)
  }

  const nextDisplay = patchDisplaySettingsMediaMove(card.settings[DISPLAY_SETTINGS_KEY], {
    videoUrl: plan.videoUrl,
    youtube: plan.videoKind === 'youtube',
  })
  await upsertSetting(card.profileId, DISPLAY_SETTINGS_KEY, nextDisplay)

  const bgAttachmentIds = matchingBackgroundAttachmentIds(card, plan.videoUrl)
  if (bgAttachmentIds.length) {
    await prisma.attachment.updateMany({
      where: { id: { in: bgAttachmentIds } },
      data: { attachmentTypeId: introTypeId },
    })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(
    JSON.stringify(
      {
        mode: args.apply ? 'APPLY' : 'DRY-RUN',
        before: args.before.toISOString(),
        monthsDefault: args.months,
        slug: args.slug || null,
        limit: args.limit,
        note: 'Only OLDER cards (createdAt < before). New-system cards from the last N months are skipped. Moves background VIDEO → intro when intro is blank.',
      },
      null,
      2
    )
  )

  const cards = await loadCards(args.before, args.slug || undefined)
  const plans = cards.map((card) => planBackgroundVideoToIntroMove(card))
  const moves = plans.filter((p) => p.status === 'would_move')
  const skipped = plans.filter((p) => p.status === 'skip')

  console.log(
    JSON.stringify(
      {
        scanned: cards.length,
        wouldMove: moves.length,
        skipped: skipped.length,
        sampleSkips: skipped.slice(0, 10),
        moves: moves.slice(0, 100),
      },
      null,
      2
    )
  )

  if (!args.apply) {
    console.log('\nDry-run only. Re-run with --apply to write settings + reclassify attachments.')
    return
  }

  const introTypeId = await resolveAttachmentTypeId(INTRO_FIELD)
  // Ensure background type still exists for name matching elsewhere (no create required).
  await resolveAttachmentTypeId(BACKGROUND_FIELD)

  let applied = 0
  for (const plan of moves.slice(0, args.limit)) {
    const card = cards.find((c) => c.profileId === plan.profileId)
    if (!card) continue
    await applyPlan(card, plan, introTypeId)
    applied += 1
    console.log(`moved ${plan.slug || plan.profileId} ← ${plan.videoUrl}`)
  }

  console.log(JSON.stringify({ applied, cappedAt: args.limit }, null, 2))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
