import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import globalErrorHandler from '../middlewares/globalErrorHandler'

function runHandler(error: unknown) {
  let status = 0
  let body: Record<string, unknown> | null = null
  const req = {
    method: 'GET',
    originalUrl: '/api/v1/example',
    user: undefined,
    params: {},
    body: {},
  } as unknown as Request
  const res = {
    status(code: number) {
      status = code
      return this
    },
    json(payload: Record<string, unknown>) {
      body = payload
      return this
    },
    getHeader() {
      return undefined
    },
  } as unknown as Response
  const next = (() => undefined) as NextFunction

  globalErrorHandler(error as Error, req, res, next)
  return { status, body }
}

test('http-errors Bad Request stays 400 instead of becoming a Sentry 500', () => {
  const error = Object.assign(new Error('Bad Request'), { status: 400, statusCode: 400 })
  const { status, body } = runHandler(error)
  assert.equal(status, 400)
  assert.equal(body?.success, false)
  assert.equal(body?.statusCode, 400)
  assert.equal(body?.message, 'Bad Request')
})

test('URIError from malformed GET encoding is a 400 Bad Request', () => {
  const { status, body } = runHandler(new URIError('Failed to decode param'))
  assert.equal(status, 400)
  assert.equal(body?.statusCode, 400)
  assert.equal(body?.message, 'Bad Request')
})

test('plain unexpected errors remain 500', () => {
  const { status, body } = runHandler(new Error('Forced test failure'))
  assert.equal(status, 500)
  assert.equal(body?.statusCode, 500)
  assert.equal(body?.message, 'Forced test failure')
})
