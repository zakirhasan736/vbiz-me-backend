import { AccountStatus, AuthProvider } from '../../generated/prisma/enums'
import { toApiRole, toPrismaRole } from '../constants/userRole'
import AppError from '../error/AppError'
import subscriptionService from '../services/subscription.service'
import authUtils from './auth.utils'
import { CORPORATE_MEMBER_DEFAULT_PASSWORD, corporateMemberCardOwnership } from './duplicateCard'
import { prisma } from './prisma'

export type ProvisionCorporateMemberInput = {
  name: string
  email: string
  password?: string | null
  phone?: string | null
  companyName?: string | null
  /** Usually the corporate owner or staff actor creating the card. */
  createdById: string
  corporateUserId: string
  /**
   * When true and the email already belongs to an active vcard-owner,
   * reuse that user instead of creating a new one (link card under corporate).
   */
  linkExistingMember?: boolean
}

export type ProvisionedCorporateMember = {
  memberUserId: string
  ownership: ReturnType<typeof corporateMemberCardOwnership>
  /** True when this call created the user (caller may roll back on failure). */
  created: boolean
  linkedExisting: boolean
}

/**
 * Create a login-ready vcard-owner for a corporate team card.
 * Password falls back to CORPORATE_MEMBER_DEFAULT_PASSWORD when omitted/blank.
 */
export async function provisionCorporateMemberUser(
  input: ProvisionCorporateMemberInput
): Promise<ProvisionedCorporateMember> {
  const email = input.email.trim().toLowerCase()
  const name = input.name.trim() || email.split('@')[0] || 'Team member'
  const password = (input.password?.trim() || CORPORATE_MEMBER_DEFAULT_PASSWORD).trim()

  if (!email) {
    throw new AppError(400, 'Member email is required')
  }
  if (password.toLowerCase() === email) {
    throw new AppError(400, "Password can't be the same as email")
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true, deletedAt: true, role: true, isActive: true, accountStatus: true },
  })
  if (existingUser && !existingUser.deletedAt) {
    if (existingUser.id === input.corporateUserId) {
      throw new AppError(400, 'Card email matches the corporate account; use a different member email for login')
    }
    const apiRole = toApiRole(existingUser.role)
    if (
      input.linkExistingMember &&
      apiRole === 'vcard-owner' &&
      existingUser.isActive &&
      existingUser.accountStatus === AccountStatus.ACTIVE
    ) {
      try {
        await subscriptionService.ensureOwnerStarterSubscription(existingUser.id, 'vcard-owner')
      } catch {
        // Keep linking even if starter sub already exists / cannot be recreated.
      }
      return {
        memberUserId: existingUser.id,
        ownership: corporateMemberCardOwnership(input.corporateUserId, existingUser.id),
        created: false,
        linkedExisting: true,
      }
    }
    throw new AppError(400, 'Email already registered')
  }

  const hashedPassword = await authUtils.hashPassword(password)
  const memberUser = await prisma.user.create({
    data: {
      name,
      email,
      password: hashedPassword,
      role: toPrismaRole('vcard-owner'),
      provider: AuthProvider.LOCAL,
      isVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      companyName: input.companyName?.trim() || null,
      createdById: input.createdById,
    },
    select: { id: true },
  })

  try {
    await subscriptionService.ensureOwnerStarterSubscription(memberUser.id, 'vcard-owner')
  } catch (error) {
    await prisma.user.delete({ where: { id: memberUser.id } }).catch(() => undefined)
    throw error
  }

  return {
    memberUserId: memberUser.id,
    ownership: corporateMemberCardOwnership(input.corporateUserId, memberUser.id),
    created: true,
    linkedExisting: false,
  }
}

/** True when this card is still owned directly by the corporate account (no member login yet). */
export function cardNeedsCorporateMemberLogin(
  profile: {
    userId?: string | null
    companyUserId?: string | null
    email?: string | null
  },
  corporateUserId: string,
  corporateEmail?: string | null
): boolean {
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : ''
  if (!email) return false
  const corpEmail = typeof corporateEmail === 'string' ? corporateEmail.trim().toLowerCase() : ''
  if (corpEmail && email === corpEmail) return false

  const ownerId = profile.userId || null
  const companyId = profile.companyUserId || null
  if (ownerId === corporateUserId && (!companyId || companyId === corporateUserId)) return true
  if (companyId === corporateUserId && ownerId === companyId) return true
  return false
}

export type CorporateMemberLoginCardReport = {
  profileId: string
  name: string
  email: string
  slug: string | null
  status: 'ready' | 'needs_user' | 'corporate_own' | 'no_email' | 'fixed' | 'linked' | 'error'
  message?: string
  memberUserId?: string | null
  ownerEmail?: string | null
}

/**
 * Audit (and optionally fix) member logins for every card under a corporate parent.
 */
export async function ensureCorporateMemberLoginsForParent(options: {
  corporateUserId: string
  actorUserId: string
  apply?: boolean
}): Promise<{
  corporate: { id: string; name: string | null; email: string; companyName: string | null }
  cards: CorporateMemberLoginCardReport[]
  summary: { ready: number; needsUser: number; fixed: number; linked: number; errors: number; skipped: number }
}> {
  const corporate = await prisma.user.findFirst({
    where: { id: options.corporateUserId, deletedAt: null },
    select: { id: true, name: true, email: true, companyName: true, role: true },
  })
  if (!corporate) throw new AppError(404, 'Corporate account not found')

  const cards = await prisma.profile.findMany({
    where: {
      OR: [{ userId: corporate.id }, { companyUserId: corporate.id }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      slug: true,
      phone: true,
      companyName: true,
      userId: true,
      companyUserId: true,
      user: { select: { id: true, email: true, role: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const reports: CorporateMemberLoginCardReport[] = []
  const summary = { ready: 0, needsUser: 0, fixed: 0, linked: 0, errors: 0, skipped: 0 }

  for (const card of cards) {
    const email = (card.email || '').trim()
    const base = {
      profileId: card.id,
      name: card.name,
      email,
      slug: card.slug,
      ownerEmail: card.user?.email || null,
      memberUserId: card.userId,
    }

    if (!email) {
      summary.skipped += 1
      reports.push({ ...base, status: 'no_email', message: 'Card has no email yet' })
      continue
    }

    if (email.toLowerCase() === corporate.email.trim().toLowerCase()) {
      summary.skipped += 1
      reports.push({ ...base, status: 'corporate_own', message: 'Uses corporate account email' })
      continue
    }

    const memberReady = Boolean(card.userId && card.userId !== corporate.id && card.companyUserId === corporate.id)
    if (memberReady) {
      summary.ready += 1
      reports.push({ ...base, status: 'ready', message: 'Member login already linked' })
      continue
    }

    if (!options.apply) {
      summary.needsUser += 1
      reports.push({
        ...base,
        status: 'needs_user',
        message: 'Still owned by corporate — needs member user',
      })
      continue
    }

    try {
      const provisioned = await provisionCorporateMemberUser({
        name: card.name || email,
        email,
        phone: card.phone,
        companyName: card.companyName,
        createdById: options.actorUserId,
        corporateUserId: corporate.id,
        linkExistingMember: true,
      })
      await prisma.profile.update({
        where: { id: card.id },
        data: {
          userId: provisioned.ownership.userId,
          companyUserId: provisioned.ownership.companyUserId,
          createdById: provisioned.ownership.createdById,
        },
      })
      if (provisioned.linkedExisting) {
        summary.linked += 1
        reports.push({
          ...base,
          status: 'linked',
          memberUserId: provisioned.memberUserId,
          message: 'Linked existing user account to this card',
        })
      } else {
        summary.fixed += 1
        reports.push({
          ...base,
          status: 'fixed',
          memberUserId: provisioned.memberUserId,
          message: `Created member login with default password`,
        })
      }
    } catch (error) {
      summary.errors += 1
      reports.push({
        ...base,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    corporate: {
      id: corporate.id,
      name: corporate.name,
      email: corporate.email,
      companyName: corporate.companyName,
    },
    cards: reports,
    summary,
  }
}
