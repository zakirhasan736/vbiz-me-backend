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
  profileId: z.string().min(1).optional(),
})

const listProfilesQuery = z.object({
  scope: z.enum(['created']).optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['all', 'active', 'inactive', 'paused', 'suspended', 'draft']).optional().default('all'),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'viewCount']).default('updatedAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(24),
})

const dashboardPeriodQuery = z.object({
  period: z.enum(['all', '7', '30', '90']).default('all'),
  scope: z.enum(['created']).optional(),
})

const checkSlugQuery = z.object({
  slug: z.string().min(1),
  excludeId: z.string().min(1).optional(),
})

const patchContactBody = z.object({
  privateNotes: z.string().max(5000).optional(),
  lastReply: z.string().max(2000).optional(),
  source: z.enum(['guest_save', 'contact', 'note']).optional(),
})

const createTeamNoticeBody = z.object({
  text: z.string().trim().min(1).max(2000),
  type: z.enum(['broadcast', 'system', 'info', 'warning', 'success']).default('broadcast'),
  audience: z.enum(['all', 'savers']).default('all'),
  targetProfileId: z.string().min(1).optional(),
})

/** Staff may assign ownership on create; other create fields pass through unchanged. */
const createProfileBody = z
  .object({
    ownerUserId: z.string().trim().min(1).optional(),
  })
  .passthrough()

const ProfileZodSchema = {
  recentEngagementQuery,
  dashboardPeriodQuery,
  profileScopeQuery,
  listProfilesQuery,
  checkSlugQuery,
  patchContactBody,
  createTeamNoticeBody,
  createProfileBody,
  ENGAGEMENT_EVENT_TYPES,
}

export type ListProfilesQuery = z.infer<typeof listProfilesQuery>
export type PatchContactBody = z.infer<typeof patchContactBody>
export type CreateTeamNoticeBody = z.infer<typeof createTeamNoticeBody>

export default ProfileZodSchema
