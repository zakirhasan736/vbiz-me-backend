import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractHexColorsFromText,
  extractReputationLinksFromHtml,
  extractReputationLinksFromText,
  filterReputationLinksForIdentity,
  formatReputationBlock,
} from '../services/ai/reputationFromSources'

describe('reputationFromSources', () => {
  it('extracts social and review URLs from source text only', () => {
    const text = `
      Follow us https://www.linkedin.com/in/jane-doe and https://instagram.com/acme
      Reviews: https://www.yelp.com/biz/acme-realty and https://www.trustpilot.com/review/acme.com
    `
    const links = extractReputationLinksFromText(text)
    assert.ok(links.some((l) => l.platform === 'linkedin'))
    assert.ok(links.some((l) => l.platform === 'instagram'))
    assert.ok(links.some((l) => l.platform === 'yelp' && l.kind === 'review'))
    assert.ok(links.every((l) => l.verification === 'verified_from_source'))
  })

  it('extracts brand hex candidates and skips black/white', () => {
    const colors = extractHexColorsFromText('color:#0f766e; bg:#fff; border:#112233;')
    assert.ok(colors.includes('#0f766e'))
    assert.ok(colors.includes('#112233'))
    assert.ok(!colors.includes('#ffffff'))
  })

  it('mines href attributes from HTML and flags uncertain LinkedIn matches', () => {
    const fromHtml = extractReputationLinksFromHtml(
      '<a href="https://www.linkedin.com/in/other-person">LI</a><a href="https://www.yelp.com/biz/acme">Y</a>'
    )
    assert.ok(fromHtml.some((l) => l.platform === 'linkedin'))
    const filtered = filterReputationLinksForIdentity(fromHtml, {
      businessName: 'Jane Realty',
      ownerName: 'Jane Doe',
      website: 'https://janerealty.com',
    })
    const li = filtered.find((l) => l.platform === 'linkedin')
    assert.equal(li?.verification, 'needs_confirmation')
    assert.match(formatReputationBlock([], []), /source="suggestion"/)
  })
})
