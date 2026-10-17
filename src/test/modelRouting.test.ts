import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getModelForTier,
  modelCandidatesForTier,
  selectFillSectionModel,
  selectModelForTask,
} from '../services/ai/modelRouter.service'

describe('model routing (tier labels preserved)', () => {
  it('keeps Luna / Terra / SOL / Vision preferred models with documented fallbacks', () => {
    assert.equal(getModelForTier('luna'), process.env.OPENAI_CARD_MODEL_LUNA?.trim() || 'gpt-5.6-luna')
    assert.equal(getModelForTier('terra'), process.env.OPENAI_CARD_MODEL_TERRA?.trim() || 'gpt-5.6-terra')
    assert.equal(getModelForTier('sol'), process.env.OPENAI_CARD_MODEL_SOL?.trim() || 'gpt-5.6-sol')
    assert.equal(getModelForTier('vision'), process.env.OPENAI_CARD_MODEL_VISION?.trim() || 'gpt-4o')

    const sol = modelCandidatesForTier('sol')
    assert.equal(sol[0], getModelForTier('sol'))
    assert.ok(sol.includes('gpt-4.1') || sol.includes('gpt-4o'))

    const terra = modelCandidatesForTier('terra')
    assert.ok(terra.includes('gpt-4.1') || terra.includes('gpt-4o'))

    const luna = modelCandidatesForTier('luna')
    assert.ok(luna.includes('gpt-4o-mini') || luna.includes('gpt-4o'))
  })

  it('routes premium writing to Terra/SOL path and FAQ fill to Luna', () => {
    const writing = selectModelForTask({ task: 'HIGH_QUALITY_WRITING' })
    assert.ok(writing.tier === 'terra' || writing.tier === 'sol')
    assert.equal(selectFillSectionModel('faqs').tier, 'luna')
    assert.equal(selectFillSectionModel('reviews').tier, 'luna')
  })
})
