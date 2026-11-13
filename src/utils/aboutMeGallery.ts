import type { PrismaClient } from '@prisma/client'

export const ABOUT_ME_GALLERY_URL_KEY = 'about_me_gallery_url'
export const ABOUT_ME_GALLERY_PREVIEW_KEY = 'about_me_gallery_preview'

export type AboutMeGalleryPreview = {
  url: string
  title: string
  description: string
  image: string
  siteName: string
}

export type AboutMeGalleryState = {
  galleryUrl: string
  galleryPreview: AboutMeGalleryPreview | null
}

function cleanText(value: unknown, max: number): string {
  let cleaned = ''
  for (const char of String(value ?? '')) {
    const code = char.charCodeAt(0)
    cleaned += code < 32 || code === 127 ? ' ' : char
  }
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, max)
}

function cleanHttpUrl(value: unknown, max = 2000): string {
  const raw = cleanText(value, max)
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString().slice(0, max)
  } catch {
    return ''
  }
}

export function parseAboutMeGalleryPreview(raw: unknown): AboutMeGalleryPreview | null {
  if (raw == null || raw === '') return null
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const url = cleanHttpUrl(row.url)
  if (!url) return null
  return {
    url,
    title: cleanText(row.title, 300),
    description: cleanText(row.description, 500),
    image: cleanHttpUrl(row.image),
    siteName: cleanText(row.siteName ?? row.site_name, 200),
  }
}

export function toPublicGalleryLink(gallery: AboutMeGalleryState): {
  url: string
  title: string
  description: string
  image: string
  site_name: string
} | null {
  const url = gallery.galleryPreview?.url || gallery.galleryUrl
  if (!url) return null
  return {
    url,
    title: gallery.galleryPreview?.title || '',
    description: gallery.galleryPreview?.description || '',
    image: gallery.galleryPreview?.image || '',
    site_name: gallery.galleryPreview?.siteName || '',
  }
}

const EMPTY_GALLERY: AboutMeGalleryState = { galleryUrl: '', galleryPreview: null }

export async function readAboutMeGallery(prisma: PrismaClient, profileId: string): Promise<AboutMeGalleryState> {
  const rows = await prisma.setting.findMany({
    where: { profileId, key: { in: [ABOUT_ME_GALLERY_URL_KEY, ABOUT_ME_GALLERY_PREVIEW_KEY] } },
    select: { key: true, value: true },
  })
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value || '']))
  const galleryUrl = cleanHttpUrl(map[ABOUT_ME_GALLERY_URL_KEY])
  if (!galleryUrl) return EMPTY_GALLERY
  const galleryPreview = parseAboutMeGalleryPreview(map[ABOUT_ME_GALLERY_PREVIEW_KEY])
  return {
    galleryUrl,
    galleryPreview: galleryPreview ? { ...galleryPreview, url: galleryPreview.url || galleryUrl } : null,
  }
}

export async function upsertAboutMeGallery(
  prisma: PrismaClient,
  profileId: string,
  input: { galleryUrl?: string | null; galleryPreview?: unknown }
): Promise<void> {
  if (input.galleryUrl === undefined && input.galleryPreview === undefined) return
  const galleryUrl = cleanHttpUrl(input.galleryUrl)
  if (!galleryUrl) {
    await prisma.setting.deleteMany({
      where: { profileId, key: { in: [ABOUT_ME_GALLERY_URL_KEY, ABOUT_ME_GALLERY_PREVIEW_KEY] } },
    })
    return
  }

  const parsed = parseAboutMeGalleryPreview(input.galleryPreview)
  const preview: AboutMeGalleryPreview = parsed
    ? { ...parsed, url: parsed.url || galleryUrl }
    : { url: galleryUrl, title: '', description: '', image: '', siteName: '' }

  await prisma.setting.upsert({
    where: { profileId_key: { profileId, key: ABOUT_ME_GALLERY_URL_KEY } },
    create: { profileId, key: ABOUT_ME_GALLERY_URL_KEY, value: galleryUrl },
    update: { value: galleryUrl },
  })
  await prisma.setting.upsert({
    where: { profileId_key: { profileId, key: ABOUT_ME_GALLERY_PREVIEW_KEY } },
    create: { profileId, key: ABOUT_ME_GALLERY_PREVIEW_KEY, value: JSON.stringify(preview) },
    update: { value: JSON.stringify(preview) },
  })
}
