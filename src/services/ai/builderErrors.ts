import { randomUUID } from 'crypto'
import AppError from '../../error/AppError'
import logger from '../../utils/logger'

export const BUILDER_STAGES = [
  'existing_card_load',
  'source_fetch',
  'website_scrape',
  'document_upload',
  'document_parse',
  'ocr',
  'business_profile',
  'sol_architecture',
  'tab_recommendation',
  'completion_analysis',
  'persistence',
] as const

export type BuilderStage = (typeof BUILDER_STAGES)[number]

export type BuilderErrorCode =
  | 'NETWORK_ERROR'
  | 'VALIDATION_FAILED'
  | 'INVALID_URL'
  | 'PROFILE_REQUIRED'
  | 'WEBSITE_FETCH_FAILED'
  | 'DOCUMENT_READ_FAILED'
  | 'OCR_FAILED'
  | 'SOURCE_ANALYSIS_FAILED'
  | 'AI_PLANNING_FAILED'
  | 'TIMEOUT'
  | 'DATABASE_FAILURE'
  | 'RATE_LIMITED'

export function newRequestId(incoming?: string): string {
  const value = String(incoming || '').trim()
  return /^[a-zA-Z0-9_-]{8,80}$/.test(value) ? value : randomUUID()
}

export function builderError(
  status: number,
  code: BuilderErrorCode,
  message: string,
  input?: { requestId?: string; stage?: BuilderStage; retryable?: boolean; data?: Record<string, unknown> }
) {
  return new AppError(status, message, {
    code,
    data: {
      requestId: input?.requestId || newRequestId(),
      stage: input?.stage,
      retryable: input?.retryable ?? (status >= 500 || status === 429),
      ...(input?.data || {}),
    },
  })
}

export function logBuilderEvent(
  event: 'AI_BUILDER_ERROR' | 'AI_BUILDER_STAGE',
  input: {
    requestId?: string
    profileId?: string
    builderMode?: string
    stage?: string
    sourceType?: string
    error?: string
    jobId?: string
  }
) {
  logger.info(event, {
    requestId: input.requestId,
    profileId: input.profileId,
    builderMode: input.builderMode,
    stage: input.stage,
    sourceType: input.sourceType,
    jobId: input.jobId,
    error: input.error ? String(input.error).slice(0, 300) : undefined,
  })
}
