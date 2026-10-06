import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { isStaffRole, toApiRole } from '../constants/userRole'
import { getEffectiveEntitlements } from '../services/entitlement.service'
import { getCardChangeActor } from './cardChangeHistory'
import { getCorporateOwnedIds, setCorporateOwnedIds } from './corporateOwnedContent'
import {
  cloneRecord,
  isCorporateLiveSyncProfileField,
  isSharedProfileFieldValuePresent,
  omitCloneKeys,
  PERSONAL_IDENTITY_SETTING_KEYS,
  POST_STYLE_CLONE_SELECT,
  SHARED_DUPLICATE_LIST_MODELS,
  SHARED_DUPLICATE_PROFILE_FIELDS,
  unknownPrismaCreateArgs,
  unknownPrismaSelectFields,
} from './duplicateCard'
import { toGalleryWriteData } from './galleryMedia'
import logger from './logger'
import { prisma } from './prisma'
import {
  isPrismaMissingTable,
  isPrismaSchemaDrift,
  isPrismaTypeMismatch,
  isPrismaUnknownArgument,
} from './prismaErrors'
import { recordCardChange } from './recordCardChange'

const syncLock = new AsyncLocalStorage<boolean>()

/**
 * List tabs unique per linked card (Personal / Socials).
 * Business tabs (services, portfolio, etc.) still fan out.
 */
export const PERSONAL_COLLECTION_KINDS = new Set(['socialLinks', 'addresses'])

/** About Me stays unique on each linked card. */
export const PERSONAL_STORAGES = new Set(['about_me'])

/** Each linked card keeps its own portrait / profile video. */
export const PERSONAL_PROFILE_MEDIA_SETTING_KEYS = [
  'profile_media_url',
  'profile_image',
  'profile_image_url',
  'avatar',
  'avatar_url',
] as const

const PERSONAL_DISPLAY_MEDIA_FIELDS = ['Profile Image/Video'] as const

/**
 * Only these Setting keys fan out across linked corporate cards.
 * Everything else (Personal/My Info, Socials & Games, Card Settings General/Home/
 * Social links/Integration/Template/SEO, About Me, portrait) stays per card.
 */
const SHARED_SETTING_KEYS = new Set(['custom_tabs_json', 'tab_section_meta_json', 'tab_label_overrides_json'])

const COLLECTION_MODELS: Record<string, string[]> = {
  education: ['education'],
  experiences: ['experience'],
  services: ['service'],
  portfolios: ['gallery', 'portfolio'],
  reviews: ['review'],
  skillTags: ['skillTag'],
  socialLinks: ['socialLink'],
  addresses: ['address'],
}

const PERSONAL_LIST_MODELS = new Set([...PERSONAL_COLLECTION_KINDS].flatMap((kind) => COLLECTION_MODELS[kind] || []))

const STORAGE_EXTRA_MODELS: Record<string, string[]> = {
  gallery: ['gallery', 'portfolio'],
  about_me: ['aboutMe'],
  why_choose_us: ['whyChooseUs'],
}

type ListDelegate = {
  findMany: (args: {
    where: Record<string, unknown>
    select?: Record<string, boolean>
  }) => Promise<Array<Record<string, unknown>>>
  deleteMany: (args: { where: Record<string, unknown> }) => Promise<unknown>
  updateMany?: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>
}

async function softClearTargetRows(
  delegate: ListDelegate,
  model: string,
  targetWhere: Record<string, unknown>
): Promise<void> {
  if (MODELS_WITH_DELETED_AT.has(model) && delegate.updateMany) {
    try {
      await delegate.updateMany({
        where: { ...targetWhere, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      return
    } catch (error) {
      if (!isPrismaUnknownArgument(error)) throw error
    }
  }
  if (MODELS_WITH_STATUS_SOFT.has(model) && delegate.updateMany) {
    try {
      // Prefer numeric 0 (Service/Review); fall back to string for String status columns.
      await delegate.updateMany({ where: targetWhere, data: { status: 0 } })
      return
    } catch {
      try {
        await delegate.updateMany({ where: targetWhere, data: { status: '0' } })
        return
      } catch (error) {
        if (!isPrismaUnknownArgument(error) && !isPrismaTypeMismatch(error)) throw error
      }
    }
  }
  await delegate.deleteMany({ where: targetWhere })
}

export type SharedSyncScope =
  | { type: 'collection'; kind: string }
  | { type: 'storage'; storage: string; tabKey?: string }
  | { type: 'posts'; postTypeId?: string | null }
  | { type: 'aboutMe' }
  | { type: 'customTabs' }
  | { type: 'settings'; keys: string[] }
  | { type: 'profileFields'; keys?: string[] }
  | { type: 'profileSettings' }
  | { type: 'fullShared' }

export type SharedSyncOptions = {
  /** When false, an empty source list does not wipe siblings (stale/no-op save). */
  allowEmpty?: boolean
  /** Setting keys that already had a real value on the source card before this write. */
  settingHadValue?: Record<string, boolean>
  /**
   * Ops scripts may pass force:true. Live editor saves sync only from the corporate
   * team owner card when a logged-in actor is present — never from member cards or
   * anonymous/background jobs.
   */
  force?: boolean
}

/** Models that support soft clear via deletedAt. */
const MODELS_WITH_DELETED_AT = new Set([
  'gallery',
  'post',
  'tabItem',
  'faq',
  'announcementDirect',
  'clientPortfolio',
  'certification',
  'propertyListing',
  'joinMyTeam',
  'additionalService',
  'bbbAccreditation',
  'calendarSection',
  'imageGallery',
])

/** Models that support soft clear via status (0 / "0"). */
const MODELS_WITH_STATUS_SOFT = new Set(['service', 'review', 'portfolio', 'gallery', 'tabItem', 'faq'])

export function canRunCorporateSiblingSync(options: SharedSyncOptions = {}): boolean {
  if (options.force === true) return true
  return Boolean(getCardChangeActor()?.userId)
}

/**
 * True when this profile is a corporate team owner card (owned by the corporate parent).
 * Only these cards may fan shared tabs out to linked team member cards.
 */
export async function isCorporateTeamOwnerSourceCard(sourceProfileId: string): Promise<boolean> {
  const source = await prisma.profile.findUnique({
    where: { id: sourceProfileId },
    select: { id: true, userId: true, companyUserId: true },
  })
  if (!source?.userId) return false
  const parentId = await resolveCorporateParentUserIdFromProfile(source)
  if (!parentId) return false
  return source.userId === parentId
}

const JSON_SHARED_SETTING_KEYS = new Set(['custom_tabs_json', 'tab_section_meta_json', 'tab_label_overrides_json'])

export function isSparseSharedSettingValue(key: string, value: string | null | undefined): boolean {
  if (value == null || !String(value).trim()) return true
  if (!JSON_SHARED_SETTING_KEYS.has(key)) return false
  try {
    const parsed = JSON.parse(String(value)) as unknown
    if (parsed == null) return true
    if (Array.isArray(parsed)) return parsed.length === 0
    if (typeof parsed === 'object') return Object.keys(parsed as Record<string, unknown>).length === 0
    return false
  } catch {
    return !String(value).trim()
  }
}

export function shouldReplaceSiblingRows(sourceLiveCount: number, allowEmpty: boolean): boolean {
  return sourceLiveCount > 0 || allowEmpty
}

export function shouldCopySharedSetting(args: {
  key: string
  sourceValue: string | undefined
  sourceHadValueBeforeWrite: boolean
}): boolean {
  if (args.sourceValue === undefined) return false
  if (isSparseSharedSettingValue(args.key, args.sourceValue) && !args.sourceHadValueBeforeWrite) return false
  return true
}

export function isCorporateSiblingSyncRunning(): boolean {
  return syncLock.getStore() === true
}

export function isPersonalCollectionKind(kind: string): boolean {
  return PERSONAL_COLLECTION_KINDS.has(kind)
}

export function isPersonalStorage(storage: string): boolean {
  return PERSONAL_STORAGES.has(storage.trim())
}

export function shouldFanOutCollection(kind: string): boolean {
  return Boolean(COLLECTION_MODELS[kind]) && !isPersonalCollectionKind(kind)
}

export function isSharedSettingKey(key: string): boolean {
  const trimmed = key.trim()
  if (!trimmed) return false
  if (PERSONAL_IDENTITY_SETTING_KEYS.has(trimmed)) return false
  return SHARED_SETTING_KEYS.has(trimmed)
}

export function storageToPrismaModel(storage: string): string {
  return storage.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

export function corporateSiblingProfileWhere(parentUserId: string): {
  OR: Array<{ userId: string } | { companyUserId: string }>
} {
  return { OR: [{ userId: parentUserId }, { companyUserId: parentUserId }] }
}

/** True only for cards in this corporation — never another company's team. */
export function cardBelongsToCorporation(
  parentUserId: string,
  card: { userId?: string | null; companyUserId?: string | null },
  foreignCorporateOwnerIds: Iterable<string> = []
): boolean {
  const parentId = parentUserId.trim()
  if (!parentId) return false
  const userId = typeof card.userId === 'string' ? card.userId.trim() : ''
  const companyId = typeof card.companyUserId === 'string' ? card.companyUserId.trim() : ''
  if (companyId === parentId) return true
  if (userId !== parentId) return false
  if (!companyId || companyId === parentId) return true
  const foreign = foreignCorporateOwnerIds instanceof Set ? foreignCorporateOwnerIds : new Set(foreignCorporateOwnerIds)
  return !foreign.has(companyId)
}

type CustomTabMatch = { id: string; key: string; label: string }

/** Match custom tabs by key, then label. Never treat remapped source ids as the sibling row. */
export function takeMatchingCustomTab(
  source: { key: string; label: string },
  unused: CustomTabMatch[]
): CustomTabMatch | null {
  const byKey = unused.findIndex((tab) => tab.key && tab.key === source.key)
  if (byKey >= 0) return unused.splice(byKey, 1)[0] || null
  const sourceLabel = source.label.trim().toLowerCase()
  if (!sourceLabel) return null
  const byLabel = unused.findIndex((tab) => tab.label.trim().toLowerCase() === sourceLabel)
  if (byLabel >= 0) return unused.splice(byLabel, 1)[0] || null
  return null
}

export function remapSharedSettingIds(value: string, idMap: Map<string, string>): string {
  if (!idMap.size || !value.trim()) return value
  let next = value
  for (const [from, to] of idMap) {
    if (!from || !to || from === to) continue
    next = next.split(from).join(to)
  }
  return next
}

/** Copy shared display chrome; keep each sibling's own Profile Image/Video. */
export function mergeDisplaySettingsKeepingPersonalMedia(
  sourceJson: string,
  targetJson: string | null | undefined
): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(sourceJson) as Record<string, unknown>
  } catch {
    return sourceJson
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sourceJson

  const sourceFields =
    parsed.fields && typeof parsed.fields === 'object' && !Array.isArray(parsed.fields)
      ? { ...(parsed.fields as Record<string, unknown>) }
      : {}

  let targetFields: Record<string, unknown> = {}
  if (targetJson?.trim()) {
    try {
      const target = JSON.parse(targetJson) as Record<string, unknown>
      if (target?.fields && typeof target.fields === 'object' && !Array.isArray(target.fields)) {
        targetFields = target.fields as Record<string, unknown>
      }
    } catch {
      targetFields = {}
    }
  }

  for (const field of PERSONAL_DISPLAY_MEDIA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(targetFields, field)) {
      sourceFields[field] = targetFields[field]
    } else {
      delete sourceFields[field]
    }
  }

  parsed.fields = sourceFields
  return JSON.stringify(parsed)
}

const isStaffActor = (role: string) => isStaffRole(role) || role === 'admin' || role === 'super-admin'
const isAdminActor = (role: string) => isStaffActor(role) || role === 'ADMIN' || role === 'SUPER_ADMIN'

export async function resolveCorporateParentUserIdFromProfile(source: {
  userId?: unknown
  companyUserId?: unknown
}): Promise<string | null> {
  const candidateIds = [
    typeof source.companyUserId === 'string' ? source.companyUserId : '',
    typeof source.userId === 'string' ? source.userId : '',
  ].filter(Boolean)

  for (const candidateId of candidateIds) {
    const user = await prisma.user.findFirst({
      where: { id: candidateId, deletedAt: null },
      select: { id: true, role: true },
    })
    if (!user) continue
    const apiRole = toApiRole(user.role)
    if (isStaffRole(apiRole)) continue
    if (apiRole === 'corporate-owner') return user.id
    const entitlements = await getEffectiveEntitlements(user.id, apiRole)
    if (entitlements.ownerMode === 'corporate') return user.id
  }

  return null
}

/** Resolve the corporate account that should own capacity for a duplicated team card. */
export async function resolveCorporateParentUserId(
  source: {
    userId?: unknown
    companyUserId?: unknown
  },
  actorUserId: string,
  actorRole: string
): Promise<string | null> {
  const fromProfile = await resolveCorporateParentUserIdFromProfile(source)
  if (fromProfile) return fromProfile

  if (!isStaffActor(actorRole) && !isAdminActor(actorRole)) {
    const actorEntitlements = await getEffectiveEntitlements(actorUserId, actorRole)
    if (actorEntitlements.ownerMode === 'corporate' || actorRole === 'corporate-owner') {
      return actorUserId
    }
  }

  return null
}

const listForeignCorporateOwnerIds = async (parentId: string, companyUserIds: string[]): Promise<Set<string>> => {
  const unique = [...new Set(companyUserIds.map((id) => id.trim()).filter((id) => id && id !== parentId))]
  if (!unique.length) return new Set()

  const users = await prisma.user.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true, role: true },
  })
  const foreign = new Set<string>()
  for (const user of users) {
    const apiRole = toApiRole(user.role)
    if (isStaffRole(apiRole)) continue
    if (apiRole === 'corporate-owner') {
      foreign.add(user.id)
      continue
    }
    const entitlements = await getEffectiveEntitlements(user.id, apiRole)
    if (entitlements.ownerMode === 'corporate') foreign.add(user.id)
  }
  return foreign
}

export async function listCorporateSiblingProfileIds(sourceProfileId: string): Promise<string[]> {
  const source = await prisma.profile.findUnique({
    where: { id: sourceProfileId },
    select: { id: true, userId: true, companyUserId: true },
  })
  if (!source) return []

  const parentId = await resolveCorporateParentUserIdFromProfile(source)
  if (!parentId) return []

  const candidates = await prisma.profile.findMany({
    where: {
      id: { not: source.id },
      ...corporateSiblingProfileWhere(parentId),
    },
    select: { id: true, userId: true, companyUserId: true },
  })
  const foreignCorporateOwnerIds = await listForeignCorporateOwnerIds(
    parentId,
    candidates.map((row) => row.companyUserId || '')
  )
  return candidates
    .filter((row) => cardBelongsToCorporation(parentId, row, foreignCorporateOwnerIds))
    .map((row) => row.id)
}

const findManyCloneRows = async (
  delegate: ListDelegate,
  where: Record<string, unknown>
): Promise<Array<Record<string, unknown>>> => {
  try {
    return await delegate.findMany({ where })
  } catch (error) {
    if (isPrismaMissingTable(error)) return []
    if (!isPrismaSchemaDrift(error) && !isPrismaUnknownArgument(error)) throw error
  }

  const select: Record<string, boolean> = { ...POST_STYLE_CLONE_SELECT }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await delegate.findMany({ where, select })
    } catch (error) {
      if (isPrismaMissingTable(error)) return []
      const unknown = unknownPrismaSelectFields(error)
      if (!unknown.length) break
      for (const key of unknown) delete select[key]
      if (!Object.keys(select).length) return []
    }
  }

  try {
    return await delegate.findMany({
      where,
      select: {
        id: true,
        profileId: true,
        title: true,
        description: true,
        url: true,
        featuredImage: true,
        status: true,
        sortOrder: true,
      },
    })
  } catch {
    return []
  }
}

const createClonedRow = async (delegate: ListDelegate, data: Record<string, unknown>) => {
  let payload = data
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await delegate.create({ data: payload })
    } catch (error) {
      const unknownArgs = [...unknownPrismaCreateArgs(error), ...unknownPrismaSelectFields(error)]
      if (unknownArgs.length) {
        payload = omitCloneKeys(payload, unknownArgs)
        continue
      }
      if (isPrismaTypeMismatch(error) && 'status' in payload) {
        const status = payload.status
        const nextStatus = typeof status === 'number' ? String(status) : Number(status)
        if (nextStatus === status || (typeof nextStatus === 'number' && Number.isNaN(nextStatus))) throw error
        payload = { ...payload, status: nextStatus }
        continue
      }
      throw error
    }
  }
  return delegate.create({ data: payload })
}

const replaceModelRows = async (
  sourceProfileId: string,
  targetProfileId: string,
  model: string,
  extraWhere: Record<string, unknown> = {},
  options: SharedSyncOptions = {}
) => {
  const client = prisma as unknown as Record<string, ListDelegate>
  const delegate = client[model]
  if (!delegate?.findMany || !delegate?.deleteMany || !delegate?.create) return

  const sourceWhere = { profileId: sourceProfileId, ...extraWhere }
  const targetWhere = { profileId: targetProfileId, ...extraWhere }

  let rows: Array<Record<string, unknown>>
  try {
    rows = await findManyCloneRows(delegate, sourceWhere)
  } catch (error) {
    if (isPrismaUnknownArgument(error) && Object.keys(extraWhere).length) {
      rows = await findManyCloneRows(delegate, { profileId: sourceProfileId })
    } else {
      throw error
    }
  }

  const liveRows = rows.filter((row) => {
    if (row.deletedAt) return false
    if (row.status === 0 || row.status === '0') return false
    return true
  })
  if (!shouldReplaceSiblingRows(liveRows.length, options.allowEmpty === true)) return

  const ownedKey = typeof extraWhere.tabKey === 'string' ? `${model}:${extraWhere.tabKey}` : model
  const ownedIds = await getCorporateOwnedIds(targetProfileId, ownedKey)
  const clearWhere = ownedIds.size > 0 ? { ...targetWhere, id: { in: [...ownedIds] } } : targetWhere

  try {
    await softClearTargetRows(delegate, model, clearWhere)
  } catch (error) {
    if (isPrismaMissingTable(error)) return
    if (isPrismaUnknownArgument(error) && Object.keys(extraWhere).length) {
      logger.warn(`corporate sibling sync skipped soft-clear extra filter for ${model}`)
      return
    }
    throw error
  }

  const createdIds: string[] = []
  for (const row of liveRows) {
    const cloned = cloneRecord(row)
    if ('status' in row && cloned.status === undefined) {
      cloned.status = typeof row.status === 'number' ? 1 : '1'
    }
    if ('sortOrder' in row && cloned.sortOrder === undefined) cloned.sortOrder = 0
    try {
      const payload = model === 'gallery' ? toGalleryWriteData(cloned) : cloned
      const created = (await createClonedRow(delegate, {
        ...payload,
        profileId: targetProfileId,
      })) as { id?: string } | null
      if (created && typeof created.id === 'string') createdIds.push(created.id)
    } catch (error) {
      logger.error(`corporate sibling sync failed for ${model}`, error)
    }
  }
  await setCorporateOwnedIds(targetProfileId, ownedKey, createdIds)
}

const replacePosts = async (
  sourceProfileId: string,
  targetProfileId: string,
  postTypeId?: string | null,
  options: SharedSyncOptions = {}
) => {
  const sourceWhere = {
    profileId: sourceProfileId,
    deletedAt: null,
    ...(postTypeId ? { postTypeId } : {}),
  }
  const targetWhere = {
    profileId: targetProfileId,
    ...(postTypeId ? { postTypeId } : {}),
  }

  const sourcePosts = await prisma.post.findMany({
    where: sourceWhere,
    include: { metas: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  if (!shouldReplaceSiblingRows(sourcePosts.length, options.allowEmpty === true)) return

  const ownedIds = await getCorporateOwnedIds(targetProfileId, 'post')
  const clearWhere =
    ownedIds.size > 0
      ? { ...targetWhere, id: { in: [...ownedIds] }, deletedAt: null }
      : { ...targetWhere, deletedAt: null }

  await prisma.post.updateMany({
    where: clearWhere,
    data: { deletedAt: new Date(), status: '0' },
  })

  const createdIds: string[] = []
  for (const post of sourcePosts) {
    const created = await prisma.post.create({
      data: {
        profileId: targetProfileId,
        postTypeId: post.postTypeId,
        title: post.title,
        description: post.description,
        status: post.status,
        url: post.url,
        featuredImage: post.featuredImage,
        sortOrder: post.sortOrder,
      },
    })
    createdIds.push(created.id)
    for (const meta of post.metas) {
      await prisma.postMeta.create({
        data: { postId: created.id, metaKey: meta.metaKey, metaValue: meta.metaValue },
      })
    }
  }
  await setCorporateOwnedIds(targetProfileId, 'post', createdIds)
}

const replaceAboutMe = async (sourceProfileId: string, targetProfileId: string, options: SharedSyncOptions = {}) => {
  await replaceModelRows(sourceProfileId, targetProfileId, 'aboutMe', {}, options)
  await copySharedSettings(
    sourceProfileId,
    targetProfileId,
    ['about_me_title', 'about_me_featured_media_url', 'about_me_status', 'about_me_featured_media_focus_y'],
    options
  )
}

const buildCustomTabIdMap = async (sourceProfileId: string, targetProfileId: string): Promise<Map<string, string>> => {
  const [sourceTabs, targetTabs] = await Promise.all([
    prisma.customTab.findMany({
      where: { profileId: sourceProfileId },
      select: { id: true, key: true, label: true },
    }),
    prisma.customTab.findMany({
      where: { profileId: targetProfileId },
      select: { id: true, key: true, label: true },
    }),
  ])
  const unused = [...targetTabs]
  const idMap = new Map<string, string>()
  for (const sourceTab of sourceTabs) {
    const match = takeMatchingCustomTab(sourceTab, unused)
    if (!match) continue
    idMap.set(sourceTab.id, match.id)
    if (sourceTab.key) idMap.set(sourceTab.key, match.key)
  }
  return idMap
}

const replaceCustomTabs = async (
  sourceProfileId: string,
  targetProfileId: string,
  options: SharedSyncOptions = {}
): Promise<Map<string, string>> => {
  const sourceTabs = await prisma.customTab.findMany({
    where: { profileId: sourceProfileId, status: { not: '0' }, isEnabled: true },
    include: { items: { where: { status: { not: '0' } }, orderBy: { sortOrder: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  })
  if (!shouldReplaceSiblingRows(sourceTabs.length, options.allowEmpty === true)) return new Map()
  const targetTabs = await prisma.customTab.findMany({
    where: { profileId: targetProfileId, status: { not: '0' } },
    orderBy: { sortOrder: 'asc' },
  })
  const ownedTabIds = await getCorporateOwnedIds(targetProfileId, 'customTab')
  const unused = [...targetTabs]
  const idMap = new Map<string, string>()
  const nextOwnedTabIds: string[] = []
  const nextOwnedItemIds: string[] = []

  for (const sourceTab of sourceTabs) {
    const match = takeMatchingCustomTab(sourceTab, unused)
    // Prefer rematching an already owner-synced tab; never absorb a member-local tab.
    if (match && ownedTabIds.size > 0 && !ownedTabIds.has(match.id)) {
      unused.push(match)
      // Fall through to create a fresh owner-synced tab instead.
    }
    const useMatch = match && (ownedTabIds.size === 0 || ownedTabIds.has(match.id)) ? match : null
    const targetTab =
      useMatch ||
      (await prisma.customTab.create({
        data: {
          profileId: targetProfileId,
          key: sourceTab.key.startsWith('custom-tab-') ? `custom-tab-${randomBytes(6).toString('hex')}` : sourceTab.key,
          label: sourceTab.label,
          slug: sourceTab.slug,
          description: sourceTab.description,
          icon: sourceTab.icon,
          sortOrder: sourceTab.sortOrder,
          isEnabled: sourceTab.isEnabled,
          isPublic: sourceTab.isPublic,
          status: sourceTab.status,
          layoutType: sourceTab.layoutType,
          settings: sourceTab.settings === null ? undefined : (sourceTab.settings as Prisma.InputJsonValue),
        },
      }))

    if (useMatch) {
      await prisma.customTab.update({
        where: { id: targetTab.id },
        data: {
          label: sourceTab.label,
          slug: sourceTab.slug,
          description: sourceTab.description,
          icon: sourceTab.icon,
          sortOrder: sourceTab.sortOrder,
          isEnabled: sourceTab.isEnabled,
          isPublic: sourceTab.isPublic,
          status: sourceTab.status,
          layoutType: sourceTab.layoutType,
          settings: sourceTab.settings === null ? undefined : (sourceTab.settings as Prisma.InputJsonValue),
        },
      })
    }

    nextOwnedTabIds.push(targetTab.id)
    idMap.set(sourceTab.id, targetTab.id)
    if (sourceTab.key) idMap.set(sourceTab.key, targetTab.key)

    const ownedItemIds = await getCorporateOwnedIds(targetProfileId, 'customTabItem')
    if (ownedItemIds.size > 0) {
      await prisma.customTabItem.updateMany({
        where: { customTabId: targetTab.id, id: { in: [...ownedItemIds] }, status: { not: '0' } },
        data: { status: '0' },
      })
    } else {
      // Soft-retire prior items (keep rows for recovery); then add the source copy as live.
      await prisma.customTabItem.updateMany({
        where: { customTabId: targetTab.id, status: { not: '0' } },
        data: { status: '0' },
      })
    }
    for (const item of sourceTab.items) {
      const createdItem = await prisma.customTabItem.create({
        data: {
          customTabId: targetTab.id,
          profileId: targetProfileId,
          title: item.title,
          description: item.description,
          url: item.url,
          featuredImage: item.featuredImage,
          sortOrder: item.sortOrder,
          status: item.status === '0' ? '1' : item.status,
          data: item.data === null ? undefined : (item.data as Prisma.InputJsonValue),
        },
      })
      nextOwnedItemIds.push(createdItem.id)
    }
  }

  // Only retire previously owner-synced tabs that no longer match — keep member-local tabs.
  const retireIds =
    ownedTabIds.size > 0
      ? unused.filter((tab) => ownedTabIds.has(tab.id)).map((tab) => tab.id)
      : unused.map((tab) => tab.id)
  if (retireIds.length) {
    await prisma.customTab.updateMany({
      where: { id: { in: retireIds } },
      data: { status: '0', isEnabled: false, isPublic: false },
    })
    await prisma.customTabItem.updateMany({
      where: { customTabId: { in: retireIds } },
      data: { status: '0' },
    })
  }

  await setCorporateOwnedIds(targetProfileId, 'customTab', nextOwnedTabIds)
  await setCorporateOwnedIds(targetProfileId, 'customTabItem', nextOwnedItemIds)
  return idMap
}

const copySharedSettings = async (
  sourceProfileId: string,
  targetProfileId: string,
  keys: string[],
  options: SharedSyncOptions = {}
) => {
  const sharedKeys = keys.filter(isSharedSettingKey)
  if (!sharedKeys.length) return

  const needsIdMap = sharedKeys.some(
    (key) => key === 'custom_tabs_json' || key === 'tab_section_meta_json' || key === 'tab_label_overrides_json'
  )
  const idMap = needsIdMap ? await buildCustomTabIdMap(sourceProfileId, targetProfileId) : new Map<string, string>()

  const rows = await prisma.setting.findMany({
    where: { profileId: sourceProfileId, key: { in: sharedKeys } },
    select: { key: true, value: true },
  })
  const sourceMap = new Map(rows.map((row) => [row.key, row.value ?? '']))

  for (const key of sharedKeys) {
    if (key === 'custom_tabs_json') continue
    const raw = sourceMap.get(key)
    if (
      !shouldCopySharedSetting({
        key,
        sourceValue: raw,
        sourceHadValueBeforeWrite: options.settingHadValue?.[key] === true,
      })
    ) {
      continue
    }
    const value =
      key === 'tab_section_meta_json' || key === 'tab_label_overrides_json'
        ? remapSharedSettingIds(raw as string, idMap)
        : (raw as string)
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: targetProfileId, key } },
      create: { profileId: targetProfileId, key, value },
      update: { value },
    })
  }
}

const copySharedProfileFields = async (
  sourceProfileId: string,
  targetProfileId: string,
  keys: string[] | undefined,
  options: SharedSyncOptions = {}
) => {
  const fieldKeys = (keys?.length ? keys : [...SHARED_DUPLICATE_PROFILE_FIELDS]).filter(isCorporateLiveSyncProfileField)
  if (!fieldKeys.length) return

  const select = Object.fromEntries(fieldKeys.map((key) => [key, true]))
  const source = await prisma.profile.findUnique({
    where: { id: sourceProfileId },
    select,
  })
  if (!source) return

  const data: Record<string, unknown> = {}
  const sourceRow = source as Record<string, unknown>
  for (const key of fieldKeys) {
    const value = sourceRow[key]
    if (!isSharedProfileFieldValuePresent(value) && options.allowEmpty !== true) continue
    data[key] = value ?? null
  }
  if (!Object.keys(data).length) return

  await prisma.profile.update({
    where: { id: targetProfileId },
    data,
  })
}

const copySharedProfileSettings = async (
  sourceProfileId: string,
  targetProfileId: string,
  options: SharedSyncOptions = {}
) => {
  const source = await prisma.profileSetting.findUnique({
    where: { profileId: sourceProfileId },
  })
  if (!source) return
  const hasTheme =
    source.themeConfig != null &&
    typeof source.themeConfig === 'object' &&
    Object.keys(source.themeConfig as Record<string, unknown>).length > 0
  if (!hasTheme && !source.layoutStyle && !source.buttonStyle && !source.cornerStyle && options.allowEmpty !== true) {
    if (!source.profileTemplate) return
  }

  await prisma.profileSetting.upsert({
    where: { profileId: targetProfileId },
    create: {
      profileId: targetProfileId,
      profileTemplate: source.profileTemplate || 'v3',
      layoutStyle: source.layoutStyle,
      buttonStyle: source.buttonStyle,
      cornerStyle: source.cornerStyle,
      themeConfig: source.themeConfig === null ? undefined : (source.themeConfig as Prisma.InputJsonValue),
    },
    update: {
      profileTemplate: source.profileTemplate || 'v3',
      layoutStyle: source.layoutStyle,
      buttonStyle: source.buttonStyle,
      cornerStyle: source.cornerStyle,
      themeConfig: source.themeConfig === null ? undefined : (source.themeConfig as Prisma.InputJsonValue),
    },
  })

  if (source.themeConfig !== undefined) {
    await prisma.profile.update({
      where: { id: targetProfileId },
      data: { themeConfig: source.themeConfig === null ? undefined : (source.themeConfig as Prisma.InputJsonValue) },
    })
  }
}

const applyCustomTabsJson = async (sourceProfileId: string, siblingId: string, options: SharedSyncOptions = {}) => {
  const sourceJson = await prisma.setting.findFirst({
    where: { profileId: sourceProfileId, key: 'custom_tabs_json' },
    select: { value: true },
  })
  const allowEmpty = options.allowEmpty === true
  const idMap = await replaceCustomTabs(sourceProfileId, siblingId, { ...options, allowEmpty })
  if (
    !shouldCopySharedSetting({
      key: 'custom_tabs_json',
      sourceValue: sourceJson?.value ?? undefined,
      sourceHadValueBeforeWrite: options.settingHadValue?.custom_tabs_json === true,
    })
  ) {
    return
  }
  if (sourceJson?.value == null) return
  await prisma.setting.upsert({
    where: { profileId_key: { profileId: siblingId, key: 'custom_tabs_json' } },
    create: {
      profileId: siblingId,
      key: 'custom_tabs_json',
      value: remapSharedSettingIds(sourceJson.value, idMap),
    },
    update: { value: remapSharedSettingIds(sourceJson.value, idMap) },
  })
}

const applyScopeToSibling = async (
  sourceProfileId: string,
  siblingId: string,
  scope: SharedSyncScope,
  options: SharedSyncOptions = {}
) => {
  if (scope.type === 'collection') {
    for (const model of COLLECTION_MODELS[scope.kind] || []) {
      await replaceModelRows(sourceProfileId, siblingId, model, {}, options)
    }
    return
  }

  if (scope.type === 'storage') {
    const models = STORAGE_EXTRA_MODELS[scope.storage] || [storageToPrismaModel(scope.storage)]
    for (const model of models) {
      await replaceModelRows(sourceProfileId, siblingId, model, {}, options)
    }
    if (scope.tabKey) {
      await replaceModelRows(sourceProfileId, siblingId, 'tabItem', { tabKey: scope.tabKey }, options)
    }
    if (scope.storage === 'about_me') {
      await copySharedSettings(
        sourceProfileId,
        siblingId,
        ['about_me_title', 'about_me_featured_media_url', 'about_me_status', 'about_me_featured_media_focus_y'],
        options
      )
    }
    return
  }

  if (scope.type === 'posts') {
    await replacePosts(sourceProfileId, siblingId, scope.postTypeId, options)
    return
  }

  if (scope.type === 'aboutMe') {
    await replaceAboutMe(sourceProfileId, siblingId, options)
    return
  }

  if (scope.type === 'customTabs') {
    await applyCustomTabsJson(sourceProfileId, siblingId, options)
    return
  }

  if (scope.type === 'settings') {
    if (scope.keys.includes('custom_tabs_json')) {
      await applyCustomTabsJson(sourceProfileId, siblingId, options)
    }
    await copySharedSettings(sourceProfileId, siblingId, scope.keys, options)
    return
  }

  if (scope.type === 'profileFields') {
    await copySharedProfileFields(sourceProfileId, siblingId, scope.keys, options)
    return
  }

  if (scope.type === 'profileSettings') {
    await copySharedProfileSettings(sourceProfileId, siblingId, options)
    return
  }

  if (scope.type === 'fullShared') {
    // Business content only — personal info, socials, Card Settings, About Me stay on each card.
    await copySharedProfileFields(sourceProfileId, siblingId, undefined, options)
    const settingRows = await prisma.setting.findMany({
      where: { profileId: sourceProfileId },
      select: { key: true },
    })
    await applyCustomTabsJson(sourceProfileId, siblingId, options)
    await copySharedSettings(
      sourceProfileId,
      siblingId,
      settingRows.map((row) => row.key),
      options
    )
    for (const model of SHARED_DUPLICATE_LIST_MODELS) {
      if (PERSONAL_LIST_MODELS.has(model)) continue
      await replaceModelRows(sourceProfileId, siblingId, model, {}, options)
    }
    await replacePosts(sourceProfileId, siblingId, null, options)
  }
}

export async function syncCorporateSiblingSharedContent(
  sourceProfileId: string,
  scope: SharedSyncScope,
  options: SharedSyncOptions = {}
): Promise<{ siblingCount: number }> {
  if (isCorporateSiblingSyncRunning()) return { siblingCount: 0 }
  // Linked corporate cards sync when a human is logged in (or ops force). Never anonymous/background.
  if (!canRunCorporateSiblingSync(options)) {
    logger.info('corporate sibling sync skipped (no logged-in actor)', {
      sourceProfileId,
      scopeType: scope.type,
    })
    return { siblingCount: 0 }
  }
  // Live path: only the corporate team owner card fans out to team members.
  // Member-card edits stay local (About Me / Personal already excluded below).
  if (options.force !== true) {
    const isOwnerSource = await isCorporateTeamOwnerSourceCard(sourceProfileId)
    if (!isOwnerSource) {
      logger.info('corporate sibling sync skipped (not corporate team owner card)', {
        sourceProfileId,
        scopeType: scope.type,
      })
      return { siblingCount: 0 }
    }
  }
  // Per-card identity / Card Settings — never fan out across linked cards.
  if (scope.type === 'aboutMe') return { siblingCount: 0 }
  if (scope.type === 'profileSettings') return { siblingCount: 0 }
  if (scope.type === 'storage' && isPersonalStorage(scope.storage)) return { siblingCount: 0 }
  if (scope.type === 'collection' && !shouldFanOutCollection(scope.kind)) return { siblingCount: 0 }
  if (scope.type === 'settings') {
    const keys = scope.keys.filter(isSharedSettingKey)
    if (!keys.length) return { siblingCount: 0 }
    scope = { ...scope, keys }
  }
  if (scope.type === 'profileFields') {
    const keys = (scope.keys?.length ? scope.keys : [...SHARED_DUPLICATE_PROFILE_FIELDS]).filter(
      isCorporateLiveSyncProfileField
    )
    if (!keys.length) return { siblingCount: 0 }
    scope = { ...scope, keys }
  }

  const siblingIds = await listCorporateSiblingProfileIds(sourceProfileId)
  if (!siblingIds.length) return { siblingCount: 0 }

  const actor = getCardChangeActor()
  const sourceCard = await prisma.profile.findUnique({
    where: { id: sourceProfileId },
    select: { id: true, slug: true, name: true },
  })
  const sourceLabel = sourceCard?.name?.trim() || sourceCard?.slug?.trim() || `card ${sourceProfileId.slice(-8)}`
  const sourceSlug = sourceCard?.slug?.trim() || ''
  const resolvedOptions: SharedSyncOptions = {
    allowEmpty: options.allowEmpty === true,
    settingHadValue: options.settingHadValue,
    force: options.force === true,
  }
  const scopeLabel =
    scope.type === 'collection'
      ? scope.kind
      : scope.type === 'storage'
        ? scope.storage
        : scope.type === 'settings'
          ? scope.keys.join(',')
          : scope.type
  const syncMeta = {
    syncSourceProfileId: sourceProfileId,
    syncSourceSlug: sourceSlug || undefined,
    syncSourceName: sourceCard?.name?.trim() || undefined,
    syncScope: scopeLabel,
    syncTargetCount: siblingIds.length,
  }

  await syncLock.run(true, async () => {
    for (const siblingId of siblingIds) {
      try {
        await applyScopeToSibling(sourceProfileId, siblingId, scope, resolvedOptions)
        // On team member cards: attribute the update to the corporate team owner source card.
        await recordCardChange({
          profileId: siblingId,
          area: 'sync',
          action: 'sync',
          summary: `Updated from corporate team owner card "${sourceLabel}"${
            sourceSlug ? ` (/${sourceSlug})` : ''
          } — corporate sync of ${scopeLabel}${actor?.email ? ` by ${actor.email}` : ''}.`,
          snapshot: null,
          meta: syncMeta,
        })
      } catch (error) {
        logger.error('corporate sibling shared-tab sync failed', {
          sourceProfileId,
          siblingId,
          scope,
          error,
        })
      }
    }
  })

  // On corporate team owner card: record that this edit was pushed to linked team member cards.
  await recordCardChange({
    profileId: sourceProfileId,
    area: 'sync',
    action: 'sync',
    summary: `Pushed ${scopeLabel} to ${siblingIds.length} corporate team member card${
      siblingIds.length === 1 ? '' : 's'
    } from this corporate team owner card ("${sourceLabel}")${actor?.email ? ` by ${actor.email}` : ''}.`,
    snapshot: null,
    meta: syncMeta,
  })

  return { siblingCount: siblingIds.length }
}

export async function safeSyncCorporateSiblingSharedContent(
  sourceProfileId: string,
  scope: SharedSyncScope,
  options: SharedSyncOptions = {}
): Promise<void> {
  // Live saves: sync only if bindCardChangeContext set a logged-in actor (force stays false here).
  const resolved: SharedSyncOptions = {
    ...options,
    allowEmpty: options.allowEmpty === true,
    force: false,
  }
  try {
    await syncCorporateSiblingSharedContent(sourceProfileId, scope, resolved)
  } catch (error) {
    logger.error('corporate sibling shared-tab sync failed', { sourceProfileId, scope, error })
  }
}
