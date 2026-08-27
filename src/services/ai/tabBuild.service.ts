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
  reviews: 'reviews',
  skills: 'skills',
}

const AUTO_FILL_KEYS = new Set(['about', 'designation', 'services', 'skills'])
const LIST_SPECIALS = new Set(['faq', 'blog', 'reviews'])
const LIST_FIELD_KEYS = new Set(['faqs', 'blogs', 'reviews'])

export function capGeneratedList(value: unknown, max = MAX_GENERATED_ITEMS): unknown {
  if (!Array.isArray(value)) return value
  return value.slice(0, max)
}

export function listLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function itemMergeKey(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item || '')
  const rec = item as Record<string, unknown>
  return [rec.id, rec.question, rec.answer, rec.title, rec.description, rec.author, rec.text]
    .map((part) =>
      String(part || '')
        .trim()
        .toLowerCase()
    )
    .join('|')
}

export function mergeGeneratedList(existing: unknown, generated: unknown, max = MAX_GENERATED_ITEMS): unknown[] {
  const prior = Array.isArray(existing) ? existing : []
  const next = Array.isArray(generated) ? generated : []
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of [...prior, ...next]) {
    if (out.length >= max) break
    const key = itemMergeKey(item)
    const blank = !key.replace(/\|/g, '')
    if (!blank && seen.has(key)) continue
    if (!blank) seen.add(key)
    out.push(item)
  }
  return out
}

export function capGeneratedSkills(value: unknown, max = MAX_GENERATED_ITEMS): unknown {
  if (!Array.isArray(value)) return value
  let remaining = max
  const groups: Array<Record<string, unknown>> = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || remaining <= 0) continue
    const group = raw as Record<string, unknown>
    const skills = Array.isArray(group.skills)
      ? group.skills
          .map((skill) => String(skill || '').trim())
          .filter(Boolean)
          .slice(0, remaining)
      : []
    if (!skills.length) continue
    groups.push({ ...group, skills })
    remaining -= skills.length
  }
  return groups
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

function isListContentField(field: AiCardField) {
  return LIST_SPECIALS.has(field.special || '') || LIST_FIELD_KEYS.has(field.fieldKey)
}

export function applySectionPayloadToFields(
  fields: AiCardField[],
  section: FillSectionId,
  payload: unknown
): AiCardField[] {
  const value = extractSectionValue(section, payload)
  if (!present(value)) return fields
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
    const capped =
      section === 'faqs' || section === 'blogs' || section === 'reviews'
        ? mergeGeneratedList(field.currentValue, capGeneratedList(value))
        : section === 'skills'
          ? capGeneratedSkills(value)
          : value
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
  includePermissioned?: { faq?: boolean; blog?: boolean; reviews?: boolean }
) {
  if (!selected.has(field.tabId)) return false
  if (!field.aiGenerationAllowed) return false
  if (field.special === 'credentials') return false
  if (field.special === 'portfolio' && field.status === 'EMPTY') return false
  if (isListContentField(field)) {
    if (field.special === 'faq' && includePermissioned?.faq === false) return false
    if (field.special === 'blog' && includePermissioned?.blog === false) return false
    if (field.special === 'reviews' && includePermissioned?.reviews === false) return false
    return listLength(field.currentValue) < MAX_GENERATED_ITEMS
  }
  if (field.status !== 'EMPTY' && field.status !== 'PARTIAL') return false
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
    section === 'reviews' ||
    section === 'services' ||
    section === 'skills' ||
    section === 'personal'
  ) {
    const existingLen = listLength(input.field.currentValue)
    const remaining = Math.max(0, MAX_GENERATED_ITEMS - existingLen)
    if ((section === 'faqs' || section === 'blogs' || section === 'reviews') && remaining <= 0) {
      return input.field.currentValue
    }
    const instruction =
      section === 'faqs'
        ? `Create ${remaining || MAX_GENERATED_ITEMS} helpful FAQs from verified services and business topics. Do not invent prices, hours, guarantees, certifications, turnaround times, or service areas. Do not duplicate existing FAQs.`
        : section === 'blogs'
          ? `Draft ${remaining || MAX_GENERATED_ITEMS} evergreen educational articles from verified expertise. Do not invent news events, dates, or awards. Do not duplicate existing posts.`
          : section === 'reviews'
            ? `Write ${remaining || MAX_GENERATED_ITEMS} realistic example testimonials from business topics when no scraped reviews exist. Do not invent licenses, prices, or awards. Do not duplicate existing reviews.`
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
    const generated = extractSectionValue(section, payload)
    if (section === 'faqs' || section === 'blogs' || section === 'reviews') {
      return mergeGeneratedList(input.field.currentValue, generated)
    }
    return generated
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
  includePermissioned?: { faq?: boolean; blog?: boolean; reviews?: boolean }
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
      const value =
        field.special === 'faq' || field.special === 'blog' || field.special === 'reviews'
          ? mergeGeneratedList(field.currentValue, capGeneratedList(generated))
          : field.fieldKey === 'skills'
            ? capGeneratedSkills(generated)
            : generated
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
