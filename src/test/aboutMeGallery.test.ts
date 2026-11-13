import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAboutMeGalleryPreview, toPublicGalleryLink } from '../utils/aboutMeGallery'

describe('about me gallery preview', () => {
  it('keeps a saved Open Graph snapshot and drops a non-http image', () => {
    const preview = parseAboutMeGalleryPreview(
      JSON.stringify({
        url: 'https://imaginedbyaloellc.pixieset.com/diplomatic',
        title: 'Diplomatic Cuisine',
        description: 'Photo collection by Imagined By Aloe LLC',
        image: 'https://images.pixieset.com/collections/diplomatic.jpg',
        siteName: 'Imagined By Aloe LLC',
      })
    )
    assert.equal(preview?.title, 'Diplomatic Cuisine')
    assert.equal(preview?.image, 'https://images.pixieset.com/collections/diplomatic.jpg')

    const link = toPublicGalleryLink({
      galleryUrl: 'https://imaginedbyaloellc.pixieset.com/diplomatic',
      galleryPreview: preview,
    })
    assert.equal(link?.site_name, 'Imagined By Aloe LLC')
    assert.equal(link?.url, 'https://imaginedbyaloellc.pixieset.com/diplomatic')
  })

  it('returns null when the stored preview is not a link', () => {
    assert.equal(parseAboutMeGalleryPreview('not-json'), null)
    assert.equal(parseAboutMeGalleryPreview({ url: 'javascript:alert(1)' }), null)
    assert.equal(toPublicGalleryLink({ galleryUrl: '', galleryPreview: null }), null)
  })
})
