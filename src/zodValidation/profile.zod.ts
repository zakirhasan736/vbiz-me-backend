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
  limit: z.coerce.number().int().min(1).max(500).default(24),
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
  /** Admin card action: also deliver to this card's savers, owner inbox, push, and email. */
  deliver: z.boolean().optional().default(false),
  /** Owner backoffice + in-app only — no public banner and no saver push/email. */
  onlyBackoffice: z.boolean().optional().default(false),
})

/** Staff may assign ownership on create; other create fields pass through unchanged. */
const createProfileBody = z
  .object({
    ownerUserId: z.string().trim().min(1).optional(),
    creationKey: z.string().trim().min(8).max(128).optional(),
  })
  .passthrough()

const upsertAboutMeBody = z.object({
  title: z.string().max(500).optional().nullable(),
  description: z.string().max(100_000).optional().nullable(),
  featuredMediaUrl: z.string().max(2000).optional().nullable(),
  featured_image: z.string().max(2000).optional().nullable(),
  featuredMediaFocusY: z.coerce.number().min(0).max(100).optional().nullable(),
  featured_media_focus_y: z.coerce.number().min(0).max(100).optional().nullable(),
  status: z.string().max(20).optional().nullable(),
})

const ProfileZodSchema = {
  recentEngagementQuery,
  dashboardPeriodQuery,
  profileScopeQuery,
  listProfilesQuery,
  checkSlugQuery,
  patchContactBody,
  createTeamNoticeBody,
  createProfileBody,
  upsertAboutMeBody,
  ENGAGEMENT_EVENT_TYPES,
}

export type ListProfilesQuery = z.infer<typeof listProfilesQuery>
export type PatchContactBody = z.infer<typeof patchContactBody>
export type CreateTeamNoticeBody = z.infer<typeof createTeamNoticeBody>

export default ProfileZodSchema
