import { z } from 'zod'
import AppError from '../../error/AppError'
import { logAiUsage, logChatMeta } from './aiUsageLog.service'
import { analyzeMasterProfile } from './businessAnalyzer.service'
import {
  FILL_SECTION_SCHEMA_HINTS,
  TAB_CATALOG,
  cardBlueprintSchema,
  coerceServiceTypes,
  countFillEntries,
  fillSectionSchemas,
  type CardBlueprint,
  type FillSectionId,
} from './cardBlueprint.schema'
import { getCardSession, putCardSession } from './cardSession.store'
import { buildCompletenessReport } from './completeness.service'
import { generateCardContent, generateSectionFromProfile, profileToBlueprintFacts } from './contentGenerator.service'
import { crawlWebsiteDeep, extractTextFromBuffer, type UploadedPart } from './extractDocumentText'
import { buildFieldGraph, buildTabPlan } from './fieldGraph.service'
import { assessComplexity, routeAiTier } from './modelRouter.service'
import { chatJson, getOpenAiApiKey } from './openai.client'
import { runSolArchitect } from './solArchitect.service'
import { normalizeSources } from './sourceNormalizer.service'
import { decideRecommendedTabs, type RecommendedTab } from './tabDecision.service'
import { sanitizeBlueprint } from './validation.service'

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

function mergeBlueprint(base: Partial<CardBlueprint>, generated: CardBlueprint): CardBlueprint {
  return cardBlueprintSchema.parse({
    ...generated,
    personal: {
      ...generated.personal,
      ...Object.fromEntries(Object.entries(base.personal || {}).filter(([, v]) => v)),
    },
    socialHandles: { ...(generated.socialHandles || {}), ...(base.socialHandles || {}) },
    education: generated.education?.length ? generated.education : base.education || [],
    experience: generated.experience?.length ? generated.experience : base.experience || [],
    skills: generated.skills?.length ? generated.skills : base.skills || [],
    services: generated.services?.length ? generated.services : base.services || [],
    portfolio: generated.portfolio?.length ? generated.portfolio : base.portfolio || [],
    reviews: base.reviews || [],
    blogs: generated.blogs || [],
    faqs: generated.faqs || [],
    enabledTabs: generated.enabledTabs?.length ? generated.enabledTabs : base.enabledTabs || ['Personal'],
    recommendedTabs: generated.recommendedTabs?.length ? generated.recommendedTabs : base.recommendedTabs || [],
    businessSummary: generated.businessSummary || base.businessSummary || '',
    suggestedSlug: generated.suggestedSlug || base.suggestedSlug || 'my-card',
  })
}

export type ExtractionUserStep = {
  id: string
  label: string
  status: 'done' | 'skipped' | 'failed'
  detail?: string
}

export function summarizeExtraction(normalized: Awaited<ReturnType<typeof normalizeSources>>) {
  const websiteFailed = Boolean(normalized.website.scrapeFailed)
  const websitePages = normalized.website.pages.length
  const websiteStep: ExtractionUserStep = !normalized.website.url
    ? { id: 'website', label: 'Reading your website', status: 'skipped', detail: 'No website was provided.' }
    : websiteFailed
      ? {
          id: 'website',
          label: 'Reading your website',
          status: 'failed',
          detail: 'The website could not be read. Your notes and files will still be used.',
        }
      : {
          id: 'website',
          label: 'Reading your website',
          status: 'done',
          detail: `Read ${websitePages} page${websitePages === 1 ? '' : 's'}${
            normalized.website.pages.length
              ? ` (${[...new Set(normalized.website.pages.map((p) => p.category))].slice(0, 6).join(', ')})`
              : ''
          }.`,
        }

  const docCount = normalized.documents.length + normalized.ocrResults.length
  const imageCount = normalized.ocrResults.filter((d) => d.extractionMethod === 'ocr').length
  const scannedCount = normalized.ocrResults.filter((d) => d.extractionMethod === 'ocr_needed').length
  const documentsStep: ExtractionUserStep =
    docCount === 0
      ? { id: 'documents', label: 'Reading your documents', status: 'skipped', detail: 'No files were uploaded.' }
      : {
          id: 'documents',
          label: 'Reading your documents',
          status: 'done',
          detail:
            [
              `Read ${docCount} file${docCount === 1 ? '' : 's'}`,
              imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : null,
              scannedCount ? `${scannedCount} scanned file${scannedCount === 1 ? '' : 's'}` : null,
            ]
              .filter(Boolean)
              .join(' · ') + '.',
        }

  return {
    website: {
      url: normalized.website.url,
      pageCount: websitePages,
      categories: [...new Set(normalized.website.pages.map((p) => p.category))],
      failed: websiteFailed,
    },
    documents: [...normalized.documents, ...normalized.ocrResults].map((d) => ({
      label: d.label,
      method: d.extractionMethod,
    })),
    warnings: normalized.warnings,
    steps: [websiteStep, documentsStep],
  }
}

export async function extractBusinessSources(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
  userId?: string
  sessionId?: string
}) {
  const websiteUrl = (input.websiteUrl || '').trim()
  const businessText = (input.businessText || '').trim()
  const files = input.files || []

  if (!websiteUrl && !businessText && files.length === 0) {
    throw new AppError(400, 'Provide a website URL, business text, and/or document uploads.')
  }

  const normalized = await normalizeSources({ websiteUrl, businessText, files })
  const session = putCardSession({
    id: input.sessionId || undefined,
    userId: input.userId,
    websiteUrl,
    status: 'EXTRACTING',
    normalized,
    businessProfile: null,
    blueprint: null,
    selectedNavIds: ['home'],
    fieldGraph: [],
    recommendedTabs: [],
    userProgress: [],
    architectureVersion: 1,
  })
  const extraction = summarizeExtraction(normalized)

  return {
    sessionId: session.id,
    extraction,
    next: 'Understanding your business...',
  }
}

export async function analyzeBusinessSources(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
  userId?: string
  sessionId?: string
}) {
  ensureOpenAiConfigured()

  const websiteUrl = (input.websiteUrl || '').trim()
  const businessText = (input.businessText || '').trim()
  const files = input.files || []

  let sessionId = input.sessionId?.trim() || ''
  let normalized = getCardSession(sessionId)?.normalized

  if (!normalized) {
    if (!websiteUrl && !businessText && files.length === 0) {
      throw new AppError(400, 'Provide a website URL, business text, and/or document uploads.')
    }
    const extracted = await extractBusinessSources({
      websiteUrl,
      businessText,
      files,
      userId: input.userId,
      sessionId,
    })
    sessionId = extracted.sessionId
    normalized = getCardSession(sessionId)?.normalized
  }

  if (!normalized) {
    throw new AppError(400, 'Could not read your sources. Try the website or files again.')
  }

  const existing = getCardSession(sessionId)
  let profile = existing?.businessProfile
  let tabs: RecommendedTab[]
  let escalatedFrom: string | null = null
  let tier: string = 'sol'

  if (existing?.architecture && profile) {
    tabs = existing.recommendedTabs || []
  } else {
    const architecture = await runSolArchitect({
      normalized,
      userId: input.userId,
      sessionId,
    })
    profile = architecture.masterBusinessProfile
    tabs = architecture.recommendedTabs
    if (existing) {
      putCardSession({
        ...existing,
        architecture,
        businessProfile: profile,
        recommendedTabs: tabs,
        status: 'MAPPING_FIELDS',
      })
    }
  }

  if (!profile) {
    const analyzed = await analyzeMasterProfile({
      normalized,
      userId: input.userId,
      sessionId,
    })
    profile = analyzed.profile
    tier = analyzed.tier
    escalatedFrom = analyzed.escalatedFrom
    tabs = decideRecommendedTabs(profile)
  }
  const factBlueprint = profileToBlueprintFacts(profile, tabs)

  let generated: CardBlueprint
  try {
    generated = await generateCardContent({
      profile,
      factBlueprint,
      userId: input.userId,
    })
  } catch {
    generated = cardBlueprintSchema.parse({
      ...factBlueprint,
      businessSummary: factBlueprint.businessSummary || profile.businessDescription || '',
      suggestedSlug: factBlueprint.suggestedSlug || 'my-card',
      personal: factBlueprint.personal,
    })
  }

  let { blueprint, issues } = (() => {
    try {
      return sanitizeBlueprint(mergeBlueprint(factBlueprint, coerceServiceTypes(generated) as CardBlueprint))
    } catch {
      return {
        blueprint: cardBlueprintSchema.parse({
          ...factBlueprint,
          businessSummary: factBlueprint.businessSummary || profile.businessDescription || '',
          suggestedSlug: factBlueprint.suggestedSlug || 'my-card',
          personal: factBlueprint.personal,
        }),
        issues: [{ code: 'invalid_json', message: 'Content pass was repaired from the business profile.' }],
      }
    }
  })()

  if (issues.some((i) => i.code === 'unsupported_tab' || i.code === 'invalid_email')) {
    const retryRoute = routeAiTier({
      confidence: profile.confidence?.overall,
      complexity: 'complex',
      validationFailed: true,
    })
    if (retryRoute.tier !== 'luna') {
      try {
        const repaired = await generateCardContent({
          profile,
          factBlueprint: blueprint,
          userId: input.userId,
          instruction: `Fix validation issues: ${issues.map((i) => i.message).join('; ')}. Keep facts unchanged.`,
        })
        const second = sanitizeBlueprint(mergeBlueprint(blueprint, coerceServiceTypes(repaired) as CardBlueprint))
        blueprint = second.blueprint
        issues = second.issues
      } catch {
        /* keep first validated blueprint */
      }
    }
  }

  const completeness = buildCompletenessReport({ profile, blueprint })
  const selectedNavIds = ['home', ...tabs.map((t) => t.navId)].filter((id, i, all) => all.indexOf(id) === i)
  const fieldGraph = buildFieldGraph({ profile, recommendedTabs: tabs, selectedNavIds })
  const session = putCardSession({
    id: sessionId,
    userId: input.userId,
    websiteUrl: websiteUrl || getCardSession(sessionId)?.websiteUrl,
    status: 'WAITING_FOR_USER_INPUT',
    normalized,
    businessProfile: profile,
    blueprint,
    selectedNavIds,
    fieldGraph,
    recommendedTabs: tabs,
    architecture: getCardSession(sessionId)?.architecture,
    userProgress: [],
    architectureVersion: 1,
  })

  return {
    blueprint,
    businessSummary: blueprint.businessSummary,
    recommendedTabs: blueprint.recommendedTabs || [],
    optionalFeatures: blueprint.optionalFeatures || {},
    enabledTabs: blueprint.enabledTabs || ['Personal'],
    sessionId: session.id,
    businessProfile: profile,
    completion: completeness,
    conflicts: profile.conflicts || [],
    warnings: [...normalized.warnings, ...profile.warnings, ...issues.map((i) => i.message)],
    missingInformation: profile.missingInformation || [],
    modelTier: tier,
    escalatedFrom,
    jobId: session.id,
    status: session.status,
    cardPlan: buildTabPlan({
      recommendedTabs: tabs,
      selectedNavIds,
      fields: fieldGraph,
    }),
    nextField: fieldGraph.find((f) => f.status === 'EMPTY' || f.status === 'PARTIAL') || null,
  }
}

export async function suggestTabs(input: {
  businessSummary?: string
  enabledNavIds?: string[]
  draftSummary?: string
  sessionId?: string
  userId?: string
}) {
  ensureOpenAiConfigured()
  const session = getCardSession(input.sessionId)
  if (session?.businessProfile) {
    const enabled = new Set(input.enabledNavIds || [])
    const recs = decideRecommendedTabs(session.businessProfile)
      .filter((t) => !PINNED_SUGGEST_BLOCK.has(t.navId) && !enabled.has(t.navId) && t.navId !== 'home')
      .slice(0, 6)
      .map((t) => ({
        tab: t.name,
        navId: t.navId,
        reason: t.reason,
        priority: t.priority,
      }))
    if (recs.length) return { recommendations: recs }
  }

  const enabled = new Set(input.enabledNavIds || [])
  const available = TAB_CATALOG.filter((t) => !PINNED_SUGGEST_BLOCK.has(t.navId) && !enabled.has(t.navId))
  const catalog = available.map((t) => `${t.name} (${t.navId}): ${t.description}`).join('\n')

  const raw = await chatJson<unknown>({
    tier: 'luna',
    system: `You recommend which vCard navigation tabs to enable next. Reply JSON only: { "recommendations": [{ "tab": "<exact catalog name>", "navId": "<exact catalog navId>", "reason": "<short why>", "priority": "high"|"medium"|"low" }] }.
Rules:
- Suggest ONLY from the Available tabs list (exact tab name + navId).
- Never invent tabs outside that list.
- Never suggest Personal, Global Connection, or My Info.
- Max 6 suggestions, best-fit first.
- Skip tabs that do not fit the business.`,
    user: `Business summary: ${input.businessSummary || '(none)'}\nDraft notes: ${input.draftSummary || '(none)'}\nAlready enabled nav ids: ${[...enabled].join(', ') || 'home'}\n\nAvailable tabs:\n${catalog || '(none left)'}`,
  })
  await logChatMeta('suggest_tabs', raw.meta, { userId: input.userId, sessionId: input.sessionId, success: true })

  const parsed = suggestResponseSchema.parse(raw.data)
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
  sessionId?: string
  masterProfile?: string
  userId?: string
}) {
  ensureOpenAiConfigured()
  const section = String(input.section || '')
    .trim()
    .toLowerCase()
  if (!SECTIONS.includes(section as CardAgentSection)) {
    throw new AppError(400, `Unsupported section. Use one of: ${SECTIONS.join(', ')}`)
  }
  const sectionId = section as FillSectionId

  const session = getCardSession(input.sessionId)
  let profile = session?.businessProfile || null
  if (!profile && input.masterProfile) {
    try {
      profile = JSON.parse(input.masterProfile)
    } catch {
      profile = null
    }
  }

  const text = (input.text || '').trim()
  const websiteUrl = (input.websiteUrl || '').trim()
  const files = input.files || []

  if (profile && files.length === 0) {
    const payload = (await generateSectionFromProfile({
      section: sectionId,
      profile,
      instruction: text,
      currentDraft: input.currentDraft,
      userId: input.userId,
      sessionId: input.sessionId,
    })) as Record<string, unknown>
    const count = countFillEntries(sectionId, payload)
    const message =
      count === 0
        ? `No ${section} found in the saved business profile. Add a note or document if you want this section filled.`
        : undefined
    return { section: sectionId, payload, ...(message ? { message } : {}), count, usedProfile: true }
  }

  if (!text && !websiteUrl && files.length === 0 && !profile) {
    throw new AppError(400, 'Provide text, a website URL, and/or files to fill this section.')
  }

  const parts: string[] = []
  const images: Array<{ mimeType: string; base64: string }> = []
  if (profile) {
    parts.push(
      `MASTER BUSINESS PROFILE (prefer this over re-reading raw sources):\n${JSON.stringify(profile).slice(0, 14000)}`
    )
  }
  if (websiteUrl && !profile) {
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

  const schemaHint = FILL_SECTION_SCHEMA_HINTS[sectionId]
  const complexity = assessComplexity({
    sourceCount: parts.length,
    ocrUsed: images.length > 0,
    textLength: parts.join('').length,
  })
  const route = routeAiTier({ confidence: profile?.confidence?.overall ?? 0.9, complexity: complexity.complexity })

  let raw: unknown
  try {
    const result = await chatJson<unknown>({
      tier: route.tier,
      system: `You fill one vCard section from user materials and the Master Business Profile when present. Return ONLY JSON matching: ${schemaHint}. Create multiple high-quality entries when the source supports it. Treat REVIEW_TESTIMONIAL_BLOCK and SLIDER_BLOCK labels as individual carousel/list candidates. Never invent customer reviews. If reviews are not in the sources, return an empty reviews array. If the requested section is not supported by the sources, return an empty array/object. For services.type use ONLY one of: Web Development, App Design, SEO, Marketing, Other.`,
      user: `Fill section “${section}”.\nCurrent draft context (may be partial JSON):\n${(input.currentDraft || '').slice(0, 8000)}\n\nSources:\n${parts.join('\n\n---\n\n')}`,
      images,
    })
    await logChatMeta(`fill_${sectionId}`, result.meta, {
      userId: input.userId,
      sessionId: input.sessionId,
      success: true,
    })
    raw = result.data
  } catch (e) {
    await logAiUsage({
      task: `fill_${sectionId}`,
      model: 'unknown',
      tier: route.tier,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      latencyMs: 0,
      success: false,
      userId: input.userId,
      sessionId: input.sessionId,
      error: e instanceof Error ? e.message : 'fill failed',
    })
    throw new AppError(
      502,
      e instanceof Error ? e.message : 'AI failed to generate section content. Try again with clearer material.',
      { code: 'AI_FILL_FAILED' }
    )
  }

  const schema = fillSectionSchemas[sectionId]
  let payload: Record<string, unknown>
  try {
    const coerced = sectionId === 'services' ? coerceServiceTypes(raw) : raw
    payload = schema.parse(coerced) as Record<string, unknown>
  } catch {
    throw new AppError(
      502,
      'AI returned an invalid structure for this section. Try again or paste the content as text.',
      { code: 'AI_FILL_INVALID' }
    )
  }

  const count = countFillEntries(sectionId, payload)
  const message =
    count === 0
      ? `No ${section} found in the provided sources. Try a clearer document, image, or paste the list as text.`
      : undefined

  return { section: sectionId, payload, ...(message ? { message } : {}), count }
}

export async function regenerateSection(input: {
  section: string
  instruction?: string
  sessionId?: string
  currentDraft?: string
  userId?: string
}) {
  const session = getCardSession(input.sessionId)
  if (!session?.businessProfile) {
    throw new AppError(400, 'No saved business profile for this card yet. Run analyze first.')
  }
  return fillSection({
    section: input.section,
    text: input.instruction,
    currentDraft: input.currentDraft,
    sessionId: input.sessionId,
    userId: input.userId,
  })
}
