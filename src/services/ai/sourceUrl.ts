import { builderError } from './builderErrors'

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
  if (!parsed.hostname || parsed.hostname === 'localhost') {
    throw builderError(400, 'INVALID_URL', 'That website address is not valid.', {
      requestId,
      stage: 'source_fetch',
      retryable: false,
    })
  }
  parsed.hash = ''
  return parsed.toString()
}
