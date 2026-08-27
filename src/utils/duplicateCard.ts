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

/** Contact fields copied on duplicate; uniqueness is not re-checked. Identity fields stay blank. */
export function duplicateContactFields(source: { email?: string | null }) {
  return {
    email: source.email || '',
  }
}

export type DuplicatedIdentityFields = {
  name: string
  lastName: null
  slug: null
  dob: null
}

export function blankDuplicatedIdentityFields(): DuplicatedIdentityFields {
  return {
    name: '',
    lastName: null,
    slug: null,
    dob: null,
  }
}

function newCustomTabId(): string {
  return `custom-tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Custom tab ids are globally unique. Rewrite them in copied settings so the draft
 * does not collide with the source card, and keep editor nav order in sync.
 */
export function remapDuplicatedCardSettings(settings: Record<string, string>): Record<string, string> {
  const next = { ...settings }
  const idMap = new Map<string, string>()
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
  if (rawDisplay?.trim() && idMap.size) {
    try {
      const parsed = JSON.parse(rawDisplay) as { editorNavOrder?: unknown }
      if (Array.isArray(parsed.editorNavOrder)) {
        parsed.editorNavOrder = parsed.editorNavOrder.map((id) =>
          typeof id === 'string' && idMap.has(id) ? idMap.get(id) : id
        )
        next.display_settings_json = JSON.stringify(parsed)
      }
    } catch {
      // Keep original display settings if they are not parseable.
    }
  }

  return next
}
