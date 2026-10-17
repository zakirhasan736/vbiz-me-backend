import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_BUILDER_MISSION, CARD_BUILDER_MISSION_COMPACT, CARD_BUILDER_MISSION_VERSION } from '../cardBuilderMission'

describe('AI Card Builder mission (v4.1.1 gaps)', () => {
  it('exports versioned mission covering the ten non-negotiable standards', () => {
    assert.equal(CARD_BUILDER_MISSION_VERSION, 'v4.1.1')
    assert.match(CARD_BUILDER_MISSION, /TEN NON-NEGOTIABLE STANDARDS/)
    assert.match(CARD_BUILDER_MISSION, /FIRST-PERSON BIOGRAPHIES/)
    assert.match(CARD_BUILDER_MISSION, /Write AS the cardholder/)
    assert.match(CARD_BUILDER_MISSION, /DEEP RESEARCH/)
    assert.match(CARD_BUILDER_MISSION, /IDENTITY VERIFICATION/)
    assert.match(CARD_BUILDER_MISSION, /PERSONAL BRANDING/)
    assert.match(CARD_BUILDER_MISSION, /PREMIUM SERVICE WRITING/)
    assert.match(CARD_BUILDER_MISSION, /ALWAYS recommend complete light AND dark/)
    assert.match(CARD_BUILDER_MISSION, /source to "suggestion"/)
    assert.match(CARD_BUILDER_MISSION, /MISSION, SEO, AND BLOGS/)
    assert.match(CARD_BUILDER_MISSION, /SOURCE-BACKED CREDIBILITY/)
    assert.match(CARD_BUILDER_MISSION, /SECTION REGENERATION/)
    assert.match(CARD_BUILDER_MISSION, /QUALITY CONTROL/)
    assert.match(CARD_BUILDER_MISSION, /Never generate service images/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /ALWAYS first person/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /source="suggestion"/)
  })
})
