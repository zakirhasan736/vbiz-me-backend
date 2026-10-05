import type { Request } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isStaffRole } from '../constants/userRole'

/** Keep restoreable snapshots ~10 days (was 72h). */
export const CARD_CHANGE_SNAPSHOT_TTL_MS = 10 * 24 * 60 * 60 * 1000
/** Max restoreable snapshots retained per card (older snapshot JSON is cleared). */
export const CARD_CHANGE_SNAPSHOT_KEEP = 10

/** Short Git-like change id (7 digits) for humans to cite / restore. */
export function generateChangeCode(): string {
  return String(Math.floor(1_000_000 + Math.random() * 9_000_000))
}

export type CardChangeActorContext = {
  userId: string
  role: string
  email?: string
  ip?: string
  userAgent?: string
  country?: string
}

const actorStore = new AsyncLocalStorage<CardChangeActorContext>()

export function runWithCardChangeActor<T>(actor: CardChangeActorContext, fn: () => T): T {
  return actorStore.run(actor, fn)
}

export function getCardChangeActor(): CardChangeActorContext | null {
  return actorStore.getStore() ?? null
}

export function cardChangeActorFromRequest(req: Request): CardChangeActorContext | null {
  const user = (req as Request & { user?: { id?: string; role?: string; email?: string } }).user
  if (!user?.id) return null
  const forwarded = req.headers['x-forwarded-for']
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : '') ||
    (typeof req.ip === 'string' ? req.ip : '') ||
    ''
  const countryHeader = req.headers['cf-ipcountry']
  const country = typeof countryHeader === 'string' ? countryHeader.trim() : ''
  return {
    userId: user.id,
    role: user.role || '',
    email: user.email,
    ip: ip || undefined,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    country: country && country !== 'XX' ? country : undefined,
  }
}

export function bindCardChangeContext(req: Request, _res: unknown, next: () => void) {
  const actor = cardChangeActorFromRequest(req)
  if (!actor) {
    next()
    return
  }
  runWithCardChangeActor(actor, next)
}

export function parseDeviceLabel(userAgent?: string | null): string {
  const ua = (userAgent || '').trim()
  if (!ua) return 'Unknown device'
  const os = /windows/i.test(ua)
    ? 'Windows'
    : /mac os|macintosh/i.test(ua)
      ? 'Mac'
      : /android/i.test(ua)
        ? 'Android'
        : /iphone|ipad|ios/i.test(ua)
          ? 'iOS'
          : /linux/i.test(ua)
            ? 'Linux'
            : 'Unknown OS'
  const browser = /edg\//i.test(ua)
    ? 'Edge'
    : /chrome|crios/i.test(ua)
      ? 'Chrome'
      : /safari/i.test(ua) && !/chrome|crios/i.test(ua)
        ? 'Safari'
        : /firefox|fxios/i.test(ua)
          ? 'Firefox'
          : 'Browser'
  return `${browser} on ${os}`
}

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  AU: 'Australia',
  BD: 'Bangladesh',
  IN: 'India',
  PK: 'Pakistan',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  SG: 'Singapore',
  MY: 'Malaysia',
  PH: 'Philippines',
  ID: 'Indonesia',
  TH: 'Thailand',
  VN: 'Vietnam',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  HK: 'Hong Kong',
  TW: 'Taiwan',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  BE: 'Belgium',
  CH: 'Switzerland',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  IE: 'Ireland',
  PT: 'Portugal',
  PL: 'Poland',
  BR: 'Brazil',
  MX: 'Mexico',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  ZA: 'South Africa',
  NG: 'Nigeria',
  KE: 'Kenya',
  EG: 'Egypt',
  TR: 'Turkey',
  IL: 'Israel',
  NZ: 'New Zealand',
  RU: 'Russia',
  UA: 'Ukraine',
}

export function countryNameFromCode(country?: string | null): string {
  const code = country?.trim().toUpperCase() || ''
  if (!code || code === 'XX' || code === 'T1') return ''
  return COUNTRY_NAMES[code] || code
}

export function formatChangeLocation(ip?: string | null, country?: string | null): string {
  const code = country?.trim().toUpperCase() || ''
  const countryName = countryNameFromCode(code)
  const countryLabel = countryName && code && countryName !== code ? `${countryName} (${code})` : countryName || code
  const parts = [countryLabel, ip?.trim()].filter(Boolean)
  return parts.join(' · ') || 'Unknown location'
}

export function resolveActorRoleLabel(input: {
  actorRole: string
  profileUserId?: string | null
  profileCompanyUserId?: string | null
  actorUserId: string
}): string {
  const role = input.actorRole.trim().toLowerCase()
  if (isStaffRole(role)) return 'Admin'
  if (role === 'corporate-owner') return 'Corporate card owner'
  const companyId = input.profileCompanyUserId?.trim() || ''
  if (companyId && companyId !== input.actorUserId && input.profileUserId === input.actorUserId) {
    return 'Corporate team member'
  }
  return 'Card owner'
}

export const AREA_LABELS: Record<string, string> = {
  services: 'Services',
  education: 'Education',
  experiences: 'Experience',
  portfolios: 'Gallery',
  reviews: 'Reviews',
  skillTags: 'Skills',
  socialLinks: 'Social links',
  addresses: 'Address',
  aboutMe: 'About Me',
  settings: 'Card settings',
  personal: 'Personal info',
  tabLabels: 'Tab names',
  posts: 'Posts',
  blogs: 'Blogs',
  customTabs: 'Custom tabs',
  faqs: 'FAQ',
  faq: 'FAQ',
  gallery: 'Gallery',
  photos: 'Photos',
  sync: 'Corporate sync',
  fullShared: 'Corporate sync',
  storage: 'Tab content',
  collection: 'Shared list',
}

export function areaLabelFor(area: string): string {
  if (AREA_LABELS[area]) return AREA_LABELS[area]
  return area
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function summarizeCollectionChange(
  beforeCount: number,
  afterCount: number
): { action: string; summary: string } {
  if (afterCount > beforeCount) {
    const added = afterCount - beforeCount
    return {
      action: 'add',
      summary: `Added ${added} ${added === 1 ? 'item' : 'items'} (${beforeCount} → ${afterCount})`,
    }
  }
  if (afterCount < beforeCount) {
    const removed = beforeCount - afterCount
    return {
      action: 'delete',
      summary: `Removed ${removed} ${removed === 1 ? 'item' : 'items'} (${beforeCount} → ${afterCount})`,
    }
  }
  return {
    action: 'update',
    summary: `Updated list (${beforeCount} → ${afterCount} ${afterCount === 1 ? 'item' : 'items'})`,
  }
}

export function snapshotExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + CARD_CHANGE_SNAPSHOT_TTL_MS)
}

export function isSnapshotRestorable(snapshot: unknown, expiresAt?: Date | string | null, now = new Date()): boolean {
  if (snapshot == null) return false
  if (!expiresAt) return false
  const expires = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  return expires.getTime() > now.getTime()
}

export type CardChangeSnapshot = {
  version: 1
  kind: 'collection' | 'settings' | 'aboutMe' | 'tabItems' | 'posts'
  collectionKind?: string
  tabKey?: string
  postTypeId?: string | null
  items?: unknown
  settings?: Record<string, string | null>
  profileFields?: Record<string, unknown>
  aboutMe?: unknown
}
