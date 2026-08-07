import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { slugify } from '../middlewares/ownership'
import { prisma } from '../utils/prisma'

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

const listForUser = async (userId: string, role: string) => {
  const where =
    role === 'admin'
      ? {}
      : {
          OR: [{ userId }, { companyUserId: userId }],
        }
  return prisma.profile.findMany({
    where,
    include: {
      profession: true,
      profileSettings: true,
      _count: { select: { services: true, portfolios: true, posts: true } },
    },
    orderBy: { updatedAt: 'desc' },
  })
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

  const { settings, profileSettings, ...raw } = input
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
  const { settings, profileSettings, ...raw } = data
  const profileData = { ...raw } as Prisma.ProfileUpdateInput

  if (typeof profileData.slug === 'string') {
    profileData.slug = await ensureUniqueSlug(profileData.slug, profileId)
  }

  await prisma.profile.update({
    where: { id: profileId },
    data: profileData,
  })

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

const replaceCollection = async <T extends { id?: string }>(
  profileId: string,
  userId: string,
  role: string,
  kind: 'education' | 'experiences' | 'services' | 'portfolios' | 'skillTags' | 'socialLinks' | 'addresses',
  items: T[],
  mapItem: (item: T) => Record<string, unknown>
) => {
  await getOwned(profileId, userId, role)
  await prisma.$transaction(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any)[kind].deleteMany({ where: { profileId } })
    if (items.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any)[kind].createMany({
        data: items.map((item, index) => ({
          profileId,
          sortOrder: index,
          ...mapItem(item),
        })),
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
  }
) => {
  const post = await prisma.post.findUnique({ where: { id: postId } })
  if (!post) throw new AppError(404, 'Post not found')
  await getOwned(post.profileId, userId, role)
  return prisma.post.update({
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

const getDashboardStats = async (userId: string, role: string) => {
  const profiles = await listForUser(userId, role)
  const profileIds = profiles.map((p) => p.id)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [views, contacts, notes, guests] = await Promise.all([
    prisma.eventLog.count({
      where: { profileId: { in: profileIds }, eventType: 'profile_view', createdAt: { gte: since } },
    }),
    prisma.contact.count({ where: { profileId: { in: profileIds }, createdAt: { gte: since } } }),
    prisma.userNote.count({ where: { profileId: { in: profileIds }, createdAt: { gte: since } } }),
    prisma.guestUserData.count({ where: { profileId: { in: profileIds }, createdAt: { gte: since } } }),
  ])

  const totalViews = profiles.reduce((sum, p) => sum + p.viewCount, 0)

  return {
    cards: profiles.length,
    totalViews,
    viewsLast30Days: views,
    contactsLast30Days: contacts,
    notesLast30Days: notes,
    guestsLast30Days: guests,
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
  listContacts,
  listPackages,
  listSubscriptions,
  ensureUniqueSlug,
}

export default profileService
