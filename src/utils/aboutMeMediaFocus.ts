import type { PrismaClient } from '@prisma/client'
import { ensureAbsoluteMediaUrl } from './mediaUrl'
import { isPrismaColumnMismatch, isPrismaMissingTable } from './prismaErrors'

export const ABOUT_ME_MEDIA_FOCUS_Y_KEY = 'about_me_featured_media_focus_y'
export const ABOUT_ME_MEDIA_URL_KEY = 'about_me_featured_media_url'

/** Matches legacy public crop before per-card positioning existed. */
export const DEFAULT_ABOUT_ME_MEDIA_FOCUS_Y = 22

export function clampAboutMeMediaFocusY(value: unknown, fallback: number = DEFAULT_ABOUT_ME_MEDIA_FOCUS_Y): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, Math.round(n)))
}

export async function readAboutMeMediaFocusY(prisma: PrismaClient, profileId: string): Promise<number | null> {
  const row = await prisma.setting.findUnique({
    where: { profileId_key: { profileId, key: ABOUT_ME_MEDIA_FOCUS_Y_KEY } },
    select: { value: true },
  })
  const raw = row?.value?.trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return clampAboutMeMediaFocusY(n, DEFAULT_ABOUT_ME_MEDIA_FOCUS_Y)
}

export async function upsertAboutMeMediaFocusY(
  prisma: PrismaClient,
  profileId: string,
  value: number | null | undefined
): Promise<void> {
  if (value === undefined) return
  if (value === null) {
    await prisma.setting.deleteMany({
      where: { profileId, key: ABOUT_ME_MEDIA_FOCUS_Y_KEY },
    })
    return
  }
  const clamped = clampAboutMeMediaFocusY(value)
  await prisma.setting.upsert({
    where: { profileId_key: { profileId, key: ABOUT_ME_MEDIA_FOCUS_Y_KEY } },
    create: { profileId, key: ABOUT_ME_MEDIA_FOCUS_Y_KEY, value: String(clamped) },
    update: { value: String(clamped) },
  })
}

/** About Me featured media for share previews and my-card hydration. */
export async function readAboutMeFeaturedMediaUrl(
  prisma: PrismaClient,
  profileId: string,
  settings?: Record<string, string>,
  legacyId?: number | null
): Promise<string | null> {
  const isVideo = (url: string) =>
    /\.(mp4|webm|mov|m4v|ogv|ogg)(\?|#|$)/i.test(url) || url.includes('/backgroundVideos/')

  const normalize = (raw: string | null | undefined): string | null => {
    const trimmed = raw?.trim()
    if (!trimmed || isVideo(trimmed)) return null
    return ensureAbsoluteMediaUrl(trimmed, { profileLegacyId: legacyId ?? null, docName: trimmed }) || trimmed
  }

  const fromSettings = normalize(settings?.[ABOUT_ME_MEDIA_URL_KEY])
  if (fromSettings) return fromSettings

  const settingRow = await prisma.setting.findUnique({
    where: { profileId_key: { profileId, key: ABOUT_ME_MEDIA_URL_KEY } },
    select: { value: true },
  })
  const fromSettingRow = normalize(settingRow?.value)
  if (fromSettingRow) return fromSettingRow

  try {
    const about = await prisma.aboutMe.findUnique({
      where: { profileId },
      select: { featuredMediaUrl: true, status: true },
    })
    if (!about || about.status === '0') return null
    return normalize(about.featuredMediaUrl)
  } catch (error) {
    if (!isPrismaMissingTable(error) && !isPrismaColumnMismatch(error)) throw error
    return null
  }
}
