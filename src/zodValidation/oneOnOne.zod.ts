import { z } from 'zod'

export const ONE_ON_ONE_REQUEST_STATUSES = ['open', 'scheduled', 'cancelled', 'completed'] as const
export const ONE_ON_ONE_MEETING_STATUSES = ['scheduled', 'rescheduled', 'cancelled', 'completed'] as const

const createPublicRequest = z.object({
  profileId: z.string().trim().min(1),
  guestName: z.string().trim().min(1).max(200),
  guestEmail: z.string().trim().email().max(200),
  guestPhone: z.string().trim().max(50).optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
})

const scheduleMeeting = z.object({
  requestId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().trim().min(1).max(50),
  durationMinutes: z.number().int().positive().max(480).optional(),
  timezone: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).optional().nullable(),
})

const rescheduleMeeting = scheduleMeeting.extend({
  requestId: z.string().trim().min(1),
})

const cancelMeeting = z.object({
  requestId: z.string().trim().min(1),
})

const completeMeeting = z.object({
  requestId: z.string().trim().min(1),
})

const listOpenRequests = z.object({
  status: z.enum(ONE_ON_ONE_REQUEST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
})

const guestAccessToken = z.object({
  token: z.string().trim().min(1),
})

export const OneOnOneZodSchema = {
  createPublicRequest,
  scheduleMeeting,
  rescheduleMeeting,
  cancelMeeting,
  completeMeeting,
  listOpenRequests,
  guestAccessToken,
  ONE_ON_ONE_REQUEST_STATUSES,
  ONE_ON_ONE_MEETING_STATUSES,
}

export type CreatePublicRequestInput = z.infer<typeof createPublicRequest>
export type ScheduleMeetingInput = z.infer<typeof scheduleMeeting>
export type RescheduleMeetingInput = z.infer<typeof rescheduleMeeting>
export type CancelMeetingInput = z.infer<typeof cancelMeeting>
export type CompleteMeetingInput = z.infer<typeof completeMeeting>
export type ListOpenRequestsQuery = z.infer<typeof listOpenRequests>
export type GuestAccessTokenInput = z.infer<typeof guestAccessToken>
