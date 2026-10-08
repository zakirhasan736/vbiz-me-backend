import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  backupDayKey,
  backupRowIdsToDelete,
  labelForNavId,
  mediaKindForUrl,
  readMediaSlots,
  resolveCardNavIds,
  tabDataLabel,
  toTabCount,
  withImageBreakdown,
} from '../utils/cardDailyBackup'

describe('card daily backup retention', () => {
  it('keeps the newest 7 days and deletes the oldest', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ id: `day-${index + 1}` }))
    assert.deepEqual(backupRowIdsToDelete(rows), ['day-8'])
    assert.deepEqual(backupRowIdsToDelete(rows.slice(0, 7)), [])
    assert.deepEqual(backupRowIdsToDelete(rows, 7), ['day-8'])
  })

  it('formats a local calendar day', () => {
    assert.equal(backupDayKey(new Date(2026, 9, 5, 15, 30)), '2026-10-05')
  })

  it('uses the saved tab order and marks empty tabs', () => {
    assert.deepEqual(
      resolveCardNavIds({
        editorNavOrder: ['home', 'menu', 'breakfast', 'home'],
        enabledNavIds: ['services'],
      }),
      ['home', 'menu', 'breakfast']
    )
    assert.equal(tabDataLabel(0), 'Empty')
    assert.equal(tabDataLabel(1), '1 item')
    assert.equal(tabDataLabel(6), '6 items')
    assert.deepEqual(toTabCount('breakfast', 'Breakfast', 0), {
      id: 'breakfast',
      label: 'Breakfast',
      count: 0,
      empty: true,
    })
    assert.equal(labelForNavId('content-media'), 'Content & media')
    assert.equal(labelForNavId('custom-1', 'Specials'), 'Specials')
  })

  it('splits items into with image and no image', () => {
    const tab = withImageBreakdown(toTabCount('services', 'Services', 6), [
      'https://cdn.example.com/a.jpg',
      null,
      '',
      'https://cdn.example.com/b.png',
      '  ',
      undefined,
    ])
    assert.equal(tab.withImage, 2)
    assert.equal(tab.withoutImage, 4)
    assert.equal(tabDataLabel(6, 2), '6 items · 2 with image · 4 no image')
  })

  it('reads personal media as image, video, or none', () => {
    assert.equal(mediaKindForUrl('https://cdn.example.com/me.jpg'), 'image')
    assert.equal(mediaKindForUrl('https://cdn.example.com/intro.mp4?v=2'), 'video')
    assert.equal(mediaKindForUrl('https://youtu.be/abc'), 'video')
    assert.equal(mediaKindForUrl(''), 'none')
    assert.deepEqual(
      readMediaSlots([
        { id: 'avatar', label: 'Avatar', kind: 'video' },
        { id: 'bogus', label: 'x', kind: 'image' },
        { id: 'background', label: 'Background', kind: 'weird' },
      ]),
      [
        { id: 'avatar', label: 'Avatar', kind: 'video' },
        { id: 'background', label: 'Background', kind: 'none' },
      ]
    )
  })
})
