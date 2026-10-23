import { builderError } from './builderErrors'

/** Block localhost, private networks, and cloud metadata endpoints (SSRF). */
export function isBlockedFetchHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === 'metadata.google.internal' || host === 'metadata') return true
  if (host === '169.254.169.254' || host.startsWith('169.254.')) return true
  // IPv4 private / loopback / link-local
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number)
    if (parts.some((n) => n > 255)) return true
    const [a, b] = parts
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  }
  // Common IPv6 loopback / ULA markers in hostname form
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  return false
}

export function normalizeWebsiteUrl(raw: string, requestId?: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw builderError(400, 'INVALID_URL', 'That website address is not valid.', {
      requestId,
      stage: 'source_fetch',
      retryable: false,
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw builderError(400, 'INVALID_URL', 'That website address is not valid.', {
      requestId,
      stage: 'source_fetch',
      retryable: false,
    })
  }
  if (!parsed.hostname || isBlockedFetchHostname(parsed.hostname)) {
    throw builderError(400, 'INVALID_URL', 'That website address is not valid.', {
      requestId,
      stage: 'source_fetch',
      retryable: false,
    })
  }
  parsed.hash = ''
  return parsed.toString()
}
