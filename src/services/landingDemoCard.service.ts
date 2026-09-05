import { buildFrontendPublicCardPath } from '../constants/frontendPublicCardPath'
import { publicReadableWhere, slugEquals } from '../utils/cardStatus'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'

type AttachmentWithType = {
  url: string | null
  docName: string | null
  extension: string | null
  mimeType: string | null
  resourceType: string | null
  attachmentType: { name: string | null; legacyId: number | null } | null
}

const PROFILE_MEDIA_ALIASES = [
  'profile picture',
  'profile pic',
  'profile_pic',
  'avatar',
  'profile image',
  'profile image/video',
  'profile',
]

function attachmentLabel(att: AttachmentWithType): string {
  return `${att.attachmentType?.name || ''} ${att.docName || ''}`.toLowerCase()
}

function scoreAttachmentAlias(label: string, aliases: string[]): number {
  let best = -1
  for (const alias of aliases) {
    if (!alias) continue
    if (label === alias) return 100
    if (label.includes(alias)) best = Math.max(best, alias.length)
  }
  return best
}

function pickProfileAttachment(attachments: AttachmentWithType[]) {
  let best: AttachmentWithType | undefined
  let bestScore = -1

  for (const att of attachments) {
    const label = attachmentLabel(att)
    if (label.includes('intro') || label.includes('background') || label.includes('music')) continue
    const score = Math.max(
      scoreAttachmentAlias(att.attachmentType?.name?.toLowerCase() || '', PROFILE_MEDIA_ALIASES),
      scoreAttachmentAlias(att.docName?.toLowerCase() || '', PROFILE_MEDIA_ALIASES)
    )
    if (score > bestScore) {
      bestScore = score
      best = att
    }
  }

  return bestScore >= 0 ? best : undefined
}

function isVideoUrl(url: string, docName?: string | null, mimeType?: string | null, resourceType?: string | null) {
  const hay = `${url} ${docName || ''} ${mimeType || ''} ${resourceType || ''}`.toLowerCase()
  return /\.(mp4|webm|mov|m4v|ogg|ogv)(\?|#|$)/i.test(url) || hay.includes('video') || /^data:video\//i.test(url)
}

function resolveAttachmentUrl(att: AttachmentWithType | undefined, legacyId?: number | null): string | null {
  if (!att?.url?.trim()) return null
  return (
    ensureAbsoluteMediaUrl(att.url.trim(), {
      docName: att.docName,
      attachmentTypeLegacyId: att.attachmentType?.legacyId ?? null,
      attachmentTypeName: att.attachmentType?.name ?? null,
      profileLegacyId: legacyId ?? null,
    }) || att.url.trim()
  )
}

/**
 * Avatar attachment (Profile Image/Video) → profile media setting → Profile.avatar column.
 * Returns null when nothing is available (landing UI shows owner initials).
 */
function resolveDemoAvatar(profile: {
  avatar: string | null
  legacyId: number | null
  settings: { key: string; value: string | null }[]
  attachments: AttachmentWithType[]
}): { url: string | null; is_video: boolean } {
  const settings = Object.fromEntries(
    profile.settings.map((s) => [s.key, s.value ?? '']).filter((entry) => entry[0])
  ) as Record<string, string>
  const fromSettings = settings.profile_media_url?.trim()
  if (fromSettings) {
    const absolute =
      ensureAbsoluteMediaUrl(fromSettings, {
        docName: fromSettings,
        profileLegacyId: profile.legacyId,
      }) || fromSettings
    return { url: absolute, is_video: isVideoUrl(absolute, fromSettings) }
  }

  const profileAtt = pickProfileAttachment(profile.attachments)
  const fromAttachment = resolveAttachmentUrl(profileAtt, profile.legacyId)
  if (fromAttachment) {
    return {
      url: fromAttachment,
      is_video: isVideoUrl(fromAttachment, profileAtt?.docName, profileAtt?.mimeType, profileAtt?.resourceType),
    }
  }

  const avatar = profile.avatar?.trim()
  if (avatar) {
    const absolute =
      ensureAbsoluteMediaUrl(avatar, {
        docName: avatar,
        attachmentTypeLegacyId: 13,
        attachmentTypeName: 'Profile Picture',
        profileLegacyId: profile.legacyId,
      }) || avatar
    return { url: absolute, is_video: isVideoUrl(absolute, avatar) }
  }

  return { url: null, is_video: false }
}

export function twoLetterInitials(name?: string | null): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] || ''}${parts[1]![0] || ''}`.toUpperCase() || '?'
  }
  const single = parts[0] || ''
  if (single.length >= 2) return single.slice(0, 2).toUpperCase()
  if (single.length === 1) return single.toUpperCase()
  return '?'
}

export type LandingDemoCardDto = {
  id: string
  category: string
  slug: string
  name: string | null
  designation: string | null
  avatar_url: string | null
  avatar_is_video: boolean
  initials: string
  profile_path: string
  sort_order: number
}

const getLandingDemoCards = async (): Promise<{ success: true; data: LandingDemoCardDto[] }> => {
  const rows = await prisma.landingDemoCard.findMany({
    where: { status: 'active' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })

  if (rows.length === 0) {
    return { success: true, data: [] }
  }

  const slugs = rows.map((row) => row.slug)
  const profiles = await prisma.profile.findMany({
    where: {
      OR: slugs.map((slug) => ({ slug: slugEquals(slug) })),
      ...publicReadableWhere(),
    },
    include: {
      profession: { select: { name: true } },
      settings: { select: { key: true, value: true } },
      attachments: { include: { attachmentType: true }, take: 12 },
    },
  })

  const bySlug = new Map(profiles.map((p) => [String(p.slug || '').toLowerCase(), p]))

  const data: LandingDemoCardDto[] = rows.map((row) => {
    const profile = bySlug.get(row.slug.toLowerCase())
    const media = profile ? resolveDemoAvatar(profile) : { url: null as string | null, is_video: false }
    const name = profile?.name?.trim() || null
    const designation =
      row.designationOverride?.trim() ||
      profile?.designation?.trim() ||
      profile?.profession?.name?.trim() ||
      profile?.prof?.trim() ||
      null

    return {
      id: row.id,
      category: row.category,
      slug: row.slug,
      name,
      designation,
      avatar_url: media.url,
      avatar_is_video: media.is_video,
      initials: twoLetterInitials(name || row.category),
      profile_path: buildFrontendPublicCardPath(row.slug),
      sort_order: row.sortOrder,
    }
  })

  return { success: true, data }
}

const landingDemoCardService = {
  getLandingDemoCards,
}

export default landingDemoCardService
