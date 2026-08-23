import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateAuthChallenge,
  hashAuthOtp,
  MAX_AUTH_CHALLENGE_ATTEMPTS,
  shouldRequireLoginOtp,
} from '../utils/authChallenge'

const secret = 'test-secret'
const userId = 'user_1'
const otp = '482910'

describe('login email OTP challenges', () => {
  it('requires OTP for card owners only when the feature is on', () => {
    assert.equal(shouldRequireLoginOtp('vcard-owner', true), true)
    assert.equal(shouldRequireLoginOtp('corporate-owner', true), true)
    assert.equal(shouldRequireLoginOtp('admin', true), false)
    assert.equal(shouldRequireLoginOtp('super-admin', true), false)
    assert.equal(shouldRequireLoginOtp('vcard-owner', false), false)
  })

  it('accepts a matching unused OTP and rejects a wrong code', () => {
    const codeHash = hashAuthOtp(otp, userId, 'LOGIN', secret)
    const record = {
      codeHash,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attemptCount: 0,
    }
    assert.deepEqual(evaluateAuthChallenge(record, otp, userId, 'LOGIN', secret), { ok: true })
    assert.deepEqual(evaluateAuthChallenge(record, '000000', userId, 'LOGIN', secret), {
      ok: false,
      reason: 'invalid',
    })
  })

  it('rejects expired OTP', () => {
    const record = {
      codeHash: hashAuthOtp(otp, userId, 'LOGIN', secret),
      expiresAt: new Date(Date.now() - 1),
      consumedAt: null,
      attemptCount: 0,
    }
    assert.deepEqual(evaluateAuthChallenge(record, otp, userId, 'LOGIN', secret), {
      ok: false,
      reason: 'expired',
    })
  })

  it('rejects reused OTP after it was consumed', () => {
    const record = {
      codeHash: hashAuthOtp(otp, userId, 'LOGIN', secret),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      attemptCount: 0,
    }
    assert.deepEqual(evaluateAuthChallenge(record, otp, userId, 'LOGIN', secret), {
      ok: false,
      reason: 'reused',
    })
  })

  it('locks a challenge after too many attempts', () => {
    const record = {
      codeHash: hashAuthOtp(otp, userId, 'LOGIN', secret),
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attemptCount: MAX_AUTH_CHALLENGE_ATTEMPTS,
    }
    assert.deepEqual(evaluateAuthChallenge(record, otp, userId, 'LOGIN', secret), {
      ok: false,
      reason: 'locked',
    })
  })
})
