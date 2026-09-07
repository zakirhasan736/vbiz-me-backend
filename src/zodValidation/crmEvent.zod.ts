import { z } from 'zod'

export const CRM_EVENT_TYPES = [
  'Birthday Wish',
  'Anniversary',
  'Congratulations',
  'Thank You',
  'Follow-up Message',
  'Custom Wish',
] as const

export const CRM_EVENT_STATUSES = ['Scheduled', 'Completed', 'Cancelled'] as const

export const CRM_EVENT_SCOPES = ['global', 'group', 'one_to_one'] as const

export type CrmEventScope = (typeof CRM_EVENT_SCOPES)[number]
export type CrmEventType = (typeof CRM_EVENT_TYPES)[number]
export type CrmEventStatus = (typeof CRM_EVENT_STATUSES)[number]

const eventType = z.string().trim().min(1).max(100)
const eventStatus = z.enum(CRM_EVENT_STATUSES)
const eventScope = z.enum(CRM_EVENT_SCOPES)

const attachmentItem = z.object({
  url: z.string().trim().min(1).max(2000),
  fileName: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().max(200).optional().nullable(),
  publicId: z.string().trim().max(500).optional().nullable(),
  resourceType: z.enum(['image', 'video', 'audio']).optional().nullable(),
})

const createCrmEvent = z
  .object({
    host: z.string().trim().min(1).max(200),
    type: eventType,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
    time: z.string().trim().min(1).max(50),
    status: eventStatus.optional(),
    scope: eventScope.optional(),
    profileId: z.string().min(1).optional().nullable(),
    groupProfileIds: z.array(z.string().min(1)).max(200).optional(),
    companyUserId: z.string().min(1).optional().nullable(),
    attachments: z.array(attachmentItem).max(20).optional().default([]),
    recipientEmail: z.string().trim().email().max(320).optional().nullable(),
    recipientName: z.string().trim().max(200).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const scope = data.scope ?? (data.profileId ? 'one_to_one' : 'global')
    if (scope === 'one_to_one' && !data.profileId) {
      ctx.addIssue({ code: 'custom', message: 'profileId is required for one-to-one events', path: ['profileId'] })
    }
    if (scope === 'group' && !data.groupProfileIds?.length && !data.companyUserId) {
      ctx.addIssue({
        code: 'custom',
        message: 'groupProfileIds or companyUserId is required for group events',
        path: ['groupProfileIds'],
      })
    }
    if (scope === 'global' && data.profileId) {
      ctx.addIssue({ code: 'custom', message: 'Global events must not include profileId', path: ['profileId'] })
    }
  })

const updateCrmEvent = z
  .object({
    host: z.string().trim().min(1).max(200).optional(),
    type: eventType.optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    time: z.string().trim().min(1).max(50).optional(),
    status: eventStatus.optional(),
    scope: eventScope.optional(),
    profileId: z.string().min(1).optional().nullable(),
    groupProfileIds: z.array(z.string().min(1)).max(200).optional(),
    attachments: z.array(attachmentItem).max(20).optional(),
    recipientEmail: z.string().trim().email().max(320).optional().nullable(),
    recipientName: z.string().trim().max(200).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })

const listCrmEventsQuery = z.object({
  status: eventStatus.optional(),
  type: eventType.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  profileId: z.string().min(1).optional(),
  scope: eventScope.optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const idParam = z.object({ id: z.string().min(1) })

const CrmEventZodSchema = {
  createCrmEvent,
  updateCrmEvent,
  listCrmEventsQuery,
  idParam,
  CRM_EVENT_TYPES,
  CRM_EVENT_STATUSES,
  CRM_EVENT_SCOPES,
}

export type CreateCrmEventInput = z.infer<typeof createCrmEvent>
export type UpdateCrmEventInput = z.infer<typeof updateCrmEvent>
export type ListCrmEventsQuery = z.infer<typeof listCrmEventsQuery>
export type CrmEventAttachmentInput = z.infer<typeof attachmentItem>

export default CrmEventZodSchema
