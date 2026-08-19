import { randomUUID } from 'crypto'
import AppError from '../../error/AppError'
import type { MasterBusinessProfile } from './businessProfile.schema'
import type { CardBlueprint } from './cardBlueprint.schema'
import type { AiCardField } from './fieldGraph.service'
import type { NormalizedSourceData } from './sourceNormalizer.service'
import type { RecommendedTab } from './tabDecision.service'

export type AiCardJobStatus =
  | 'QUEUED'
  | 'EXTRACTING'
  | 'ARCHITECTING'
  | 'MAPPING_FIELDS'
  | 'WAITING_FOR_USER_INPUT'
  | 'GENERATING'
  | 'ASSEMBLING'
  | 'VALIDATING'
  | 'READY'
  | 'APPLYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

export type UserProgressStep = {
  id: string
  label: string
  status: 'pending' | 'active' | 'done' | 'skipped' | 'failed'
  detail?: string
}

export type CardBuildSession = {
  id: string
  userId?: string
  profileId?: string
  websiteUrl?: string
  sourceHash?: string
  status: AiCardJobStatus
  normalized: NormalizedSourceData
  businessProfile: MasterBusinessProfile | null
  blueprint: CardBlueprint | null
  architecture?: unknown
  selectedNavIds: string[]
  fieldGraph: AiCardField[]
  recommendedTabs: RecommendedTab[]
  assembledDraft?: unknown
  userProgress: UserProgressStep[]
  errorMessage?: string | null
  errorCode?: string | null
  errorStage?: string | null
  requestId?: string
  builderMode?: 'create' | 'update'
  rawSources?: Record<string, unknown>
  architectureVersion: number
  createdAt: number
}

const memory = new Map<string, CardBuildSession>()
const TTL_MS = 24 * 60 * 60 * 1000

function persistableNormalized(normalized: NormalizedSourceData) {
  return {
    ...normalized,
    images: normalized.images.map((img) => ({ mimeType: img.mimeType, omitted: true })),
  }
}

function prune() {
  const now = Date.now()
  for (const [id, session] of memory) {
    if (now - session.createdAt > TTL_MS) memory.delete(id)
  }
}

function restoreMeta(row: {
  rawSources?: unknown
  architecture?: unknown
  errorMessage?: string | null
}): Pick<CardBuildSession, 'requestId' | 'builderMode' | 'errorCode' | 'errorStage' | 'rawSources'> {
  const raw = (row.rawSources && typeof row.rawSources === 'object' ? row.rawSources : {}) as Record<string, unknown>
  const architecture = (row.architecture && typeof row.architecture === 'object' ? row.architecture : {}) as {
    builderMeta?: { requestId?: string; builderMode?: 'create' | 'update'; stage?: string; errorCode?: string }
  }
  return {
    rawSources: raw,
    requestId: typeof raw.requestId === 'string' ? raw.requestId : architecture.builderMeta?.requestId,
    builderMode:
      raw.builderMode === 'update' || architecture.builderMeta?.builderMode === 'update' ? 'update' : 'create',
    errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : architecture.builderMeta?.errorCode || undefined,
    errorStage: typeof raw.errorStage === 'string' ? raw.errorStage : architecture.builderMeta?.stage || undefined,
  }
}

function emptyNormalized(): NormalizedSourceData {
  return {
    website: { url: '', pages: [], scrapeFailed: false },
    documents: [],
    ocrResults: [],
    images: [],
    manualText: '',
    userInstructions: '',
    extractedText: '',
    warnings: [],
  } as NormalizedSourceData
}

export function putCardSession(
  session: Omit<CardBuildSession, 'id' | 'createdAt'> & { id?: string; createdAt?: number }
): CardBuildSession {
  prune()
  const saved: CardBuildSession = {
    ...session,
    selectedNavIds: session.selectedNavIds || ['home'],
    fieldGraph: session.fieldGraph || [],
    recommendedTabs: session.recommendedTabs || [],
    userProgress: session.userProgress || [],
    architectureVersion: session.architectureVersion || 1,
    status: session.status || 'QUEUED',
    id: session.id || randomUUID(),
    createdAt: session.createdAt || Date.now(),
  }
  memory.set(saved.id, saved)
  void persistSession(saved)
  return saved
}

export function getCardSession(id?: string | null): CardBuildSession | undefined {
  if (!id) return undefined
  const session = memory.get(id)
  if (session && Date.now() - session.createdAt <= TTL_MS) return session
  return undefined
}

export async function loadCardSession(id?: string | null): Promise<CardBuildSession | undefined> {
  const memoryHit = getCardSession(id)
  if (memoryHit) return memoryHit
  if (!id) return undefined
  try {
    const { prisma } = await import('../../utils/prisma')
    const row = await prisma.aiCardSession.findUnique({ where: { id } })
    if (!row) return undefined
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return undefined
    const restored: CardBuildSession = {
      id: row.id,
      userId: row.userId || undefined,
      profileId: row.profileId || undefined,
      websiteUrl: row.websiteUrl || undefined,
      sourceHash: row.sourceHash || undefined,
      status: (row.status as AiCardJobStatus) || 'QUEUED',
      normalized: (row.normalizedSources as NormalizedSourceData) || emptyNormalized(),
      businessProfile: (row.businessProfile as MasterBusinessProfile) || null,
      blueprint: (row.finalBlueprint as CardBlueprint) || null,
      architecture: row.architecture,
      selectedNavIds: Array.isArray(row.selectedNavIds) ? (row.selectedNavIds as string[]) : ['home'],
      fieldGraph: Array.isArray(row.fieldGraph) ? (row.fieldGraph as AiCardField[]) : [],
      recommendedTabs: ((row.architecture as { recommendedTabs?: RecommendedTab[] } | null)?.recommendedTabs ||
        []) as RecommendedTab[],
      assembledDraft: row.assembledDraft,
      userProgress: Array.isArray(row.userProgress) ? (row.userProgress as UserProgressStep[]) : [],
      errorMessage: row.errorMessage,
      architectureVersion: row.architectureVersion || 1,
      createdAt: row.createdAt.getTime(),
      ...restoreMeta(row),
    }
    memory.set(restored.id, restored)
    return restored
  } catch {
    return undefined
  }
}

async function persistSession(session: CardBuildSession) {
  const architecture = {
    ...((session.architecture && typeof session.architecture === 'object' ? session.architecture : {}) as object),
    recommendedTabs: session.recommendedTabs,
    builderMeta: {
      requestId: session.requestId,
      builderMode: session.builderMode || 'create',
      stage: session.errorStage,
      errorCode: session.errorCode,
    },
  }
  const rawSources = {
    ...(session.rawSources || {}),
    requestId: session.requestId,
    builderMode: session.builderMode || 'create',
    errorCode: session.errorCode,
    errorStage: session.errorStage,
  }
  try {
    const { prisma } = await import('../../utils/prisma')
    await prisma.aiCardSession.upsert({
      where: { id: session.id },
      create: {
        id: session.id,
        userId: session.userId || null,
        profileId: session.profileId || null,
        websiteUrl: session.websiteUrl || null,
        sourceHash: session.sourceHash || null,
        status: session.status,
        rawSources: rawSources as object,
        normalizedSources: persistableNormalized(session.normalized) as object,
        businessProfile: session.businessProfile as object | undefined,
        finalBlueprint: session.blueprint as object | undefined,
        architecture: architecture as object,
        selectedNavIds: session.selectedNavIds as object,
        fieldGraph: session.fieldGraph as object,
        assembledDraft: session.assembledDraft as object | undefined,
        userProgress: session.userProgress as object,
        errorMessage: session.errorMessage || null,
        architectureVersion: session.architectureVersion,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
      update: {
        profileId: session.profileId || null,
        websiteUrl: session.websiteUrl || null,
        sourceHash: session.sourceHash || null,
        status: session.status,
        rawSources: rawSources as object,
        normalizedSources: persistableNormalized(session.normalized) as object,
        businessProfile: session.businessProfile as object | undefined,
        finalBlueprint: session.blueprint as object | undefined,
        architecture: architecture as object,
        selectedNavIds: session.selectedNavIds as object,
        fieldGraph: session.fieldGraph as object,
        assembledDraft: session.assembledDraft as object | undefined,
        userProgress: session.userProgress as object,
        errorMessage: session.errorMessage || null,
        architectureVersion: session.architectureVersion,
        updatedAt: new Date(),
      },
    })
  } catch (error) {
    const { default: logger } = await import('../../utils/logger')
    logger.error('AI_BUILDER_ERROR', {
      stage: 'persistence',
      jobId: session.id,
      requestId: session.requestId,
      error: error instanceof Error ? error.message : 'persist failed',
    })
  }
}

export async function persistCardSession(session: CardBuildSession) {
  await persistSession(session)
}

export function assertJobOwner(session: CardBuildSession, userId?: string) {
  if (session.userId && userId && session.userId !== userId) {
    throw new AppError(403, 'This card job belongs to another account.')
  }
}
