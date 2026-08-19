import type { MasterBusinessProfile } from './businessProfile.schema'
import { type FillSectionId } from './cardBlueprint.schema'
import { generateSectionFromProfile } from './contentGenerator.service'
import { generateFieldCopy } from './fieldCompletion.service'
import { mergeFieldDecision, type AiCardField } from './fieldGraph.service'

const MAX_GENERATED_ITEMS = 5

const FIELD_TO_SECTION: Partial<Record<string, FillSectionId>> = {
  about: 'personal',
  services: 'services',
  faqs: 'faqs',
  blogs: 'blogs',
  skills: 'skills',
}

const AUTO_FILL_KEYS = new Set(['about', 'designation', 'services', 'skills'])

export function capGeneratedList(value: unknown, max = MAX_GENERATED_ITEMS): unknown {
  if (!Array.isArray(value)) return value
  return value.slice(0, max)
}

export function extractSectionValue(section: FillSectionId, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const rec = payload as Record<string, unknown>
  if (section === 'personal') {
    const personal = rec.personal && typeof rec.personal === 'object' ? (rec.personal as Record<string, unknown>) : rec
    return personal.about ?? rec.about
  }
  if (section === 'seo') return rec.seo
  if (section === 'portfolio') return rec.portfolio
  if (section === 'experience') return rec.experience
  return rec[section]
}

function present(value: unknown): boolean {
  if (value == null) return false
  if (typeof value === 'string') return Boolean(value.trim())
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(present)
  return true
}

export function applySectionPayloadToFields(
  fields: AiCardField[],
  section: FillSectionId,
  payload: unknown
): AiCardField[] {
  const value = extractSectionValue(section, payload)
  if (!present(value)) return fields
  const capped = section === 'faqs' || section === 'blogs' ? capGeneratedList(value) : value
  const matchKeys =
    section === 'personal'
      ? ['about']
      : section === 'portfolio'
        ? ['portfolio']
        : section === 'experience'
          ? ['experience']
          : [section]
  let next = fields
  for (const field of fields) {
    if (!matchKeys.includes(field.fieldKey)) continue
    next = mergeFieldDecision(next, {
      id: field.id,
      currentValue: capped,
      status: 'READY',
      source: 'AI',
      userDecision: true,
    })
  }
  return next
}

function shouldAutoFill(
  field: AiCardField,
  selected: Set<string>,
  includePermissioned?: { faq?: boolean; blog?: boolean }
) {
  if (!selected.has(field.tabId)) return false
  if (field.status !== 'EMPTY' && field.status !== 'PARTIAL') return false
  if (!field.aiGenerationAllowed) return false
  if (field.special === 'reviews' || field.special === 'credentials') return false
  if (field.special === 'portfolio' && field.status === 'EMPTY') return false
  if (field.special === 'faq') return Boolean(includePermissioned?.faq)
  if (field.special === 'blog') return Boolean(includePermissioned?.blog)
  return AUTO_FILL_KEYS.has(field.fieldKey) || field.special === 'services'
}

async function generateForField(input: {
  field: AiCardField
  profile: MasterBusinessProfile
  userId?: string
  sessionId?: string
}): Promise<unknown> {
  const section = FIELD_TO_SECTION[input.field.fieldKey]
  if (
    section === 'faqs' ||
    section === 'blogs' ||
    section === 'services' ||
    section === 'skills' ||
    section === 'personal'
  ) {
    const instruction =
      section === 'faqs'
        ? 'Create up to 5 helpful FAQs from verified services and business facts. Do not invent prices, hours, guarantees, certifications, turnaround times, or service areas.'
        : section === 'blogs'
          ? 'Draft up to 5 evergreen educational articles from verified expertise. Do not invent news events, dates, or awards.'
          : section === 'personal'
            ? 'Write a professional About section from verified facts only.'
            : section === 'services'
              ? 'Keep verified service titles. Write missing descriptions from verified facts. Do not invent prices.'
              : 'Group skills from verified services and experience only.'
    const payload = await generateSectionFromProfile({
      section,
      profile: input.profile,
      instruction,
      userId: input.userId,
      sessionId: input.sessionId,
    })
    return extractSectionValue(section, payload)
  }
  return generateFieldCopy({
    field: input.field,
    profile: input.profile,
    userId: input.userId,
    sessionId: input.sessionId,
  })
}

export async function autoFillSelectedFields(input: {
  fields: AiCardField[]
  selectedNavIds: string[]
  profile: MasterBusinessProfile
  userId?: string
  sessionId?: string
  includePermissioned?: { faq?: boolean; blog?: boolean }
}): Promise<AiCardField[]> {
  const selected = new Set(input.selectedNavIds)
  const targets = input.fields.filter((field) => shouldAutoFill(field, selected, input.includePermissioned))
  let fields = [...input.fields]
  for (const field of targets) {
    try {
      const generated = await generateForField({
        field,
        profile: input.profile,
        userId: input.userId,
        sessionId: input.sessionId,
      })
      const value = field.special === 'faq' || field.special === 'blog' ? capGeneratedList(generated) : generated
      if (!present(value)) continue
      fields = mergeFieldDecision(fields, {
        id: field.id,
        currentValue: value,
        status: 'READY',
        source: 'AI',
        userDecision: true,
      })
    } catch {
      /* leave the field for the owner to skip or fill */
    }
  }
  return fields
}
