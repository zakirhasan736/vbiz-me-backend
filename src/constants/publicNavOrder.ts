/** Default public-card tab order. Missing tabs are skipped; remaining keep this relative order. */
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
] as const

const CANONICAL_PUBLIC_NAV_SET = new Set<string>(CANONICAL_PUBLIC_NAV_IDS)

/**
 * Reorders only the canonical public tabs (Home → FAQ) in their default sequence.
 * Other nav items keep their slots. Example: 1,2,3,4,5,6,8,9 when 7 is missing.
 */
export function applyCanonicalPublicNavOrder(ids: string[]): string[] {
  const present = CANONICAL_PUBLIC_NAV_IDS.filter((id) => ids.includes(id))
  let next = 0
  return ids.map((id) => (CANONICAL_PUBLIC_NAV_SET.has(id) ? present[next++]! : id))
}

export function canonicalPublicNavRank(navId: string): number {
  const index = (CANONICAL_PUBLIC_NAV_IDS as readonly string[]).indexOf(navId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}
