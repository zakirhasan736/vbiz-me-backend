import { z } from 'zod'

export const ONE_ON_ONE_REQUEST_STATUSES = ['open', 'awaiting_guest', 'scheduled', 'cancelled', 'completed'] as const
export const ONE_ON_ONE_MEETING_STATUSES = ['scheduled', 'rescheduled', 'cancelled', 'completed'] as const

const slotInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().trim().min(1).max(50),
})

const createPublicRequest = z.object({
  profileId: z.string().trim().min(1),
  guestName: z.string().trim().min(1).max(200),
  guestEmail: z.string().trim().email().max(200),
  guestPhone: z.string().trim().max(50).optional().nullable(),
  message: z.string().trim().max(2000).optional().nullable(),
})

/** Owner proposes one or more slots; guest picks one to confirm the meeting. */
const scheduleMeeting = z.object({
  requestId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  timezone: z.string().trim().min(1).max(80),
  durationMinutes: z.number().int().positive().max(480).optional(),
  slots: z.array(slotInput).min(1).max(12),
})

const rescheduleMeeting = z.object({
  requestId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().trim().min(1).max(50),
  durationMinutes: z.number().int().positive().max(480).optional(),
  timezone: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).optional().nullable(),
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

const confirmGuestSlot = z.object({
  slotId: z.string().trim().min(1),
})

export const OneOnOneZodSchema = {
  createPublicRequest,
  scheduleMeeting,
  rescheduleMeeting,
  cancelMeeting,
  completeMeeting,
  listOpenRequests,
  guestAccessToken,
  confirmGuestSlot,
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
export type ConfirmGuestSlotInput = z.infer<typeof confirmGuestSlot>
