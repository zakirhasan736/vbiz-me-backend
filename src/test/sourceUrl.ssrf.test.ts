import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isBlockedFetchHostname, normalizeWebsiteUrl } from '../services/ai/sourceUrl'

describe('website URL SSRF guards', () => {
  it('blocks localhost, private IPs, and metadata hosts', () => {
    assert.equal(isBlockedFetchHostname('localhost'), true)
    assert.equal(isBlockedFetchHostname('127.0.0.1'), true)
    assert.equal(isBlockedFetchHostname('10.0.0.5'), true)
    assert.equal(isBlockedFetchHostname('192.168.1.1'), true)
    assert.equal(isBlockedFetchHostname('169.254.169.254'), true)
    assert.equal(isBlockedFetchHostname('metadata.google.internal'), true)
    assert.equal(isBlockedFetchHostname('example.com'), false)
  })

  it('normalizes public https URLs', () => {
    assert.equal(normalizeWebsiteUrl('example.com/about'), 'https://example.com/about')
  })

  it('rejects blocked hosts in normalizeWebsiteUrl', () => {
    assert.throws(() => normalizeWebsiteUrl('http://127.0.0.1/admin'))
  })
})
