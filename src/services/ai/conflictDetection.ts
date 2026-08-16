import type { MasterBusinessProfile } from './businessProfile.schema'

const PHONE_DIGITS = (value: string) => value.replace(/\D/g, '')

function norm(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function similar(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.includes(nb) || nb.includes(na)) return true
  const da = PHONE_DIGITS(a)
  const db = PHONE_DIGITS(b)
  if (da.length >= 7 && db.length >= 7 && (da.endsWith(db.slice(-7)) || db.endsWith(da.slice(-7)))) return true
  return false
}

export type DetectedConflict = {
  conflict: true
  field: string
  values: Array<{ value: string; source: string; sourceUrl?: string }>
}

/**
 * Detect obvious contradictions between website vs documents vs typed notes.
 * Does not silently pick a winner.
 */
export function detectSourceConflicts(input: {
  websiteText?: string
  documentTexts?: Array<{ label: string; text: string }>
  manualText?: string
  profile?: MasterBusinessProfile | null
}): DetectedConflict[] {
  if (input.profile?.conflicts?.length) {
    return input.profile.conflicts.map((c) => ({
      conflict: true as const,
      field: c.field,
      values: c.values.map((v) => ({
        value: String(v.value),
        source: v.source || 'unknown',
        sourceUrl: v.sourceUrl,
      })),
    }))
  }

  const conflicts: DetectedConflict[] = []
  const website = input.websiteText || ''
  const docs = (input.documentTexts || []).map((d) => `${d.label}\n${d.text}`).join('\n')
  const manual = input.manualText || ''

  const yearFrom = (text: string) => {
    const m = text.match(/(\d{1,2})\s*\+?\s*years?\s+(?:of\s+)?(?:experience|in business|serving)/i)
    return m ? m[1] : null
  }

  const wy = yearFrom(website)
  const dy = yearFrom(docs)
  if (wy && dy && wy !== dy) {
    conflicts.push({
      conflict: true,
      field: 'yearsInBusiness',
      values: [
        { value: wy, source: 'website' },
        { value: dy, source: 'document' },
      ],
    })
  }

  const phones = [
    { source: 'website', value: website.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/)?.[0] },
    { source: 'document', value: docs.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/)?.[0] },
    { source: 'manual', value: manual.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/)?.[0] },
  ].filter((p): p is { source: string; value: string } => Boolean(p.value))

  if (phones.length >= 2) {
    const a = PHONE_DIGITS(phones[0].value)
    const disagree = phones.filter((p) => {
      const d = PHONE_DIGITS(p.value)
      return d.length >= 7 && a.length >= 7 && !similar(d, a)
    })
    if (disagree.length) {
      conflicts.push({
        conflict: true,
        field: 'phone',
        values: phones.map((p) => ({ value: p.value, source: p.source })),
      })
    }
  }

  return conflicts
}

export function profileHasUnresolvedConflicts(profile: MasterBusinessProfile | null | undefined): boolean {
  return Boolean(profile?.conflicts?.length)
}
