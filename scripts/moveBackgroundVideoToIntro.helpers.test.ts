import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractDisplayFieldUrl,
  isYoutubeUrl,
  monthsAgo,
  patchDisplaySettingsMediaMove,
  planBackgroundVideoToIntroMove,
  settingsPatchForMove,
  type CardMediaSnapshot,
} from './moveBackgroundVideoToIntro.helpers'

function card(
  partial: Partial<CardMediaSnapshot> & Pick<CardMediaSnapshot, 'settings' | 'attachments'>
): CardMediaSnapshot {
  return {
    profileId: 'p1',
    slug: 'demo-card',
    name: 'Demo',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...partial,
  }
}

describe('moveBackgroundVideoToIntro helpers', () => {
  it('monthsAgo subtracts calendar months (older-than cutoff for legacy cards)', () => {
    const from = new Date('2026-10-29T00:00:00.000Z')
    const got = monthsAgo(2, from)
    assert.equal(got.toISOString().slice(0, 7), '2026-08')
    // Cards created on/after this cutoff are new-system and must not be touched.
    assert.ok(new Date('2026-09-15T00:00:00.000Z') >= got)
    assert.ok(new Date('2026-07-01T00:00:00.000Z') < got)
  })

  it('detects youtube urls', () => {
    assert.equal(isYoutubeUrl('https://youtu.be/abc'), true)
    assert.equal(isYoutubeUrl('https://cdn.example/x.mp4'), false)
  })

  it('plans a move when background has video and intro is blank', () => {
    const plan = planBackgroundVideoToIntroMove(
      card({
        settings: { background_media_url: 'https://cdn.example/vbizme/old-intro.mp4' },
        attachments: [],
      })
    )
    assert.equal(plan.status, 'would_move')
    assert.equal(plan.videoUrl, 'https://cdn.example/vbizme/old-intro.mp4')
    assert.equal(plan.videoKind, 'file')
  })

  it('skips when intro already has a file', () => {
    const plan = planBackgroundVideoToIntroMove(
      card({
        settings: {
          background_media_url: 'https://cdn.example/vbizme/old-intro.mp4',
          intro_video_url: 'https://cdn.example/vbizme/real-intro.mp4',
        },
        attachments: [],
      })
    )
    assert.equal(plan.status, 'skip')
    assert.match(plan.reason, /Intro video already present/i)
  })

  it('skips background images', () => {
    const plan = planBackgroundVideoToIntroMove(
      card({
        settings: { background_media_url: 'https://cdn.example/vbizme/wallpaper.jpg' },
        attachments: [],
      })
    )
    assert.equal(plan.status, 'skip')
    assert.match(plan.reason, /No video found/i)
  })

  it('accepts background video attachment when settings are empty', () => {
    const plan = planBackgroundVideoToIntroMove(
      card({
        settings: {},
        attachments: [
          {
            id: 'a1',
            url: 'https://cdn.example/vbizme/bg.mp4',
            typeName: 'Background Video/Image',
            mimeType: 'video/mp4',
          },
        ],
      })
    )
    assert.equal(plan.status, 'would_move')
    assert.equal(plan.backgroundSource, 'attachment')
  })

  it('patches settings for file move', () => {
    const patch = settingsPatchForMove({
      profileId: 'p1',
      slug: 'x',
      name: 'X',
      createdAt: new Date().toISOString(),
      status: 'would_move',
      reason: 'move',
      videoUrl: 'https://cdn.example/v.mp4',
      videoKind: 'file',
    })
    assert.equal(patch.intro_video_url, 'https://cdn.example/v.mp4')
    assert.equal(patch.background_media_url, '')
    assert.equal(patch.profile_video_checkbox, '1')
    assert.equal(patch.background_video_checkbox, '0')
  })

  it('patches display_settings_json for the move', () => {
    const raw = JSON.stringify({
      fields: {
        'Background Video/Image': { customValue: 'https://cdn.example/v.mp4', visible: true },
        'Intro vCard Video': { customValue: '', visible: false },
      },
    })
    const next = JSON.parse(
      patchDisplaySettingsMediaMove(raw, { videoUrl: 'https://cdn.example/v.mp4', youtube: false })
    )
    assert.equal(next.fields['Intro vCard Video'].customValue, 'https://cdn.example/v.mp4')
    assert.equal(next.fields['Intro vCard Video'].visible, true)
    assert.equal(next.fields['Background Video/Image'].customValue, '')
    assert.equal(extractDisplayFieldUrl(JSON.stringify(next), 'Intro vCard Video'), 'https://cdn.example/v.mp4')
  })
})
