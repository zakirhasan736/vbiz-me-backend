import { AccountStatus, AuthProvider, UserRole as PrismaUserRole } from '../../generated/prisma/enums'
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
  /** When linking an existing member, also set password to the default. */
  resetPasswordOnLink?: boolean
}

export type ProvisionedCorporateMember = {
  memberUserId: string
  ownership: ReturnType<typeof corporateMemberCardOwnership>
  /** True when this call created the user (caller may roll back on failure). */
  created: boolean
  linkedExisting: boolean
  passwordReset: boolean
}

async function setUserDefaultPassword(userId: string, password = CORPORATE_MEMBER_DEFAULT_PASSWORD): Promise<void> {
  const hashedPassword = await authUtils.hashPassword(password.trim())
  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword,
      provider: AuthProvider.LOCAL,
      isVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
    },
  })
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
      let passwordReset = false
      if (input.resetPasswordOnLink !== false) {
        await setUserDefaultPassword(existingUser.id, password)
        passwordReset = true
      }
      return {
        memberUserId: existingUser.id,
        ownership: corporateMemberCardOwnership(input.corporateUserId, existingUser.id),
        created: false,
        linkedExisting: true,
        passwordReset,
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
    passwordReset: false,
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
  status: 'ready' | 'needs_user' | 'corporate_own' | 'no_email' | 'fixed' | 'linked' | 'password_reset' | 'error'
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
  /** When applying, also set default password on already-linked member users. */
  resetPasswords?: boolean
}): Promise<{
  corporate: { id: string; name: string | null; email: string; companyName: string | null }
  cards: CorporateMemberLoginCardReport[]
  summary: {
    ready: number
    needsUser: number
    fixed: number
    linked: number
    passwordReset: number
    errors: number
    skipped: number
  }
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
  const summary = {
    ready: 0,
    needsUser: 0,
    fixed: 0,
    linked: 0,
    passwordReset: 0,
    errors: 0,
    skipped: 0,
  }

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
      if (options.apply && !card.companyUserId) {
        await prisma.profile.update({
          where: { id: card.id },
          data: { companyUserId: corporate.id },
        })
      }
      summary.skipped += 1
      reports.push({ ...base, status: 'corporate_own', message: 'Uses corporate account email (corporate backoffice)' })
      continue
    }

    const memberReady = Boolean(card.userId && card.userId !== corporate.id && card.companyUserId === corporate.id)
    if (memberReady) {
      if (options.apply && options.resetPasswords && card.userId) {
        try {
          await setUserDefaultPassword(card.userId)
          summary.passwordReset += 1
          reports.push({
            ...base,
            status: 'password_reset',
            message: `Member password set to default (${CORPORATE_MEMBER_DEFAULT_PASSWORD})`,
          })
        } catch (error) {
          summary.errors += 1
          reports.push({
            ...base,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        continue
      }
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
        resetPasswordOnLink: true,
      })
      try {
        await prisma.profile.update({
          where: { id: card.id },
          data: {
            userId: provisioned.ownership.userId,
            companyUserId: provisioned.ownership.companyUserId,
            createdById: provisioned.ownership.createdById,
          },
        })
      } catch (error) {
        if (provisioned.created) {
          await prisma.user.delete({ where: { id: provisioned.memberUserId } }).catch(() => undefined)
        }
        throw error
      }
      if (provisioned.linkedExisting) {
        summary.linked += 1
        if (provisioned.passwordReset) summary.passwordReset += 1
        reports.push({
          ...base,
          status: 'linked',
          memberUserId: provisioned.memberUserId,
          message: `Linked existing user; password set to default (${CORPORATE_MEMBER_DEFAULT_PASSWORD})`,
        })
      } else {
        summary.fixed += 1
        reports.push({
          ...base,
          status: 'fixed',
          memberUserId: provisioned.memberUserId,
          message: `Created member login with default password (${CORPORATE_MEMBER_DEFAULT_PASSWORD})`,
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

export type OwnerPasswordResetReport = {
  userId: string
  email: string
  name: string | null
  role: string
  status: 'reset' | 'skipped' | 'error'
  message?: string
}

/**
 * Set default password for all single-card owners, corporate owners, and corporate-linked members.
 * Never touches admin / super-admin accounts.
 */
export async function resetOwnerDefaultPasswords(options: { apply?: boolean }): Promise<{
  password: string
  summary: { reset: number; skipped: number; errors: number; total: number }
  users: OwnerPasswordResetReport[]
}> {
  const owners = await prisma.user.findMany({
    where: {
      deletedAt: null,
      role: { in: [PrismaUserRole.VCARD_OWNER, PrismaUserRole.CORPORATE_OWNER] },
    },
    select: { id: true, email: true, name: true, role: true, provider: true },
    orderBy: { createdAt: 'asc' },
  })

  const users: OwnerPasswordResetReport[] = []
  const summary = { reset: 0, skipped: 0, errors: 0, total: owners.length }

  for (const owner of owners) {
    const role = toApiRole(owner.role)
    if (!options.apply) {
      summary.skipped += 1
      users.push({
        userId: owner.id,
        email: owner.email,
        name: owner.name,
        role,
        status: 'skipped',
        message: `Would set password to ${CORPORATE_MEMBER_DEFAULT_PASSWORD}`,
      })
      continue
    }
    try {
      await setUserDefaultPassword(owner.id)
      summary.reset += 1
      users.push({
        userId: owner.id,
        email: owner.email,
        name: owner.name,
        role,
        status: 'reset',
        message: 'Password set to default',
      })
    } catch (error) {
      summary.errors += 1
      users.push({
        userId: owner.id,
        email: owner.email,
        name: owner.name,
        role,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    password: CORPORATE_MEMBER_DEFAULT_PASSWORD,
    summary,
    users,
  }
}

/** Find every corporate-owner account (active), plus any parent ids used on cards. */
export async function listAllCorporateOwnerIds(): Promise<string[]> {
  const ids = new Set<string>()

  const rows = await prisma.user.findMany({
    where: {
      deletedAt: null,
      role: PrismaUserRole.CORPORATE_OWNER,
      isActive: true,
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  for (const row of rows) ids.add(row.id)

  // Cards already stamped with companyUserId (covers parents even if role drifted).
  const companyParents = await prisma.profile.findMany({
    where: { companyUserId: { not: null } },
    select: { companyUserId: true },
    distinct: ['companyUserId'],
  })
  for (const row of companyParents) {
    if (row.companyUserId) ids.add(row.companyUserId)
  }

  // Profiles owned by a corporate-owner but missing companyUserId still count as corporate team cards.
  const ownedByCorporate = await prisma.profile.findMany({
    where: {
      userId: { not: null },
      user: { role: PrismaUserRole.CORPORATE_OWNER, deletedAt: null },
    },
    select: { userId: true },
    distinct: ['userId'],
  })
  for (const row of ownedByCorporate) {
    if (row.userId) ids.add(row.userId)
  }

  return [...ids]
}

/**
 * Audit/fix member logins for every corporate account.
 */
export async function ensureAllCorporateMemberLogins(options: {
  actorUserId: string
  apply?: boolean
  resetPasswords?: boolean
}): Promise<{
  apply: boolean
  resetPasswords: boolean
  results: Awaited<ReturnType<typeof ensureCorporateMemberLoginsForParent>>[]
  totals: {
    corporates: number
    ready: number
    needsUser: number
    fixed: number
    linked: number
    passwordReset: number
    errors: number
    skipped: number
  }
}> {
  const corpIds = await listAllCorporateOwnerIds()
  const results = []
  const totals = {
    corporates: corpIds.length,
    ready: 0,
    needsUser: 0,
    fixed: 0,
    linked: 0,
    passwordReset: 0,
    errors: 0,
    skipped: 0,
  }

  for (const corporateUserId of corpIds) {
    const report = await ensureCorporateMemberLoginsForParent({
      corporateUserId,
      actorUserId: options.actorUserId,
      apply: options.apply,
      resetPasswords: options.resetPasswords,
    })
    results.push(report)
    totals.ready += report.summary.ready
    totals.needsUser += report.summary.needsUser
    totals.fixed += report.summary.fixed
    totals.linked += report.summary.linked
    totals.passwordReset += report.summary.passwordReset
    totals.errors += report.summary.errors
    totals.skipped += report.summary.skipped
  }

  return {
    apply: Boolean(options.apply),
    resetPasswords: Boolean(options.resetPasswords),
    results,
    totals,
  }
}
