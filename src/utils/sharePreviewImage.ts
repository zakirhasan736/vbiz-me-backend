import { SEO_IMAGE_SETTING_KEY } from '../services/seoMetadata.service'
import { readAboutMeFeaturedMediaUrl } from './aboutMeMediaFocus'
import { ensureAbsoluteMediaUrl, looksLikeExternalPageUrl } from './mediaUrl'
import { prisma } from './prisma'

const VIDEO_MEDIA_RE = /\.(mp4|webm|mov|m4v|ogv|ogg)(\?|#|$)/i

export const SHARE_PREVIEW_IMAGE_SETTING_KEY = 'share_preview_image_url'

type SharePreviewCard = {
  settings?: Record<string, string>
  profile?: { avatar?: string | null }
  profile_media?: {
    url?: string | null
    fallback_url?: string | null
    video_url?: string | null
    is_video?: boolean
  }
}

function isStillShareImageUrl(url: string): boolean {
  const value = url.trim()
  if (!value) return false
  if (VIDEO_MEDIA_RE.test(value) || value.includes('/backgroundVideos/')) return false
  if (looksLikeExternalPageUrl(value)) return false
  return /^https?:\/\//i.test(value) || value.startsWith('/')
}

function pushStillShareCandidate(
  seen: Set<string>,
  out: string[],
  raw: string | null | undefined,
  legacyId?: number | null
) {
  const trimmed = raw?.trim()
  if (!trimmed) return
  const absolute = ensureAbsoluteMediaUrl(trimmed, { profileLegacyId: legacyId ?? null, docName: trimmed }) || trimmed
  if (!isStillShareImageUrl(absolute) || seen.has(absolute)) return
  seen.add(absolute)
  out.push(absolute)
}

/** Resolve a still image for link-share previews (OG / JSON-LD). */
export async function resolveProfileSharePreviewImageUrl(
  profileId: string,
  legacyId: number | null | undefined,
  card: SharePreviewCard
): Promise<string | null> {
  const settings = card.settings || {}
  const seen = new Set<string>()
  const candidates: string[] = []
  const profileMedia = card.profile_media
  const profileMediaIsVideo =
    profileMedia?.is_video === true ||
    VIDEO_MEDIA_RE.test(profileMedia?.url || '') ||
    VIDEO_MEDIA_RE.test(profileMedia?.video_url || '')

  const linked = Boolean(String(settings.duplicated_from || '').trim())

  // This card's SEO / Home Screen first (never copied from the corporate owner onto linked cards).
  pushStillShareCandidate(seen, candidates, settings[SEO_IMAGE_SETTING_KEY], legacyId)
  pushStillShareCandidate(seen, candidates, settings.pwa_home_screen_icon_url, legacyId)
  pushStillShareCandidate(seen, candidates, settings[SHARE_PREVIEW_IMAGE_SETTING_KEY], legacyId)

  if (profileMediaIsVideo) {
    pushStillShareCandidate(seen, candidates, profileMedia?.fallback_url, legacyId)
    const aboutFeatured = await readAboutMeFeaturedMediaUrl(prisma, profileId, settings, legacyId)
    pushStillShareCandidate(seen, candidates, aboutFeatured, legacyId)
  } else {
    pushStillShareCandidate(seen, candidates, profileMedia?.url, legacyId)
    pushStillShareCandidate(seen, candidates, profileMedia?.fallback_url, legacyId)
  }

  pushStillShareCandidate(seen, candidates, settings.profile_media_url, legacyId)
  pushStillShareCandidate(seen, candidates, settings.profile_image, legacyId)
  pushStillShareCandidate(seen, candidates, settings.profile_image_url, legacyId)

  if (!profileMediaIsVideo) {
    const aboutFeatured = await readAboutMeFeaturedMediaUrl(prisma, profileId, settings, legacyId)
    pushStillShareCandidate(seen, candidates, aboutFeatured, legacyId)
  }

  if (!linked) {
    pushStillShareCandidate(seen, candidates, card.profile?.avatar, legacyId)
    pushStillShareCandidate(seen, candidates, settings.company_logo, legacyId)
    pushStillShareCandidate(seen, candidates, settings.company_icon_url, legacyId)
    pushStillShareCandidate(seen, candidates, settings.featured_image, legacyId)
    pushStillShareCandidate(seen, candidates, settings.featured_image_url, legacyId)
  } else {
    const ownPortrait =
      settings.profile_media_url?.trim() ||
      settings.profile_image?.trim() ||
      settings.profile_image_url?.trim() ||
      (!profileMediaIsVideo ? profileMedia?.url?.trim() || '' : '')
    const avatar = card.profile?.avatar?.trim() || ''
    if (avatar && ownPortrait && avatar === ownPortrait) {
      pushStillShareCandidate(seen, candidates, avatar, legacyId)
    }
  }

  return candidates[0] || null
}
