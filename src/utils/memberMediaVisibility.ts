import { getCorporateOwnedIds } from './corporateOwnedContent'
import { prisma } from './prisma'

/** Member-only. Not a shared setting, so it never copies onto the owner or other cards. */
export const HIDE_OWNER_PHOTOS_SETTING_KEY = 'hide_owner_photos'
export const HIDE_OWNER_VIDEOS_SETTING_KEY = 'hide_owner_videos'
/** JSON map of section keys → hide corporate-owner list items on this member card. */
export const HIDE_OWNER_SECTIONS_SETTING_KEY = 'hide_owner_sections_json'

export type HideOwnerSectionsMap = Record<string, boolean>

export function isHideOwnerMediaEnabled(value: string | null | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

export function parseHideOwnerSections(raw: string | null | undefined): HideOwnerSectionsMap {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: HideOwnerSectionsMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const section = key.trim()
      if (!section) continue
      if (value === true || value === 1 || value === '1' || value === 'true') out[section] = true
    }
    return out
  } catch {
    return {}
  }
}

export function isHideOwnerSectionEnabled(map: HideOwnerSectionsMap, sectionKey: string): boolean {
  return Boolean(map[sectionKey.trim()])
}

export function customTabHideOwnerSectionKey(tabId: string): string {
  return `custom:${tabId.trim()}`
}

export function withoutOwnedIds<T extends { id: string }>(rows: T[], ownedIds: ReadonlySet<string>): T[] {
  if (!ownedIds.size) return rows
  return rows.filter((row) => !ownedIds.has(row.id))
}

async function readHideOwnerSections(profileId: string): Promise<HideOwnerSectionsMap> {
  const row = await prisma.setting.findUnique({
    where: { profileId_key: { profileId, key: HIDE_OWNER_SECTIONS_SETTING_KEY } },
    select: { value: true },
  })
  return parseHideOwnerSections(row?.value)
}

/**
 * Drop corporate-owner rows from a public list when this member enabled
 * "Only show my items" for the section.
 */
export async function withoutHiddenOwnerSectionRows<T extends { id: string }>(args: {
  profileId: string
  sectionKey: string
  model: string
  rows: T[]
}): Promise<T[]> {
  const map = await readHideOwnerSections(args.profileId)
  if (!isHideOwnerSectionEnabled(map, args.sectionKey)) return args.rows
  const owned = await getCorporateOwnedIds(args.profileId, args.model)
  return withoutOwnedIds(args.rows, owned)
}

async function readHideFlags(profileId: string): Promise<{ hideOwnerPhotos: boolean; hideOwnerVideos: boolean }> {
  const rows = await prisma.setting.findMany({
    where: {
      profileId,
      key: { in: [HIDE_OWNER_PHOTOS_SETTING_KEY, HIDE_OWNER_VIDEOS_SETTING_KEY] },
    },
    select: { key: true, value: true },
  })
  const map = new Map(rows.map((row) => [row.key, row.value]))
  return {
    hideOwnerPhotos: isHideOwnerMediaEnabled(map.get(HIDE_OWNER_PHOTOS_SETTING_KEY)),
    hideOwnerVideos: isHideOwnerMediaEnabled(map.get(HIDE_OWNER_VIDEOS_SETTING_KEY)),
  }
}

/** Ids to omit from this member card's public photos or videos. Empty when the checkbox is off. */
export async function hiddenOwnerMediaIds(profileId: string, kind: 'photos' | 'videos'): Promise<Set<string>> {
  const flags = await readHideFlags(profileId)
  if (kind === 'photos' && !flags.hideOwnerPhotos) return new Set()
  if (kind === 'videos' && !flags.hideOwnerVideos) return new Set()
  return ownedMediaIds(profileId, kind)
}

/** Member-only per-item hide list. Not a shared setting. */
export const HIDDEN_OWNER_MEDIA_SETTING_KEY = 'hidden_owner_media_json'

export type HiddenOwnerMediaEntry = { id: string; fingerprint: string }

export type HiddenOwnerMediaLists = {
  photos: HiddenOwnerMediaEntry[]
  videos: HiddenOwnerMediaEntry[]
}

export type OwnerMediaRow = {
  id: string
  title?: string | null
  description?: string | null
  text?: string | null
  url?: string | null
  imageUrl?: string | null
  featuredImage?: string | null
}

export function ownerMediaFingerprint(row: Omit<OwnerMediaRow, 'id'>): string {
  return [row.title, row.description, row.text, row.url, row.featuredImage, row.imageUrl]
    .map((value) => (value == null ? '' : String(value).trim().toLowerCase()))
    .filter(Boolean)
    .join('|')
}

function readHiddenEntries(value: unknown): HiddenOwnerMediaEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as { id?: unknown; fingerprint?: unknown }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const fingerprint = typeof row.fingerprint === 'string' ? row.fingerprint.trim() : ''
    if (!id && !fingerprint) return []
    return [{ id, fingerprint }]
  })
}

export function parseHiddenOwnerMedia(raw: string | null | undefined): HiddenOwnerMediaLists {
  if (!raw?.trim()) return { photos: [], videos: [] }
  try {
    const parsed = JSON.parse(raw) as { photos?: unknown; videos?: unknown }
    return { photos: readHiddenEntries(parsed.photos), videos: readHiddenEntries(parsed.videos) }
  } catch {
    return { photos: [], videos: [] }
  }
}

export function hiddenOwnerMediaMatches(entries: readonly HiddenOwnerMediaEntry[], row: OwnerMediaRow): boolean {
  const fingerprint = ownerMediaFingerprint(row)
  return entries.some(
    (entry) => (entry.id && entry.id === row.id) || (fingerprint && entry.fingerprint === fingerprint)
  )
}

async function ownedMediaIds(profileId: string, kind: 'photos' | 'videos'): Promise<Set<string>> {
  const models = kind === 'photos' ? ['gallery', 'portfolio'] : ['video']
  const sets = await Promise.all(models.map((model) => getCorporateOwnedIds(profileId, model)))
  return new Set(sets.flatMap((ids) => [...ids]))
}

async function readHiddenOwnerMedia(profileId: string): Promise<HiddenOwnerMediaLists> {
  const row = await prisma.setting.findUnique({
    where: { profileId_key: { profileId, key: HIDDEN_OWNER_MEDIA_SETTING_KEY } },
    select: { value: true },
  })
  return parseHiddenOwnerMedia(row?.value)
}

/**
 * Owner photos or videos this member hid from their public card.
 * The bulk checkbox hides every owned row. Per-item entries hide one row, and still match after
 * the owner sync assigns a new id, as long as the content fingerprint is unchanged.
 */
export async function idsHiddenOnMemberPublicCard(
  profileId: string,
  kind: 'photos' | 'videos',
  rows: readonly OwnerMediaRow[]
): Promise<Set<string>> {
  const hidden = await hiddenOwnerMediaIds(profileId, kind)
  const entries = (await readHiddenOwnerMedia(profileId))[kind]
  if (!entries.length) return hidden
  const owned = await ownedMediaIds(profileId, kind)
  for (const row of rows) {
    if (!owned.has(row.id)) continue
    if (hiddenOwnerMediaMatches(entries, row)) hidden.add(row.id)
  }
  return hidden
}
