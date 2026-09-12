import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveStoredProductPricing } from '../utils/productPricing'

describe('resolveStoredProductPricing', () => {
  it('prefers columns then metas', () => {
    const result = resolveStoredProductPricing({
      price: '$10',
      offerPrice: '$8',
      metas: { price: '$99', offer_price: '$88' },
    })
    assert.equal(result.price, '$10')
    assert.equal(result.offerPrice, '$8')
    assert.equal(result.metas.price, '$10')
    assert.equal(result.metas.offer_price, '$8')
  })

  it('falls back to metas.offer_price', () => {
    const result = resolveStoredProductPricing({
      metas: { price: '49.99', offer_price: '39.99' },
    })
    assert.equal(result.price, '49.99')
    assert.equal(result.offerPrice, '39.99')
  })
})
