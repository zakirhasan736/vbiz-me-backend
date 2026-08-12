import crypto from 'node:crypto'
import webpush from 'web-push'
import type { PushNotificationPreference } from '../../generated/prisma/client'
import config from '../configs/config'
import AppError from '../error/AppError'
import logger from '../utils/logger'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'

export type PushPreferenceKey =
  | 'service_updates'
  | 'portfolio_updates'
  | 'contact_updates'
  | 'offers'
  | 'business_hours'
  | 'news'
  | 'event_updates'
  | 'announcement_updates'
  | 'theme_updates'

export type SnakeCasePreferences = Record<PushPreferenceKey, boolean>

export type PushPayload = {
  title: string
  body: string
  type: PushPreferenceKey | string
  slug?: string
  url?: string
  businessName?: string
  icon?: string
  avatarUrl?: string
  avatarImageUrl?: string
  profile_id?: string
  profileId?: string
}

const PREFERENCE_FIELD: Record<PushPreferenceKey, keyof PushNotificationPreference> = {
  service_updates: 'serviceUpdates',
  portfolio_updates: 'portfolioUpdates',
  contact_updates: 'contactUpdates',
  offers: 'offers',
  business_hours: 'businessHours',
  news: 'news',
  event_updates: 'eventUpdates',
  announcement_updates: 'announcementUpdates',
  theme_updates: 'themeUpdates',
}

const DEFAULT_PREFERENCES: SnakeCasePreferences = {
  service_updates: true,
  portfolio_updates: true,
  contact_updates: true,
  offers: true,
  business_hours: true,
  news: true,
  event_updates: true,
  announcement_updates: true,
  theme_updates: false,
}

let vapidConfigured = false

const ensureVapid = () => {
  if (vapidConfigured) return
  const publicKey = config.VAPID.PUBLIC_KEY
  const privateKey = config.VAPID.PRIVATE_KEY
  if (!publicKey || !privateKey) {
    throw new AppError(500, 'VAPID keys are not configured on the server.')
  }
  webpush.setVapidDetails(config.VAPID.SUBJECT, publicKey, privateKey)
  vapidConfigured = true
}

/** Public half only — safe to expose to browsers for PushManager.subscribe. */
const getVapidPublicKey = () => {
  const publicKey = config.VAPID.PUBLIC_KEY?.trim()
  if (!publicKey) {
    throw new AppError(503, 'Push notifications are not configured on the server (missing VAPID keys).')
  }
  return { publicKey }
}

const hashEndpoint = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex')

export const preferencesToSnake = (prefs: PushNotificationPreference | null | undefined): SnakeCasePreferences => {
  if (!prefs) return { ...DEFAULT_PREFERENCES }
  return {
    service_updates: prefs.serviceUpdates,
    portfolio_updates: prefs.portfolioUpdates,
    contact_updates: prefs.contactUpdates,
    offers: prefs.offers,
    business_hours: prefs.businessHours,
    news: prefs.news,
    event_updates: prefs.eventUpdates,
    announcement_updates: prefs.announcementUpdates,
    theme_updates: prefs.themeUpdates,
  }
}

type PreferenceBooleanFields = {
  serviceUpdates?: boolean
  portfolioUpdates?: boolean
  contactUpdates?: boolean
  offers?: boolean
  businessHours?: boolean
  news?: boolean
  eventUpdates?: boolean
  announcementUpdates?: boolean
  themeUpdates?: boolean
}

const snakeToPrismaData = (preferences: Partial<SnakeCasePreferences>): PreferenceBooleanFields => {
  const data: PreferenceBooleanFields = {}
  for (const [snakeKey, field] of Object.entries(PREFERENCE_FIELD) as Array<
    [PushPreferenceKey, keyof PreferenceBooleanFields]
  >) {
    if (typeof preferences[snakeKey] === 'boolean') {
      data[field] = preferences[snakeKey]
    }
  }
  return data
}

const preferenceAllows = (prefs: PushNotificationPreference | null | undefined, type: string): boolean => {
  const key = type as PushPreferenceKey
  const field = PREFERENCE_FIELD[key]
  if (!field) return true
  if (!prefs) return DEFAULT_PREFERENCES[key] !== false
  return Boolean(prefs[field])
}

const resolvePublicProfile = async (input: { profile_slug?: string; profile_id?: string }) => {
  const profile = await prisma.profile.findFirst({
    where: input.profile_id ? { id: input.profile_id, isPublic: true } : { slug: input.profile_slug, isPublic: true },
    select: {
      id: true,
      slug: true,
      name: true,
      companyName: true,
      avatar: true,
      settings: { where: { key: { in: ['profile_media_url', 'company_logo'] } }, select: { key: true, value: true } },
    },
  })
  if (!profile) throw new AppError(404, 'Profile not found')
  return profile
}

const mediaFromProfile = (profile: {
  avatar: string | null
  settings: Array<{ key: string; value: string | null }>
}) => {
  const settingMap = Object.fromEntries(profile.settings.map((s) => [s.key, s.value]))
  const icon =
    ensureAbsoluteMediaUrl(settingMap.profile_media_url) ||
    ensureAbsoluteMediaUrl(settingMap.company_logo) ||
    ensureAbsoluteMediaUrl(profile.avatar) ||
    undefined
  return { icon, avatarUrl: icon, avatarImageUrl: icon }
}

const subscribe = async (input: {
  profile_slug?: string
  profile_id?: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  browser?: string
  platform?: string
}) => {
  if (!config.VAPID.PUBLIC_KEY || !config.VAPID.PRIVATE_KEY) {
    throw new AppError(503, 'Push notifications are not configured on the server (missing VAPID keys).')
  }
  if (!input.endpoint?.trim() || !input.keys?.p256dh || !input.keys?.auth) {
    throw new AppError(400, 'endpoint and keys are required')
  }
  if (!input.profile_id && !input.profile_slug) {
    throw new AppError(400, 'profile_slug or profile_id is required')
  }

  const profile = await resolvePublicProfile(input)
  const endpointHash = hashEndpoint(input.endpoint)

  const sub = await prisma.pushSubscription.upsert({
    where: {
      profileId_endpointHash: {
        profileId: profile.id,
        endpointHash,
      },
    },
    create: {
      profileId: profile.id,
      endpoint: input.endpoint,
      endpointHash,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      browser: input.browser,
      platform: input.platform,
      isActive: true,
      lastUsedAt: new Date(),
      preferences: { create: {} },
    },
    update: {
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      browser: input.browser,
      platform: input.platform,
      isActive: true,
      lastUsedAt: new Date(),
    },
    include: { preferences: true },
  })

  if (!sub.preferences) {
    const preferences = await prisma.pushNotificationPreference.create({
      data: { pushSubscriptionId: sub.id },
    })
    return { id: sub.id, subscribed: true, preferences: preferencesToSnake(preferences) }
  }

  return { id: sub.id, subscribed: true, preferences: preferencesToSnake(sub.preferences) }
}

const subscriptionStatus = async (slug: string, endpoint?: string) => {
  const profile = await prisma.profile.findFirst({ where: { slug, isPublic: true } })
  if (!profile) throw new AppError(404, 'Profile not found')
  if (!endpoint) return { subscribed: false, preferences: null }

  const endpointHash = hashEndpoint(endpoint)
  const sub = await prisma.pushSubscription.findFirst({
    where: { profileId: profile.id, endpointHash, isActive: true },
    include: { preferences: true },
  })

  return {
    subscribed: Boolean(sub),
    preferences: sub ? preferencesToSnake(sub.preferences) : null,
  }
}

const updatePreferences = async (input: {
  profile_slug?: string
  profile_id?: string
  endpoint: string
  preferences: Partial<SnakeCasePreferences>
}) => {
  if (!input.endpoint?.trim()) throw new AppError(400, 'endpoint is required')
  if (!input.profile_id && !input.profile_slug) {
    throw new AppError(400, 'profile_slug or profile_id is required')
  }

  const profile = await resolvePublicProfile(input)
  const endpointHash = hashEndpoint(input.endpoint)
  const sub = await prisma.pushSubscription.findFirst({
    where: { profileId: profile.id, endpointHash, isActive: true },
    include: { preferences: true },
  })
  if (!sub) throw new AppError(404, 'Push subscription not found')

  const data = snakeToPrismaData(input.preferences || {})
  const preferences = sub.preferences
    ? await prisma.pushNotificationPreference.update({
        where: { id: sub.preferences.id },
        data,
      })
    : await prisma.pushNotificationPreference.create({
        data: { pushSubscriptionId: sub.id, ...data },
      })

  return {
    success: true,
    message: 'Your notification preferences were updated.',
    preferences: preferencesToSnake(preferences),
  }
}

const unsubscribe = async (input: { profile_slug?: string; profile_id?: string; endpoint: string }) => {
  if (!input.endpoint?.trim()) throw new AppError(400, 'endpoint is required')
  if (!input.profile_id && !input.profile_slug) {
    throw new AppError(400, 'profile_slug or profile_id is required')
  }

  const profile = await resolvePublicProfile(input)
  const endpointHash = hashEndpoint(input.endpoint)
  const result = await prisma.pushSubscription.updateMany({
    where: { profileId: profile.id, endpointHash },
    data: { isActive: false },
  })

  return { unsubscribed: true, count: result.count }
}

const deactivateSubscription = async (id: string) => {
  await prisma.pushSubscription.update({
    where: { id },
    data: { isActive: false },
  })
}

const sendOne = async (sub: { id: string; endpoint: string; p256dh: string; auth: string }, payload: PushPayload) => {
  ensureVapid()
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      JSON.stringify(payload)
    )
    await prisma.pushSubscription.update({
      where: { id: sub.id },
      data: { lastUsedAt: new Date() },
    })
    return true
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : undefined
    if (statusCode === 404 || statusCode === 410) {
      await deactivateSubscription(sub.id)
      logger.info(`Deactivated dead push subscription ${sub.id}`)
      return false
    }
    logger.error('Failed to send web push', error)
    return false
  }
}

const buildProfilePayload = async (
  profileId: string,
  partial: Omit<PushPayload, 'slug' | 'url' | 'businessName' | 'profile_id' | 'profileId'> &
    Partial<Pick<PushPayload, 'slug' | 'url' | 'businessName'>>
): Promise<PushPayload | null> => {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      slug: true,
      name: true,
      companyName: true,
      avatar: true,
      isPublic: true,
      settings: { where: { key: { in: ['profile_media_url', 'company_logo'] } }, select: { key: true, value: true } },
    },
  })
  if (!profile?.isPublic || !profile.slug) return null

  const businessName = profile.companyName || profile.name || profile.slug
  const media = mediaFromProfile(profile)

  return {
    ...partial,
    slug: partial.slug || profile.slug,
    url: partial.url || `/v/${profile.slug}`,
    businessName: partial.businessName || businessName,
    icon: partial.icon || media.icon,
    avatarUrl: partial.avatarUrl || media.avatarUrl,
    avatarImageUrl: partial.avatarImageUrl || media.avatarImageUrl,
    profile_id: profile.id,
    profileId: profile.id,
  }
}

const sendToProfile = async (
  profileId: string,
  partial: Omit<PushPayload, 'slug' | 'url' | 'businessName' | 'profile_id' | 'profileId'> &
    Partial<Pick<PushPayload, 'slug' | 'url' | 'businessName'>>
) => {
  if (!config.VAPID.PUBLIC_KEY || !config.VAPID.PRIVATE_KEY) {
    logger.warn('Skipping push send: VAPID keys not configured')
    return { sent: 0, skipped: true as const }
  }

  const payload = await buildProfilePayload(profileId, partial)
  if (!payload) return { sent: 0, skipped: true as const }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { profileId, isActive: true },
    include: { preferences: true },
  })

  let sent = 0
  for (const sub of subscriptions) {
    if (!preferenceAllows(sub.preferences, payload.type)) continue
    const ok = await sendOne(sub, payload)
    if (ok) sent += 1
  }

  return { sent, skipped: false as const }
}

/** Fire-and-forget wrapper for owner mutations — never throws to callers. */
const notifyProfileUpdate = (
  profileId: string,
  partial: Omit<PushPayload, 'slug' | 'url' | 'businessName' | 'profile_id' | 'profileId'> &
    Partial<Pick<PushPayload, 'slug' | 'url' | 'businessName'>>
) => {
  void sendToProfile(profileId, partial).catch((error) => {
    logger.error('Background push notify failed', error)
  })
}

const sendTest = async (input: {
  profile_slug?: string
  profile_id?: string
  cardSlug?: string
  endpoint: string
  title?: string
  body?: string
}) => {
  const slug = input.profile_slug || input.cardSlug
  if (!input.endpoint?.trim()) throw new AppError(400, 'endpoint is required')
  if (!input.profile_id && !slug) {
    throw new AppError(400, 'profile_slug or profile_id is required')
  }

  const profile = await resolvePublicProfile({
    profile_id: input.profile_id,
    profile_slug: slug,
  })
  const endpointHash = hashEndpoint(input.endpoint)
  const sub = await prisma.pushSubscription.findFirst({
    where: { profileId: profile.id, endpointHash, isActive: true },
  })
  if (!sub) throw new AppError(404, 'Push subscription not found for this endpoint')

  const businessName = profile.companyName || profile.name || profile.slug || 'vBiz Me'
  const media = mediaFromProfile(profile)
  const payload: PushPayload = {
    title: input.title?.trim() || 'Test notification',
    body: input.body?.trim() || `${businessName} sent a test push notification.`,
    type: 'service_updates',
    slug: profile.slug || undefined,
    url: profile.slug ? `/v/${profile.slug}` : '/',
    businessName,
    ...media,
    profile_id: profile.id,
    profileId: profile.id,
  }

  const ok = await sendOne(sub, payload)
  return { sent: ok, message: ok ? 'Test notification sent.' : 'Failed to send test notification.' }
}

/** Map post type names to preference keys. */
export const preferenceKeyForPostType = (postTypeName?: string | null): PushPreferenceKey => {
  const name = (postTypeName || '').toLowerCase()
  if (name.includes('event')) return 'event_updates'
  if (name.includes('announce')) return 'announcement_updates'
  if (name.includes('offer') || name.includes('promo')) return 'offers'
  return 'news'
}

export const preferenceKeyForCollection = (
  kind: 'services' | 'portfolios' | 'socialLinks' | 'experiences' | 'education' | 'skillTags' | 'reviews' | 'addresses'
): PushPreferenceKey | null => {
  switch (kind) {
    case 'services':
      return 'service_updates'
    case 'portfolios':
      return 'portfolio_updates'
    case 'socialLinks':
      return 'contact_updates'
    case 'experiences':
    case 'education':
    case 'skillTags':
      return 'business_hours'
    default:
      return null
  }
}

const pushService = {
  getVapidPublicKey,
  subscribe,
  subscriptionStatus,
  updatePreferences,
  unsubscribe,
  sendTest,
  sendToProfile,
  notifyProfileUpdate,
  preferenceKeyForPostType,
  preferenceKeyForCollection,
  preferencesToSnake,
}

export default pushService
