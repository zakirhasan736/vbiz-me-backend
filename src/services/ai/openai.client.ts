import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import AppError from '../../error/AppError'
import logger from '../../utils/logger'
import {
  estimateCostUsd,
  getModelForTier,
  isUnavailableModelError,
  isUnsupportedParameterError,
  modelCandidatesForTier,
  type AiTier,
} from './modelRouter.service'

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export const MAX_FILES = 6

export function getOpenAiApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) {
    throw new AppError(
      503,
      'OPENAI_API_KEY is not configured on the server. Add it to the backend .env only — never expose it to the browser.'
    )
  }
  return key
}

export function getCardAgentModel(): string {
  return process.env.OPENAI_CARD_MODEL?.trim() || getModelForTier('luna')
}

export function createOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: getOpenAiApiKey(), timeout: 240_000 })
}

export type ChatJsonMeta = {
  model: string
  tier: AiTier
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  latencyMs: number
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    throw new AppError(502, 'AI returned invalid JSON', { code: 'AI_INVALID_JSON' })
  }
}

function publicAiFailure(status: number, message: string, code: string, extra?: Record<string, unknown>) {
  const requestId = randomUUID()
  return new AppError(status, message, {
    code,
    data: { requestId, retryable: status === 429 || status === 504, ...extra },
  })
}

async function createJsonCompletion(
  client: OpenAI,
  input: {
    model: string
    temperature?: number
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  }
) {
  const base = {
    model: input.model,
    response_format: { type: 'json_object' as const },
    messages: input.messages,
  }
  try {
    return await client.chat.completions.create({
      ...base,
      temperature: input.temperature ?? 0.4,
    })
  } catch (error) {
    if (!isUnsupportedParameterError(error)) throw error
    return client.chat.completions.create(base)
  }
}

export async function chatJson<T>(params: {
  system: string
  user: string
  images?: Array<{ mimeType: string; base64: string }>
  tier?: AiTier
  model?: string
  temperature?: number
}): Promise<{ data: T; meta: ChatJsonMeta }> {
  const client = createOpenAIClient()
  const requested = params.tier || 'luna'
  const keepRequested = requested === 'sol' || Boolean(params.model)
  const tier = (params.images?.length && !keepRequested ? 'vision' : requested) as AiTier
  const candidates = params.model
    ? [params.model, ...modelCandidatesForTier(tier).filter((id) => id !== params.model)]
    : modelCandidatesForTier(tier)
  const started = Date.now()

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: params.user }]
  for (const img of params.images || []) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })
  }
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: params.system },
    { role: 'user', content: userContent },
  ]

  let completion: OpenAI.Chat.Completions.ChatCompletion | undefined
  let model = candidates[0]
  for (const candidate of candidates) {
    model = candidate
    try {
      completion = await createJsonCompletion(client, {
        model: candidate,
        temperature: params.temperature,
        messages,
      })
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenAI request failed'
      if (/rate limit|429/i.test(message) || (error as { status?: number }).status === 429) {
        throw publicAiFailure(429, 'The AI service is busy. Please try again in a moment.', 'AI_RATE_LIMIT')
      }
      if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
        throw publicAiFailure(504, 'The AI request timed out. Try again with fewer documents.', 'AI_TIMEOUT')
      }
      if (isUnavailableModelError(error)) {
        logger.error('card_agent_model_unavailable', { tier, requestStage: 'chat_json' })
        continue
      }
      logger.error('card_agent_openai_failed', { tier, requestStage: 'chat_json' })
      throw publicAiFailure(502, 'AI request failed. Please try again.', 'AI_REQUEST_FAILED')
    }
  }
  if (!completion) {
    logger.error('card_agent_all_models_unavailable', { tier, requestStage: 'chat_json' })
    throw publicAiFailure(
      502,
      'The AI assistant could not start. Please try again in a moment.',
      'AI_MODEL_UNAVAILABLE'
    )
  }

  const text = completion.choices[0]?.message?.content
  if (!text) throw publicAiFailure(502, 'The AI assistant returned an empty response. Please try again.', 'AI_EMPTY')

  let data: T
  try {
    data = parseJsonObject(text) as T
  } catch {
    const repair = await createJsonCompletion(client, {
      model: getModelForTier('terra') === model ? modelCandidatesForTier('terra')[0] : getModelForTier('terra'),
      temperature: 0,
      messages: [
        { role: 'system', content: 'Repair the following into valid JSON only. Do not add new facts.' },
        { role: 'user', content: text.slice(0, 20000) },
      ],
    }).catch(() => null)
    const repaired = repair?.choices[0]?.message?.content
    if (!repaired)
      throw publicAiFailure(502, 'The AI assistant returned an invalid response. Please try again.', 'AI_INVALID_JSON')
    data = parseJsonObject(repaired) as T
  }

  const inputTokens = completion.usage?.prompt_tokens || 0
  const outputTokens = completion.usage?.completion_tokens || 0
  return {
    data,
    meta: {
      model,
      tier,
      inputTokens,
      outputTokens,
      estimatedCost: estimateCostUsd(tier, inputTokens, outputTokens),
      latencyMs: Date.now() - started,
    },
  }
}
