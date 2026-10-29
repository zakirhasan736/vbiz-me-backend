/**
 * Reclaim S3 storage from files nothing uses anymore — the ONLY place media is
 * ever deleted. The API itself has no delete path (see docs/S3_MEDIA_SAFETY.md).
 *
 * A file is deleted only when ALL are true:
 *   1. It is not referenced anywhere in the database (every table and text/json
 *      column, incl. soft-deleted rows, change history and daily backups).
 *   2. It was uploaded more than --grace-days ago (default 30), so unsaved editor
 *      sessions and in-flight uploads are never touched.
 *   3. Its key matches the app's own upload pattern `<prefix>/<13-digit ms>-<name>`
 *      (migrated / legacy files are never touched).
 *
 * With bucket versioning on, a delete only adds a delete marker — the bytes stay
 * recoverable for the noncurrent-version window (90 days) via media:repair.
 *
 * Uses SEPARATE credentials (S3_CLEANUP_ACCESS_KEY_ID / S3_CLEANUP_SECRET_ACCESS_KEY)
 * because the app's own IAM user is not allowed to delete.
 *
 *   yarn media:cleanup                         # dry-run report
 *   yarn media:cleanup --grace-days=60         # dry-run, stricter
 *   yarn media:cleanup --apply                 # actually delete
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client, type _Object } from '@aws-sdk/client-s3'
import fs from 'fs'
import path from 'path'
import config from '../src/configs/config'
import { collectAllReferencedMediaKeys } from '../src/utils/cardMediaScan'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'

function parseArgs(argv: string[]) {
  const graceArg = argv.find((a) => a.startsWith('--grace-days='))
  const grace = graceArg ? Number(graceArg.slice('--grace-days='.length)) : 30
  return {
    apply: argv.includes('--apply'),
    graceDays: Number.isFinite(grace) && grace >= 7 ? Math.floor(grace) : 30,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { REGION, BUCKET, KEY_PREFIX } = config.S3
  const accessKeyId = process.env.S3_CLEANUP_ACCESS_KEY_ID || ''
  const secretAccessKey = process.env.S3_CLEANUP_SECRET_ACCESS_KEY || ''
  if (!BUCKET) throw new Error('S3_BUCKET is not set')
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Set S3_CLEANUP_ACCESS_KEY_ID / S3_CLEANUP_SECRET_ACCESS_KEY (cleanup-only IAM user)')
  }
  const client = new S3Client({ region: REGION, credentials: { accessKeyId, secretAccessKey } })

  const prefix = `${(KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '')}/`
  const appKeyPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{13}-[A-Za-z0-9._-]+$`)
  const cutoff = Date.now() - args.graceDays * 24 * 60 * 60 * 1000

  console.log('Collecting references from the database…')
  const referenced = await collectAllReferencedMediaKeys()
  console.log(`Referenced keys: ${referenced.size}`)
  if (referenced.size === 0) {
    throw new Error('Found zero references — refusing to continue (wrong DATABASE_URL or S3_PUBLIC_BASE_URL?)')
  }

  const candidates: _Object[] = []
  let scanned = 0
  let token: string | undefined
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 })
    )
    for (const obj of page.Contents || []) {
      scanned += 1
      const key = obj.Key || ''
      if (!appKeyPattern.test(key)) continue
      if (referenced.has(key)) continue
      if (!obj.LastModified || obj.LastModified.getTime() > cutoff) continue
      candidates.push(obj)
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)

  // Safety valve: if most of the bucket looks unused, the scan is wrong — stop.
  if (scanned > 50 && candidates.length / scanned > 0.5) {
    throw new Error(
      `Refusing: ${candidates.length}/${scanned} objects look unreferenced (>50%). Check DB / base URL config.`
    )
  }

  const bytes = candidates.reduce((sum, o) => sum + (o.Size || 0), 0)
  const dir = path.join(process.cwd(), 'scripts', 'reports')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `media-cleanup-${Date.now()}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        apply: args.apply,
        graceDays: args.graceDays,
        scanned,
        referenced: referenced.size,
        candidates: candidates.map((o) => ({ key: o.Key, size: o.Size, lastModified: o.LastModified })),
      },
      null,
      2
    )
  )

  console.log(
    `Scanned ${scanned} objects; ${candidates.length} unused for ${args.graceDays}+ days (${(bytes / 1e6).toFixed(1)} MB)`
  )
  console.log(`Report: ${file}`)
  if (!args.apply) {
    console.log('Dry-run only. Re-run with --apply to delete (recoverable via versioning).')
    return
  }

  for (let i = 0; i < candidates.length; i += 1000) {
    const batch = candidates.slice(i, i + 1000)
    await client.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: batch.map((o) => ({ Key: o.Key! })), Quiet: true },
      })
    )
  }
  console.log(`Deleted ${candidates.length} unused objects.`)
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().catch(() => undefined))
