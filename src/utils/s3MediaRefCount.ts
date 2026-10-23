import { normalizeMediaUrlKey } from './attachmentTypeMatch'
import { prisma } from './prisma'

/**
 * Corporate / linked cards duplicate attachment rows with the same S3 `publicId` + URL.
 * Deleting that object when one card replaces intro/profile/background leaves every
 * sibling card with a dead URL (browser shows AWS AccessDenied XML).
 *
 * Only destroy an object when no other card still references it.
 */
export async function s3ObjectStillReferenced(input: {
  publicId: string
  url?: string | null
  /** The card that is replacing/clearing this media — its own rows are ignored. */
  exceptProfileId?: string
  /** Attachment rows already scheduled for delete on the editing card. */
  exceptAttachmentIds?: string[]
}): Promise<boolean> {
  const key = input.publicId.trim()
  if (!key) return false
  const exceptIds = (input.exceptAttachmentIds || []).filter(Boolean)

  const otherAttachment = await prisma.attachment.findFirst({
    where: {
      publicId: key,
      ...(input.exceptProfileId ? { profileId: { not: input.exceptProfileId } } : {}),
      ...(exceptIds.length ? { id: { notIn: exceptIds } } : {}),
    },
    select: { id: true },
  })
  if (otherAttachment) return true

  const urlKey = normalizeMediaUrlKey(input.url)
  if (!urlKey) return false

  // Other cards may keep the URL in settings even if their attachment row drifted.
  const settings = await prisma.setting.findMany({
    where: {
      value: { contains: key },
      ...(input.exceptProfileId ? { profileId: { not: input.exceptProfileId } } : {}),
    },
    select: { value: true },
    take: 50,
  })
  for (const row of settings) {
    const valueKey = normalizeMediaUrlKey(row.value)
    if (valueKey && (valueKey === urlKey || valueKey.includes(key.toLowerCase()))) {
      return true
    }
  }

  return false
}

/** Best-effort S3 delete only when no other card still uses this object. */
export async function destroyS3IfUnreferenced(input: {
  publicId: string
  url?: string | null
  exceptProfileId?: string
  exceptAttachmentIds?: string[]
  destroy: (key: string) => Promise<unknown>
}): Promise<'deleted' | 'kept-shared' | 'skipped'> {
  const key = input.publicId.trim()
  if (!key) return 'skipped'
  if (await s3ObjectStillReferenced(input)) return 'kept-shared'
  await input.destroy(key)
  return 'deleted'
}
