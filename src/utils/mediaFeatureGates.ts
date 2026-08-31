export type UploadedMediaKind = 'image' | 'video' | 'audio' | 'other'

export type MediaCatalogGate = { all: string[] } | { any: string[] }

const VIDEO_EXT = /\.(m4v|mov|mp4|ogv|webm)(\?|$)/i
const AUDIO_EXT = /\.(aac|flac|m4a|mp3|ogg|wav)(\?|$)/i
const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|svg|webp)(\?|$)/i
const VIDEO_HOST = /(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com)/i

export function guessUploadedKind(input: {
  mimetype?: string | null
  filename?: string | null
  url?: string | null
}): UploadedMediaKind {
  const mime = (input.mimetype || '').toLowerCase()
  const name = `${input.filename || ''} ${input.url || ''}`
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) return 'image'
  if (mime.startsWith('video/') || VIDEO_EXT.test(name) || VIDEO_HOST.test(name)) return 'video'
  if (mime.startsWith('audio/') || AUDIO_EXT.test(name)) return 'audio'
  return 'other'
}

export function isVideoLikeUrl(value: string | null | undefined): boolean {
  const raw = (value || '').trim()
  if (!raw) return false
  return guessUploadedKind({ url: raw }) === 'video'
}

export function catalogGateSatisfied(gate: MediaCatalogGate, allowed: (key: string) => boolean): boolean {
  if ('any' in gate) return gate.any.some((key) => allowed(key))
  return gate.all.every((key) => allowed(key))
}

export function mediaUploadCatalogGate(input: {
  attachmentType?: string | null
  kind: UploadedMediaKind
}): MediaCatalogGate | null {
  const type = (input.attachmentType || '').trim().toLowerCase()
  if (!type) return null

  if (type === 'profile image/video') {
    return input.kind === 'video' ? { all: ['allow_video_upload'] } : null
  }
  if (type === 'background video/image') {
    return input.kind === 'video' ? { all: ['allow_background_video_upload'] } : null
  }
  if (type === 'intro vcard video') {
    return input.kind === 'video' ? { all: ['allow_intro_video_upload'] } : null
  }
  if (type === '2d video explainer') {
    return input.kind === 'video' ? { all: ['allow_2d_explainer'] } : null
  }
  if (type === 'background music') {
    return input.kind === 'audio' || input.kind === 'other'
      ? { all: ['allow_music_upload', 'allow_bg_music_upload'] }
      : null
  }
  return null
}

const SETTING_GATES: Record<string, MediaCatalogGate | ((value: string) => MediaCatalogGate | null)> = {
  intro_youtube_url: { all: ['allow_intro_video_upload'] },
  intro_video_url: { all: ['allow_intro_video_upload'] },
  background_music_url: { all: ['allow_yt_bg_music_upload'] },
  background_music_file_url: { all: ['allow_music_upload', 'allow_bg_music_upload'] },
  background_media_url: (value) => (isVideoLikeUrl(value) ? { all: ['allow_background_video_upload'] } : null),
  profile_media_url: (value) => (isVideoLikeUrl(value) ? { all: ['allow_video_upload'] } : null),
}

const DISPLAY_FIELD_GATES: Record<string, MediaCatalogGate | ((value: string) => MediaCatalogGate | null)> = {
  'Intro YouTube vCard Video Link': SETTING_GATES.intro_youtube_url,
  'Intro vCard Video': SETTING_GATES.intro_video_url,
  'YouTube Background Music Link': SETTING_GATES.background_music_url,
  'Background Music': SETTING_GATES.background_music_file_url,
  'Background Video/Image': SETTING_GATES.background_media_url,
  'Profile Image/Video': SETTING_GATES.profile_media_url,
}

function resolveGate(
  spec: MediaCatalogGate | ((value: string) => MediaCatalogGate | null) | undefined,
  value: string
): MediaCatalogGate | null {
  if (!spec) return null
  return typeof spec === 'function' ? spec(value) : spec
}

function isNewlyFilled(next: string, previous: string | null | undefined): boolean {
  const value = next.trim()
  if (!value) return false
  return value !== (previous || '').trim()
}

function displayFieldValue(raw: string | null | undefined, label: string): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { fields?: Record<string, { customValue?: string | null }> }
    return String(parsed?.fields?.[label]?.customValue || '').trim()
  } catch {
    return ''
  }
}

function wallpaperStyle(themeConfig: unknown): string {
  if (!themeConfig || typeof themeConfig !== 'object') return ''
  const wallpaper = (themeConfig as { wallpaper?: { style?: unknown } }).wallpaper
  return typeof wallpaper?.style === 'string' ? wallpaper.style.trim().toLowerCase() : ''
}

export function catalogGatesForSettingChange(
  key: string,
  nextValue: string,
  previousValue?: string | null
): MediaCatalogGate[] {
  const next = (nextValue || '').trim()
  if (!isNewlyFilled(next, previousValue)) return []

  if (key === 'display_settings_json') {
    const gates: MediaCatalogGate[] = []
    for (const [label, spec] of Object.entries(DISPLAY_FIELD_GATES)) {
      const fieldNext = displayFieldValue(next, label)
      const fieldPrev = displayFieldValue(previousValue, label)
      if (!isNewlyFilled(fieldNext, fieldPrev)) continue
      const gate = resolveGate(spec, fieldNext)
      if (gate) gates.push(gate)
    }
    return gates
  }

  const gate = resolveGate(SETTING_GATES[key], next)
  return gate ? [gate] : []
}

export function catalogGateForWallpaperChange(nextTheme: unknown, previousTheme: unknown): MediaCatalogGate | null {
  const next = wallpaperStyle(nextTheme)
  const previous = wallpaperStyle(previousTheme)
  if (next !== 'video' || previous === 'video') return null
  return { all: ['allow_background_video_upload'] }
}

export function firstDeniedFeatureKey(gate: MediaCatalogGate, allowed: (key: string) => boolean): string {
  const keys = 'any' in gate ? gate.any : gate.all
  return keys.find((key) => !allowed(key)) || keys[0] || 'allow_video_upload'
}
