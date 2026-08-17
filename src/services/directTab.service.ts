import type { Prisma } from '../../generated/prisma/client'
import { isListSectionStorage, isSingletonSectionStorage, LIST_SECTION_MODELS } from '../constants/directSectionStorage'
import { getTabByKey, TAB_REGISTRY, type TabRegistryEntry } from '../constants/tabRegistry'
import AppError from '../error/AppError'
import { prisma } from '../utils/prisma'
import profileService from './profile.service'

type BlogInput = {
  title?: string | null
  description?: string | null
  category?: string | null
  date?: string | null
  url?: string | null
  featuredImage?: string | null
  status?: string | null
  sortOrder?: number | null
}

type TabItemInput = {
  title?: string | null
  description?: string | null
  url?: string | null
  featuredImage?: string | null
  status?: string | null
  sortOrder?: number | null
  metas?: Record<string, unknown> | null
}

const serializeBlog = (row: {
  id: string
  profileId: string
  title: string | null
  description: string | null
  category: string | null
  date: string | null
  url: string | null
  featuredImage: string | null
  status: string
  sortOrder: number
  legacyPostId: number | null
  createdAt: Date
  updatedAt: Date
}) => ({
  id: row.id,
  profileId: row.profileId,
  title: row.title,
  description: row.description,
  category: row.category,
  date: row.date,
  url: row.url,
  featuredImage: row.featuredImage,
  status: row.status,
  sortOrder: row.sortOrder,
  legacyPostId: row.legacyPostId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  metas: {
    ...(row.category ? { category: row.category } : {}),
    ...(row.date ? { date: row.date } : {}),
  },
  postType: { name: 'blog', title: 'blog' },
})

const serializeTabItem = (row: {
  id: string
  profileId: string
  tabKey: string
  title: string | null
  description: string | null
  url: string | null
  featuredImage: string | null
  status: string
  sortOrder: number
  metas: unknown
  legacyPostId: number | null
  legacyPostTypeId: number | null
  createdAt: Date
  updatedAt: Date
}) => {
  const tab = getTabByKey(row.tabKey)
  const metas =
    row.metas && typeof row.metas === 'object' && !Array.isArray(row.metas)
      ? (row.metas as Record<string, unknown>)
      : {}
  return {
    id: row.id,
    profileId: row.profileId,
    tabKey: row.tabKey,
    title: row.title,
    description: row.description,
    url: row.url,
    featuredImage: row.featuredImage,
    status: row.status,
    sortOrder: row.sortOrder,
    metas,
    legacyPostId: row.legacyPostId,
    legacyPostTypeId: row.legacyPostTypeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    postType: {
      name: tab?.publicSectionName || row.tabKey,
      title: tab?.label || row.tabKey,
    },
  }
}

const assertDirectListTab = (tabKey: string): TabRegistryEntry => {
  const tab = getTabByKey(tabKey)
  if (!tab) throw new AppError(404, `Unknown tab: ${tabKey}`)
  return tab
}

const str = (v: unknown) => (v == null ? null : String(v))
const statusOf = (v: unknown, fallback = '1') => {
  const s = str(v)?.trim()
  return s || fallback
}

/** ——— Blogs ——— */

const listBlogs = async (profileId: string, userId: string, role: string, limit?: number) => {
  await profileService.getOwned(profileId, userId, role)
  const rows = await prisma.blog.findMany({
    where: { profileId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    ...(limit ? { take: Math.min(200, Math.max(1, limit)) } : {}),
  })
  return rows.map(serializeBlog)
}

const createBlog = async (profileId: string, userId: string, role: string, input: BlogInput) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  const max = await prisma.blog.aggregate({
    where: { profileId, deletedAt: null },
    _max: { sortOrder: true },
  })
  const row = await prisma.blog.create({
    data: {
      profileId,
      title: str(input.title),
      description: str(input.description),
      category: str(input.category),
      date: str(input.date),
      url: str(input.url),
      featuredImage: str(input.featuredImage),
      status: statusOf(input.status),
      sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : (max._max.sortOrder ?? -1) + 1,
    },
  })
  return serializeBlog(row)
}

const updateBlog = async (profileId: string, blogId: string, userId: string, role: string, input: BlogInput) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  const existing = await prisma.blog.findFirst({ where: { id: blogId, profileId, deletedAt: null } })
  if (!existing) throw new AppError(404, 'Blog not found')
  const row = await prisma.blog.update({
    where: { id: blogId },
    data: {
      ...(input.title !== undefined ? { title: str(input.title) } : {}),
      ...(input.description !== undefined ? { description: str(input.description) } : {}),
      ...(input.category !== undefined ? { category: str(input.category) } : {}),
      ...(input.date !== undefined ? { date: str(input.date) } : {}),
      ...(input.url !== undefined ? { url: str(input.url) } : {}),
      ...(input.featuredImage !== undefined ? { featuredImage: str(input.featuredImage) } : {}),
      ...(input.status !== undefined ? { status: statusOf(input.status, existing.status) } : {}),
      ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
    },
  })
  return serializeBlog(row)
}

const deleteBlog = async (profileId: string, blogId: string, userId: string, role: string) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  const existing = await prisma.blog.findFirst({ where: { id: blogId, profileId, deletedAt: null } })
  if (!existing) throw new AppError(404, 'Blog not found')
  await prisma.blog.update({
    where: { id: blogId },
    data: { deletedAt: new Date(), status: '0' },
  })
  return { deleted: true as const }
}

/** ——— Dedicated tab storage with the legacy editor response contract ——— */

type DirectRow = {
  id: string
  profileId: string
  title?: string | null
  description?: string | null
  url?: string | null
  featuredImage?: string | null
  featuredMediaUrl?: string | null
  imageUrl?: string | null
  reviewUrl?: string | null
  author?: string | null
  text?: string | null
  rating?: number
  status: string | number
  sortOrder?: number
  metas?: unknown
  attachmentUrl?: string | null
  attachmentName?: string | null
  legacyPostId?: number | null
  createdAt: Date
  updatedAt: Date
}

const serializeDedicatedRow = (tab: TabRegistryEntry, row: DirectRow) => {
  const metas =
    row.metas && typeof row.metas === 'object' && !Array.isArray(row.metas)
      ? { ...(row.metas as Record<string, unknown>) }
      : {}
  if (row.attachmentUrl) metas.attachmentUrl = row.attachmentUrl
  if (row.attachmentName) metas.attachmentName = row.attachmentName
  if (row.rating != null) metas.rating = row.rating
  return serializeTabItem({
    id: row.id,
    profileId: row.profileId,
    tabKey: tab.key,
    title: row.title ?? row.author ?? null,
    description: row.description ?? row.text ?? null,
    url: row.url ?? row.reviewUrl ?? null,
    featuredImage: row.featuredImage ?? row.featuredMediaUrl ?? row.imageUrl ?? null,
    status: String(row.status),
    sortOrder: row.sortOrder ?? 0,
    metas,
    legacyPostId: row.legacyPostId ?? null,
    legacyPostTypeId: tab.legacyPostTypeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

// Prisma delegate methods are structurally incompatible across models although these direct-list
// tables deliberately share the same columns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const listModel = (tab: TabRegistryEntry): any => {
  if (!isListSectionStorage(tab.storage)) throw new AppError(400, `${tab.label} is not list storage`)
  return LIST_SECTION_MODELS[tab.storage]
}

const galleryData = (input: TabItemInput) => {
  const metas = input.metas || {}
  const attachments =
    metas.attachments && typeof metas.attachments === 'object' && !Array.isArray(metas.attachments)
      ? (metas.attachments as Record<string, unknown>)
      : {}
  return {
    title: str(input.title),
    description: str(input.description),
    url: str(input.url),
    featuredImage: str(input.featuredImage),
    status: statusOf(input.status),
    ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
    metas: input.metas != null ? (input.metas as Prisma.InputJsonValue) : undefined,
    attachmentUrl: str(metas.attachmentUrl ?? attachments.url),
    attachmentName: str(metas.attachmentName ?? attachments.name),
  }
}

const genericData = (input: TabItemInput) => ({
  title: str(input.title),
  description: str(input.description),
  url: str(input.url),
  featuredImage: str(input.featuredImage),
  status: statusOf(input.status),
  ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
  metas: input.metas != null ? (input.metas as Prisma.InputJsonValue) : undefined,
})

const genericUpdateData = (input: TabItemInput) => ({
  ...(input.title !== undefined ? { title: str(input.title) } : {}),
  ...(input.description !== undefined ? { description: str(input.description) } : {}),
  ...(input.url !== undefined ? { url: str(input.url) } : {}),
  ...(input.featuredImage !== undefined ? { featuredImage: str(input.featuredImage) } : {}),
  ...(input.status !== undefined ? { status: statusOf(input.status) } : {}),
  ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
  ...(input.metas !== undefined
    ? { metas: input.metas == null ? undefined : (input.metas as Prisma.InputJsonValue) }
    : {}),
})

const galleryUpdateData = (input: TabItemInput) => ({
  ...genericUpdateData(input),
  ...(input.metas?.attachmentUrl !== undefined ||
  (input.metas?.attachments && typeof input.metas.attachments === 'object')
    ? {
        attachmentUrl: str(
          input.metas?.attachmentUrl ?? (input.metas?.attachments as Record<string, unknown> | undefined)?.url
        ),
      }
    : {}),
  ...(input.metas?.attachmentName !== undefined ||
  (input.metas?.attachments && typeof input.metas.attachments === 'object')
    ? {
        attachmentName: str(
          input.metas?.attachmentName ?? (input.metas?.attachments as Record<string, unknown> | undefined)?.name
        ),
      }
    : {}),
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const singletonModel = (storage: 'mission_statement' | 'why_choose_us'): any =>
  storage === 'mission_statement' ? prisma.missionStatement : prisma.whyChooseUs

const listTabItems = async (profileId: string, tabKey: string, userId: string, role: string, limit?: number) => {
  const tab = assertDirectListTab(tabKey)
  await profileService.getOwned(profileId, userId, role)
  if (tab.storage === 'blog') return listBlogs(profileId, userId, role, limit)
  const take = limit ? Math.min(200, Math.max(1, limit)) : undefined
  let rows: DirectRow[]
  if (isListSectionStorage(tab.storage)) {
    rows = await listModel(tab).findMany({
      where: { profileId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take,
    })
  } else if (tab.storage === 'gallery') {
    rows = await prisma.gallery.findMany({
      where: { profileId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take,
    })
  } else if (tab.storage === 'service') {
    rows = await prisma.service.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' }, take })
  } else if (tab.storage === 'review') {
    rows = await prisma.review.findMany({ where: { profileId }, orderBy: { sortOrder: 'asc' }, take })
  } else if (tab.storage === 'about_me') {
    const row = await prisma.aboutMe.findUnique({ where: { profileId } })
    rows = row ? [row] : []
  } else if (isSingletonSectionStorage(tab.storage)) {
    const row = await singletonModel(tab.storage).findUnique({ where: { profileId } })
    rows = row ? [row] : []
  } else {
    rows = []
  }
  return rows.map((row) => serializeDedicatedRow(tab, row))
}

const createTabItem = async (profileId: string, tabKey: string, userId: string, role: string, input: TabItemInput) => {
  const tab = assertDirectListTab(tabKey)
  await profileService.getOwnedForWrite(profileId, userId, role)
  if (tab.storage === 'blog') return createBlog(profileId, userId, role, input)
  if (tab.storage === 'about_me' || isSingletonSectionStorage(tab.storage)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model: any = tab.storage === 'about_me' ? prisma.aboutMe : singletonModel(tab.storage)
    const row = await model.upsert({
      where: { profileId },
      create: {
        profileId,
        title: str(input.title) || tab.label,
        description: str(input.description),
        featuredMediaUrl: str(input.featuredImage),
        status: statusOf(input.status),
      },
      update: {
        title: str(input.title) || tab.label,
        description: str(input.description),
        featuredMediaUrl: str(input.featuredImage),
        status: statusOf(input.status),
      },
    })
    return serializeDedicatedRow(tab, row)
  }
  const model =
    tab.storage === 'gallery'
      ? prisma.gallery
      : tab.storage === 'service'
        ? prisma.service
        : tab.storage === 'review'
          ? prisma.review
          : listModel(tab)
  const max = await model.aggregate({ where: { profileId }, _max: { sortOrder: true } })
  const sortOrder = typeof input.sortOrder === 'number' ? input.sortOrder : (max._max.sortOrder ?? -1) + 1
  const data =
    tab.storage === 'gallery'
      ? galleryData(input)
      : tab.storage === 'service'
        ? {
            title: str(input.title),
            description: str(input.description),
            reviewUrl: str(input.url),
            imageUrl: str(input.featuredImage),
            status: Number(statusOf(input.status)),
          }
        : tab.storage === 'review'
          ? {
              author: str(input.title),
              text: str(input.description),
              rating: Number(input.metas?.rating) || 5,
              status: Number(statusOf(input.status)),
            }
          : genericData(input)
  const row = await model.create({ data: { profileId, sortOrder, ...data } })
  return serializeDedicatedRow(tab, row)
}

const updateTabItem = async (
  profileId: string,
  tabKey: string,
  itemId: string,
  userId: string,
  role: string,
  input: TabItemInput
) => {
  const tab = assertDirectListTab(tabKey)
  await profileService.getOwnedForWrite(profileId, userId, role)
  if (tab.storage === 'blog') return updateBlog(profileId, itemId, userId, role, input)
  const model =
    tab.storage === 'gallery'
      ? prisma.gallery
      : tab.storage === 'service'
        ? prisma.service
        : tab.storage === 'review'
          ? prisma.review
          : tab.storage === 'about_me'
            ? prisma.aboutMe
            : isSingletonSectionStorage(tab.storage)
              ? singletonModel(tab.storage)
              : listModel(tab)
  const existing = await model.findFirst({ where: { id: itemId, profileId } })
  if (!existing) throw new AppError(404, 'Item not found')
  const base =
    tab.storage === 'gallery'
      ? galleryUpdateData(input)
      : tab.storage === 'service'
        ? {
            ...(input.title !== undefined ? { title: str(input.title) } : {}),
            ...(input.description !== undefined ? { description: str(input.description) } : {}),
            ...(input.url !== undefined ? { reviewUrl: str(input.url) } : {}),
            ...(input.featuredImage !== undefined ? { imageUrl: str(input.featuredImage) } : {}),
            ...(input.status !== undefined ? { status: Number(statusOf(input.status)) } : {}),
          }
        : tab.storage === 'review'
          ? {
              ...(input.title !== undefined ? { author: str(input.title) } : {}),
              ...(input.description !== undefined ? { text: str(input.description) } : {}),
              ...(input.status !== undefined ? { status: Number(statusOf(input.status)) } : {}),
              ...(input.metas?.rating !== undefined ? { rating: Number(input.metas.rating) || 5 } : {}),
            }
          : tab.storage === 'about_me' || isSingletonSectionStorage(tab.storage)
            ? {
                ...(input.title !== undefined ? { title: str(input.title) || tab.label } : {}),
                ...(input.description !== undefined ? { description: str(input.description) } : {}),
                ...(input.featuredImage !== undefined ? { featuredMediaUrl: str(input.featuredImage) } : {}),
                ...(input.status !== undefined ? { status: statusOf(input.status) } : {}),
              }
            : genericUpdateData(input)
  const row = await model.update({
    where: { id: itemId },
    data: {
      ...base,
      ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
    },
  })
  return serializeDedicatedRow(tab, row)
}

const deleteTabItem = async (profileId: string, tabKey: string, itemId: string, userId: string, role: string) => {
  const tab = assertDirectListTab(tabKey)
  await profileService.getOwnedForWrite(profileId, userId, role)
  if (tab.storage === 'blog') return deleteBlog(profileId, itemId, userId, role)
  const model =
    tab.storage === 'gallery'
      ? prisma.gallery
      : tab.storage === 'service'
        ? prisma.service
        : tab.storage === 'review'
          ? prisma.review
          : tab.storage === 'about_me'
            ? prisma.aboutMe
            : isSingletonSectionStorage(tab.storage)
              ? singletonModel(tab.storage)
              : listModel(tab)
  const existing = await model.findFirst({ where: { id: itemId, profileId } })
  if (!existing) throw new AppError(404, 'Item not found')
  const singleton = tab.storage === 'about_me' || isSingletonSectionStorage(tab.storage)
  const numericStatus = tab.storage === 'service' || tab.storage === 'review'
  await model.update({
    where: { id: itemId },
    data: singleton ? { status: '0' } : numericStatus ? { status: 0 } : { deletedAt: new Date(), status: '0' },
  })
  return { deleted: true as const }
}

/** Public helpers used by getDynamicSection */
const listPublicBlogs = async (profileId: string) => {
  const rows = await prisma.blog.findMany({
    where: { profileId, deletedAt: null, status: '1' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  })
  return rows
}

const listPublicTabItems = async (profileId: string, tabKey: string) => {
  const rows = await prisma.tabItem.findMany({
    where: { profileId, tabKey, deletedAt: null, status: '1' },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  })
  return rows
}

const findTabKeyByPublicSectionName = (name: string): string | null => {
  const needle = name.trim().toLowerCase()
  for (const tab of Object.values(TAB_REGISTRY)) {
    if (tab.architecture !== 'direct') continue
    if (tab.key === 'about_me' || tab.key === 'services' || tab.key === 'gallery' || tab.key === 'reviews') {
      continue
    }
    if (tab.key === 'blogs') continue
    if (tab.publicSectionName.toLowerCase() === needle) return tab.key
  }
  return null
}

const directTabService = {
  listBlogs,
  createBlog,
  updateBlog,
  deleteBlog,
  listTabItems,
  createTabItem,
  updateTabItem,
  deleteTabItem,
  listPublicBlogs,
  listPublicTabItems,
  findTabKeyByPublicSectionName,
  serializeBlog,
  serializeTabItem,
}

export default directTabService
