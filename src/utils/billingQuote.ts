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

export function resolveSignupFeeCents(input: {
  ownerMode: OwnerMode | null | undefined
  packageSignupFeeCents?: number | null
  negotiatedSignupFeeCents?: number | null
}): number {
  const catalog = Math.max(0, Math.round(Number(input.packageSignupFeeCents) || 0))
  if (input.ownerMode === 'corporate' && input.negotiatedSignupFeeCents != null) {
    return Math.max(0, Math.round(Number(input.negotiatedSignupFeeCents) || 0))
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

export function adminAssignBilling(pkg: {
  monthlyPrice?: number | null
  signupFeeCents?: number | null
  ownerMode?: OwnerMode | null
  negotiatedMonthlyCents?: number | null
  negotiatedSignupFeeCents?: number | null
}): {
  provider: 'stripe' | 'admin'
  stripeStatus: 'incomplete' | 'active'
} {
  const monthlyCents = resolveMonthlyCents({
    ownerMode: pkg.ownerMode,
    packageMonthlyCents: pkg.monthlyPrice,
    negotiatedMonthlyCents: pkg.negotiatedMonthlyCents,
  })
  const signupFeeCents = resolveSignupFeeCents({
    ownerMode: pkg.ownerMode,
    packageSignupFeeCents: pkg.signupFeeCents,
    negotiatedSignupFeeCents: pkg.negotiatedSignupFeeCents,
  })
  if (monthlyCents > 0 || signupFeeCents > 0) {
    return { provider: 'stripe', stripeStatus: 'incomplete' }
  }
  return { provider: 'admin', stripeStatus: 'active' }
}
