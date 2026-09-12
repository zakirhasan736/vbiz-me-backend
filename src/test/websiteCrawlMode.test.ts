import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectWebsiteCrawlMode, looksLikeStorefrontUrl } from '../services/ai/websiteCrawlMode'

describe('websiteCrawlMode', () => {
  it('detects Amway / MyShop style seller URLs as storefront', () => {
    assert.equal(looksLikeStorefrontUrl('https://www.amway.com/en_US/myshop/ChisholmMarkandTracy'), true)
    assert.equal(looksLikeStorefrontUrl('https://marktracy.myshopify.com'), true)
    assert.equal(looksLikeStorefrontUrl('https://www.etsy.com/shop/CoolSeller'), true)
    assert.equal(looksLikeStorefrontUrl('https://example.com/seller/jane'), true)
  })

  it('keeps ordinary business sites on full crawl', () => {
    assert.equal(looksLikeStorefrontUrl('https://acmeplumbing.com'), false)
    assert.equal(looksLikeStorefrontUrl('https://www.acme.com/about'), false)
    assert.equal(detectWebsiteCrawlMode('https://acmeplumbing.com'), 'full')
  })

  it('honors explicit crawlMode overrides', () => {
    assert.equal(detectWebsiteCrawlMode('https://acmeplumbing.com', 'storefront'), 'storefront')
    assert.equal(detectWebsiteCrawlMode('https://www.amway.com/en_US/myshop/x', 'full'), 'full')
    assert.equal(detectWebsiteCrawlMode('https://x.com', 'vendor'), 'storefront')
  })
})
