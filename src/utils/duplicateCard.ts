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
  phone: string | null
  genderId: null
}

/** Card-owner identity — unique on every linked / duplicated card. */
export const DUPLICATED_IDENTITY_PROFILE_FIELDS = [
  'name',
  'lastName',
  'slug',
  'dob',
  'email',
  'phone',
  'genderId',
] as const

export type DuplicatedIdentityProfileField = (typeof DUPLICATED_IDENTITY_PROFILE_FIELDS)[number]

/** Shared company content that duplicate copies and linked corporate cards must keep in sync. */
export const SHARED_DUPLICATE_PROFILE_FIELDS = [
  'companyName',
  'designation',
  'website',
  'address',
  'city',
  'state',
  'zipCode',
  'prof',
  'whatsapp',
  'countryCode',
  'facebook',
  'instagram',
  'twitter',
  'tiktok',
  'youtube',
  'rumble',
  'truth',
  'linkedin',
  'pinterest',
  'avatar',
  'colorCode',
  'template',
  'themeConfig',
  'isEmploy',
  'professionId',
  'maritalStatusId',
] as const

export type SharedDuplicateProfileField = (typeof SHARED_DUPLICATE_PROFILE_FIELDS)[number]

export const SHARED_DUPLICATE_PROFILE_FIELD_SET = new Set<string>(SHARED_DUPLICATE_PROFILE_FIELDS)

export function isSharedDuplicateProfileField(key: string): boolean {
  return SHARED_DUPLICATE_PROFILE_FIELD_SET.has(key)
}

/**
 * Live corporate sync must not overwrite these on another linked card.
 * Duplicate-card clone may still seed them; linked-card edits stay per card.
 * Includes Personal Information, Social handles, and Card Settings template/theme.
 */
export const PERSONAL_LIVE_SYNC_PROFILE_FIELDS = new Set([
  'avatar',
  'companyName',
  'designation',
  'website',
  'address',
  'city',
  'state',
  'zipCode',
  'prof',
  'whatsapp',
  'countryCode',
  'facebook',
  'instagram',
  'twitter',
  'tiktok',
  'youtube',
  'rumble',
  'truth',
  'linkedin',
  'pinterest',
  'colorCode',
  'template',
  'themeConfig',
  'professionId',
  'maritalStatusId',
])

export function isCorporateLiveSyncProfileField(key: string): boolean {
  return isSharedDuplicateProfileField(key) && !PERSONAL_LIVE_SYNC_PROFILE_FIELDS.has(key)
}

/** Clone marker only — never overwrite another card's source pointer. */
export const PERSONAL_IDENTITY_SETTING_KEYS = new Set(['duplicated_from'])

/** About Me tab settings — unique per linked card. */
export const ABOUT_ME_SETTING_KEYS = [
  'about_me_title',
  'about_me_featured_media_url',
  'about_me_status',
  'about_me_featured_media_focus_y',
] as const

export function stripAboutMeSettings(settings: Record<string, string>): Record<string, string> {
  const next = { ...settings }
  for (const key of ABOUT_ME_SETTING_KEYS) delete next[key]
  for (const key of Object.keys(next)) {
    if (key.startsWith('about_me_')) delete next[key]
  }
  return next
}

/** My Info contact values that stay on the card owner. WhatsApp and chrome copy. */
export const MY_INFO_PERSONAL_CONTACT_KEYS = ['phone', 'email'] as const

/** Tab / list models duplicate copies onto the new card (not identity). */
export const SHARED_DUPLICATE_LIST_MODELS = [
  'education',
  'experience',
  'service',
  'portfolio',
  'review',
  'skillTag',
  'socialLink',
  'blog',
  'tabItem',
  'gallery',
  'video',
  'bbbAccreditation',
  'licensing',
  'dcp',
  'certificateLicense',
  'faq',
  'calendarSection',
  'propertyListing',
  'profileEvent',
  'mediaPress',
  'missionStatement',
  'menuSection',
  'announcementDirect',
  'joinMyTeam',
  'booking',
  'additionalService',
  'videoLink',
  'inventory',
  'homeSolar',
  'resiliencyProduct',
  'breakfast',
  'lunch',
  'dinner',
  'product',
  'salesPerson',
  'teamMember',
  'client',
  'generalPost',
  'insuranceLicense',
  'videoExplainer',
  'address',
] as const

export function isSharedProfileFieldValuePresent(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (typeof value === 'boolean' || typeof value === 'number') return true
  if (value instanceof Date) return true
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return true
}

/** Copy shared My Info chrome; keep each card's own phone and email. */
export function mergeMyInfoKeepingPersonalContacts(
  sourceJson: string | null | undefined,
  targetJson: string | null | undefined
): string | undefined {
  if (sourceJson == null) return undefined
  try {
    const parsed = JSON.parse(sourceJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sourceJson
    const next = { ...(parsed as Record<string, unknown>) }
    let phone = ''
    let email = ''
    if (targetJson?.trim()) {
      try {
        const target = JSON.parse(targetJson) as unknown
        if (target && typeof target === 'object' && !Array.isArray(target)) {
          const row = target as Record<string, unknown>
          phone = typeof row.phone === 'string' ? row.phone : ''
          email = typeof row.email === 'string' ? row.email : ''
        }
      } catch {
        // Keep blank contacts when the sibling JSON is unreadable.
      }
    }
    next.phone = phone
    next.email = email
    return JSON.stringify(next)
  } catch {
    return sourceJson
  }
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

/** Corporate team member card: member owns the card; corporate account remains the company parent. */
export function corporateMemberCardOwnership(
  corporateUserId: string,
  memberUserId: string
): {
  userId: string
  companyUserId: string
  createdById: string
} {
  return {
    userId: memberUserId,
    companyUserId: corporateUserId,
    createdById: corporateUserId,
  }
}

/** Re-parent an existing card under a corporate account without stealing a distinct member login. */
export function relinkExistingCardToCorporate(input: {
  corporateUserId: string
  corporateEmail?: string | null
  cardEmail?: string | null
  currentUserId?: string | null
}): {
  userId: string
  companyUserId: string
} {
  const corpId = input.corporateUserId.trim()
  const cardEmail = (input.cardEmail || '').trim().toLowerCase()
  const corpEmail = (input.corporateEmail || '').trim().toLowerCase()
  const currentUserId = input.currentUserId?.trim() || ''
  if (cardEmail && corpEmail && cardEmail === corpEmail) {
    return { userId: corpId, companyUserId: corpId }
  }
  if (currentUserId && currentUserId !== corpId) {
    return { userId: currentUserId, companyUserId: corpId }
  }
  return { userId: currentUserId || corpId, companyUserId: corpId }
}

/** Identity for a newly provisioned corporate member card (not a blank clone). */
export function memberDuplicatedIdentityFields(input: {
  name: string
  email: string
  phone?: string | null
}): DuplicatedIdentityFields {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  const phone = typeof input.phone === 'string' ? input.phone.trim() || null : null
  return {
    name,
    lastName: null,
    slug: null,
    dob: null,
    email,
    phone,
    genderId: null,
  }
}

/** Default login password when corporate owners provision a member without a custom one. */
export const CORPORATE_MEMBER_DEFAULT_PASSWORD = 'Secret@vbizme123//'

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
  const merged = mergeMyInfoKeepingPersonalContacts(settings.my_info_json, null)
  if (merged !== undefined) settings.my_info_json = merged
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

  for (const key of ['tab_label_overrides_json', 'tab_section_meta_json'] as const) {
    const raw = next[key]
    if (!raw) continue
    let value = raw
    for (const [oldId, newId] of idMap) {
      if (oldId && newId) value = value.split(oldId).join(newId)
    }
    next[key] = value
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
        .filter((id): id is string => typeof id === 'string'),
      { preserveCustom: true }
    )
    parsed.navOrderCustomized = true
    next.display_settings_json = JSON.stringify(parsed)
  } catch {
    // Keep original display settings if they are not parseable.
  }

  if (sourceProfileId) next.duplicated_from = sourceProfileId
  stripDuplicatedMyInfoContacts(next)
  return next
}
