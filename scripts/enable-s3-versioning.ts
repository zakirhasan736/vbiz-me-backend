/**
 * Enable S3 versioning on the card-media bucket + optional noncurrent cleanup.
 *
 * After this:
 * - DeleteObject keeps prior bytes as a previous version / delete marker
 * - Accidental deletes are recoverable (see restore-s3-object-version.ts)
 *
 * Cost control: expire noncurrent versions after N days (default 90).
 * Current (live) objects are never expired by this rule.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/enable-s3-versioning.ts
 *   npx tsx --env-file=.env scripts/enable-s3-versioning.ts --noncurrent-days=30
 *   npx tsx --env-file=.env scripts/enable-s3-versioning.ts --no-lifecycle
 */
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import config from '../src/configs/config'
import logger from '../src/utils/logger'

function parseArgs(argv: string[]) {
  const daysArg = argv.find((a) => a.startsWith('--noncurrent-days='))
  const days = daysArg ? Number(daysArg.slice('--noncurrent-days='.length)) : 90
  return {
    noncurrentDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 90,
    noLifecycle: argv.includes('--no-lifecycle'),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BUCKET } = config.S3
  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET) {
    throw new Error('S3 is not configured (AWS keys / S3_BUCKET)')
  }

  const client = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  })

  const before = await client.send(new GetBucketVersioningCommand({ Bucket: BUCKET }))
  logger.info(`Versioning before: ${before.Status || '(off)'}`)

  await client.send(
    new PutBucketVersioningCommand({
      Bucket: BUCKET,
      VersioningConfiguration: { Status: 'Enabled' },
    })
  )

  const after = await client.send(new GetBucketVersioningCommand({ Bucket: BUCKET }))
  logger.info(`Versioning after: ${after.Status || '(off)'}`)
  if (after.Status !== 'Enabled') {
    throw new Error('PutBucketVersioning did not stick — check IAM s3:PutBucketVersioning')
  }

  if (args.noLifecycle) {
    logger.info('Skipped lifecycle (--no-lifecycle). Noncurrent versions will be kept forever.')
    return
  }

  const ruleId = 'ExpireNoncurrentVbizmeMedia'
  let existingRules: import('@aws-sdk/client-s3').LifecycleRule[] = []
  try {
    const life = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }))
    existingRules = (life.Rules || []).filter((r) => r.ID !== ruleId)
  } catch (err: unknown) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : ''
    if (name !== 'NoSuchLifecycleConfiguration') throw err
  }

  const prefix = (config.S3.KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '') + '/'
  const rule = {
    ID: ruleId,
    Status: 'Enabled' as const,
    Filter: { Prefix: prefix },
    NoncurrentVersionExpiration: {
      NoncurrentDays: args.noncurrentDays,
    },
  }

  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: BUCKET,
      LifecycleConfiguration: {
        Rules: [...existingRules, rule],
      },
    })
  )

  logger.info(
    `Lifecycle: noncurrent versions under ${prefix}* expire after ${args.noncurrentDays} days (live objects kept)`
  )
  logger.info('Done. Deletes are recoverable within that window via scripts/restore-s3-object-version.ts')
}

main().catch((err) => {
  logger.error(err)
  process.exitCode = 1
})
