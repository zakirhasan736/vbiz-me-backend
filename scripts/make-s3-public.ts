/**
 * Permanent public-read for card media under the S3 key prefix.
 *
 * Uploads intentionally omit object ACLs (BucketOwnerEnforced). Browsers load
 * direct S3 URLs, so the bucket MUST allow anonymous s3:GetObject on `{prefix}/*`.
 * Without this policy, every new upload returns AccessDenied in the browser.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/make-s3-public.ts
 *   npx tsx --env-file=.env scripts/make-s3-public.ts --verify-key=vbizme/1793285518140-ML1.jpg
 */
import {
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import config from '../src/configs/config'
import logger from '../src/utils/logger'

function parseArgs(argv: string[]) {
  const verifyArg = argv.find((a) => a.startsWith('--verify-key='))
  return {
    verifyKey: verifyArg?.slice('--verify-key='.length)?.trim() || '',
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BUCKET, KEY_PREFIX, PUBLIC_BASE_URL } = config.S3
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

  try {
    const ownership = await client.send(new GetBucketOwnershipControlsCommand({ Bucket: BUCKET }))
    logger.info('Object ownership:', ownership.OwnershipControls?.Rules?.[0]?.ObjectOwnership || 'unknown')
  } catch (err) {
    logger.warn('Could not read ownership controls', err)
  }

  try {
    const block = await client.send(new GetPublicAccessBlockCommand({ Bucket: BUCKET }))
    logger.info('Public access block (before):', block.PublicAccessBlockConfiguration)
  } catch (err) {
    logger.warn('Could not read public access block (may be unset)', err)
  }

  // Allow bucket policies that grant public read (keep ACLs blocked — modern default)
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: BUCKET,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: false,
        RestrictPublicBuckets: false,
      },
    })
  )
  logger.info('Updated public access block to allow a public-read bucket policy')

  const prefix = (KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '')
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicReadVbizmeMedia',
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${BUCKET}/${prefix}/*`],
      },
    ],
  }

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: BUCKET,
      Policy: JSON.stringify(policy),
    })
  )

  try {
    const current = await client.send(new GetBucketPolicyCommand({ Bucket: BUCKET }))
    logger.info('Bucket policy now:', current.Policy)
  } catch (err) {
    logger.warn('Could not re-read bucket policy', err)
  }

  const sampleBase = `${(PUBLIC_BASE_URL || '').replace(/\/$/, '')}/${prefix}/`
  logger.info(`Bucket policy applied: public GetObject on s3://${BUCKET}/${prefix}/*`)
  logger.info(`Public media base: ${sampleBase}`)

  // Prefer an object known to exist; override with --verify-key=...
  const verifyKey = args.verifyKey || `${prefix}/1793285554787-ML3.jpg`
  const verifyUrl = `${(PUBLIC_BASE_URL || '').replace(/\/$/, '')}/${verifyKey.replace(/^\/+/, '')}`
  try {
    const res = await fetch(verifyUrl, { method: 'HEAD', redirect: 'follow' })
    logger.info(`Verify HEAD ${verifyUrl} → HTTP ${res.status}`)
    if (!res.ok) {
      throw new Error(
        `Public read still failing (${res.status}). Check AWS account-level Block Public Access, or IAM permission s3:PutBucketPolicy / s3:PutPublicAccessBlock.`
      )
    }
    logger.info('OK — browsers can load card media URLs again.')
  } catch (err) {
    if (err instanceof Error && err.message.includes('Public read still failing')) throw err
    logger.warn('Could not verify public URL', err)
  }
}

main().catch((err) => {
  logger.error(err)
  process.exitCode = 1
})
