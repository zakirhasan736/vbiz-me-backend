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

const PublicZodSchema = {
  trackEvent,
}

export default PublicZodSchema
