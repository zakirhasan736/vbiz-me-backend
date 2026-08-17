import { randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import AppError from '../error/AppError'
import { slugify } from '../middlewares/ownership'
import { prisma } from '../utils/prisma'
import profileService from './profile.service'

type Input = Record<string, unknown>

const json = (value: unknown) => (value && typeof value === 'object' ? (value as Prisma.InputJsonValue) : undefined)
const text = (value: unknown) => (value == null ? null : String(value))
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const status = (value: unknown, fallback = '1') => (value == null ? fallback : String(value))
const order = (value: unknown, fallback: number) => (typeof value === 'number' ? value : fallback)

const makeKey = (label: string) => `custom-${slugify(label) || 'tab'}-${randomBytes(4).toString('hex')}`

const getTab = async (profileId: string, tabId: string) => {
  const tab = await prisma.customTab.findFirst({ where: { id: tabId, profileId } })
  if (!tab) throw new AppError(404, 'Custom tab not found')
  return tab
}

const listTabs = async (profileId: string, userId: string, role: string) => {
  await profileService.getOwned(profileId, userId, role)
  return prisma.customTab.findMany({
    where: { profileId },
    include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], take: 200 } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
}

const createTab = async (profileId: string, userId: string, role: string, input: Input) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  const label = String(input.label || 'Custom tab').trim() || 'Custom tab'
  const count = await prisma.customTab.count({ where: { profileId } })
  return prisma.customTab.create({
    data: {
      profileId,
      key: makeKey(label),
      label,
      slug: slugify(String(input.slug || label)) || 'custom-tab',
      description: text(input.description),
      icon: text(input.icon),
      sortOrder: order(input.sortOrder, count),
      isEnabled: bool(input.isEnabled, true),
      isPublic: bool(input.isPublic, true),
      status: status(input.status),
      layoutType: String(input.layoutType || 'list'),
      settings: json(input.settings),
    },
    include: { items: true },
  })
}

const updateTab = async (profileId: string, tabId: string, userId: string, role: string, input: Input) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  await getTab(profileId, tabId)
  return prisma.customTab.update({
    where: { id: tabId },
    data: {
      ...(input.label !== undefined ? { label: String(input.label).trim() || 'Custom tab' } : {}),
      ...(input.slug !== undefined ? { slug: slugify(String(input.slug)) || 'custom-tab' } : {}),
      ...(input.description !== undefined ? { description: text(input.description) } : {}),
      ...(input.icon !== undefined ? { icon: text(input.icon) } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: order(input.sortOrder, 0) } : {}),
      ...(input.isEnabled !== undefined ? { isEnabled: bool(input.isEnabled, true) } : {}),
      ...(input.isPublic !== undefined ? { isPublic: bool(input.isPublic, true) } : {}),
      ...(input.status !== undefined ? { status: status(input.status) } : {}),
      ...(input.layoutType !== undefined ? { layoutType: String(input.layoutType) } : {}),
      ...(input.settings !== undefined ? { settings: json(input.settings) } : {}),
    },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  })
}

const deleteTab = async (profileId: string, tabId: string, userId: string, role: string) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  await getTab(profileId, tabId)
  await prisma.customTab.delete({ where: { id: tabId } })
  return { id: tabId, deleted: true as const }
}

const listItems = async (profileId: string, tabId: string, userId: string, role: string, skip = 0, limit = 200) => {
  await profileService.getOwned(profileId, userId, role)
  await getTab(profileId, tabId)
  const take = Math.min(200, Math.max(1, limit))
  const start = Math.max(0, skip)
  const where = { profileId, customTabId: tabId }
  const [items, total] = await Promise.all([
    prisma.customTabItem.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      skip: start,
      take,
    }),
    prisma.customTabItem.count({ where }),
  ])
  return { items, total, skip: start, limit: take }
}

const createItem = async (profileId: string, tabId: string, userId: string, role: string, input: Input) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  await getTab(profileId, tabId)
  const count = await prisma.customTabItem.count({ where: { customTabId: tabId } })
  return prisma.customTabItem.create({
    data: {
      profileId,
      customTabId: tabId,
      title: text(input.title),
      description: text(input.description),
      url: text(input.url),
      featuredImage: text(input.featuredImage ?? input.mediaUrl),
      sortOrder: order(input.sortOrder, count),
      status: status(input.status, input.active === false ? '0' : '1'),
      data: json(input.data),
    },
  })
}

const updateItem = async (
  profileId: string,
  tabId: string,
  itemId: string,
  userId: string,
  role: string,
  input: Input
) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  const item = await prisma.customTabItem.findFirst({ where: { id: itemId, customTabId: tabId, profileId } })
  if (!item) throw new AppError(404, 'Custom tab item not found')
  return prisma.customTabItem.update({
    where: { id: itemId },
    data: {
      ...(input.title !== undefined ? { title: text(input.title) } : {}),
      ...(input.description !== undefined ? { description: text(input.description) } : {}),
      ...(input.url !== undefined ? { url: text(input.url) } : {}),
      ...(input.featuredImage !== undefined || input.mediaUrl !== undefined
        ? { featuredImage: text(input.featuredImage ?? input.mediaUrl) }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: order(input.sortOrder, item.sortOrder) } : {}),
      ...(input.status !== undefined || input.active !== undefined
        ? { status: status(input.status, input.active === false ? '0' : '1') }
        : {}),
      ...(input.data !== undefined ? { data: json(input.data) } : {}),
    },
  })
}

const deleteItem = async (profileId: string, tabId: string, itemId: string, userId: string, role: string) => {
  await profileService.getOwnedForWrite(profileId, userId, role)
  const result = await prisma.customTabItem.deleteMany({ where: { id: itemId, customTabId: tabId, profileId } })
  if (!result.count) throw new AppError(404, 'Custom tab item not found')
  return { id: itemId, deleted: true as const }
}

export default { listTabs, createTab, updateTab, deleteTab, listItems, createItem, updateItem, deleteItem, makeKey }
