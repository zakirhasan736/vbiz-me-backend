import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { slugify } from '../middlewares/ownership'
import {
  SOCIAL_CHANNELS,
  SOCIAL_CHANNEL_LABELS,
  buildDailyPoints,
  countDistinctGuests,
  countDistinctGuestsByChannel,
  countDistinctGuestsByDay,
  eventTypeLabel,
  formatRelativeTime,
  parsePlatformFromUa,
  trendPercent,
  viewerFromPayload,
} from '../utils/dashboardAnalytics'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'

const DASHBOARD_WINDOW_DAYS = 30
const RECENT_ENGAGEMENT_LIMIT = 10

/** Setting keys that store media URLs shown on the admin vCards grid. */
const LIST_MEDIA_SETTING_KEYS = new Set(['profile_media_url', 'background_media_url'])

const profileInclude = {
  gender: true,
  maritalStatus: true,
  profession: true,
  status: true,
  settings: true,
  profileSettings: true,
  socialLinks: true,
  education: { orderBy: { sortOrder: 'asc' as const } },
  experiences: { orderBy: { sortOrder: 'asc' as const } },
  services: { orderBy: { sortOrder: 'asc' as const } },
  portfolios: { orderBy: { sortOrder: 'asc' as const } },
  skillTags: { orderBy: { sortOrder: 'asc' as const } },
  addresses: true,
  attachments: { include: { attachmentType: true } },
} satisfies Prisma.ProfileInclude

const listInclude = {
  profession: true,
  profileSettings: true,
  settings: true,
  attachments: { include: { attachmentType: true } },
  _count: { select: { services: true, portfolios: true, posts: true } },
} satisfies Prisma.ProfileInclude

type ListProfileRow = Prisma.ProfileGetPayload<{ include: typeof listInclude }>

/** Absolutize avatar / media settings / attachment URLs for admin list responses. */
const absolutizeListProfile = (profile: ListProfileRow): ListProfileRow => {
  const legacyId = profile.legacyId ?? null
  const slug = profile.slug ?? null

  const avatar =
    ensureAbsoluteMediaUrl(profile.avatar, {
      docName: profile.avatar,
      attachmentTypeLegacyId: 13,
      attachmentTypeName: 'Profile Picture',
      profileLegacyId: legacyId,
      profileSlug: slug,
    }) || profile.avatar

  const settings = profile.settings.map((row) => {
    if (!LIST_MEDIA_SETTING_KEYS.has(row.key) || !row.value?.trim()) return row
    const isBackground = row.key === 'background_media_url'
    const absolute =
      ensureAbsoluteMediaUrl(row.value, {
        docName: row.value,
        attachmentTypeLegacyId: isBackground ? 9 : 13,
        attachmentTypeName: isBackground ? 'Background Video' : 'Profile Picture',
        profileLegacyId: legacyId,
        profileSlug: slug,
      }) || row.value
    return { ...row, value: absolute }
  })

  const attachments = profile.attachments.map((att) => {
    const absolute =
      ensureAbsoluteMediaUrl(att.url, {
        docName: att.docName,
        attachmentTypeLegacyId: att.attachmentType?.legacyId ?? null,
        attachmentTypeName: att.attachmentType?.name ?? null,
        profileLegacyId: legacyId,
        profileSlug: slug,
      }) || att.url
    return { ...att, url: absolute }
  })

  return { ...profile, avatar, settings, attachments }
}

const listForUser = async (userId: string, role: string) => {
  const where =
    role === 'admin'
      ? {}
      : {
          OR: [{ userId }, { companyUserId: userId }],
        }
  const profiles = await prisma.profile.findMany({
    where,
    include: listInclude,
    orderBy: { updatedAt: 'desc' },
  })
  return profiles.map(absolutizeListProfile)
}

const getOwned = async (profileId: string, userId: string, role: string) => {
  if (role === 'admin') {
    const profile = await prisma.profile.findUnique({ where: { id: profileId }, include: profileInclude })
    if (!profile) throw new AppError(404, 'Profile not found')
    return profile
  }
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, OR: [{ userId }, { companyUserId: userId }] },
    include: profileInclude,
  })
  if (!profile) throw new AppError(404, 'Profile not found')
  return profile
}

const ensureUniqueSlug = async (base: string, excludeId?: string) => {
  let slug = slugify(base) || `card-${Date.now()}`
  let i = 0
  while (true) {
    const existing = await prisma.profile.findFirst({
      where: { slug, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    })
    if (!existing) return slug
    i += 1
    slug = `${slugify(base)}-${i}`
  }
}

const checkSlugAvailability = async (rawSlug: string, excludeId?: string) => {
  const slug = slugify(rawSlug)
  if (!slug) {
    return { slug: '', available: false, suggestion: '' }
  }

  const existing = await prisma.profile.findFirst({
    where: { slug, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
  })

  if (!existing) {
    return { slug, available: true, suggestion: slug }
  }

  const suggestion = await ensureUniqueSlug(slug, excludeId)
  return { slug, available: false, suggestion }
}

const asOptionalString = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined
  const trimmed = String(value).trim()
  return trimmed || undefined
}

/** Upsert the primary Address row used for city/state (and mirrored zip). */
const upsertPrimaryAddress = async (
  profileId: string,
  fields: {
    address?: unknown
    city?: unknown
    state?: unknown
    zipCode?: unknown
  }
) => {
  const line1 = asOptionalString(fields.address)
  const city = asOptionalString(fields.city)
  const state = asOptionalString(fields.state)
  const zipCode = asOptionalString(fields.zipCode)

  if (!line1 && !city && !state && !zipCode) return

  const existing =
    (await prisma.address.findFirst({ where: { profileId, isPrimary: true } })) ||
    (await prisma.address.findFirst({ where: { profileId }, orderBy: { createdAt: 'asc' } }))

  const data = {
    line1: line1 ?? null,
    city: city ?? null,
    state: state ?? null,
    zipCode: zipCode ?? null,
    isPrimary: true,
  }

  if (existing) {
    await prisma.address.update({ where: { id: existing.id }, data })
  } else {
    await prisma.address.create({
      data: { profileId, ...data },
    })
  }
}

const create = async (
  userId: string,
  input: {
    name: string
    email?: string
    slug?: string
    companyName?: string
    designation?: string
    phone?: string
    whatsapp?: string
    website?: string
    address?: string
    about?: string
    prof?: string
    isPublic?: boolean
    template?: string
    facebook?: string
    instagram?: string
    twitter?: string
    tiktok?: string
    youtube?: string
    linkedin?: string
    settings?: Record<string, string>
    profileSettings?: {
      profileTemplate?: string
      layoutStyle?: string
      buttonStyle?: string
      cornerStyle?: string
      themeConfig?: unknown
    }
    [key: string]: unknown
  }
) => {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw new AppError(404, 'User not found')

  const { settings, profileSettings, city, state, ...raw } = input
  const zipCode = asOptionalString(raw.zipCode)
  const slug = await ensureUniqueSlug(String(raw.slug || raw.name))
  const profile = await prisma.profile.create({
    data: {
      userId,
      name: String(raw.name),
      email: (raw.email as string) || user.email,
      slug,
      companyName: raw.companyName as string | undefined,
      designation: raw.designation as string | undefined,
      phone: raw.phone as string | undefined,
      whatsapp: raw.whatsapp as string | undefined,
      website: raw.website as string | undefined,
      address: raw.address as string | undefined,
      zipCode,
      about: raw.about as string | undefined,
      prof: raw.prof as string | undefined,
      dob: raw.dob ? new Date(String(raw.dob)) : undefined,
      template: (raw.template as string) || 'default',
      isPublic: raw.isPublic !== false,
      facebook: raw.facebook as string | undefined,
      instagram: raw.instagram as string | undefined,
      twitter: raw.twitter as string | undefined,
      tiktok: raw.tiktok as string | undefined,
      youtube: raw.youtube as string | undefined,
      linkedin: raw.linkedin as string | undefined,
      profileSettings: {
        create: {
          profileTemplate:
            profileSettings?.profileTemplate ||
            (raw.template === 'dynamic' ? 'v1' : raw.template === 'classic' ? 'v2' : 'v3'),
          layoutStyle: profileSettings?.layoutStyle,
          buttonStyle: profileSettings?.buttonStyle,
          cornerStyle: profileSettings?.cornerStyle,
          themeConfig: profileSettings?.themeConfig as object | undefined,
        },
      },
    },
    include: profileInclude,
  })

  await upsertPrimaryAddress(profile.id, {
    address: raw.address,
    city,
    state,
    zipCode,
  })

  if (settings) {
    await Promise.all(
      Object.entries(settings).map(([key, value]) =>
        prisma.setting.create({
          data: { profileId: profile.id, key, value },
        })
      )
    )
  }

  return prisma.profile.findUniqueOrThrow({ where: { id: profile.id }, include: profileInclude })
}

const update = async (
  profileId: string,
  userId: string,
  role: string,
  data: {
    settings?: Record<string, string>
    profileSettings?: {
      profileTemplate?: string
      layoutStyle?: string
      buttonStyle?: string
      cornerStyle?: string
      themeConfig?: unknown
    }
    [key: string]: unknown
  }
) => {
  await getOwned(profileId, userId, role)
  // city/state belong on Address, not Profile scalars — strip before Prisma update
  const { settings, profileSettings, city, state, ...raw } = data
  const profileData = { ...raw } as Prisma.ProfileUpdateInput

  if ('dob' in raw) {
    const dobValue = raw.dob
    profileData.dob = dobValue === null || dobValue === undefined || dobValue === '' ? null : new Date(String(dobValue))
  }

  if (typeof profileData.slug === 'string') {
    profileData.slug = await ensureUniqueSlug(profileData.slug, profileId)
  }

  if ('zipCode' in raw) {
    profileData.zipCode = asOptionalString(raw.zipCode) ?? null
  }

  await prisma.profile.update({
    where: { id: profileId },
    data: profileData,
  })

  if ('address' in raw || 'city' in data || 'state' in data || 'zipCode' in raw) {
    await upsertPrimaryAddress(profileId, {
      address: raw.address,
      city,
      state,
      zipCode: raw.zipCode,
    })
  }

  if (settings) {
    await Promise.all(
      Object.entries(settings).map(([key, value]) =>
        prisma.setting.upsert({
          where: { profileId_key: { profileId, key } },
          create: { profileId, key, value },
          update: { value },
        })
      )
    )
  }

  if (profileSettings) {
    await prisma.profileSetting.upsert({
      where: { profileId },
      create: {
        profileId,
        profileTemplate: profileSettings.profileTemplate || 'v3',
        layoutStyle: profileSettings.layoutStyle,
        buttonStyle: profileSettings.buttonStyle,
        cornerStyle: profileSettings.cornerStyle,
        themeConfig: profileSettings.themeConfig as object | undefined,
      },
      update: {
        ...(profileSettings.profileTemplate ? { profileTemplate: profileSettings.profileTemplate } : {}),
        ...(profileSettings.layoutStyle !== undefined ? { layoutStyle: profileSettings.layoutStyle } : {}),
        ...(profileSettings.buttonStyle !== undefined ? { buttonStyle: profileSettings.buttonStyle } : {}),
        ...(profileSettings.cornerStyle !== undefined ? { cornerStyle: profileSettings.cornerStyle } : {}),
        ...(profileSettings.themeConfig !== undefined ? { themeConfig: profileSettings.themeConfig as object } : {}),
      },
    })
  }

  return prisma.profile.findUniqueOrThrow({ where: { id: profileId }, include: profileInclude })
}

const remove = async (profileId: string, userId: string, role: string) => {
  await getOwned(profileId, userId, role)
  await prisma.profile.delete({ where: { id: profileId } })
  return { id: profileId, deleted: true }
}

const COLLECTION_DELEGATE = {
  education: 'education',
  experiences: 'experience',
  services: 'service',
  portfolios: 'portfolio',
  skillTags: 'skillTag',
  socialLinks: 'socialLink',
  addresses: 'address',
} as const

type CollectionKind = keyof typeof COLLECTION_DELEGATE

const replaceCollection = async <T extends Record<string, unknown>>(
  profileId: string,
  userId: string,
  role: string,
  kind: CollectionKind,
  items: T[],
  mapItem: (item: T) => Record<string, unknown>
) => {
  await getOwned(profileId, userId, role)
  const delegate = COLLECTION_DELEGATE[kind]
  await prisma.$transaction(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = (tx as any)[delegate]
    if (!model?.deleteMany || !model?.create) {
      throw new AppError(500, `Unknown collection model: ${kind}`)
    }
    await model.deleteMany({ where: { profileId } })
    // Prefer per-row `create` over `createMany` so Prisma applies `@default(cuid())`
    // and `@updatedAt` (createMany skips those client-side defaults).
    for (let index = 0; index < items.length; index += 1) {
      await model.create({
        data: {
          profileId,
          sortOrder: index,
          ...mapItem(items[index]),
        },
      })
    }
  })
  return getOwned(profileId, userId, role)
}

const createPost = async (
  profileId: string,
  userId: string,
  role: string,
  input: {
    title?: string
    description?: string
    postTypeName?: string
    postTypeId?: string
    url?: string
    featuredImage?: string
    status?: string
    metas?: Record<string, string>
  }
) => {
  await getOwned(profileId, userId, role)
  let postTypeId = input.postTypeId
  if (!postTypeId && input.postTypeName) {
    const existing = await prisma.postType.findFirst({
      where: { name: { equals: input.postTypeName, mode: 'insensitive' } },
    })
    const pt =
      existing || (await prisma.postType.create({ data: { name: input.postTypeName, title: input.postTypeName } }))
    postTypeId = pt.id
  }

  const post = await prisma.post.create({
    data: {
      profileId,
      postTypeId,
      title: input.title,
      description: input.description,
      url: input.url,
      featuredImage: input.featuredImage,
      status: input.status ?? '1',
      createdById: userId,
      metas: input.metas
        ? {
            create: Object.entries(input.metas).map(([metaKey, metaValue]) => ({ metaKey, metaValue })),
          }
        : undefined,
    },
    include: { postType: true, metas: true, attachments: true },
  })
  return post
}

const updatePost = async (
  postId: string,
  userId: string,
  role: string,
  data: {
    title?: string
    description?: string
    url?: string
    featuredImage?: string
    status?: string
    sortOrder?: number
    metas?: Record<string, string>
  }
) => {
  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) throw new AppError(404, 'Post not found')
  await getOwned(post.profileId, userId, role)

  await prisma.post.update({
    where: { id: postId },
    data: {
      title: data.title,
      description: data.description,
      url: data.url,
      featuredImage: data.featuredImage,
      status: data.status,
      sortOrder: data.sortOrder,
      updatedById: userId,
    },
  })

  if (data.metas && typeof data.metas === 'object') {
    await Promise.all(
      Object.entries(data.metas).map(async ([metaKey, metaValue]) => {
        const existing = await prisma.postMeta.findFirst({ where: { postId, metaKey } })
        const value = metaValue == null ? '' : String(metaValue)
        if (existing) {
          await prisma.postMeta.update({ where: { id: existing.id }, data: { metaValue: value } })
        } else if (value) {
          await prisma.postMeta.create({ data: { postId, metaKey, metaValue: value } })
        }
      })
    )
  }

  return prisma.post.findUniqueOrThrow({
    where: { id: postId },
    include: { postType: true, metas: true, attachments: true },
  })
}

const deletePost = async (postId: string, userId: string, role: string) => {
  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) throw new AppError(404, 'Post not found')
  await getOwned(post.profileId, userId, role)
  await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date(), status: '0' } })
  return { id: postId, deleted: true }
}

const listPosts = async (profileId: string, userId: string, role: string, postTypeName?: string) => {
  await getOwned(profileId, userId, role)
  return prisma.post.findMany({
    where: {
      profileId,
      deletedAt: null,
      ...(postTypeName ? { postType: { name: { equals: postTypeName, mode: 'insensitive' } } } : {}),
    },
    include: { postType: true, metas: true, attachments: true },
    orderBy: { sortOrder: 'asc' },
  })
}

const emptyProfileIds = (profileIds: string[]) => profileIds.length === 0

const getDashboardStats = async (userId: string, role: string) => {
  const profiles = await listForUser(userId, role)
  const profileIds = profiles.map((p) => p.id)
  const now = new Date()
  const since = new Date(now.getTime() - DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const prevSince = new Date(since.getTime() - DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  if (emptyProfileIds(profileIds)) {
    return {
      cards: 0,
      totalViews: 0,
      viewsLast30Days: 0,
      contactsLast30Days: 0,
      notesLast30Days: 0,
      guestsLast30Days: 0,
      visitsChart: { total: 0, trendPercent: 0, points: buildDailyPoints(now, DASHBOARD_WINDOW_DAYS, new Map()) },
      socialChannels: SOCIAL_CHANNELS.map((channel) => ({
        channel,
        label: SOCIAL_CHANNEL_LABELS[channel],
        count: 0,
        trendPercent: 0,
      })),
      recentEngagement: [] as Array<{
        id: string
        event: string
        viewer: string
        time: string
        platform: string
        createdAt: string
      }>,
      profiles: [],
    }
  }

  const [contacts, notes, guests, viewEvents, prevViewEvents, socialEvents, prevSocialEvents, recentLogs] =
    await Promise.all([
      prisma.contact.count({ where: { profileId: { in: profileIds }, createdAt: { gte: since } } }),
      prisma.userNote.count({ where: { profileId: { in: profileIds }, createdAt: { gte: since } } }),
      prisma.guestUserData.count({ where: { profileId: { in: profileIds }, createdAt: { gte: since } } }),
      prisma.eventLog.findMany({
        where: { profileId: { in: profileIds }, eventType: 'profile_view', createdAt: { gte: since } },
        select: { createdAt: true, payload: true },
      }),
      prisma.eventLog.findMany({
        where: {
          profileId: { in: profileIds },
          eventType: 'profile_view',
          createdAt: { gte: prevSince, lt: since },
        },
        select: { payload: true },
      }),
      prisma.eventLog.findMany({
        where: { profileId: { in: profileIds }, eventType: 'social_click', createdAt: { gte: since } },
        select: { payload: true },
      }),
      prisma.eventLog.findMany({
        where: {
          profileId: { in: profileIds },
          eventType: 'social_click',
          createdAt: { gte: prevSince, lt: since },
        },
        select: { payload: true },
      }),
      prisma.eventLog.findMany({
        where: { profileId: { in: profileIds } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_ENGAGEMENT_LIMIT,
        select: { id: true, eventType: true, payload: true, userAgent: true, createdAt: true },
      }),
    ])

  const views = countDistinctGuests(viewEvents)
  const prevViews = countDistinctGuests(prevViewEvents)
  const countsByDay = countDistinctGuestsByDay(viewEvents)
  const visitsPoints = buildDailyPoints(now, DASHBOARD_WINDOW_DAYS, countsByDay)

  const currentSocial = countDistinctGuestsByChannel(socialEvents)
  const prevSocial = countDistinctGuestsByChannel(prevSocialEvents)

  const totalViews = profiles.reduce((sum, p) => sum + p.viewCount, 0)

  return {
    cards: profiles.length,
    totalViews,
    viewsLast30Days: views,
    contactsLast30Days: contacts,
    notesLast30Days: notes,
    guestsLast30Days: guests,
    visitsChart: {
      total: views,
      trendPercent: trendPercent(views, prevViews),
      points: visitsPoints,
    },
    socialChannels: SOCIAL_CHANNELS.map((channel) => ({
      channel,
      label: SOCIAL_CHANNEL_LABELS[channel],
      count: currentSocial.get(channel) || 0,
      trendPercent: trendPercent(currentSocial.get(channel) || 0, prevSocial.get(channel) || 0),
    })),
    recentEngagement: recentLogs.map((row) => {
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : null
      return {
        id: row.id,
        event: eventTypeLabel(row.eventType, payload),
        viewer: viewerFromPayload(row.eventType, payload),
        time: formatRelativeTime(row.createdAt, now),
        platform: parsePlatformFromUa(row.userAgent),
        createdAt: row.createdAt.toISOString(),
      }
    }),
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      viewCount: p.viewCount,
      services: p._count.services,
      portfolios: p._count.portfolios,
      posts: p._count.posts,
    })),
  }
}

const listContacts = async (userId: string, role: string, profileId?: string) => {
  const profiles = await listForUser(userId, role)
  const ids = profileId ? [profileId] : profiles.map((p) => p.id)
  if (profileId) await getOwned(profileId, userId, role)
  return prisma.contact.findMany({
    where: { profileId: { in: ids } },
    orderBy: { createdAt: 'desc' },
    include: { profile: { select: { id: true, name: true, slug: true } } },
  })
}

type RecentEngagementQuery = {
  skip?: number
  limit?: number
  profileId?: string
  eventType?: string
  from?: Date
  to?: Date
}

const listRecentEngagement = async (userId: string, role: string, query: RecentEngagementQuery = {}) => {
  const skip = Math.max(0, Number(query.skip) || 0)
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 10))

  if (query.profileId) {
    await getOwned(query.profileId, userId, role)
  }

  const profiles = await listForUser(userId, role)
  const profileIds = query.profileId ? [query.profileId] : profiles.map((p) => p.id)

  if (emptyProfileIds(profileIds)) {
    return { items: [], total: 0, skip, limit }
  }

  const where: Prisma.EventLogWhereInput = {
    profileId: { in: profileIds },
    ...(query.eventType ? { eventType: query.eventType } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
  }

  const now = new Date()
  const [total, rows] = await Promise.all([
    prisma.eventLog.count({ where }),
    prisma.eventLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: { id: true, eventType: true, payload: true, userAgent: true, createdAt: true },
    }),
  ])

  const items = rows.map((row) => {
    const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : null
    return {
      id: row.id,
      event: eventTypeLabel(row.eventType, payload),
      viewer: viewerFromPayload(row.eventType, payload),
      time: formatRelativeTime(row.createdAt, now),
      platform: parsePlatformFromUa(row.userAgent),
      createdAt: row.createdAt.toISOString(),
    }
  })

  return { items, total, skip, limit }
}

const listPackages = async () => {
  return prisma.package.findMany({
    where: { isActive: true },
    include: { features: true },
    orderBy: { sortOrder: 'asc' },
  })
}

const listSubscriptions = async (userId: string, role: string) => {
  const where = role === 'admin' ? {} : { userId }
  return prisma.subscription.findMany({
    where,
    include: { package: { include: { features: true } }, items: true, transactions: true },
    orderBy: { createdAt: 'desc' },
  })
}

const profileService = {
  listForUser,
  getOwned,
  create,
  update,
  remove,
  replaceCollection,
  createPost,
  updatePost,
  deletePost,
  listPosts,
  getDashboardStats,
  listRecentEngagement,
  listContacts,
  listPackages,
  listSubscriptions,
  ensureUniqueSlug,
  checkSlugAvailability,
}

export default profileService
