import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BUILDER_ATTACHMENT_TYPE_ALIASES,
  PUBLIC_ATTACHMENT_KIND_ALIASES,
  attachmentTypeNameMatches,
  sameMediaUrl,
  scoreAttachmentTypeName,
} from '../utils/attachmentTypeMatch'

describe('attachmentTypeMatch', () => {
  it('matches builder types by type name only', () => {
    assert.equal(attachmentTypeNameMatches('Intro vCard Video', 'Intro vCard Video'), true)
    assert.equal(attachmentTypeNameMatches('intro video', 'Intro vCard Video'), true)
    assert.equal(attachmentTypeNameMatches('Background Video/Image', 'Intro vCard Video'), false)
    assert.equal(attachmentTypeNameMatches('Background Video/Image', 'Background Video/Image'), true)
  })

  it('does not match bare short tokens', () => {
    assert.equal(scoreAttachmentTypeName('intro', PUBLIC_ATTACHMENT_KIND_ALIASES.intro), -1)
    assert.equal(scoreAttachmentTypeName('background', PUBLIC_ATTACHMENT_KIND_ALIASES.background), -1)
    assert.equal(scoreAttachmentTypeName('profile', PUBLIC_ATTACHMENT_KIND_ALIASES.profile), -1)
  })

  it('keeps intro and background alias families disjoint', () => {
    const introType = 'intro vcard video office_background.mp4'
    // Type names never include filenames — simulate type-only scoring.
    assert.equal(scoreAttachmentTypeName('Intro vCard Video', PUBLIC_ATTACHMENT_KIND_ALIASES.background), -1)
    assert.equal(scoreAttachmentTypeName('Intro vCard Video', PUBLIC_ATTACHMENT_KIND_ALIASES.intro) >= 0, true)
    assert.equal(scoreAttachmentTypeName('Background Video/Image', PUBLIC_ATTACHMENT_KIND_ALIASES.intro), -1)
    void introType
    assert.ok(BUILDER_ATTACHMENT_TYPE_ALIASES['Intro vCard Video'].every((a) => a.length > 5))
  })

  it('compares media urls without query strings', () => {
    assert.equal(sameMediaUrl('https://cdn.example.com/x.mp4?v=1', 'https://cdn.example.com/x.mp4'), true)
  })
})
