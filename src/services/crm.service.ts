import {
  assertCrmStaffAuthorization,
  crmProfileWhere,
  resolveCrmScopeKind,
  type CrmAccessContext,
  type CrmActor,
  type CrmScopeKind,
} from '../utils/crmScope'
import { prisma } from '../utils/prisma'
import { assertUserPackageAccess } from './entitlement.service'

export type { CrmAccessContext, CrmActor, CrmScopeKind }

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
    'CRM is not included in your package. Upgrade to Professional, Professional Concierge, or Corporate.'
  )

  const where = crmProfileWhere(actor.id, kind)
  const profiles = await prisma.profile.findMany({
    where: where ?? undefined,
    select: { id: true },
  })
  return { kind, profileIds: profiles.map((row) => row.id) }
}

export async function getCrmDashboard(actor: CrmActor) {
  const access = await resolveCrmAccess(actor)
  if (access.profileIds !== null && access.profileIds.length === 0) {
    return {
      scope: access.kind,
      metrics: { newLeads: 0, openLeads: 0 },
    }
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const profileFilter = access.profileIds === null ? {} : { profileId: { in: access.profileIds } }

  const [openLeads, newLeads] = await Promise.all([
    prisma.guestUserData.count({ where: profileFilter }),
    prisma.guestUserData.count({ where: { ...profileFilter, createdAt: { gte: since } } }),
  ])

  return {
    scope: access.kind,
    metrics: {
      newLeads,
      openLeads,
    },
  }
}

const crmService = {
  resolveCrmAccess,
  getCrmDashboard,
}

export default crmService
