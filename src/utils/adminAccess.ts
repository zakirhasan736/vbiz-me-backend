import { isStaffRole, isSuperAdmin, SUPER_ADMIN_ONLY_MODULES, type AdminModuleKey } from '../constants/userRole'
import AppError from '../error/AppError'

export function assertStaff(role?: string | null): void {
  if (!isStaffRole(role)) {
    throw new AppError(403, 'FORBIDDEN ACCESS')
  }
}

export function assertSuperAdmin(role?: string | null): void {
  if (!isSuperAdmin(role)) {
    throw new AppError(403, 'FORBIDDEN ACCESS')
  }
}

/** Super-admin always passes. Regular admins need the module and cannot use SA-only modules. */
export function assertModule(
  role: string | undefined | null,
  allowedModules: string[] | undefined | null,
  moduleKey: AdminModuleKey
): void {
  if (isSuperAdmin(role)) return

  assertStaff(role)

  if ((SUPER_ADMIN_ONLY_MODULES as readonly string[]).includes(moduleKey)) {
    throw new AppError(403, 'FORBIDDEN ACCESS')
  }

  const modules = allowedModules ?? []
  if (!modules.includes(moduleKey)) {
    throw new AppError(403, 'FORBIDDEN ACCESS')
  }
}
