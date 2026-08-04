import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'

export const USER_ROLES = ['vcard-owner', 'corporate-owner', 'admin'] as const

export type UserRole = (typeof USER_ROLES)[number]

export const USER_ROLE_TO_PRISMA = {
  'vcard-owner': PrismaUserRole.VCARD_OWNER,
  'corporate-owner': PrismaUserRole.CORPORATE_OWNER,
  admin: PrismaUserRole.ADMIN,
} as const satisfies Record<UserRole, PrismaUserRole>

export const PRISMA_ROLE_TO_USER = {
  [PrismaUserRole.VCARD_OWNER]: 'vcard-owner',
  [PrismaUserRole.CORPORATE_OWNER]: 'corporate-owner',
  [PrismaUserRole.ADMIN]: 'admin',
} as const satisfies Record<PrismaUserRole, UserRole>

export const toApiRole = (role: PrismaUserRole): UserRole => {
  return PRISMA_ROLE_TO_USER[role]
}

export const toPrismaRole = (role: UserRole): PrismaUserRole => {
  return USER_ROLE_TO_PRISMA[role]
}
