/**
 * Site-wide media health check + repair.
 *
 * Finds every S3 URL referenced anywhere in the database (all cards, all tabs,
 * settings, history snapshots, backups …), checks each file exists, and — with
 * --apply — brings missing files back from S3 versioning.
 *
 * Never deletes anything. Safe to run any time.
 *
 *   yarn media:repair                    # dry-run: report missing files only
 *   yarn media:repair --apply            # recover missing files from versions
 *   yarn media:repair --card=michelle-loyola [--apply]
 *
 * Report: scripts/reports/media-repair-<timestamp>.json
 */
import fs from 'fs'
import path from 'path'
import { collectAllReferencedMediaKeys, collectCardMediaKeys } from '../src/utils/cardMediaScan'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'

function parseArgs(argv: string[]) {
  const card =
    argv
      .find((a) => a.startsWith('--card='))
      ?.slice('--card='.length)
      .trim() || ''
  return { apply: argv.includes('--apply'), card }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  s3Utils.ensureConfigured()

  let keys: Set<string>
  if (args.card) {
    const profile = await prisma.profile.findFirst({ where: { slug: args.card }, select: { id: true } })
    if (!profile) throw new Error(`Card not found: ${args.card}`)
    keys = await collectCardMediaKeys(profile.id)
  } else {
    keys = await collectAllReferencedMediaKeys()
  }
  console.log(`Referenced S3 files: ${keys.size}${args.apply ? '' : '  (dry-run)'}`)

  const missing: string[] = []
  const restored: string[] = []
  const unrecoverable: Array<{ key: string; reason: string }> = []
  const queue = [...keys]
  let done = 0

  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      done += 1
      if (done % 200 === 0) console.log(`  checked ${done}/${keys.size}`)
      if (await s3Utils.headObject(key)) continue
      missing.push(key)
      if (!args.apply) continue
      try {
        const result = await s3Utils.restoreFromVersions(key)
        if (result.status === 'restored' || result.status === 'alive') restored.push(key)
        else unrecoverable.push({ key, reason: result.reason })
      } catch (error) {
        unrecoverable.push({ key, reason: (error as Error)?.message || 'error' })
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  // Which cards use each still-broken file, so you know whom to ask for a re-upload.
  const stillBroken = args.apply ? unrecoverable.map((u) => u.key) : missing
  const affectedCards = await findCardsUsingKeys(stillBroken)

  const report = {
    at: new Date().toISOString(),
    apply: args.apply,
    card: args.card || null,
    referenced: keys.size,
    missing: missing.length,
    restored,
    unrecoverable,
    affectedCards,
  }
  const dir = path.join(process.cwd(), 'scripts', 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `media-repair-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))

  console.log(`\nMissing: ${missing.length}`)
  if (args.apply) {
    console.log(`Recovered from versions: ${restored.length}`)
    console.log(`Unrecoverable (needs re-upload): ${unrecoverable.length}`)
  } else if (missing.length) {
    console.log('Re-run with --apply to recover them from S3 versioning.')
  }
  if (affectedCards.length) {
    console.log('\nCards with broken media:')
    for (const card of affectedCards) console.log(`  ${card.slug || card.id}: ${card.urls.length} file(s)`)
  }
  console.log(`\nReport: ${file}`)
}

async function findCardsUsingKeys(keys: string[]) {
  const out: Array<{ id: string; slug: string | null; urls: string[] }> = []
  if (!keys.length) return out
  const wanted = new Set(keys)
  const profiles = await prisma.profile.findMany({ select: { id: true, slug: true } })
  for (const profile of profiles) {
    const cardKeys = await collectCardMediaKeys(profile.id, {
      skipTables: new Set(['CardChangeHistory', 'CardDailyBackup']),
    })
    const hits = [...cardKeys].filter((k) => wanted.has(k))
    if (hits.length) out.push({ id: profile.id, slug: profile.slug, urls: hits.map((k) => s3Utils.publicUrlForKey(k)) })
  }
  return out
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    return prisma.$disconnect().catch(() => undefined)
  })
