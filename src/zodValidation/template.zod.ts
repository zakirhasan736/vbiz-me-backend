import { z } from 'zod'

export const CARD_TEMPLATE_IDS = ['v1', 'v2', 'v3'] as const
export type CardTemplateId = (typeof CARD_TEMPLATE_IDS)[number]

export const CARD_TEMPLATE_STATUSES = ['active', 'inactive'] as const
export type CardTemplateStatus = (typeof CARD_TEMPLATE_STATUSES)[number]

const updateCardTemplate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).optional(),
    status: z.enum(CARD_TEMPLATE_STATUSES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  })

const templateIdParam = z.object({
  id: z.enum(CARD_TEMPLATE_IDS),
})

const CardTemplateZodSchema = {
  updateCardTemplate,
  templateIdParam,
}

export type UpdateCardTemplateInput = z.infer<typeof updateCardTemplate>

export default CardTemplateZodSchema
