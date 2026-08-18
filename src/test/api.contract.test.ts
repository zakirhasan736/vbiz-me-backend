import jwt from 'jsonwebtoken'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import request from 'supertest'

process.env.NODE_ENV = 'test'

const { default: app } = await import('../app')

test('GET / returns the standard success envelope', async () => {
  const response = await request(app).get('/')

  assert.equal(response.status, 200)
  assert.equal(response.body.success, true)
  assert.equal(response.body.statusCode, 200)
  assert.equal(response.body.message, 'Welcome')
})

test('GET /api/v1/health reports service health', async () => {
  const response = await request(app).get('/api/v1/health')

  assert.equal(response.status, 200)
  assert.equal(response.body.success, true)
  assert.equal(response.body.data.status, 'healthy')
})

test('invalid login payloads return 400 validation responses', async () => {
  const response = await request(app).post('/api/v1/auth/login').send({ email: 'invalid-email', password: '' })

  assert.equal(response.status, 400)
  assert.equal(response.body.success, false)
  assert.equal(response.body.statusCode, 400)
  assert.equal(response.body.message, 'Validation Error')
  assert.ok(Array.isArray(response.body.errorMessages))
})

test('protected resources reject unauthenticated requests with 403', async () => {
  const response = await request(app).get('/api/v1/profiles')

  assert.equal(response.status, 403)
  assert.equal(response.body.success, false)
  assert.equal(response.body.message, 'Unauthorized')
})

test('public note reads require a visitor scope', async () => {
  const response = await request(app).get('/api/v1/public/notes?profile_id=profile-1')

  assert.equal(response.status, 400)
  assert.equal(response.body.success, false)
  assert.equal(response.body.error, 'profile_id and visitor_id are required')
})

test('expired access tokens return 401 when no refresh token is supplied', async () => {
  const expiredToken = jwt.sign({ id: 'expired-user', exp: Math.floor(Date.now() / 1000) - 60 }, 'test-secret')
  const response = await request(app).get('/api/v1/profiles').set('Authorization', `Bearer ${expiredToken}`)

  assert.equal(response.status, 401)
  assert.equal(response.body.success, false)
  assert.equal(response.body.message, 'Refresh token is missing')
})

test('unknown API routes return 404 with the requested path', async () => {
  const response = await request(app).get('/api/v1/does-not-exist')

  assert.equal(response.status, 404)
  assert.equal(response.body.success, false)
  assert.equal(response.body.statusCode, 404)
  assert.equal(response.body.data.path, '/api/v1/does-not-exist')
})

test('unexpected errors use the standard 500 response shape', async () => {
  const response = await request(app).get('/__test__/error')

  assert.equal(response.status, 500)
  assert.equal(response.body.success, false)
  assert.equal(response.body.statusCode, 500)
  assert.equal(response.body.message, 'Forced test failure')
  assert.ok(Array.isArray(response.body.errorMessages))
})
