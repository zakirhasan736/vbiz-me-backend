import { attachmentTypeNameMatches, sameMediaUrl } from '../src/utils/attachmentTypeMatch'
import { isVideoLikeUrl } from '../src/utils/mediaFeatureGates'

export const INTRO_FIELD = 'Intro vCard Video'
export const BACKGROUND_FIELD = 'Background Video/Image'
export const INTRO_URL_KEY = 'intro_video_url'
export const INTRO_YOUTUBE_KEY = 'intro_youtube_url'
export const BACKGROUND_URL_KEY = 'background_media_url'
export const INTRO_CHECKBOX_KEY = 'profile_video_checkbox'
export const INTRO_YT_CHECKBOX_KEY = 'profile_video_link_checkbox'
export const BACKGROUND_CHECKBOX_KEY = 'background_video_checkbox'
export const DISPLAY_SETTINGS_KEY = 'display_settings_json'

const YOUTUBE_RE = /(youtube\.com|youtu\.be)/i

export type DisplayField = {
  visible?: boolean
  customValue?: string
  [key: string]: unknown
}

export type DisplaySettings = {
  fields?: Record<string, DisplayField>
  [key: string]: unknown
}

export type CardMediaSnapshot = {
  profileId: string
  slug: string | null
  name: string
  createdAt: Date
  settings: Record<string, string>
  attachments: Array<{
    id: string
    url: string | null
    mimeType?: string | null
    format?: string | null
    extension?: string | null
    docName?: string | null
    typeName?: string | null
  }>
}

export type MovePlan = {
  profileId: string
  slug: string | null
  name: string
  createdAt: string
  status: 'would_move' | 'skip'
  reason: string
  videoUrl?: string
  videoKind?: 'file' | 'youtube'
  backgroundSource?: 'setting' | 'display' | 'attachment'
  clearBackground?: boolean
}

export function monthsAgo(months: number, from = new Date()): Date {
  const d = new Date(from)
  d.setMonth(d.getMonth() - months)
  return d
}

export function isYoutubeUrl(url: string | null | undefined): boolean {
  return Boolean((url || '').trim() && YOUTUBE_RE.test(url || ''))
}

export function isBackgroundAttachment(typeName?: string | null): boolean {
  return attachmentTypeNameMatches(typeName, BACKGROUND_FIELD)
}

export function isIntroAttachment(typeName?: string | null): boolean {
  return attachmentTypeNameMatches(typeName, INTRO_FIELD)
}

export function extractDisplayFieldUrl(raw: string | null | undefined, field: string): string {
  if (!raw?.trim()) return ''
  try {
    const parsed = JSON.parse(raw) as DisplaySettings
    const value = parsed?.fields?.[field]?.customValue
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

export function patchDisplaySettingsMediaMove(
  raw: string | null | undefined,
  input: { videoUrl: string; youtube: boolean }
): string {
  let parsed: DisplaySettings = {}
  if (raw?.trim()) {
    try {
      const value = JSON.parse(raw) as DisplaySettings
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value
    } catch {
      parsed = {}
    }
  }
  const fields =
    parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields) ? { ...parsed.fields } : {}

  fields[INTRO_FIELD] = {
    ...(fields[INTRO_FIELD] || {}),
    visible: true,
    customValue: input.youtube ? '' : input.videoUrl,
  }
  fields['Intro YouTube vCard Video Link'] = {
    ...(fields['Intro YouTube vCard Video Link'] || {}),
    visible: input.youtube ? true : fields['Intro YouTube vCard Video Link']?.visible,
    customValue: input.youtube ? input.videoUrl : '',
  }
  fields[BACKGROUND_FIELD] = {
    ...(fields[BACKGROUND_FIELD] || {}),
    customValue: '',
  }

  parsed.fields = fields
  return JSON.stringify(parsed)
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = (value || '').trim()
    if (trimmed) return trimmed
  }
  return ''
}

export function resolveBackgroundVideoCandidate(card: CardMediaSnapshot): {
  url: string
  source: 'setting' | 'display' | 'attachment'
} | null {
  const settingUrl = (card.settings[BACKGROUND_URL_KEY] || '').trim()
  const displayUrl = extractDisplayFieldUrl(card.settings[DISPLAY_SETTINGS_KEY], BACKGROUND_FIELD)
  const attachment = card.attachments.find((att) => {
    if (!isBackgroundAttachment(att.typeName)) return false
    const url = (att.url || '').trim()
    if (!url) return false
    return (
      isVideoLikeUrl(url) ||
      isVideoLikeUrl(att.docName) ||
      Boolean(att.mimeType?.toLowerCase().startsWith('video/')) ||
      ['mp4', 'webm', 'mov', 'm4v'].includes((att.format || att.extension || '').toLowerCase())
    )
  })
  const attachmentUrl = (attachment?.url || '').trim()

  for (const [url, source] of [
    [settingUrl, 'setting'],
    [displayUrl, 'display'],
    [attachmentUrl, 'attachment'],
  ] as const) {
    if (url && isVideoLikeUrl(url)) return { url, source }
  }
  return null
}

export function resolveIntroPresent(card: CardMediaSnapshot): boolean {
  const introFile = firstNonEmpty(
    card.settings[INTRO_URL_KEY],
    extractDisplayFieldUrl(card.settings[DISPLAY_SETTINGS_KEY], INTRO_FIELD)
  )
  const introYt = firstNonEmpty(
    card.settings[INTRO_YOUTUBE_KEY],
    extractDisplayFieldUrl(card.settings[DISPLAY_SETTINGS_KEY], 'Intro YouTube vCard Video Link')
  )
  if (introFile || introYt) return true
  return card.attachments.some((att) => isIntroAttachment(att.typeName) && Boolean((att.url || '').trim()))
}

export function planBackgroundVideoToIntroMove(card: CardMediaSnapshot): MovePlan {
  const base = {
    profileId: card.profileId,
    slug: card.slug,
    name: card.name,
    createdAt: card.createdAt.toISOString(),
  }

  if (resolveIntroPresent(card)) {
    return { ...base, status: 'skip', reason: 'Intro video already present' }
  }

  const candidate = resolveBackgroundVideoCandidate(card)
  if (!candidate) {
    return { ...base, status: 'skip', reason: 'No video found on profile background' }
  }

  return {
    ...base,
    status: 'would_move',
    reason: `Move background video (${candidate.source}) → intro`,
    videoUrl: candidate.url,
    videoKind: isYoutubeUrl(candidate.url) ? 'youtube' : 'file',
    backgroundSource: candidate.source,
    clearBackground: true,
  }
}

export function settingsPatchForMove(plan: MovePlan): Record<string, string> {
  if (plan.status !== 'would_move' || !plan.videoUrl) return {}
  const youtube = plan.videoKind === 'youtube'
  const patch: Record<string, string> = {
    [BACKGROUND_URL_KEY]: '',
    [BACKGROUND_CHECKBOX_KEY]: '0',
  }
  if (youtube) {
    patch[INTRO_YOUTUBE_KEY] = plan.videoUrl
    patch[INTRO_YT_CHECKBOX_KEY] = '1'
    patch[INTRO_URL_KEY] = ''
    patch[INTRO_CHECKBOX_KEY] = '0'
  } else {
    patch[INTRO_URL_KEY] = plan.videoUrl
    patch[INTRO_CHECKBOX_KEY] = '1'
    patch[INTRO_YOUTUBE_KEY] = ''
    patch[INTRO_YT_CHECKBOX_KEY] = '0'
  }
  return patch
}

export function matchingBackgroundAttachmentIds(card: CardMediaSnapshot, videoUrl: string): string[] {
  return card.attachments
    .filter((att) => isBackgroundAttachment(att.typeName) && sameMediaUrl(att.url, videoUrl))
    .map((att) => att.id)
}
