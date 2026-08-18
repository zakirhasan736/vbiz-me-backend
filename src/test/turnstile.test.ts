import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import request from 'supertest'
import AppError from '../error/AppError'
import { verifyTurnstileToken } from '../utils/turnstile'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const assertTurnstileError = async (promise: Promise<unknown>, statusCode: number, message: string) => {
  await assert.rejects(promise, (error: unknown) => {
    return error instanceof AppError && error.statusCode === statusCode && error.message === message
  })
}

test('disabled Turnstile does not call Cloudflare or require a token', async () => {
  let fetchCalled = false
  globalThis.fetch = async () => {
    fetchCalled = true
    return new Response('{}')
  }

  await verifyTurnstileToken(undefined, { enabled: false, secretKey: 'unused' })

  assert.equal(fetchCalled, false)
})

test('enabled Turnstile rejects missing tokens', async () => {
  await assertTurnstileError(
    verifyTurnstileToken(undefined, { enabled: true, secretKey: 'test-secret' }),
    400,
    'Security verification is required'
  )
})

test('successful Turnstile validation sends the token and visitor IP to Cloudflare', async () => {
  let requestBody = ''
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body)
    return new Response(JSON.stringify({ success: true, hostname: 'app.vbizme.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  await verifyTurnstileToken('valid-token', {
    enabled: true,
    secretKey: 'test-secret',
    expectedHostname: 'app.vbizme.com',
    remoteIp: '203.0.113.10',
  })

  const body = new URLSearchParams(requestBody)
  assert.equal(body.get('secret'), 'test-secret')
  assert.equal(body.get('response'), 'valid-token')
  assert.equal(body.get('remoteip'), '203.0.113.10')
})

test('failed Turnstile validation returns a client error without exposing Cloudflare details', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, 'error-codes': ['timeout-or-duplicate'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  await assertTurnstileError(
    verifyTurnstileToken('expired-token', { enabled: true, secretKey: 'test-secret' }),
    400,
    'Security verification failed'
  )
})

test('Turnstile service outages return a 503 response', async () => {
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })

  await assertTurnstileError(
    verifyTurnstileToken('valid-token', { enabled: true, secretKey: 'test-secret' }),
    503,
    'Security verification service is unavailable'
  )
})

test('configured hostname mismatches are rejected', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, hostname: 'wrong.vbizme.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  await assertTurnstileError(
    verifyTurnstileToken('valid-token', {
      enabled: true,
      secretKey: 'test-secret',
      expectedHostname: 'app.vbizme.com',
    }),
    400,
    'Security verification failed'
  )
})

test('protected auth routes reject missing Turnstile tokens when enabled', async () => {
  process.env.NODE_ENV = 'test'
  const [{ default: app }, { default: config }] = await Promise.all([import('../app'), import('../configs/config')])

  const previousConfig = { ...config.TURNSTILE }
  config.TURNSTILE.ENABLED = true
  config.TURNSTILE.SECRET_KEY = 'test-secret'

  try {
    const protectedRequests = [
      {
        path: '/api/v1/auth/login',
        body: { email: 'owner@example.com', password: 'password' },
      },
      {
        path: '/api/v1/auth/register',
        body: {
          name: 'Owner',
          email: 'owner@example.com',
          password: 'StrongPassword1!',
          role: 'vcard-owner',
        },
      },
      {
        path: '/api/v1/auth/forgot-password',
        body: { email: 'owner@example.com' },
      },
    ]

    for (const protectedRequest of protectedRequests) {
      const response = await request(app).post(protectedRequest.path).send(protectedRequest.body)

      assert.equal(response.status, 400)
      assert.equal(response.body.message, 'Security verification is required')
    }
  } finally {
    config.TURNSTILE.ENABLED = previousConfig.ENABLED
    config.TURNSTILE.SECRET_KEY = previousConfig.SECRET_KEY
    config.TURNSTILE.EXPECTED_HOSTNAME = previousConfig.EXPECTED_HOSTNAME
  }
})
