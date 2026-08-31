export function countFilledSocialLinks(items: Array<{ name?: unknown; url?: unknown }> | undefined | null): number {
  return (items || []).filter((item) => {
    const name = String(item?.name ?? '').trim()
    const url = String(item?.url ?? '').trim()
    return Boolean(name || url)
  }).length
}

export function countFilledExtraFields(raw: string | null | undefined): number {
  if (!raw?.trim()) return 0
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return 0
    return parsed.filter((row) => {
      if (!row || typeof row !== 'object') return false
      const record = row as { name?: unknown; value?: unknown }
      const name = String(record.name ?? '').trim()
      const value = String(record.value ?? '').trim()
      return Boolean(name || value)
    }).length
  } catch {
    return 0
  }
}

/** Builder uploads are not package-capped. */
export function maxUploadBytes(_packageLimitMb?: number | null | undefined): number {
  return Number.MAX_SAFE_INTEGER
}

/** Reject only writes that raise the filled count above the package cap. Existing over-limit content can be saved unchanged. */
export function allowsCountWrite(currentFilled: number, nextFilled: number, limit: number | null | undefined): boolean {
  if (limit == null) return true
  if (nextFilled <= currentFilled) return true
  return nextFilled <= limit
}

export function canCreateAnotherCard(existingCount: number, maxCards: number | null | undefined): boolean {
  if (maxCards == null) return true
  return existingCount < maxCards
}

export function remainingCardSlots(existingCount: number, maxCards: number | null | undefined): number | null {
  if (maxCards == null) return null
  return Math.max(0, maxCards - existingCount)
}
