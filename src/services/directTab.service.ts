import type { Prisma } from '../../generated/prisma/client'
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
  if (tab.architecture !== 'direct' || tab.storage !== 'tab_item') {
    throw new AppError(400, `Tab ${tabKey} is not a TabItem-backed direct tab`)
  }
  return tab
}

const str = (v: unknown) => (v == null ? null : String(v))
const statusOf = (v: unknown, fallback = '1') => {
  const s = str(v)?.trim()
  return s || fallback
}

/** ——— Blogs ——— */

const listBlogs = async (profileId: string, userId: string, role: string) => {
  await profileService.getOwned(profileId, userId, role)
  const rows = await prisma.blog.findMany({
    where: { profileId, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
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

/** ——— Tab items (remaining direct tabs) ——— */

const listTabItems = async (profileId: string, tabKey: string, userId: string, role: string) => {
  assertDirectListTab(tabKey)
  await profileService.getOwned(profileId, userId, role)
  const rows = await prisma.tabItem.findMany({
    where: { profileId, tabKey, deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  })
  return rows.map(serializeTabItem)
}

const createTabItem = async (profileId: string, tabKey: string, userId: string, role: string, input: TabItemInput) => {
  const tab = assertDirectListTab(tabKey)
  await profileService.getOwnedForWrite(profileId, userId, role)

  if (tab.mode === 'singleton') {
    const existing = await prisma.tabItem.findFirst({
      where: { profileId, tabKey, deletedAt: null },
    })
    if (existing) {
      const row = await prisma.tabItem.update({
        where: { id: existing.id },
        data: {
          title: input.title !== undefined ? str(input.title) : existing.title,
          description: input.description !== undefined ? str(input.description) : existing.description,
          url: input.url !== undefined ? str(input.url) : existing.url,
          featuredImage: input.featuredImage !== undefined ? str(input.featuredImage) : existing.featuredImage,
          status: input.status !== undefined ? statusOf(input.status, existing.status) : existing.status,
          metas: input.metas !== undefined ? (input.metas as Prisma.InputJsonValue) : undefined,
        },
      })
      return serializeTabItem(row)
    }
  }

  const max = await prisma.tabItem.aggregate({
    where: { profileId, tabKey, deletedAt: null },
    _max: { sortOrder: true },
  })
  const row = await prisma.tabItem.create({
    data: {
      profileId,
      tabKey,
      legacyPostTypeId: tab.legacyPostTypeId,
      title: str(input.title),
      description: str(input.description),
      url: str(input.url),
      featuredImage: str(input.featuredImage),
      status: statusOf(input.status),
      sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : (max._max.sortOrder ?? -1) + 1,
      metas: input.metas != null ? (input.metas as Prisma.InputJsonValue) : undefined,
    },
  })
  return serializeTabItem(row)
}

const updateTabItem = async (
  profileId: string,
  tabKey: string,
  itemId: string,
  userId: string,
  role: string,
  input: TabItemInput
) => {
  assertDirectListTab(tabKey)
  await profileService.getOwnedForWrite(profileId, userId, role)
  const existing = await prisma.tabItem.findFirst({
    where: { id: itemId, profileId, tabKey, deletedAt: null },
  })
  if (!existing) throw new AppError(404, 'Item not found')
  const row = await prisma.tabItem.update({
    where: { id: itemId },
    data: {
      ...(input.title !== undefined ? { title: str(input.title) } : {}),
      ...(input.description !== undefined ? { description: str(input.description) } : {}),
      ...(input.url !== undefined ? { url: str(input.url) } : {}),
      ...(input.featuredImage !== undefined ? { featuredImage: str(input.featuredImage) } : {}),
      ...(input.status !== undefined ? { status: statusOf(input.status, existing.status) } : {}),
      ...(typeof input.sortOrder === 'number' ? { sortOrder: input.sortOrder } : {}),
      ...(input.metas !== undefined
        ? { metas: input.metas == null ? undefined : (input.metas as Prisma.InputJsonValue) }
        : {}),
    },
  })
  return serializeTabItem(row)
}

const deleteTabItem = async (profileId: string, tabKey: string, itemId: string, userId: string, role: string) => {
  assertDirectListTab(tabKey)
  await profileService.getOwnedForWrite(profileId, userId, role)
  const existing = await prisma.tabItem.findFirst({
    where: { id: itemId, profileId, tabKey, deletedAt: null },
  })
  if (!existing) throw new AppError(404, 'Item not found')
  await prisma.tabItem.update({
    where: { id: itemId },
    data: { deletedAt: new Date(), status: '0' },
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
