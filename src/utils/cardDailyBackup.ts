export const CARD_BACKUP_KEEP_DAYS = 7

export type CardMediaKind = 'image' | 'video' | 'none'

export type CardMediaSlot = {
  id: 'avatar' | 'intro' | 'background'
  label: string
  kind: CardMediaKind
}

export type CardTabCount = {
  id: string
  label: string
  count: number
  empty: boolean
  /** Only on tabs whose items carry an image (services, blogs, photos, reviews…). */
  withImage?: number
  withoutImage?: number
}

/** Stored inside the backup `tabs` JSON; never counted as a tab. */
export const PERSONAL_MEDIA_ENTRY_ID = '__personal_media'

const VIDEO_URL = /\.(m4v|mov|mp4|ogv|webm)(\?|#|$)|youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com/i

export function mediaKindForUrl(url: string | null | undefined): CardMediaKind {
  const raw = (url || '').trim()
  if (!raw) return 'none'
  return VIDEO_URL.test(raw) ? 'video' : 'image'
}

export function withImageBreakdown(tab: CardTabCount, images: Array<string | null | undefined>): CardTabCount {
  const withImage = images.filter((image) => Boolean(image?.trim())).length
  return { ...tab, withImage, withoutImage: Math.max(0, tab.count - withImage) }
}

export function readMediaSlots(value: unknown): CardMediaSlot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as { id?: unknown; label?: unknown; kind?: unknown }
    if (row.id !== 'avatar' && row.id !== 'intro' && row.id !== 'background') return []
    const kind: CardMediaKind = row.kind === 'image' || row.kind === 'video' ? row.kind : 'none'
    return [{ id: row.id, label: typeof row.label === 'string' ? row.label : row.id, kind }]
  })
}

const EXTRA_NAV_LABELS: Record<string, string> = {
  home: 'Home',
  about: 'About Me',
  education: 'Education',
  work: 'Work Experience',
  skills: 'Skills',
  resume: 'Resume',
  profile: 'Profile',
  'public-cards': 'Public Cards',
  'my-info': 'My Info',
  'global-connection': 'Global Connection',
  'content-media': 'Content & media',
  'contact-us': 'Contact Us',
}

export function backupDayKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Tabs currently saved on the card. Saved order wins; otherwise the enabled checkboxes. */
export function resolveCardNavIds(input: { editorNavOrder?: unknown; enabledNavIds?: string[] }): string[] {
  const saved = Array.isArray(input.editorNavOrder)
    ? input.editorNavOrder.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    : []
  const source = saved.length ? saved : input.enabledNavIds || []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of source) {
    const key = id.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    ids.push(key)
  }
  return ids
}

export function labelForNavId(navId: string, customLabel?: string | null): string {
  const custom = customLabel?.trim()
  if (custom) return custom
  if (EXTRA_NAV_LABELS[navId]) return EXTRA_NAV_LABELS[navId]
  return navId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function tabDataLabel(count: number, withImage?: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Empty'
  const base = count === 1 ? '1 item' : `${count} items`
  if (typeof withImage !== 'number') return base
  return `${base} · ${withImage} with image · ${Math.max(0, count - withImage)} no image`
}

export function toTabCount(id: string, label: string, count: number): CardTabCount {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  return { id, label, count: safeCount, empty: safeCount === 0 }
}

/** Newest rows first. Everything after the kept window is deleted. */
export function backupRowIdsToDelete<T extends { id: string }>(
  rowsNewestFirst: T[],
  keep = CARD_BACKUP_KEEP_DAYS
): string[] {
  const limit = Math.max(1, keep)
  return rowsNewestFirst.slice(limit).map((row) => row.id)
}
