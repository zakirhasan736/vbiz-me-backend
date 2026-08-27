export type AiTier = 'luna' | 'terra' | 'sol' | 'vision'
export type ComplexityLevel = 'normal' | 'complex' | 'very_complex'
export type AiTask = 'CARD_ARCHITECTURE' | 'HIGH_QUALITY_WRITING' | 'SIMPLE_VOLUME' | 'VISION' | 'STRUCTURED_TRANSFORM'

export type RoutingInput = {
  confidence?: number
  complexity?: ComplexityLevel
  conflictingSources?: boolean
  validationFailed?: boolean
  terraFailed?: boolean
  ocrQualityPoor?: boolean
}

const TIER_ENV: Record<AiTier, string | undefined> = {
  luna: process.env.OPENAI_CARD_MODEL_LUNA,
  terra: process.env.OPENAI_CARD_MODEL_TERRA,
  sol: process.env.OPENAI_CARD_MODEL_SOL,
  vision: process.env.OPENAI_CARD_MODEL_VISION,
}

const TIER_DEFAULTS: Record<AiTier, string> = {
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
  vision: 'gpt-4o',
}

/** USD per 1M tokens — overridable via env for cost reporting. */
const COST_PER_M: Record<AiTier, { input: number; output: number }> = {
  luna: {
    input: Number(process.env.AI_COST_LUNA_INPUT_PER_M || 0.15),
    output: Number(process.env.AI_COST_LUNA_OUTPUT_PER_M || 0.6),
  },
  terra: {
    input: Number(process.env.AI_COST_TERRA_INPUT_PER_M || 2.5),
    output: Number(process.env.AI_COST_TERRA_OUTPUT_PER_M || 10),
  },
  sol: {
    input: Number(process.env.AI_COST_SOL_INPUT_PER_M || 2),
    output: Number(process.env.AI_COST_SOL_OUTPUT_PER_M || 8),
  },
  vision: {
    input: Number(process.env.AI_COST_VISION_INPUT_PER_M || 2.5),
    output: Number(process.env.AI_COST_VISION_OUTPUT_PER_M || 10),
  },
}

export function getModelForTier(tier: AiTier): string {
  return TIER_ENV[tier]?.trim() || TIER_DEFAULTS[tier]
}

const TIER_FALLBACKS: Record<AiTier, string[]> = {
  sol: ['gpt-5.6-sol', 'gpt-5.2', 'gpt-4.1', 'gpt-4o'],
  terra: ['gpt-5.6-terra', 'gpt-5.2', 'gpt-4.1', 'gpt-4o'],
  luna: ['gpt-5.6-luna', 'gpt-4o-mini', 'gpt-4o'],
  vision: ['gpt-4o'],
}

/** Preferred model first, then compatible fallbacks. Never shown in the UI. */
export function modelCandidatesForTier(tier: AiTier): string[] {
  const preferred = getModelForTier(tier)
  const seen = new Set<string>()
  const list: string[] = []
  for (const model of [preferred, ...TIER_FALLBACKS[tier]]) {
    const id = model.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push(id)
  }
  return list
}

export function isUnavailableModelError(error: unknown): boolean {
  const err = error as { status?: number; code?: string; message?: string }
  const message = String(err.message || '')
  return (
    err.status === 404 ||
    err.code === 'model_not_found' ||
    /model[s]? .* (not found|does not exist|is not available)|invalid model|unknown model/i.test(message)
  )
}

export function isUnsupportedParameterError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || '')
  return /unsupported.*(temperature|max_tokens|parameter)|unknown parameter|does not support/i.test(message)
}

export function estimateCostUsd(tier: AiTier, inputTokens: number, outputTokens: number): number {
  const rates = COST_PER_M[tier]
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output
}

export function assessComplexity(flags: {
  sourceCount?: number
  pageCount?: number
  textLength?: number
  ocrUsed?: boolean
  ocrQualityPoor?: boolean
  conflictingSources?: boolean
  unrelatedServiceSpread?: boolean
  industryUnclear?: boolean
  validationFailed?: boolean
}): { complexity: ComplexityLevel; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  if ((flags.sourceCount || 0) >= 4) {
    score += 1
    reasons.push('many_sources')
  }
  if ((flags.pageCount || 0) >= 10) {
    score += 1
    reasons.push('large_site')
  }
  if ((flags.textLength || 0) > 40_000) {
    score += 1
    reasons.push('long_source_text')
  }
  if (flags.ocrUsed) {
    score += 1
    reasons.push('ocr_used')
  }
  if (flags.ocrQualityPoor) {
    score += 2
    reasons.push('poor_ocr')
  }
  if (flags.conflictingSources) {
    score += 2
    reasons.push('conflicts')
  }
  if (flags.unrelatedServiceSpread) {
    score += 2
    reasons.push('unrelated_services')
  }
  if (flags.industryUnclear) {
    score += 2
    reasons.push('unclear_industry')
  }
  if (flags.validationFailed) {
    score += 2
    reasons.push('validation_failed')
  }

  if (score >= 5 || (flags.conflictingSources && flags.ocrQualityPoor)) {
    return { complexity: 'very_complex', reasons }
  }
  if (score >= 2) return { complexity: 'complex', reasons }
  return { complexity: 'normal', reasons }
}

/**
 * Route by confidence + complexity. Luna is the default majority path.
 * Terra/Sol are never chosen randomly.
 */
export function routeAiTier(input: RoutingInput): { tier: AiTier; reason: string } {
  if (input.terraFailed || input.complexity === 'very_complex') {
    return { tier: 'sol', reason: input.terraFailed ? 'terra_failed' : 'very_complex' }
  }

  const confidence = input.confidence ?? 1
  const complexity = input.complexity || 'normal'
  const conflicts = Boolean(input.conflictingSources)
  const validationFailed = Boolean(input.validationFailed)
  const ocrPoor = Boolean(input.ocrQualityPoor)

  if (confidence < 0.7 || conflicts || (validationFailed && complexity !== 'normal') || ocrPoor) {
    if (confidence < 0.55 && (conflicts || complexity === 'complex')) {
      return { tier: 'sol', reason: 'low_confidence_with_conflicts' }
    }
    return { tier: 'terra', reason: conflicts ? 'conflicts' : ocrPoor ? 'poor_ocr' : 'low_confidence' }
  }

  if ((confidence >= 0.7 && confidence < 0.9) || complexity === 'complex' || validationFailed) {
    return { tier: 'terra', reason: complexity === 'complex' ? 'complex' : 'mid_confidence' }
  }

  return { tier: 'luna', reason: 'normal' }
}

/**
 * Single place to pick a model family. Do not scatter model names in callers.
 * UI must never display these names.
 */
export function selectModelForTask(input: {
  task: AiTask
  complexity?: ComplexityLevel
  preferredTier?: AiTier
  sourceQuality?: 'high' | 'medium' | 'low'
  previousAttempts?: number
  hasImages?: boolean
}): { tier: AiTier; reason: string } {
  if (input.task === 'CARD_ARCHITECTURE') {
    return { tier: 'sol', reason: 'card_architecture' }
  }
  if (input.preferredTier === 'vision' || input.task === 'VISION' || input.hasImages) {
    return { tier: 'vision', reason: 'vision_or_legacy_ocr' }
  }
  if (input.task === 'HIGH_QUALITY_WRITING') {
    if ((input.previousAttempts || 0) >= 2) return { tier: 'sol', reason: 'writing_retry' }
    return { tier: 'terra', reason: 'high_quality_writing' }
  }
  if (input.task === 'STRUCTURED_TRANSFORM' || input.task === 'SIMPLE_VOLUME') {
    if (input.sourceQuality === 'low') return { tier: 'terra', reason: 'low_source_quality' }
    return { tier: 'luna', reason: 'simple_volume' }
  }
  return routeAiTier({
    complexity: input.complexity,
    confidence: input.sourceQuality === 'low' ? 0.5 : 0.9,
  })
}

/** FAQ / Reviews / News-Blogs drop-fill: OCR separately, then Luna reads the text and structures entries. */
export const LUNA_DOCUMENT_FILL_SECTIONS = new Set(['faqs', 'blogs', 'reviews'])

export function selectFillSectionModel(section: string): { tier: AiTier; reason: string } {
  if (LUNA_DOCUMENT_FILL_SECTIONS.has(section)) {
    return { tier: 'luna', reason: 'document_text_section_fill' }
  }
  return selectModelForTask({ task: 'STRUCTURED_TRANSFORM' })
}
