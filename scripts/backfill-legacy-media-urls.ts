/**
 * Rewrite bare/relative attachment & avatar paths to full Laravel source URLs
 * so `yarn migrate:media` can download them. Does not upload to S3.
 *
 * Usage:
 *   yarn migrate:media-urls
 */
import logger from '../src/utils/logger'
import { isAbsoluteMediaUrl, isAlreadyOnS3, resolveMediaUrl } from '../src/utils/mediaUrl'
import { prisma } from '../src/utils/prisma'

async function backfillAttachments() {
  const rows = await prisma.attachment.findMany({
    include: {
      attachmentType: true,
      profile: { select: { legacyId: true } },
    },
  })

  let updated = 0
  let skipped = 0
  let unresolved = 0

  for (const row of rows) {
    if (isAlreadyOnS3(row.url) || (row.url && isAbsoluteMediaUrl(row.url))) {
      skipped += 1
      continue
    }

    let profileLegacyId = row.profile?.legacyId ?? null
    if (profileLegacyId == null && row.attachableType.includes('Profile')) {
      const profile = await prisma.profile.findUnique({
        where: { id: row.attachableId },
        select: { legacyId: true },
      })
      profileLegacyId = profile?.legacyId ?? null
    }

    const resolved = resolveMediaUrl({
      url: row.url,
      docName: row.docName,
      attachmentTypeLegacyId: row.attachmentType?.legacyId ?? null,
      attachmentTypeName: row.attachmentType?.name ?? null,
      profileLegacyId,
    })

    if (!resolved || !isAbsoluteMediaUrl(resolved)) {
      unresolved += 1
      logger.warn(
        `[attachment] unresolved ${row.id} url=${row.url} docName=${row.docName} profileLegacyId=${profileLegacyId}`
      )
      continue
    }

    if (resolved === row.url) {
      skipped += 1
      continue
    }

    await prisma.attachment.update({
      where: { id: row.id },
      data: { url: resolved },
    })
    updated += 1
  }

  return { total: rows.length, updated, skipped, unresolved }
}

async function backfillAvatars() {
  let updated = 0
  let skipped = 0
  let unresolved = 0

  const profiles = await prisma.profile.findMany({
    where: { avatar: { not: null } },
    select: { id: true, avatar: true, legacyId: true },
  })

  for (const profile of profiles) {
    if (!profile.avatar || isAlreadyOnS3(profile.avatar) || isAbsoluteMediaUrl(profile.avatar)) {
      skipped += 1
      continue
    }
    const resolved = resolveMediaUrl({
      url: profile.avatar,
      docName: profile.avatar,
      attachmentTypeLegacyId: 13,
      attachmentTypeName: 'Profile Picture',
      profileLegacyId: profile.legacyId,
    })
    if (!resolved || !isAbsoluteMediaUrl(resolved)) {
      unresolved += 1
      continue
    }
    await prisma.profile.update({ where: { id: profile.id }, data: { avatar: resolved } })
    updated += 1
  }

  const users = await prisma.user.findMany({
    where: { avatar: { not: null } },
    select: { id: true, avatar: true },
  })

  for (const user of users) {
    if (!user.avatar || isAlreadyOnS3(user.avatar) || isAbsoluteMediaUrl(user.avatar)) {
      skipped += 1
      continue
    }
    // User avatars without a profile folder cannot be rebuilt reliably — skip
    unresolved += 1
    logger.warn(`[user.avatar] unresolved ${user.id} (${user.avatar})`)
  }

  return { updated, skipped, unresolved }
}

async function main() {
  logger.info('Backfilling legacy media source URLs…')
  const a = await backfillAttachments()
  logger.info('Attachments:', a)
  const b = await backfillAvatars()
  logger.info('Avatars:', b)
  if (a.unresolved > 0 || b.unresolved > 0) {
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    logger.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
