import { createHash } from 'crypto'
import AppError from '../../error/AppError'
import {
  cardActivationIssueMessage,
  cardCreationIssueMessage,
  collectCardActivationIssues,
  collectCardCreationIssues,
  collectCardDobIssues,
  normalizeCardEmail,
  normalizeCardPhone,
} from '../../utils/cardActivation'
import profileService from '../profile.service'
import { seoMetadataToSettings } from '../seoMetadata.service'
import { builderError, logBuilderEvent, newRequestId, type BuilderErrorCode, type BuilderStage } from './builderErrors'
import { summarizeExtraction } from './cardAgent.service'
import { assembleAiCard } from './cardAssembler.service'
import { cardBlueprintSchema, TAB_CATALOG } from './cardBlueprint.schema'
import {
  assertJobOwner,
  loadCardSession,
  persistCardSession,
  putCardSession,
  type CardBuildSession,
  type UserProgressStep,
} from './cardSession.store'
import { buildCompletenessReport } from './completeness.service'
import { generateSectionFromProfile, profileToBlueprintFacts } from './contentGenerator.service'
import { hashBuffer, type UploadedPart } from './extractDocumentText'
import { applyUserFieldValue, generateFieldCopy, skipField, type FieldAction } from './fieldCompletion.service'
import {
  applyExistingCardToProfile,
  buildFieldGraph,
  buildTabPlan,
  fieldsForAddedTab,
  mergeFieldDecision,
  nextActionableField,
  type AiCardField,
} from './fieldGraph.service'
import { runSolArchitect } from './solArchitect.service'
import { emptyNormalizedSources, normalizeSources, seedProfileFromCrawledPages } from './sourceNormalizer.service'
import { normalizeWebsiteUrl } from './sourceUrl'
import { autoFillSelectedFields, capGeneratedList } from './tabBuild.service'
import { sanitizeBlueprint } from './validation.service'

const running = new Set<string>()
const pendingWork = new Map<
  string,
  { websiteUrl: string; businessText: string; files: UploadedPart[]; existingCard?: unknown }
>()

export function computeSourceHash(input: {
  websiteUrl: string
  businessText: string
  files: UploadedPart[]
  profileId?: string
  builderMode?: string
}) {
  const digest = createHash('sha256')
  digest.update(input.websiteUrl)
  digest.update('\n')
  digest.update(input.businessText)
  digest.update('\n')
  digest.update(input.profileId || '')
  digest.update('\n')
  digest.update(input.builderMode || 'create')
  for (const sha of input.files.map((file) => hashBuffer(file.buffer)).sort()) {
    digest.update(sha)
  }
  return digest.digest('hex')
}

function productErrorMessage(code: BuilderErrorCode, fallback: string) {
  if (code === 'WEBSITE_FETCH_FAILED') {
    return "I couldn't read that website. Your current card is safe. Try the URL again, paste the information, or upload a document."
  }
  if (code === 'DOCUMENT_READ_FAILED' || code === 'OCR_FAILED') {
    return "I couldn't finish reading that document. Try uploading it again or use another file."
  }
  if (code === 'AI_PLANNING_FAILED') {
    return "I read your source, but the AI couldn't finish planning the update. Your current card is unchanged. Try again."
  }
  if (code === 'TIMEOUT') {
    return 'That source took too long to analyze. Your card is unchanged. Try again or use a smaller source.'
  }
  if (code === 'INVALID_URL' || code === 'VALIDATION_FAILED') return fallback
  if (code === 'PROFILE_REQUIRED') return fallback
  return "We couldn't finish analyzing that source. Your existing card was not overwritten."
}

function progress(
  session: CardBuildSession,
  id: string,
  status: UserProgressStep['status'],
  detail?: string
): UserProgressStep[] {
  const base: UserProgressStep[] = session.userProgress.length
    ? session.userProgress
    : [
        { id: 'website', label: 'Reading your website', status: 'pending' },
        { id: 'documents', label: 'Reading your documents', status: 'pending' },
        { id: 'understand', label: 'Understanding your business', status: 'pending' },
        { id: 'design', label: 'Designing your card', status: 'pending' },
        { id: 'map', label: 'Matching what we found', status: 'pending' },
      ]
  return base.map((step) => (step.id === id ? { ...step, status, detail: detail ?? step.detail } : step))
}

function publicJob(session: CardBuildSession) {
  const plan = buildTabPlan({
    recommendedTabs: session.recommendedTabs,
    selectedNavIds: session.selectedNavIds,
    fields: session.fieldGraph,
  })
  const nextField = nextActionableField(session.fieldGraph, session.selectedNavIds)
  return {
    jobId: session.id,
    sessionId: session.id,
    status: session.status,
    profileId: session.profileId || null,
    userProgress: session.userProgress,
    cardPercent: plan.cardPercent,
    cardPlan: plan.tabs,
    nextField,
    selectedNavIds: session.selectedNavIds,
    recommendedTabs: session.recommendedTabs.map((t) => ({
      tab: t.name,
      navId: t.navId,
      reason: t.reason,
      priority: t.priority,
    })),
    businessSummary: session.businessProfile?.businessDescription || session.blueprint?.businessSummary || '',
    blueprint: session.blueprint,
    businessProfile: session.businessProfile,
    completion: buildCompletenessReport({ profile: session.businessProfile, blueprint: session.blueprint }),
    missingInformation: session.businessProfile?.missingInformation || [],
    conflicts: session.businessProfile?.conflicts || [],
    warnings: session.normalized?.warnings || [],
    errorMessage: session.errorMessage || null,
    errorCode: session.errorCode || null,
    errorStage: session.errorStage || null,
    requestId: session.requestId || null,
    builderMode: session.builderMode || 'create',
    retryable: Boolean(session.errorCode && session.status === 'FAILED'),
    addableTabs: TAB_CATALOG.filter(
      (t) =>
        t.navId !== 'public-cards' &&
        t.navId !== 'my-info' &&
        t.navId !== 'home' &&
        t.navId !== 'about' &&
        !session.selectedNavIds.includes(t.navId)
    ).map((t) => ({ navId: t.navId, tab: t.name })),
  }
}

export async function getJob(jobId: string, userId?: string) {
  const session = await loadCardSession(jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, userId)
  await resumeIfIdle(session)
  const latest = (await loadCardSession(jobId)) || session
  return publicJob(latest)
}

async function resumeIfIdle(session: CardBuildSession) {
  const active =
    session.status === 'QUEUED' ||
    session.status === 'EXTRACTING' ||
    session.status === 'ARCHITECTING' ||
    session.status === 'MAPPING_FIELDS'
  if (!active || running.has(session.id)) return
  const work = pendingWork.get(session.id)
  if (work) {
    queueWorker(session.id)
    return
  }
  if (session.normalized?.extractedText) {
    queueWorker(session.id, { architectureOnly: true })
    return
  }
  if (Date.now() - session.createdAt < 120_000) return
  await save(session, {
    status: 'FAILED',
    errorCode: 'TIMEOUT',
    errorStage: 'source_fetch',
    errorMessage: productErrorMessage('TIMEOUT', 'That source took too long to analyze.'),
  })
}

function queueWorker(jobId: string, opts?: { architectureOnly?: boolean }) {
  if (running.has(jobId)) return
  running.add(jobId)
  const task = opts?.architectureOnly ? runArchitecture(jobId) : runExtractAndArchitecture(jobId)
  void task.finally(() => {
    running.delete(jobId)
    pendingWork.delete(jobId)
  })
}

async function save(session: CardBuildSession, patch: Partial<CardBuildSession>) {
  const next = putCardSession({
    ...session,
    ...patch,
    id: session.id,
    createdAt: session.createdAt,
  })
  await persistCardSession(next)
  return next
}

export async function startCardJob(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
  existingCard?: unknown
  userId?: string
  role?: string
  sessionId?: string
  profileId?: string
  builderMode?: 'create' | 'update'
  requestId?: string
}) {
  const requestId = newRequestId(input.requestId)
  const builderMode = input.builderMode === 'update' ? 'update' : 'create'
  const profileId = String(input.profileId || '').trim()
  const businessText = (input.businessText || '').trim()
  const files = input.files || []
  const websiteUrl = input.websiteUrl?.trim() ? normalizeWebsiteUrl(input.websiteUrl, requestId) : ''

  if (builderMode === 'update') {
    if (!profileId) {
      throw builderError(400, 'PROFILE_REQUIRED', 'Existing-card updates require profileId and builderMode=update.', {
        requestId,
        stage: 'existing_card_load',
        retryable: false,
      })
    }
    if (!input.userId) throw new AppError(403, 'Unauthorized')
    logBuilderEvent('AI_BUILDER_STAGE', {
      requestId,
      profileId,
      builderMode,
      stage: 'existing_card_load',
    })
    await profileService.getOwnedForWrite(profileId, input.userId, input.role || 'user')
  }

  if (!websiteUrl && !businessText && files.length === 0 && !input.existingCard) {
    throw builderError(400, 'VALIDATION_FAILED', 'Provide a website URL, business text, and/or document uploads.', {
      requestId,
      stage: 'source_fetch',
      retryable: false,
    })
  }

  const sourceHash = computeSourceHash({ websiteUrl, businessText, files, profileId, builderMode })
  if (input.sessionId) {
    const existing = await loadCardSession(input.sessionId)
    if (existing && existing.userId === input.userId && existing.sourceHash === sourceHash) {
      if (
        existing.status === 'WAITING_FOR_USER_INPUT' ||
        existing.status === 'READY' ||
        existing.status === 'COMPLETED'
      ) {
        return publicJob(existing)
      }
      if (existing.status === 'FAILED' && existing.normalized?.extractedText) {
        const resumed = await save(existing, {
          status: 'ARCHITECTING',
          errorMessage: null,
          errorCode: null,
          errorStage: null,
          requestId,
        })
        pendingWork.set(resumed.id, { websiteUrl, businessText, files, existingCard: input.existingCard })
        queueWorker(resumed.id, { architectureOnly: true })
        return publicJob(resumed)
      }
      if (
        existing.status === 'QUEUED' ||
        existing.status === 'EXTRACTING' ||
        existing.status === 'ARCHITECTING' ||
        existing.status === 'MAPPING_FIELDS'
      ) {
        pendingWork.set(existing.id, { websiteUrl, businessText, files, existingCard: input.existingCard })
        queueWorker(existing.id)
        return publicJob(existing)
      }
    }
  }

  const session = putCardSession({
    id: input.sessionId || undefined,
    userId: input.userId,
    profileId: profileId || undefined,
    websiteUrl,
    sourceHash,
    requestId,
    builderMode,
    status: 'EXTRACTING',
    normalized: emptyNormalizedSources(websiteUrl),
    businessProfile: null,
    blueprint: null,
    selectedNavIds: ['home'],
    fieldGraph: [],
    recommendedTabs: [],
    rawSources: {
      websiteUrl,
      businessText,
      existingCard: input.existingCard,
      builderMode,
      requestId,
      profileId,
      fileMeta: files.map((file) => ({
        name: file.name,
        mime: file.mimeType,
        size: file.buffer.length,
        sha256: hashBuffer(file.buffer),
      })),
    },
    userProgress: [
      {
        id: 'website',
        label: 'Reading your website',
        status: websiteUrl ? 'active' : 'skipped',
        detail: websiteUrl
          ? 'Reading every public page we can reach, including blogs and portfolio.'
          : 'No website was provided.',
      },
      {
        id: 'documents',
        label: 'Reading your documents',
        status: files.length ? 'active' : 'skipped',
        detail: files.length
          ? 'OCR and document reading run at the same time as the website crawl.'
          : 'No files were uploaded.',
      },
      { id: 'understand', label: 'Understanding your business', status: 'pending' },
      { id: 'design', label: 'Designing your card', status: 'pending' },
      { id: 'map', label: 'Matching what we found', status: 'pending' },
    ],
    architectureVersion: 1,
  })
  await persistCardSession(session)

  pendingWork.set(session.id, { websiteUrl, businessText, files, existingCard: input.existingCard })
  queueWorker(session.id)
  logBuilderEvent('AI_BUILDER_STAGE', {
    requestId,
    profileId,
    builderMode,
    stage: 'source_fetch',
    jobId: session.id,
    sourceType: websiteUrl ? 'url' : files.length ? 'document' : 'text',
  })
  return publicJob(session)
}

function classifyExtractFailure(
  error: unknown,
  normalized?: CardBuildSession['normalized']
): {
  code: BuilderErrorCode
  stage: BuilderStage
} {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/timeout|timed out|abort/i.test(message)) return { code: 'TIMEOUT', stage: 'website_scrape' }
  if (normalized?.website.scrapeFailed && !normalized.documents.length && !normalized.manualText) {
    return { code: 'WEBSITE_FETCH_FAILED', stage: 'website_scrape' }
  }
  if (/ocr/i.test(message)) return { code: 'OCR_FAILED', stage: 'ocr' }
  if (/document|pdf|file/i.test(message)) return { code: 'DOCUMENT_READ_FAILED', stage: 'document_parse' }
  return { code: 'SOURCE_ANALYSIS_FAILED', stage: 'source_fetch' }
}

async function runExtractAndArchitecture(jobId: string) {
  const session = await loadCardSession(jobId)
  const work = pendingWork.get(jobId)
  if (!session) return
  const websiteUrl = work?.websiteUrl || session.websiteUrl || ''
  const businessText = work?.businessText || String(session.rawSources?.businessText || '')
  const files = work?.files || []
  const existingCard = work?.existingCard ?? session.rawSources?.existingCard
  try {
    logBuilderEvent('AI_BUILDER_STAGE', {
      requestId: session.requestId,
      profileId: session.profileId,
      builderMode: session.builderMode,
      stage: websiteUrl ? 'website_scrape' : files.length ? 'document_parse' : 'source_fetch',
      jobId,
    })
    await save(session, { status: 'EXTRACTING' })
    const normalized = session.normalized?.extractedText
      ? session.normalized
      : await normalizeSources({
          websiteUrl,
          businessText,
          files,
        })

    const hasOtherSource =
      Boolean(businessText) ||
      Boolean(existingCard) ||
      normalized.documents.some((doc) => doc.text.trim()) ||
      normalized.ocrResults.some((doc) => doc.text.trim())
    if (normalized.website.scrapeFailed && websiteUrl && !hasOtherSource) {
      throw builderError(
        422,
        'WEBSITE_FETCH_FAILED',
        productErrorMessage('WEBSITE_FETCH_FAILED', "I couldn't read that website."),
        { requestId: session.requestId, stage: 'website_scrape', retryable: true }
      )
    }
    const docsFailed = [...normalized.documents, ...normalized.ocrResults]
    const docsHaveText = docsFailed.some((doc) => doc.text.trim())
    if (files.length && !docsHaveText && !websiteUrl && !businessText && !existingCard) {
      throw builderError(
        422,
        'DOCUMENT_READ_FAILED',
        productErrorMessage('DOCUMENT_READ_FAILED', "I couldn't finish reading that document."),
        { requestId: session.requestId, stage: 'document_parse', retryable: true }
      )
    }

    const extraction = summarizeExtraction(normalized)
    const next = await save(session, {
      status: 'ARCHITECTING',
      normalized,
      websiteUrl,
      sourceHash: session.sourceHash,
      rawSources: {
        ...(session.rawSources || {}),
        websiteUrl,
        businessText,
        existingCard,
      },
      userProgress: [
        ...(extraction.steps || []).map((s) => ({
          id: s.id,
          label: s.label,
          status: s.status,
          detail: s.detail,
        })),
        {
          id: 'understand',
          label: 'Understanding your business',
          status: 'active' as const,
          detail: 'Taking extra time to understand the business from the full site, notes, and documents.',
        },
        { id: 'design', label: 'Designing your card', status: 'pending' as const },
        { id: 'map', label: 'Matching what we found', status: 'pending' as const },
      ],
    })
    await runArchitecture(next.id, existingCard)
  } catch (error) {
    const classified = classifyExtractFailure(error, session.normalized)
    const code = error instanceof AppError && error.code ? (error.code as BuilderErrorCode) : classified.code
    const stage =
      (error instanceof AppError && (error.data as { stage?: BuilderStage } | undefined)?.stage) || classified.stage
    const message = productErrorMessage(code, error instanceof Error ? error.message : 'Could not read your sources.')
    logBuilderEvent('AI_BUILDER_ERROR', {
      requestId: session.requestId,
      profileId: session.profileId,
      builderMode: session.builderMode,
      stage,
      jobId,
      sourceType: websiteUrl ? 'url' : files.length ? 'document' : 'text',
      error: error instanceof Error ? error.message : String(error),
    })
    await save(session, {
      status: 'FAILED',
      errorCode: code,
      errorStage: stage,
      errorMessage: message,
      userProgress: progress(session, websiteUrl ? 'website' : 'documents', 'failed', message),
    })
  }
}

async function runArchitecture(jobId: string, existingCard?: unknown) {
  const session = await loadCardSession(jobId)
  if (!session) return
  const cardSnapshot = existingCard ?? session.rawSources?.existingCard
  try {
    if (session.architecture && session.businessProfile && session.fieldGraph.length) {
      await save(session, { status: 'WAITING_FOR_USER_INPUT' })
      return
    }
    logBuilderEvent('AI_BUILDER_STAGE', {
      requestId: session.requestId,
      profileId: session.profileId,
      builderMode: session.builderMode,
      stage: 'sol_architecture',
      jobId,
    })
    await save(session, {
      status: 'ARCHITECTING',
      userProgress: progress(session, 'understand', 'active'),
    })
    const architecture = await runSolArchitect({
      normalized: session.normalized,
      userId: session.userId,
      sessionId: session.id,
      existingCard: cardSnapshot,
    })
    const profile = seedProfileFromCrawledPages(
      applyExistingCardToProfile(architecture.masterBusinessProfile, cardSnapshot),
      session.normalized.website.pages
    )
    await save(session, {
      status: 'MAPPING_FIELDS',
      businessProfile: profile,
      recommendedTabs: architecture.recommendedTabs,
      architecture: { ...architecture, masterBusinessProfile: profile },
      userProgress: progress({ ...session, userProgress: progress(session, 'understand', 'done') }, 'design', 'done'),
    })
    const selectedNavIds = [
      'home',
      'about',
      ...architecture.recommendedTabs.map((t) => t.navId).filter((id) => id !== 'public-cards' && id !== 'my-info'),
      'public-cards',
      'my-info',
    ].filter((id, index, all) => all.indexOf(id) === index)
    const fieldGraph = buildFieldGraph({
      profile,
      recommendedTabs: architecture.recommendedTabs,
      selectedNavIds,
    })
    const facts = profileToBlueprintFacts(profile, architecture.recommendedTabs)
    const { blueprint } = sanitizeBlueprint(
      cardBlueprintSchema.parse({
        ...facts,
        businessSummary: facts.businessSummary || profile.businessDescription || '',
        suggestedSlug: facts.suggestedSlug || 'my-card',
        personal: facts.personal,
      })
    )
    await save(session, {
      status: 'WAITING_FOR_USER_INPUT',
      businessProfile: profile,
      recommendedTabs: architecture.recommendedTabs,
      architecture: { ...architecture, masterBusinessProfile: profile },
      selectedNavIds,
      fieldGraph,
      blueprint,
      userProgress: [...progress(session, 'understand', 'done')].map((step) =>
        step.id === 'design' || step.id === 'map' ? { ...step, status: 'done' as const } : step
      ),
    })
  } catch (error) {
    logBuilderEvent('AI_BUILDER_ERROR', {
      requestId: session.requestId,
      profileId: session.profileId,
      builderMode: session.builderMode,
      stage: 'sol_architecture',
      jobId,
      error: error instanceof Error ? error.message : String(error),
    })
    await save(session, {
      status: 'FAILED',
      errorCode: 'AI_PLANNING_FAILED',
      errorStage: 'sol_architecture',
      errorMessage: productErrorMessage('AI_PLANNING_FAILED', 'Could not design the card.'),
      userProgress: progress(
        session,
        'understand',
        'failed',
        productErrorMessage('AI_PLANNING_FAILED', 'Could not design the card.')
      ),
    })
  }
}

export async function setSelectedTabs(jobId: string, selectedNavIds: string[], userId?: string) {
  const session = await loadCardSession(jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, userId)
  if (!session.businessProfile) throw new AppError(409, 'The card plan is not ready yet.')
  const allowed = new Set(TAB_CATALOG.map((t) => t.navId))
  const nextIds = [
    'home',
    'about',
    ...selectedNavIds.filter((id) => allowed.has(id) && id !== 'public-cards' && id !== 'my-info'),
    'public-cards',
    'my-info',
  ]
  const unique = [...new Set(nextIds)]
  let fields = session.fieldGraph.filter((field) => unique.includes(field.tabId))
  for (const navId of unique) {
    if (!fields.some((f) => f.tabId === navId)) {
      fields = [...fields, ...fieldsForAddedTab(navId, session.businessProfile)]
    }
  }
  const withContent = await autoFillSelectedFields({
    fields,
    selectedNavIds: unique,
    profile: session.businessProfile,
    userId,
    sessionId: session.id,
  })
  const { blueprint } = assembleAiCard({
    profile: session.businessProfile,
    fields: withContent,
    recommendedTabs: session.recommendedTabs,
    selectedNavIds: unique,
  })
  const updated = await save(session, {
    selectedNavIds: unique,
    fieldGraph: withContent,
    blueprint,
    assembledDraft: blueprint,
    status: 'WAITING_FOR_USER_INPUT',
  })
  return publicJob(updated)
}

export async function generatePermissionedContent(input: { jobId: string; kind: 'faq' | 'blog'; userId?: string }) {
  const session = await loadCardSession(input.jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, input.userId)
  if (!session.businessProfile) throw new AppError(409, 'The card plan is not ready yet.')
  const section = input.kind === 'faq' ? 'faqs' : 'blogs'
  const payload = await generateSectionFromProfile({
    section,
    profile: session.businessProfile,
    instruction:
      input.kind === 'faq'
        ? 'Create up to 5 helpful FAQs from verified services and business facts. Do not invent prices, hours, guarantees, certifications, turnaround times, or service areas.'
        : 'Draft up to 5 evergreen educational articles. Do not invent news events, dates, awards, or statistics.',
    userId: input.userId,
    sessionId: session.id,
  })
  const fieldKey = input.kind === 'faq' ? 'faqs' : 'blogs'
  const field = session.fieldGraph.find((row) => row.fieldKey === fieldKey)
  const value = capGeneratedList(
    section === 'faqs' ? (payload as { faqs?: unknown[] }).faqs : (payload as { blogs?: unknown[] }).blogs
  )
  let fields = session.fieldGraph
  if (field) {
    fields = mergeFieldDecision(fields, {
      id: field.id,
      currentValue: value,
      status: Array.isArray(value) && value.length ? 'READY' : 'EMPTY',
      source: 'AI',
      userDecision: true,
    })
  }
  const updated = await save(session, { fieldGraph: fields, status: 'WAITING_FOR_USER_INPUT' })
  const assembled = await assembleAndReady(updated)
  return { ...publicJob(assembled), payload, generatedCount: Array.isArray(value) ? value.length : 0 }
}

export async function applyFieldAction(input: {
  jobId: string
  fieldId: string
  action: FieldAction
  value?: unknown
  instruction?: string
  userId?: string
}) {
  const session = await loadCardSession(input.jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, input.userId)
  if (!session.businessProfile) throw new AppError(409, 'The card plan is not ready yet.')
  const field = session.fieldGraph.find((row) => row.id === input.fieldId)
  if (!field) throw new AppError(404, 'That card field was not found.')

  let next: AiCardField
  if (input.action === 'SKIP') {
    if (field.required) {
      throw new AppError(400, `${field.fieldLabel} is required and cannot be skipped.`)
    }
    next = skipField(field)
  } else if (input.action === 'KEEP_THIS' || input.action === 'USE_EXISTING' || input.action === 'KEEP_NAMES_ONLY') {
    next = {
      ...field,
      status: 'READY',
      userDecision: true,
      source: field.source === 'NONE' ? 'EXISTING_CARD' : field.source,
    }
  } else if (input.action === 'USER_INPUT' || input.action === 'UPLOAD') {
    if (input.value == null || (typeof input.value === 'string' && !input.value.trim())) {
      throw new AppError(400, 'Add a value before saving.')
    }
    if (field.fieldKey === 'dob') {
      const issue = collectCardDobIssues({ dob: input.value })[0]
      if (issue) throw new AppError(400, cardCreationIssueMessage(issue))
    }
    if (field.fieldKey === 'email') {
      const email = normalizeCardEmail(input.value)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new AppError(400, 'Enter a valid email address for this card.')
      }
      next = applyUserFieldValue(field, email)
    } else if (field.fieldKey === 'phone') {
      const digits = normalizeCardPhone(input.value)
      if (digits.length < 7 || digits.length > 15) {
        throw new AppError(400, 'Enter a valid phone number for this card.')
      }
      next = applyUserFieldValue(field, String(input.value).trim())
    } else {
      next = applyUserFieldValue(field, input.value)
    }
  } else if (input.action === 'AI_GENERATE' || input.action === 'IMPROVE_WITH_AI') {
    if (field.special === 'faq' || field.special === 'blog') {
      return generatePermissionedContent({
        jobId: input.jobId,
        kind: field.special === 'faq' ? 'faq' : 'blog',
        userId: input.userId,
      })
    }
    const generated = await generateFieldCopy({
      field,
      profile: session.businessProfile,
      instruction: input.instruction,
      currentText: typeof input.value === 'string' ? input.value : undefined,
      userId: input.userId,
      sessionId: session.id,
    })
    next = {
      ...field,
      currentValue: generated,
      status: 'READY',
      source: 'AI',
      userDecision: true,
    }
  } else {
    throw new AppError(400, 'Unsupported field action.')
  }

  const fields = mergeFieldDecision(session.fieldGraph, next)
  let updated = await save(session, { fieldGraph: fields, status: 'WAITING_FOR_USER_INPUT' })
  try {
    if (updated.businessProfile) updated = await assembleAndReady(updated)
  } catch {
    /* keep the saved field even if assembly still needs other required values */
  }
  return { ...publicJob(updated), field: next }
}

export async function runFastMode(jobId: string, mode: 'ai' | 'found' | 'review', userId?: string) {
  const session = await loadCardSession(jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, userId)
  if (!session.businessProfile) throw new AppError(409, 'The card plan is not ready yet.')

  if (mode === 'found') {
    const fields = session.fieldGraph.map((field) =>
      !field.required && (field.status === 'EMPTY' || field.status === 'PARTIAL') ? skipField(field) : field
    )
    return publicJob(await assembleAndReady(await save(session, { fieldGraph: fields })))
  }

  if (mode === 'review') {
    return publicJob(session)
  }

  await save(session, { status: 'GENERATING' })
  const filled = await autoFillSelectedFields({
    fields: session.fieldGraph,
    selectedNavIds: session.selectedNavIds,
    profile: session.businessProfile,
    userId,
    sessionId: session.id,
  })
  return publicJob(await assembleAndReady(await save(session, { fieldGraph: filled })))
}

async function assembleAndReady(session: CardBuildSession) {
  if (!session.businessProfile) throw new AppError(409, 'Missing business profile.')
  const assembling = await save(session, { status: 'ASSEMBLING' })
  const { blueprint, issues } = assembleAiCard({
    profile: assembling.businessProfile!,
    fields: assembling.fieldGraph,
    recommendedTabs: assembling.recommendedTabs,
    selectedNavIds: assembling.selectedNavIds,
  })
  const requiredEmpty = assembling.fieldGraph.filter(
    (field) => assembling.selectedNavIds.includes(field.tabId) && field.required && field.status !== 'READY'
  )
  if (requiredEmpty.length) {
    return save(assembling, {
      status: 'WAITING_FOR_USER_INPUT',
      blueprint,
      errorMessage: `Still need: ${requiredEmpty.map((f) => f.fieldLabel).join(', ')}.`,
    })
  }
  return save(assembling, {
    status: 'READY',
    blueprint,
    assembledDraft: blueprint,
    errorMessage: issues.length ? issues.map((i) => i.message).join(' ') : null,
  })
}

export async function assembleJob(jobId: string, userId?: string) {
  const session = await loadCardSession(jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, userId)
  return publicJob(await assembleAndReady(session))
}

export async function applyJob(input: {
  jobId: string
  userId: string
  role: string
  publish?: boolean
  seo?: { metaTitle?: string; metaDescription?: string; metaKeywords?: unknown[] }
}) {
  const session = await loadCardSession(input.jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, input.userId)
  if (session.status === 'COMPLETED' && session.profileId) {
    return { ...publicJob(session), profileId: session.profileId }
  }
  const ready = session.status === 'READY' ? session : await assembleAndReady(session)
  if (ready.status !== 'READY' || !ready.blueprint) {
    throw new AppError(409, ready.errorMessage || 'Finish the remaining card details first.')
  }
  const personal = ready.blueprint.personal
  const identityIssue = collectCardCreationIssues({
    email: personal.email,
    phone: personal.phone,
    dob: personal.dob,
  })[0]
  if (identityIssue) {
    throw new AppError(400, cardCreationIssueMessage(identityIssue))
  }
  if (input.publish === true) {
    const issues = collectCardActivationIssues({
      slug: ready.blueprint.suggestedSlug,
      name: personal.fullName || personal.company,
      email: personal.email,
      dob: personal.dob,
      phone: personal.phone,
    })
    if (issues.length) throw new AppError(422, cardActivationIssueMessage(issues))
  }
  await save(ready, { status: 'APPLYING' })
  const profileService = (await import('../profile.service')).default
  const created = await profileService.create(input.userId, input.role, {
    name: personal.fullName || personal.company || 'My Card',
    email: personal.email,
    dob: personal.dob || undefined,
    phone: personal.phone,
    whatsapp: personal.whatsapp,
    website: personal.website,
    address: personal.address,
    about: personal.about,
    companyName: personal.company,
    designation: personal.designation,
    slug: ready.blueprint.suggestedSlug,
    isDraft: input.publish !== true,
    isPublic: input.publish === true,
    facebook: ready.blueprint.socialHandles?.facebook,
    instagram: ready.blueprint.socialHandles?.instagram,
    twitter: ready.blueprint.socialHandles?.twitter,
    linkedin: ready.blueprint.socialHandles?.linkedin,
    youtube: ready.blueprint.socialHandles?.youtube,
    tiktok: ready.blueprint.socialHandles?.tiktok,
    settings: input.seo
      ? seoMetadataToSettings({
          metaTitle: input.seo.metaTitle,
          metaDescription: input.seo.metaDescription,
          keywords: input.seo.metaKeywords?.filter((value): value is string => typeof value === 'string'),
        })
      : undefined,
  })

  const profileId = created.id as string
  const collections: Array<
    [
      'services' | 'education' | 'experiences' | 'portfolios' | 'reviews' | 'skillTags',
      unknown[],
      (item: Record<string, unknown>) => Record<string, unknown>,
    ]
  > = [
    [
      'services',
      ready.blueprint.services || [],
      (item) => ({
        title: item.title,
        description: item.description,
        reviewUrl: item.url,
        imageUrl: item.imageUrl || item.featuredImage,
        status: 1,
      }),
    ],
    [
      'education',
      ready.blueprint.education || [],
      (item) => ({
        institute: item.institute,
        degree: item.degree,
        fromDate: item.fromDate ? new Date(String(item.fromDate)) : null,
        toDate: item.toDate ? new Date(String(item.toDate)) : null,
        tillNow: Boolean(item.tillNow),
      }),
    ],
    [
      'experiences',
      ready.blueprint.experience || [],
      (item) => ({
        company: item.company,
        jobTitle: item.jobTitle,
        description: item.description,
        fromDate: item.fromDate ? new Date(String(item.fromDate)) : null,
        toDate: item.toDate ? new Date(String(item.toDate)) : null,
        tillNow: Boolean(item.tillNow),
      }),
    ],
    [
      'portfolios',
      ready.blueprint.portfolio || [],
      (item) => ({
        title: item.title,
        description: item.description,
        url: item.url,
        featuredImage: item.imageUrl || item.featuredImage,
        imageUrl: item.imageUrl || item.featuredImage,
        status: 1,
      }),
    ],
    [
      'reviews',
      ready.blueprint.reviews || [],
      (item) => ({
        author: item.author,
        text: item.text,
        rating: item.rating || 5,
        status: 1,
        imageUrl: item.imageUrl,
        reviewUrl: item.reviewUrl || item.url,
      }),
    ],
    [
      'skillTags',
      (ready.blueprint.skills || []).flatMap((group) => {
        const category = String(group.type || 'General')
        const names = Array.isArray(group.skills) ? group.skills : []
        return names.filter((name) => String(name || '').trim()).map((name) => ({ name, level: category }))
      }),
      (item) => ({
        name: item.name,
        level: item.level || null,
      }),
    ],
  ]

  for (const [key, items, map] of collections) {
    if (!items.length) continue
    await profileService.replaceCollection(
      profileId,
      input.userId,
      input.role,
      key,
      items as Array<Record<string, unknown>>,
      map
    )
  }

  const aboutText = String(personal.about || '').trim()
  if (aboutText) {
    await profileService.upsertAboutMe(profileId, input.userId, input.role, {
      title: personal.fullName || personal.company || '',
      description: aboutText.includes('<') ? aboutText : `<p>${aboutText}</p>`,
      status: '1',
    })
  }

  for (const faq of ready.blueprint.faqs || []) {
    const question = String(faq.question || '').trim()
    const answer = String(faq.answer || '').trim()
    if (!question && !answer) continue
    await profileService.createPost(profileId, input.userId, input.role, {
      postTypeName: 'Faq',
      title: question || 'FAQ',
      description: answer,
      status: '1',
    })
  }
  for (const blog of ready.blueprint.blogs || []) {
    const title = String(blog.title || '').trim()
    const description = String(blog.description || '').trim()
    if (!title && !description) continue
    await profileService.createPost(profileId, input.userId, input.role, {
      postTypeName: 'blog',
      title: title || 'Article',
      description,
      url: String(blog.url || '').trim() || undefined,
      featuredImage: String(blog.imageUrl || '').trim() || undefined,
      status: '1',
      metas: { category: String(blog.category || 'News') },
    })
  }

  const completed = await save(ready, { status: 'COMPLETED', profileId })
  return { ...publicJob(completed), profileId }
}
