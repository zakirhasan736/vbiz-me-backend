import { z } from 'zod'
import { WORK_NOTE_STATUSES } from '../services/workNote.service'

const emptyToUndefined = (value: unknown) => (value === '' || value == null ? undefined : value)

const listQuery = z.object({
  q: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(200).optional()),
  status: z.preprocess(emptyToUndefined, z.enum(WORK_NOTE_STATUSES).optional()),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

const createBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.preprocess(emptyToUndefined, z.string().trim().max(10000).optional()),
  status: z.enum(WORK_NOTE_STATUSES).optional(),
  assigneeUserId: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  profileId: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  leadRef: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  startsAt: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  dueAt: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  remindAt: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
})

const updateBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(10000).nullable().optional(),
    status: z.enum(WORK_NOTE_STATUSES).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    assigneeUserId: z.string().trim().min(1).nullable().optional(),
    profileId: z.string().trim().min(1).nullable().optional(),
    leadRef: z.string().trim().min(1).nullable().optional(),
    startsAt: z.string().trim().min(1).nullable().optional(),
    dueAt: z.string().trim().min(1).nullable().optional(),
    remindAt: z.string().trim().min(1).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })

const reorderBody = z.object({
  items: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        status: z.enum(WORK_NOTE_STATUSES),
        sortOrder: z.number().int().min(0).max(10000),
      })
    )
    .min(1)
    .max(200),
})

const idParam = z.object({
  id: z.string().trim().min(1),
})

const WorkNoteZodSchema = {
  listQuery,
  createBody,
  updateBody,
  reorderBody,
  idParam,
}

export type WorkNoteListQuery = z.infer<typeof listQuery>
export type WorkNoteCreateBody = z.infer<typeof createBody>
export type WorkNoteUpdateBody = z.infer<typeof updateBody>
export type WorkNoteReorderBody = z.infer<typeof reorderBody>

export default WorkNoteZodSchema
