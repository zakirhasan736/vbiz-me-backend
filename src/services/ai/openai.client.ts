import OpenAI from 'openai'
import AppError from '../../error/AppError'

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
  return process.env.OPENAI_CARD_MODEL?.trim() || 'gpt-4o-mini'
}

export function createOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: getOpenAiApiKey() })
}

export async function chatJson<T>(params: {
  system: string
  user: string
  images?: Array<{ mimeType: string; base64: string }>
}): Promise<T> {
  const client = createOpenAIClient()
  const model = getCardAgentModel()

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: params.user }]
  for (const img of params.images || []) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })
  }

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: params.system },
      { role: 'user', content: userContent },
    ],
  })

  const text = completion.choices[0]?.message?.content
  if (!text) throw new AppError(502, 'Empty response from OpenAI')
  return JSON.parse(text) as T
}
