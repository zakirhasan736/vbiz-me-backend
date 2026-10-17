import type { FillSectionId } from './cardBlueprint.schema'

/**
 * Merge a regenerated section payload into a full draft without overwriting
 * unrelated approved fields (spec §10 section-specific editing).
 */
export function mergeSectionIntoDraft(
  currentDraft: Record<string, unknown> | null | undefined,
  section: FillSectionId,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(currentDraft || {}) }

  if (section === 'personal') {
    const incoming =
      payload.personal && typeof payload.personal === 'object' ? (payload.personal as Record<string, unknown>) : payload
    const existing =
      base.personal && typeof base.personal === 'object' ? (base.personal as Record<string, unknown>) : {}
    // Only replace keys present in the regeneration payload (preserve dob/email/etc.).
    const nextPersonal = { ...existing }
    for (const [key, value] of Object.entries(incoming)) {
      if (key === 'personal') continue
      if (value === undefined) continue
      if (
        typeof value === 'string' &&
        !value.trim() &&
        typeof existing[key] === 'string' &&
        String(existing[key]).trim()
      ) {
        continue
      }
      nextPersonal[key] = value
    }
    return { ...base, personal: nextPersonal }
  }

  if (section === 'seo') {
    return { ...base, seo: payload.seo ?? payload }
  }

  if (section in payload) {
    return { ...base, [section]: payload[section] }
  }

  // Payload is the array/value itself for some callers.
  if (Array.isArray(payload) || typeof payload !== 'object') {
    return { ...base, [section]: payload }
  }

  return { ...base, ...payload }
}

/** Detect narrow edit instructions that must not trigger full-card regen. */
export function isSectionScopedInstruction(instruction: string): boolean {
  const text = instruction.trim().toLowerCase()
  if (!text) return false
  return (
    /\b(shorten|rewrite|improve|change|update|fix|correct|replace|only|accent|mission|faq|about|service|title|theme|light|dark)\b/.test(
      text
    ) && !/\bentire card|whole card|everything|all sections\b/.test(text)
  )
}
