import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { slugify } from '../middlewares/ownership'
import {
  DASHBOARD_ALL_CHART_DAYS,
  SOCIAL_CHANNELS,
  SOCIAL_CHANNEL_LABELS,
  buildDailyPoints,
  countDistinctGuests,
  countDistinctGuestsByChannel,
  countDistinctGuestsByDay,
  dayKey,
  eventTypeLabel,
  formatRelativeTime,
  parsePlatformFromUa,
  resolveDashboardWindowDays,
  trendPercent,
  viewerFromPayload,
  type DashboardPeriod,
  type SocialChannel,
} from '../utils/dashboardAnalytics'
import liveClicksHub, { type LiveSocialClickRow } from '../utils/liveClicksHub'
import { ensureAbsoluteMediaUrl } from '../utils/mediaUrl'
import { prisma } from '../utils/prisma'
import pushService from './push.service'

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
  reviews: { orderBy: { sortOrder: 'asc' as const } },
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

/** Upsert the primary Address row used for street address (line1). */
const upsertPrimaryAddress = async (
  profileId: string,
  fields: {
    address?: unknown
  }
) => {
  const line1 = asOptionalString(fields.address)

  if (!line1) return

  const existing =
    (await prisma.address.findFirst({ where: { profileId, isPrimary: true } })) ||
    (await prisma.address.findFirst({ where: { profileId }, orderBy: { createdAt: 'asc' } }))

  const data = {
    line1: line1 ?? null,
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

  const { settings, profileSettings, city: _city, state: _state, zipCode: _zipCode, ...raw } = input
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
  // Strip non-Profile scalars / removed address fields before Prisma update
  const { settings, profileSettings, city: _city, state: _state, zipCode: _zipCode, ...raw } = data
  const profileData = { ...raw } as Prisma.ProfileUpdateInput

  if ('dob' in raw) {
    const dobValue = raw.dob
    profileData.dob = dobValue === null || dobValue === undefined || dobValue === '' ? null : new Date(String(dobValue))
  }

  if (typeof profileData.slug === 'string') {
    profileData.slug = await ensureUniqueSlug(profileData.slug, profileId)
  }

  await prisma.profile.update({
    where: { id: profileId },
    data: profileData,
  })

  if ('address' in raw) {
    await upsertPrimaryAddress(profileId, {
      address: raw.address,
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

  const updated = await prisma.profile.findUniqueOrThrow({ where: { id: profileId }, include: profileInclude })

  const themeTouched = Boolean(
    profileSettings &&
    (profileSettings.profileTemplate !== undefined ||
      profileSettings.layoutStyle !== undefined ||
      profileSettings.buttonStyle !== undefined ||
      profileSettings.cornerStyle !== undefined ||
      profileSettings.themeConfig !== undefined ||
      'colorCode' in raw ||
      'template' in raw ||
      'themeConfig' in raw)
  )
  const contactKeys = [
    'email',
    'phone',
    'whatsapp',
    'website',
    'facebook',
    'instagram',
    'twitter',
    'tiktok',
    'youtube',
    'rumble',
    'truth',
    'linkedin',
    'pinterest',
    'address',
    'countryCode',
  ]
  const contactTouched = contactKeys.some((key) => key in raw)

  if (themeTouched) {
    pushService.notifyProfileUpdate(profileId, {
      type: 'theme_updates',
      title: 'Theme updated',
      body: `${updated.companyName || updated.name} updated their card design.`,
    })
  } else if (contactTouched) {
    pushService.notifyProfileUpdate(profileId, {
      type: 'contact_updates',
      title: 'Contact info updated',
      body: `${updated.companyName || updated.name} updated their contact info.`,
    })
  } else {
    pushService.notifyProfileUpdate(profileId, {
      type: 'business_hours',
      title: 'Profile updated',
      body: `${updated.companyName || updated.name} updated their profile.`,
    })
  }

  return updated
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
  reviews: 'review',
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
  const owned = await getOwned(profileId, userId, role)
  const preferenceType = pushService.preferenceKeyForCollection(kind)
  if (preferenceType) {
    const titles: Record<string, { title: string; action: string }> = {
      service_updates: { title: 'Services updated', action: 'updated their services' },
      portfolio_updates: { title: 'Portfolio updated', action: 'added new photos or videos' },
      contact_updates: { title: 'Contact links updated', action: 'updated their contact links' },
      business_hours: { title: 'Professional info updated', action: 'updated their professional info' },
    }
    const copy = titles[preferenceType] || { title: 'Card updated', action: 'has a new update' }
    const businessName = owned.companyName || owned.name
    pushService.notifyProfileUpdate(profileId, {
      type: preferenceType,
      title: copy.title,
      body: `${businessName} ${copy.action}.`,
    })
  }
  return owned
}

type PostDocumentInput = {
  url: string
  name?: string
  type?: string
}

const extensionFromDoc = (doc: PostDocumentInput) => {
  const fromName = doc.name?.includes('.') ? doc.name.split('.').pop() : undefined
  if (fromName) return fromName.toLowerCase()
  if (doc.type?.includes('/')) return doc.type.split('/')[1]?.toLowerCase()
  try {
    const pathname = new URL(doc.url).pathname
    const ext = pathname.includes('.') ? pathname.split('.').pop() : undefined
    return ext?.toLowerCase()
  } catch {
    return undefined
  }
}

const syncPostDocuments = async (postId: string, profileId: string, documents: PostDocumentInput[]) => {
  await prisma.attachment.deleteMany({ where: { postId } })
  const valid = documents.filter((d) => typeof d?.url === 'string' && d.url.trim())
  if (!valid.length) return
  await prisma.attachment.createMany({
    data: valid.map((doc) => ({
      attachableType: 'Post',
      attachableId: postId,
      postId,
      profileId,
      docName: doc.name?.trim() || 'document',
      url: doc.url.trim(),
      mimeType: doc.type || undefined,
      extension: extensionFromDoc(doc),
    })),
  })
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
    documents?: PostDocumentInput[]
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

  const primaryDocUrl = input.documents?.find((d) => d?.url?.trim())?.url?.trim()
  const featuredImage = input.featuredImage?.trim() || primaryDocUrl || undefined

  const post = await prisma.post.create({
    data: {
      profileId,
      postTypeId,
      title: input.title,
      description: input.description,
      url: input.url,
      featuredImage,
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

  if (Array.isArray(input.documents)) {
    await syncPostDocuments(post.id, profileId, input.documents)
  }

  const created = await prisma.post.findUniqueOrThrow({
    where: { id: post.id },
    include: { postType: true, metas: true, attachments: true },
  })

  const preferenceType = pushService.preferenceKeyForPostType(created.postType?.name || input.postTypeName)
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { name: true, companyName: true },
  })
  const businessName = profile?.companyName || profile?.name || 'vBiz Me'
  pushService.notifyProfileUpdate(profileId, {
    type: preferenceType,
    title: created.title?.trim() || 'New post',
    body: `${businessName} published a new update.`,
  })

  return created
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
    documents?: PostDocumentInput[]
  }
) => {
  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) throw new AppError(404, 'Post not found')
  await getOwned(post.profileId, userId, role)

  const primaryDocUrl = Array.isArray(data.documents)
    ? data.documents.find((d) => d?.url?.trim())?.url?.trim()
    : undefined
  const featuredImage =
    data.featuredImage !== undefined ? data.featuredImage : primaryDocUrl !== undefined ? primaryDocUrl : undefined

  await prisma.post.update({
    where: { id: postId },
    data: {
      title: data.title,
      description: data.description,
      url: data.url,
      featuredImage,
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

  if (Array.isArray(data.documents)) {
    await syncPostDocuments(postId, post.profileId, data.documents)
  }

  const updatedPost = await prisma.post.findUniqueOrThrow({
    where: { id: postId },
    include: { postType: true, metas: true, attachments: true },
  })

  const preferenceType = pushService.preferenceKeyForPostType(updatedPost.postType?.name)
  const profile = await prisma.profile.findUnique({
    where: { id: post.profileId },
    select: { name: true, companyName: true },
  })
  const businessName = profile?.companyName || profile?.name || 'vBiz Me'
  pushService.notifyProfileUpdate(post.profileId, {
    type: preferenceType,
    title: updatedPost.title?.trim() || 'Post updated',
    body: `${businessName} updated a post.`,
  })

  return updatedPost
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

const getDashboardStats = async (userId: string, role: string, period: DashboardPeriod = 'all') => {
  const profiles = await listForUser(userId, role)
  const profileIds = profiles.map((p) => p.id)
  const now = new Date()
  const windowDays = resolveDashboardWindowDays(period)
  const chartDays = windowDays ?? DASHBOARD_ALL_CHART_DAYS
  const since = windowDays != null ? new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000) : null
  const prevSince = since && windowDays != null ? new Date(since.getTime() - windowDays * 24 * 60 * 60 * 1000) : null
  const createdAtFilter = since ? { createdAt: { gte: since } } : {}

  if (emptyProfileIds(profileIds)) {
    return {
      cards: 0,
      totalViews: 0,
      viewsLast30Days: 0,
      contactsLast30Days: 0,
      notesLast30Days: 0,
      guestsLast30Days: 0,
      uniqueViews: 0,
      shares: 0,
      period,
      visitsChart: { total: 0, trendPercent: 0, points: buildDailyPoints(now, chartDays, new Map()) },
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
      prisma.contact.count({ where: { profileId: { in: profileIds }, ...createdAtFilter } }),
      prisma.userNote.count({ where: { profileId: { in: profileIds }, ...createdAtFilter } }),
      prisma.guestUserData.count({ where: { profileId: { in: profileIds }, ...createdAtFilter } }),
      prisma.eventLog.findMany({
        where: { profileId: { in: profileIds }, eventType: 'profile_view', ...createdAtFilter },
        select: { createdAt: true, payload: true },
      }),
      prevSince && since
        ? prisma.eventLog.findMany({
            where: {
              profileId: { in: profileIds },
              eventType: 'profile_view',
              createdAt: { gte: prevSince, lt: since },
            },
            select: { payload: true },
          })
        : Promise.resolve([] as Array<{ payload: unknown }>),
      prisma.eventLog.findMany({
        where: { profileId: { in: profileIds }, eventType: 'social_click', ...createdAtFilter },
        select: { payload: true },
      }),
      prevSince && since
        ? prisma.eventLog.findMany({
            where: {
              profileId: { in: profileIds },
              eventType: 'social_click',
              createdAt: { gte: prevSince, lt: since },
            },
            select: { payload: true },
          })
        : Promise.resolve([] as Array<{ payload: unknown }>),
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
  const visitsPoints = buildDailyPoints(now, chartDays, countsByDay)

  const currentSocial = countDistinctGuestsByChannel(socialEvents)
  const prevSocial = countDistinctGuestsByChannel(prevSocialEvents)
  const shares = SOCIAL_CHANNELS.reduce((sum, channel) => sum + (currentSocial.get(channel) || 0), 0)

  const totalViews = profiles.reduce((sum, p) => sum + p.viewCount, 0)

  return {
    cards: profiles.length,
    totalViews,
    viewsLast30Days: views,
    contactsLast30Days: contacts,
    notesLast30Days: notes,
    guestsLast30Days: guests,
    uniqueViews: views,
    shares,
    period,
    visitsChart: {
      total: views,
      trendPercent: since ? trendPercent(views, prevViews) : 0,
      points: visitsPoints,
    },
    socialChannels: SOCIAL_CHANNELS.map((channel) => ({
      channel,
      label: SOCIAL_CHANNEL_LABELS[channel],
      count: currentSocial.get(channel) || 0,
      trendPercent: since ? trendPercent(currentSocial.get(channel) || 0, prevSocial.get(channel) || 0) : 0,
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

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const WEEKDAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** All-time social click counts for channels with at least one click. */
const getLiveSocialClicks = async (userId: string, role: string): Promise<LiveSocialClickRow[]> => {
  const profiles = await listForUser(userId, role)
  const profileIds = profiles.map((p) => p.id)
  if (emptyProfileIds(profileIds)) return []

  const socialEvents = await prisma.eventLog.findMany({
    where: { profileId: { in: profileIds }, eventType: 'social_click' },
    select: { payload: true },
  })
  const counts = countDistinctGuestsByChannel(socialEvents)
  const rows: LiveSocialClickRow[] = []
  for (const channel of SOCIAL_CHANNELS) {
    const clickCount = counts.get(channel) || 0
    if (clickCount <= 0) continue
    rows.push({
      channel,
      label: SOCIAL_CHANNEL_LABELS[channel],
      clickCount,
    })
  }
  rows.sort((a, b) => b.clickCount - a.clickCount)
  return rows
}

/** After a newly counted social_click, push refreshed totals to profile owners listening on SSE. */
const notifyLiveSocialClicks = async (profileId: string) => {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { userId: true, companyUserId: true },
  })
  if (!profile) return

  const ownerIds = Array.from(
    new Set([profile.userId, profile.companyUserId].filter((id): id is string => Boolean(id)))
  )

  await Promise.all(
    ownerIds.map(async (ownerId) => {
      const clicks = await getLiveSocialClicks(ownerId, 'vcard-owner')
      liveClicksHub.publishClickUpdate(ownerId, clicks)
    })
  )
}

/** Current UTC calendar week Mon–Sun: views / social clicks / CTR. */
const getWeeklyEngagement = async (userId: string, role: string) => {
  const profiles = await listForUser(userId, role)
  const profileIds = profiles.map((p) => p.id)
  const profileName = profiles[0]?.name || 'Your card'

  const now = new Date()
  const utcDay = now.getUTCDay() // 0 Sun … 6 Sat
  const daysFromMonday = utcDay === 0 ? 6 : utcDay - 1
  const mondayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday)
  const weekStart = new Date(mondayUtc)
  const weekEnd = new Date(mondayUtc + 7 * 24 * 60 * 60 * 1000)

  const emptyDays = () => {
    const days = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(mondayUtc + i * 24 * 60 * 60 * 1000)
      const wd = d.getUTCDay()
      days.push({
        day: WEEKDAY_SHORT[wd],
        fullDay: WEEKDAY_FULL[wd],
        views: 0,
        clicks: 0,
        ctr: 0,
      })
    }
    return {
      days,
      totals: { views: 0, clicks: 0, avgCtr: 0 },
      profileName,
    }
  }

  if (emptyProfileIds(profileIds)) return emptyDays()

  const [viewEvents, clickEvents] = await Promise.all([
    prisma.eventLog.findMany({
      where: {
        profileId: { in: profileIds },
        eventType: 'profile_view',
        createdAt: { gte: weekStart, lt: weekEnd },
      },
      select: { createdAt: true, payload: true },
    }),
    prisma.eventLog.findMany({
      where: {
        profileId: { in: profileIds },
        eventType: 'social_click',
        createdAt: { gte: weekStart, lt: weekEnd },
      },
      select: { createdAt: true, payload: true },
    }),
  ])

  const viewsByDay = countDistinctGuestsByDay(viewEvents)
  const clicksByDay = countDistinctGuestsByDay(clickEvents)

  const days: Array<{ day: string; fullDay: string; views: number; clicks: number; ctr: number }> = []
  let viewsSum = 0
  let clicksSum = 0

  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayUtc + i * 24 * 60 * 60 * 1000)
    const key = dayKey(d)
    const wd = d.getUTCDay()
    const views = viewsByDay.get(key) || 0
    const clicks = clicksByDay.get(key) || 0
    const ctr = views > 0 ? parseFloat(((clicks / views) * 100).toFixed(1)) : 0
    viewsSum += views
    clicksSum += clicks
    days.push({
      day: WEEKDAY_SHORT[wd],
      fullDay: WEEKDAY_FULL[wd],
      views,
      clicks,
      ctr,
    })
  }

  const avgCtr = viewsSum > 0 ? parseFloat(((clicksSum / viewsSum) * 100).toFixed(1)) : 0

  return {
    days,
    totals: { views: viewsSum, clicks: clicksSum, avgCtr },
    profileName,
  }
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
  getLiveSocialClicks,
  notifyLiveSocialClicks,
  getWeeklyEngagement,
  listRecentEngagement,
  listContacts,
  listPackages,
  listSubscriptions,
  ensureUniqueSlug,
  checkSlugAvailability,
}

export default profileService

export type { LiveSocialClickRow, SocialChannel }
