type ParsedSentryDsn = {
  key: string
  storeUrl: string
}

export function parseSentryDsn(raw: string | undefined | null): ParsedSentryDsn | null {
  const value = raw?.trim()
  if (!value) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const key = decodeURIComponent(url.username)
  const projectId = url.pathname.split('/').filter(Boolean)[0] || ''
  if (!key || !/^\d+$/.test(projectId)) return null

  return {
    key,
    storeUrl: `${url.protocol}//${url.host}/api/${projectId}/store/`,
  }
}

function eventId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export async function deliverSentryEvent(input: {
  dsn?: string | null
  message: string
  extra?: Record<string, unknown>
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const parsed = parseSentryDsn(input.dsn)
  if (!parsed) return false

  const fetchImpl = input.fetchImpl || fetch
  try {
    const response = await fetchImpl(parsed.storeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=vbiz-backend/1.0, sentry_key=${parsed.key}`,
      },
      body: JSON.stringify({
        event_id: eventId(),
        message: input.message.slice(0, 2000),
        level: 'error',
        platform: 'node',
        timestamp: Date.now() / 1000,
        tags: { app: 'vbiz-me-backend' },
        extra: input.extra || {},
      }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Fire-and-forget. Tests and a missing DSN never call Sentry. */
export function captureSentryException(message: string, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test') return
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  void deliverSentryEvent({ dsn, message, extra })
}
