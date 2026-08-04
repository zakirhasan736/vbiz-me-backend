/**
 * Make the media prefix publicly readable so next/image / browsers can load URLs.
 *
 * Usage:
 *   yarn tsx --env-file=.env scripts/make-s3-public.ts
 */
import {
  GetBucketOwnershipControlsCommand,
  GetPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import config from '../src/configs/config'
import logger from '../src/utils/logger'

async function main() {
  const { ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION, BUCKET, KEY_PREFIX } = config.S3
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
    logger.info('Public access block:', block.PublicAccessBlockConfiguration)
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

  const sample = `${(config.S3.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/${prefix}/`
  logger.info(`Bucket policy applied: public GetObject on s3://${BUCKET}/${prefix}/*`)
  logger.info(`Verify by opening an object URL under ${sample}`)
}

main().catch((err) => {
  logger.error(err)
  process.exitCode = 1
})
