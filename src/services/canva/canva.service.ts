import { randomBytes } from 'crypto'
import AppError from '../../error/AppError'
import { prisma } from '../../utils/prisma'
import s3Utils from '../../utils/s3'
import profileService from '../profile.service'
import {
  createCanvaDesign,
  createCanvaExportJob,
  downloadCanvaUrl,
  getCanvaDesign,
  listCanvaDesigns,
  waitForCanvaExport,
  type CanvaExportFormat,
} from './canva.api'
import { getCanvaConfig, isCanvaConfigured } from './canva.config'
import { decryptTokenPair, encryptTokenPair } from './canva.crypto'
import { resolveCanvaFieldPreset, type CanvaMediaKind } from './canva.fieldPresets'
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  type CanvaTokenResponse,
} from './canva.oauth'
import { verifyCanvaCorrelationJwt } from './canva.returnJwt'

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

const REQUIRED_WRITE_SCOPE = 'design:content:write'
const REQUIRED_READ_SCOPE = 'design:content:read'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function createCorrelationState() {
  // URL-safe opaque key ≤50 chars (Canva Return Navigation limit)
  return randomBytes(24).toString('base64url').slice(0, 32)
}

/**
 * Append correlation_state without parsing via `new URL()`.
 * Canva edit_url paths contain opaque encrypted tokens; URL normalize/re-encode
 * can alter the path and Canva then returns Cloudflare 403 on open.
 */
function appendCorrelationState(editUrl: string, correlationState: string) {
  const trimmed = editUrl.trim()
  if (!trimmed) return trimmed
  const hashIndex = trimmed.indexOf('#')
  const withoutHash = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed
  const hash = hashIndex >= 0 ? trimmed.slice(hashIndex) : ''
  const sep = withoutHash.includes('?') ? '&' : '?'
  return `${withoutHash}${sep}correlation_state=${encodeURIComponent(correlationState)}${hash}`
}

function grantedScopes(scope: string | null | undefined) {
  return new Set(
    String(scope || '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

async function assertGrantedScopes(userId: string, required: string[]) {
  const row = await prisma.canvaConnection.findUnique({ where: { userId } })
  if (!row) throw new AppError(401, 'Canva is not connected')
  const scopes = grantedScopes(row.scope)
  const missing = required.filter((s) => !scopes.has(s))
  if (missing.length) {
    throw new AppError(
      403,
      `Canva reconnect required — missing scopes: ${missing.join(', ')}. Disconnect and connect Canva again.`
    )
  }
}

function serializeSession(row: {
  id: string
  correlationState: string
  profileId: string
  fieldKey: string
  itemKey: string | null
  attachmentType: string | null
  designId: string
  designTitle: string | null
  mediaKind: string
  exportFormat: string
  targetWidth: number | null
  targetHeight: number | null
  builderRoute: string
  status: string
  resultUrl: string | null
  resultFilename: string | null
  resultMime: string | null
  attachmentId: string | null
  errorMessage: string | null
  expiresAt: Date
  createdAt: Date
  completedAt: Date | null
}) {
  return {
    id: row.id,
    sessionId: row.id,
    correlationState: row.correlationState,
    profileId: row.profileId,
    fieldKey: row.fieldKey,
    itemKey: row.itemKey,
    attachmentType: row.attachmentType,
    designId: row.designId,
    designTitle: row.designTitle,
    mediaKind: row.mediaKind,
    exportFormat: row.exportFormat,
    targetWidth: row.targetWidth,
    targetHeight: row.targetHeight,
    builderRoute: row.builderRoute,
    status: row.status,
    resultUrl: row.resultUrl,
    resultFilename: row.resultFilename,
    resultMime: row.resultMime,
    attachmentId: row.attachmentId,
    errorMessage: row.errorMessage,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

export type CreateEditSessionInput = {
  profileId: string
  fieldKey: string
  itemKey?: string | null
  attachmentType?: string | null
  mediaKind?: CanvaMediaKind | null
  width?: number | null
  height?: number | null
  exportFormat?: CanvaExportFormat | null
  builderRoute: string
  title?: string | null
  /** When set, open an existing design instead of creating a blank one. */
  designId?: string | null
}

export async function createOrOpenEditSession(userId: string, role: string, input: CreateEditSessionInput) {
  assertCanvaConfigured()
  await assertGrantedScopes(userId, [REQUIRED_WRITE_SCOPE, REQUIRED_READ_SCOPE])
  await profileService.getOwnedLite(input.profileId, userId, role)

  const fieldKey = String(input.fieldKey || '').trim()
  if (!fieldKey) throw new AppError(400, 'fieldKey is required')
  const builderRoute = sanitizeReturnTo(input.builderRoute, `/vcards/edit/${input.profileId}`)
  const preset = resolveCanvaFieldPreset({
    fieldKey,
    attachmentType: input.attachmentType,
    mediaKind: input.mediaKind,
    width: input.width,
    height: input.height,
    exportFormat: input.exportFormat,
  })

  const accessToken = await getValidAccessToken(userId)
  let designId = String(input.designId || '').trim()
  let designTitle = (input.title || '').trim() || `${preset.titlePrefix} — vBiz Me`
  let editUrl: string | undefined
  let canvaUserId: string | undefined
  let canvaTeamId: string | undefined

  if (designId) {
    const design = await getCanvaDesign(accessToken, designId)
    editUrl = design.urls?.edit_url
    designTitle = design.title?.trim() || designTitle
    canvaUserId = design.owner?.user_id
    canvaTeamId = design.owner?.team_id
  } else {
    const design = await createCanvaDesign(accessToken, {
      title: designTitle,
      width: preset.width,
      height: preset.height,
    })
    designId = design.id
    editUrl = design.urls?.edit_url
    designTitle = design.title?.trim() || designTitle
    canvaUserId = design.owner?.user_id
    canvaTeamId = design.owner?.team_id
  }

  if (!editUrl) throw new AppError(502, 'Canva did not return an edit URL for this design')

  const correlationState = createCorrelationState()
  const session = await prisma.canvaEditSession.create({
    data: {
      correlationState,
      userId,
      profileId: input.profileId,
      fieldKey,
      itemKey: input.itemKey?.trim() || null,
      attachmentType: input.attachmentType?.trim() || fieldKey,
      designId,
      designTitle,
      mediaKind: preset.mediaKind,
      exportFormat: preset.exportFormat,
      targetWidth: preset.width,
      targetHeight: preset.height,
      builderRoute,
      status: 'awaiting_return',
      canvaUserId: canvaUserId || null,
      canvaTeamId: canvaTeamId || null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })

  return {
    ...serializeSession(session),
    editUrl: appendCorrelationState(editUrl, correlationState),
  }
}

async function storeExportAsAttachment(params: {
  userId: string
  profileId: string
  attachmentType?: string | null
  designTitle?: string | null
  buffer: Buffer
  contentType: string
  filename: string
}) {
  const uploaded = await s3Utils.uploadBuffer(params.buffer, {
    contentType: params.contentType,
    filename: params.filename,
    resourceType: 'auto',
  })

  let attachmentId: string | undefined
  const attachmentTypeName = params.attachmentType?.trim()
  if (attachmentTypeName) {
    const type =
      (await prisma.attachmentType.findFirst({
        where: { name: { equals: attachmentTypeName, mode: 'insensitive' } },
      })) ||
      (await prisma.attachmentType.create({
        data: {
          name: attachmentTypeName,
          slug: attachmentTypeName.toLowerCase().replace(/\s+/g, '-'),
        },
      }))

    const attachment = await prisma.attachment.create({
      data: {
        attachableType: 'Profile',
        attachableId: params.profileId,
        profileId: params.profileId,
        attachmentTypeId: type.id,
        docName: params.filename,
        url: uploaded.url,
        publicId: uploaded.publicId,
        resourceType: uploaded.resourceType,
        format: uploaded.format,
        bytes: uploaded.bytes,
        extension: uploaded.format,
        mimeType: params.contentType,
      },
    })
    attachmentId = attachment.id
  }

  return { url: uploaded.url, attachmentId }
}

async function runSessionImport(sessionId: string) {
  const session = await prisma.canvaEditSession.findUnique({ where: { id: sessionId } })
  if (!session) return
  if (session.status === 'ready' && session.resultUrl) return
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.canvaEditSession.update({
      where: { id: sessionId },
      data: { status: 'expired', errorMessage: 'Edit session expired' },
    })
    return
  }

  try {
    await prisma.canvaEditSession.update({
      where: { id: sessionId },
      data: {
        status: 'importing',
        importStartedAt: new Date(),
        errorMessage: null,
      },
    })

    const format = (session.exportFormat as CanvaExportFormat) || 'png'
    const accessToken = await getValidAccessToken(session.userId)
    const created = await createCanvaExportJob(accessToken, session.designId, format)
    await prisma.canvaEditSession.update({
      where: { id: sessionId },
      data: { exportJobId: created.id },
    })

    const job = await waitForCanvaExport(accessToken, created.id)
    const urls = (job.urls || []).filter(Boolean)
    if (!urls.length) throw new Error('Canva export returned no download URL')

    // Prefer the first page/file; multi-page exports keep the first usable media URL.
    const downloadUrl = urls[0]
    const { buffer, contentType } = await downloadCanvaUrl(downloadUrl)
    if (!buffer.length) throw new Error('Canva export file was empty')

    const safeName = (session.designTitle || 'canva-design')
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

    const stored = await storeExportAsAttachment({
      userId: session.userId,
      profileId: session.profileId,
      attachmentType: session.attachmentType || session.fieldKey,
      designTitle: session.designTitle,
      buffer,
      contentType: mime,
      filename,
    })

    await prisma.canvaEditSession.update({
      where: { id: sessionId },
      data: {
        status: 'ready',
        resultUrl: stored.url,
        resultFilename: filename,
        resultMime: mime,
        attachmentId: stored.attachmentId || null,
        completedAt: new Date(),
        errorMessage: null,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Canva import failed'
    await prisma.canvaEditSession.update({
      where: { id: sessionId },
      data: {
        status: 'failed',
        errorMessage: message.slice(0, 500),
      },
    })
  }
}

/**
 * Public Canva Return Navigation landing.
 * Verifies correlation_jwt, resolves the edit session, starts export/import idempotently,
 * then redirects to the frontend return page (user must still authenticate for status).
 */
export async function handleReturnNavigation(correlationJwt: string | undefined) {
  assertCanvaConfigured()
  const { frontendUrl } = getCanvaConfig()
  const feReturn = `${frontendUrl}/canva/return`

  const failRedirect = (code: string) => {
    const url = new URL(feReturn)
    url.searchParams.set('canva_return', 'error')
    url.searchParams.set('canva_error', code.slice(0, 180))
    return url.toString()
  }

  if (!correlationJwt?.trim()) return failRedirect('missing_correlation_jwt')

  let claims
  try {
    claims = await verifyCanvaCorrelationJwt(correlationJwt.trim())
  } catch {
    return failRedirect('invalid_correlation_jwt')
  }

  const existingByJti = await prisma.canvaEditSession.findUnique({
    where: { correlationJti: claims.jti },
  })
  if (existingByJti) {
    const url = new URL(feReturn)
    url.searchParams.set('sessionId', existingByJti.id)
    url.searchParams.set('canva_return', existingByJti.status === 'ready' ? 'ready' : 'importing')
    return url.toString()
  }

  const session = await prisma.canvaEditSession.findUnique({
    where: { correlationState: claims.correlation_state },
  })
  if (!session) return failRedirect('unknown_session')
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.canvaEditSession.update({
      where: { id: session.id },
      data: { status: 'expired', errorMessage: 'Edit session expired' },
    })
    return failRedirect('session_expired')
  }
  if (session.designId !== claims.design_id) return failRedirect('design_mismatch')

  if (session.canvaUserId && session.canvaUserId !== claims.sub) {
    return failRedirect('canva_user_mismatch')
  }
  if (session.canvaTeamId && session.canvaTeamId !== claims.team_id) {
    return failRedirect('canva_team_mismatch')
  }

  const alreadyTerminal = session.status === 'ready' || session.status === 'importing'
  if (!alreadyTerminal) {
    await prisma.canvaEditSession.update({
      where: { id: session.id },
      data: {
        correlationJti: claims.jti,
        canvaUserId: claims.sub,
        canvaTeamId: claims.team_id,
        status: 'importing',
        importStartedAt: new Date(),
      },
    })
    // Fire-and-forget export/import so the redirect is immediate.
    void runSessionImport(session.id)
  } else if (!session.correlationJti) {
    await prisma.canvaEditSession.update({
      where: { id: session.id },
      data: { correlationJti: claims.jti },
    })
  }

  const url = new URL(feReturn)
  url.searchParams.set('sessionId', session.id)
  url.searchParams.set('canva_return', session.status === 'ready' ? 'ready' : 'importing')
  return url.toString()
}

export async function getImportSession(userId: string, role: string, sessionId: string) {
  assertCanvaConfigured()
  const session = await prisma.canvaEditSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new AppError(404, 'Canva import session not found')
  if (session.userId !== userId) throw new AppError(403, 'Not allowed to access this Canva session')
  await profileService.getOwnedLite(session.profileId, userId, role)
  return serializeSession(session)
}

export async function retryImportSession(userId: string, role: string, sessionId: string) {
  assertCanvaConfigured()
  await assertGrantedScopes(userId, [REQUIRED_READ_SCOPE])
  const session = await prisma.canvaEditSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new AppError(404, 'Canva import session not found')
  if (session.userId !== userId) throw new AppError(403, 'Not allowed to access this Canva session')
  await profileService.getOwnedLite(session.profileId, userId, role)

  if (session.expiresAt.getTime() < Date.now()) {
    throw new AppError(410, 'Edit session expired — create or edit again in Canva')
  }

  await prisma.canvaEditSession.update({
    where: { id: sessionId },
    data: { status: 'importing', errorMessage: null, importStartedAt: new Date() },
  })
  void runSessionImport(sessionId)
  return serializeSession({ ...session, status: 'importing', errorMessage: null })
}

export async function markReturnCanceled(userId: string, role: string, sessionId: string) {
  const session = await prisma.canvaEditSession.findUnique({ where: { id: sessionId } })
  if (!session) throw new AppError(404, 'Canva import session not found')
  if (session.userId !== userId) throw new AppError(403, 'Not allowed')
  await profileService.getOwnedLite(session.profileId, userId, role)
  if (session.status === 'awaiting_return') {
    const updated = await prisma.canvaEditSession.update({
      where: { id: sessionId },
      data: { status: 'canceled', errorMessage: 'Return canceled' },
    })
    return serializeSession(updated)
  }
  return serializeSession(session)
}
