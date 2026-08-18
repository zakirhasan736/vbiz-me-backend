import OpenAI from 'openai'
import AppError from '../../error/AppError'
import { estimateCostUsd, getModelForTier, type AiTier } from './modelRouter.service'

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
  return new OpenAI({ apiKey: getOpenAiApiKey() })
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
  const model = params.model || getModelForTier(tier)
  const started = Date.now()

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: params.user }]
  for (const img of params.images || []) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })
  }

  let completion: OpenAI.Chat.Completions.ChatCompletion
  try {
    completion = await client.chat.completions.create({
      model,
      temperature: params.temperature ?? 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: userContent },
      ],
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'OpenAI request failed'
    if (/rate limit|429/i.test(message)) {
      throw new AppError(429, 'The AI service is busy. Please try again in a moment.', { code: 'AI_RATE_LIMIT' })
    }
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
      throw new AppError(504, 'The AI request timed out. Try again with fewer documents.', { code: 'AI_TIMEOUT' })
    }
    throw new AppError(502, 'AI request failed. Please try again.', { code: 'AI_REQUEST_FAILED' })
  }

  const text = completion.choices[0]?.message?.content
  if (!text) throw new AppError(502, 'Empty response from OpenAI', { code: 'AI_EMPTY' })

  let data: T
  try {
    data = parseJsonObject(text) as T
  } catch {
    const repair = await client.chat.completions.create({
      model: getModelForTier('terra'),
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Repair the following into valid JSON only. Do not add new facts.' },
        { role: 'user', content: text.slice(0, 20000) },
      ],
    })
    const repaired = repair.choices[0]?.message?.content
    if (!repaired) throw new AppError(502, 'AI returned invalid JSON', { code: 'AI_INVALID_JSON' })
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
