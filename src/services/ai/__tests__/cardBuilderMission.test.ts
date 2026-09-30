import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_BUILDER_MISSION, CARD_BUILDER_MISSION_COMPACT } from '../cardBuilderMission'

describe('AI Card Builder mission', () => {
  it('includes the full operating brief for card creation', () => {
    assert.match(CARD_BUILDER_MISSION, /You are the AI Card Builder for vBiz Me/)
    assert.match(CARD_BUILDER_MISSION, /ABOUT SECTION/)
    assert.match(CARD_BUILDER_MISSION, /SERVICES/)
    assert.match(CARD_BUILDER_MISSION, /FAQs/)
    assert.match(CARD_BUILDER_MISSION, /WHY CHOOSE US/)
    assert.match(CARD_BUILDER_MISSION, /CALL TO ACTION/)
    assert.match(CARD_BUILDER_MISSION, /BUSINESS INFORMATION/)
    assert.match(CARD_BUILDER_MISSION, /BRAND VOICE/)
    assert.match(CARD_BUILDER_MISSION, /SALES AND MARKETING/)
    assert.match(CARD_BUILDER_MISSION, /ACCURACY/)
    assert.match(CARD_BUILDER_MISSION, /COMPLETENESS/)
    assert.match(CARD_BUILDER_MISSION, /Never invent factual claims/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /fill as much as possible/)
  })
})
