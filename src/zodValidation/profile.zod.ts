import { z } from 'zod'

const ENGAGEMENT_EVENT_TYPES = [
  'profile_view',
  'save_guest_user',
  'save_contact_download',
  'social_click',
  'save_note',
] as const

const recentEngagementQuery = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  profileId: z.string().min(1).optional(),
  eventType: z.enum(ENGAGEMENT_EVENT_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

const profileScopeQuery = z.object({
  scope: z.enum(['created']).optional(),
})

const dashboardPeriodQuery = z.object({
  period: z.enum(['all', '7', '30', '90']).default('all'),
  scope: z.enum(['created']).optional(),
})

const checkSlugQuery = z.object({
  slug: z.string().min(1),
  excludeId: z.string().min(1).optional(),
})

const ProfileZodSchema = {
  recentEngagementQuery,
  dashboardPeriodQuery,
  profileScopeQuery,
  checkSlugQuery,
  ENGAGEMENT_EVENT_TYPES,
}

export default ProfileZodSchema
