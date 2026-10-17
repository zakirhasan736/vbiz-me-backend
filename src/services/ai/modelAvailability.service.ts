/**
 * Validate configured OpenAI model IDs against the account (admin diagnostics).
 * Never exposes secrets; never silently changes routing — only reports availability.
 */

import OpenAI from 'openai'
import logger from '../../utils/logger'
import { getModelForTier, modelCandidatesForTier, type AiTier } from './modelRouter.service'
import { getOpenAiApiKey } from './openai.client'

export type ModelAvailabilityRow = {
  tier: AiTier
  preferredModel: string
  candidates: string[]
  /** Models confirmed present in GET /models for this API key (when list succeeds). */
  availableInAccount: string[]
  /** Preferred model not found in account model list. */
  preferredMissing: boolean
  listError?: string
}

let cached: { at: number; rows: ModelAvailabilityRow[] } | null = null
const CACHE_MS = 10 * 60 * 1000

export async function probeModelAvailability(force = false): Promise<{
  checkedAt: string
  rows: ModelAvailabilityRow[]
  note: string
}> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return {
      checkedAt: new Date(cached.at).toISOString(),
      rows: cached.rows,
      note: 'Cached model list. Pass force=true to refresh.',
    }
  }

  const tiers: AiTier[] = ['luna', 'terra', 'sol', 'vision']
  let listed = new Set<string>()
  let listError: string | undefined
  try {
    const client = new OpenAI({ apiKey: getOpenAiApiKey(), timeout: 30_000 })
    const page = await client.models.list()
    listed = new Set(page.data.map((m) => m.id))
  } catch (error) {
    listError = error instanceof Error ? error.message : 'models.list failed'
    logger.warn('card_agent_model_list_failed', { error: listError })
  }

  const rows: ModelAvailabilityRow[] = tiers.map((tier) => {
    const preferredModel = getModelForTier(tier)
    const candidates = modelCandidatesForTier(tier)
    const availableInAccount = listError
      ? []
      : candidates.filter((id) => listed.has(id) || [...listed].some((x) => x.includes(id) || id.includes(x)))
    // Some project-scoped models do not appear in /models — treat as unknown, not hard fail.
    const preferredMissing = Boolean(listed.size) && !availableInAccount.includes(preferredModel)
    return {
      tier,
      preferredModel,
      candidates,
      availableInAccount,
      preferredMissing,
      listError,
    }
  })

  cached = { at: Date.now(), rows }
  logger.info('card_agent_model_availability', {
    rows: rows.map((r) => ({
      tier: r.tier,
      preferred: r.preferredModel,
      preferredMissing: r.preferredMissing,
      candidates: r.candidates,
    })),
  })

  return {
    checkedAt: new Date().toISOString(),
    rows,
    note: listError
      ? `Could not list models (${listError}). Fallbacks still apply at request time with logging.`
      : 'UI tier labels (Luna/Terra/SOL/Vision) stay separate from API model IDs. Fallbacks are logged when used.',
  }
}
