import { isSingletonBuilderAttachmentType, normalizeMediaUrlKey } from './attachmentTypeMatch'
import logger from './logger'
import { prisma } from './prisma'
import s3Utils from './s3'

export type DuplicatedMediaClone = {
  url: string
  publicId: string
  bytes?: number | null
  resourceType?: string | null
  format?: string | null
}

export type DuplicateMediaRemap = {
  /** source attachment id → cloned media */
  byAttachmentId: Map<string, DuplicatedMediaClone>
  /** old URL (normalized + raw) → new URL */
  urlMap: Map<string, string>
}

/**
 * Copy-on-write for singleton profile media (intro / profile / background / music / explainer)
 * when duplicating a card. Linked cards must not share the same S3 key — otherwise one
 * card's replace/clear deletes the file every sibling still points at (AccessDenied).
 *
 * Portfolio / gallery items keep shared URLs (collection rows are not singleton destroys).
 */
export async function copySingletonMediaForDuplicate(sourceProfileId: string): Promise<DuplicateMediaRemap> {
  const byAttachmentId = new Map<string, DuplicatedMediaClone>()
  const urlMap = new Map<string, string>()

  const attachments = await prisma.attachment.findMany({
    where: { profileId: sourceProfileId },
    include: { attachmentType: true },
  })

  for (const att of attachments) {
    if (!isSingletonBuilderAttachmentType(att.attachmentType?.name)) continue
    const sourceKey = att.publicId?.trim()
    const sourceUrl = att.url?.trim()
    if (!sourceKey && !sourceUrl) continue

    try {
      let copied: Awaited<ReturnType<typeof s3Utils.copyObject>> | Awaited<ReturnType<typeof s3Utils.uploadFromUrl>>
      if (sourceKey && (await s3Utils.headObject(sourceKey))) {
        copied = await s3Utils.copyObject(sourceKey, {
          filename: att.docName || undefined,
          contentType: att.mimeType || undefined,
          resourceType:
            att.resourceType === 'image' || att.resourceType === 'video' || att.resourceType === 'raw'
              ? att.resourceType
              : 'auto',
        })
      } else if (sourceUrl) {
        copied = await s3Utils.uploadFromUrl(sourceUrl, {
          resourceType:
            att.resourceType === 'image' || att.resourceType === 'video' || att.resourceType === 'raw'
              ? att.resourceType
              : 'auto',
        })
      } else {
        continue
      }

      const clone: DuplicatedMediaClone = {
        url: copied.url,
        publicId: copied.publicId,
        bytes: copied.bytes ?? att.bytes,
        resourceType: copied.resourceType || att.resourceType,
        format: copied.format || att.format,
      }
      byAttachmentId.set(att.id, clone)
      if (sourceUrl) {
        urlMap.set(sourceUrl, clone.url)
        urlMap.set(normalizeMediaUrlKey(sourceUrl), clone.url)
      }
      urlMap.set(normalizeMediaUrlKey(clone.url), clone.url)
    } catch (error) {
      logger.error('duplicate singleton media copy failed; linked card will share source URL', {
        sourceProfileId,
        attachmentId: att.id,
        publicId: sourceKey,
        error,
      })
    }
  }

  return { byAttachmentId, urlMap }
}

/** Rewrite setting values + profile.avatar on the duplicated card to the new S3 URLs. */
export async function applyDuplicatedMediaUrlRemap(
  targetProfileId: string,
  urlMap: Map<string, string>
): Promise<void> {
  if (!urlMap.size) return

  const replaceAll = (input: string): string => {
    let next = input
    for (const [from, to] of urlMap) {
      if (!from || !to || from === to) continue
      if (next.includes(from)) next = next.split(from).join(to)
    }
    return next
  }

  const settings = await prisma.setting.findMany({ where: { profileId: targetProfileId } })
  for (const row of settings) {
    if (!row.value?.trim()) continue
    const next = replaceAll(row.value)
    if (next === row.value) continue
    await prisma.setting.update({
      where: { id: row.id },
      data: { value: next },
    })
  }

  const profile = await prisma.profile.findUnique({
    where: { id: targetProfileId },
    select: { avatar: true },
  })
  if (profile?.avatar?.trim()) {
    const nextAvatar = replaceAll(profile.avatar)
    if (nextAvatar !== profile.avatar) {
      await prisma.profile.update({
        where: { id: targetProfileId },
        data: { avatar: nextAvatar },
      })
    }
  }
}
