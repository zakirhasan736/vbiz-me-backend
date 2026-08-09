import { UserRole as PrismaUserRole } from '../../generated/prisma/enums'

export const USER_ROLES = ['vcard-owner', 'corporate-owner', 'admin', 'super-admin'] as const

export type UserRole = (typeof USER_ROLES)[number]

export const STAFF_ROLES = ['admin', 'super-admin'] as const
export type StaffRole = (typeof STAFF_ROLES)[number]

export const SUPER_ADMIN_ONLY_MODULES = ['packages', 'team', 'audit'] as const

export const GRANTABLE_ADMIN_MODULES = [
  'dashboard',
  'mycards',
  'vcards',
  'users',
  'leads',
  'support',
  'announcements',
  'templates',
  'schedule',
  'settings',
] as const

export type AdminModuleKey = (typeof GRANTABLE_ADMIN_MODULES)[number] | (typeof SUPER_ADMIN_ONLY_MODULES)[number]

export const ALL_ADMIN_MODULES: AdminModuleKey[] = [...GRANTABLE_ADMIN_MODULES, ...SUPER_ADMIN_ONLY_MODULES]

export const USER_ROLE_TO_PRISMA = {
  'vcard-owner': PrismaUserRole.VCARD_OWNER,
  'corporate-owner': PrismaUserRole.CORPORATE_OWNER,
  admin: PrismaUserRole.ADMIN,
  'super-admin': PrismaUserRole.SUPER_ADMIN,
} as const satisfies Record<UserRole, PrismaUserRole>

export const PRISMA_ROLE_TO_USER = {
  [PrismaUserRole.VCARD_OWNER]: 'vcard-owner',
  [PrismaUserRole.CORPORATE_OWNER]: 'corporate-owner',
  [PrismaUserRole.ADMIN]: 'admin',
  [PrismaUserRole.SUPER_ADMIN]: 'super-admin',
} as const satisfies Record<PrismaUserRole, UserRole>

export const toApiRole = (role: PrismaUserRole): UserRole => {
  return PRISMA_ROLE_TO_USER[role]
}

export const toPrismaRole = (role: UserRole): PrismaUserRole => {
  return USER_ROLE_TO_PRISMA[role]
}

export const isStaffRole = (role?: string | null): role is StaffRole => {
  return role === 'admin' || role === 'super-admin'
}

export const isSuperAdmin = (role?: string | null): boolean => {
  return role === 'super-admin'
}

export const sanitizeAllowedModules = (modules: string[] | undefined | null): string[] => {
  if (!modules?.length) return []
  const grantable = new Set<string>(GRANTABLE_ADMIN_MODULES)
  return [...new Set(modules.filter((m) => grantable.has(m)))]
}
