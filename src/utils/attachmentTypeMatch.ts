/**
 * Builder media type families — match on attachment type name only.
 * Short substrings (intro, background, profile, music) are intentionally omitted
 * so filenames cannot cross-classify Intro vs Background vs Profile.
 */
export const BUILDER_ATTACHMENT_TYPE_ALIASES: Record<string, string[]> = {
  'Profile Image/Video': [
    'profile image/video',
    'profile picture',
    'profile pic',
    'profile_pic',
    'avatar',
    'profile image',
  ],
  'Background Video/Image': ['background video/image', 'background_media', 'bg_video', 'bg video', 'background video'],
  'Intro vCard Video': ['intro vcard video', 'intro video'],
  '2D Video Explainer': ['2d video explainer', '2d explainer', '2d video', 'video explainer', 'video_explainer'],
  'Background Music': ['background music', 'background audio', 'bg music', 'music'],
}

/** Public myCard pickAttachment kind → type-name aliases (no bare short tokens). */
export const PUBLIC_ATTACHMENT_KIND_ALIASES: Record<string, string[]> = {
  profile: ['profile image/video', 'profile picture', 'profile pic', 'profile_pic', 'avatar', 'profile image'],
  background: ['background video/image', 'background_media', 'bg_video', 'bg video', 'background video'],
  intro: ['intro vcard video', 'intro video'],
  explainer: ['2d video explainer', '2d explainer', '2d video', 'video explainer', 'video_explainer'],
  audio: ['background music', 'background audio', 'bg music', 'music'],
}

/** Score how well a type name matches aliases (type name only — never docName). */
export function scoreAttachmentTypeName(typeName: string | null | undefined, aliases: string[]): number {
  const name = (typeName || '').toLowerCase().trim()
  if (!name) return -1
  let best = -1
  for (const alias of aliases) {
    const a = alias.toLowerCase().trim()
    if (!a) continue
    if (name === a) return Math.max(best, a.length + 1000)
    if (name.includes(a)) best = Math.max(best, a.length)
  }
  return best
}

/** True when attachment type name belongs to the given builder/canonical family. */
export function attachmentTypeNameMatches(
  typeName: string | null | undefined,
  canonicalType: string,
  aliases?: string[]
): boolean {
  const name = (typeName || '').toLowerCase().trim()
  if (!name) return false
  const canonical = canonicalType.toLowerCase().trim()
  if (name === canonical) return true
  const list = aliases ?? BUILDER_ATTACHMENT_TYPE_ALIASES[canonicalType] ?? [canonical]
  return scoreAttachmentTypeName(name, list) >= 0
}

export function normalizeMediaUrlKey(url: string | null | undefined): string {
  return (url || '').trim().split(/[?#]/)[0].toLowerCase()
}

export function sameMediaUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeMediaUrlKey(a)
  const right = normalizeMediaUrlKey(b)
  return Boolean(left && right && left === right)
}
