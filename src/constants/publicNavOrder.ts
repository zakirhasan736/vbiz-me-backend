/**
 * Default create-card / builder tab order (ordering template only).
 * Selected/AI tabs are filtered into this sequence; missing ids are skipped — never “enable all”.
 */
export const CANONICAL_PUBLIC_NAV_IDS = [
  'home',
  'about',
  'mission',
  'services',
  'gallery',
  'videos',
  'reviews',
  'bbb',
  'faq',
  'education',
  'work',
  'skills',
  'blog',
  'profile',
  'certificates',
  'resume',
  'content-media',
] as const

export const PINNED_END_NAV_IDS = ['public-cards', 'my-info'] as const

/** Keep this card's current saved tab order instead of applying the default list. */
export const PRESERVE_CUSTOM_NAV_SLUGS = new Set(['michaelangelo-casanova-2'])

const CANONICAL_PUBLIC_NAV_SET = new Set<string>(CANONICAL_PUBLIC_NAV_IDS)
const PINNED_END_NAV_SET = new Set<string>(PINNED_END_NAV_IDS)

function uniqueNavIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.trim())))
}

function ensureRequiredNavIds(ids: string[]): string[] {
  const next = uniqueNavIds(ids)
  if (!next.includes('home')) next.unshift('home')
  if (!next.includes('about')) {
    const homeIndex = next.indexOf('home')
    next.splice(homeIndex >= 0 ? homeIndex + 1 : 1, 0, 'about')
  }
  return next
}

/**
 * Sort enabled tabs by the default catalog order; skip missing catalog tabs.
 * Unknown / industry extras keep relative input order after catalog tabs.
 * Always ends with Public Cards, then My Info.
 */
export function applyCanonicalPublicNavOrder(ids: string[]): string[] {
  return assemblePublicNavOrder(ids, { preserveCustom: false })
}

export function assemblePublicNavOrder(ids: string[], options?: { preserveCustom?: boolean }): string[] {
  const unique = ensureRequiredNavIds(ids)
  const middle = unique.filter((id) => !PINNED_END_NAV_SET.has(id))
  if (options?.preserveCustom) {
    return [...middle, ...PINNED_END_NAV_IDS]
  }
  const canonical = CANONICAL_PUBLIC_NAV_IDS.filter((id) => middle.includes(id))
  const extras = middle.filter((id) => !CANONICAL_PUBLIC_NAV_SET.has(id))
  return [...canonical, ...extras, ...PINNED_END_NAV_IDS]
}

/** Merge every enabled tab into the saved order, then apply default or preserved order. */
export function mergeEnabledNavOrder(
  savedIds: string[],
  enabledIds: string[],
  options?: { preserveCustom?: boolean }
): string[] {
  return assemblePublicNavOrder(uniqueNavIds([...savedIds, ...enabledIds]), options)
}

export function shouldPreserveCustomNavOrder(slug?: string | null, customized?: boolean): boolean {
  if (customized) return true
  const key = String(slug || '')
    .trim()
    .toLowerCase()
  return PRESERVE_CUSTOM_NAV_SLUGS.has(key)
}

export function canonicalPublicNavRank(navId: string): number {
  const index = (CANONICAL_PUBLIC_NAV_IDS as readonly string[]).indexOf(navId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}
