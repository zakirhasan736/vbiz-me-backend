import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FEATURE_LIMIT_REACHED,
  FEATURE_NOT_INCLUDED,
  PACKAGE_FEATURE_LOCKED,
  PACKAGE_LIMIT_REACHED,
  featureLimitReachedError,
  featureNotIncludedError,
} from '../constants/packageErrors'
import { isCatalogFeatureAllowed } from '../utils/effectiveEntitlements'
import {
  catalogGateForWallpaperChange,
  catalogGateSatisfied,
  catalogGatesForSettingChange,
  guessUploadedKind,
  mediaUploadCatalogGate,
} from '../utils/mediaFeatureGates'

describe('media catalog gates', () => {
  it('maps attachment types to media allow_* flags', () => {
    assert.deepEqual(mediaUploadCatalogGate({ attachmentType: 'Profile Image/Video', kind: 'image' }), null)
    assert.deepEqual(mediaUploadCatalogGate({ attachmentType: 'Profile Image/Video', kind: 'video' }), {
      all: ['allow_video_upload'],
    })
    assert.deepEqual(mediaUploadCatalogGate({ attachmentType: 'Background Video/Image', kind: 'video' }), {
      all: ['allow_background_video_upload'],
    })
    assert.deepEqual(mediaUploadCatalogGate({ attachmentType: 'Intro vCard Video', kind: 'video' }), {
      all: ['allow_intro_video_upload'],
    })
    assert.deepEqual(mediaUploadCatalogGate({ attachmentType: '2D Video Explainer', kind: 'video' }), {
      all: ['allow_2d_explainer'],
    })
    assert.deepEqual(mediaUploadCatalogGate({ attachmentType: 'Background Music', kind: 'audio' }), {
      all: ['allow_music_upload', 'allow_bg_music_upload'],
    })
    assert.equal(mediaUploadCatalogGate({ attachmentType: 'Blog Featured', kind: 'video' }), null)
  })

  it('guesses video vs still image from mime and filename', () => {
    assert.equal(guessUploadedKind({ mimetype: 'video/mp4', filename: 'clip.mp4' }), 'video')
    assert.equal(guessUploadedKind({ mimetype: 'image/jpeg', filename: 'face.jpg' }), 'image')
    assert.equal(guessUploadedKind({ mimetype: 'audio/mpeg', filename: 'loop.mp3' }), 'audio')
  })

  it('does not package-gate card setting media URLs', () => {
    assert.deepEqual(catalogGatesForSettingChange('intro_youtube_url', 'https://youtu.be/abc', ''), [])
    assert.deepEqual(catalogGatesForSettingChange('background_music_file_url', 'https://cdn.example.com/a.mp3', ''), [])
    const previous = JSON.stringify({ fields: { 'Intro vCard Video': { customValue: '' } } })
    const next = JSON.stringify({
      fields: { 'Intro vCard Video': { customValue: 'https://cdn.example.com/intro.mp4' } },
    })
    assert.deepEqual(catalogGatesForSettingChange('display_settings_json', next, previous), [])
  })

  it('does not package-gate wallpaper style changes', () => {
    assert.equal(
      catalogGateForWallpaperChange({ wallpaper: { style: 'video' } }, { wallpaper: { style: 'image' } }),
      null
    )
    assert.equal(
      catalogGateForWallpaperChange({ wallpaper: { style: 'fill' } }, { wallpaper: { style: 'gradient' } }),
      null
    )
  })

  it('requires every all-flag and any one any-flag', () => {
    const allow = (key: string) => key === 'allow_intro_video_upload'
    assert.equal(catalogGateSatisfied({ any: ['allow_intro_video_upload', 'allow_2d_explainer'] }, allow), true)
    assert.equal(catalogGateSatisfied({ all: ['allow_music_upload', 'allow_bg_music_upload'] }, allow), false)
  })
})

describe('entitlement error aliases', () => {
  it('emits FEATURE_NOT_INCLUDED with PACKAGE_FEATURE_LOCKED as an alias', () => {
    const error = featureNotIncludedError('allow_2d_explainer')
    assert.equal(error.statusCode, 403)
    assert.equal(error.code, FEATURE_NOT_INCLUDED)
    assert.deepEqual((error.data as { codes: string[] }).codes, [FEATURE_NOT_INCLUDED, PACKAGE_FEATURE_LOCKED])
  })

  it('emits FEATURE_LIMIT_REACHED with PACKAGE_LIMIT_REACHED as an alias', () => {
    const error = featureLimitReachedError('Limit reached', { limit: 3 })
    assert.equal(error.code, FEATURE_LIMIT_REACHED)
    assert.ok((error.data as { codes: string[] }).codes.includes(PACKAGE_LIMIT_REACHED))
  })

  it('treats unpaid catalog media flags as locked even if the package row is 1', () => {
    assert.equal(
      isCatalogFeatureAllowed(
        {
          access: {
            allow_ai_assistance: false,
            allow_canva: false,
            allow_push_notification: false,
            allow_email_notification: false,
            allow_support_ticket: false,
            allow_auto_card_builder: false,
            allow_seo: false,
            allow_crm: false,
          },
          features: [{ featureKey: 'allow_2d_explainer', featureValue: '1', unlimited: false }],
          subscriptionActive: false,
          source: 'none',
        },
        'allow_2d_explainer'
      ),
      false
    )
  })
})
