import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliverSentryEvent, parseSentryDsn } from '../utils/sentry'

test('parseSentryDsn accepts a project DSN', () => {
  assert.deepEqual(parseSentryDsn('https://public-key@o123.ingest.sentry.io/456'), {
    key: 'public-key',
    storeUrl: 'https://o123.ingest.sentry.io/api/456/store/',
  })
})

test('parseSentryDsn rejects empty and incomplete DSNs', () => {
  assert.equal(parseSentryDsn(''), null)
  assert.equal(parseSentryDsn(undefined), null)
  assert.equal(parseSentryDsn('https://o123.ingest.sentry.io/456'), null)
  assert.equal(parseSentryDsn('https://public-key@o123.ingest.sentry.io/abc'), null)
})

test('deliverSentryEvent posts server errors only when a DSN is set', async () => {
  let called = false
  const skipped = await deliverSentryEvent({
    dsn: '',
    message: 'skip',
    fetchImpl: async () => {
      called = true
      return new Response(null, { status: 200 })
    },
  })
  assert.equal(skipped, false)
  assert.equal(called, false)

  let auth = ''
  let app = ''
  const sent = await deliverSentryEvent({
    dsn: 'https://public-key@o123.ingest.sentry.io/456',
    message: 'Forced test failure',
    extra: { statusCode: 500 },
    fetchImpl: async (_url, init) => {
      auth = String(new Headers(init?.headers).get('X-Sentry-Auth'))
      app = (JSON.parse(String(init?.body)) as { tags: { app: string } }).tags.app
      return new Response(null, { status: 200 })
    },
  })
  assert.equal(sent, true)
  assert.match(auth, /sentry_key=public-key/)
  assert.equal(app, 'vbiz-me-backend')
})
