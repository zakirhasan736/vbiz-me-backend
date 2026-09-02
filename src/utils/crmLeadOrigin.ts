import type { Prisma } from '../../generated/prisma/client'

export const CRM_EXTERNAL_ORIGIN = 'external' as const
export const CRM_LEAD_ORIGIN_GUEST = 'guest' as const
export const CRM_LEAD_ORIGIN_EXTERNAL = 'crm_external' as const

export type CrmLeadOrigin = typeof CRM_LEAD_ORIGIN_GUEST | typeof CRM_LEAD_ORIGIN_EXTERNAL

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function crmOriginFromMeta(meta: unknown): CrmLeadOrigin {
  const root = asRecord(meta)
  return root.crmOrigin === CRM_EXTERNAL_ORIGIN ? CRM_LEAD_ORIGIN_EXTERNAL : CRM_LEAD_ORIGIN_GUEST
}

export function isCrmExternalMeta(meta: unknown): boolean {
  return crmOriginFromMeta(meta) === CRM_LEAD_ORIGIN_EXTERNAL
}

/** Prisma filter: guest saves that belong on backoffice dashboards / admin leads. */
export function guestSaveDashboardVisibleWhere(): Prisma.GuestUserDataWhereInput {
  return {
    NOT: {
      meta: {
        path: ['crmOrigin'],
        equals: CRM_EXTERNAL_ORIGIN,
      },
    },
  }
}

export function guestSaveExternalWhere(): Prisma.GuestUserDataWhereInput {
  return {
    meta: {
      path: ['crmOrigin'],
      equals: CRM_EXTERNAL_ORIGIN,
    },
  }
}

export function guestSaveOriginWhere(origin?: CrmLeadOrigin | null): Prisma.GuestUserDataWhereInput {
  if (origin === CRM_LEAD_ORIGIN_EXTERNAL) return guestSaveExternalWhere()
  if (origin === CRM_LEAD_ORIGIN_GUEST) return guestSaveDashboardVisibleWhere()
  return {}
}

export function buildCrmExternalLeadMeta(notes?: string | null): Prisma.InputJsonValue {
  const trimmed = notes?.trim()
  const meta: Prisma.JsonObject = {
    crmOrigin: CRM_EXTERNAL_ORIGIN,
    admin: trimmed ? { privateNotes: trimmed } : {},
  }
  return meta
}
