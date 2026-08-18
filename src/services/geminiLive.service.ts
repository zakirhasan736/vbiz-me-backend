import { GoogleGenAI, Modality } from '@google/genai'
import config from '../configs/config'
import AppError from '../error/AppError'
import { assertProfileId, assertPublicAssistantGate, publicLiveTokenShape } from './assistantPolicy'
import { getPublicAssistantState } from './profileAssistant.service'

export const GEMINI_LIVE_API_VERSION = 'v1beta'
export const REQUIRED_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview'

type TokenSource = { name?: string }

export async function issuePublicLiveToken(profileId: string) {
  profileId = assertProfileId(profileId)
  const state = await getPublicAssistantState(profileId)
  assertPublicAssistantGate(true, state.enabled, false)

  const apiKey = config.GEMINI.API_KEY
  if (!apiKey) {
    throw new AppError(503, 'Public AI assistant is temporarily unavailable because Gemini is not configured.')
  }
  if (config.GEMINI.LIVE_MODEL !== REQUIRED_GEMINI_LIVE_MODEL) {
    throw new AppError(503, `GEMINI_LIVE_MODEL must be ${REQUIRED_GEMINI_LIVE_MODEL}.`)
  }

  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
  const newSessionExpiresAt = new Date(Date.now() + 60_000).toISOString()
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: GEMINI_LIVE_API_VERSION },
  })
  let token: TokenSource
  try {
    token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        liveConnectConstraints: {
          model: REQUIRED_GEMINI_LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
          },
        },
        lockAdditionalFields: [],
      },
    })
  } catch {
    throw new AppError(503, 'Public AI assistant could not start a Gemini session. Please try again shortly.')
  }

  return publicLiveTokenShape({
    token,
    model: REQUIRED_GEMINI_LIVE_MODEL,
    expiresAt,
    newSessionExpiresAt,
    context: `${state.modelContext}${
      state.systemPromptAddendum ? `\n\nOWNER STYLE GUIDANCE:\n${state.systemPromptAddendum}` : ''
    }`,
  })
}
