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

export function isAssistantEnabled(configEnabled: unknown, legacySettingValue: unknown, slug?: string | null): boolean {
  if (isDefaultAiAssistanceSlug(slug)) return true
  return parseAssistantEnabled(configEnabled) || parseAssistantEnabled(legacySettingValue)
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

export function buildTabFillSystemPrompt(scope: Exclude<FillSectionId, 'seo'>): string {
  return `You extract and write data for exactly one public vCard section: "${scope}".
Return ONLY valid JSON matching this exact shape: ${FILL_SECTION_SCHEMA_HINTS[scope]}
Do not return keys, suggestions, or content for any other section.
Use only facts present in the supplied text/files/current public card. Do not invent reviews, credentials, dates, contact details, or claims.
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
