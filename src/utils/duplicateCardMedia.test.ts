import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSingletonBuilderAttachmentType, normalizeMediaUrlKey } from './attachmentTypeMatch'

describe('duplicate card media copy-on-write', () => {
  it('treats intro / profile / background as singleton slots that must be reminted', () => {
    assert.equal(isSingletonBuilderAttachmentType('Intro vCard Video'), true)
    assert.equal(isSingletonBuilderAttachmentType('Profile Image/Video'), true)
    assert.equal(isSingletonBuilderAttachmentType('Background Video/Image'), true)
    assert.equal(isSingletonBuilderAttachmentType('Portfolio Gallery'), false)
  })

  it('compares remapped urls without query strings', () => {
    const from = 'https://cdn.example.com/vbizme/owner-intro.mp4?sig=1'
    const to = 'https://cdn.example.com/vbizme/member-intro.mp4'
    assert.notEqual(normalizeMediaUrlKey(from), normalizeMediaUrlKey(to))
    assert.equal(normalizeMediaUrlKey(from), 'https://cdn.example.com/vbizme/owner-intro.mp4')
  })
})
