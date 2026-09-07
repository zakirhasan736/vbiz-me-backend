import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import {
  isProfileIdInCrmScope,
  stripClientOwnershipClaims,
  type CrmAccessContext,
  type CrmActor,
} from '../utils/crmScope'
import { prisma } from '../utils/prisma'
import { LEAD_NOTE_KINDS, type LeadNoteKind } from '../zodValidation/leadNote.zod'

export type LeadNoteRow = {
  id: string
  guestUserDataId: string
  createdById: string
  createdByName: string | null
  kind: LeadNoteKind
  content: string | null
  audioUrl: string | null
  audioFileName: string | null
  audioMimeType: string | null
  startsAt: string | null
  dueAt: string | null
  createdAt: string
  updatedAt: string
}

const include = {
  createdBy: { select: { id: true, name: true, email: true } },
} as const

function isKind(value: string): value is LeadNoteKind {
  return (LEAD_NOTE_KINDS as readonly string[]).includes(value)
}

function mapRow(row: {
  id: string
  guestUserDataId: string
  createdById: string
  kind: string
  content: string | null
  audioUrl: string | null
  audioFileName: string | null
  audioMimeType: string | null
  startsAt: Date | null
  dueAt: Date | null
  createdAt: Date
  updatedAt: Date
  createdBy: { id: string; name: string | null; email: string }
}): LeadNoteRow {
  return {
    id: row.id,
    guestUserDataId: row.guestUserDataId,
    createdById: row.createdById,
    createdByName: row.createdBy.name || row.createdBy.email || null,
    kind: isKind(row.kind) ? row.kind : 'text',
    content: row.content,
    audioUrl: row.audioUrl,
    audioFileName: row.audioFileName,
    audioMimeType: row.audioMimeType,
    startsAt: row.startsAt?.toISOString() || null,
    dueAt: row.dueAt?.toISOString() || null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function parseDate(value: unknown): Date | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new AppError(400, 'Invalid date')
  return d
}

async function assertLeadInScope(_actor: CrmActor, access: CrmAccessContext, leadId: string) {
  const lead = await prisma.guestUserData.findUnique({
    where: { id: leadId },
    select: { id: true, profileId: true },
  })
  if (!lead || !isProfileIdInCrmScope(access, lead.profileId)) {
    throw new AppError(404, 'Lead not found')
  }
  return lead
}

async function assertNoteInScope(actor: CrmActor, access: CrmAccessContext, leadId: string, noteId: string) {
  await assertLeadInScope(actor, access, leadId)
  const note = await prisma.leadNote.findFirst({
    where: { id: noteId, guestUserDataId: leadId },
    include,
  })
  if (!note) throw new AppError(404, 'Lead note not found')
  return note
}

export async function listLeadNotes(actor: CrmActor, access: CrmAccessContext, leadId: string) {
  await assertLeadInScope(actor, access, leadId)
  const rows = await prisma.leadNote.findMany({
    where: { guestUserDataId: leadId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include,
  })
  return rows.map(mapRow)
}

export async function createLeadNote(
  actor: CrmActor,
  access: CrmAccessContext,
  leadId: string,
  rawBody: Record<string, unknown>
) {
  await assertLeadInScope(actor, access, leadId)
  const body = stripClientOwnershipClaims(rawBody)

  const kindRaw = typeof body.kind === 'string' ? body.kind : ''
  if (!isKind(kindRaw)) throw new AppError(400, 'Invalid note kind')

  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const audioUrl = typeof body.audioUrl === 'string' ? body.audioUrl.trim() : ''
  const audioFileName = typeof body.audioFileName === 'string' ? body.audioFileName.trim() : ''
  const audioMimeType = typeof body.audioMimeType === 'string' ? body.audioMimeType.trim() : ''

  if (kindRaw === 'voice') {
    if (!audioUrl) throw new AppError(400, 'audioUrl is required for voice notes')
  } else if (!content) {
    throw new AppError(400, 'content is required')
  }

  const startsAt = parseDate(body.startsAt)
  const dueAt = parseDate(body.dueAt)
  if (!startsAt || !dueAt) {
    throw new AppError(400, 'Start and due dates are required')
  }

  const data: Prisma.LeadNoteCreateInput = {
    kind: kindRaw,
    content: kindRaw === 'voice' ? content || null : content,
    audioUrl: kindRaw === 'voice' ? audioUrl : null,
    audioFileName: kindRaw === 'voice' ? audioFileName || null : null,
    audioMimeType: kindRaw === 'voice' ? audioMimeType || null : null,
    startsAt,
    dueAt,
    guestUserData: { connect: { id: leadId } },
    createdBy: { connect: { id: actor.id } },
  }

  const row = await prisma.leadNote.create({ data, include })
  return mapRow(row)
}

export async function updateLeadNote(
  actor: CrmActor,
  access: CrmAccessContext,
  leadId: string,
  noteId: string,
  rawBody: Record<string, unknown>
) {
  const existing = await assertNoteInScope(actor, access, leadId, noteId)
  const body = stripClientOwnershipClaims(rawBody)

  const data: Prisma.LeadNoteUpdateInput = {}

  if ('content' in body) {
    if (body.content === null) data.content = null
    else if (typeof body.content === 'string') data.content = body.content.trim() || null
  }
  if ('audioUrl' in body) {
    if (body.audioUrl === null) data.audioUrl = null
    else if (typeof body.audioUrl === 'string') data.audioUrl = body.audioUrl.trim() || null
  }
  if ('audioFileName' in body) {
    if (body.audioFileName === null) data.audioFileName = null
    else if (typeof body.audioFileName === 'string') data.audioFileName = body.audioFileName.trim() || null
  }
  if ('audioMimeType' in body) {
    if (body.audioMimeType === null) data.audioMimeType = null
    else if (typeof body.audioMimeType === 'string') data.audioMimeType = body.audioMimeType.trim() || null
  }
  if ('startsAt' in body) {
    const startsAt = parseDate(body.startsAt)
    if (!startsAt) throw new AppError(400, 'Start date is required')
    data.startsAt = startsAt
  }
  if ('dueAt' in body) {
    const dueAt = parseDate(body.dueAt)
    if (!dueAt) throw new AppError(400, 'Due date is required')
    data.dueAt = dueAt
  }

  if (Object.keys(data).length === 0) throw new AppError(400, 'At least one field is required')

  if (existing.kind !== 'voice') {
    const nextContent = 'content' in data ? (data.content as string | null) : existing.content
    if (!nextContent?.trim()) throw new AppError(400, 'content is required')
  } else {
    const nextAudio = 'audioUrl' in data ? (data.audioUrl as string | null) : existing.audioUrl
    if (!nextAudio?.trim()) throw new AppError(400, 'audioUrl is required for voice notes')
  }

  const row = await prisma.leadNote.update({ where: { id: noteId }, data, include })
  return mapRow(row)
}

export async function deleteLeadNote(actor: CrmActor, access: CrmAccessContext, leadId: string, noteId: string) {
  await assertNoteInScope(actor, access, leadId, noteId)
  await prisma.leadNote.delete({ where: { id: noteId } })
  return { id: noteId, deleted: true }
}

const leadNoteService = {
  listLeadNotes,
  createLeadNote,
  updateLeadNote,
  deleteLeadNote,
}

export default leadNoteService
