import { AccountStatus, AuthProvider, UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import { sanitizeAllowedModules, toApiRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import authUtils from '../utils/auth.utils'
import { prisma } from '../utils/prisma'
import type {
  CreateAdminTeamMemberBody,
  SetAdminTeamStatusBody,
  UpdateAdminTeamMemberBody,
} from '../zodValidation/adminTeam.zod'

type ActorContext = {
  actorId: string
  actorEmail?: string | null
  actorName?: string | null
}

export type AdminTeamMemberRow = {
  id: string
  name: string | null
  email: string
  role: string
  staffRole: string | null
  allowedModules: string[]
  isActive: boolean
  accountStatus: string
  isVerified: boolean
  createdAt: Date
  updatedAt: Date
}

const memberSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  staffRole: true,
  allowedModules: true,
  isActive: true,
  accountStatus: true,
  isVerified: true,
  createdAt: true,
  updatedAt: true,
} as const

function mapRow(user: {
  id: string
  name: string | null
  email: string
  role: PrismaUserRole
  staffRole: string | null
  allowedModules: string[]
  isActive: boolean
  accountStatus: AccountStatus
  isVerified: boolean
  createdAt: Date
  updatedAt: Date
}): AdminTeamMemberRow {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: toApiRole(user.role),
    staffRole: user.staffRole,
    allowedModules: user.allowedModules ?? [],
    isActive: user.isActive,
    accountStatus: user.accountStatus,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

async function countSuperAdmins(excludeId?: string): Promise<number> {
  return prisma.user.count({
    where: {
      role: PrismaUserRole.SUPER_ADMIN,
      deletedAt: null,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
  })
}

const list = async (): Promise<AdminTeamMemberRow[]> => {
  const rows = await prisma.user.findMany({
    where: {
      deletedAt: null,
      role: { in: [PrismaUserRole.ADMIN, PrismaUserRole.SUPER_ADMIN] },
    },
    select: memberSelect,
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map(mapRow)
}

const create = async (body: CreateAdminTeamMemberBody, actor: ActorContext): Promise<AdminTeamMemberRow> => {
  const email = body.email.trim().toLowerCase()
  const conflict = await prisma.user.findUnique({ where: { email } })
  if (conflict) {
    throw new AppError(400, 'Email already registered')
  }

  const allowedModules = sanitizeAllowedModules(body.allowedModules)
  if (allowedModules.length === 0) {
    throw new AppError(400, 'Select at least one grantable module')
  }

  const hashedPassword = await authUtils.hashPassword(body.password)

  const user = await prisma.user.create({
    data: {
      name: body.name.trim(),
      email,
      password: hashedPassword,
      role: PrismaUserRole.ADMIN,
      provider: AuthProvider.LOCAL,
      isVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      staffRole: body.staffRole,
      allowedModules,
      createdById: actor.actorId,
    },
    select: memberSelect,
  })

  await writeAuditLog({
    action: 'Admin Created',
    details: `Created admin ${user.name ?? user.email} (${body.staffRole})`,
    type: 'create',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, staffRole: body.staffRole, allowedModules },
  })

  return mapRow(user)
}

const update = async (
  id: string,
  body: UpdateAdminTeamMemberBody,
  actor: ActorContext
): Promise<AdminTeamMemberRow> => {
  const existing = await prisma.user.findFirst({
    where: {
      id,
      deletedAt: null,
      role: { in: [PrismaUserRole.ADMIN, PrismaUserRole.SUPER_ADMIN] },
    },
  })
  if (!existing) throw new AppError(404, 'Admin not found')

  if (existing.role === PrismaUserRole.SUPER_ADMIN) {
    if (body.staffRole !== undefined || body.allowedModules !== undefined) {
      throw new AppError(400, 'Cannot change super admin access modules')
    }
  }

  const allowedModules = body.allowedModules !== undefined ? sanitizeAllowedModules(body.allowedModules) : undefined
  if (allowedModules !== undefined && allowedModules.length === 0) {
    throw new AppError(400, 'Select at least one grantable module')
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(existing.role === PrismaUserRole.ADMIN && body.staffRole !== undefined ? { staffRole: body.staffRole } : {}),
      ...(existing.role === PrismaUserRole.ADMIN && allowedModules !== undefined ? { allowedModules } : {}),
    },
    select: memberSelect,
  })

  await writeAuditLog({
    action: 'Admin Access Updated',
    details: `Updated admin access for ${user.name ?? user.email}`,
    type: 'update',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, staffRole: user.staffRole, allowedModules: user.allowedModules },
  })

  return mapRow(user)
}

const setStatus = async (
  id: string,
  body: SetAdminTeamStatusBody,
  actor: ActorContext
): Promise<AdminTeamMemberRow> => {
  const existing = await prisma.user.findFirst({
    where: {
      id,
      deletedAt: null,
      role: { in: [PrismaUserRole.ADMIN, PrismaUserRole.SUPER_ADMIN] },
    },
  })
  if (!existing) throw new AppError(404, 'Admin not found')

  if (existing.id === actor.actorId && !body.isActive) {
    throw new AppError(400, 'Cannot deactivate your own account')
  }

  if (existing.role === PrismaUserRole.SUPER_ADMIN && !body.isActive) {
    const remaining = await countSuperAdmins(id)
    if (remaining < 1) {
      throw new AppError(400, 'Cannot deactivate the last super admin')
    }
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      isActive: body.isActive,
      accountStatus: body.isActive ? AccountStatus.ACTIVE : AccountStatus.PAUSED,
    },
    select: memberSelect,
  })

  await writeAuditLog({
    action: 'Admin Status Changed',
    details: `${body.isActive ? 'Activated' : 'Deactivated'} admin ${user.name ?? user.email}`,
    type: 'status',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, isActive: body.isActive },
  })

  return mapRow(user)
}

const remove = async (id: string, actor: ActorContext): Promise<null> => {
  const existing = await prisma.user.findFirst({
    where: {
      id,
      deletedAt: null,
      role: { in: [PrismaUserRole.ADMIN, PrismaUserRole.SUPER_ADMIN] },
    },
  })
  if (!existing) throw new AppError(404, 'Admin not found')

  if (existing.id === actor.actorId) {
    throw new AppError(400, 'Cannot remove your own account')
  }

  if (existing.role === PrismaUserRole.SUPER_ADMIN) {
    const remaining = await countSuperAdmins(id)
    if (remaining < 1) {
      throw new AppError(400, 'Cannot delete the last super admin')
    }
  }

  await prisma.user.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      isActive: false,
      accountStatus: AccountStatus.SUSPENDED,
    },
  })

  await writeAuditLog({
    action: 'Admin Removed',
    details: `Removed admin ${existing.name ?? existing.email}`,
    type: 'delete',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: existing.id, role: toApiRole(existing.role) },
  })

  return null
}

const adminTeamService = {
  list,
  create,
  update,
  setStatus,
  remove,
}

export default adminTeamService
