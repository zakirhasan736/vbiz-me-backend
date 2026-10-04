import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildFrontendPublicCardPath, normalizeFrontendPublicCardPath } from './frontendPublicCardPath'

describe('frontend public card path', () => {
  it('builds /vCard/{slug}', () => {
    assert.equal(buildFrontendPublicCardPath('michael-casanova'), '/vCard/michael-casanova')
  })

  it('rewrites legacy /v/{slug} to /vCard/{slug}', () => {
    assert.equal(normalizeFrontendPublicCardPath('/v/michael-casanova'), '/vCard/michael-casanova')
    assert.equal(
      normalizeFrontendPublicCardPath('https://app.vbizme.com/v/demo-card'),
      'https://app.vbizme.com/vCard/demo-card'
    )
  })

  it('keeps modern /vCard/{slug} paths', () => {
    assert.equal(normalizeFrontendPublicCardPath('/vCard/demo-card'), '/vCard/demo-card')
  })
})
