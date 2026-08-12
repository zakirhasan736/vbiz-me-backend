import AppError from '../../error/AppError'
import { prisma } from '../../utils/prisma'
import {
  createCanvaExportJob,
  downloadCanvaUrl,
  listCanvaDesigns,
  waitForCanvaExport,
  type CanvaExportFormat,
} from './canva.api'
import { getCanvaConfig, isCanvaConfigured } from './canva.config'
import { decryptTokenPair, encryptTokenPair } from './canva.crypto'
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  type CanvaTokenResponse,
} from './canva.oauth'

function sanitizeReturnTo(returnTo: string | undefined, fallback: string) {
  const value = (returnTo || '').trim() || fallback
  if (!value.startsWith('/') || value.startsWith('//')) return fallback
  return value
}

async function saveTokens(userId: string, tokenResponse: CanvaTokenResponse) {
  const packed = encryptTokenPair({
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
    scope: tokenResponse.scope,
  })

  await prisma.canvaConnection.upsert({
    where: { userId },
    create: {
      userId,
      accessTokenEnc: packed.accessTokenEnc,
      refreshTokenEnc: packed.refreshTokenEnc || 'packed',
      tokenIv: packed.tokenIv,
      tokenTag: packed.tokenTag,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scope: tokenResponse.scope,
      connectedAt: new Date(),
    },
    update: {
      accessTokenEnc: packed.accessTokenEnc,
      refreshTokenEnc: packed.refreshTokenEnc || 'packed',
      tokenIv: packed.tokenIv,
      tokenTag: packed.tokenTag,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scope: tokenResponse.scope,
    },
  })
}

export function assertCanvaConfigured() {
  if (!isCanvaConfigured()) {
    throw new AppError(503, 'Canva is not configured on the server')
  }
}

export async function getConnectionStatus(userId: string) {
  if (!isCanvaConfigured()) return { connected: false as const, configured: false }

  const row = await prisma.canvaConnection.findUnique({ where: { userId } })
  if (!row) return { connected: false as const, configured: true }

  return {
    connected: true as const,
    configured: true,
    scope: row.scope ?? undefined,
    connectedAt: row.connectedAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  }
}

export async function createAuthorizeUrl(userId: string, returnTo?: string) {
  assertCanvaConfigured()
  const { codeVerifier, codeChallenge } = createPkcePair()
  const state = createOAuthState()
  const safeReturnTo = sanitizeReturnTo(returnTo, '/')

  await prisma.canvaOAuthPending.deleteMany({
    where: { OR: [{ userId }, { expiresAt: { lt: new Date() } }] },
  })

  await prisma.canvaOAuthPending.create({
    data: {
      state,
      userId,
      codeVerifier,
      returnTo: safeReturnTo,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  })

  return buildAuthorizationUrl(codeChallenge, state)
}

export async function handleOAuthCallback(params: {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}) {
  assertCanvaConfigured()
  const { frontendUrl } = getCanvaConfig()

  const buildResult = (returnTo: string, result: 'connected' | 'error', errorMessage?: string) => {
    const url = new URL(returnTo.startsWith('http') ? returnTo : `${frontendUrl}${returnTo}`)
    url.searchParams.set('canva', result)
    if (errorMessage) url.searchParams.set('canva_error', errorMessage.slice(0, 180))
    return url.toString()
  }

  if (params.error) {
    return buildResult('/', 'error', params.errorDescription || params.error)
  }

  if (!params.code || !params.state) {
    return buildResult('/', 'error', 'missing_code')
  }

  const pending = await prisma.canvaOAuthPending.findUnique({ where: { state: params.state } })
  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    if (pending) await prisma.canvaOAuthPending.delete({ where: { state: params.state } }).catch(() => undefined)
    return buildResult('/', 'error', 'invalid_or_expired_state')
  }

  try {
    const tokens = await exchangeAuthorizationCode(params.code, pending.codeVerifier)
    await saveTokens(pending.userId, tokens)
    await prisma.canvaOAuthPending.delete({ where: { state: params.state } }).catch(() => undefined)
    return buildResult(pending.returnTo, 'connected')
  } catch (error) {
    await prisma.canvaOAuthPending.delete({ where: { state: params.state } }).catch(() => undefined)
    const message = error instanceof Error ? error.message : 'token_exchange_failed'
    return buildResult(pending.returnTo, 'error', message)
  }
}

export async function getValidAccessToken(userId: string): Promise<string> {
  assertCanvaConfigured()
  const row = await prisma.canvaConnection.findUnique({ where: { userId } })
  if (!row) throw new AppError(401, 'Canva is not connected')

  const tokens = decryptTokenPair(row)
  const refreshBufferMs = 60_000
  if (Date.now() < row.expiresAt.getTime() - refreshBufferMs) {
    return tokens.accessToken
  }

  try {
    const refreshed = await refreshAccessToken(tokens.refreshToken)
    await saveTokens(userId, refreshed)
    return refreshed.access_token
  } catch {
    await prisma.canvaConnection.delete({ where: { userId } }).catch(() => undefined)
    throw new AppError(401, 'Canva session expired — reconnect Canva')
  }
}

export async function disconnect(userId: string) {
  assertCanvaConfigured()
  const row = await prisma.canvaConnection.findUnique({ where: { userId } })
  if (row) {
    try {
      const tokens = decryptTokenPair(row)
      await revokeToken(tokens.refreshToken)
    } catch {
      // ignore revoke failures
    }
    await prisma.canvaConnection.delete({ where: { userId } }).catch(() => undefined)
  }
  return { connected: false as const }
}

export async function listLibrary(userId: string, options?: { query?: string; continuation?: string }) {
  const accessToken = await getValidAccessToken(userId)
  const result = await listCanvaDesigns(accessToken, {
    query: options?.query,
    continuation: options?.continuation,
    limit: 40,
  })

  return {
    items: result.items.map((item) => ({
      id: item.id,
      name: item.title?.trim() || 'Untitled design',
      thumb: item.thumbnail?.url,
      updatedAt: item.updated_at,
      pageCount: item.page_count,
    })),
    continuation: result.continuation,
  }
}

export async function importDesign(
  userId: string,
  input: { designId: string; designName?: string; format?: CanvaExportFormat }
) {
  const format: CanvaExportFormat =
    input.format === 'mp4' || input.format === 'pdf' || input.format === 'jpg' ? input.format : 'png'
  const accessToken = await getValidAccessToken(userId)
  const created = await createCanvaExportJob(accessToken, input.designId, format)
  const job = await waitForCanvaExport(accessToken, created.id)
  const downloadUrl = job.urls?.[0]
  if (!downloadUrl) throw new AppError(502, 'Canva export returned no download URL')

  const { buffer, contentType } = await downloadCanvaUrl(downloadUrl)
  const safeName = (input.designName || 'canva-design')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  const ext = format === 'mp4' ? 'mp4' : format === 'pdf' ? 'pdf' : format === 'jpg' ? 'jpg' : 'png'
  const filename = `${safeName || 'canva-design'}.${ext}`
  const mime =
    format === 'mp4'
      ? 'video/mp4'
      : format === 'pdf'
        ? 'application/pdf'
        : format === 'jpg'
          ? 'image/jpeg'
          : contentType.startsWith('image/')
            ? contentType
            : 'image/png'

  return { buffer, contentType: mime, filename }
}
