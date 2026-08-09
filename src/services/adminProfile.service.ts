import type { Prisma } from '../../generated/prisma/client'
import { toApiRole } from '../constants/userRole'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'
import type {
  AdminProfileFiltersInput,
  ExportAdminProfilesQuery,
  ListAdminProfilesQuery,
} from '../zodValidation/adminProfile.zod'

const adminListInclude = {
  status: { select: { id: true, name: true } },
  profession: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true, role: true } },
  companyUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ProfileInclude

type AdminListRow = Prisma.ProfileGetPayload<{ include: typeof adminListInclude }>

export type AdminProfileRow = {
  id: string
  slug: string | null
  name: string
  email: string
  companyName: string | null
  designation: string | null
  phone: string | null
  whatsapp: string | null
  avatar: string | null
  isPublic: boolean
  viewCount: number
  createdAt: Date
  updatedAt: Date
  status: { id: string; name: string } | null
  profession: { id: string; name: string } | null
  user: { id: string; name: string | null; email: string; role: string } | null
  companyUser: { id: string; name: string | null; email: string } | null
}

function buildWhere(filters: AdminProfileFiltersInput): Prisma.ProfileWhereInput {
  const where: Prisma.ProfileWhereInput = {}

  const q = filters.q?.trim()
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { companyName: { contains: q, mode: 'insensitive' } },
      { designation: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ]
  }

  const statusName = filters.status?.trim()
  if (statusName && statusName.toLowerCase() !== 'all') {
    where.status = { name: { equals: statusName, mode: 'insensitive' } }
  }

  const professionName = filters.profession?.trim()
  if (professionName && professionName.toLowerCase() !== 'all') {
    where.profession = { name: { equals: professionName, mode: 'insensitive' } }
  }

  return where
}

function buildOrderBy(
  sortBy: ListAdminProfilesQuery['sortBy'],
  sortDir: ListAdminProfilesQuery['sortDir']
): Prisma.ProfileOrderByWithRelationInput {
  return { [sortBy]: sortDir }
}

function mapRow(profile: AdminListRow): AdminProfileRow {
  const avatar =
    ensureAbsoluteMediaUrl(profile.avatar, {
      docName: profile.avatar,
      attachmentTypeLegacyId: 13,
      attachmentTypeName: 'Profile Picture',
      profileLegacyId: profile.legacyId ?? null,
      profileSlug: profile.slug ?? null,
    }) || profile.avatar

  return {
    id: profile.id,
    slug: profile.slug,
    name: profile.name,
    email: profile.email,
    companyName: profile.companyName,
    designation: profile.designation,
    phone: profile.phone,
    whatsapp: profile.whatsapp,
    avatar,
    isPublic: profile.isPublic,
    viewCount: profile.viewCount,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    status: profile.status,
    profession: profile.profession,
    user: profile.user
      ? {
          id: profile.user.id,
          name: profile.user.name,
          email: profile.user.email,
          role: toApiRole(profile.user.role),
        }
      : null,
    companyUser: profile.companyUser,
  }
}

const list = async (query: ListAdminProfilesQuery) => {
  const where = buildWhere(query)
  const orderBy = buildOrderBy(query.sortBy, query.sortDir)
  const showAll = Boolean(query.showAll)

  const [total, rows] = await Promise.all([
    prisma.profile.count({ where }),
    prisma.profile.findMany({
      where,
      include: adminListInclude,
      orderBy,
      ...(showAll
        ? {}
        : {
            skip: query.skip,
            take: query.limit,
          }),
    }),
  ])

  return {
    items: rows.map(mapRow),
    total,
    skip: showAll ? 0 : query.skip,
    limit: showAll ? null : query.limit,
    showAll,
  }
}

const getFilterOptions = async () => {
  const [statuses, professions] = await Promise.all([
    prisma.status.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.profession.findMany({
      where: { profiles: { some: {} } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  return { statuses, professions }
}

function csvEscape(value: string | number | null | undefined): string {
  const raw = value == null ? '' : String(value)
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`
  return raw
}

const exportCsv = async (query: ExportAdminProfilesQuery) => {
  const where = buildWhere(query)
  const orderBy = buildOrderBy(query.sortBy, query.sortDir)

  const rows = await prisma.profile.findMany({
    where,
    include: adminListInclude,
    orderBy,
  })

  const header = ['ID', 'Slug', 'Full Name', 'Email', 'Profession', 'Designation', 'Company', 'Status']
  const lines = [
    header.join(','),
    ...rows.map((p) =>
      [
        csvEscape(p.id),
        csvEscape(p.slug),
        csvEscape(p.name),
        csvEscape(p.email),
        csvEscape(p.profession?.name),
        csvEscape(p.designation),
        csvEscape(p.companyName),
        csvEscape(p.status?.name),
      ].join(',')
    ),
  ]

  return lines.join('\n')
}

const adminProfileService = {
  list,
  getFilterOptions,
  exportCsv,
}

export default adminProfileService
