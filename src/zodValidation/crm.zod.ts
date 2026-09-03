import { z } from 'zod'

const emptyToUndefined = (value: unknown) => (value === '' || value == null ? undefined : value)

const listLeadsQuery = z.object({
  q: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(3, 'Search requires at least 3 characters').max(200).optional()
  ),
  profileId: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  origin: z.preprocess(emptyToUndefined, z.enum(['guest', 'crm_external']).optional()),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const createLeadBody = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.preprocess(emptyToUndefined, z.string().trim().email().max(320).optional()),
  phone: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  notes: z.preprocess(emptyToUndefined, z.string().trim().max(5000).optional()),
  profileId: z.string().trim().min(1),
})

const patchLeadBody = z
  .object({
    privateNotes: z.string().max(5000).optional(),
    lastReply: z.string().max(5000).optional(),
  })
  .refine((v) => v.privateNotes !== undefined || v.lastReply !== undefined, {
    message: 'At least one of privateNotes or lastReply is required',
  })

const idParam = z.object({
  id: z.string().trim().min(1),
})

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const scheduleCalendarQuery = z.object({
  from: isoDate,
  to: isoDate,
})

const CrmZodSchema = {
  listLeadsQuery,
  createLeadBody,
  patchLeadBody,
  idParam,
  scheduleCalendarQuery,
}

export type CrmListLeadsQuery = z.infer<typeof listLeadsQuery>
export type CrmCreateLeadBody = z.infer<typeof createLeadBody>
export type CrmPatchLeadBody = z.infer<typeof patchLeadBody>
export type CrmScheduleCalendarQuery = z.infer<typeof scheduleCalendarQuery>

export default CrmZodSchema
