import { getCorporateOwnedIds } from './corporateOwnedContent'
import { prisma } from './prisma'

/** Member-only. Not a shared setting, so it never copies onto the owner or other cards. */
export const HIDE_OWNER_PHOTOS_SETTING_KEY = 'hide_owner_photos'
export const HIDE_OWNER_VIDEOS_SETTING_KEY = 'hide_owner_videos'

export function isHideOwnerMediaEnabled(value: string | null | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

export function withoutOwnedIds<T extends { id: string }>(rows: T[], ownedIds: ReadonlySet<string>): T[] {
  if (!ownedIds.size) return rows
  return rows.filter((row) => !ownedIds.has(row.id))
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
  const models = kind === 'photos' ? ['gallery', 'portfolio'] : ['video']
  const sets = await Promise.all(models.map((model) => getCorporateOwnedIds(profileId, model)))
  return new Set(sets.flatMap((ids) => [...ids]))
}
