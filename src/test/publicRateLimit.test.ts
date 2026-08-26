import type { Request } from 'express'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  INTERNAL_PUBLIC_API_HEADER,
  isTrustedInternalPublicRequest,
  publicRateLimitKeyType,
  timingSafeEqualString,
} from '../middlewares/internalPublicRequest'

function reqWithHeader(value?: string): Request {
  return {
    headers: value === undefined ? {} : { [INTERNAL_PUBLIC_API_HEADER]: value },
  } as Request
}

describe('trusted internal public requests', () => {
  it('rejects missing secret, missing header, and wrong header', () => {
    assert.equal(isTrustedInternalPublicRequest(reqWithHeader('abc'), ''), false)
    assert.equal(isTrustedInternalPublicRequest(reqWithHeader(), 'secret-value'), false)
    assert.equal(isTrustedInternalPublicRequest(reqWithHeader('nope'), 'secret-value'), false)
  })

  it('accepts only an exact secret match', () => {
    assert.equal(isTrustedInternalPublicRequest(reqWithHeader('secret-value'), 'secret-value'), true)
  })

  it('does not treat X-Forwarded-For or loopback as trusted', () => {
    const spoofed = {
      headers: { 'x-forwarded-for': '127.0.0.1' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request
    assert.equal(isTrustedInternalPublicRequest(spoofed, 'secret-value'), false)
    assert.equal(publicRateLimitKeyType(spoofed), 'ip')
  })

  it('compares secrets in constant time for equal lengths', () => {
    assert.equal(timingSafeEqualString('abcd', 'abce'), false)
    assert.equal(timingSafeEqualString('abcd', 'abcd'), true)
  })
})
