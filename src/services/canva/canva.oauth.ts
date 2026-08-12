import { createHash, randomBytes } from 'crypto'
import { getCanvaConfig } from './canva.config'

export function createPkcePair() {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

export function createOAuthState() {
  return randomBytes(24).toString('hex')
}

export type CanvaTokenResponse = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

function basicAuthHeader() {
  const { clientId, clientSecret } = getCanvaConfig()
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
}

async function requestToken(body: URLSearchParams): Promise<CanvaTokenResponse> {
  const { apiBaseUrl } = getCanvaConfig()
  const response = await fetch(`${apiBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  const data = (await response.json()) as CanvaTokenResponse & { code?: string; message?: string }
  if (!response.ok) {
    throw new Error(data.message || data.code || 'Failed to exchange Canva token')
  }
  return data
}

export async function exchangeAuthorizationCode(code: string, codeVerifier: string) {
  const { redirectUri } = getCanvaConfig()
  return requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    })
  )
}

export async function refreshAccessToken(refreshToken: string) {
  return requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  )
}

export async function revokeToken(token: string) {
  const { apiBaseUrl } = getCanvaConfig()
  const response = await fetch(`${apiBaseUrl}/oauth/revoke`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token }),
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(data?.message || 'Failed to revoke Canva token')
  }
}

export function buildAuthorizationUrl(codeChallenge: string, state: string) {
  const { authBaseUrl, clientId, redirectUri, scopes } = getCanvaConfig()
  const params = new URLSearchParams({
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: scopes,
    response_type: 'code',
    client_id: clientId,
    state,
    redirect_uri: redirectUri,
  })
  return `${authBaseUrl}?${params.toString()}`
}
