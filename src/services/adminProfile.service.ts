import type { Prisma } from '../../generated/prisma/client'
import { toApiRole } from '../constants/userRole'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'
import { loadProfileEngagementMetrics, type ProfileSocialClickRow } from '../utils/profileListMetrics'
import type {
  AdminProfileFiltersInput,
  ExportAdminProfilesQuery,
  ListAdminProfilesQuery,
} from '../zodValidation/adminProfile.zod'

const adminListInclude = {
  status: { select: { id: true, name: true } },
  profession: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true, role: true } },
  companyUser: { select: { id: true, name: true, email: true, role: true } },
  createdBy: { select: { id: true, name: true, email: true, role: true } },
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
  website: string | null
  avatar: string | null
  isPublic: boolean
  isDraft: boolean
  viewCount: number
  clickCount: number
  saveCount: number
  shareCount: number
  facebook: string | null
  instagram: string | null
  twitter: string | null
  tiktok: string | null
  youtube: string | null
  linkedin: string | null
  rumble: string | null
  truth: string | null
  socialClicks: ProfileSocialClickRow[]
  createdAt: Date
  updatedAt: Date
  status: { id: string; name: string } | null
  profession: { id: string; name: string } | null
  user: { id: string; name: string | null; email: string; role: string } | null
  companyUser: { id: string; name: string | null; email: string; role: string } | null
  createdBy: { id: string; name: string | null; email: string; role: string } | null
}

function buildWhere(filters: AdminProfileFiltersInput): Prisma.ProfileWhereInput {
  const and: Prisma.ProfileWhereInput[] = []

  const q = filters.q?.trim()
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { companyName: { contains: q, mode: 'insensitive' } },
        { designation: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
      ],
    })
  }

  const statusName = filters.status?.trim()
  if (statusName && statusName.toLowerCase() !== 'all') {
    and.push({ status: { name: { equals: statusName, mode: 'insensitive' } } })
  }

  // Lifecycle tabs: isDraft flag OR legacy Status.name === "Draft"
  if (filters.lifecycle === 'draft') {
    and.push({
      OR: [{ isDraft: true }, { status: { name: { equals: 'draft', mode: 'insensitive' } } }],
    })
  } else if (filters.lifecycle === 'active') {
    and.push({ isDraft: false })
    and.push({ NOT: { status: { name: { equals: 'draft', mode: 'insensitive' } } } })
  }

  const professionName = filters.profession?.trim()
  if (professionName && professionName.toLowerCase() !== 'all') {
    and.push({ profession: { name: { equals: professionName, mode: 'insensitive' } } })
  }

  return and.length ? { AND: and } : {}
}

function buildOrderBy(
  sortBy: ListAdminProfilesQuery['sortBy'],
  sortDir: ListAdminProfilesQuery['sortDir']
): Prisma.ProfileOrderByWithRelationInput {
  return { [sortBy]: sortDir }
}

function mapRow(
  profile: AdminListRow,
  metrics?: {
    clickCount: number
    saveCount: number
    shareCount: number
    socialClicks: ProfileSocialClickRow[]
  }
): AdminProfileRow {
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
    website: profile.website,
    avatar,
    isPublic: profile.isPublic,
    isDraft: profile.isDraft,
    viewCount: profile.viewCount,
    clickCount: metrics?.clickCount ?? 0,
    saveCount: metrics?.saveCount ?? 0,
    shareCount: metrics?.shareCount ?? 0,
    facebook: profile.facebook,
    instagram: profile.instagram,
    twitter: profile.twitter,
    tiktok: profile.tiktok,
    youtube: profile.youtube,
    linkedin: profile.linkedin,
    rumble: profile.rumble,
    truth: profile.truth,
    socialClicks: metrics?.socialClicks ?? [],
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
    companyUser: profile.companyUser
      ? {
          id: profile.companyUser.id,
          name: profile.companyUser.name,
          email: profile.companyUser.email,
          role: toApiRole(profile.companyUser.role),
        }
      : null,
    createdBy: profile.createdBy
      ? {
          id: profile.createdBy.id,
          name: profile.createdBy.name,
          email: profile.createdBy.email,
          role: toApiRole(profile.createdBy.role),
        }
      : null,
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

  const metricsByProfile = await loadProfileEngagementMetrics(rows.map((r) => r.id))

  return {
    items: rows.map((row) => mapRow(row, metricsByProfile.get(row.id))),
    total,
    skip: showAll ? 0 : query.skip,
    limit: showAll ? null : query.limit,
    showAll,
  }
}

const getFilterOptions = async () => {
  const [statuses, professions] = await Promise.all([
    prisma.status.findMany({
      where: { NOT: { name: { equals: 'draft', mode: 'insensitive' } } },
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
