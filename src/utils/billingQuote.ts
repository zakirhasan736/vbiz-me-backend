import type { OwnerMode } from '../constants/packageOwnerMode'

export function resolveMonthlyCents(input: {
  ownerMode: OwnerMode | null | undefined
  packageMonthlyCents?: number | null
  negotiatedMonthlyCents?: number | null
}): number {
  const catalog = Math.max(0, Math.round(Number(input.packageMonthlyCents) || 0))
  if (input.ownerMode === 'corporate' && input.negotiatedMonthlyCents != null) {
    return Math.max(0, Math.round(Number(input.negotiatedMonthlyCents) || 0))
  }
  return catalog
}

export function resolveRecurringInvoiceCents(monthlyCents: number): number {
  return Math.max(0, Math.round(Number(monthlyCents) || 0))
}

export function resolveFirstInvoiceCents(input: {
  monthlyCents: number
  signupFeeCents?: number | null
  signupFeeChargedAt?: Date | string | null
}): number {
  const monthly = resolveRecurringInvoiceCents(input.monthlyCents)
  if (input.signupFeeChargedAt) return monthly
  return monthly + Math.max(0, Math.round(Number(input.signupFeeCents) || 0))
}

export function packageRequiresStripe(
  pkg:
    | {
        monthlyPrice?: number | null
        signupFeeCents?: number | null
      }
    | null
    | undefined
): boolean {
  if (!pkg) return false
  return (
    Math.max(0, Math.round(Number(pkg.monthlyPrice) || 0)) > 0 ||
    Math.max(0, Math.round(Number(pkg.signupFeeCents) || 0)) > 0
  )
}

export function adminAssignBilling(pkg: { monthlyPrice?: number | null; signupFeeCents?: number | null }): {
  provider: 'stripe' | 'admin'
  stripeStatus: 'incomplete' | 'active'
} {
  if (packageRequiresStripe(pkg)) {
    return { provider: 'stripe', stripeStatus: 'incomplete' }
  }
  return { provider: 'admin', stripeStatus: 'active' }
}
