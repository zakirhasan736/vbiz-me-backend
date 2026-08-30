import { z } from 'zod'

const emptyToUndefined = (value: unknown) => (value === '' || value == null ? undefined : value)

const listQuery = z.object({
  q: z.preprocess(
    emptyToUndefined,
    z.string().trim().min(3, 'Search requires at least 3 characters').max(200).optional()
  ),
  profileId: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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

const AdminLeadsZodSchema = {
  listQuery,
  patchLeadBody,
  idParam,
}

export type ListLeadsQuery = z.infer<typeof listQuery>
export type PatchLeadBody = z.infer<typeof patchLeadBody>

export default AdminLeadsZodSchema
