import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyCanonicalPublicNavOrder } from '../constants/publicNavOrder'

describe('canonical public nav order', () => {
  it('skips missing tabs and keeps the remaining default sequence', () => {
    assert.deepEqual(
      applyCanonicalPublicNavOrder(['home', 'about', 'mission', 'services', 'gallery', 'videos', 'bbb', 'faq']),
      ['home', 'about', 'mission', 'services', 'gallery', 'videos', 'bbb', 'faq']
    )
  })

  it('reorders only canonical tabs and leaves other items in place', () => {
    assert.deepEqual(
      applyCanonicalPublicNavOrder(['home', 'education', 'faq', 'services', 'gallery', 'reviews', 'videos']),
      ['home', 'education', 'services', 'gallery', 'videos', 'reviews', 'faq']
    )
  })
})
