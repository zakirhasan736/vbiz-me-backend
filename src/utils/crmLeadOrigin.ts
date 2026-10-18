import { Prisma } from '../../generated/prisma/client'

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

/**
 * Guest saves that belong on backoffice dashboards / admin leads.
 *
 * Do NOT use `NOT: { path equals 'external' }` alone — Postgres treats a missing
 * JSON path as NULL, so `NOT (NULL = 'external')` drops every public form save.
 */
export function guestSaveDashboardVisibleWhere(): Prisma.GuestUserDataWhereInput {
  return {
    OR: [
      { meta: { equals: Prisma.DbNull } },
      { meta: { path: ['crmOrigin'], equals: Prisma.DbNull } },
      { meta: { path: ['crmOrigin'], equals: Prisma.JsonNull } },
      { meta: { path: ['crmOrigin'], equals: CRM_LEAD_ORIGIN_GUEST } },
    ],
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

/**
 * Real display name (not empty / anonymous "Visitor").
 */
export function isRealGuestFullName(fullName?: string | null): boolean {
  const name = (fullName || '').trim()
  if (!name) return false
  return name.toLowerCase() !== 'visitor'
}

/**
 * Qualified CRM lead: real name + (email and/or phone).
 * Name-only saves are contact-save activity, not CRM leads.
 */
export function isQualifiedCrmLead(input: {
  fullName?: string | null
  email?: string | null
  phone?: string | null
}): boolean {
  if (!isRealGuestFullName(input.fullName)) return false
  const email = (input.email || '').trim()
  const phone = (input.phone || '').trim()
  return Boolean(email || phone)
}

/**
 * CRM-only: require a real name plus email and/or phone.
 * Name-only and anonymous Visitor rows stay on dashboards via {@link guestSaveDashboardVisibleWhere}.
 */
export function guestSaveCrmContactableWhere(): Prisma.GuestUserDataWhereInput {
  return {
    AND: [
      { fullName: { not: null } },
      { NOT: { fullName: { equals: 'Visitor', mode: 'insensitive' } } },
      { NOT: { fullName: { equals: '' } } },
      {
        OR: [{ email: { not: null } }, { phone: { not: null } }],
      },
    ],
  }
}

export function buildCrmExternalLeadMeta(notes?: string | null): Prisma.InputJsonValue {
  const trimmed = notes?.trim()
  const meta: Prisma.JsonObject = {
    crmOrigin: CRM_EXTERNAL_ORIGIN,
    admin: trimmed ? { privateNotes: trimmed } : {},
  }
  return meta
}
