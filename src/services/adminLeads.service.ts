import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { prisma } from '../utils/prisma'
import type { ListLeadsQuery, PatchLeadBody } from '../zodValidation/adminLeads.zod'

export type LeadMetadata = {
  userAgent: string
  language: string
  platform: string
  browser: string
  device: string
  screen: string
  timezone: string
  approximateLocation: string
  referrer: string
}

export type AdminLeadRow = {
  id: string
  fullName: string
  phoneNumber: string
  email: string
  guestMessage?: string
  privateNotes?: string
  lastReply?: string
  lastReplyAt?: string
  submittedAt: string
  vCardId: string
  vCardSlug: string
  vCardName: string
  ownerId: string
  ownerName: string
  kind: 'guest_save' | 'guest_message'
  consent: boolean
  metadata: LeadMetadata
}

type AdminMeta = {
  privateNotes?: string
  lastReply?: string
  lastReplyAt?: string
}

type ProfileSelect = {
  id: string
  name: string
  slug: string | null
  userId: string | null
  user: { id: string; name: string | null } | null
}

const EMPTY_METADATA: LeadMetadata = {
  userAgent: '',
  language: '',
  platform: '',
  browser: '',
  device: '',
  screen: '',
  timezone: '',
  approximateLocation: '',
  referrer: '',
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function readAdminMeta(meta: unknown): AdminMeta {
  const root = asRecord(meta)
  const admin = asRecord(root.admin)
  return {
    privateNotes: typeof admin.privateNotes === 'string' ? admin.privateNotes : undefined,
    lastReply: typeof admin.lastReply === 'string' ? admin.lastReply : undefined,
    lastReplyAt: typeof admin.lastReplyAt === 'string' ? admin.lastReplyAt : undefined,
  }
}

function mergeAdminMeta(existingMeta: unknown, patch: PatchLeadBody): Prisma.InputJsonValue {
  const root = { ...asRecord(existingMeta) }
  const admin = { ...asRecord(root.admin) }

  if (patch.privateNotes !== undefined) {
    admin.privateNotes = patch.privateNotes
  }
  if (patch.lastReply !== undefined) {
    admin.lastReply = patch.lastReply
    admin.lastReplyAt = new Date().toISOString()
  }

  root.admin = admin
  return root as Prisma.InputJsonValue
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function metadataFromMeta(meta: unknown): LeadMetadata {
  const m = asRecord(meta)
  return {
    userAgent: str(m.userAgent),
    language: str(m.language),
    platform: str(m.platform),
    browser: str(m.browser),
    device: str(m.device),
    screen: str(m.screen),
    timezone: str(m.timezone),
    approximateLocation: str(m.approximateLocation) || str(m.location) || 'Unknown',
    referrer: str(m.referrer) || 'Direct / QR',
  }
}

function ownerFromProfile(profile: ProfileSelect) {
  return {
    ownerId: profile.userId || profile.user?.id || '',
    ownerName: profile.user?.name || profile.name || 'Unknown',
  }
}

function mapGuestSave(row: {
  id: string
  fullName: string | null
  phone: string | null
  email: string | null
  meta: unknown
  createdAt: Date
  profileId: string
  profile: ProfileSelect
}): AdminLeadRow {
  const admin = readAdminMeta(row.meta)
  const owner = ownerFromProfile(row.profile)
  return {
    id: row.id,
    fullName: row.fullName || 'Unnamed',
    phoneNumber: row.phone || '',
    email: row.email || '',
    privateNotes: admin.privateNotes,
    lastReply: admin.lastReply,
    lastReplyAt: admin.lastReplyAt,
    submittedAt: row.createdAt.toISOString(),
    vCardId: row.profileId,
    vCardSlug: row.profile.slug || '',
    vCardName: row.profile.name || '',
    ownerId: owner.ownerId,
    ownerName: owner.ownerName,
    kind: 'guest_save',
    consent: true,
    metadata: metadataFromMeta(row.meta),
  }
}

function mapGuestNote(row: {
  id: string
  content: string
  meta: unknown
  createdAt: Date
  profileId: string
  profile: ProfileSelect
}): AdminLeadRow {
  const admin = readAdminMeta(row.meta)
  const owner = ownerFromProfile(row.profile)
  const meta = asRecord(row.meta)
  return {
    id: row.id,
    fullName: str(meta.fullName) || str(meta.name) || 'Guest',
    phoneNumber: str(meta.phone) || str(meta.phoneNumber),
    email: str(meta.email),
    guestMessage: row.content,
    privateNotes: admin.privateNotes,
    lastReply: admin.lastReply,
    lastReplyAt: admin.lastReplyAt,
    submittedAt: row.createdAt.toISOString(),
    vCardId: row.profileId,
    vCardSlug: row.profile.slug || '',
    vCardName: row.profile.name || '',
    ownerId: owner.ownerId,
    ownerName: owner.ownerName,
    kind: 'guest_message',
    consent: true,
    metadata: Object.keys(meta).length ? metadataFromMeta(row.meta) : { ...EMPTY_METADATA },
  }
}

const profileInclude = {
  select: {
    id: true,
    name: true,
    slug: true,
    userId: true,
    user: { select: { id: true, name: true } },
  },
} as const

function buildSearchFilter(q?: string): Prisma.StringFilter | undefined {
  const term = q?.trim()
  if (!term) return undefined
  return { contains: term, mode: 'insensitive' }
}

const getStats = async () => {
  const [totalSaves, sourceProfiles, totalNotes] = await Promise.all([
    prisma.guestUserData.count(),
    prisma.guestUserData.findMany({ select: { profileId: true }, distinct: ['profileId'] }).then((rows) => rows.length),
    prisma.userNote.count(),
  ])

  return {
    totalSaves,
    sourceProfiles,
    totalNotes,
    storage: 'api' as const,
  }
}

const listSaves = async (query: ListLeadsQuery): Promise<AdminLeadRow[]> => {
  const search = buildSearchFilter(query.q)
  const where: Prisma.GuestUserDataWhereInput = {
    ...(query.profileId ? { profileId: query.profileId } : {}),
    ...(search
      ? {
          OR: [
            { fullName: search },
            { email: search },
            { phone: search },
            { profile: { name: search } },
            { profile: { slug: search } },
          ],
        }
      : {}),
  }

  const rows = await prisma.guestUserData.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { profile: profileInclude },
  })

  return rows.map(mapGuestSave)
}

const listNotes = async (query: ListLeadsQuery): Promise<AdminLeadRow[]> => {
  const search = buildSearchFilter(query.q)
  const where: Prisma.UserNoteWhereInput = {
    ...(query.profileId ? { profileId: query.profileId } : {}),
    ...(search
      ? {
          OR: [{ content: search }, { profile: { name: search } }, { profile: { slug: search } }],
        }
      : {}),
  }

  const rows = await prisma.userNote.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { profile: profileInclude },
  })

  return rows.map(mapGuestNote)
}

const patchSave = async (id: string, body: PatchLeadBody): Promise<AdminLeadRow> => {
  const existing = await prisma.guestUserData.findUnique({
    where: { id },
    include: { profile: profileInclude },
  })
  if (!existing) throw new AppError(404, 'Contact save not found')

  const updated = await prisma.guestUserData.update({
    where: { id },
    data: { meta: mergeAdminMeta(existing.meta, body) },
    include: { profile: profileInclude },
  })

  return mapGuestSave(updated)
}

const deleteSave = async (id: string) => {
  const existing = await prisma.guestUserData.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new AppError(404, 'Contact save not found')
  await prisma.guestUserData.delete({ where: { id } })
  return { id, deleted: true }
}

const patchNote = async (id: string, body: PatchLeadBody): Promise<AdminLeadRow> => {
  const existing = await prisma.userNote.findUnique({
    where: { id },
    include: { profile: profileInclude },
  })
  if (!existing) throw new AppError(404, 'Note not found')

  const updated = await prisma.userNote.update({
    where: { id },
    data: { meta: mergeAdminMeta(existing.meta, body) },
    include: { profile: profileInclude },
  })

  return mapGuestNote(updated)
}

const deleteNote = async (id: string) => {
  const existing = await prisma.userNote.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw new AppError(404, 'Note not found')
  await prisma.userNote.delete({ where: { id } })
  return { id, deleted: true }
}

const adminLeadsService = {
  getStats,
  listSaves,
  listNotes,
  patchSave,
  deleteSave,
  patchNote,
  deleteNote,
}

export default adminLeadsService
