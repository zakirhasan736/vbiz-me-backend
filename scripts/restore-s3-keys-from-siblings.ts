/**
 * Restore missing S3 keys by copying still-living sibling objects (same stem).
 * Does not touch the database — card URLs keep working once the key exists again.
 *
 *   npx tsx --env-file=.env scripts/restore-s3-keys-from-siblings.ts --apply
 *   npx tsx --env-file=.env scripts/restore-s3-keys-from-siblings.ts          # dry-run
 */
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import config from '../src/configs/config'

/** Broken keys still referenced by michelle-loyola services HTML → known living originals. */
const RESTORE_MAP: Array<{ missing: string; from: string }> = [
  { missing: 'vbizme/1793285518140-ML1.jpg', from: 'vbizme/1793270996816-ML-1.jpeg' },
  { missing: 'vbizme/1793269367779-ML6.jpg', from: 'vbizme/1793271039946-ML-6.jpg' },
  { missing: 'vbizme/1793269587394-ML7.jpg', from: 'vbizme/1793271145826-ML-7.jpg' },
  { missing: 'vbizme/1793269385416-ML8.jpg', from: 'vbizme/1793271155086-ML-8.jpg' },
  { missing: 'vbizme/1793269417832-ML9.jpg', from: 'vbizme/1793271115195-ML-9.jpg' },
]

/** No living sibling found for these (client/admin must re-upload once). */
const UNRECOVERABLE = ['vbizme/1793285535889-ML2.jpg', 'vbizme/1793269336295-ML4.jpg', 'vbizme/1793284021958-ML10.jpg']

async function main() {
  const apply = process.argv.includes('--apply')
  const { ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BUCKET, PUBLIC_BASE_URL } = config.S3
  if (!ACCESS_KEY_ID || !SECRET_ACCESS_KEY || !BUCKET) throw new Error('S3 not configured')

  const client = new S3Client({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  })

  console.log(apply ? 'APPLY mode — copying objects' : 'DRY-RUN — pass --apply to write')

  for (const { missing, from } of RESTORE_MAP) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: missing }))
      console.log('SKIP already exists', missing)
      continue
    } catch {
      /* restore */
    }

    try {
      await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: from }))
    } catch {
      console.log('FAIL source missing', from)
      continue
    }

    if (!apply) {
      console.log('WOULD copy', from, '→', missing)
      continue
    }

    const copySource = `${BUCKET}/${from
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')}`
    await client.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: copySource,
        Key: missing,
        MetadataDirective: 'COPY',
      })
    )
    const url = `${(PUBLIC_BASE_URL || '').replace(/\/$/, '')}/${missing}`
    const res = await fetch(url, { method: 'HEAD' })
    console.log('OK   copied', missing, `public HEAD ${res.status}`)
  }

  console.log('\nStill need one re-upload (no sibling on S3):')
  for (const key of UNRECOVERABLE) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
      console.log('  OK already', key)
    } catch {
      console.log('  MISS', key)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
