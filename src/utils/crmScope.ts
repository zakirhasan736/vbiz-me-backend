import type { Prisma } from '../../generated/prisma/client'
import { isStaffRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { assertModule } from './adminAccess'

export type CrmScopeKind = 'admin' | 'corporate' | 'single'

export type CrmAccessContext = {
  kind: CrmScopeKind
  /** `null` means platform-wide (admin). Empty array means entitled but no cards yet. */
  profileIds: string[] | null
}

export type CrmActor = {
  id: string
  role: string
  allowedModules?: string[] | null
}

/** Staff CRM uses the existing Admin Leads module. Super-admin always passes. */
export const CRM_STAFF_MODULE = 'leads' as const

export function resolveCrmScopeKind(role: string): CrmScopeKind {
  if (isStaffRole(role)) return 'admin'
  if (role === 'corporate-owner') return 'corporate'
  return 'single'
}

export function assertCrmStaffAuthorization(actor: Pick<CrmActor, 'role' | 'allowedModules'>): void {
  assertModule(actor.role, actor.allowedModules, CRM_STAFF_MODULE)
}

/**
 * Prisma `Profile` where for this actor. `null` = no profile filter (admin platform).
 * Client-supplied owner/company/profile IDs must never replace this.
 */
export function crmProfileWhere(actorId: string, kind: CrmScopeKind): Prisma.ProfileWhereInput | null {
  if (kind === 'admin') return null
  if (kind === 'corporate') {
    return { OR: [{ companyUserId: actorId }, { userId: actorId }] }
  }
  return { userId: actorId }
}

export function profileOwnedByCrmActor(
  kind: CrmScopeKind,
  actorId: string,
  profile: { userId?: string | null; companyUserId?: string | null }
): boolean {
  if (kind === 'admin') return true
  if (kind === 'corporate') {
    return profile.companyUserId === actorId || profile.userId === actorId
  }
  return profile.userId === actorId
}

export function isProfileIdInCrmScope(access: Pick<CrmAccessContext, 'profileIds'>, profileId: string): boolean {
  if (access.profileIds === null) return true
  return access.profileIds.includes(profileId)
}

/** Rejects a client-requested profile filter that is outside the session scope. */
export function assertRequestedProfileInScope(
  access: Pick<CrmAccessContext, 'profileIds'>,
  requestedProfileId?: string | null
): void {
  const id = requestedProfileId?.trim()
  if (!id) return
  if (!isProfileIdInCrmScope(access, id)) {
    throw new AppError(404, 'Profile not found')
  }
}

/**
 * Ownership fields on a request body are never authorization.
 * Strip them so later handlers cannot accidentally trust them.
 */
export function stripClientOwnershipClaims<T extends Record<string, unknown>>(body: T): T {
  const next = { ...body }
  delete next.corporateAccountId
  delete next.ownerId
  delete next.ownerUserId
  delete next.companyUserId
  delete next.accountId
  return next
}
