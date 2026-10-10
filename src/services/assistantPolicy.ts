import AppError from '../error/AppError'
import { FILL_SECTION_SCHEMA_HINTS, fillSectionSchemas, type FillSectionId } from './ai/cardBlueprint.schema'

export const ASSISTANT_SETTING_KEY = 'aiAssistance_checkbox'
export const DEFAULT_AI_ASSISTANCE_ENABLED_SLUGS = ['michaelangelo-casanova-2'] as const
export const MAX_ASSISTANT_CONTEXT_CHARS = 48_000
export const MAX_KNOWLEDGE_TEXT_CHARS = 24_000
export const MAX_BUSINESS_BRIEF_CHARS = 8_000
export const MAX_PROMPT_ADDENDUM_CHARS = 2_000

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled'])

export function normalizeCardSlug(slug?: string | null): string {
  return String(slug || '')
    .trim()
    .toLowerCase()
}

export function isDefaultAiAssistanceSlug(slug?: string | null): boolean {
  const normalized = normalizeCardSlug(slug)
  return (DEFAULT_AI_ASSISTANCE_ENABLED_SLUGS as readonly string[]).includes(normalized)
}

export function assertProfileId(value: unknown): string {
  const profileId = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(profileId)) throw new AppError(400, 'Invalid profile id.')
  return profileId
}

export function parseAssistantEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return TRUTHY.has(
    String(value ?? '')
      .trim()
      .toLowerCase()
  )
}

function hasExplicitAssistantFlag(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return false
  return true
}

export function isAssistantEnabled(configEnabled: unknown, legacySettingValue: unknown, slug?: string | null): boolean {
  const configSet = hasExplicitAssistantFlag(configEnabled)
  const legacySet = hasExplicitAssistantFlag(legacySettingValue)
  if (!configSet && !legacySet) return isDefaultAiAssistanceSlug(slug)
  return (configSet && parseAssistantEnabled(configEnabled)) || (legacySet && parseAssistantEnabled(legacySettingValue))
}

export function assertPublicAssistantGate(
  publicReadable: boolean,
  configEnabled: unknown,
  legacySettingValue: unknown,
  slug?: string | null
): void {
  if (!publicReadable || !isAssistantEnabled(configEnabled, legacySettingValue, slug)) {
    throw new AppError(404, 'Public AI assistant is not enabled for this profile.')
  }
}

export const SUPPORTED_TAB_FILL_SCOPES = Object.freeze(
  (Object.keys(fillSectionSchemas) as FillSectionId[]).filter((scope) => scope !== 'seo')
)

export function parseSupportedTabScope(raw: unknown): Exclude<FillSectionId, 'seo'> {
  const scope = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!SUPPORTED_TAB_FILL_SCOPES.includes(scope as Exclude<FillSectionId, 'seo'>)) {
    throw new AppError(400, `Unsupported section. Use one of: ${SUPPORTED_TAB_FILL_SCOPES.join(', ')}`)
  }
  return scope as Exclude<FillSectionId, 'seo'>
}

export function sanitizePromptAddendum(raw: unknown): string | null {
  const value = String(raw ?? '')
    .replace(/\0/g, '')
    .trim()
  if (!value) return null
  if (value.length > MAX_PROMPT_ADDENDUM_CHARS) {
    throw new AppError(400, `System prompt addendum must be at most ${MAX_PROMPT_ADDENDUM_CHARS} characters.`)
  }
  if (
    /(?:reveal|print|return|expose).{0,30}(?:api key|secret|token|system prompt)|ignore.{0,30}(?:previous|system)|override.{0,20}(?:safety|instructions)/i.test(
      value
    )
  ) {
    throw new AppError(400, 'System prompt addendum contains unsafe instructions.')
  }
  return value
}

export type KnowledgeContextItem = {
  id: string
  label: string
  tabScope?: string | null
  extractedText: string
  createdAt?: Date | string
}

export function boundKnowledgeContext(
  profileId: string,
  rows: Array<KnowledgeContextItem & { profileId: string }>,
  maxChars = MAX_KNOWLEDGE_TEXT_CHARS
): string {
  const sorted = rows
    .filter((row) => row.profileId === profileId && row.extractedText.trim())
    .sort((a, b) => {
      const scope = String(a.tabScope || '').localeCompare(String(b.tabScope || ''))
      if (scope) return scope
      const label = a.label.localeCompare(b.label)
      return label || a.id.localeCompare(b.id)
    })

  let remaining = Math.max(0, maxChars)
  const chunks: string[] = []
  for (const row of sorted) {
    if (remaining <= 0) break
    const header = `[${row.tabScope || 'general'}] ${row.label}\n`
    const text = row.extractedText.replace(/\s+/g, ' ').trim()
    const chunk = `${header}${text}`.slice(0, remaining)
    chunks.push(chunk)
    remaining -= chunk.length + 2
  }
  return chunks.join('\n\n')
}

export type TabFillBodyMode = 'as_written' | 'summarize'

export function parseTabFillBodyMode(value: unknown): TabFillBodyMode {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  if (raw === 'summarize' || raw === 'summarised' || raw === 'summary') return 'summarize'
  return 'as_written'
}

/** Body fields on paste-fill sections that must keep the owner's full wording. */
const FULL_BODY_FIELD_RULE: Partial<Record<Exclude<FillSectionId, 'seo'>, string>> = {
  blogs:
    'For each post: put a short clear title in "title". Put the COMPLETE article body in "description" — every paragraph from the source, not a summary or teaser. Prefer HTML with one <p> per paragraph. Never shorten, paraphrase, or omit body paragraphs.',
  services:
    'For each service: put the name in "title". Put the COMPLETE service write-up in "description" (every paragraph from the source). Prefer HTML with one <p> per paragraph. Do not reduce a long pasted blurb to one short sentence.',
  portfolio:
    'For each project: put the name in "title". Put the COMPLETE project write-up in "description". Prefer HTML with one <p> per paragraph. Do not summarize away detail the owner pasted.',
  faqs: 'For each FAQ: put the question in "question". Put the COMPLETE answer in "answer" (full wording from the source). Prefer HTML with one <p> per paragraph when the answer has multiple paragraphs. Do not shorten answers.',
  reviews:
    'For each review: put the author in "author". Put the COMPLETE quote in "text" (full wording from the source). Prefer HTML with one <p> per paragraph when the quote has multiple paragraphs. Do not shorten quotes.',
}

/** Body fields when the owner asked for a polished short summary. */
const SUMMARIZE_BODY_FIELD_RULE: Partial<Record<Exclude<FillSectionId, 'seo'>, string>> = {
  blogs:
    'For each post: put a short clear title in "title". Write a polished HTML summary in "description" (2–5 sentences, one or more <p> tags) that captures the main points of the source. Do not copy the full article verbatim.',
  services:
    'For each service: put the name in "title". Write a polished HTML benefit-focused summary in "description" (2–4 sentences). Keep only facts from the source.',
  portfolio:
    'For each project: put the name in "title". Write a polished HTML summary in "description" (2–4 sentences) of what the project is about.',
  faqs: 'For each FAQ: put the question in "question". Write a clear, concise HTML answer in "answer" that keeps the meaning of the source without unnecessary length.',
  reviews:
    'For each review: put the author in "author". Keep a faithful but concise quote in "text" (trim filler if needed; do not invent praise).',
}

export function buildTabFillSystemPrompt(
  scope: Exclude<FillSectionId, 'seo'>,
  bodyMode: TabFillBodyMode = 'as_written'
): string {
  const summarize = bodyMode === 'summarize'
  const extractRule =
    scope === 'faqs'
      ? 'Extract every distinct Q&A conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Pair questions with their answers. Do not invent FAQs that are not implied by the source.'
      : scope === 'blogs'
        ? summarize
          ? 'Extract every distinct post or news item conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Keep real titles and write a smart summary in description. Do not invent articles.'
          : 'Extract every distinct post or news item conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Keep real titles and the FULL post body in description. Do not invent articles.'
        : scope === 'reviews'
          ? summarize
            ? 'Extract every distinct testimonial conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Capture author, a concise faithful quote, and rating when present. Do not invent reviews.'
            : 'Extract every distinct testimonial conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Capture author, the FULL quote, and rating when present. Do not invent reviews.'
          : scope === 'services' || scope === 'portfolio'
            ? summarize
              ? 'Extract every distinct item conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Keep real titles and write polished short descriptions from the source.'
              : 'Extract every distinct item conceptually present in the pasted text or OCR output. Keep all found items with no maximum. Keep real titles and FULL descriptions from the source.'
            : 'Use only facts present in the supplied text/files/current public card.'
  const bodyRule = (summarize ? SUMMARIZE_BODY_FIELD_RULE : FULL_BODY_FIELD_RULE)[scope] || ''
  const singleItemRule = summarize
    ? 'When the paste is a single article/item (title line plus body paragraphs), return exactly one entry and summarize the body clearly for a public card.'
    : 'When the paste is a single article/item (title line plus body paragraphs), return exactly one entry and keep the entire body — never compress it into a short summary.'
  return `You extract and write data for exactly one public vCard section: "${scope}".
Return ONLY valid JSON matching this exact shape: ${FILL_SECTION_SCHEMA_HINTS[scope]}
Do not return keys, suggestions, or content for any other section.
Body mode: ${summarize ? 'summarize' : 'as_written'}.
${extractRule}
${bodyRule}
${singleItemRule}
Do not invent reviews, credentials, dates, contact details, or claims.
If the sources do not support this section, return the matching empty array/object.`
}

export function publicLiveTokenShape(input: {
  token: { name?: string }
  model: string
  expiresAt: string
  newSessionExpiresAt: string
  context?: string
}) {
  if (!input.token.name) throw new AppError(502, 'Gemini returned an empty ephemeral token.')
  return {
    token: input.token.name,
    model: input.model,
    expiresAt: input.expiresAt,
    newSessionExpiresAt: input.newSessionExpiresAt,
    ...(input.context ? { context: input.context } : {}),
  }
}
