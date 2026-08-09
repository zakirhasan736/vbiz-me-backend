import { z } from 'zod'

export const AUDIT_TYPES = [
  'create',
  'update',
  'delete',
  'schedule',
  'cancel',
  'status',
  'settings',
  'view',
  'save',
  'click',
] as const

export type AuditType = (typeof AUDIT_TYPES)[number]

export const ACTIVITY_CATEGORIES = ['all', 'engagement', 'creations', 'updates', 'deletions'] as const

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

const createAuditLog = z.object({
  action: z.string().trim().min(1).max(300),
  details: z.string().trim().min(1).max(2000),
  type: z.enum(AUDIT_TYPES),
  actor: z.string().trim().max(200).optional().nullable(),
  profileId: z.string().min(1).optional().nullable(),
  meta: z.record(z.string(), z.unknown()).optional().nullable(),
})

const listAuditLogsQuery = z.object({
  type: z.enum(AUDIT_TYPES).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const activityFeedQuery = z.object({
  category: z.enum(ACTIVITY_CATEGORIES).default('all'),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const AuditZodSchema = {
  createAuditLog,
  listAuditLogsQuery,
  activityFeedQuery,
  AUDIT_TYPES,
  ACTIVITY_CATEGORIES,
}

export type CreateAuditLogInput = z.infer<typeof createAuditLog>
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuery>
export type ActivityFeedQuery = z.infer<typeof activityFeedQuery>

export default AuditZodSchema
