import { assemblePublicNavOrder } from '../constants/publicNavOrder'

const CLONE_OMIT = new Set([
  'id',
  'legacyId',
  'legacyPostId',
  'legacyServiceId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'profileId',
  'profile',
  'customTab',
  'customTabId',
  'items',
  'attachments',
  'metasRelation',
  'post',
  'postId',
  'menu',
  'menuId',
])

function isPlainJson(value: unknown): boolean {
  if (value === null || value instanceof Date) return true
  if (Array.isArray(value)) return true
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

/** Copy a Prisma row for insert on another profile. Drops ids, timestamps, and relations. */
export function cloneRecord(row: Record<string, unknown>, extraOmit: string[] = []): Record<string, unknown> {
  const skip = extraOmit.length ? new Set([...CLONE_OMIT, ...extraOmit]) : CLONE_OMIT
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (skip.has(key)) continue
    // Omit null so Prisma/DB defaults apply (status, sortOrder, updatedAt, NOT NULL live columns).
    if (value === null) continue
    if (typeof value === 'object' && !isPlainJson(value) && !(value instanceof Date)) continue
    data[key] = value
  }
  return data
}

/** Prisma validation errors name unknown create() fields in backticks. */
export function unknownPrismaCreateArgs(error: unknown): string[] {
  const message = String((error as { message?: string })?.message || '')
  const names = [...message.matchAll(/Unknown argument `([^`]+)`/gi)].map((match) => match[1])
  return [...new Set(names.filter(Boolean))]
}

export function omitCloneKeys(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  if (!keys.length) return data
  const skip = new Set(keys)
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!skip.has(key)) next[key] = value
  }
  return next
}

/** Personal / identity fields that must not copy onto a duplicated card. */
export type DuplicatedIdentityFields = {
  name: string
  lastName: null
  slug: null
  dob: null
  email: string
  phone: null
  genderId: null
}

export function blankDuplicatedIdentityFields(): DuplicatedIdentityFields {
  return {
    name: '',
    lastName: null,
    slug: null,
    dob: null,
    email: '',
    phone: null,
    genderId: null,
  }
}

/** Keep the source owner's card on their list — never stamp the duplicating admin as owner. */
export function duplicatedCardOwnership(
  source: {
    userId?: string | null
    companyUserId?: string | null
    createdById?: string | null
  },
  actorUserId: string
): {
  userId: string | null
  companyUserId: string | null
  createdById: string | null
} {
  const ownerId = source.userId || null
  const companyId = source.companyUserId || null
  const createdBy = source.createdById || null
  const actorOwnsSource = Boolean(actorUserId) && (ownerId === actorUserId || companyId === actorUserId)
  if (actorOwnsSource) {
    return {
      userId: ownerId,
      companyUserId: companyId,
      createdById: createdBy || ownerId,
    }
  }
  return {
    userId: ownerId,
    companyUserId: companyId === actorUserId ? null : companyId,
    createdById: createdBy && createdBy !== actorUserId ? createdBy : ownerId,
  }
}

/** Copy every setting key, including empty/null values the editor still expects. */
export function settingsMapFromRows(
  settings: Array<{ key?: unknown; value?: unknown } | null | undefined>
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const item of settings) {
    if (!item || typeof item.key !== 'string' || !item.key.trim()) continue
    const value = item.value
    map[item.key] = typeof value === 'string' ? value : value == null ? '' : String(value)
  }
  return map
}

/** Prisma findMany/select errors name unknown fields in backticks. */
export function unknownPrismaSelectFields(error: unknown): string[] {
  const message = String((error as { message?: string })?.message || '')
  const names = [...message.matchAll(/Unknown (?:field|argument) `([^`]+)`/gi)].map((match) => match[1])
  const column =
    message.match(/column [`'](?:[\w.]+\.)?(\w+)[`']/i)?.[1] ||
    message.match(/The column `([^`]+)` does not exist/i)?.[1]
  if (column) names.push(column.includes('.') ? column.split('.').pop() || column : column)
  return [...new Set(names.filter(Boolean))]
}

export const POST_STYLE_CLONE_SELECT = {
  id: true,
  profileId: true,
  title: true,
  description: true,
  url: true,
  featuredImage: true,
  status: true,
  sortOrder: true,
  attachmentUrl: true,
  attachmentName: true,
  metas: true,
  tabKey: true,
} as const

function stripDuplicatedMyInfoContacts(settings: Record<string, string>): void {
  const raw = settings.my_info_json
  if (!raw?.trim()) return
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const next = parsed as Record<string, unknown>
    next.phone = ''
    next.email = ''
    settings.my_info_json = JSON.stringify(next)
  } catch {
    // Keep original JSON if it is not parseable.
  }
}

function newCustomTabId(): string {
  return `custom-tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Custom tab ids are globally unique. Rewrite them in copied settings so the draft
 * does not collide with the source card, and keep editor nav order in sync.
 */
export function remapDuplicatedCardSettings(
  settings: Record<string, string>,
  sourceProfileId?: string,
  customTabIdMap?: Map<string, string>
): Record<string, string> {
  const next = { ...settings }
  const idMap = customTabIdMap || new Map<string, string>()
  const rawTabs = next.custom_tabs_json
  if (rawTabs?.trim()) {
    try {
      const parsed = JSON.parse(rawTabs) as unknown
      if (Array.isArray(parsed)) {
        const remapped = parsed.map((tab) => {
          if (!tab || typeof tab !== 'object') return tab
          const row = { ...(tab as Record<string, unknown>) }
          const oldId = typeof row.id === 'string' ? row.id.trim() : ''
          const nextId = oldId.startsWith('custom-tab-') ? newCustomTabId() : oldId || newCustomTabId()
          if (oldId) idMap.set(oldId, nextId)
          row.id = nextId
          if (Array.isArray(row.items)) {
            row.items = row.items.map((item) => {
              if (!item || typeof item !== 'object') return item
              const nextItem = { ...(item as Record<string, unknown>) }
              delete nextItem.id
              return nextItem
            })
          }
          return row
        })
        next.custom_tabs_json = JSON.stringify(remapped)
      }
    } catch {
      // Keep original JSON if it is not parseable.
    }
  }

  const rawDisplay = next.display_settings_json
  try {
    const parsed = rawDisplay?.trim()
      ? (JSON.parse(rawDisplay) as { editorNavOrder?: unknown; navOrderCustomized?: unknown })
      : { editorNavOrder: [] as string[] }
    const order = Array.isArray(parsed.editorNavOrder) ? parsed.editorNavOrder : []
    parsed.editorNavOrder = assemblePublicNavOrder(
      order
        .map((id) => (typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id))
        .filter((id): id is string => typeof id === 'string')
    )
    parsed.navOrderCustomized = false
    next.display_settings_json = JSON.stringify(parsed)
  } catch {
    // Keep original display settings if they are not parseable.
  }

  if (sourceProfileId) next.duplicated_from = sourceProfileId
  stripDuplicatedMyInfoContacts(next)
  return next
}
