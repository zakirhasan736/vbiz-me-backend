import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import {
  buildCrmExternalLeadMeta,
  guestSaveExternalWhere,
  guestSaveOriginWhere,
  type CrmLeadOrigin,
} from '../utils/crmLeadOrigin'
import {
  assertCrmStaffAuthorization,
  assertRequestedProfileInScope,
  crmProfileWhere,
  isProfileIdInCrmScope,
  resolveCrmScopeKind,
  stripClientOwnershipClaims,
  type CrmAccessContext,
  type CrmActor,
  type CrmScopeKind,
} from '../utils/crmScope'
import { prisma } from '../utils/prisma'
import { mapGuestSave, mergeAdminMeta, type AdminLeadRow } from './adminLeads.service'
import { assertUserPackageAccess } from './entitlement.service'

export type { CrmAccessContext, CrmActor, CrmScopeKind }

export type CrmLeadRow = AdminLeadRow

export async function resolveCrmAccess(actor: CrmActor): Promise<CrmAccessContext> {
  const kind = resolveCrmScopeKind(actor.role)

  if (kind === 'admin') {
    assertCrmStaffAuthorization(actor)
    return { kind, profileIds: null }
  }

  await assertUserPackageAccess(
    actor.id,
    actor.role,
    'allow_crm',
    'CRM isn’t on your current plan. Upgrade to Professional, Professional Concierge, or Corporate to use it.'
  )

  const where = crmProfileWhere(actor.id, kind)
  const profiles = await prisma.profile.findMany({
    where: where ?? undefined,
    select: { id: true },
  })
  return { kind, profileIds: profiles.map((row) => row.id) }
}

function searchTokens(q?: string): string[] {
  return q?.trim().split(/\s+/).filter(Boolean) ?? []
}

function profileIdentitySearch(token: string): Prisma.ProfileWhereInput {
  const search = { contains: token, mode: 'insensitive' as const }
  return {
    OR: [
      { name: search },
      { slug: search },
      { designation: search },
      { prof: search },
      { companyName: search },
      { email: search },
      { phone: search },
      { profession: { name: search } },
      { user: { is: { name: search } } },
      { user: { is: { email: search } } },
    ],
  }
}

const profileInclude = {
  select: {
    id: true,
    name: true,
    slug: true,
    designation: true,
    prof: true,
    companyName: true,
    profession: { select: { name: true } },
    userId: true,
    user: { select: { id: true, name: true } },
  },
} as const

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { firstName: parts[0] || fullName, lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

function scopedProfileFilter(profileIds: string[] | null, requestedProfileId?: string): Prisma.GuestUserDataWhereInput {
  assertRequestedProfileInScope({ profileIds }, requestedProfileId)
  if (requestedProfileId) return { profileId: requestedProfileId }
  if (profileIds === null) return {}
  return { profileId: { in: profileIds } }
}

export async function getCrmDashboard(actor: CrmActor) {
  const access = await resolveCrmAccess(actor)
  if (access.profileIds !== null && access.profileIds.length === 0) {
    return {
      scope: access.kind,
      metrics: { newLeads: 0, openLeads: 0, externalLeads: 0 },
    }
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const profileFilter = access.profileIds === null ? {} : { profileId: { in: access.profileIds } }

  const [openLeads, newLeads, externalLeads] = await Promise.all([
    prisma.guestUserData.count({ where: profileFilter }),
    prisma.guestUserData.count({ where: { ...profileFilter, createdAt: { gte: since } } }),
    prisma.guestUserData.count({ where: { ...profileFilter, ...guestSaveExternalWhere() } }),
  ])

  return {
    scope: access.kind,
    metrics: {
      newLeads,
      openLeads,
      externalLeads,
    },
  }
}

export async function listCrmLeads(
  actor: CrmActor,
  query: { q?: string; profileId?: string; origin?: CrmLeadOrigin; skip?: number; limit?: number }
) {
  const access = await resolveCrmAccess(actor)
  const skip = Math.max(0, query.skip ?? 0)
  const limit = Math.min(100, Math.max(1, query.limit ?? 50))

  if (access.profileIds !== null && access.profileIds.length === 0) {
    return { items: [] as CrmLeadRow[], total: 0, skip, limit }
  }

  const tokens = searchTokens(query.q)
  const where: Prisma.GuestUserDataWhereInput = {
    ...scopedProfileFilter(access.profileIds, query.profileId),
    ...guestSaveOriginWhere(query.origin),
    ...(tokens.length
      ? {
          AND: tokens.map((token) => {
            const search = { contains: token, mode: 'insensitive' as const }
            return {
              OR: [
                { fullName: search },
                { email: search },
                { phone: search },
                { profile: { is: profileIdentitySearch(token) } },
              ],
            }
          }),
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.guestUserData.count({ where }),
    prisma.guestUserData.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { profile: profileInclude },
    }),
  ])

  return { items: rows.map(mapGuestSave), total, skip, limit }
}

export async function createCrmLead(actor: CrmActor, rawBody: Record<string, unknown>): Promise<CrmLeadRow> {
  const access = await resolveCrmAccess(actor)
  const body = stripClientOwnershipClaims(rawBody)
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : ''
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : ''
  if (!profileId) throw new AppError(400, 'A card is required')
  if (!fullName) throw new AppError(400, 'Lead name is required')
  assertRequestedProfileInScope(access, profileId)

  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { id: true },
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  const { firstName, lastName } = splitName(fullName)
  const notes = typeof body.notes === 'string' ? body.notes : undefined
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''

  const row = await prisma.guestUserData.create({
    data: {
      profileId,
      fullName,
      firstName,
      lastName: lastName || null,
      email: email || null,
      phone: phone || null,
      meta: buildCrmExternalLeadMeta(notes),
    },
    include: { profile: profileInclude },
  })

  return mapGuestSave(row)
}

async function loadScopedGuest(actor: CrmActor, id: string) {
  const access = await resolveCrmAccess(actor)
  const existing = await prisma.guestUserData.findUnique({
    where: { id },
    include: { profile: profileInclude },
  })
  if (!existing || !isProfileIdInCrmScope(access, existing.profileId)) {
    throw new AppError(404, 'Lead not found')
  }
  return existing
}

export async function patchCrmLead(
  actor: CrmActor,
  id: string,
  body: { privateNotes?: string; lastReply?: string }
): Promise<CrmLeadRow> {
  const existing = await loadScopedGuest(actor, id)
  const updated = await prisma.guestUserData.update({
    where: { id },
    data: { meta: mergeAdminMeta(existing.meta, body) },
    include: { profile: profileInclude },
  })
  return mapGuestSave(updated)
}

export async function deleteCrmLead(actor: CrmActor, id: string) {
  await loadScopedGuest(actor, id)
  await prisma.guestUserData.delete({ where: { id } })
  return { id, deleted: true }
}

const crmService = {
  resolveCrmAccess,
  getCrmDashboard,
  listCrmLeads,
  createCrmLead,
  patchCrmLead,
  deleteCrmLead,
}

export default crmService
