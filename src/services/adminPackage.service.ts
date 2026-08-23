import {
  inferOwnerModeFromCatalog,
  prismaOwnerMode,
  resolveOwnerMode,
  type OwnerMode,
} from '../constants/packageOwnerMode'
import AppError from '../error/AppError'
import { writeAuditLog } from '../utils/auditLog'
import { prisma } from '../utils/prisma'
import type { CreateAdminPackageBody, UpdateAdminPackageBody } from '../zodValidation/adminPackage.zod'

type ActorContext = {
  actorId: string
  actorEmail?: string | null
  actorName?: string | null
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = slugify(base) || `package-${Date.now()}`
  let i = 0
  while (true) {
    const existing = await prisma.package.findFirst({
      where: {
        slug,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    })
    if (!existing) return slug
    i += 1
    slug = `${slugify(base).slice(0, 100)}-${i}`
  }
}

const featureSelect = {
  id: true,
  featureKey: true,
  featureValue: true,
} as const

const packageListSelect = {
  id: true,
  name: true,
  slug: true,
  ownerMode: true,
  description: true,
  monthlyPrice: true,
  yearlyPrice: true,
  signupFeeCents: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  features: { select: featureSelect, orderBy: { featureKey: 'asc' as const } },
  _count: { select: { subscriptions: true } },
} as const

export type AdminPackageRow = {
  id: string
  name: string
  slug: string | null
  description: string | null
  monthlyPrice: number
  yearlyPrice: number
  signupFeeCents: number
  isActive: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  features: { id: string; featureKey: string; featureValue: string | null }[]
  subscriberCount: number
  ownerMode: OwnerMode
}

export type PackageSubscriber = {
  subscriptionId: string
  userId: string
  name: string | null
  email: string
  stripeStatus: string | null
  createdAt: Date
}

function mapPackage(row: {
  id: string
  name: string
  slug: string | null
  ownerMode?: string | null
  description: string | null
  monthlyPrice: number
  yearlyPrice: number
  signupFeeCents: number
  isActive: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
  features: { id: string; featureKey: string; featureValue: string | null }[]
  _count: { subscriptions: number }
}): AdminPackageRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    monthlyPrice: row.monthlyPrice,
    yearlyPrice: row.yearlyPrice,
    signupFeeCents: row.signupFeeCents,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    features: row.features,
    subscriberCount: row._count.subscriptions,
    ownerMode: resolveOwnerMode(row),
  }
}

const list = async (): Promise<AdminPackageRow[]> => {
  const rows = await prisma.package.findMany({
    select: packageListSelect,
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map(mapPackage)
}

const getById = async (id: string): Promise<AdminPackageRow & { subscribers: PackageSubscriber[] }> => {
  const row = await prisma.package.findUnique({
    where: { id },
    select: packageListSelect,
  })
  if (!row) throw new AppError(404, 'Package not found')

  const subscriptions = await prisma.subscription.findMany({
    where: { packageId: id },
    select: {
      id: true,
      stripeStatus: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return {
    ...mapPackage(row),
    subscribers: subscriptions.map((s) => ({
      subscriptionId: s.id,
      userId: s.user.id,
      name: s.user.name,
      email: s.user.email,
      stripeStatus: s.stripeStatus,
      createdAt: s.createdAt,
    })),
  }
}

const create = async (body: CreateAdminPackageBody, actor: ActorContext): Promise<AdminPackageRow> => {
  const slug = await ensureUniqueSlug(body.slug?.trim() || body.name)
  const ownerMode = inferOwnerModeFromCatalog({ slug, name: body.name })

  const row = await prisma.package.create({
    data: {
      name: body.name.trim(),
      slug,
      ownerMode: prismaOwnerMode(ownerMode),
      description: body.description?.trim() || null,
      monthlyPrice: body.monthlyPrice,
      yearlyPrice: body.yearlyPrice,
      signupFeeCents: body.signupFeeCents ?? 0,
      isActive: body.isActive ?? true,
      sortOrder: body.sortOrder ?? 0,
      features: {
        create: (body.features ?? []).map((f) => ({
          featureKey: f.featureKey.trim(),
          featureValue: f.featureValue?.trim() || null,
        })),
      },
    },
    select: packageListSelect,
  })

  await writeAuditLog({
    action: 'Package Created',
    details: `Created subscription package '${row.name}'`,
    type: 'create',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { packageId: row.id, slug: row.slug },
  })

  return mapPackage(row)
}

const update = async (id: string, body: UpdateAdminPackageBody, actor: ActorContext): Promise<AdminPackageRow> => {
  const existing = await prisma.package.findUnique({ where: { id } })
  if (!existing) throw new AppError(404, 'Package not found')

  let slug: string | null | undefined = body.slug
  if (body.slug !== undefined) {
    if (body.slug === null || body.slug.trim() === '') {
      slug = null
    } else {
      slug = await ensureUniqueSlug(body.slug, id)
    }
  } else if (body.name && body.name.trim() !== existing.name && !existing.slug) {
    slug = await ensureUniqueSlug(body.name, id)
  }

  const nextName = body.name !== undefined ? body.name.trim() : existing.name
  const nextSlug = slug !== undefined ? slug : existing.slug
  const ownerMode = prismaOwnerMode(inferOwnerModeFromCatalog({ slug: nextSlug, name: nextName }))

  const row = await prisma.$transaction(async (tx) => {
    if (body.features !== undefined) {
      await tx.packageFeature.deleteMany({ where: { packageId: id } })
      if (body.features.length > 0) {
        await tx.packageFeature.createMany({
          data: body.features.map((f) => ({
            packageId: id,
            featureKey: f.featureKey.trim(),
            featureValue: f.featureValue?.trim() || null,
          })),
        })
      }
    }

    return tx.package.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ownerMode,
        ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
        ...(body.monthlyPrice !== undefined ? { monthlyPrice: body.monthlyPrice } : {}),
        ...(body.yearlyPrice !== undefined ? { yearlyPrice: body.yearlyPrice } : {}),
        ...(body.signupFeeCents !== undefined ? { signupFeeCents: body.signupFeeCents } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      },
      select: packageListSelect,
    })
  })

  await writeAuditLog({
    action: 'Package Updated',
    details: `Updated subscription package '${row.name}'`,
    type: 'update',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { packageId: row.id },
  })

  return mapPackage(row)
}

const remove = async (id: string, actor: ActorContext): Promise<null> => {
  const existing = await prisma.package.findUnique({
    where: { id },
    include: { _count: { select: { subscriptions: true } } },
  })
  if (!existing) throw new AppError(404, 'Package not found')

  if (existing._count.subscriptions > 0) {
    throw new AppError(
      409,
      `Cannot delete package with ${existing._count.subscriptions} subscriber(s). Deactivate it instead.`
    )
  }

  await prisma.package.delete({ where: { id } })

  await writeAuditLog({
    action: 'Package Deleted',
    details: `Deleted subscription package '${existing.name}'`,
    type: 'delete',
    actorId: actor.actorId,
    actor: actor.actorName || actor.actorEmail || null,
    meta: { packageId: id },
  })

  return null
}

const adminPackageService = {
  list,
  getById,
  create,
  update,
  remove,
}

export default adminPackageService
