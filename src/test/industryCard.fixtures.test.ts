import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateIndustryFixture, INDUSTRY_FIXTURES } from '../services/ai/industryCard.fixtures'
import { runExternalResearch } from '../services/ai/researchEnrichment.service'

describe('industry card quality fixtures (Phase 12)', () => {
  for (const fixture of INDUSTRY_FIXTURES) {
    it(`${fixture.industry}: after rules beat before on first-person + service value`, () => {
      const result = evaluateIndustryFixture(fixture)
      assert.equal(result.beforeFailsFirstPerson, true)
      assert.equal(result.afterFirstPerson, true)
      assert.equal(result.afterServiceInRange, true)
      assert.equal(result.afterNoFakeReviews, true)
      assert.equal(result.afterNoServiceImages, true)
      assert.equal(result.upgraded, true)
    })
  }
})

describe('external research enrichment', () => {
  it('skips cleanly without search API credentials and does not invent findings', async () => {
    const prevSerp = process.env.SERPAPI_API_KEY
    const prevBrave = process.env.BRAVE_SEARCH_API_KEY
    delete process.env.SERPAPI_API_KEY
    delete process.env.SERP_API_KEY
    delete process.env.BRAVE_SEARCH_API_KEY
    try {
      const bundle = await runExternalResearch({
        businessName: 'Jane Realty',
        ownerName: 'Jane Doe',
        website: 'https://example-realty.test',
        crawlText: 'Visit https://www.yelp.com/biz/jane-realty for reviews',
      })
      assert.equal(bundle.status, 'skipped')
      assert.equal(bundle.findings.length, 0)
      assert.ok(bundle.links.some((l) => l.platform === 'yelp'))
      assert.match(bundle.promptBlock, /skipped|No search API/i)
    } finally {
      if (prevSerp !== undefined) process.env.SERPAPI_API_KEY = prevSerp
      if (prevBrave !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevBrave
    }
  })
})
