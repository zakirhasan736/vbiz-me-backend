import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import AppError from '../error/AppError'
import { sanitizeCorporateFeatureOverrides } from '../utils/corporateFeatureOverrides'

describe('corporate feature overrides', () => {
  it('keeps allow_* and file-size overrides and drops empty keys', () => {
    const result = sanitizeCorporateFeatureOverrides([
      { featureKey: 'allow_canva', featureValue: '0' },
      { featureKey: 'MAX_FILE_SIZE_MB', featureValue: '25' },
      { featureKey: '  ', featureValue: '1' },
    ])
    assert.deepEqual(result, [
      { featureKey: 'allow_canva', featureValue: '0' },
      { featureKey: 'max_file_size_mb', featureValue: '25' },
    ])
  })

  it('does not persist inherit or empty values', () => {
    const result = sanitizeCorporateFeatureOverrides([
      { featureKey: 'allow_canva', featureValue: 'inherit' },
      { featureKey: 'allow_seo', featureValue: '' },
      { featureKey: 'allow_seo', featureValue: null },
      { featureKey: 'allow_2d_explainer', featureValue: '0' },
    ])
    assert.deepEqual(result, [{ featureKey: 'allow_2d_explainer', featureValue: '0' }])
  })

  it('rejects max_cards so card caps stay on Subscription.quantity', () => {
    assert.throws(
      () => sanitizeCorporateFeatureOverrides([{ featureKey: 'max_cards', featureValue: '99' }]),
      (err: unknown) => err instanceof AppError && err.statusCode === 400
    )
  })
})
