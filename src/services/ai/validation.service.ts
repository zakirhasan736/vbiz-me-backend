import { z } from 'zod'
import { minCardAgeCutoffDate } from '../../utils/cardActivation'
import type { MasterBusinessProfile } from './businessProfile.schema'
import { TAB_CATALOG, cardBlueprintSchema, type CardBlueprint, type FillSectionId } from './cardBlueprint.schema'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/\S*)?$/i
const CATALOG_NAMES = new Set(TAB_CATALOG.map((t) => t.name))
const CATALOG_NAV = new Set(TAB_CATALOG.map((t) => t.navId))

export type ValidationIssue = { code: string; message: string; field?: string }

export function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim())
}

export function looksLikeUrl(value: string): boolean {
  return URL_RE.test(value.trim())
}

export function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15
}

export function looksLikeDateOnly(value: string): boolean {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized
}

function stripSampleReviews(blueprint: CardBlueprint): CardBlueprint {
  const reviews = (blueprint.reviews || []).filter((row) => {
    const blob = `${row.author} ${row.text}`.toLowerCase()
    if (blob.includes('draft / sample') || blob.includes('[sample]')) return false
    if (/^sample (client|customer|reviewer)/i.test(row.author || '')) return false
    return Boolean((row.author || '').trim() || (row.text || '').trim())
  })
  return { ...blueprint, reviews }
}

function dedupeServices(blueprint: CardBlueprint): CardBlueprint {
  const seen = new Set<string>()
  const services = (blueprint.services || []).filter((s) => {
    const key = `${s.title}`.trim().toLowerCase()
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ...blueprint, services }
}

export function sanitizeBlueprint(raw: unknown): { blueprint: CardBlueprint; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  let parsed: CardBlueprint
  try {
    parsed = cardBlueprintSchema.parse(raw)
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw err
    }
    throw err
  }

  parsed = stripSampleReviews(parsed)
  parsed = dedupeServices(parsed)

  if (parsed.personal.email && !looksLikeEmail(parsed.personal.email)) {
    issues.push({ code: 'invalid_email', field: 'personal.email', message: 'Email format looks invalid.' })
    parsed = { ...parsed, personal: { ...parsed.personal, email: '' } }
  }
  if (parsed.personal.website && !looksLikeUrl(parsed.personal.website) && !parsed.personal.website.includes('.')) {
    issues.push({ code: 'invalid_url', field: 'personal.website', message: 'Website URL looks invalid.' })
    parsed = { ...parsed, personal: { ...parsed.personal, website: '' } }
  }
  if (parsed.personal.phone && !looksLikePhone(parsed.personal.phone)) {
    issues.push({ code: 'invalid_phone', field: 'personal.phone', message: 'Phone format looks incomplete.' })
  }
  if (parsed.personal.dob && !looksLikeDateOnly(parsed.personal.dob)) {
    issues.push({
      code: 'invalid_date_of_birth',
      field: 'personal.dob',
      message: 'Please enter a valid date of birth (YYYY-MM-DD).',
    })
    parsed = { ...parsed, personal: { ...parsed.personal, dob: '' } }
  } else if (parsed.personal.dob && parsed.personal.dob > minCardAgeCutoffDate()) {
    issues.push({
      code: 'underage_date_of_birth',
      field: 'personal.dob',
      message: 'You must be at least 12 years old.',
    })
    parsed = { ...parsed, personal: { ...parsed.personal, dob: '' } }
  }

  const enabledTabs = (parsed.enabledTabs || []).filter((name) => CATALOG_NAMES.has(name))
  const dropped = (parsed.enabledTabs || []).filter((name) => !CATALOG_NAMES.has(name))
  for (const name of dropped) {
    issues.push({ code: 'unsupported_tab', field: 'enabledTabs', message: `Dropped unsupported tab “${name}”.` })
  }

  const recommendedTabs = (parsed.recommendedTabs || []).filter((row) => CATALOG_NAMES.has(row.tab))

  const about = parsed.personal.about || ''
  if (about.length > 4000) {
    parsed = { ...parsed, personal: { ...parsed.personal, about: about.slice(0, 4000) } }
    issues.push({ code: 'truncated', field: 'personal.about', message: 'About text was truncated.' })
  }

  return { blueprint: { ...parsed, enabledTabs, recommendedTabs }, issues }
}

export function assertSupportedSection(section: string): section is FillSectionId {
  return [
    'services',
    'blogs',
    'portfolio',
    'reviews',
    'skills',
    'education',
    'experience',
    'faqs',
    'personal',
    'seo',
  ].includes(section)
}

export function filterRealReviews<T extends { author?: string; text?: string; isSample?: boolean; label?: string }>(
  rows: T[] | undefined
): T[] {
  return (rows || []).filter((row) => {
    if (row.isSample) return false
    if (
      String(row.label || '')
        .toUpperCase()
        .includes('SAMPLE')
    )
      return false
    const blob = `${row.author || ''} ${row.text || ''}`.toLowerCase()
    if (blob.includes('draft / sample')) return false
    return Boolean(String(row.author || '').trim() || String(row.text || '').trim())
  })
}

export function tabTypeSupported(type: string): boolean {
  return CATALOG_NAV.has(type) || CATALOG_NAMES.has(type)
}

export function profileAllowsClaim(profile: MasterBusinessProfile, claim: string): boolean {
  const hay = JSON.stringify(profile).toLowerCase()
  const tokens = claim
    .toLowerCase()
    .replace(/[^a-z0-9+\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 4)
  if (!tokens.length) return true
  const hits = tokens.filter((t) => hay.includes(t)).length
  return hits / tokens.length >= 0.35
}
