import { createHash } from 'crypto'
import type { Request } from 'express'

export type PublicViewerIdentity = {
  visitorId?: string
  browserKey: string
}

function sanitizeVisitorId(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed.slice(0, 200) : undefined
}

function headerValue(req: Request, key: string): string {
  return (req.get(key) || '').trim()
}

export function getPublicViewerIdentity(req: Request, visitorId?: unknown): PublicViewerIdentity {
  const normalizedVisitorId = sanitizeVisitorId(visitorId)
  const browserSeed = [
    headerValue(req, 'user-agent'),
    headerValue(req, 'accept-language'),
    headerValue(req, 'sec-ch-ua'),
    headerValue(req, 'sec-ch-ua-mobile'),
    headerValue(req, 'sec-ch-ua-platform'),
  ].join('|')

  const browserKey = createHash('sha256')
    .update(browserSeed || 'vbiz-public-viewer')
    .digest('hex')

  return {
    visitorId: normalizedVisitorId,
    browserKey,
  }
}
