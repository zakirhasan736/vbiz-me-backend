import { z } from 'zod'
import AppError from '../../error/AppError'
import { BLUEPRINT_JSON_INSTRUCTION, TAB_CATALOG, cardBlueprintSchema } from './cardBlueprint.schema'
import { crawlWebsiteDeep, extractTextFromBuffer, type UploadedPart } from './extractDocumentText'
import { chatJson, getOpenAiApiKey } from './openai.client'

const suggestResponseSchema = z.object({
  recommendations: z.array(
    z.object({
      tab: z.string(),
      navId: z.string().optional(),
      reason: z.string(),
      priority: z.enum(['high', 'medium', 'low']).default('medium'),
    })
  ),
})

const SECTIONS = [
  'services',
  'blogs',
  'portfolio',
  'reviews',
  'skills',
  'education',
  'experience',
  'faqs',
  'personal',
] as const

export type CardAgentSection = (typeof SECTIONS)[number]

const TAB_BY_NAV = Object.fromEntries(TAB_CATALOG.map((t) => [t.navId, t]))
const TAB_BY_NAME = Object.fromEntries(TAB_CATALOG.map((t) => [t.name.trim().toLowerCase(), t]))
const PINNED_SUGGEST_BLOCK = new Set(['home', 'global-connection', 'my-info'])

function resolveCatalogTab(tab?: string, navId?: string) {
  if (navId && TAB_BY_NAV[navId]) return TAB_BY_NAV[navId]
  const key = String(tab || navId || '')
    .trim()
    .toLowerCase()
  if (!key) return null
  return TAB_BY_NAME[key] || null
}

function ensureOpenAiConfigured() {
  getOpenAiApiKey()
}

export async function analyzeBusinessSources(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
}) {
  ensureOpenAiConfigured()

  const websiteUrl = (input.websiteUrl || '').trim()
  const businessText = (input.businessText || '').trim()
  const files = input.files || []

  if (!websiteUrl && !businessText && files.length === 0) {
    throw new AppError(400, 'Provide a website URL, business text, and/or document uploads.')
  }

  const parts: string[] = []
  const images: Array<{ mimeType: string; base64: string }> = []

  if (websiteUrl) {
    try {
      const crawled = await crawlWebsiteDeep(websiteUrl)
      parts.push(
        `WEBSITE URL: ${websiteUrl}\nCRAWLED ${crawled.pages.length} PAGE(S) (home + related services/portfolio/blog/faq/reviews/about when found):\n${crawled.combined}`
      )
    } catch (e) {
      parts.push(
        `WEBSITE URL: ${websiteUrl}\n(Could not crawl site: ${e instanceof Error ? e.message : 'error'}. Infer from the domain name and any other sources.)`
      )
    }
  }

  if (businessText) {
    parts.push(`USER BUSINESS DESCRIPTION:\n${businessText}`)
  }

  for (const file of files) {
    const extracted = await extractTextFromBuffer(file)
    parts.push(`DOCUMENT “${extracted.label}”:\n${extracted.text}`)
    images.push(...extracted.images)
  }

  const catalog = TAB_CATALOG.map((t) => `${t.name} (navId=${t.navId}): ${t.description}`).join('\n')

  const raw = await chatJson<unknown>({
    system: `You are the vBiz digital business card creation agent. Build a COMPLETE multi-tab vCard blueprint from the sources. When the crawl includes services, portfolio, blog, FAQ, or review pages, FILL those arrays with real extracted items (titles + descriptions). Treat labeled REVIEW_TESTIMONIAL_BLOCK and SLIDER_BLOCK text as separate carousel/list items. Prefer many concrete entries over empty arrays. Enable every tab that has content. Only use tabs from this catalog:\n${catalog}\n\n${BLUEPRINT_JSON_INSTRUCTION}`,
    user: `Create a full vCard blueprint from these sources. Extract services, portfolio projects, blog posts, FAQs, and reviews whenever the text supports it. If reviews/testimonials/sliders are present, include every distinct item found up to 30, not only the first visible slide.\n\n${parts.join('\n\n---\n\n')}`,
    images,
  })

  const blueprint = cardBlueprintSchema.parse(raw)
  return {
    blueprint,
    businessSummary: blueprint.businessSummary,
    recommendedTabs: blueprint.recommendedTabs || [],
    optionalFeatures: blueprint.optionalFeatures || {},
    enabledTabs: blueprint.enabledTabs || ['Personal'],
  }
}

export async function suggestTabs(input: {
  businessSummary?: string
  enabledNavIds?: string[]
  draftSummary?: string
}) {
  ensureOpenAiConfigured()
  const enabled = new Set(input.enabledNavIds || [])
  const available = TAB_CATALOG.filter((t) => !PINNED_SUGGEST_BLOCK.has(t.navId) && !enabled.has(t.navId))
  const catalog = available.map((t) => `${t.name} (${t.navId}): ${t.description}`).join('\n')

  const raw = await chatJson<unknown>({
    system: `You recommend which vCard navigation tabs to enable next. Reply JSON only: { "recommendations": [{ "tab": "<exact catalog name>", "navId": "<exact catalog navId>", "reason": "<short why>", "priority": "high"|"medium"|"low" }] }.
Rules:
- Suggest ONLY from the Available tabs list (exact tab name + navId).
- Never invent tabs outside that list.
- Never suggest Personal, Global Connection, or My Info.
- Max 6 suggestions, best-fit first.
- Skip tabs that do not fit the business.`,
    user: `Business summary: ${input.businessSummary || '(none)'}\nDraft notes: ${input.draftSummary || '(none)'}\nAlready enabled nav ids: ${[...enabled].join(', ') || 'home'}\n\nAvailable tabs:\n${catalog || '(none left)'}`,
  })

  const parsed = suggestResponseSchema.parse(raw)
  const seen = new Set<string>()
  const recommendations = parsed.recommendations
    .map((r) => {
      const match = resolveCatalogTab(r.tab, r.navId)
      if (!match) return null
      if (PINNED_SUGGEST_BLOCK.has(match.navId) || enabled.has(match.navId) || seen.has(match.navId)) return null
      seen.add(match.navId)
      return {
        tab: match.name,
        navId: match.navId,
        reason: r.reason || `Fits this business — add ${match.name} to the card.`,
        priority: r.priority || ('medium' as const),
      }
    })
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .slice(0, 6)

  return { recommendations }
}

export async function fillSection(input: {
  section: string
  text?: string
  websiteUrl?: string
  currentDraft?: string
  files?: UploadedPart[]
}) {
  ensureOpenAiConfigured()
  const section = String(input.section || '')
    .trim()
    .toLowerCase()
  if (!SECTIONS.includes(section as CardAgentSection)) {
    throw new AppError(400, `Unsupported section. Use one of: ${SECTIONS.join(', ')}`)
  }

  const text = (input.text || '').trim()
  const websiteUrl = (input.websiteUrl || '').trim()
  const files = input.files || []
  if (!text && !websiteUrl && files.length === 0) {
    throw new AppError(400, 'Provide text, a website URL, and/or files to fill this section.')
  }

  const parts: string[] = []
  const images: Array<{ mimeType: string; base64: string }> = []
  if (websiteUrl) {
    try {
      const crawled = await crawlWebsiteDeep(websiteUrl, section)
      parts.push(
        `WEBSITE URL: ${websiteUrl}\nFOCUSED SECTION: ${section}\nCRAWLED ${crawled.pages.length} PAGE(S):\n${crawled.combined}`
      )
    } catch (e) {
      parts.push(
        `WEBSITE URL: ${websiteUrl}\n(Could not re-crawl site for ${section}: ${e instanceof Error ? e.message : 'error'}.)`
      )
    }
  }
  if (text) parts.push(`USER TEXT:\n${text}`)
  for (const file of files) {
    const extracted = await extractTextFromBuffer(file)
    parts.push(`DOCUMENT “${extracted.label}”:\n${extracted.text}`)
    images.push(...extracted.images)
  }

  const schemaHint: Record<string, string> = {
    services: `{ "services": [{ "title": "", "description": "", "url": "" }] }`,
    blogs: `{ "blogs": [{ "title": "", "description": "", "category": "News" }] }`,
    portfolio: `{ "portfolio": [{ "title": "", "description": "", "url": "" }] }`,
    reviews: `{ "reviews": [{ "author": "", "text": "", "rating": 5 }] }`,
    skills: `{ "skills": [{ "type": "Core", "skills": [""] }] }`,
    education: `{ "education": [{ "institute": "", "degree": "", "fromDate": "", "toDate": "", "tillNow": false }] }`,
    experience: `{ "experience": [{ "company": "", "jobTitle": "", "description": "", "fromDate": "", "toDate": "", "tillNow": false }] }`,
    faqs: `{ "faqs": [{ "question": "", "answer": "" }] }`,
    personal: `{ "personal": { "fullName": "", "email": "", "phone": "", "designation": "", "company": "", "about": "", "website": "", "address": "" }, "socialHandles": {} }`,
  }

  const payload = await chatJson<Record<string, unknown>>({
    system: `You fill one vCard section from user materials, website crawls, embedded JSON, and OCR from images. Return ONLY JSON matching: ${schemaHint[section]}. Create multiple high-quality entries when the source supports it. Treat REVIEW_TESTIMONIAL_BLOCK and SLIDER_BLOCK labels as individual carousel/list candidates. For reviews/testimonials and slider/carousel/list content, include all distinct credible items present in the source, up to 30. If the approved section is not supported by the sources, return an empty array/object for that section instead of inventing specific facts.`,
    user: `Fill section “${section}”.\nCurrent draft context (may be partial JSON):\n${(input.currentDraft || '').slice(0, 8000)}\n\nSources:\n${parts.join('\n\n---\n\n')}`,
    images,
  })

  return { section, payload }
}
