import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractAvatarUrlsFromSnapshot,
  mostCommonSharedUrl,
  patchDisplaySettingsProfileImage,
  pickRestoreAvatarUrl,
} from './restoreCorporateCardAvatars.helpers'

describe('mostCommonSharedUrl', () => {
  it('returns the overwritten URL when two or more cards share it', () => {
    assert.equal(
      mostCommonSharedUrl([
        'https://cdn.example.com/julia.jpg',
        'https://cdn.example.com/julia.jpg?v=1',
        'https://cdn.example.com/mila.jpg',
      ]),
      'https://cdn.example.com/julia.jpg'
    )
  })
})

describe('pickRestoreAvatarUrl', () => {
  it('restores a card-owned attachment that is not the overwrite', () => {
    const picked = pickRestoreAvatarUrl({
      currentUrl: 'https://cdn.example.com/julia.jpg',
      sharedOverwriteUrl: 'https://cdn.example.com/julia.jpg',
      attachmentUrls: ['https://cdn.example.com/julia.jpg', 'https://cdn.example.com/mila.jpg'],
      historyUrls: [],
    })
    assert.equal(picked.source, 'attachment')
    assert.equal(picked.url, 'https://cdn.example.com/mila.jpg')
  })

  it('keeps the source card that actually owns the shared photo', () => {
    const picked = pickRestoreAvatarUrl({
      currentUrl: 'https://cdn.example.com/julia.jpg',
      sharedOverwriteUrl: 'https://cdn.example.com/julia.jpg',
      attachmentUrls: ['https://cdn.example.com/julia.jpg'],
      historyUrls: [],
    })
    assert.equal(picked.source, 'keep')
    assert.equal(picked.url, 'https://cdn.example.com/julia.jpg')
  })

  it('uses history when no unique attachment remains', () => {
    const picked = pickRestoreAvatarUrl({
      currentUrl: 'https://cdn.example.com/julia.jpg',
      sharedOverwriteUrl: 'https://cdn.example.com/julia.jpg',
      attachmentUrls: [],
      historyUrls: ['https://cdn.example.com/casanova.jpg'],
    })
    assert.equal(picked.source, 'history')
    assert.equal(picked.url, 'https://cdn.example.com/casanova.jpg')
  })
})

describe('snapshot and display settings', () => {
  it('reads avatar URLs from a settings snapshot', () => {
    assert.deepEqual(
      extractAvatarUrlsFromSnapshot({
        settings: {
          profile_media_url: 'https://cdn.example.com/old.jpg',
          display_settings_json: JSON.stringify({
            fields: { 'Profile Image/Video': { customValue: 'https://cdn.example.com/old.jpg' } },
          }),
        },
      }),
      ['https://cdn.example.com/old.jpg', 'https://cdn.example.com/old.jpg']
    )
  })

  it('patches only the Profile Image/Video custom value', () => {
    const next = patchDisplaySettingsProfileImage(
      JSON.stringify({
        fields: {
          'Profile Image/Video': { visible: true, customValue: 'https://cdn.example.com/julia.jpg' },
          'Background Video/Image': { customValue: 'https://cdn.example.com/office.jpg' },
        },
      }),
      'https://cdn.example.com/mila.jpg'
    )
    const parsed = JSON.parse(next || '{}') as {
      fields: Record<string, { customValue?: string; visible?: boolean }>
    }
    assert.equal(parsed.fields['Profile Image/Video']?.customValue, 'https://cdn.example.com/mila.jpg')
    assert.equal(parsed.fields['Profile Image/Video']?.visible, true)
    assert.equal(parsed.fields['Background Video/Image']?.customValue, 'https://cdn.example.com/office.jpg')
  })
})
