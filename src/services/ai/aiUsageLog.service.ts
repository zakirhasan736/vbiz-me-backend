import type { ChatJsonMeta } from './openai.client'

export type UsageLogInput = {
  userId?: string
  profileId?: string
  sessionId?: string
  jobId?: string
  stage?: string
  task: string
  model: string
  tier: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  retryNumber?: number
  estimatedCost: number
  latencyMs: number
  success: boolean
  escalatedFrom?: string | null
  error?: string | null
}

export async function logAiUsage(entry: UsageLogInput): Promise<void> {
  try {
    const { prisma } = await import('../../utils/prisma')
    await prisma.aiGenerationLog.create({
      data: {
        userId: entry.userId || null,
        profileId: entry.profileId || null,
        sessionId: entry.sessionId || null,
        jobId: entry.jobId || entry.sessionId || null,
        stage: entry.stage || null,
        task: entry.task,
        model: entry.model,
        tier: entry.tier,
        inputTokens: entry.inputTokens,
        cachedInputTokens: entry.cachedInputTokens || 0,
        outputTokens: entry.outputTokens,
        estimatedCost: entry.estimatedCost,
        latencyMs: entry.latencyMs,
        retryNumber: entry.retryNumber || 0,
        success: entry.success,
        escalatedFrom: entry.escalatedFrom || null,
        error: entry.error || null,
      },
    })
  } catch {
    /* logging must never break card generation */
  }
}

export async function logChatMeta(task: string, meta: ChatJsonMeta, extra?: Partial<UsageLogInput>): Promise<void> {
  await logAiUsage({
    task,
    model: meta.model,
    tier: meta.tier,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    estimatedCost: meta.estimatedCost,
    latencyMs: meta.latencyMs,
    success: extra?.success ?? true,
    userId: extra?.userId,
    profileId: extra?.profileId,
    sessionId: extra?.sessionId,
    jobId: extra?.jobId,
    stage: extra?.stage,
    escalatedFrom: extra?.escalatedFrom,
    error: extra?.error,
  })
}
