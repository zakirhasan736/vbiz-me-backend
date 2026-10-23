import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeMediaUrlKey } from './attachmentTypeMatch'

describe('s3 media ref-count helpers', () => {
  it('normalizes media urls for shared-key comparison', () => {
    assert.equal(
      normalizeMediaUrlKey('https://cdn.example.com/vbizme/123-intro.mp4?X-Amz-Signature=abc'),
      'https://cdn.example.com/vbizme/123-intro.mp4'
    )
  })
})
