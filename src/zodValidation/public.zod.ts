import { z } from 'zod'
import { SOCIAL_CHANNELS } from '../utils/dashboardAnalytics'

const trackEvent = z
  .object({
    eventType: z.enum(['social_click', 'profile_view']),
    guestId: z.string().min(1),
    channel: z.enum(SOCIAL_CHANNELS).optional(),
    profileId: z.string().min(1).optional(),
    profile_id: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    profile_slug: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.profileId || data.profile_id || data.slug || data.profile_slug), {
    message: 'profileId or slug is required',
  })
  .refine((data) => data.eventType !== 'social_click' || Boolean(data.channel), {
    message: 'channel is required for social_click',
    path: ['channel'],
  })

const dismissAnnouncement = z.object({
  announcementId: z.string().trim().min(1).optional(),
  visitorId: z.string().trim().min(1).max(200).optional(),
})

const pushKeys = z.object({
  p256dh: z.string().min(1),
  auth: z.string().min(1),
})

const pushPreferencesShape = z.object({
  service_updates: z.boolean().optional(),
  portfolio_updates: z.boolean().optional(),
  contact_updates: z.boolean().optional(),
  offers: z.boolean().optional(),
  business_hours: z.boolean().optional(),
  news: z.boolean().optional(),
  event_updates: z.boolean().optional(),
  announcement_updates: z.boolean().optional(),
  theme_updates: z.boolean().optional(),
})

const pushProfileRef = {
  profile_slug: z.string().min(1).optional(),
  profile_id: z.string().min(1).optional(),
  cardSlug: z.string().min(1).optional(),
}

const pushSubscribe = z
  .object({
    ...pushProfileRef,
    endpoint: z.string().url(),
    keys: pushKeys,
    browser: z.string().optional(),
    platform: z.string().optional(),
    preferences: pushPreferencesShape.optional(),
  })
  .refine((data) => Boolean(data.profile_id || data.profile_slug || data.cardSlug), {
    message: 'profile_slug or profile_id is required',
  })

const pushPreferences = z
  .object({
    ...pushProfileRef,
    endpoint: z.string().url(),
    preferences: pushPreferencesShape,
  })
  .refine((data) => Boolean(data.profile_id || data.profile_slug || data.cardSlug), {
    message: 'profile_slug or profile_id is required',
  })

const pushUnsubscribe = z
  .object({
    ...pushProfileRef,
    endpoint: z.string().url(),
  })
  .refine((data) => Boolean(data.profile_id || data.profile_slug || data.cardSlug), {
    message: 'profile_slug or profile_id is required',
  })

const pushTest = z
  .object({
    ...pushProfileRef,
    endpoint: z.string().url(),
    title: z.string().optional(),
    body: z.string().optional(),
  })
  .refine((data) => Boolean(data.profile_id || data.profile_slug || data.cardSlug), {
    message: 'profile_slug or profile_id is required',
  })

const PublicZodSchema = {
  trackEvent,
  dismissAnnouncement,
  pushSubscribe,
  pushPreferences,
  pushUnsubscribe,
  pushTest,
}

export default PublicZodSchema
