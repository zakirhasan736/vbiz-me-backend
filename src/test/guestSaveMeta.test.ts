import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  enrichGuestSaveMeta,
  leadMetadataFromGuestMeta,
  mergeGuestSaveMeta,
  parseBrowserFromUa,
  parseDeviceFromUa,
} from '../utils/guestSaveMeta'

describe('guest save meta enrichment', () => {
  it('parses iPhone Safari from user agent', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    assert.equal(parseBrowserFromUa(ua), 'Safari')
    assert.match(parseDeviceFromUa(ua), /iPhone/)
  })

  it('fills device/browser/location from UA + timezone when client meta is thin', () => {
    const enriched = enrichGuestSaveMeta(
      { guestId: 'guest-1', timezone: 'America/New_York' },
      {
        ip: '203.0.113.10',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    )
    assert.equal(enriched.browser, 'Chrome')
    assert.equal(enriched.device, 'Windows PC')
    assert.equal(enriched.ip, '203.0.113.10')
    assert.match(String(enriched.approximateLocation), /Eastern USA/)
  })

  it('keeps richer existing meta when a later upsert sends Unknowns', () => {
    const merged = mergeGuestSaveMeta(
      {
        guestId: 'guest-1',
        device: 'iPhone · iOS 17.5',
        browser: 'Safari',
        approximateLocation: 'Eastern USA (America/New_York)',
        ip: '203.0.113.10',
        userAgent: 'Mozilla/5.0 (iPhone)',
      },
      {
        guestId: 'guest-1',
        device: 'Unknown device',
        browser: 'Unknown browser',
        approximateLocation: 'Unknown',
        ip: null,
        userAgent: '',
      }
    )
    assert.equal(merged.device, 'iPhone · iOS 17.5')
    assert.equal(merged.browser, 'Safari')
    assert.equal(merged.approximateLocation, 'Eastern USA (America/New_York)')
    assert.equal(merged.ip, '203.0.113.10')
  })

  it('exposes guestId for CRM uniqueness grouping', () => {
    const meta = leadMetadataFromGuestMeta({
      guestId: 'guest-abc',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      timezone: 'America/Los_Angeles',
      ip: '198.51.100.4',
    })
    assert.equal(meta.guestId, 'guest-abc')
    assert.equal(meta.ip, '198.51.100.4')
    assert.equal(meta.browser, 'Chrome')
    assert.equal(meta.device, 'Mac')
  })
})
