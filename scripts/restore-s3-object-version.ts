/**
 * Restore a deleted (or overwritten) object from S3 versioning.
 *
 * Lists versions for a key, then either:
 * - removes the latest delete marker (undelete), or
 * - copies a specific VersionId back to become the current object
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/restore-s3-object-version.ts vbizme/1793285518140-ML1.jpg
 *   npx tsx --env-file=.env scripts/restore-s3-object-version.ts vbizme/1793285518140-ML1.jpg --apply
 *   npx tsx --env-file=.env scripts/restore-s3-object-version.ts vbizme/foo.jpg --version-id=XXXX --apply
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import config from '../src/configs/config'
import logger from '../src/utils/logger'

function parseArgs(argv: string[]) {
  const versionArg = argv.find((a) => a.startsWith('--version-id='))
  const key = argv.find((a) => !a.startsWith('--')) || ''
  return {
    key: key.replace(/^\/+/, ''),
    apply: argv.includes('--apply'),
    versionId: versionArg?.slice('--version-id='.length)?.trim() || '',
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.key) {
    throw new Error('Usage: restore-s3-object-version.ts <key> [--apply] [--version-id=...]')
  }

  const { ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BUCKET, PUBLIC_BASE_URL } = config.S3
  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET) throw new Error('S3 not configured')

  const client = new S3Client({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  })

  const listed = await client.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: args.key, MaxKeys: 50 }))
  const versions = (listed.Versions || []).filter((v) => v.Key === args.key)
  const markers = (listed.DeleteMarkers || []).filter((m) => m.Key === args.key)

  console.log(`Key: ${args.key}`)
  console.log(`Versions (${versions.length}):`)
  for (const v of versions) {
    console.log(`  VER ${v.LastModified?.toISOString()} size=${v.Size} latest=${v.IsLatest} id=${v.VersionId}`)
  }
  console.log(`Delete markers (${markers.length}):`)
  for (const m of markers) {
    console.log(`  DEL ${m.LastModified?.toISOString()} latest=${m.IsLatest} id=${m.VersionId}`)
  }

  if (!versions.length && !markers.length) {
    throw new Error('No versions found — object was never uploaded, or versioning was off when it was deleted')
  }

  const latestMarker = markers.find((m) => m.IsLatest)
  const targetVersion = args.versionId || versions.find((v) => !v.IsLatest)?.VersionId || versions[0]?.VersionId || ''

  if (!args.apply) {
    if (latestMarker) {
      console.log(`\nDRY-RUN: would remove delete marker ${latestMarker.VersionId} (undelete)`)
    } else if (targetVersion) {
      console.log(`\nDRY-RUN: would promote version ${targetVersion} to current`)
    }
    console.log('Re-run with --apply to restore')
    return
  }

  if (latestMarker?.VersionId) {
    await client.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: args.key,
        VersionId: latestMarker.VersionId,
      })
    )
    logger.info(`Removed delete marker ${latestMarker.VersionId}`)
  } else if (targetVersion) {
    const copySource = `${BUCKET}/${args.key
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')}?versionId=${encodeURIComponent(targetVersion)}`
    await client.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        Key: args.key,
        CopySource: copySource,
        MetadataDirective: 'COPY',
      })
    )
    logger.info(`Copied version ${targetVersion} → current`)
  } else {
    throw new Error('Nothing to restore')
  }

  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: args.key }))
    const url = `${(PUBLIC_BASE_URL || '').replace(/\/$/, '')}/${args.key}`
    logger.info(`Restored OK — size=${head.ContentLength} url=${url}`)
  } catch (err) {
    logger.error('Restore ran but HeadObject still fails', err)
    process.exitCode = 1
  }
}

main().catch((err) => {
  logger.error(err)
  process.exitCode = 1
})
