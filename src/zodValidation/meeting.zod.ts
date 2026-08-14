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

export type MeetingType = (typeof MEETING_TYPES)[number]
export type MeetingStatus = (typeof MEETING_STATUSES)[number]

const meetingType = z.string().trim().min(1).max(100)
const meetingStatus = z.enum(MEETING_STATUSES)

const createMeeting = z.object({
  host: z.string().trim().min(1).max(200),
  type: meetingType,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time: z.string().trim().min(1).max(50),
  location: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  status: meetingStatus.optional(),
  profileId: z.string().min(1).optional().nullable(),
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
    profileId: z.string().min(1).optional().nullable(),
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
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const MeetingZodSchema = {
  createMeeting,
  updateMeeting,
  listMeetingsQuery,
  MEETING_TYPES,
  MEETING_STATUSES,
}

export type CreateMeetingInput = z.infer<typeof createMeeting>
export type UpdateMeetingInput = z.infer<typeof updateMeeting>
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuery>

export default MeetingZodSchema
