import AppError from '../../error/AppError'
import { cardActivationIssueMessage, collectCardActivationIssues } from '../../utils/cardActivation'
import { seoMetadataToSettings } from '../seoMetadata.service'
import { summarizeExtraction } from './cardAgent.service'
import { assembleAiCard } from './cardAssembler.service'
import { cardBlueprintSchema, TAB_CATALOG } from './cardBlueprint.schema'
import {
  assertJobOwner,
  loadCardSession,
  putCardSession,
  type CardBuildSession,
  type UserProgressStep,
} from './cardSession.store'
import { buildCompletenessReport } from './completeness.service'
import { profileToBlueprintFacts } from './contentGenerator.service'
import type { UploadedPart } from './extractDocumentText'
import { applyUserFieldValue, generateFieldCopy, skipField, type FieldAction } from './fieldCompletion.service'
import {
  buildFieldGraph,
  buildTabPlan,
  fieldsForAddedTab,
  mergeFieldDecision,
  nextActionableField,
  type AiCardField,
} from './fieldGraph.service'
import { runSolArchitect } from './solArchitect.service'
import { normalizeSources } from './sourceNormalizer.service'
import { sanitizeBlueprint } from './validation.service'

const running = new Set<string>()

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
  return publicJob(session)
}

async function save(session: CardBuildSession, patch: Partial<CardBuildSession>) {
  return putCardSession({
    ...session,
    ...patch,
    id: session.id,
    createdAt: session.createdAt,
  })
}

export async function startCardJob(input: {
  websiteUrl?: string
  businessText?: string
  files?: UploadedPart[]
  existingCard?: unknown
  userId?: string
  sessionId?: string
}) {
  const websiteUrl = (input.websiteUrl || '').trim()
  const businessText = (input.businessText || '').trim()
  const files = input.files || []
  if (!websiteUrl && !businessText && files.length === 0 && !input.existingCard) {
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

  const extraction = summarizeExtraction(session.normalized)
  const next = await save(session, {
    status: 'ARCHITECTING',
    userProgress: [
      ...(extraction.steps || []).map((s) => ({
        id: s.id,
        label: s.label,
        status: s.status,
        detail: s.detail,
      })),
      { id: 'understand', label: 'Understanding your business', status: 'active' as const },
      { id: 'design', label: 'Designing your card', status: 'pending' as const },
      { id: 'map', label: 'Matching what we found', status: 'pending' as const },
    ],
  })

  if (!running.has(next.id)) {
    running.add(next.id)
    void runArchitecture(next.id, input.existingCard).finally(() => running.delete(next.id))
  }

  return publicJob(next)
}

async function runArchitecture(jobId: string, existingCard?: unknown) {
  const session = await loadCardSession(jobId)
  if (!session) return
  try {
    if (session.architecture && session.businessProfile && session.fieldGraph.length) {
      await save(session, { status: 'WAITING_FOR_USER_INPUT' })
      return
    }
    await save(session, {
      status: 'ARCHITECTING',
      userProgress: progress(session, 'understand', 'active'),
    })
    const architecture = await runSolArchitect({
      normalized: session.normalized,
      userId: session.userId,
      sessionId: session.id,
      existingCard,
    })
    await save(session, {
      status: 'MAPPING_FIELDS',
      businessProfile: architecture.masterBusinessProfile,
      recommendedTabs: architecture.recommendedTabs,
      architecture,
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
      profile: architecture.masterBusinessProfile,
      recommendedTabs: architecture.recommendedTabs,
      selectedNavIds,
    })
    const facts = profileToBlueprintFacts(architecture.masterBusinessProfile, architecture.recommendedTabs)
    const { blueprint } = sanitizeBlueprint(
      cardBlueprintSchema.parse({
        ...facts,
        businessSummary: facts.businessSummary || architecture.masterBusinessProfile.businessDescription || '',
        suggestedSlug: facts.suggestedSlug || 'my-card',
        personal: facts.personal,
      })
    )
    await save(session, {
      status: 'WAITING_FOR_USER_INPUT',
      businessProfile: architecture.masterBusinessProfile,
      recommendedTabs: architecture.recommendedTabs,
      architecture,
      selectedNavIds,
      fieldGraph,
      blueprint,
      userProgress: [...progress(session, 'understand', 'done')].map((step) =>
        step.id === 'design' || step.id === 'map' ? { ...step, status: 'done' as const } : step
      ),
    })
  } catch (error) {
    await save(session, {
      status: 'FAILED',
      errorMessage: error instanceof Error ? error.message : 'Could not design the card.',
      userProgress: progress(session, 'understand', 'failed', error instanceof Error ? error.message : undefined),
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
  const updated = await save(session, { selectedNavIds: unique, fieldGraph: fields, status: 'WAITING_FOR_USER_INPUT' })
  return publicJob(updated)
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
    next = applyUserFieldValue(field, input.value)
  } else if (input.action === 'AI_GENERATE' || input.action === 'IMPROVE_WITH_AI') {
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
  const updated = await save(session, { fieldGraph: fields, status: 'WAITING_FOR_USER_INPUT' })
  return { ...publicJob(updated), field: next }
}

export async function runFastMode(jobId: string, mode: 'ai' | 'found' | 'review', userId?: string) {
  const session = await loadCardSession(jobId)
  if (!session) throw new AppError(404, 'Card job not found.')
  assertJobOwner(session, userId)
  if (!session.businessProfile) throw new AppError(409, 'The card plan is not ready yet.')

  if (mode === 'found') {
    const fields = session.fieldGraph.map((field) =>
      field.status === 'EMPTY' || field.status === 'PARTIAL' ? skipField(field) : field
    )
    return publicJob(await assembleAndReady(await save(session, { fieldGraph: fields })))
  }

  if (mode === 'review') {
    return publicJob(session)
  }

  await save(session, { status: 'GENERATING' })
  let fields = [...session.fieldGraph]
  const auto = fields.filter(
    (field) =>
      session.selectedNavIds.includes(field.tabId) &&
      field.aiGenerationAllowed &&
      (field.status === 'EMPTY' || field.status === 'PARTIAL')
  )
  await Promise.all(
    auto.slice(0, 6).map(async (field) => {
      try {
        const generated = await generateFieldCopy({
          field,
          profile: session.businessProfile!,
          userId,
          sessionId: session.id,
        })
        fields = mergeFieldDecision(fields, {
          id: field.id,
          currentValue: generated,
          status: 'READY',
          source: 'AI',
          userDecision: true,
        })
      } catch {
        fields = mergeFieldDecision(fields, skipField(field))
      }
    })
  )
  const leftover = fields.map((field) =>
    !field.aiGenerationAllowed && (field.status === 'EMPTY' || field.status === 'PARTIAL') ? field : field
  )
  return publicJob(await assembleAndReady(await save(session, { fieldGraph: leftover })))
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
    (field) =>
      assembling.selectedNavIds.includes(field.tabId) &&
      field.required &&
      field.status !== 'READY' &&
      field.status !== 'SKIPPED'
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
      'services' | 'education' | 'experiences' | 'portfolios' | 'reviews',
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

  const completed = await save(ready, { status: 'COMPLETED', profileId })
  return { ...publicJob(completed), profileId }
}
