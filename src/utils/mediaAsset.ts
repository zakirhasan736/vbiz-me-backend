import config from '../configs/config'
import logger from './logger'
import { prisma } from './prisma'

/**
 * Media identity + status registry (MediaAsset table).
 *
 * Every file the app writes gets a row: its S3 key (source of truth), which card
 * and which tab/screen it belongs to, and whether it currently exists in S3
 * (ok | missing | pending). The public URL is always rebuilt from the key, so a
 * bucket / CDN change is one config value, not a database edit.
 */

export type MediaStatus = 'ok' | 'missing' | 'pending'

export type MediaIdentity = {
  profileId?: string | null
  area?: string | null
  itemLabel?: string | null
  uploadedById?: string | null
  source?: 'upload' | 'duplicate' | 'backfill' | 'canva' | 'url-import' | 'ai'
}

/** Builder attachment type → tab / screen slug used in keys and reports. */
const ATTACHMENT_TYPE_AREAS: Array<[RegExp, string]> = [
  [/service/i, 'services'],
  [/portfolio/i, 'portfolio'],
  [/gallery|content media/i, 'gallery'],
  [/blog/i, 'blogs'],
  [/about/i, 'about'],
  [/why choose|mission/i, 'mission'],
  [/review|testimonial/i, 'reviews'],
  [/faq/i, 'faqs'],
  [/certificate|licen[cs]e/i, 'certificates'],
  [/resume|document/i, 'documents'],
  [/profile image|avatar|profile pic/i, 'profile'],
  [/intro/i, 'intro-video'],
  [/background video|background_media|bg[ _]video|background video\/image/i, 'background'],
  [/music|audio/i, 'music'],
  [/explainer/i, 'explainer'],
  [/seo|favicon|pwa|icon/i, 'seo'],
  [/banner/i, 'banner'],
  [/company|office/i, 'company'],
  [/crm/i, 'crm'],
]

/** Lowercase slug, letters/digits/dashes only, max 40 chars. */
export function sanitizeArea(value: string | null | undefined): string | null {
  const slug = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || null
}

/** Known tab for a builder attachment type, or null when the type is generic. */
export function knownAreaFromAttachmentType(attachmentType: string | null | undefined): string | null {
  const name = (attachmentType || '').trim()
  if (!name) return null
  for (const [re, area] of ATTACHMENT_TYPE_AREAS) if (re.test(name)) return area
  return null
}

export function areaFromAttachmentType(attachmentType: string | null | undefined): string | null {
  return knownAreaFromAttachmentType(attachmentType) || sanitizeArea(attachmentType)
}

/**
 * Tab for an upload: a specific attachment type wins (avatar / intro / service …),
 * then the builder section the client was on, then the raw type name.
 */
export function resolveUploadArea(attachmentType?: string | null, clientArea?: string | null): string {
  return (
    knownAreaFromAttachmentType(attachmentType) ||
    sanitizeArea(clientArea) ||
    areaFromAttachmentType(attachmentType) ||
    'misc'
  )
}

/** Table that held a URL → tab / screen (used by backfill and health reports). */
const TABLE_AREAS: Record<string, string> = {
  Service: 'services',
  Portfolio: 'portfolio',
  Gallery: 'gallery',
  Blog: 'blogs',
  BlogDirect: 'blogs',
  Post: 'posts',
  PostMeta: 'posts',
  AboutMe: 'about',
  WhyChooseUs: 'mission',
  Review: 'reviews',
  CustomTab: 'custom-tab',
  CustomTabItem: 'custom-tab',
  TabItem: 'custom-tab',
  Video: 'videos',
  VideoLink: 'videos',
  VideoExplainer: 'explainer',
  Client: 'clients',
  Setting: 'settings',
  Attachment: 'attachments',
  Profile: 'profile',
}

export function areaFromTable(table: string, column?: string): string {
  if (table === 'Profile' && column === 'avatar') return 'profile'
  return TABLE_AREAS[table] || sanitizeArea(table) || 'other'
}

/**
 * Folder for a new upload: `<prefix>/cards/<profileId>/<area>` so the key itself
 * says which card and which tab a file belongs to. Without a card yet (new card
 * not saved), files go under the uploading user.
 */
export function mediaFolderFor(identity: { profileId?: string | null; userId?: string | null; area?: string | null }) {
  const prefix = (config.S3.KEY_PREFIX || 'vbizme').replace(/^\/+|\/+$/g, '')
  const area = sanitizeArea(identity.area) || 'misc'
  const profileId = sanitizeArea(identity.profileId)
  if (profileId) return `${prefix}/cards/${profileId}/${area}`
  const userId = sanitizeArea(identity.userId)
  if (userId) return `${prefix}/users/${userId}/${area}`
  return `${prefix}/unassigned/${area}`
}

/** Reads card + area back out of a new-style key (null for legacy flat keys). */
export function identityFromKey(key: string): { profileId: string | null; area: string | null } {
  const match = /(?:^|\/)cards\/([a-z0-9-]+)\/([a-z0-9-]+)\/[^/]+$/i.exec(key)
  if (!match) return { profileId: null, area: null }
  return { profileId: match[1], area: match[2] }
}

/** S3 user metadata so identity survives even if a key is copied or listed raw. */
export function s3MetadataFor(identity: MediaIdentity): Record<string, string> {
  const meta: Record<string, string> = {}
  const put = (k: string, v: string | null | undefined) => {
    const clean = (v || '').replace(/[^\x20-\x7e]/g, '').slice(0, 200)
    if (clean) meta[k] = clean
  }
  put('profile-id', identity.profileId)
  put('area', identity.area)
  put('uploaded-by', identity.uploadedById)
  put('source', identity.source)
  return meta
}

const swallow = (label: string) => (error: unknown) => {
  logger.warn(`media registry: ${label} failed (upload still succeeded)`, { error })
}

/** Record a file as pending before the S3 write. Never throws. */
export async function registerPending(
  key: string,
  identity: MediaIdentity,
  info?: { originalName?: string | null; contentType?: string | null; bytes?: number | null }
): Promise<void> {
  const data = {
    status: 'pending' as MediaStatus,
    profileId: identity.profileId || null,
    area: identity.area || null,
    itemLabel: identity.itemLabel?.slice(0, 200) || null,
    uploadedById: identity.uploadedById || null,
    source: identity.source || 'upload',
    originalName: info?.originalName?.slice(0, 200) || null,
    contentType: info?.contentType || null,
    bytes: info?.bytes ?? null,
  }
  await prisma.mediaAsset
    .upsert({ where: { key }, create: { key, ...data }, update: data })
    .then(() => undefined)
    .catch(swallow('registerPending'))
}

/** Set the current S3 status of a key (creates the row if needed). Never throws. */
export async function setMediaStatus(
  key: string,
  status: MediaStatus,
  extra?: { reason?: string | null; recovered?: boolean; identity?: MediaIdentity }
): Promise<void> {
  const now = new Date()
  const update = {
    status,
    checkedAt: now,
    missingReason: status === 'missing' ? extra?.reason || 'not found in S3' : null,
    ...(extra?.recovered ? { recoveredAt: now } : {}),
  }
  const identity = extra?.identity || {}
  const fromKey = identityFromKey(key)
  await prisma.mediaAsset
    .upsert({
      where: { key },
      update,
      create: {
        key,
        ...update,
        profileId: identity.profileId || fromKey.profileId,
        area: identity.area || fromKey.area,
        itemLabel: identity.itemLabel?.slice(0, 200) || null,
        source: identity.source || 'backfill',
      },
    })
    .then(() => undefined)
    .catch(swallow('setMediaStatus'))
}
