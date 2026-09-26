import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isMultipartTruncatedError, MEDIA_UPLOAD_INTERRUPTED_MESSAGE } from '../constants/mediaUpload'

describe('media upload truncated form', () => {
  it('detects busboy unexpected end of form', () => {
    assert.equal(isMultipartTruncatedError(new Error('Unexpected end of form')), true)
    assert.equal(isMultipartTruncatedError(new Error('invalid file')), false)
    assert.equal(MEDIA_UPLOAD_INTERRUPTED_MESSAGE.includes('interrupted'), true)
  })
})
