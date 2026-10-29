import { sameMediaUrl } from './attachmentTypeMatch'
import { prisma } from './prisma'

/**
 * Corporate / linked cards duplicate attachment rows with the same S3 `publicId` + URL.
 * Collection fields (Service.imageUrl, Portfolio, Gallery, posts, …) also store the
 * public URL directly — Attachment rows alone are not enough.
 *
 * Prefer leaving an orphan S3 object over deleting a URL still shown on a card
 * (missing keys show as AccessDenied XML in the browser).
 */
export async function s3ObjectStillReferenced(input: {
  publicId: string
  url?: string | null
  /** Attachment rows already scheduled for delete (ignored in the attachment scan). */
  exceptAttachmentIds?: string[]
}): Promise<boolean> {
  const key = input.publicId.trim()
  if (!key) return false
  const exceptIds = (input.exceptAttachmentIds || []).filter(Boolean)
  const url = (input.url || '').trim()

  const otherAttachment = await prisma.attachment.findFirst({
    where: {
      publicId: key,
      ...(exceptIds.length ? { id: { notIn: exceptIds } } : {}),
    },
    select: { id: true },
  })
  if (otherAttachment) return true

  const settings = await prisma.setting.findMany({
    where: { value: { contains: key } },
    select: { value: true },
    take: 80,
  })
  for (const row of settings) {
    const value = (row.value || '').trim()
    if (!value) continue
    if (value.includes(key) || (url && sameMediaUrl(value, url))) return true
  }

  const profile = await prisma.profile.findFirst({
    where: { avatar: { contains: key } },
    select: { id: true },
  })
  if (profile) return true

  const contentHit = await Promise.all([
    prisma.service.findFirst({ where: { imageUrl: { contains: key } }, select: { id: true } }),
    prisma.portfolio.findFirst({
      where: { OR: [{ imageUrl: { contains: key } }, { attachmentUrl: { contains: key } }] },
      select: { id: true },
    }),
    prisma.gallery.findFirst({
      where: {
        OR: [{ featuredImage: { contains: key } }, { url: { contains: key } }, { attachmentUrl: { contains: key } }],
      },
      select: { id: true },
    }),
    prisma.post.findFirst({
      where: { OR: [{ featuredImage: { contains: key } }, { url: { contains: key } }] },
      select: { id: true },
    }),
    prisma.blog.findFirst({
      where: { OR: [{ featuredImage: { contains: key } }, { url: { contains: key } }] },
      select: { id: true },
    }),
    prisma.aboutMe.findFirst({
      where: { featuredMediaUrl: { contains: key } },
      select: { id: true },
    }),
    prisma.whyChooseUs.findFirst({
      where: { featuredMediaUrl: { contains: key } },
      select: { id: true },
    }),
    prisma.tabItem.findFirst({
      where: { OR: [{ featuredImage: { contains: key } }, { url: { contains: key } }] },
      select: { id: true },
    }),
  ])

  return contentHit.some(Boolean)
}

/** Best-effort S3 delete only when nothing still uses this object. */
export async function destroyS3IfUnreferenced(input: {
  publicId: string
  url?: string | null
  /** @deprecated Ignored — same-card content URLs must still count as live refs. */
  exceptProfileId?: string
  exceptAttachmentIds?: string[]
  destroy: (key: string) => Promise<unknown>
}): Promise<'deleted' | 'kept-shared' | 'skipped'> {
  const key = input.publicId.trim()
  if (!key) return 'skipped'
  if (
    await s3ObjectStillReferenced({
      publicId: key,
      url: input.url,
      exceptAttachmentIds: input.exceptAttachmentIds,
    })
  ) {
    return 'kept-shared'
  }
  await input.destroy(key)
  return 'deleted'
}
