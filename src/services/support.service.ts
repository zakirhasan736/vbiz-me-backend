import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import { prisma } from '../utils/prisma'
import type { AuditType } from '../zodValidation/audit.zod'
import type {
  CreateSupportTicketInput,
  ListSupportTicketsQuery,
  TicketChannel,
  TicketRole,
  TicketStatus,
  TicketType,
  UpdateSupportTicketInput,
} from '../zodValidation/support.zod'

function serializeTicket(row: {
  id: string
  channel: string
  type: string
  status: string
  subject: string
  details: string
  rating: number | null
  fromRole: string
  fromName: string
  fromEmail: string | null
  adminReply: string | null
  blocked: boolean
  meta: Prisma.JsonValue | null
  createdById: string | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    channel: row.channel as TicketChannel,
    type: row.type as TicketType,
    status: row.status as TicketStatus,
    subject: row.subject,
    details: row.details,
    rating: row.rating ?? undefined,
    fromRole: row.fromRole as TicketRole,
    fromName: row.fromName,
    fromEmail: row.fromEmail ?? undefined,
    adminReply: row.adminReply ?? undefined,
    blocked: row.blocked,
    meta:
      row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
        ? (row.meta as Record<string, string>)
        : undefined,
    createdById: row.createdById ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const list = async (query: ListSupportTicketsQuery) => {
  const skip = query.skip
  const limit = query.limit

  const where: Prisma.SupportTicketWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
    ...(query.blocked !== undefined ? { blocked: query.blocked } : {}),
    fromRole: { in: ['single', 'corporate'] },
  }

  const [total, openCount, rows] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.count({
      where: { fromRole: { in: ['single', 'corporate'] }, status: 'open' },
    }),
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ])

  return {
    items: rows.map(serializeTicket),
    total,
    skip,
    limit,
    openCount,
  }
}

const getOne = async (id: string) => {
  const row = await prisma.supportTicket.findUnique({ where: { id } })
  if (!row) throw new AppError(404, 'Support ticket not found')
  return serializeTicket(row)
}

const create = async (
  actor: { id: string; email: string; name?: string | null },
  input: CreateSupportTicketInput,
  fromRole: TicketRole
) => {
  const blockedCount = await prisma.supportTicket.count({
    where: { createdById: actor.id, blocked: true },
  })
  if (blockedCount > 0) {
    throw new AppError(403, 'Your support access is blocked. Contact an administrator.')
  }

  const row = await prisma.supportTicket.create({
    data: {
      channel: input.channel,
      type: input.type,
      status: 'open',
      subject: input.subject,
      details: input.details,
      rating: input.rating ?? null,
      fromRole: input.fromRole ?? fromRole,
      fromName: input.fromName?.trim() || actor.name || actor.email,
      fromEmail: input.fromEmail ?? actor.email,
      meta: input.meta ?? undefined,
      createdById: actor.id,
    },
  })

  await writeAuditLog({
    action: 'Support ticket created',
    details: `${row.fromName}: ${row.subject}`,
    type: 'create',
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { ticketId: row.id, channel: row.channel, type: row.type },
  })

  return serializeTicket(row)
}

const update = async (
  id: string,
  actor: { id: string; email: string; name?: string | null },
  input: UpdateSupportTicketInput
) => {
  const existing = await prisma.supportTicket.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Support ticket not found')

  const row = await prisma.supportTicket.update({
    where: { id },
    data: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.adminReply !== undefined ? { adminReply: input.adminReply } : {}),
      ...(input.blocked !== undefined ? { blocked: input.blocked } : {}),
    },
  })

  const parts: string[] = []
  if (input.status !== undefined && input.status !== existing.status) {
    parts.push(`status → ${input.status}`)
  }
  if (input.adminReply !== undefined) {
    parts.push(input.adminReply ? 'reply saved' : 'reply cleared')
  }
  if (input.blocked !== undefined && input.blocked !== existing.blocked) {
    parts.push(input.blocked ? 'blocked' : 'unblocked')
  }

  let auditType: AuditType = 'update'
  if (input.status !== undefined && input.status !== existing.status) {
    auditType = 'status'
  }

  await writeAuditLog({
    action: 'Support ticket updated',
    details: parts.length ? `${existing.subject}: ${parts.join(', ')}` : existing.subject,
    type: auditType,
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { ticketId: row.id, status: row.status, blocked: row.blocked },
  })

  return serializeTicket(row)
}

const remove = async (id: string, actor: { id: string; email: string; name?: string | null }) => {
  const existing = await prisma.supportTicket.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Support ticket not found')

  await prisma.supportTicket.delete({ where: { id } })

  await writeAuditLog({
    action: 'Support ticket deleted',
    details: existing.subject,
    type: 'delete',
    actor: actor.name || actor.email,
    actorId: actor.id,
    meta: { ticketId: existing.id, channel: existing.channel, type: existing.type },
  })

  return { id }
}

const supportService = {
  list,
  getOne,
  create,
  update,
  remove,
}

export default supportService
