/** Pure helpers (no DB) so they can be unit-tested anywhere. */
export function normalizeSlug(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

/** True when a profile update moved the card to a different public address. */
export function isSlugRename(oldSlug: string | null | undefined, newSlug: string | null | undefined): boolean {
  const from = normalizeSlug(oldSlug)
  const to = normalizeSlug(newSlug)
  return Boolean(from && to && from !== to)
}
