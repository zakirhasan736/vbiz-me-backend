import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectSaveContactPhotoCandidates, isStillContactPhotoUrl } from '../utils/saveContactPhoto'

describe('save-contact VCF photo candidates', () => {
  it('prefers avatar, then About Me, then any other still profile image', () => {
    const urls = collectSaveContactPhotoCandidates({
      id: 'p1',
      avatar: 'https://cdn.example.com/avatar.jpg',
      settings: {
        company_logo: 'https://cdn.example.com/logo.png',
        featured_image: 'https://cdn.example.com/featured.png',
      },
      aboutMeFeaturedUrl: 'https://cdn.example.com/about-me.jpg',
    })
    assert.deepEqual(urls, [
      'https://cdn.example.com/avatar.jpg',
      'https://cdn.example.com/about-me.jpg',
      'https://cdn.example.com/logo.png',
      'https://cdn.example.com/featured.png',
    ])
  })

  it('skips avatar video and uses About Me, then another still image', () => {
    const urls = collectSaveContactPhotoCandidates({
      id: 'p1',
      avatar: 'https://cdn.example.com/intro.mp4',
      settings: [{ key: 'profile_media_url', value: 'https://cdn.example.com/clip.webm' }],
      attachments: [
        {
          url: 'https://cdn.example.com/gallery.png',
          mimeType: 'image/png',
          attachmentType: { name: 'Gallery', legacyId: 7 },
        },
      ],
      aboutMeFeaturedUrl: 'https://cdn.example.com/about.png',
    })
    assert.equal(urls[0], 'https://cdn.example.com/about.png')
    assert.ok(urls.includes('https://cdn.example.com/gallery.png'))
    assert.equal(urls.includes('https://cdn.example.com/intro.mp4'), false)
  })

  it('rejects video and social page URLs', () => {
    assert.equal(isStillContactPhotoUrl('https://cdn.example.com/photo.jpg'), true)
    assert.equal(isStillContactPhotoUrl('https://cdn.example.com/intro.mp4'), false)
    assert.equal(isStillContactPhotoUrl('https://www.youtube.com/watch?v=abc'), false)
  })
})
