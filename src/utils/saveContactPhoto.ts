import { readAboutMeFeaturedMediaUrl } from './aboutMeMediaFocus'
import { ensureAbsoluteMediaUrl, looksLikeExternalPageUrl } from './mediaUrl'
import { prisma } from './prisma'

const VIDEO_MEDIA_RE = /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)(\?|#|$)/i
const VIDEO_PATH_RE = /\/(backgroundVideos|videoExplainers|videos)\//i
const IMAGE_SETTING_KEY_RE =
  /logo|avatar|profile.?media|profile.?image|featured.?image|company.?icon|profile.?pic|about.?me|seo_|pwa_home/i
/** This card's portrait settings (Profile Image/Video). */
const PROFILE_PHOTO_SETTING_KEYS = ['profile_media_url', 'profile_image', 'profile_image_url'] as const
/** Card Settings → SEO: Home Screen then Open Graph (unique per linked card). */
const SEO_AREA_PHOTO_KEYS = ['pwa_home_screen_icon_url', 'seo_image_url'] as const
const OTHER_SETTING_KEYS = ['company_logo', 'company_icon_url', 'featured_image', 'featured_image_url']

export type SaveContactPhotoSource = {
  id: string
  avatar?: string | null
  legacyId?: number | null
  settings: Array<{ key: string; value: string | null }> | Record<string, string | null | undefined>
  attachments?: Array<{
    url?: string | null
    docName?: string | null
    resourceType?: string | null
    mimeType?: string | null
    attachmentType?: { name?: string | null; legacyId?: number | null } | null
  }>
}

function settingsMap(settings: SaveContactPhotoSource['settings']): Record<string, string> {
  if (Array.isArray(settings)) {
    return Object.fromEntries(
      settings
        .filter((row) => row.key && row.value != null && String(row.value).trim())
        .map((row) => [row.key.trim().toLowerCase(), String(row.value).trim()])
    )
  }
  const map: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings || {})) {
    const trimmed = value?.trim()
    if (!trimmed) continue
    map[key.trim().toLowerCase()] = trimmed
  }
  return map
}

export function isStillContactPhotoUrl(url: string): boolean {
  const value = url.trim()
  if (!value) return false
  if (VIDEO_MEDIA_RE.test(value) || VIDEO_PATH_RE.test(value)) return false
  if (looksLikeExternalPageUrl(value)) return false
  return /^https?:\/\//i.test(value) || value.startsWith('/')
}

function pushStillPhoto(seen: Set<string>, out: string[], raw: string | null | undefined, legacyId?: number | null) {
  const trimmed = raw?.trim()
  if (!trimmed) return
  const absolute = ensureAbsoluteMediaUrl(trimmed, { profileLegacyId: legacyId ?? null, docName: trimmed }) || trimmed
  if (!isStillContactPhotoUrl(absolute) || seen.has(absolute)) return
  seen.add(absolute)
  out.push(absolute)
}

function isProfileAvatarAttachment(attachment: NonNullable<SaveContactPhotoSource['attachments']>[number]): boolean {
  const name = `${attachment.attachmentType?.name || ''}`.toLowerCase()
  const legacyId = attachment.attachmentType?.legacyId
  if (legacyId === 1 || legacyId === 13) return true
  return /profile|avatar|pic/.test(name) && !/about/.test(name)
}

function isImageAttachment(attachment: NonNullable<SaveContactPhotoSource['attachments']>[number]): boolean {
  const mime = `${attachment.mimeType || ''} ${attachment.resourceType || ''}`.toLowerCase()
  if (mime.includes('video') || mime.includes('audio')) return false
  return true
}

/**
 * Phone contact / VCF photo candidates, in order:
 * 1. This card's profile image
 * 2. About Me featured image
 * 3. Card Settings → Add to Home Screen icon
 * 4. Card Settings → SEO / Open Graph image
 *
 * Linked corporate cards stop after that list — never the owner's avatar, logos,
 * featured images, or cloned attachments.
 */
export function collectSaveContactPhotoCandidates(
  input: SaveContactPhotoSource & { aboutMeFeaturedUrl?: string | null }
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const map = settingsMap(input.settings)
  const legacyId = input.legacyId ?? null
  const attachments = input.attachments || []
  const linked = Boolean(map.duplicated_from?.trim())

  // 1) Profile image
  for (const key of PROFILE_PHOTO_SETTING_KEYS) {
    pushStillPhoto(seen, out, map[key], legacyId)
  }
  // 2) About Me
  pushStillPhoto(seen, out, input.aboutMeFeaturedUrl, legacyId)
  pushStillPhoto(seen, out, map.about_me_featured_media_url, legacyId)
  // 3–4) SEO area: Home Screen icon, then Open Graph
  for (const key of SEO_AREA_PHOTO_KEYS) {
    pushStillPhoto(seen, out, map[key], legacyId)
  }

  if (linked) {
    return out
  }

  pushStillPhoto(seen, out, input.avatar, legacyId)
  for (const key of ['avatar', 'avatar_url']) {
    pushStillPhoto(seen, out, map[key], legacyId)
  }
  for (const attachment of attachments) {
    if (!isImageAttachment(attachment) || !isProfileAvatarAttachment(attachment)) continue
    pushStillPhoto(seen, out, attachment.url || attachment.docName, legacyId)
  }
  pushStillPhoto(seen, out, map.share_preview_image_url, legacyId)
  for (const key of OTHER_SETTING_KEYS) {
    pushStillPhoto(seen, out, map[key], legacyId)
  }
  for (const [key, value] of Object.entries(map)) {
    if (!IMAGE_SETTING_KEY_RE.test(key)) continue
    pushStillPhoto(seen, out, value, legacyId)
  }
  for (const attachment of attachments) {
    if (!isImageAttachment(attachment)) continue
    pushStillPhoto(seen, out, attachment.url || attachment.docName, legacyId)
  }

  return out
}

export async function resolveSaveContactPhotoUrls(profile: SaveContactPhotoSource): Promise<string[]> {
  const map = settingsMap(profile.settings)
  const aboutMeFeaturedUrl = await readAboutMeFeaturedMediaUrl(prisma, profile.id, map, profile.legacyId)
  return collectSaveContactPhotoCandidates({ ...profile, aboutMeFeaturedUrl })
}
