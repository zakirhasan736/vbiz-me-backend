import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSlugRename, normalizeSlug } from '../utils/slugRename'

describe('slug redirects', () => {
  it('normalizes case and whitespace', () => {
    assert.equal(normalizeSlug('  Kasia-Nowak '), 'kasia-nowak')
    assert.equal(normalizeSlug(null), '')
  })

  it('only treats a real address change as a rename', () => {
    assert.equal(isSlugRename('kasia-nowak', 'kasia-nowak-realtor'), true)
    assert.equal(isSlugRename('Kasia-Nowak', 'kasia-nowak'), false)
    assert.equal(isSlugRename(null, 'new-card'), false)
    assert.equal(isSlugRename('old-card', ''), false)
  })
})
