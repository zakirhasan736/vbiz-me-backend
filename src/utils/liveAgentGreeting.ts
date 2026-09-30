import type { UserRole as PrismaUserRole } from '../../generated/prisma/enums'

type GreetingUser = {
  name: string | null
  role: PrismaUserRole | string
} | null

function isCorporateOwnerRole(role?: PrismaUserRole | string | null): boolean {
  if (!role) return false
  const normalized = String(role).trim().toLowerCase().replace(/_/g, '-')
  return normalized === 'corporate-owner'
}

/**
 * Live Agent greeting host:
 * - Corporate / linked cards → corporate owner account name
 * - Single cards → that card's display name
 */
export function resolveLiveAgentGreetingHostName(input: {
  cardName?: string | null
  lastName?: string | null
  user?: GreetingUser
  companyUser?: GreetingUser
}): string {
  if (input.companyUser && isCorporateOwnerRole(input.companyUser.role)) {
    const corporate = input.companyUser.name?.trim()
    if (corporate) return corporate
  }

  if (input.user && isCorporateOwnerRole(input.user.role)) {
    const corporate = input.user.name?.trim()
    if (corporate) return corporate
  }

  const cardName = [input.cardName, input.lastName]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' ')
  if (cardName) return cardName

  return input.user?.name?.trim() || 'Guest'
}
