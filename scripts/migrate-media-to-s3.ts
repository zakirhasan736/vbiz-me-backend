/**
 * Upload existing attachment/avatar URLs to AWS S3 and rewrite DB rows.
 *
 * Usage:
 *   yarn tsx --env-file=.env scripts/migrate-media-to-s3.ts
 */
import config from '../src/configs/config'
import logger from '../src/utils/logger'
import { prisma } from '../src/utils/prisma'
import s3Utils from '../src/utils/s3'

const isAlreadyOnS3 = (url?: string | null) => {
  if (!url) return false
  const base = (config.S3.PUBLIC_BASE_URL || '').replace(/\/$/, '')
  if (base && url.startsWith(base)) return true
  return /amazonaws\.com|\.s3[.-]|cloudfront\.net/i.test(url)
}

const resolveUrl = (raw?: string | null): string | null => {
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.startsWith('//')) return `https:${raw}`
  const base = config.MEDIA_BASE_URL.replace(/\/$/, '')
  return `${base}/${raw.replace(/^\//, '')}`
}

async function migrateAttachments() {
  const rows = await prisma.attachment.findMany({
    where: {
      OR: [{ publicId: null }, { url: { not: null } }],
    },
  })

  let ok = 0
  let skip = 0
  let fail = 0

  for (const row of rows) {
    if (isAlreadyOnS3(row.url) && row.publicId) {
      skip += 1
      continue
    }
    const source = resolveUrl(row.url)
    if (!source) {
      skip += 1
      continue
    }
    try {
      const uploaded = await s3Utils.uploadFromUrl(source)
      await prisma.attachment.update({
        where: { id: row.id },
        data: {
          url: uploaded.url,
          publicId: uploaded.publicId,
          resourceType: uploaded.resourceType,
          format: uploaded.format,
          bytes: uploaded.bytes,
          extension: uploaded.format || row.extension,
        },
      })
      ok += 1
      logger.info(`[attachment] ${row.id} -> ${uploaded.url}`)
    } catch (err) {
      fail += 1
      logger.error(`[attachment] FAILED ${row.id} (${source})`, err)
    }
  }

  return { ok, skip, fail, total: rows.length }
}

async function migrateAvatars() {
  const users = await prisma.user.findMany({ where: { avatar: { not: null } } })
  const profiles = await prisma.profile.findMany({ where: { avatar: { not: null } } })
  let ok = 0
  let skip = 0
  let fail = 0

  for (const user of users) {
    if (isAlreadyOnS3(user.avatar)) {
      skip += 1
      continue
    }
    const source = resolveUrl(user.avatar)
    if (!source) {
      skip += 1
      continue
    }
    try {
      const uploaded = await s3Utils.uploadFromUrl(source, { folder: `${config.S3.KEY_PREFIX}/avatars` })
      await prisma.user.update({ where: { id: user.id }, data: { avatar: uploaded.url } })
      ok += 1
    } catch (err) {
      fail += 1
      logger.error(`[user.avatar] FAILED ${user.id}`, err)
    }
  }

  for (const profile of profiles) {
    if (isAlreadyOnS3(profile.avatar)) {
      skip += 1
      continue
    }
    const source = resolveUrl(profile.avatar)
    if (!source) {
      skip += 1
      continue
    }
    try {
      const uploaded = await s3Utils.uploadFromUrl(source, { folder: `${config.S3.KEY_PREFIX}/profiles` })
      await prisma.profile.update({ where: { id: profile.id }, data: { avatar: uploaded.url } })
      ok += 1
    } catch (err) {
      fail += 1
      logger.error(`[profile.avatar] FAILED ${profile.id}`, err)
    }
  }

  return { ok, skip, fail, total: users.length + profiles.length }
}

async function main() {
  s3Utils.ensureConfigured()
  logger.info('Migrating attachments to S3…')
  const a = await migrateAttachments()
  logger.info('Attachments:', a)
  logger.info('Migrating avatars to S3…')
  const b = await migrateAvatars()
  logger.info('Avatars:', b)
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
