export const CARD_BACKUP_KEEP_DAYS = 7

export type CardTabCount = {
  id: string
  label: string
  count: number
  empty: boolean
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

export function tabDataLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Empty'
  return count === 1 ? '1 item' : `${count} items`
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
