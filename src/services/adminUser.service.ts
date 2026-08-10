import type { Prisma } from '../../generated/prisma/client'
import { AccountStatus, AuthProvider, UserRole as PrismaUserRole } from '../../generated/prisma/enums'
import { toApiRole, toPrismaRole } from '../constants/userRole'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import authUtils from '../utils/auth.utils'
import { prisma } from '../utils/prisma'
import type {
  AccountStatusValue,
  CreateAdminUserBody,
  ListAdminUsersQuery,
  SetAdminUserStatusBody,
  UpdateAdminUserBody,
} from '../zodValidation/adminUser.zod'
import subscriptionService from './subscription.service'

export type AdminUserRow = {
  id: string
  name: string | null
  email: string
  role: string
  companyName: string | null
  registeredCards: number
  accountStatus: AccountStatusValue
  isActive: boolean
  isVerified: boolean
  createdAt: Date
}

export type AdminUserStats = {
  singleOwners: number
  corporateOwners: number
  activeNow: number
  total: number
}

export type AdminUsersListPage = {
  items: AdminUserRow[]
  total: number
  skip: number
  limit: number
}

type ActorContext = {
  actorId: string
  actorEmail?: string | null
  actorName?: string | null
}

function syncIsActive(status: AccountStatusValue): boolean {
  return status === 'ACTIVE'
}

function buildWhere(query: ListAdminUsersQuery): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
  }

  const q = query.q?.trim()
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { companyName: { contains: q, mode: 'insensitive' } },
    ]
  }

  if (query.role) {
    where.role = toPrismaRole(query.role)
  }

  if (query.accountStatus) {
    where.accountStatus = query.accountStatus as AccountStatus
  }

  return where
}

function mapRow(user: {
  id: string
  name: string | null
  email: string
  role: PrismaUserRole
  companyName: string | null
  accountStatus: AccountStatus
  isActive: boolean
  isVerified: boolean
  createdAt: Date
  _count: { profiles: number }
}): AdminUserRow {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: toApiRole(user.role),
    companyName: user.companyName,
    registeredCards: user._count.profiles,
    accountStatus: user.accountStatus,
    isActive: user.isActive,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
  }
}

const list = async (query: ListAdminUsersQuery): Promise<AdminUsersListPage> => {
  const where = buildWhere(query)
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip: query.skip,
      take: query.limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        companyName: true,
        accountStatus: true,
        isActive: true,
        isVerified: true,
        createdAt: true,
        _count: { select: { profiles: true } },
      },
    }),
  ])

  return {
    items: rows.map(mapRow),
    total,
    skip: query.skip,
    limit: query.limit,
  }
}

const stats = async (): Promise<AdminUserStats> => {
  const base = { deletedAt: null as null }
  const [singleOwners, corporateOwners, activeNow, total] = await Promise.all([
    prisma.user.count({ where: { ...base, role: PrismaUserRole.VCARD_OWNER } }),
    prisma.user.count({ where: { ...base, role: PrismaUserRole.CORPORATE_OWNER } }),
    prisma.user.count({ where: { ...base, accountStatus: AccountStatus.ACTIVE, isActive: true } }),
    prisma.user.count({ where: base }),
  ])

  return { singleOwners, corporateOwners, activeNow, total }
}

const create = async (body: CreateAdminUserBody, actor: ActorContext): Promise<AdminUserRow> => {
  const email = body.email.trim().toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    throw new AppError(400, 'Email already registered')
  }

  const hashedPassword = await authUtils.hashPassword(body.password)
  const companyName = body.companyName?.trim() || null

  const user = await prisma.user.create({
    data: {
      name: body.name.trim(),
      email,
      password: hashedPassword,
      role: toPrismaRole(body.role),
      provider: AuthProvider.LOCAL,
      isVerified: true,
      isActive: true,
      accountStatus: AccountStatus.ACTIVE,
      companyName,
      createdById: actor.actorId,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyName: true,
      accountStatus: true,
      isActive: true,
      isVerified: true,
      createdAt: true,
      _count: { select: { profiles: true } },
    },
  })

  if (body.role === 'corporate-owner') {
    await subscriptionService.ensureCorporateStarterSubscription(user.id)
  }

  await writeAuditLog({
    action: 'User Created',
    details: `Provisioned user account for ${user.name ?? user.email} (${toApiRole(user.role)})`,
    type: 'create',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, email: user.email, role: toApiRole(user.role) },
  })

  return mapRow(user)
}

const update = async (id: string, body: UpdateAdminUserBody, actor: ActorContext): Promise<AdminUserRow> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
  })
  if (!existing) {
    throw new AppError(404, 'User not found')
  }

  if ((existing.role === PrismaUserRole.ADMIN || existing.role === PrismaUserRole.SUPER_ADMIN) && body.role) {
    throw new AppError(400, 'Cannot change admin role from this endpoint')
  }

  if (body.email) {
    const email = body.email.trim().toLowerCase()
    if (email !== existing.email) {
      const conflict = await prisma.user.findUnique({ where: { email } })
      if (conflict) {
        throw new AppError(400, 'Email already registered')
      }
    }
  }

  const data: Prisma.UserUpdateInput = {}
  if (body.name !== undefined) data.name = body.name.trim()
  if (body.email !== undefined) data.email = body.email.trim().toLowerCase()
  if (body.role !== undefined) data.role = toPrismaRole(body.role)
  if (body.companyName !== undefined) data.companyName = body.companyName?.trim() || null

  if (body.password) {
    const emailForCheck = (body.email ?? existing.email).trim().toLowerCase()
    if (body.password.trim().toLowerCase() === emailForCheck) {
      throw new AppError(400, "Password can't be the same as email")
    }
    data.password = await authUtils.hashPassword(body.password)
    data.passwordChangedAt = new Date()
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyName: true,
      accountStatus: true,
      isActive: true,
      isVerified: true,
      createdAt: true,
      _count: { select: { profiles: true } },
    },
  })

  await writeAuditLog({
    action: 'User Modified',
    details: body.password
      ? `Updated parameters and reset password for ${user.name ?? user.email}`
      : `Updated parameters for ${user.name ?? user.email}`,
    type: 'update',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, passwordReset: Boolean(body.password) },
  })

  return mapRow(user)
}

const setStatus = async (id: string, body: SetAdminUserStatusBody, actor: ActorContext): Promise<AdminUserRow> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
  })
  if (!existing) {
    throw new AppError(404, 'User not found')
  }

  if (existing.id === actor.actorId && body.accountStatus !== 'ACTIVE') {
    throw new AppError(400, 'Cannot pause or suspend your own account')
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      accountStatus: body.accountStatus as AccountStatus,
      isActive: syncIsActive(body.accountStatus),
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyName: true,
      accountStatus: true,
      isActive: true,
      isVerified: true,
      createdAt: true,
      _count: { select: { profiles: true } },
    },
  })

  await writeAuditLog({
    action: 'User Toggle Status',
    details: `Changed account status for ${user.name ?? user.email} to ${body.accountStatus}`,
    type: 'status',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: user.id, accountStatus: body.accountStatus },
  })

  return mapRow(user)
}

const remove = async (id: string, actor: ActorContext): Promise<null> => {
  const existing = await prisma.user.findFirst({
    where: { id, deletedAt: null },
  })
  if (!existing) {
    throw new AppError(404, 'User not found')
  }

  if (existing.id === actor.actorId) {
    throw new AppError(400, 'Cannot delete your own account')
  }

  if (existing.role === PrismaUserRole.SUPER_ADMIN) {
    const superAdminCount = await prisma.user.count({
      where: { role: PrismaUserRole.SUPER_ADMIN, deletedAt: null },
    })
    if (superAdminCount <= 1) {
      throw new AppError(400, 'Cannot delete the last super admin account')
    }
  } else if (existing.role === PrismaUserRole.ADMIN) {
    throw new AppError(400, 'Manage admin accounts from the Admin Team page')
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
    action: 'User Wiped',
    details: `Deleted user ${existing.name ?? existing.email} and unlinked portfolio access`,
    type: 'delete',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { userId: existing.id, email: existing.email },
  })

  return null
}

const adminUserService = {
  list,
  stats,
  create,
  update,
  setStatus,
  remove,
}

export default adminUserService
