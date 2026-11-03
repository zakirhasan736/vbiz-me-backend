import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  areaFromAttachmentType,
  areaFromTable,
  identityFromKey,
  mediaFolderFor,
  resolveUploadArea,
  s3MetadataFor,
  sanitizeArea,
} from '../utils/mediaAsset'

describe('media identity (card + tab)', () => {
  it('maps builder attachment types to tabs', () => {
    assert.equal(areaFromAttachmentType('Service Featured'), 'services')
    assert.equal(areaFromAttachmentType('Portfolio Gallery'), 'portfolio')
    assert.equal(areaFromAttachmentType('Content Media Gallery'), 'gallery')
    assert.equal(areaFromAttachmentType('Blog Featured'), 'blogs')
    assert.equal(areaFromAttachmentType('About Me Featured'), 'about')
    assert.equal(areaFromAttachmentType('Profile Image/Video'), 'profile')
    assert.equal(areaFromAttachmentType('Intro vCard Video'), 'intro-video')
    assert.equal(areaFromAttachmentType('Background Video/Image'), 'background')
    assert.equal(areaFromAttachmentType('Background Music'), 'music')
    assert.equal(areaFromAttachmentType(''), null)
  })

  it('picks the upload tab: specific type > builder section > raw type', () => {
    assert.equal(resolveUploadArea('Profile Image/Video', 'personal-info'), 'profile')
    assert.equal(resolveUploadArea('Featured Image', 'services'), 'services')
    assert.equal(resolveUploadArea('Featured Image', null), 'featured-image')
    assert.equal(resolveUploadArea(null, null), 'misc')
  })

  it('maps tables to tabs', () => {
    assert.equal(areaFromTable('Service', 'imageUrl'), 'services')
    assert.equal(areaFromTable('Portfolio', 'imageUrl'), 'portfolio')
    assert.equal(areaFromTable('Profile', 'avatar'), 'profile')
    assert.equal(areaFromTable('SomethingNew', 'x'), 'somethingnew')
  })

  it('builds card/tab-scoped folders and reads identity back from the key', () => {
    const folder = mediaFolderFor({ profileId: 'cmabc123', area: 'Services' })
    assert.equal(folder, 'vbizme/cards/cmabc123/services')
    assert.deepEqual(identityFromKey(`${folder}/1793285518140-ML1.jpg`), { profileId: 'cmabc123', area: 'services' })
    assert.deepEqual(identityFromKey('vbizme/1793285518140-ML1.jpg'), { profileId: null, area: null })
    assert.equal(mediaFolderFor({ userId: 'u1', area: null }), 'vbizme/users/u1/misc')
    assert.equal(mediaFolderFor({}), 'vbizme/unassigned/misc')
  })

  it('never lets user input escape the folder', () => {
    assert.equal(sanitizeArea('../../etc/passwd'), 'etc-passwd')
    assert.equal(mediaFolderFor({ profileId: '../x', area: '../../y' }), 'vbizme/cards/x/y')
  })

  it('writes ASCII-only S3 metadata', () => {
    assert.deepEqual(s3MetadataFor({ profileId: 'p1', area: 'services', source: 'upload', uploadedById: 'ü1' }), {
      'profile-id': 'p1',
      area: 'services',
      'uploaded-by': '1',
      source: 'upload',
    })
  })
})
