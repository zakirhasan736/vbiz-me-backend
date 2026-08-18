import AppError from '../error/AppError'

const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const TURNSTILE_TOKEN_MAX_LENGTH = 2048
const TURNSTILE_REQUEST_TIMEOUT_MS = 5000

type TurnstileSiteVerifyResponse = {
  success?: boolean
  hostname?: string
}

export type TurnstileVerificationOptions = {
  enabled: boolean
  secretKey?: string
  expectedHostname?: string
  remoteIp?: string
}

export const verifyTurnstileToken = async (token: unknown, options: TurnstileVerificationOptions): Promise<void> => {
  if (!options.enabled) return

  if (typeof token !== 'string' || !token.trim()) {
    throw new AppError(400, 'Security verification is required')
  }

  const normalizedToken = token.trim()
  if (normalizedToken.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    throw new AppError(400, 'Security verification token is invalid')
  }

  if (!options.secretKey) {
    throw new AppError(503, 'Security verification is not configured')
  }

  const body = new URLSearchParams({
    secret: options.secretKey,
    response: normalizedToken,
  })

  if (options.remoteIp) {
    body.set('remoteip', options.remoteIp)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TURNSTILE_REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    })
  } catch {
    throw new AppError(503, 'Security verification service is unavailable')
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new AppError(503, 'Security verification service is unavailable')
  }

  let result: TurnstileSiteVerifyResponse
  try {
    result = (await response.json()) as TurnstileSiteVerifyResponse
  } catch {
    throw new AppError(503, 'Security verification service returned an invalid response')
  }

  if (result.success !== true) {
    throw new AppError(400, 'Security verification failed')
  }

  if (options.expectedHostname && result.hostname !== options.expectedHostname) {
    throw new AppError(400, 'Security verification failed')
  }
}
