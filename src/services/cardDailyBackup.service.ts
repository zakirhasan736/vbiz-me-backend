import { Prisma } from '../../generated/prisma/client'
import { countPublicSection, DIRECT_SECTION_LOADERS, isGenericDirectStorage } from '../constants/directSectionStorage'
import { NAV_CHECKBOX_TO_TAB_KEY, NAV_ID_TO_TAB_KEY, TAB_KEY_TO_NAV_ID, TAB_REGISTRY } from '../constants/tabRegistry'
import {
  backupDayKey,
  backupRowIdsToDelete,
  labelForNavId,
  mediaKindForUrl,
  PERSONAL_MEDIA_ENTRY_ID,
  readMediaSlots,
  resolveCardNavIds,
  toTabCount,
  withImageBreakdown,
  type CardMediaSlot,
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
  personalMedia: CardMediaSlot[]
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

const TEXT_ONLY_NAV_IDS = new Set(['home', 'education', 'work', 'skills', 'my-info', 'resume'])
const IMAGE_STORAGES = new Set(['about_me', 'service', 'review', 'gallery', 'blog'])
const IMAGE_NAV_IDS = new Set(['about', 'services', 'reviews', 'gallery', 'blog', 'content-media'])

/** Mirrors the branches in itemsForStorage: true when its items carry a real image field. */
function tabTracksImages(navId: string): boolean {
  if (TEXT_ONLY_NAV_IDS.has(navId)) return false
  const tab = TAB_REGISTRY[NAV_ID_TO_TAB_KEY[navId] || navId]
  if (!tab) return true
  if (isGenericDirectStorage(tab.storage)) return true
  return IMAGE_STORAGES.has(tab.storage) || IMAGE_NAV_IDS.has(navId)
}

function displayFieldValue(display: Record<string, unknown>, field: string): string {
  const fields = display.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return ''
  const entry = (fields as Record<string, unknown>)[field]
  if (!entry || typeof entry !== 'object') return ''
  const value = (entry as { customValue?: unknown }).customValue
  return typeof value === 'string' ? value.trim() : ''
}

/** Personal info avatar / intro / background, each as image, video, or none. */
async function collectPersonalMedia(
  profileId: string,
  map: Record<string, string>,
  display: Record<string, unknown>
): Promise<CardMediaSlot[]> {
  const profile = await prisma.profile
    .findUnique({ where: { id: profileId }, select: { avatar: true } })
    .catch(() => null)
  const avatar =
    displayFieldValue(display, 'Profile Image/Video') || map.profile_media_url?.trim() || profile?.avatar?.trim() || ''
  const introFile = displayFieldValue(display, 'Intro vCard Video') || map.intro_video_url?.trim() || ''
  const introYoutube =
    displayFieldValue(display, 'Intro YouTube vCard Video Link') || map.intro_youtube_url?.trim() || ''
  const background = displayFieldValue(display, 'Background Video/Image') || map.background_media_url?.trim() || ''
  return [
    { id: 'avatar', label: 'Avatar', kind: mediaKindForUrl(avatar) },
    { id: 'intro', label: 'Intro video', kind: introFile || introYoutube ? 'video' : 'none' },
    { id: 'background', label: 'Background', kind: mediaKindForUrl(background) },
  ]
}

export async function collectCardTabInventory(
  profileId: string
): Promise<{ tabs: CardTabSnapshot[]; personalMedia: CardMediaSlot[] }> {
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
    const withImages = tabTracksImages(navId)
      ? withImageBreakdown(
          counted,
          items.map((row) => row.image)
        )
      : counted
    tabs.push({ ...withImages, items })
  }
  const personalMedia = await collectPersonalMedia(profileId, map, display)
  return { tabs, personalMedia }
}

function publicTabs(tabs: CardTabSnapshot[]): CardTabCount[] {
  return tabs.map(({ items: _items, ...tab }) => tab)
}

function readStoredTabs(value: Prisma.JsonValue): { tabs: CardTabCount[]; personalMedia: CardMediaSlot[] } {
  if (!Array.isArray(value)) return { tabs: [], personalMedia: [] }
  let personalMedia: CardMediaSlot[] = []
  const tabs = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as {
      id?: unknown
      label?: unknown
      count?: unknown
      withImage?: unknown
      media?: unknown
    }
    const id = typeof row.id === 'string' ? row.id : ''
    if (id === PERSONAL_MEDIA_ENTRY_ID) {
      personalMedia = readMediaSlots(row.media)
      return []
    }
    const label = typeof row.label === 'string' ? row.label : id
    const count = typeof row.count === 'number' ? row.count : 0
    if (!id) return []
    const tab = toTabCount(id, label, count)
    if (typeof row.withImage !== 'number') return [tab]
    const withImage = Math.min(tab.count, Math.max(0, Math.floor(row.withImage)))
    return [{ ...tab, withImage, withoutImage: tab.count - withImage }]
  })
  return { tabs, personalMedia }
}

export async function saveCardDailyBackup(
  profileId: string,
  collected: { tabs: CardTabSnapshot[]; personalMedia: CardMediaSlot[] },
  now = new Date()
): Promise<void> {
  const day = backupDayKey(now)
  const tabs = publicTabs(collected.tabs)
  const storedTabs = [
    ...tabs,
    { id: PERSONAL_MEDIA_ENTRY_ID, label: 'Personal info media', count: 0, media: collected.personalMedia },
  ]
  const snapshot = {
    version: 1,
    backupDate: day,
    tabCount: tabs.length,
    tabs: collected.tabs,
    personalMedia: collected.personalMedia,
  }
  await prisma.cardDailyBackup.upsert({
    where: { profileId_backupDate: { profileId, backupDate: day } },
    create: {
      profileId,
      backupDate: day,
      tabCount: tabs.length,
      tabs: storedTabs as unknown as Prisma.InputJsonValue,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
    update: {
      tabCount: tabs.length,
      tabs: storedTabs as unknown as Prisma.InputJsonValue,
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
    ...readStoredTabs(row.tabs),
  }))
}

/** Current tab counts, plus today's backup. Missing backup table does not hide the counts. */
export async function readCardHistoryFootprint(profileId: string): Promise<{
  inventory: { tabCount: number; tabs: CardTabCount[]; personalMedia: CardMediaSlot[] }
  backups: CardBackupSummary[]
}> {
  const collected = await collectCardTabInventory(profileId)
  const inventory = {
    tabCount: collected.tabs.length,
    tabs: publicTabs(collected.tabs),
    personalMedia: collected.personalMedia,
  }
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
