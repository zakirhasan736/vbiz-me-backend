import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import { isStaffRole, toApiRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { prisma } from './prisma'

type ProfileOutreachRow = {
  id: string
  userId: string | null
  companyUserId: string | null
  user: { role: PrismaUserRole } | null
  companyUser: { role: PrismaUserRole } | null
  createdBy: { role: PrismaUserRole } | null
}

function isAdminPortfolioProfile(profile: ProfileOutreachRow): boolean {
  if (profile.companyUser?.role && isStaffRole(toApiRole(profile.companyUser.role))) return true
  if (profile.createdBy?.role && isStaffRole(toApiRole(profile.createdBy.role))) return true
  if (
    profile.companyUserId &&
    profile.companyUserId === profile.userId &&
    profile.user?.role &&
    isStaffRole(toApiRole(profile.user.role))
  ) {
    return true
  }
  return false
}

const profileOutreachSelect = {
  id: true,
  userId: true,
  companyUserId: true,
  user: { select: { role: true } },
  companyUser: { select: { role: true } },
  createdBy: { select: { role: true } },
} as const

/** Reject admin outreach (schedule, card notice) against portfolio or non-owner profiles. */
export async function assertAdminCanContactProfile(_actorId: string, profileId: string) {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: profileOutreachSelect,
  })
  if (!profile) throw new AppError(404, 'Profile not found')

  if (isAdminPortfolioProfile(profile)) {
    throw new AppError(403, 'Admin outreach is not available for portfolio cards')
  }

  const ownerRole = profile.user?.role ? toApiRole(profile.user.role) : null
  if (ownerRole !== 'vcard-owner' && ownerRole !== 'corporate-owner') {
    throw new AppError(403, 'Admin outreach is only available for single and corporate card owners')
  }

  return profile
}
