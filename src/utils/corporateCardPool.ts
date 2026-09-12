/** Distinct seat-pool cards per corporate account (owner userId or companyUserId). */
export function tallyCorporatePoolCards(
  accountIds: string[],
  profiles: Array<{ id: string; userId?: string | null; companyUserId?: string | null }>
): Map<string, number> {
  const ids = [...new Set(accountIds.map((id) => id.trim()).filter(Boolean))]
  const map = new Map<string, number>()
  for (const id of ids) map.set(id, 0)
  if (!ids.length) return map

  for (const id of ids) {
    const seen = new Set<string>()
    for (const profile of profiles) {
      if (profile.userId === id || profile.companyUserId === id) seen.add(profile.id)
    }
    map.set(id, seen.size)
  }
  return map
}
