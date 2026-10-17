import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARD_BUILDER_MISSION,
  CARD_BUILDER_MISSION_COMPACT,
  CARD_BUILDER_MISSION_VERSION,
} from '../cardBuilderMission'

describe('AI Card Builder mission (v3.0)', () => {
  it('exports the master mission and compact fill instructions', () => {
    assert.equal(CARD_BUILDER_MISSION_VERSION, 'v3.0.0')
    assert.match(CARD_BUILDER_MISSION, /AI CARD BUILDER MASTER MISSION/)
    assert.match(CARD_BUILDER_MISSION, /FIRST PERSON/)
    assert.match(CARD_BUILDER_MISSION, /SERVICES — PREMIUM PROFESSIONAL WRITING/)
    assert.match(CARD_BUILDER_MISSION, /40 to 75 words/)
    assert.match(CARD_BUILDER_MISSION, /SERVICE IMAGE GENERATION IS DISABLED/)
    assert.match(CARD_BUILDER_MISSION, /BRAND COLOR INTELLIGENCE/)
    assert.match(CARD_BUILDER_MISSION, /PARTIAL REGENERATION/)
    assert.match(CARD_BUILDER_MISSION, /QUALITY CONTROL/)
    assert.match(CARD_BUILDER_MISSION, /Never invent facts/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /Always first person/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /40–75 words/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /Do not create service images/)
    assert.match(CARD_BUILDER_MISSION_COMPACT, /Creative facts are forbidden/)
  })
})
