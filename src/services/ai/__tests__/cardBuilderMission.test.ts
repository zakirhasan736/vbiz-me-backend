import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_BUILDER_MISSION, CARD_BUILDER_MISSION_COMPACT, CARD_BUILDER_MISSION_VERSION } from '../cardBuilderMission'

describe('AI Card Builder mission (v4.1)', () => {
  it('exports the master mission and compact fill instructions', () => {
    assert.equal(CARD_BUILDER_MISSION_VERSION, 'v4.1.0')
    assert.match(CARD_BUILDER_MISSION, /official AI Card Builder for vBiz Me/)
    assert.match(CARD_BUILDER_MISSION, /FIRST PERSON/)
    assert.match(CARD_BUILDER_MISSION, /do not invent additional services to fill a quota/)
    assert.match(CARD_BUILDER_MISSION, /40–75-word/)
    assert.match(CARD_BUILDER_MISSION, /SERVICE IMAGES ARE DISABLED/)
    assert.match(CARD_BUILDER_MISSION, /LIGHT AND DARK BRAND THEMES/)
    assert.match(CARD_BUILDER_MISSION, /BRAND COLOR RESEARCH/)
    assert.match(CARD_BUILDER_MISSION, /Do NOT assign roles by raw frequency/)
    assert.match(CARD_BUILDER_MISSION, /platform default Global Color/)
    assert.match(CARD_BUILDER_MISSION, /PARTIAL EDITING/)
    assert.match(CARD_BUILDER_MISSION, /FINAL QUALITY GATE/)
    assert.match(CARD_BUILDER_MISSION, /Creative facts are forbidden/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /FIRST PERSON/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /40–75-word/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /BRAND COLOR RESEARCH/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /No new service images/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /no invented facts/)
  })
})
