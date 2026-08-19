import { EXPLICIT_ALLOW_FLAG_KEYS } from '../constants/packageAccess'
import { roleForOwnerMode, type OwnerMode } from '../constants/packageOwnerMode'
import { isStaffRole } from '../constants/userRole'

export type RoleBackfillDecision =
  | { action: 'none' }
  | { action: 'set'; nextRole: 'vcard-owner' | 'corporate-owner'; reason: string }
  | { action: 'report'; code: 'corporate-owner-on-single-package'; reason: string }

export type MissingSubscriptionDecision =
  { action: 'none' } | { action: 'attach'; slug: 'free' | 'corporate' } | { action: 'report'; reason: string }

export type QuantityBackfillDecision = { action: 'none' } | { action: 'set'; quantity: number }

export function missingAllowFlagKeys(existingKeys: Array<string | null | undefined>): string[] {
  const have = new Set(
    existingKeys
      .map((key) =>
        String(key || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  )
  return EXPLICIT_ALLOW_FLAG_KEYS.filter((key) => !have.has(key))
}

export function decideMissingSubscription(input: {
  role: string | null | undefined
  hasActiveSubscription: boolean
}): MissingSubscriptionDecision {
  if (isStaffRole(input.role) || input.hasActiveSubscription) return { action: 'none' }
  if (input.role === 'vcard-owner') return { action: 'attach', slug: 'free' }
  if (input.role === 'corporate-owner') return { action: 'attach', slug: 'corporate' }
  return { action: 'none' }
}

export function decideOwnerRoleBackfill(input: {
  role: string | null | undefined
  ownerMode: OwnerMode | null
}): RoleBackfillDecision {
  if (isStaffRole(input.role) || !input.role || !input.ownerMode) return { action: 'none' }
  const expected = roleForOwnerMode(input.ownerMode)
  if (input.role === expected) return { action: 'none' }
  if (expected === 'corporate-owner' && input.role === 'vcard-owner') {
    return {
      action: 'set',
      nextRole: 'corporate-owner',
      reason: 'Package is Corporate; role can be aligned without removing cards.',
    }
  }
  if (expected === 'vcard-owner' && input.role === 'corporate-owner') {
    return {
      action: 'report',
      code: 'corporate-owner-on-single-package',
      reason: 'Corporate owner is on a Single package (often Free). Do not auto-demote.',
    }
  }
  return { action: 'none' }
}

export function decideCorporateQuantityCopy(input: {
  ownerMode: OwnerMode | null
  quantity: number | null | undefined
  packageMaxCards: number | null
}): QuantityBackfillDecision {
  if (input.ownerMode !== 'corporate') return { action: 'none' }
  if (input.quantity != null) return { action: 'none' }
  if (input.packageMaxCards == null) return { action: 'none' }
  return { action: 'set', quantity: input.packageMaxCards }
}

export function assertProfileCountUnchanged(before: number, after: number): void {
  if (after !== before) {
    throw new Error(`Profile count changed during backfill (${before} → ${after}). No profiles may be deleted.`)
  }
}
