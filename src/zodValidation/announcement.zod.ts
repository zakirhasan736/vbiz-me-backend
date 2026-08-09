import { z } from 'zod'

export const ANNOUNCEMENT_KINDS = ['announcement', 'warning'] as const
export const ANNOUNCEMENT_TYPES = ['info', 'warning', 'success'] as const
export const ANNOUNCEMENT_STATUSES = ['active', 'archived'] as const
export const ANNOUNCEMENT_TARGET_TYPES = ['all', 'specific'] as const

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number]
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number]
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number]
export type AnnouncementTargetType = (typeof ANNOUNCEMENT_TARGET_TYPES)[number]

const announcementKind = z.enum(ANNOUNCEMENT_KINDS)
const announcementType = z.enum(ANNOUNCEMENT_TYPES)
const announcementStatus = z.enum(ANNOUNCEMENT_STATUSES)
const announcementTargetType = z.enum(ANNOUNCEMENT_TARGET_TYPES)

const emailList = z
  .array(z.string().trim().email().max(320))
  .max(100)
  .default([])
  .transform((emails) => [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))])

const optionalDate = z
  .union([z.string().min(1), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' })
      return z.NEVER
    }
    return d
  })

const createAnnouncement = z
  .object({
    kind: announcementKind.optional(),
    type: announcementType,
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(2000),
    status: announcementStatus.optional().default('active'),
    targetType: announcementTargetType.optional().default('all'),
    targetEmails: emailList.optional(),
    startsAt: optionalDate,
    endsAt: optionalDate,
    meta: z.record(z.string(), z.string()).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const targetType = data.targetType ?? 'all'
    const emails = data.targetEmails ?? []
    if (targetType === 'specific' && emails.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one target email is required when targetType is specific',
        path: ['targetEmails'],
      })
    }
    if (data.startsAt && data.endsAt && data.startsAt > data.endsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startsAt must be before endsAt',
        path: ['endsAt'],
      })
    }
  })

const updateAnnouncement = z
  .object({
    kind: announcementKind.optional(),
    type: announcementType.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(2000).optional(),
    status: announcementStatus.optional(),
    targetType: announcementTargetType.optional(),
    targetEmails: emailList.optional(),
    startsAt: optionalDate,
    endsAt: optionalDate,
    meta: z.record(z.string(), z.string()).optional().nullable(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })

const listAnnouncementsQuery = z.object({
  status: announcementStatus.optional(),
  kind: announcementKind.optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const AnnouncementZodSchema = {
  createAnnouncement,
  updateAnnouncement,
  listAnnouncementsQuery,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_TARGET_TYPES,
}

export type CreateAnnouncementInput = z.infer<typeof createAnnouncement>
export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncement>
export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuery>

export default AnnouncementZodSchema
