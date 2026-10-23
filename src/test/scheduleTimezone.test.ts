import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_CAMPAIGN_TIMEZONE, normalizeIanaTimeZone, zonedLocalDateTimeToUtc } from '../utils/scheduleTimezone'

describe('scheduleTimezone', () => {
  it('defaults invalid zones to America/New_York', () => {
    assert.equal(normalizeIanaTimeZone(''), DEFAULT_CAMPAIGN_TIMEZONE)
    assert.equal(normalizeIanaTimeZone('Not/AZone'), DEFAULT_CAMPAIGN_TIMEZONE)
    assert.equal(normalizeIanaTimeZone('America/Los_Angeles'), 'America/Los_Angeles')
  })

  it('converts Eastern wall time to a UTC instant (winter)', () => {
    // 2024-01-15 15:00 America/New_York = 20:00 UTC (EST, UTC-5)
    const utc = zonedLocalDateTimeToUtc('2024-01-15', '3:00 PM', 'America/New_York')
    assert.equal(utc.toISOString(), '2024-01-15T20:00:00.000Z')
  })

  it('handles Pacific daylight-saving summer offset', () => {
    // 2024-07-04 09:00 America/Los_Angeles = 16:00 UTC (PDT, UTC-7)
    const utc = zonedLocalDateTimeToUtc('2024-07-04', '09:00', 'America/Los_Angeles')
    assert.equal(utc.toISOString(), '2024-07-04T16:00:00.000Z')
  })
})
