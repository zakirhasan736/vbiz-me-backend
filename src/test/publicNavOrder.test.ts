import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyCanonicalPublicNavOrder,
  assemblePublicNavOrder,
  mergeEnabledNavOrder,
  shouldPreserveCustomNavOrder,
} from '../constants/publicNavOrder'

describe('canonical public nav order', () => {
  it('skips missing tabs and keeps the remaining default sequence', () => {
    assert.deepEqual(
      applyCanonicalPublicNavOrder(['home', 'about', 'mission', 'services', 'gallery', 'videos', 'bbb', 'faq']),
      ['home', 'about', 'mission', 'services', 'gallery', 'videos', 'bbb', 'faq', 'public-cards', 'my-info']
    )
  })

  it('puts extras after FAQ and pins Public Cards then My Info', () => {
    assert.deepEqual(
      applyCanonicalPublicNavOrder(['home', 'education', 'faq', 'services', 'gallery', 'reviews', 'videos']),
      ['home', 'about', 'services', 'gallery', 'videos', 'reviews', 'faq', 'education', 'public-cards', 'my-info']
    )
  })

  it('preserves a customized middle order while still pinning the last two tabs', () => {
    assert.deepEqual(assemblePublicNavOrder(['faq', 'services', 'home', 'about'], { preserveCustom: true }), [
      'faq',
      'services',
      'home',
      'about',
      'public-cards',
      'my-info',
    ])
  })

  it('merges enabled tabs that were missing from the saved order', () => {
    assert.deepEqual(mergeEnabledNavOrder(['home', 'about', 'faq'], ['services', 'videos', 'bbb']), [
      'home',
      'about',
      'services',
      'videos',
      'bbb',
      'faq',
      'public-cards',
      'my-info',
    ])
  })

  it('preserves the michaelangelo-casanova-2 slug', () => {
    assert.equal(shouldPreserveCustomNavOrder('michaelangelo-casanova-2'), true)
    assert.equal(shouldPreserveCustomNavOrder('other-card'), false)
    assert.equal(shouldPreserveCustomNavOrder('other-card', true), true)
  })
})
