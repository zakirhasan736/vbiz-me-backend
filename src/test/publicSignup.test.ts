import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ACCOUNT_LOOKUP_OK_MESSAGE, isPublicSignupEnabled, PUBLIC_SIGNUP_DISABLED_CODE } from '../utils/publicSignup'

describe('public signup flag', () => {
  it('stays off unless explicitly enabled', () => {
    assert.equal(isPublicSignupEnabled(undefined), false)
    assert.equal(isPublicSignupEnabled('false'), false)
    assert.equal(isPublicSignupEnabled('true'), true)
    assert.equal(PUBLIC_SIGNUP_DISABLED_CODE, 'PUBLIC_SIGNUP_DISABLED')
    assert.match(ACCOUNT_LOOKUP_OK_MESSAGE, /If an account exists/)
  })
})
