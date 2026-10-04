import { Prisma } from '../../generated/prisma/client'
import { DIRECT_SECTION_LOADERS, countPublicSection, isGenericDirectStorage } from '../constants/directSectionStorage'
import { NAV_CHECKBOX_TO_TAB_KEY, NAV_ID_TO_TAB_KEY, TAB_KEY_TO_NAV_ID, TAB_REGISTRY } from '../constants/tabRegistry'
import {
  backupDayKey,
  backupRowIdsToDelete,
  labelForNavId,
  resolveCardNavIds,
  toTabCount,
  type CardTabCount,
} from '../utils/cardDailyBackup'
import logger from '../utils/logger'
import { prisma } from '../utils/prisma'
import { isPrismaMissingTable } from '../utils/prismaErrors'

export type CardBackupItem = {
  title: string | null
  description: string | null
  url: string | null
  image: string | null
}

export type CardTabSnapshot = CardTabCount & {
  items: CardBackupItem[]
}

export type CardBackupSummary = {
  id: string
  backupDate: string
  tabCount: number
  tabs: CardTabCount[]
}

const ITEM_TEXT_LIMIT = 20_000

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > ITEM_TEXT_LIMIT ? trimmed.slice(0, ITEM_TEXT_LIMIT) : trimmed
}

function item(input: {
  title?: unknown
  description?: unknown
  url?: unknown
  image?: unknown
}): CardBackupItem | null {
  const row: CardBackupItem = {
    title: text(input.title),
    description: text(input.description),
    url: text(input.url),
    image: text(input.image),
  }
  if (!row.title && !row.description && !row.url && !row.image) return null
  return row
}

function jsonRecord(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

async function safeRows<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run()
  } catch {
    return []
  }
}

function settingsMap(rows: Array<{ key: string; value: string | null }>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const row of rows) map[row.key] = row.value ?? ''
  return map
}

function enabledNavIds(map: Record<string, string>): string[] {
  const ids: string[] = []
  for (const [checkbox, tabKey] of Object.entries(NAV_CHECKBOX_TO_TAB_KEY)) {
    const value = map[checkbox]
    if (value === '1' || value === 'true') ids.push(TAB_KEY_TO_NAV_ID[tabKey] || tabKey)
  }
  return ids
}

async function itemsForStorage(
  profileId: string,
  navId: string,
  map: Record<string, string>
): Promise<CardBackupItem[]> {
  const tabKey = NAV_ID_TO_TAB_KEY[navId] || navId
  const tab = TAB_REGISTRY[tabKey]

  if (tab && isGenericDirectStorage(tab.storage)) {
    const rows = await DIRECT_SECTION_LOADERS[tab.storage](profileId, 200).catch(() => [])
    return rows
      .map((row) =>
        item({
          title: row.title,
          description: row.description,
          url: row.url,
          image: row.featuredImage,
        })
      )
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (tab?.storage === 'about_me' || navId === 'about') {
    const row = await prisma.aboutMe.findUnique({ where: { profileId } }).catch(() => null)
    if (!row || row.status === '0') return []
    const title = text(row.title)
    const saved = item({
      title: title && title.toLowerCase() !== 'about me' ? title : null,
      description: row.description,
      image: row.featuredMediaUrl,
    })
    return saved ? [saved] : []
  }

  if (tab?.storage === 'service' || navId === 'services') {
    const rows = await safeRows(() =>
      prisma.service.findMany({ where: { profileId, status: 1 }, orderBy: { sortOrder: 'asc' }, take: 200 })
    )
    return rows
      .map((row) => item({ title: row.title, description: row.description, url: row.reviewUrl, image: row.imageUrl }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (tab?.storage === 'review' || navId === 'reviews') {
    const rows = await safeRows(() =>
      prisma.review.findMany({ where: { profileId, status: 1 }, orderBy: { sortOrder: 'asc' }, take: 200 })
    )
    return rows
      .map((row) => item({ title: row.author, description: row.text, url: row.reviewUrl, image: row.imageUrl }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (tab?.storage === 'gallery' || navId === 'gallery') {
    const gallery = await safeRows(() =>
      prisma.gallery.findMany({
        where: { profileId, deletedAt: null, status: '1' },
        orderBy: { sortOrder: 'asc' },
        take: 200,
      })
    )
    const galleryItems = gallery
      .map((row) => item({ title: row.title, description: row.description, url: row.url, image: row.featuredImage }))
      .filter((row): row is CardBackupItem => Boolean(row))
    if (galleryItems.length) return galleryItems
    const portfolios = await safeRows(() =>
      prisma.portfolio.findMany({ where: { profileId, status: 1 }, orderBy: { sortOrder: 'asc' }, take: 200 })
    )
    return portfolios
      .map((row) => item({ title: row.title, description: row.description, url: row.url, image: row.imageUrl }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (tab?.storage === 'blog' || navId === 'blog') {
    const rows = await safeRows(() =>
      prisma.blog.findMany({
        where: { profileId, deletedAt: null, status: '1' },
        orderBy: { sortOrder: 'asc' },
        take: 200,
      })
    )
    return rows
      .map((row) => item({ title: row.title, description: row.description, url: row.url, image: row.featuredImage }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (navId === 'education') {
    const rows = await safeRows(() => prisma.education.findMany({ where: { profileId }, take: 200 }))
    return rows
      .map((row) => item({ title: row.degree || row.institute, description: row.institute }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (navId === 'work') {
    const rows = await safeRows(() => prisma.experience.findMany({ where: { profileId }, take: 200 }))
    return rows
      .map((row) => item({ title: row.jobTitle || row.company, description: row.description || row.company }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (navId === 'skills') {
    const rows = await safeRows(() => prisma.skillTag.findMany({ where: { profileId }, take: 200 }))
    return rows
      .map((row) => item({ title: row.name, description: row.level }))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (navId === 'home') {
    const profile = await prisma.profile
      .findUnique({
        where: { id: profileId },
        select: { name: true, email: true, phone: true, about: true, avatar: true, companyName: true },
      })
      .catch(() => null)
    const saved = item({
      title: profile?.name,
      description: profile?.about || profile?.companyName,
      url: profile?.email,
      image: profile?.avatar,
    })
    return saved ? [saved] : []
  }

  if (navId === 'my-info') {
    const info = jsonRecord(map.my_info_json)
    return Object.entries(info)
      .map(([key, value]) => (typeof value === 'string' ? item({ title: key, description: value }) : null))
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (navId === 'content-media') {
    const media = jsonRecord(map.content_media_json)
    const entries = [...jsonArray(media.gallery), ...jsonArray(media.videos)]
    return entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return item({ title: typeof entry === 'string' ? entry : null })
        const row = entry as Record<string, unknown>
        return item({
          title: row.title || row.name,
          description: row.description,
          url: row.url,
          image: row.image || row.src,
        })
      })
      .filter((row): row is CardBackupItem => Boolean(row))
  }

  if (navId === 'resume') {
    const resume = jsonRecord(map.resume_json)
    const documents = jsonArray(resume.documents)
    const summary = text(resume.summary) ? item({ title: resume.title, description: resume.summary }) : null
    const files = documents
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const row = entry as Record<string, unknown>
        return item({ title: row.name || row.title, url: row.url })
      })
      .filter((row): row is CardBackupItem => Boolean(row))
    return [...(summary ? [summary] : []), ...files]
  }

  if (tab) {
    const total = await countPublicSection(tab.storage, profileId).catch(() => 0)
    return Array.from({ length: total }, () => item({ title: tab.label })).filter((row): row is CardBackupItem =>
      Boolean(row)
    )
  }

  const custom = await prisma.customTab
    .findFirst({
      where: { profileId, OR: [{ id: navId }, { key: navId }, { slug: navId }] },
      select: { id: true, label: true },
    })
    .catch(() => null)
  if (!custom) return []
  const rows = await safeRows(() =>
    prisma.customTabItem.findMany({
      where: { customTabId: custom.id, profileId, status: '1' },
      orderBy: { sortOrder: 'asc' },
      take: 200,
    })
  )
  return rows
    .map((row) => item({ title: row.title, description: row.description, url: row.url, image: row.featuredImage }))
    .filter((row): row is CardBackupItem => Boolean(row))
}

export async function collectCardTabInventory(profileId: string): Promise<{ tabs: CardTabSnapshot[] }> {
  const [settings, customTabs] = await Promise.all([
    prisma.setting.findMany({ where: { profileId }, select: { key: true, value: true } }).catch(() => []),
    prisma.customTab
      .findMany({ where: { profileId, isEnabled: true }, select: { id: true, key: true, slug: true, label: true } })
      .catch(() => []),
  ])
  const map = settingsMap(settings)
  const display = jsonRecord(map.display_settings_json)
  const navIds = resolveCardNavIds({
    editorNavOrder: display.editorNavOrder,
    enabledNavIds: enabledNavIds(map),
  })

  const tabs: CardTabSnapshot[] = []
  for (const navId of navIds) {
    const tabKey = NAV_ID_TO_TAB_KEY[navId] || navId
    const custom = customTabs.find((tab) => tab.id === navId || tab.key === navId || tab.slug === navId)
    const label = labelForNavId(navId, custom?.label || TAB_REGISTRY[tabKey]?.label)
    const items = await itemsForStorage(profileId, navId, map)
    const counted = toTabCount(navId, label, items.length)
    tabs.push({ ...counted, items })
  }
  return { tabs }
}

function publicTabs(tabs: CardTabSnapshot[]): CardTabCount[] {
  return tabs.map(({ id, label, count, empty }) => ({ id, label, count, empty }))
}

function readStoredTabs(value: Prisma.JsonValue): CardTabCount[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as { id?: unknown; label?: unknown; count?: unknown }
    const id = typeof row.id === 'string' ? row.id : ''
    const label = typeof row.label === 'string' ? row.label : id
    const count = typeof row.count === 'number' ? row.count : 0
    if (!id) return []
    return [toTabCount(id, label, count)]
  })
}

export async function saveCardDailyBackup(
  profileId: string,
  collected: { tabs: CardTabSnapshot[] },
  now = new Date()
): Promise<void> {
  const day = backupDayKey(now)
  const tabs = publicTabs(collected.tabs)
  const snapshot = {
    version: 1,
    backupDate: day,
    tabCount: tabs.length,
    tabs: collected.tabs,
  }
  await prisma.cardDailyBackup.upsert({
    where: { profileId_backupDate: { profileId, backupDate: day } },
    create: {
      profileId,
      backupDate: day,
      tabCount: tabs.length,
      tabs: tabs as unknown as Prisma.InputJsonValue,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
    update: {
      tabCount: tabs.length,
      tabs: tabs as unknown as Prisma.InputJsonValue,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  })
  const rows = await prisma.cardDailyBackup.findMany({
    where: { profileId },
    orderBy: { backupDate: 'desc' },
    select: { id: true },
  })
  const dropIds = backupRowIdsToDelete(rows)
  if (dropIds.length) {
    await prisma.cardDailyBackup.deleteMany({ where: { id: { in: dropIds } } })
  }
}

export async function listCardDailyBackups(profileId: string): Promise<CardBackupSummary[]> {
  const rows = await prisma.cardDailyBackup.findMany({
    where: { profileId },
    orderBy: { backupDate: 'desc' },
    take: 7,
    select: { id: true, backupDate: true, tabCount: true, tabs: true },
  })
  return rows.map((row) => ({
    id: row.id,
    backupDate: row.backupDate,
    tabCount: row.tabCount,
    tabs: readStoredTabs(row.tabs),
  }))
}

/** Current tab counts, plus today's backup. Missing backup table does not hide the counts. */
export async function readCardHistoryFootprint(profileId: string): Promise<{
  inventory: { tabCount: number; tabs: CardTabCount[] }
  backups: CardBackupSummary[]
}> {
  const collected = await collectCardTabInventory(profileId)
  const inventory = { tabCount: collected.tabs.length, tabs: publicTabs(collected.tabs) }
  try {
    await saveCardDailyBackup(profileId, collected)
    const backups = await listCardDailyBackups(profileId)
    return { inventory, backups }
  } catch (error) {
    if (!isPrismaMissingTable(error)) logger.warn('card daily backup skipped', error)
    return { inventory, backups: [] }
  }
}

export async function backupAllCards(now = new Date()): Promise<{ saved: number; failed: number }> {
  const profiles = await prisma.profile.findMany({ select: { id: true } })
  let saved = 0
  let failed = 0
  for (const profile of profiles) {
    try {
      const collected = await collectCardTabInventory(profile.id)
      await saveCardDailyBackup(profile.id, collected, now)
      saved += 1
    } catch (error) {
      failed += 1
      logger.warn(`card daily backup failed for ${profile.id}`, error)
    }
  }
  logger.info(`Card daily backup finished: ${saved} saved, ${failed} failed, keeping 7 days`)
  return { saved, failed }
}
