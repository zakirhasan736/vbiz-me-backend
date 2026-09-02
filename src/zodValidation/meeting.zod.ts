import { z } from 'zod'

export const MEETING_TYPES = [
  'Growth Meeting',
  'Onboarding Call',
  'Onboarding Session',
  'Phone Consultation',
  'Billing Consultation',
  'Technical Support',
] as const

export const MEETING_STATUSES = ['Scheduled', 'Completed', 'Cancelled'] as const

export const MEETING_SCOPES = ['global', 'group', 'one_to_one'] as const

export type MeetingScope = (typeof MEETING_SCOPES)[number]

export type MeetingType = (typeof MEETING_TYPES)[number]
export type MeetingStatus = (typeof MEETING_STATUSES)[number]

const meetingType = z.string().trim().min(1).max(100)
const meetingStatus = z.enum(MEETING_STATUSES)

const meetingScope = z.enum(MEETING_SCOPES)

const createMeeting = z
  .object({
    host: z.string().trim().min(1).max(200),
    type: meetingType,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    time: z.string().trim().min(1).max(50),
    location: z.string().trim().max(200).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    status: meetingStatus.optional(),
    scope: meetingScope.optional(),
    profileId: z.string().min(1).optional().nullable(),
    groupProfileIds: z.array(z.string().min(1)).max(200).optional(),
    companyUserId: z.string().min(1).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const scope = data.scope ?? (data.profileId ? 'one_to_one' : 'global')
    if (scope === 'one_to_one' && !data.profileId) {
      ctx.addIssue({ code: 'custom', message: 'profileId is required for one-to-one schedules', path: ['profileId'] })
    }
    if (scope === 'group' && !data.groupProfileIds?.length && !data.companyUserId) {
      ctx.addIssue({
        code: 'custom',
        message: 'groupProfileIds or companyUserId is required for group schedules',
        path: ['groupProfileIds'],
      })
    }
    if (scope === 'global' && data.profileId) {
      ctx.addIssue({ code: 'custom', message: 'Global schedules must not include profileId', path: ['profileId'] })
    }
  })

const updateMeeting = z
  .object({
    host: z.string().trim().min(1).max(200).optional(),
    type: meetingType.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    time: z.string().trim().min(1).max(50).optional(),
    location: z.string().trim().max(200).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    status: meetingStatus.optional(),
    scope: meetingScope.optional(),
    profileId: z.string().min(1).optional().nullable(),
    groupProfileIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })

const listMeetingsQuery = z.object({
  status: meetingStatus.optional(),
  type: meetingType.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  profileId: z.string().min(1).optional(),
  scope: meetingScope.optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const listOwnerMeetingsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
  profileId: z.string().min(1).optional(),
  status: meetingStatus.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  upcomingOnly: z.coerce.boolean().optional(),
})

const listOwnerUpcomingQuery = listOwnerMeetingsQuery.pick({ limit: true, profileId: true }).extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

const MeetingZodSchema = {
  createMeeting,
  updateMeeting,
  listMeetingsQuery,
  listOwnerMeetingsQuery,
  listOwnerUpcomingQuery,
  MEETING_TYPES,
  MEETING_STATUSES,
  MEETING_SCOPES,
}

export type CreateMeetingInput = z.infer<typeof createMeeting>
export type UpdateMeetingInput = z.infer<typeof updateMeeting>
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuery>
export type ListOwnerMeetingsQuery = z.infer<typeof listOwnerMeetingsQuery>
export type ListOwnerUpcomingQuery = z.infer<typeof listOwnerUpcomingQuery>

export default MeetingZodSchema
