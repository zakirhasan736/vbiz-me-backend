import { z } from 'zod'

export const TICKET_CHANNELS = ['feedback', 'email', 'ai', 'support'] as const
export const TICKET_TYPES = ['issue', 'feature', 'satisfaction', 'system_update', 'help', 'other'] as const
export const TICKET_STATUSES = ['open', 'in_progress', 'closed'] as const
export const TICKET_ROLES = ['single', 'corporate', 'admin'] as const

export type TicketChannel = (typeof TICKET_CHANNELS)[number]
export type TicketType = (typeof TICKET_TYPES)[number]
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export type TicketRole = (typeof TICKET_ROLES)[number]

const ticketChannel = z.enum(TICKET_CHANNELS)
const ticketType = z.enum(TICKET_TYPES)
const ticketStatus = z.enum(TICKET_STATUSES)
const ticketRole = z.enum(TICKET_ROLES)

const createSupportTicket = z.object({
  channel: ticketChannel,
  type: ticketType,
  subject: z.string().trim().min(1).max(300),
  details: z.string().trim().min(1).max(5000),
  rating: z.number().int().min(1).max(5).optional().nullable(),
  fromRole: ticketRole.optional(),
  fromName: z.string().trim().min(1).max(200).optional(),
  fromEmail: z.string().trim().email().max(320).optional().nullable(),
  meta: z.record(z.string(), z.string()).optional().nullable(),
})

const updateSupportTicket = z
  .object({
    status: ticketStatus.optional(),
    adminReply: z.string().trim().max(5000).optional().nullable(),
    blocked: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })

const listSupportTicketsQuery = z.object({
  status: ticketStatus.optional(),
  channel: ticketChannel.optional(),
  blocked: z.coerce.boolean().optional(),
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const SupportZodSchema = {
  createSupportTicket,
  updateSupportTicket,
  listSupportTicketsQuery,
  TICKET_CHANNELS,
  TICKET_TYPES,
  TICKET_STATUSES,
  TICKET_ROLES,
}

export type CreateSupportTicketInput = z.infer<typeof createSupportTicket>
export type UpdateSupportTicketInput = z.infer<typeof updateSupportTicket>
export type ListSupportTicketsQuery = z.infer<typeof listSupportTicketsQuery>

export default SupportZodSchema
