import { z } from 'zod'
import AppError from '../../error/AppError'
import logger from '../../utils/logger'
import { logChatMeta } from './aiUsageLog.service'
import {
  MASTER_PROFILE_JSON_INSTRUCTION,
  masterBusinessProfileSchema,
  type MasterBusinessProfile,
} from './businessProfile.schema'
import { TAB_CATALOG } from './cardBlueprint.schema'
import { CARD_BUILDER_MISSION } from './cardBuilderMission'
import { detectSourceConflicts } from './conflictDetection'
import { selectModelForTask } from './modelRouter.service'
import { chatJson } from './openai.client'
import type { NormalizedSourceData } from './sourceNormalizer.service'
import { decideRecommendedTabs, type RecommendedTab } from './tabDecision.service'

const solEnvelopeSchema = z.object({
  masterBusinessProfile: masterBusinessProfileSchema,
  recommendedNavIds: z.array(z.string()).optional().default([]),
  tabReasons: z
    .array(z.object({ navId: z.string(), reason: z.string() }))
    .optional()
    .default([]),
})

const CATALOG_NAV = new Set(TAB_CATALOG.map((t) => t.navId))

export type SolArchitecture = {
  masterBusinessProfile: MasterBusinessProfile
  recommendedTabs: RecommendedTab[]
  sourceMap: Array<{ fieldKey: string; value: unknown; source?: string; sourceUrl?: string }>
}

const LARGE_SITE_PAGES = 8
const LARGE_SITE_CHARS = 32_000
const ARCHITECTURE_SOURCE_BUDGET = 26_000
const ARCHITECTURE_RETRY_BUDGET = 12_000

function excerpt(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max).replace(/\s+\S*$/, '')}…`
}

function isLargeSite(normalized: NormalizedSourceData): boolean {
  return normalized.website.pages.length >= LARGE_SITE_PAGES || normalized.extractedText.length > LARGE_SITE_CHARS
}

/**
 * Large crawls used to send the first ~70k characters straight to the planner.
 * Inventory-heavy sites then timed out or returned cut-off JSON. This digest
 * keeps every page (title, url, category) and longer excerpts for identity pages.
 */
export function buildArchitectureSource(normalized: NormalizedSourceData, budget = ARCHITECTURE_SOURCE_BUDGET): string {
  const pages = normalized.website.pages
  if (!pages.length) {
    const cap = budget < ARCHITECTURE_SOURCE_BUDGET ? budget : 70_000
    return [
      'NO WEBSITE URL. The uploaded PDF, Word, text, photos, and notes are the business source.',
      'Read them fully. Understand the business, then suggest the vBiz Me card and tabs. Do not wait for a website.',
      normalized.extractedText.slice(0, cap),
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  if (!isLargeSite(normalized)) {
    const cap = budget < ARCHITECTURE_SOURCE_BUDGET ? budget : 70_000
    return normalized.extractedText.slice(0, cap)
  }

  const priority = /^(home|about|contact|services|team|products)$/
  const chunks: string[] = []
  const push = (block: string) => {
    if (!block.trim()) return
    const next = chunks.length ? `${chunks.join('\n\n')}\n\n${block}` : block
    if (next.length > budget) return false
    chunks.push(block)
    return true
  }

  push(
    [
      `LARGE SITE DIGEST. ${pages.length} pages were opened from ${normalized.website.url || 'the website'}.`,
      'Main business pages are included in full. Long inventories were read by category, with one example each.',
      'Turn each category into a service or product line. Do not create one card entry per vehicle or SKU.',
      'Caps: 15 services, 15 portfolio items, 15 blogs, 15 reviews, 16 products, 10 team members.',
    ].join(' ')
  )
  if (normalized.website.catalogSummary) push(normalized.website.catalogSummary)
  push(
    `PAGE INDEX:\n${pages
      .map((page, index) => `${index + 1}. [${page.category}] ${page.title || 'Untitled'} — ${page.url}`)
      .join('\n')}`
  )
  const notes = [normalized.userInstructions, normalized.manualText].filter(Boolean).join('\n')
  if (notes) push(`OWNER NOTES (high trust):\n${excerpt(notes, 4000)}`)
  for (const doc of [...normalized.documents, ...normalized.ocrResults]) {
    if (!doc.text.trim()) continue
    if (!push(`DOCUMENT “${doc.label}”:\n${excerpt(doc.text, 1800)}`)) break
  }

  const ordered = [
    ...pages.filter((page) => priority.test(page.category)),
    ...pages.filter((page) => !priority.test(page.category)),
  ]
  for (const page of ordered) {
    const limit = priority.test(page.category) ? 1600 : 320
    const media = page.imageUrls?.length ? `\nIMAGES: ${page.imageUrls.slice(0, 2).join(' | ')}` : ''
    const ok = push(
      `=== [${page.category}] ${page.title || 'Untitled'} ===\n${page.url}${media}\n${excerpt(page.text, limit)}`
    )
    if (!ok && !priority.test(page.category)) continue
  }

  return chunks.join('\n\n').slice(0, budget)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function titledObjects(value: unknown, limit: number): Array<Record<string, unknown>> {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  const out: Array<Record<string, unknown>> = []
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ title: item.trim() })
    } else {
      const rec = asRecord(item)
      if (!rec) continue
      const title = [rec.title, rec.name, rec.value, rec.label]
        .find((part): part is string => typeof part === 'string' && Boolean(part.trim()))
        ?.trim()
      if (!title) continue
      out.push({ ...rec, title })
    }
    if (out.length >= limit) break
  }
  return out
}

function plainStrings(value: unknown, limit: number): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value]
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim())
    else {
      const rec = asRecord(item)
      const title = rec
        ? [rec.title, rec.name, rec.value, rec.label].find(
            (part): part is string => typeof part === 'string' && Boolean(part.trim())
          )
        : ''
      if (title) out.push(title.trim())
    }
    if (out.length >= limit) break
  }
  return out
}

/** Drop list items that would fail the profile schema, and cap catalog size. */
function prepareSolPayload(data: unknown): unknown {
  const root = asRecord(data) || {}
  const wrapped = asRecord(root.masterBusinessProfile)
  const profile: Record<string, unknown> = { ...(wrapped || root) }
  profile.services = titledObjects(profile.services, 15)
  profile.portfolio = titledObjects(profile.portfolio, 15)
  profile.blogs = titledObjects(profile.blogs, 15)
  profile.products = plainStrings(profile.products, 16)
  profile.teamMembers = plainStrings(profile.teamMembers, 10)
  profile.credentials = plainStrings(profile.credentials, 12)
  profile.licenses = plainStrings(profile.licenses, 12)
  profile.certifications = plainStrings(profile.certifications, 12)
  profile.awards = plainStrings(profile.awards, 12)
  profile.conflicts = []
  const objectList = (value: unknown, limit: number) =>
    (Array.isArray(value) ? value : [])
      .filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
      .slice(0, limit)
  profile.education = objectList(profile.education, 8)
  profile.experience = objectList(profile.experience, 8)
  profile.skills = objectList(profile.skills, 8)
  profile.verifiedReviews = objectList(profile.verifiedReviews, 15)
  profile.existingTestimonials = objectList(profile.existingTestimonials, 15)
  profile.suggestedTestimonialTemplates = objectList(profile.suggestedTestimonialTemplates, 4).filter(
    (item) => typeof item.text === 'string' && item.text.trim()
  )
  profile.importantFacts = Array.isArray(profile.importantFacts) ? profile.importantFacts.slice(0, 20) : []
  return {
    ...root,
    masterBusinessProfile: profile,
    recommendedNavIds: Array.isArray(root.recommendedNavIds) ? root.recommendedNavIds : [],
    tabReasons: Array.isArray(root.tabReasons) ? root.tabReasons : [],
  }
}

function findEmail(text: string): string | null {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null
}

function findPhone(text: string): string | null {
  const match = text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/)
  return match?.[0] || null
}

/** Card draft from the crawl when the planner cannot finish a large site. */
export function fallbackArchitecture(normalized: NormalizedSourceData): SolArchitecture {
  const pages = normalized.website.pages
  const home = pages.find((page) => page.category === 'home') || pages[0]
  const docCorpus = [
    normalized.manualText,
    normalized.userInstructions,
    ...normalized.documents.map((doc) => doc.text),
    ...normalized.ocrResults.map((doc) => doc.text),
  ]
    .filter((part) => part && !/^\[(Image attached|Scanned PDF)/.test(part.trim()))
    .join('\n')
  const docLines = docCorpus
    .split(/\n+/)
    .map((line) => line.replace(/^[\s\-*•]+/, '').trim())
    .filter(
      (line) => line && !/^(DOCUMENT|WEBSITE|OWNER|NO WEBSITE|USER INSTRUCTIONS)\b/i.test(line) && line.length <= 80
    )
  const rawTitle = (home?.title || docLines[0] || '').split(/\s+[|–—-]\s+/)[0]?.trim() || ''
  let host: string
  try {
    host = normalized.website.url ? new URL(normalized.website.url).hostname.replace(/^www\./, '') : ''
  } catch {
    host = ''
  }
  const corpus = normalized.extractedText || [home?.text || '', ...pages.map((page) => page.text)].join('\n')
  const services = pages
    .filter((page) => page.category === 'services' || page.category === 'products')
    .slice(0, 12)
    .map((page) => ({
      title: (page.title || page.url).slice(0, 180),
      description: excerpt(page.text, 280),
      url: page.url,
      source: 'website',
      sourceUrl: page.url,
    }))
  const portfolio = pages
    .filter((page) => page.category === 'portfolio')
    .slice(0, 8)
    .map((page) => ({
      title: (page.title || page.url).slice(0, 180),
      description: excerpt(page.text, 280),
      url: page.url,
      imageUrl: page.imageUrls?.[0] || '',
    }))
  const blogs = pages
    .filter((page) => page.category === 'blog')
    .slice(0, 6)
    .map((page) => ({
      title: (page.title || page.url).slice(0, 180),
      description: excerpt(page.text, 280),
      url: page.url,
      imageUrl: page.imageUrls?.[0] || '',
      category: 'News',
    }))
  const teamMembers = pages
    .filter((page) => page.category === 'team')
    .slice(0, 10)
    .map((page) => (page.title || '').trim())
    .filter(Boolean)

  const profile = masterBusinessProfileSchema.parse({
    businessName: rawTitle || host || null,
    website: normalized.website.url || null,
    businessDescription: excerpt(home?.text || docCorpus || corpus, 700) || null,
    email: findEmail(docCorpus || corpus),
    phone: findPhone(docCorpus || corpus),
    services,
    products: pages
      .filter((page) => page.category === 'products')
      .slice(0, 16)
      .map((page) => (page.title || '').trim())
      .filter(Boolean),
    portfolio,
    blogs,
    teamMembers,
    warnings: [
      pages.length
        ? 'The full AI plan could not finish on this large site, so this draft was built from the pages that were read. Review names, services, and contact details.'
        : 'This draft was built from the uploaded PDF, Word, text, or photos. Review the business name, services, and contact details.',
    ],
  })
  return {
    masterBusinessProfile: profile,
    recommendedTabs: decideRecommendedTabs(profile),
    sourceMap: [{ fieldKey: 'website', value: profile.website, source: 'WEBSITE', sourceUrl: normalized.website.url }],
  }
}

function existingCardPrompt(existingCard?: unknown): string {
  if (!existingCard) return ''
  try {
    return `\nEXISTING CARD (already on file — prefer these facts when they do not conflict):\n${JSON.stringify(existingCard).slice(0, 8000)}\n`
  } catch {
    return ''
  }
}

function canUseCrawlFallback(normalized: NormalizedSourceData): boolean {
  return normalized.website.pages.length > 0 || normalized.extractedText.trim().length > 200
}

function isMissingAiConfig(error: unknown): boolean {
  return error instanceof AppError && error.statusCode === 503
}

/** One architecture pass. A large site is planned from a digest, then retried smaller, then drafted from the crawl. */
export async function runSolArchitect(input: {
  normalized: NormalizedSourceData
  userId?: string
  sessionId?: string
  existingCard?: unknown
}): Promise<SolArchitecture> {
  const attempt = async (budget: number, includeImages: boolean) => {
    const route = selectModelForTask({ task: 'CARD_ARCHITECTURE' })
    const catalog = TAB_CATALOG.filter((t) => t.navId !== 'public-cards' && t.navId !== 'my-info')
      .map((t) => `${t.navId} = ${t.name}: ${t.description}`)
      .join('\n')
    const large = isLargeSite(input.normalized)

    const result = await chatJson<unknown>({
      tier: route.tier,
      temperature: 0.2,
      maxCompletionTokens: large ? 8000 : 6000,
      system: `You are the vBiz Me card architect.

${CARD_BUILDER_MISSION}

${MASTER_PROFILE_JSON_INSTRUCTION}

Also return recommendedNavIds using ONLY these ids:
${catalog}

Return JSON:
{
  "masterBusinessProfile": { ...profile shape above },
  "recommendedNavIds": ["home", "services"],
  "tabReasons": [{ "navId": "services", "reason": "short why" }]
}

First understand the business thoroughly from ALL provided sources (website crawl or seller/storefront page, OCR/documents, and owner-typed notes):
1. What is this business and who is the owner/professional? For seller/vendor storefronts, prefer the seller's name over the marketplace brand.
2. Industry, services/products, target customers, buying journey, conversion opportunities. Map catalog/product lines into services and products. When the source says cars or products were read by category, make one service or product line per category (brand, type, or collection) using the opened example. Do not list every vehicle or SKU.
3. Geography/service area, branding/tone, differentiators, social presence, contact, media. Use authentic product packaging images from IMAGES: when present.
4. Verified reviews, projects, experience, certifications — only if present in sources.
5. Real blog/news articles and portfolio/project pages from the crawl — copy titles, excerpts, URLs, and images. Likely FAQ topics and SEO opportunities from verified facts.
6. Which EXISTING catalog tabs fit, which fields can be filled now, what must be asked of the owner, and what is required for a 90–100% ready card.
7. Draft whyChooseUs, suggestedCta, and brandVoice from verified strengths only so content generation can finish a marketing-ready card.

Large sites: finish valid JSON. Keep real services, FAQs, blogs, reviews, and portfolio items up to 15 each. Keep at most 16 products and 10 team members. Do not invent extra list items when the source already has some.
If no website URL is present, the PDF, Word, text, and photo uploads are the full source. Understand that business from the files and still suggest the card: about, services, FAQs, why choose us, CTA, and contact details that the files actually contain.
Owner-typed notes and OCR text outrank weaker website guesses when they conflict.
Never invent tabs. Never invent phones, emails, licenses, awards, reviews, projects, or years in business.
Prefer facts already on an existing card over weaker new source text. Leave unknown required personal facts null so the owner can be asked later.`,
      user: `${existingCardPrompt(input.existingCard)}\nAnalyze sources and design the best card from supported tabs only.\n\n${buildArchitectureSource(input.normalized, budget)}`,
      images: includeImages ? input.normalized.images.slice(0, 4) : [],
    })
    await logChatMeta('sol_architecture', result.meta, {
      userId: input.userId,
      sessionId: input.sessionId,
      jobId: input.sessionId,
      stage: 'ARCHITECTING',
      success: true,
    })

    return solEnvelopeSchema.parse(prepareSolPayload(result.data))
  }

  let parsed: z.infer<typeof solEnvelopeSchema>
  try {
    parsed = await attempt(ARCHITECTURE_SOURCE_BUDGET, !isLargeSite(input.normalized))
  } catch (error) {
    if (isMissingAiConfig(error) || !canUseCrawlFallback(input.normalized)) throw error
    logger.warn('card_architecture_retry', {
      sessionId: input.sessionId,
      pages: input.normalized.website.pages.length,
      textLength: input.normalized.extractedText.length,
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      parsed = await attempt(ARCHITECTURE_RETRY_BUDGET, false)
    } catch (retryError) {
      if (isMissingAiConfig(retryError)) throw retryError
      logger.error('card_architecture_crawl_fallback', {
        sessionId: input.sessionId,
        pages: input.normalized.website.pages.length,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      })
      return fallbackArchitecture(input.normalized)
    }
  }
  let profile = parsed.masterBusinessProfile
  const heuristicConflicts = detectSourceConflicts({
    websiteText: input.normalized.website.pages.map((p) => p.text).join('\n'),
    documentTexts: [...input.normalized.documents, ...input.normalized.ocrResults].map((d) => ({
      label: d.label,
      text: d.text,
    })),
    manualText: `${input.normalized.manualText}\n${input.normalized.userInstructions}`,
    profile,
  })
  if (heuristicConflicts.length && !profile.conflicts.length) {
    profile = { ...profile, conflicts: heuristicConflicts }
  }

  const codeTabs = decideRecommendedTabs(profile)
  const solNav = parsed.recommendedNavIds.filter(
    (id) => CATALOG_NAV.has(id) && id !== 'public-cards' && id !== 'my-info'
  )
  const reasonByNav = Object.fromEntries(parsed.tabReasons.map((row) => [row.navId, row.reason]))
  const mergedNav = [...new Set(['home', ...solNav, ...codeTabs.map((t) => t.navId)])]
  const recommendedTabs: RecommendedTab[] = mergedNav
    .map((navId, index) => {
      const catalog = TAB_CATALOG.find((t) => t.navId === navId)
      const fromCode = codeTabs.find((t) => t.navId === navId)
      if (!catalog) return null
      const tab: RecommendedTab = {
        type: navId,
        navId,
        name: catalog.name,
        enabled: true,
        order: index + 1,
        reason: reasonByNav[navId] || fromCode?.reason || `Fits this business — add ${catalog.name}.`,
        priority: fromCode?.priority || (index < 4 ? 'high' : 'medium'),
      }
      return tab
    })
    .filter((row): row is RecommendedTab => row !== null)

  const sourceMap: SolArchitecture['sourceMap'] = [
    { fieldKey: 'businessName', value: profile.businessName, source: 'WEBSITE' },
    { fieldKey: 'phone', value: profile.phone, source: 'WEBSITE' },
    { fieldKey: 'email', value: profile.email, source: 'WEBSITE' },
    { fieldKey: 'website', value: profile.website, source: 'WEBSITE' },
  ].filter((row) => row.value)

  return { masterBusinessProfile: profile, recommendedTabs, sourceMap }
}
