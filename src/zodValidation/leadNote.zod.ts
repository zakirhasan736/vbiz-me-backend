import { z } from 'zod'

export const LEAD_NOTE_KINDS = ['text', 'voice', 'voice_to_text'] as const
export type LeadNoteKind = (typeof LEAD_NOTE_KINDS)[number]

const emptyToUndefined = (value: unknown) => (value === '' || value == null ? undefined : value)

const requiredDate = z.string().trim().min(1, 'Date is required')

const leadIdParam = z.object({
  leadId: z.string().trim().min(1),
})

const noteIdParam = z.object({
  leadId: z.string().trim().min(1),
  noteId: z.string().trim().min(1),
})

const createBody = z
  .object({
    kind: z.enum(LEAD_NOTE_KINDS),
    content: z.preprocess(emptyToUndefined, z.string().trim().max(10000).optional()),
    audioUrl: z.preprocess(emptyToUndefined, z.string().trim().url().max(2000).optional()),
    audioFileName: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
    audioMimeType: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
    startsAt: requiredDate,
    dueAt: requiredDate,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'voice') {
      if (!value.audioUrl) {
        ctx.addIssue({ code: 'custom', path: ['audioUrl'], message: 'audioUrl is required for voice notes' })
      }
      return
    }
    if (!value.content?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'content is required' })
    }
  })

const updateBody = z
  .object({
    content: z.string().trim().max(10000).nullable().optional(),
    audioUrl: z.string().trim().url().max(2000).nullable().optional(),
    audioFileName: z.string().trim().max(500).nullable().optional(),
    audioMimeType: z.string().trim().max(200).nullable().optional(),
    startsAt: requiredDate.optional(),
    dueAt: requiredDate.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })
  .superRefine((value, ctx) => {
    if ('startsAt' in value && (value.startsAt == null || !String(value.startsAt).trim())) {
      ctx.addIssue({ code: 'custom', path: ['startsAt'], message: 'Start date is required' })
    }
    if ('dueAt' in value && (value.dueAt == null || !String(value.dueAt).trim())) {
      ctx.addIssue({ code: 'custom', path: ['dueAt'], message: 'Due date is required' })
    }
  })

const LeadNoteZodSchema = {
  leadIdParam,
  noteIdParam,
  createBody,
  updateBody,
}

export type LeadNoteCreateBody = z.infer<typeof createBody>
export type LeadNoteUpdateBody = z.infer<typeof updateBody>

export default LeadNoteZodSchema
