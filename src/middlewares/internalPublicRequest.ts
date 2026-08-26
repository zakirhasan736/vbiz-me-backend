import type { Request } from 'express'
import { timingSafeEqual } from 'node:crypto'
import config from '../configs/config'

export const INTERNAL_PUBLIC_API_HEADER = 'x-vbiz-internal-key'

export function timingSafeEqualString(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** True only when the server-only secret matches. Never trust loopback or X-Forwarded-For. */
export function isTrustedInternalPublicRequest(req: Request, secret = config.INTERNAL_PUBLIC_API_KEY): boolean {
  if (!secret) return false
  const header = req.headers[INTERNAL_PUBLIC_API_HEADER]
  const provided = Array.isArray(header) ? header[0] : header
  if (!provided) return false
  return timingSafeEqualString(provided, secret)
}

export function publicRateLimitKeyType(req: Request): 'internal-ssr' | 'ip' {
  return isTrustedInternalPublicRequest(req) ? 'internal-ssr' : 'ip'
}
