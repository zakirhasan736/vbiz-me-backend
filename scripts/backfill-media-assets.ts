/**
 * One-time (re-runnable) migration of existing media into the MediaAsset registry.
 *
 * For every card, finds every S3 URL it uses (all tabs, settings, attachments,
 * rich text), works out WHICH TAB and WHICH ITEM it belongs to, HEAD-checks the
 * file, and records key + card + tab + item + status. Existing rows keep their
 * original owner/tab (an upload record is never overwritten by a guess).
 *
 * Never deletes and never touches S3 objects.
 *
 *   yarn media:backfill            # dry-run summary
 *   yarn media:backfill --apply    # write MediaAsset rows
 */
import { collectCardMediaRefs } from '../src/utils/cardMediaScan'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'

const GENERIC = new Set(['attachments', 'settings'])

async function main() {
  const apply = process.argv.includes('--apply')
  s3Utils.ensureConfigured()

  const profiles = await prisma.profile.findMany({ select: { id: true, slug: true }, orderBy: { createdAt: 'asc' } })
  console.log(`Cards: ${profiles.length}${apply ? '' : '  (dry-run)'}`)

  // key → first card (oldest) that uses it, with the most specific tab seen.
  const best = new Map<string, { profileId: string; area: string; label: string | null }>()
  for (const [i, profile] of profiles.entries()) {
    if (i % 100 === 0) console.log(`  scanned ${i}/${profiles.length} cards`)
    const refs = await collectCardMediaRefs(profile.id, {
      skipTables: new Set(['CardChangeHistory', 'CardDailyBackup']),
    })
    for (const ref of refs) {
      const current = best.get(ref.key)
      if (!current) best.set(ref.key, { profileId: profile.id, area: ref.area, label: ref.label })
      else if (current.profileId === profile.id && GENERIC.has(current.area) && !GENERIC.has(ref.area)) {
        best.set(ref.key, { profileId: profile.id, area: ref.area, label: ref.label })
      }
    }
  }
  console.log(`Distinct files referenced by cards: ${best.size}`)

  const existing = new Map(
    (await prisma.mediaAsset.findMany({ select: { key: true, profileId: true, area: true } })).map((a) => [a.key, a])
  )

  let ok = 0
  let missing = 0
  let created = 0
  let filled = 0
  const queue = [...best.entries()]
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const [key, where] = item
      const alive = await s3Utils.headObject(key)
      if (alive) ok += 1
      else missing += 1
      if (!apply) continue
      const prior = existing.get(key)
      const status = alive ? 'ok' : 'missing'
      const now = new Date()
      if (!prior) {
        await prisma.mediaAsset.create({
          data: {
            key,
            status,
            profileId: where.profileId,
            area: where.area,
            itemLabel: where.label?.slice(0, 200) || null,
            source: 'backfill',
            checkedAt: now,
            missingReason: alive ? null : 'not found in S3 at backfill',
          },
        })
        created += 1
      } else {
        await prisma.mediaAsset.update({
          where: { key },
          data: {
            status,
            checkedAt: now,
            missingReason: alive ? null : 'not found in S3 at backfill',
            // Only fill identity gaps — never overwrite what an upload recorded.
            ...(prior.profileId ? {} : { profileId: where.profileId }),
            ...(prior.area ? {} : { area: where.area, itemLabel: where.label?.slice(0, 200) || null }),
          },
        })
        if (!prior.profileId || !prior.area) filled += 1
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  console.log(`\nIn S3: ${ok}   Missing: ${missing}`)
  if (apply) console.log(`MediaAsset rows created: ${created}, identity filled: ${filled}`)
  else console.log('Dry-run only. Re-run with --apply to write MediaAsset rows.')
  if (missing) console.log('Run `yarn media:repair --apply` to recover missing files from S3 versions.')
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().catch(() => undefined))
