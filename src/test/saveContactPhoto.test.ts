import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectSaveContactPhotoCandidates, isStillContactPhotoUrl } from '../utils/saveContactPhoto'

describe('save-contact VCF photo candidates', () => {
  it('uses profile → About Me → Home Screen → SEO Open Graph, then other stills', () => {
    const urls = collectSaveContactPhotoCandidates({
      id: 'p1',
      avatar: 'https://cdn.example.com/avatar.jpg',
      settings: {
        profile_media_url: 'https://cdn.example.com/profile.jpg',
        pwa_home_screen_icon_url: 'https://cdn.example.com/pwa.png',
        seo_image_url: 'https://cdn.example.com/seo.jpg',
        company_logo: 'https://cdn.example.com/logo.png',
        featured_image: 'https://cdn.example.com/featured.png',
      },
      aboutMeFeaturedUrl: 'https://cdn.example.com/about-me.jpg',
    })
    assert.deepEqual(urls.slice(0, 4), [
      'https://cdn.example.com/profile.jpg',
      'https://cdn.example.com/about-me.jpg',
      'https://cdn.example.com/pwa.png',
      'https://cdn.example.com/seo.jpg',
    ])
    assert.ok(urls.includes('https://cdn.example.com/avatar.jpg'))
    assert.ok(urls.includes('https://cdn.example.com/logo.png'))
    assert.ok(urls.includes('https://cdn.example.com/featured.png'))
  })

  it('falls back to Home Screen then SEO when profile and About Me are empty', () => {
    const urls = collectSaveContactPhotoCandidates({
      id: 'p2',
      settings: {
        pwa_home_screen_icon_url: 'https://cdn.example.com/pwa.png',
        seo_image_url: 'https://cdn.example.com/seo.jpg',
      },
    })
    assert.deepEqual(urls.slice(0, 2), ['https://cdn.example.com/pwa.png', 'https://cdn.example.com/seo.jpg'])
  })

  it('linked-card VCF uses profile → About Me → SEO area only — never owner fallbacks', () => {
    const urls = collectSaveContactPhotoCandidates({
      id: 'member-1',
      avatar: 'https://cdn.example.com/owner-from-duplicate.jpg',
      settings: {
        duplicated_from: 'owner-card-id',
        pwa_home_screen_icon_url: 'https://cdn.example.com/member-pwa.png',
        seo_image_url: 'https://cdn.example.com/member-seo.jpg',
        profile_media_url: 'https://cdn.example.com/member.jpg',
        company_logo: 'https://cdn.example.com/owner-logo.png',
        featured_image: 'https://cdn.example.com/owner-featured.png',
      },
      attachments: [
        {
          url: 'https://cdn.example.com/cloned-owner-avatar.png',
          mimeType: 'image/png',
          attachmentType: { name: 'Profile Image', legacyId: 1 },
        },
      ],
      aboutMeFeaturedUrl: 'https://cdn.example.com/about-me.jpg',
    })
    assert.deepEqual(urls, [
      'https://cdn.example.com/member.jpg',
      'https://cdn.example.com/about-me.jpg',
      'https://cdn.example.com/member-pwa.png',
      'https://cdn.example.com/member-seo.jpg',
    ])
    assert.equal(urls.includes('https://cdn.example.com/owner-from-duplicate.jpg'), false)
    assert.equal(urls.includes('https://cdn.example.com/owner-logo.png'), false)
    assert.equal(urls.includes('https://cdn.example.com/owner-featured.png'), false)
    assert.equal(urls.includes('https://cdn.example.com/cloned-owner-avatar.png'), false)
  })

  it('linked card with empty SEO still skips owner avatar fallbacks', () => {
    const urls = collectSaveContactPhotoCandidates({
      id: 'member-2',
      avatar: 'https://cdn.example.com/owner.jpg',
      settings: {
        duplicated_from: 'owner-card-id',
        company_logo: 'https://cdn.example.com/logo.png',
      },
    })
    assert.deepEqual(urls, [])
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
