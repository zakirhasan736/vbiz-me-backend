import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { Prisma } from '../../generated/prisma/client'
import { isStaffRole, toApiRole } from '../constants/userRole'
import { getEffectiveEntitlements } from '../services/entitlement.service'
import {
  cloneRecord,
  omitCloneKeys,
  POST_STYLE_CLONE_SELECT,
  unknownPrismaCreateArgs,
  unknownPrismaSelectFields,
} from './duplicateCard'
import logger from './logger'
import { prisma } from './prisma'
import {
  isPrismaMissingTable,
  isPrismaSchemaDrift,
  isPrismaTypeMismatch,
  isPrismaUnknownArgument,
} from './prismaErrors'

const syncLock = new AsyncLocalStorage<boolean>()

/** Street/contact address stays on the card owner. Social links are shared. */
export const PERSONAL_COLLECTION_KINDS = new Set(['addresses'])

/** No direct-tab storage is personal — About Me and other tabs fan out. */
export const PERSONAL_STORAGES = new Set<string>()

const PERSONAL_SETTING_KEYS = new Set([
  'avatar',
  'avatar_url',
  'profile_image',
  'profile_image_url',
  'my_info_json',
  'duplicated_from',
])

const PERSONAL_SETTING_PREFIXES: string[] = []

const COLLECTION_MODELS: Record<string, string[]> = {
  education: ['education'],
  experiences: ['experience'],
  services: ['service'],
  portfolios: ['gallery', 'portfolio'],
  reviews: ['review'],
  skillTags: ['skillTag'],
  socialLinks: ['socialLink'],
}

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
  create: (args: { data: Record<string, unknown> }) => Promise<unknown>
}

export type SharedSyncScope =
  | { type: 'collection'; kind: string }
  | { type: 'storage'; storage: string; tabKey?: string }
  | { type: 'posts'; postTypeId?: string | null }
  | { type: 'aboutMe' }
  | { type: 'customTabs' }
  | { type: 'settings'; keys: string[] }

export type SharedSyncOptions = {
  /** When false, an empty source list does not wipe siblings (stale/no-op save). */
  allowEmpty?: boolean
  /** Setting keys that already had a real value on the source card before this write. */
  settingHadValue?: Record<string, boolean>
}

const JSON_SHARED_SETTING_KEYS = new Set([
  'custom_tabs_json',
  'display_settings_json',
  'tab_section_meta_json',
  'tab_label_overrides_json',
])

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
  if (PERSONAL_SETTING_KEYS.has(trimmed)) return false
  return !PERSONAL_SETTING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
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

  const liveRows = rows.filter((row) => !row.deletedAt)
  if (!shouldReplaceSiblingRows(liveRows.length, options.allowEmpty === true)) return

  try {
    await delegate.deleteMany({ where: targetWhere })
  } catch (error) {
    if (isPrismaMissingTable(error)) return
    if (isPrismaUnknownArgument(error) && Object.keys(extraWhere).length) {
      logger.warn(`corporate sibling sync skipped deleteMany extra filter for ${model}`)
      return
    }
    throw error
  }

  for (const row of liveRows) {
    const cloned = cloneRecord(row)
    if ('status' in row && cloned.status === undefined) {
      cloned.status = typeof row.status === 'number' ? 1 : '1'
    }
    if ('sortOrder' in row && cloned.sortOrder === undefined) cloned.sortOrder = 0
    try {
      await createClonedRow(delegate, { ...cloned, profileId: targetProfileId })
    } catch (error) {
      logger.error(`corporate sibling sync failed for ${model}`, error)
    }
  }
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

  await prisma.post.deleteMany({ where: targetWhere })

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
    for (const meta of post.metas) {
      await prisma.postMeta.create({
        data: { postId: created.id, metaKey: meta.metaKey, metaValue: meta.metaValue },
      })
    }
  }
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
    where: { profileId: sourceProfileId },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { sortOrder: 'asc' },
  })
  if (!shouldReplaceSiblingRows(sourceTabs.length, options.allowEmpty === true)) return new Map()
  const targetTabs = await prisma.customTab.findMany({
    where: { profileId: targetProfileId },
    orderBy: { sortOrder: 'asc' },
  })
  const unused = [...targetTabs]
  const idMap = new Map<string, string>()

  for (const sourceTab of sourceTabs) {
    const match = takeMatchingCustomTab(sourceTab, unused)
    const targetTab =
      match ||
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

    if (match) {
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

    idMap.set(sourceTab.id, targetTab.id)
    if (sourceTab.key) idMap.set(sourceTab.key, targetTab.key)

    await prisma.customTabItem.deleteMany({ where: { customTabId: targetTab.id } })
    for (const item of sourceTab.items) {
      await prisma.customTabItem.create({
        data: {
          customTabId: targetTab.id,
          profileId: targetProfileId,
          title: item.title,
          description: item.description,
          url: item.url,
          featuredImage: item.featuredImage,
          sortOrder: item.sortOrder,
          status: item.status,
          data: item.data === null ? undefined : (item.data as Prisma.InputJsonValue),
        },
      })
    }
  }

  if (unused.length) {
    await prisma.customTab.deleteMany({ where: { id: { in: unused.map((tab) => tab.id) } } })
  }

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
    (key) =>
      key === 'custom_tabs_json' ||
      key === 'display_settings_json' ||
      key === 'tab_section_meta_json' ||
      key === 'tab_label_overrides_json'
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
      key === 'display_settings_json' || key === 'tab_section_meta_json' || key === 'tab_label_overrides_json'
        ? remapSharedSettingIds(raw as string, idMap)
        : (raw as string)
    await prisma.setting.upsert({
      where: { profileId_key: { profileId: targetProfileId, key } },
      create: { profileId: targetProfileId, key, value },
      update: { value },
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
  }
}

export async function syncCorporateSiblingSharedContent(
  sourceProfileId: string,
  scope: SharedSyncScope,
  options: SharedSyncOptions = {}
): Promise<{ siblingCount: number }> {
  if (isCorporateSiblingSyncRunning()) return { siblingCount: 0 }
  if (scope.type === 'storage' && isPersonalStorage(scope.storage)) return { siblingCount: 0 }
  if (scope.type === 'collection' && !shouldFanOutCollection(scope.kind)) return { siblingCount: 0 }
  if (scope.type === 'settings') {
    const keys = scope.keys.filter(isSharedSettingKey)
    if (!keys.length) return { siblingCount: 0 }
    scope = { ...scope, keys }
  }

  const siblingIds = await listCorporateSiblingProfileIds(sourceProfileId)
  if (!siblingIds.length) return { siblingCount: 0 }

  const resolvedOptions: SharedSyncOptions = {
    allowEmpty: options.allowEmpty === true,
    settingHadValue: options.settingHadValue,
  }

  await syncLock.run(true, async () => {
    for (const siblingId of siblingIds) {
      try {
        await applyScopeToSibling(sourceProfileId, siblingId, scope, resolvedOptions)
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

  return { siblingCount: siblingIds.length }
}

export async function safeSyncCorporateSiblingSharedContent(
  sourceProfileId: string,
  scope: SharedSyncScope,
  options: SharedSyncOptions = {}
): Promise<void> {
  const resolved: SharedSyncOptions = {
    ...options,
    allowEmpty: options.allowEmpty === true,
  }
  try {
    await syncCorporateSiblingSharedContent(sourceProfileId, scope, resolved)
  } catch (error) {
    logger.error('corporate sibling shared-tab sync failed', { sourceProfileId, scope, error })
  }
}
