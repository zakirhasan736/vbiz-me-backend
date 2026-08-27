import { z } from 'zod'
import AppError from '../../error/AppError'
import { extractWithOcrFallback, needsServerOcr } from '../documentOcr.service'
import {
  MAX_OWNER_SEO_KEYWORDS,
  MAX_SEO_DESCRIPTION_LENGTH,
  MAX_SEO_TITLE_LENGTH,
  normalizeSeoMetadata,
  ownerSeoKeywords,
} from '../seoMetadata.service'
import { logAiUsage, logChatMeta } from './aiUsageLog.service'
import { analyzeMasterProfile } from './businessAnalyzer.service'
import { assembleAiCard } from './cardAssembler.service'
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
import { getCardSession, loadCardSession, putCardSession } from './cardSession.store'
import { buildCompletenessReport } from './completeness.service'
import { generateCardContent, generateSectionFromProfile, profileToBlueprintFacts } from './contentGenerator.service'
import { crawlWebsiteDeep, extractTextFromBuffer, type UploadedPart } from './extractDocumentText'
import { buildFieldGraph, buildTabPlan } from './fieldGraph.service'
import { LUNA_DOCUMENT_FILL_SECTIONS, routeAiTier, selectFillSectionModel } from './modelRouter.service'
import { chatJson, getOpenAiApiKey } from './openai.client'
import { runSolArchitect } from './solArchitect.service'
import { normalizeSources } from './sourceNormalizer.service'
import {
  applySectionPayloadToFields,
  capGeneratedSkills,
  mergeUniqueLists,
  topUpGeneratedList,
} from './tabBuild.service'
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
  'seo',
] as const

export type CardAgentSection = (typeof SECTIONS)[number]

const TAB_BY_NAV = Object.fromEntries(TAB_CATALOG.map((t) => [t.navId, t]))
const TAB_BY_NAME = Object.fromEntries(TAB_CATALOG.map((t) => [t.name.trim().toLowerCase(), t]))
const PINNED_SUGGEST_BLOCK = new Set(['home', 'about', 'public-cards', 'my-info'])

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

function listFromCurrentDraft(currentDraft: string | undefined, sectionId: FillSectionId): unknown[] {
  if (!currentDraft) return []
  try {
    const parsed = JSON.parse(currentDraft) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return []
    if (sectionId === 'blogs') {
      if (Array.isArray(parsed.blogs)) return parsed.blogs
      if (Array.isArray(parsed.generalPosts)) return parsed.generalPosts
      return []
    }
    const value = parsed[sectionId]
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

async function ensureGeneratedListSection(input: {
  sectionId: FillSectionId
  payload: Record<string, unknown>
  profile: Parameters<typeof generateSectionFromProfile>[0]['profile'] | null
  currentDraft?: string
  instruction?: string
  userId?: string
  sessionId?: string
}): Promise<Record<string, unknown>> {
  const sectionId = input.sectionId
  if (sectionId !== 'faqs' && sectionId !== 'blogs' && sectionId !== 'reviews') return input.payload
  const existing = listFromCurrentDraft(input.currentDraft, sectionId)
  const incoming = Array.isArray(input.payload[sectionId]) ? (input.payload[sectionId] as unknown[]) : []
  let merged = mergeUniqueLists(existing, incoming)
  if (merged.length < 5 && input.profile) {
    const remaining = 5 - merged.length
    const generated = (await generateSectionFromProfile({
      section: sectionId,
      profile: input.profile,
      instruction:
        input.instruction ||
        `Generate ${remaining} additional ${sectionId} from business topics because the URL and documents did not provide enough. Do not invent licenses, prices, hours, guarantees, or awards.`,
      currentDraft: input.currentDraft,
      userId: input.userId,
      sessionId: input.sessionId,
    })) as Record<string, unknown>
    merged = topUpGeneratedList(merged, generated[sectionId])
  }
  return { ...input.payload, [sectionId]: merged }
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

  const session = (await loadCardSession(input.sessionId)) || getCardSession(input.sessionId)
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
    const withLists = await ensureGeneratedListSection({
      sectionId,
      payload,
      profile,
      currentDraft: input.currentDraft,
      instruction: text,
      userId: input.userId,
      sessionId: input.sessionId,
    })
    if (sectionId === 'seo' && withLists.seo && typeof withLists.seo === 'object') {
      withLists.seo = normalizeSeoMetadata(
        withLists.seo as { metaTitle?: string; metaDescription?: string; keywords?: string[] }
      )
    }
    const count = countFillEntries(sectionId, withLists)
    const message =
      count === 0
        ? `No ${section} found in the saved business profile. Add a note or document if you want this section filled.`
        : undefined
    await persistFillToJob(input.sessionId, sectionId, withLists)
    return { section: sectionId, payload: withLists, ...(message ? { message } : {}), count, usedProfile: true }
  }

  if (!text && !websiteUrl && files.length === 0 && !profile) {
    throw new AppError(400, 'Provide text, a website URL, and/or files to fill this section.')
  }

  const parts: string[] = []
  if (profile) {
    parts.push(
      `MASTER BUSINESS PROFILE (prefer this over re-reading raw sources):\n${JSON.stringify(profile).slice(0, 14000)}`
    )
  }
  if (text) parts.push(`USER TEXT:\n${text}`)

  const websiteTask = websiteUrl
    ? crawlWebsiteDeep(websiteUrl, section).then(
        (crawled) =>
          `WEBSITE URL: ${websiteUrl}\nFOCUSED SECTION: ${section}\nCRAWLED ${crawled.pages.length} PAGE(S):\n${crawled.combined}`,
        (error) =>
          `WEBSITE URL: ${websiteUrl}\n(Could not re-crawl site for ${section}: ${error instanceof Error ? error.message : 'error'}.)`
      )
    : Promise.resolve(null)

  const filesTask = Promise.all(
    files.map(async (file) => {
      const extracted = await extractTextFromBuffer(file)
      const body = needsServerOcr(extracted)
        ? await extractWithOcrFallback(file, extracted.extractionMethod === 'ocr_needed' ? 'scanned PDF' : 'image')
        : extracted.text
      return `DOCUMENT “${extracted.label}”:\n${body}`
    })
  )

  const [websitePart, fileParts] = await Promise.all([websiteTask, filesTask])
  if (websitePart) parts.push(websitePart)
  parts.push(...fileParts)

  const readyText = parts.join('\n\n---\n\n').trim()
  if (!readyText) {
    throw new AppError(422, 'Could not read text from this source. Add clearer text or another file.')
  }

  const schemaHint = FILL_SECTION_SCHEMA_HINTS[sectionId]
  const seoRule =
    sectionId === 'seo'
      ? `For SEO, write a concise business-specific title (max ${MAX_SEO_TITLE_LENGTH} chars) and description (max ${MAX_SEO_DESCRIPTION_LENGTH} chars) from verified facts. Return 5-${MAX_OWNER_SEO_KEYWORDS} high-intent keywords about this business. Do not include vBiz Me platform keywords; those are added automatically. Never invent numeric search-volume claims.`
      : ''
  const extractFromSource = LUNA_DOCUMENT_FILL_SECTIONS.has(sectionId)
    ? sectionId === 'faqs'
      ? 'Extract every distinct question-and-answer conceptually present in the ready text (OCR output, pasted copy, or crawled pages). Pair each question with its matching answer. Do not invent FAQs that are not implied by the source. Keep all found items with no maximum. If none are present, return an empty faqs array.'
      : sectionId === 'blogs'
        ? 'Extract every distinct article or news item conceptually present in the ready text. Use real titles and summaries from the source. Do not invent posts. Keep all found items with no maximum. If none are present, return an empty blogs array.'
        : 'Extract every distinct testimonial or review conceptually present in the ready text. Treat REVIEW_TESTIMONIAL_BLOCK and SLIDER_BLOCK labels as individual items. Do not invent customer reviews. Keep all found items with no maximum. If none are present, return an empty reviews array.'
    : 'Create multiple high-quality entries when the source supports it. Treat REVIEW_TESTIMONIAL_BLOCK and SLIDER_BLOCK labels as individual carousel/list candidates. If reviews, FAQs, or blogs are not in the sources, generate up to 5 realistic items from business topics instead of empty arrays. If some were found but fewer than 5, fill only the remaining slots up to 5. If more than 5 were found, keep all of them. Example reviews must be grounded in the business and must not invent licenses, prices, or awards. If the requested section is not supported and is not faqs/blogs/reviews, return an empty array/object.'
  const fillRoute = selectFillSectionModel(sectionId)

  let raw: unknown
  try {
    const result = await chatJson<unknown>({
      tier: fillRoute.tier,
      system: `You fill one vCard section from ready text. Return ONLY JSON matching: ${schemaHint}. Fill only the current section/tab. ${extractFromSource} For services.type use ONLY one of: Web Development, App Design, SEO, Marketing, Other. ${seoRule}`,
      user: `Fill section “${section}”.\nCurrent draft context (may be partial JSON):\n${(input.currentDraft || '').slice(0, 8000)}\n\nREADY TEXT:\n${readyText}`,
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
      tier: 'vision',
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
    if (sectionId === 'skills') {
      payload.skills = capGeneratedSkills(payload.skills)
    }
    payload = await ensureGeneratedListSection({
      sectionId,
      payload,
      profile,
      currentDraft: input.currentDraft,
      instruction: text,
      userId: input.userId,
      sessionId: input.sessionId,
    })
    if (sectionId === 'seo' && payload.seo && typeof payload.seo === 'object') {
      const seo = normalizeSeoMetadata(
        payload.seo as { metaTitle?: string; metaDescription?: string; keywords?: string[] }
      )
      payload.seo = seo
    }
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

  await persistFillToJob(input.sessionId, sectionId, payload)
  return { section: sectionId, payload, ...(message ? { message } : {}), count }
}

async function persistFillToJob(
  sessionId: string | undefined,
  sectionId: FillSectionId,
  payload: Record<string, unknown>
) {
  const session = await loadCardSession(sessionId)
  if (!session?.businessProfile) return
  const fields = applySectionPayloadToFields(session.fieldGraph, sectionId, payload)
  const { blueprint } = assembleAiCard({
    profile: session.businessProfile,
    fields,
    recommendedTabs: session.recommendedTabs,
    selectedNavIds: session.selectedNavIds,
  })
  putCardSession({
    ...session,
    fieldGraph: fields,
    blueprint,
    assembledDraft: blueprint,
  })
}

const generateSeoInputSchema = z.object({
  field: z.enum(['title', 'description', 'keywords']),
  name: z.string().optional().default(''),
  company: z.string().optional().default(''),
  designation: z.string().optional().default(''),
  profession: z.string().optional().default(''),
  about: z.string().optional().default(''),
  address: z.string().optional().default(''),
  website: z.string().optional().default(''),
  services: z.array(z.string()).optional().default([]),
  metaTitle: z.string().optional().default(''),
  metaDescription: z.string().optional().default(''),
})

const generateSeoResultSchema = z.object({
  metaTitle: z.string().optional().default(''),
  metaDescription: z.string().optional().default(''),
  keywords: z.array(z.string()).optional().default([]),
})

export type GeneratedCardSeo = {
  metaTitle?: string
  metaDescription?: string
  keywords?: string[]
}

function compactSeoFacts(input: z.infer<typeof generateSeoInputSchema>): string {
  const services = input.services
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12)
  return JSON.stringify(
    {
      name: input.name.trim(),
      company: input.company.trim(),
      designation: input.designation.trim(),
      profession: input.profession.trim(),
      about: input.about.trim().slice(0, 1200),
      address: input.address.trim(),
      website: input.website.trim(),
      services,
      metaTitle: input.metaTitle.trim(),
      metaDescription: input.metaDescription.trim(),
    },
    null,
    2
  )
}

export async function generateSeo(input: unknown, userId?: string): Promise<GeneratedCardSeo> {
  ensureOpenAiConfigured()
  const parsedResult = generateSeoInputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new AppError(400, 'Invalid SEO generate request.')
  }
  const parsed = parsedResult.data
  const facts = compactSeoFacts(parsed)
  const hasBusiness = Boolean(
    parsed.name.trim() ||
    parsed.company.trim() ||
    parsed.profession.trim() ||
    parsed.designation.trim() ||
    parsed.about.trim() ||
    parsed.services.some((item) => item.trim())
  )
  const hasTitleOrDescription = Boolean(parsed.metaTitle.trim() || parsed.metaDescription.trim())

  if (parsed.field === 'keywords') {
    if (!hasTitleOrDescription && !hasBusiness) {
      throw new AppError(400, 'Add a meta title or description first so AI can suggest keywords.')
    }
  } else if (!hasBusiness && !hasTitleOrDescription) {
    throw new AppError(400, 'Add personal or business details first so AI can write SEO.')
  }

  const fieldPrompt =
    parsed.field === 'title'
      ? `Write one SEO meta title for this digital business card. Max ${MAX_SEO_TITLE_LENGTH} characters. Include the person or brand name and the main service or profession. No quotes. No clickbait. Do not mention vBiz Me. Return JSON: { "metaTitle": "..." }`
      : parsed.field === 'description'
        ? `Write one SEO meta description for this digital business card. Max ${MAX_SEO_DESCRIPTION_LENGTH} characters. Summarize who they are, what they offer, and why to open the card. No quotes. Do not mention vBiz Me. Return JSON: { "metaDescription": "..." }`
        : `Propose 5 to ${MAX_OWNER_SEO_KEYWORDS} high-intent SEO keywords or short phrases for this card. Base them on the meta title, meta description, and business facts. Do not include vBiz Me, vbizme, virtual card, digital business card, or online business card — those are added automatically. Return JSON: { "keywords": ["...", "..."] }`

  let raw: unknown
  try {
    const result = await chatJson<unknown>({
      tier: 'luna',
      temperature: 0.4,
      system: `You write search metadata for one public digital business card. Use only the supplied facts. Never invent licenses, awards, years in business, or reviews. ${fieldPrompt}`,
      user: `FIELD: ${parsed.field}\nCARD FACTS:\n${facts}`,
    })
    await logChatMeta(`generate_seo_${parsed.field}`, result.meta, { userId, success: true })
    raw = result.data
  } catch (e) {
    await logAiUsage({
      task: `generate_seo_${parsed.field}`,
      model: 'unknown',
      tier: 'luna',
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      latencyMs: 0,
      success: false,
      userId,
      error: e instanceof Error ? e.message : 'generate seo failed',
    })
    throw new AppError(502, e instanceof Error ? e.message : 'AI failed to generate SEO. Try again.', {
      code: 'AI_SEO_FAILED',
    })
  }

  let generated: z.infer<typeof generateSeoResultSchema>
  try {
    generated = generateSeoResultSchema.parse(raw)
  } catch {
    throw new AppError(502, 'AI returned invalid SEO JSON. Try again.', { code: 'AI_SEO_INVALID' })
  }
  if (parsed.field === 'title') {
    const metaTitle = generated.metaTitle.trim().slice(0, MAX_SEO_TITLE_LENGTH)
    if (!metaTitle) throw new AppError(502, 'AI did not return a meta title. Try again.')
    return { metaTitle }
  }
  if (parsed.field === 'description') {
    const metaDescription = generated.metaDescription.trim().slice(0, MAX_SEO_DESCRIPTION_LENGTH)
    if (!metaDescription) throw new AppError(502, 'AI did not return a meta description. Try again.')
    return { metaDescription }
  }
  const keywords = ownerSeoKeywords(generated.keywords)
  if (!keywords.length) throw new AppError(502, 'AI did not return keywords. Try again.')
  return { keywords }
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
