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

export function catalogGatesForSettingChange(
  key: string,
  nextValue: string,
  previousValue?: string | null
): MediaCatalogGate[] {
  // Card Settings / tab settings (wallpaper, intro, music, profile and cover media) are not package-gated.
  void key
  void nextValue
  void previousValue
  return []
}

export function catalogGateForWallpaperChange(nextTheme: unknown, previousTheme: unknown): MediaCatalogGate | null {
  // Fill, gradient, blur, pattern, image, and video are available on every plan.
  void nextTheme
  void previousTheme
  return null
}

export function firstDeniedFeatureKey(gate: MediaCatalogGate, allowed: (key: string) => boolean): string {
  const keys = 'any' in gate ? gate.any : gate.all
  return keys.find((key) => !allowed(key)) || keys[0] || 'allow_video_upload'
}
